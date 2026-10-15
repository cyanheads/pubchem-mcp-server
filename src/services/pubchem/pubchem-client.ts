/**
 * @fileoverview PubChem API client with rate limiting, retry, and response parsing.
 * Wraps both PUG REST and PUG View APIs behind a shared rate limiter.
 * @module services/pubchem/pubchem-client
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  requestCancelled,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  logger,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type {
  ActivityValue,
  AidListResponse,
  AssayCidListKeyResponse,
  AssayCidPage,
  AssaySummary,
  AssaySummaryTableResponse,
  AssayTargetActivity,
  BioactivityRow,
  CidListResponse,
  CompoundClassification,
  ConformerListResponse,
  GHSClassification,
  GHSSourceClassification,
  InteractionEntry,
  InteractionKindFetch,
  InteractionKindPage,
  InteractionsResult,
  ListKeyResponse,
  PropertyTableResponse,
  PugViewInformation,
  PugViewResponse,
  PugViewSection,
  SafetyLookup,
  SdqResponse,
  SynonymResponse,
  TargetGroup,
  XrefResponse,
} from './types.js';

const isNotFound = (error: unknown): boolean =>
  error instanceof McpError && error.code === JsonRpcErrorCode.NotFound;

const isBadRequest = (error: unknown): boolean =>
  error instanceof McpError && error.data?.status === 400;

/** The upstream fault `fetchResponse` attaches to an HTTP failure whose body states one. */
const faultOf = (error: unknown): string | undefined => {
  const fault = error instanceof McpError ? error.data?.fault : undefined;
  return typeof fault === 'string' ? fault : undefined;
};

/** PubChem's answer when a fast search cannot run on the query itself: a malformed SMILES or
 * formula, a SMILES with a "*" wildcard atom, a CID with no record. Every re-send of a
 * faulting request has faulted again, and no valid query has drawn it — a slow search gets
 * 504 `PUGREST.Timeout`, a search with no hits 404 `PUGREST.NotFound`. So `fetchResponse`
 * spends no retry on it, and the search methods, which know the query form, turn it into a
 * typed `search_query_rejected`. */
const SEARCH_REJECTED_FAULT = 'PUGREST.ServerError: Search status indicates failure';

/** Re-throws a rejected-query fault from a fast search as `search_query_rejected`, with a
 * hint for the query form the caller sent. Every other failure passes through unchanged. */
function mapRejectedSearch<T>(search: Promise<T>, message: string, hint: string): Promise<T> {
  return search.catch((error: unknown) => {
    if (faultOf(error) !== SEARCH_REJECTED_FAULT) throw error;
    throw validationError(
      message,
      { reason: 'search_query_rejected', fault: SEARCH_REJECTED_FAULT, recovery: { hint } },
      { cause: error },
    );
  });
}

/** PubChem's 404 fault for an AID with no live assay. The same endpoints answer a real assay
 * with no CIDs of the requested kind with 404 "No CIDs found for the given AID(s)". */
const NO_LIVE_AIDS_FAULT = 'No live AIDs in the supplied AID list';

/** CID 0 is PubChem's "no such structure" placeholder, never a compound: a SMILES lookup for a
 * structure that parses but is not in the database answers 200 with `CID: [0]`. Dropped
 * wherever a CID list is read, so no route can report it as a match. */
const realCids = (cids: number[]): number[] => cids.filter((cid) => cid > 0);

/** Distinguishes the two outcomes PUG View hides behind a single HTTP 404.
 *
 * `heading=`-filtered PUG View requests answer both "this CID has no record" and "this CID's
 * record has no data under that heading" with 404 `PUGVIEW.NotFound`. The only discriminator
 * is the fault message: "No record found" for a nonexistent CID, "No data found" for a real
 * compound the heading doesn't cover. `fetchResponse` parses that message onto `data.fault`,
 * so no extra request is needed to tell them apart.
 *
 * Defaults to false when the message is missing or unrecognized: claiming a compound has no
 * data understates what is known, while wrongly claiming a CID does not exist sends the caller
 * chasing a correct identifier. */
const isMissingRecord = (error: unknown): boolean =>
  isNotFound(error) && (faultOf(error)?.includes('No record found') ?? false);

/** What a caller's cancellation surfaces as. `RequestCancelled` is never retried and the
 * framework logs it at `info`; raising it here keeps a withdrawn call from reading as a
 * timeout, and from matching the not-found checks that turn a 404 into "no data". */
const cancellation = (reason: unknown): McpError =>
  requestCancelled('PubChem request cancelled by the caller.', undefined, { cause: reason });

// ── Rate Limiter ─────────────────────────────────────────────────────

/** Sliding-window rate limiter. Queues requests exceeding maxPerSecond. */
class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly max: number;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(maxPerSecond: number) {
    this.max = maxPerSecond;
  }

  /** Waits for a slot. A caller that cancels while queued leaves the queue without taking one. */
  acquire(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancellation(signal.reason));
        return;
      }
      const grant = () => {
        signal?.removeEventListener('abort', withdraw);
        resolve();
      };
      const withdraw = () => {
        this.queue.splice(this.queue.indexOf(grant), 1);
        reject(cancellation(signal?.reason));
      };
      signal?.addEventListener('abort', withdraw, { once: true });
      this.queue.push(grant);
      if (!this.draining) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      const cutoff = now - 1000;
      while (this.timestamps[0] != null && this.timestamps[0] <= cutoff) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.max) {
        this.timestamps.push(Date.now());
        this.queue.shift()?.();
      } else {
        const oldest = this.timestamps[0] ?? Date.now();
        const wait = oldest + 1000 - Date.now();
        await new Promise<void>((r) => setTimeout(r, Math.max(10, wait)));
      }
    }
    this.draining = false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** A request's options, with the caller's cancellation signal required at every call site —
 * `undefined` only where no caller signal exists. */
type FetchInit = Omit<RequestInit, 'signal'> & { signal: AbortSignal | undefined };

/** Waits `ms`, or rejects with the cancellation as soon as `signal` aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellation(signal.reason));
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(cancellation(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });

/** One wall-clock budget per tool call or resource read, shared by every PubChem request the
 * call makes, in sequence or in parallel — each one's rate-limit wait, attempts' headers and
 * bodies, and retry backoff. It sits below the 60 s default request timeout of MCP SDK clients,
 * so a slow or hung upstream reaches the caller as this server's `Timeout`, not the client's. */
const CALL_BUDGET_MS = 50_000;

/** When each call's budget runs out, keyed by the call's cancellation signal — the one object
 * every request of a call already carries, and a new one per call. The call's first request
 * starts the clock; the entry goes with the signal. */
const callDeadlines = new WeakMap<AbortSignal, number>();

/** Milliseconds left of the budget of the call `signal` belongs to. A request with no caller
 * signal is a call of its own. */
function callBudgetLeft(signal: AbortSignal | undefined): number {
  if (!signal) return CALL_BUDGET_MS;
  let deadline = callDeadlines.get(signal);
  if (deadline === undefined) {
    deadline = Date.now() + CALL_BUDGET_MS;
    callDeadlines.set(signal, deadline);
  }
  return deadline - Date.now();
}

/** Ceiling on one attempt; the retry gets whatever the call's budget has left. */
const ATTEMPT_TIMEOUT_MS = 30_000;

/** Every non-2xx status. `fetchWithTimeout` logs a status it is not told to expect at `error`,
 * without the route; this client logs the request's final outcome itself, with the URL. */
const HTTP_ERROR_STATUSES = Array.from({ length: 200 }, (_, i) => 400 + i);

/** Bytes of a non-2xx body kept to parse PubChem's fault from. Fault envelopes run a few
 * hundred bytes; an HTML error page past this is cut, never read whole. */
const ERROR_BODY_LIMIT = 2_048;

/** A non-2xx response as `fetchWithTimeout` reports it. */
const isHttpFailure = (error: unknown): error is McpError =>
  error instanceof McpError && error.data?.errorSource === 'FetchHttpError';

/** The message of an HTTP failure. PubChem sends its fault code as the status text ("400
 * PUGREST.BadRequest"), so a parsed fault, which leads with that code, replaces the status text
 * rather than repeating it. `attempts` names an exhausted retry in the head, where it reads as
 * part of the sentence whatever punctuation the fault ends with. */
function httpFailureMessage(
  status: number,
  statusText: string | undefined,
  fault: string | undefined,
  attempts?: number,
): string {
  const text = !fault && statusText ? ` ${statusText}` : '';
  const head = `PubChem returned HTTP ${status}${text}${attempts ? ` after ${attempts} attempts` : ''}`;
  return fault ? `${head}: ${fault}` : `${head}.`;
}

/** Rebuilds a non-2xx into this client's error: the status fields, the fault PubChem stated in
 * its envelope (`Code: Message`) on `data.fault` and in the message, which is all some clients
 * show, and neither the captured body nor the request URL — `data` reaches the client as
 * `structuredContent.error.data`, and a PubChem URL carries the caller's own query. A body
 * with no parseable fault, such as the HTML page PubChem throttles with, leaves `fault` unset. */
function pubChemHttpError(error: McpError): McpError {
  const data = error.data ?? {};
  const status = Number(data.status);
  const statusText = typeof data.statusText === 'string' ? data.statusText : '';
  const body = typeof data.body === 'string' ? data.body : '';
  const fault = parseFaultMessage(body);
  return new McpError(error.code, httpFailureMessage(status, statusText, fault), {
    status,
    statusText: statusText || undefined,
    statusCode: status,
    ...(data.retryAfter !== undefined && { retryAfter: data.retryAfter }),
    ...(data.retryable !== undefined && { retryable: data.retryable }),
    ...(fault && { fault }),
  });
}

/** An HTTP failure as the caller sees it once its retry is spent. `withRetry` appends
 * "(failed after N attempts)" after this client's own full stop, a second sentence, so the
 * message is rebuilt with the attempts in its head; data and cause carry over. Any other HTTP
 * failure passes through unchanged. */
function exhaustedHttpFailure(
  error: McpError,
  status: number,
  fault: string | undefined,
): McpError {
  const attempts = error.data?.retryAttempts;
  if (typeof attempts !== 'number') return error;
  const statusText = typeof error.data?.statusText === 'string' ? error.data.statusText : undefined;
  return new McpError(
    error.code,
    httpFailureMessage(status, statusText, fault, attempts),
    error.data,
    { cause: error },
  );
}

/** `errorSource` of a 2xx whose body could not be read: not JSON where JSON was asked for, or
 * cut off mid-stream. Raised as a transient `ServiceUnavailable` inside the attempt, so the
 * retry covers the body read as well as the exchange. */
const UNREADABLE_BODY = 'PubChemUnreadableBody';

/** A body read's failure as the attempt throws it. The framework already classifies a body
 * read the request's own clocks or the caller ended, as an `McpError`; anything else — a
 * `SyntaxError` from `JSON.parse`, the runtime's error for a dropped connection — is the body
 * itself failing, which is PubChem's side, never the caller's. */
function bodyReadFailure(error: unknown): unknown {
  if (error instanceof McpError) return error;
  return serviceUnavailable(
    `PubChem response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
    { errorSource: UNREADABLE_BODY },
    error instanceof Error ? { cause: error } : undefined,
  );
}

/** Rebuilds a failure that carries no HTTP status — a timeout, a network error, or a body that
 * could not be read — into what the caller sees: one fixed message per kind, with the request's
 * host, path, and query left to the server log. The framework names the URL's origin in these
 * messages, and the runtime's own text can quote the host. Any clock can end a request — the
 * call's {@link CALL_BUDGET_MS} budget, running out mid-request or already spent, or one
 * attempt's timer — and all read the same. The code and the retry count carry over; the
 * original stays on `cause`, which never reaches the wire. */
function requestFailure(error: unknown): unknown {
  if (!(error instanceof McpError)) return error;
  const data =
    typeof error.data?.retryAttempts === 'number'
      ? { retryAttempts: error.data.retryAttempts }
      : undefined;
  if (error.code === JsonRpcErrorCode.Timeout) {
    return timeout('PubChem did not respond in time; the request timed out. Retry shortly.', data, {
      cause: error,
    });
  }
  if (error.data?.errorSource === 'FetchNetworkErrorWrapper') {
    return new McpError(
      error.code,
      'PubChem could not be reached (network error). Retry shortly.',
      data,
      { cause: error },
    );
  }
  if (error.data?.errorSource === UNREADABLE_BODY) {
    return serviceUnavailable(
      'PubChem sent a response that could not be read. Retry shortly.',
      data,
      { cause: error },
    );
  }
  return error;
}

/** The framework's transient set, narrowed to this client's policy: an HTTP failure retries
 * only on 5xx, and never when PubChem has rejected the search query itself, which faults
 * identically on every re-send. Network errors and per-attempt timeouts stay transient. */
function isRetryable(error: unknown): boolean {
  const status = error instanceof McpError ? error.data?.status : undefined;
  if (typeof status === 'number' && (status < 500 || faultOf(error) === SEARCH_REJECTED_FAULT)) {
    return false;
  }
  return defaultIsTransient(error);
}

/** Reason on an SDQ answer that is not SDQ data — a refusal, which a retry does not clear. */
const SDQ_UNAVAILABLE = 'sdq_unavailable';

/** Records a failed PubChem request, with its URL, in the server's own log. The error the
 * caller receives deliberately omits the URL, so this line is the only place an operator can
 * see which route failed. The module `logger` writes server-side only — `ctx.log` would also
 * forward the line to the client as `notifications/message`. */
function logFailedRequest(
  level: 'debug' | 'warning',
  url: string,
  method: string,
  detail: { status: number; fault?: string } | { error: string },
): void {
  const summary = 'status' in detail ? `HTTP ${detail.status}` : detail.error;
  logger[level](
    `PubChem request failed: ${summary}`,
    requestContextService.createRequestContext({
      operation: 'PubChemClient.fetch',
      additionalContext: { url, method, ...detail },
    }),
  );
}

/** PubChem returns different field names than the request parameter names for some properties.
 * Request IsomericSMILES → response key "SMILES" (includes stereochemistry).
 * Request CanonicalSMILES → response key "ConnectivitySMILES" (connectivity only). */
const PROPERTY_NAME_MAP: Record<string, string> = {
  SMILES: 'IsomericSMILES',
  ConnectivitySMILES: 'CanonicalSMILES',
};

function normalizePropertyNames<T extends Record<string, unknown>>(row: T): T {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) {
    result[PROPERTY_NAME_MAP[key] ?? key] = value;
  }
  return result as T;
}

function parseFaultMessage(text: string): string | undefined {
  // JSON fault response (most endpoints)
  try {
    const data = JSON.parse(text) as { Fault?: { Code?: string; Message?: string } };
    if (data.Fault?.Message) {
      return `${data.Fault.Code ?? 'Error'}: ${data.Fault.Message}`;
    }
  } catch {
    /* not JSON — try plain-text format below */
  }

  // Plain-text fault response (image endpoint): "Status: 400\nCode: X\nMessage: Y"
  const code = text.match(/^Code:\s*(.+)$/m)?.[1];
  const message = text.match(/^Message:\s*(.+)$/m)?.[1];
  if (code && message) return `${code}: ${message}`;

  return;
}

// ── PUG View Parsing ─────────────────────────────────────────────────

/** Recursively search PUG View sections for a heading */
function findSection(sections: PugViewSection[], heading: string): PugViewSection | undefined {
  for (const section of sections) {
    if (section.TOCHeading === heading) return section;
    if (section.Section) {
      const found = findSection(section.Section, heading);
      if (found) return found;
    }
  }
  return;
}

/** Extract all text strings from a PUG View section and its children */
function extractStrings(section: PugViewSection): string[] {
  const strings: string[] = [];
  if (section.Information) {
    for (const info of section.Information) {
      if (info.Value.StringWithMarkup) {
        for (const swm of info.Value.StringWithMarkup) {
          if (swm.String) strings.push(swm.String);
        }
      }
    }
  }
  if (section.Section) {
    for (const sub of section.Section) {
      strings.push(...extractStrings(sub));
    }
  }
  return strings;
}

/** A human ATC level-5 code ("N02BA01"). ATCvet codes carry a leading "Q" and never match. */
const ATC_LEVEL5 = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;

/** One WHO ATC hierarchy string at any level: "<code> - <name>" ("N02 - Analgesics"). */
const ATC_ENTRY = /^([A-Z][0-9A-Z]*) - (.+)$/;

/** Source whose code lists name other drugs' ATC codes beside the compound's own. */
const ESSENTIAL_MEDICINES_SOURCE = 'WHO Model Lists of Essential Medicines';

type AtcCode = CompoundClassification['atcCodes'][number];

/** Parse PUG View's `ATC Code` section into human ATC codes with their hierarchy.
 *
 * Each `Information` entry is one deposit, so entries are read one at a time rather than
 * flattened: a WHO ATC Classification entry is five "<code> - <name>" strings from anatomical
 * group down to substance, and only within one entry do those strings describe the same code.
 * The section also holds bare codes (NORMAN Suspect List Exchange deposits one, listed first),
 * ATCvet blocks whose `Q…` codes never match the human pattern, and WHO Model List of Essential
 * Medicines code lists ("C05AA09; H02AB02; L01AA01"), which can name another drug's code and so
 * never contribute one — a list of a single code is ruled out by its source, not its shape.
 *
 * Codes keep first-appearance order. A hierarchy entry fills a bare code's place, so the
 * bare-listed primary code still gets its description and levels; a code PubChem lists only
 * bare comes back with `description: ""` and `levels: []`. */
function parseAtcCodes(section: PugViewSection, sources: Map<number, string>): AtcCode[] {
  const byCode = new Map<string, AtcCode>();
  for (const info of section.Information ?? []) {
    const strings = (info.Value.StringWithMarkup ?? []).map((swm) => swm.String.trim());
    const entries = strings.flatMap((s) => {
      const match = s.match(ATC_ENTRY);
      return match?.[1] && match[2] ? [{ code: match[1], description: match[2].trim() }] : [];
    });
    for (const leaf of entries) {
      if (!ATC_LEVEL5.test(leaf.code) || byCode.get(leaf.code)?.description) continue;
      const levels = entries.filter(
        (e) => e.code.length < leaf.code.length && leaf.code.startsWith(e.code),
      );
      byCode.set(leaf.code, { ...leaf, levels });
    }
    const source = info.ReferenceNumber != null ? sources.get(info.ReferenceNumber) : undefined;
    if (source === ESSENTIAL_MEDICINES_SOURCE) continue;
    for (const code of strings) {
      if (ATC_LEVEL5.test(code) && !byCode.has(code)) {
        byCode.set(code, { code, description: '', levels: [] });
      }
    }
  }
  return [...byCode.values()];
}

/** Extract description strings paired with their PUG View ReferenceNumber so we can attribute sources. */
function extractDescriptionItems(
  section: PugViewSection,
): Array<{ refNum?: number; text: string }> {
  const items: Array<{ refNum?: number; text: string }> = [];
  if (section.Information) {
    for (const info of section.Information) {
      if (!info.Value.StringWithMarkup) continue;
      for (const swm of info.Value.StringWithMarkup) {
        if (!swm.String) continue;
        items.push(
          info.ReferenceNumber != null
            ? { refNum: info.ReferenceNumber, text: swm.String }
            : { text: swm.String },
        );
      }
    }
  }
  if (section.Section) {
    for (const sub of section.Section) {
      items.push(...extractDescriptionItems(sub));
    }
  }
  return items;
}

/** ReferenceNumber → SourceName for a PUG View record, so its entries can carry attribution. */
function referenceSources(data: PugViewResponse): Map<number, string> {
  return new Map((data.Record.Reference ?? []).map((ref) => [ref.ReferenceNumber, ref.SourceName]));
}

/** Filter to first occurrence of each non-empty key. Empty keys are dropped. */
function dedupByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const descriptionKey = (item: { text: string }) =>
  item.text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Extract GHS info items from a PUG View section */
function extractGHSInfo(section: PugViewSection): PugViewInformation[] {
  const infos: PugViewInformation[] = [];
  if (section.Information) infos.push(...section.Information);
  if (section.Section) {
    for (const sub of section.Section) {
      infos.push(...extractGHSInfo(sub));
    }
  }
  return infos;
}

/** Parse "H225: Highly flammable..." into { code, statement }.
 *
 * Two upstream annotations sit between the code and the separator, and neither may fail the
 * parse: the depositor-agreement percentage ("H319 (100%): Causes serious eye irritation
 * [Warning …]") and the asterisk marker some depositors append ("H370 **: Causes damage to
 * organs"). Requiring the separator to follow the code immediately discarded every annotated
 * statement, which on records that deposit only the annotated form left the compound with no
 * hazard statements at all.
 *
 * The code itself may carry a subcategory suffix — H350i (by inhalation), H360D/H360FD,
 * H361f/H361fd — naming a narrower classification than its base code, and on some records it
 * is the only form deposited. Allowing up to two trailing letters keeps those as their own
 * entries instead of dropping the statement; a suffixed code is deliberately distinct from
 * its base, so both survive the later dedup-by-code.
 *
 * The annotation group consumes exactly one annotation per iteration, with its leading
 * whitespace attached and the trailing whitespace taken once after the loop. Writing it as
 * `(?:(?:\([^)]*\)|\*+)\s*)*` instead nests `\*+` inside a `*` loop, so a code followed by a
 * run of asterisks and no separator makes the engine try every partition of that run — the
 * same statements match either way, but only this form matches them in linear time.
 *
 * The agreement percentage is returned verbatim ("37.7%", "> 99.9%") as `agreement`: on an
 * ECHA C&L block it is the share of notifying companies that assigned the code, which is what
 * separates a consensus hazard from a minority one. */
function parseCodedStatement(
  text: string,
): { code: string; statement: string; agreement?: string } | undefined {
  const match = text.match(
    /^([HP]\d{3}[A-Za-z]{0,2}(?:\+[HP]\d{3}[A-Za-z]{0,2})*)((?:\s*(?:\([^)]*\)|\*))*)\s*[:\-–]\s*(.+)/,
  );
  if (match?.[1] && match[3]) {
    const agreement = match[2]?.match(/\(([^)]*%)\)/)?.[1]?.trim();
    const parsed = { code: match[1], statement: match[3].trim() };
    return agreement ? { ...parsed, agreement } : parsed;
  }
  const codeOnly = text.match(/^([HP]\d{3}[A-Za-z]{0,2}(?:\+[HP]\d{3}[A-Za-z]{0,2})*)$/);
  if (codeOnly?.[1]) return { code: codeOnly[1], statement: '' };
  return;
}

/** Standard GHS precautionary statement text, keyed by P-code exactly as
 * `parsePrecautionaryCodes` emits it — individual codes ("P261") and combined codes
 * ("P305+P351+P338") alike. Decoding a standardized code to its official text is a lookup,
 * not fabrication — the same static-table decode already applied to pictogram codes.
 * Primary reference: UN GHS Rev. 10 Annex 3 (2023) — the revision PubChem's GHS depositors
 * follow — transcribed verbatim (British-English "vapours", consistent with the H-code text).
 * Combined-code text is assembled from its component single statements, exactly as Annex 3
 * §A3.2.5.2 prescribes. Codes carrying a free-fill "…" the label author must supply (P501
 * disposal method, P411 temperature, P320/P321 first-aid reference) and codes deleted in
 * Rev. 10 (P201, P202, and the P310–P315 family superseded by P316–P319) are omitted — they
 * fall back to "" and are reported as `decoded: false`. The one placeholder resolved rather
 * than omitted is P264, rendered with its near-universal "hands" body-part fill ("Wash hands
 * thoroughly after handling.") in place of the bare "Wash [and …] …" template — a decode a
 * reader can act on.
 *
 * Codes are added only against Rev. 10 itself. PubChem's own P-code reference
 * (pubchem.ncbi.nlm.nih.gov/ghs) is NOT a usable source despite being the upstream: it is
 * transcribed from an older revision and disagrees with Rev. 10 across this very block —
 * P210 "hot surface", P234 "original container", P240 "Ground/bond …", P242 "Use only
 * non-sparking tools", P243 "…against static discharge" are all pre-Rev.-10 forms.
 *
 * Placeholders get one of three treatments, so read the existing entries before adding a code.
 * Resolved: P264 alone, filled to its near-universal "hands" body-part. Verbatim: P280 and P352
 * keep the standard's own slash-list ("gloves/…/hearing protection/…") and decode true, because
 * the enumeration is itself the guidance. Omitted: codes whose blank only the label author can
 * fill (P501 disposal method, P411 temperature, P320/P321 first-aid reference).
 *
 * P241 is absent for a source reason, not a placeholder one — on shape alone it belongs with
 * the verbatim group. Its Rev. 10 text has not been read from a Rev. 10 source: UNECE serves
 * Annex 3 only as blocked PDFs, and every reachable transcription is older — the same lag that
 * disqualifies PubChem's page above, which disagrees with Rev. 10 on P210/P234/P240/P242/P243
 * in this very block. Adding it from a pre-Rev.-10 transcription would ship safety text this
 * table claims is Rev. 10 and is not. Add it verbatim, alongside P280, once Rev. 10 Annex 3
 * itself is in hand. */
const PRECAUTIONARY_STATEMENTS: Record<string, string> = {
  // General (P1xx)
  P101: 'If medical advice is needed, have product container or label at hand.',
  P102: 'Keep out of reach of children.',
  P103: 'Read carefully and follow all instructions.',
  // Prevention (P2xx) — P201/P202 deleted in Rev. 10 (see docstring), omitted → "".
  P203: 'Obtain, read and follow all safety instructions before use.',
  P210: 'Keep away from heat, hot surfaces, sparks, open flames and other ignition sources. No smoking.',
  P211: 'Do not spray on an open flame or other ignition source.',
  P220: 'Keep away from clothing and other combustible materials.',
  P222: 'Do not allow contact with air.',
  P223: 'Do not allow contact with water.',
  P232: 'Protect from moisture.',
  P233: 'Keep container tightly closed.',
  P234: 'Keep only in original packaging.',
  P235: 'Keep cool.',
  P240: 'Ground and bond container and receiving equipment.',
  P242: 'Use non-sparking tools.',
  P243: 'Take action to prevent static discharges.',
  P244: 'Keep valves and fittings free from oil and grease.',
  P251: 'Do not pierce or burn, even after use.',
  P260: 'Do not breathe dust/fume/gas/mist/vapours/spray.',
  P261: 'Avoid breathing dust/fume/gas/mist/vapours/spray.',
  P262: 'Do not get in eyes, on skin, or on clothing.',
  P263: 'Avoid contact during pregnancy and while nursing.',
  P264: 'Wash hands thoroughly after handling.',
  'P264+P265': 'Wash hands thoroughly after handling. Do not touch eyes.',
  P265: 'Do not touch eyes.',
  P270: 'Do not eat, drink or smoke when using this product.',
  P271: 'Use only outdoors or with adequate ventilation.',
  P272: 'Contaminated work clothing should not be allowed out of the workplace.',
  P273: 'Avoid release to the environment.',
  P280: 'Wear protective gloves/protective clothing/eye protection/face protection/hearing protection/…',
  P282: 'Wear cold insulating gloves and either face shield or eye protection.',
  P283: 'Wear fire resistant or flame-retardant clothing.',
  P284: 'In case of inadequate ventilation wear respiratory protection.',
  // Response (P3xx)
  P301: 'IF SWALLOWED:',
  'P301+P316': 'IF SWALLOWED: Get emergency medical help immediately.',
  'P301+P317': 'IF SWALLOWED: Get medical help.',
  'P301+P330+P331': 'IF SWALLOWED: Rinse mouth. Do NOT induce vomiting.',
  P302: 'IF ON SKIN:',
  'P302+P334': 'IF ON SKIN: Immerse in cool water [or wrap in wet bandages].',
  'P302+P352': 'IF ON SKIN: Wash with plenty of water/…',
  P303: 'IF ON SKIN (or hair):',
  'P303+P361+P353':
    'IF ON SKIN (or hair): Take off immediately all contaminated clothing. Rinse affected areas with water [or shower].',
  P304: 'IF INHALED:',
  'P304+P340': 'IF INHALED: Remove person to fresh air and keep comfortable for breathing.',
  P305: 'IF IN EYES:',
  'P305+P351+P338':
    'IF IN EYES: Rinse cautiously with water for several minutes. Remove contact lenses, if present and easy to do. Continue rinsing.',
  'P305+P354+P338':
    'IF IN EYES: Immediately rinse with water for several minutes. Remove contact lenses, if present and easy to do. Continue rinsing.',
  P306: 'IF ON CLOTHING:',
  P308: 'IF exposed or concerned:',
  'P308+P316': 'IF exposed or concerned: Get emergency medical help immediately.',
  P316: 'Get emergency medical help immediately.',
  P317: 'Get medical help.',
  P318: 'IF exposed or concerned, get medical advice.',
  P319: 'Get medical help if you feel unwell.',
  // P320/P321 omitted — free-fill "(see … on this label)" first-aid reference, → "".
  P330: 'Rinse mouth.',
  P331: 'Do NOT induce vomiting.',
  P332: 'If skin irritation occurs:',
  'P332+P317': 'If skin irritation occurs: Get medical help.',
  P333: 'If skin irritation or rash occurs:',
  'P333+P317': 'If skin irritation or rash occurs: Get medical help.',
  P334: 'Immerse in cool water [or wrap in wet bandages].',
  P335: 'Brush off loose particles from skin.',
  P337: 'If eye irritation persists:',
  'P337+P317': 'If eye irritation persists: Get medical help.',
  P338: 'Remove contact lenses, if present and easy to do. Continue rinsing.',
  P340: 'Remove person to fresh air and keep comfortable for breathing.',
  P342: 'If experiencing respiratory symptoms:',
  'P342+P316': 'If experiencing respiratory symptoms: Get emergency medical help immediately.',
  P351: 'Rinse cautiously with water for several minutes.',
  P352: 'Wash with plenty of water/…',
  P353: 'Rinse affected areas with water [or shower].',
  P354: 'Immediately rinse with water for several minutes.',
  P360: 'Rinse immediately contaminated clothing and skin with plenty of water before removing clothes.',
  P361: 'Take off immediately all contaminated clothing.',
  'P361+P364': 'Take off immediately all contaminated clothing and wash it before reuse.',
  P362: 'Take off contaminated clothing.',
  'P362+P364': 'Take off contaminated clothing and wash it before reuse.',
  P363: 'Wash contaminated clothing before reuse.',
  P364: 'And wash it before reuse.',
  P370: 'In case of fire:',
  P372: 'Explosion risk.',
  P373: 'DO NOT fight fire when fire reaches explosives.',
  P375: 'Fight fire remotely due to the risk of explosion.',
  P376: 'Stop leak if safe to do so.',
  P377: 'Leaking gas fire: Do not extinguish, unless leak can be stopped safely.',
  P380: 'Evacuate area.',
  P381: 'In case of leakage, eliminate all ignition sources.',
  P390: 'Absorb spillage to prevent material damage.',
  P391: 'Collect spillage.',
  // Storage (P4xx)
  P402: 'Store in a dry place.',
  'P402+P404': 'Store in a dry place. Store in a closed container.',
  P403: 'Store in a well-ventilated place.',
  'P403+P233': 'Store in a well-ventilated place. Keep container tightly closed.',
  'P403+P235': 'Store in a well-ventilated place. Keep cool.',
  P404: 'Store in a closed container.',
  P405: 'Store locked up.',
  P407: 'Maintain air gap between stacks or pallets.',
  P410: 'Protect from sunlight.',
  'P410+P403': 'Protect from sunlight. Store in a well-ventilated place.',
  P420: 'Store separately.',
  // Disposal (P5xx)
  P502: 'Refer to manufacturer or supplier for information on recovery or recycling.',
};

/** Matches one P-code — individual ("P261") or combined ("P305+P351+P338"). Greedy on the
 * `+` groups so a combined code is captured whole rather than as its first component. */
const P_CODE_PATTERN = /\bP\d{3}(?:\+P\d{3})*\b/g;

/** Parse PubChem's precautionary code list — e.g. "P261, P264+P265, P405, and P501 (click each
 * P-code to see the statement)" — into precautionary statement entries.
 *
 * The list is scanned for P-code shapes rather than split on the delimiter and matched against
 * an anchored pattern. PubChem appends explanatory prose to the list, and an anchored per-token
 * test rejects whichever token the prose is glued to — in practice the final code, silently
 * dropping it from every record (most often P501, the disposal statement). Scanning makes the
 * parse independent of both the delimiter and the wording of the prose, so a change to either
 * costs no data. It also subsumes the terminal Oxford "and" without special-casing it.
 *
 * PubChem deposits precautionary statements as bare codes (no text), so each code is decoded to
 * its standard UN GHS statement via PRECAUTIONARY_STATEMENTS. A code absent from the table
 * (free-fill placeholder or Rev. 10-deleted code) yields `statement: ''` with `decoded: false`,
 * so a consumer can tell an undecoded code from a genuinely empty statement. */
function parsePrecautionaryCodes(
  text: string,
): Array<{ code: string; statement: string; decoded: boolean }> {
  const entries: Array<{ code: string; statement: string; decoded: boolean }> = [];
  for (const [code] of text.matchAll(P_CODE_PATTERN)) {
    const statement = PRECAUTIONARY_STATEMENTS[code];
    entries.push({ code, statement: statement ?? '', decoded: statement !== undefined });
  }
  return entries;
}

/** Map PubChem pictogram markup strings to human labels */
const PICTOGRAM_LABELS: Record<string, string> = {
  GHS01: 'Explosive',
  GHS02: 'Flammable',
  GHS03: 'Oxidizer',
  GHS04: 'Compressed Gas',
  GHS05: 'Corrosive',
  GHS06: 'Toxic',
  GHS07: 'Irritant',
  GHS08: 'Health Hazard',
  GHS09: 'Environmental Hazard',
};

function parsePictogram(text: string): string {
  for (const [code, label] of Object.entries(PICTOGRAM_LABELS)) {
    if (text.includes(code)) return label;
  }
  return text.replace(/.*\//, '').replace(/\..*/, '');
}

/** Severity order for the top-level signal word. A word outside GHS's two ranks below both,
 * and an absent one below that. */
function signalRank(word: string | undefined): number {
  if (!word) return -1;
  return { danger: 2, warning: 1 }[word.toLowerCase()] ?? 0;
}

/** ECHA's verdict that notifiers found the substance meets no GHS hazard criteria, deposited as
 * a hazard-statement string of its own followed by the line naming the notifier counts. */
const NOT_CLASSIFIED = /^not classified$/i;

/** The boilerplate ECHA appends to its verdict line, pointing at its own website. */
const ECHA_WEBSITE_POINTER = /\s*For more detailed information.*$/s;

type HazardStatement = { code: string; statement: string };
type PrecautionaryStatement = { code: string; statement: string; decoded: boolean };

/** Parse one source's run of GHS `Information` entries into its classification plus the
 * statements it contributes to the record-wide unions. */
function parseGhsBlock(
  entries: PugViewInformation[],
  reference: { SourceName: string; Name?: string } | undefined,
): {
  classification: GHSSourceClassification;
  hazardStatements: HazardStatement[];
  precautionaryStatements: PrecautionaryStatement[];
} {
  let signalWord: string | undefined;
  let summary: string | undefined;
  let verdict: string | undefined;
  let hasVerdict = false;
  const pictograms: string[] = [];
  const hazardStatements: HazardStatement[] = [];
  const hazardCodes: GHSSourceClassification['hazardCodes'] = [];
  const precautionaryStatements: PrecautionaryStatement[] = [];

  for (const info of entries) {
    const name = info.Name?.toLowerCase() ?? '';
    const strings = info.Value.StringWithMarkup?.map((s) => s.String).filter(Boolean) ?? [];

    if (name.includes('signal') && strings[0]) {
      signalWord ??= strings[0];
    } else if (name.includes('pictogram')) {
      const extras =
        info.Value.StringWithMarkup?.flatMap(
          (s) => s.Markup?.map((m) => m.Extra).filter((e): e is string => e != null) ?? [],
        ) ?? [];
      pictograms.push(...(extras.length > 0 ? extras : strings).map(parsePictogram));
    } else if (name.includes('hazard') && name.includes('statement')) {
      for (const s of strings) {
        if (NOT_CLASSIFIED.test(s.trim())) {
          hasVerdict = true;
          continue;
        }
        const parsed = parseCodedStatement(s);
        if (parsed) {
          hazardStatements.push({ code: parsed.code, statement: parsed.statement });
          hazardCodes.push(
            parsed.agreement
              ? { code: parsed.code, agreement: parsed.agreement }
              : { code: parsed.code },
          );
        } else if (hasVerdict) {
          verdict ??= s.replace(ECHA_WEBSITE_POINTER, '').trim();
        }
      }
    } else if (name.includes('precautionary') && name.includes('statement')) {
      // PubChem deposits precautionary statements as a single comma-separated code
      // list (codes only, no text) — not the "Pxxx: text" shape parseCodedStatement
      // expects. Split each list into individual code entries.
      for (const s of strings) {
        precautionaryStatements.push(...parsePrecautionaryCodes(s));
      }
    } else if (name.includes('notifications summary')) {
      summary ??= strings[0];
    }
  }

  const uniqueCodes = dedupByKey(hazardCodes, (h) => h.code);
  const notClassified = hasVerdict && uniqueCodes.length === 0;
  const notifications = notClassified ? (verdict ?? summary) : summary;
  return {
    classification: {
      ...(reference && { source: reference.SourceName }),
      ...(reference?.Name && { sourceRecord: reference.Name }),
      ...(signalWord && { signalWord }),
      pictograms: [...new Set(pictograms)],
      hazardCodes: uniqueCodes,
      ...(notClassified && { notClassified: true as const }),
      ...(notifications && { notifications }),
    },
    hazardStatements,
    precautionaryStatements,
  };
}

/** Identity key for bioactivity entry dedup within an AID. */
const activityKey = (v: { name?: string; value: number; unit?: string }) =>
  `${v.name ?? ''}|${v.value}|${v.unit ?? ''}`;

/**
 * Connected components of the accession ↔ Gene ID graph whose edges are the given pairs.
 * One protein's UniProt, RefSeq and GenBank accessions meet through its gene, and one
 * accession deposited against several strain or readthrough genes meets them through it.
 */
function groupTargetPairs(pairs: Iterable<readonly [string, number]>): TargetGroup[] {
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const neighbors = adjacency.get(from);
    if (neighbors) neighbors.push(to);
    else adjacency.set(from, [to]);
  };
  for (const [accession, geneId] of pairs) {
    link(`a:${accession}`, `g:${geneId}`);
    link(`g:${geneId}`, `a:${accession}`);
  }

  const groups: TargetGroup[] = [];
  const seen = new Set<string>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const group: TargetGroup = { accessions: [], geneIds: [] };
    seen.add(start);
    const stack = [start];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (node.startsWith('a:')) group.accessions.push(node.slice(2));
      else group.geneIds.push(Number(node.slice(2)));
      for (const next of adjacency.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

// ── Client ───────────────────────────────────────────────────────────

export class PubChemClient {
  private readonly pugBase = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
  private readonly viewBase = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view';
  private readonly sdqBase = 'https://pubchem.ncbi.nlm.nih.gov/sdq/sdqagent.cgi';
  private readonly rateLimiter = new RateLimiter(5);

  // ── Core HTTP ────────────────────────────────────────────────────

  /** Shared HTTP core: one PubChem request, end to end, and its body read by `read`. Every
   * fetch variant runs on this one resilience contract, so the divergence that left
   * fetchBinary without retry or a clean timeout (#16) cannot recur.
   *
   * The request draws on its call's {@link CALL_BUDGET_MS} budget: whatever the call has left
   * bounds the rate-limit wait, each attempt's headers and body (capped at
   * {@link ATTEMPT_TIMEOUT_MS} per attempt), and the backoff, and expires as a `Timeout`; a call
   * with nothing left fails the request before it is sent. The body is read inside the attempt,
   * so a response that stalls after its headers is bounded too. One retry, after 1 s — or after
   * the `Retry-After` PubChem names, up to 30 s, when the budget still covers it — on a 5xx
   * (except a rejected search query), a network error, an attempt timeout, or a body that could
   * not be read; any other non-2xx fails at once, carrying PubChem's parsed fault on
   * `data.fault` when the body states one. A failure with no HTTP status reaches the caller as
   * {@link requestFailure} rebuilds it, with nothing of the request in it.
   *
   * `init.signal` is the caller's cancellation, and identifies the call whose budget the request
   * draws on. Once it aborts — queued for a slot, mid-fetch, mid-body, or in the backoff — the
   * request ends with `RequestCancelled`: no retry, and no failed-request log, since nothing
   * failed upstream. */
  private async fetchResponse<T>(
    url: string,
    { signal, ...init }: FetchInit,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const context = requestContextService.createRequestContext({
      operation: 'PubChemClient.fetch',
      additionalContext: { url, method },
    });
    try {
      const budgetLeftMs = callBudgetLeft(signal);
      if (budgetLeftMs <= 0) {
        throw timeout(`The call spent its ${CALL_BUDGET_MS}ms budget before this request.`);
      }
      return await withRetry(
        async (attempt) => {
          await this.rateLimiter.acquire(attempt.signal);
          let response: Response;
          try {
            response = await fetchWithTimeout(
              url,
              Math.min(ATTEMPT_TIMEOUT_MS, attempt.remainingMs),
              context,
              {
                ...init,
                signal: attempt.signal,
                expectedStatuses: HTTP_ERROR_STATUSES,
                errorBodyLimit: ERROR_BODY_LIMIT,
              },
            );
          } catch (error) {
            throw isHttpFailure(error) ? pubChemHttpError(error) : error;
          }
          try {
            return await read(response);
          } catch (error) {
            throw bodyReadFailure(error);
          }
        },
        {
          operation: 'PubChem request',
          context,
          ...(signal && { signal }),
          deadlineMs: budgetLeftMs,
          maxRetries: 1,
          baseDelayMs: 1000,
          jitter: 0,
          isTransient: isRetryable,
        },
      );
    } catch (error) {
      // The caller withdrew the call: whatever shape the abort took on the way out, it is over.
      if (signal?.aborted) throw cancellation(signal.reason);

      const status = error instanceof McpError ? error.data?.status : undefined;
      if (error instanceof McpError && typeof status === 'number') {
        const fault = faultOf(error);
        // A 404 is routine — most callers read it as "no data" — so it logs below warning.
        logFailedRequest(status === 404 ? 'debug' : 'warning', url, method, {
          status,
          ...(fault && { fault }),
        });
        throw exhaustedHttpFailure(error, status, fault);
      }
      logFailedRequest('warning', url, method, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw requestFailure(error);
    }
  }

  /** Parsed inside the attempt, so a body that is not JSON is retried and fails as
   * {@link requestFailure} reports an unreadable body. */
  private fetchJson<T>(url: string, init: FetchInit): Promise<T> {
    return this.fetchResponse(
      url,
      init,
      async (response) => JSON.parse(await response.text()) as T,
    );
  }

  private fetchBinary(url: string, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
    return this.fetchResponse(url, { signal }, (response) => response.arrayBuffer());
  }

  /** Fetch a text/plain body (e.g. an SDF record). Non-2xx is classified and thrown. */
  private fetchText(url: string, signal: AbortSignal | undefined): Promise<string> {
    return this.fetchResponse(url, { signal }, (response) => response.text());
  }

  // ── CID Resolution ──────────────────────────────────────────────

  /** Fetch CID list, with automatic ListKey polling for async searches.
   *
   * `maxRecords` carries a bounded search's cap into the ListKey retrieval. A search that
   * answers synchronously is already bounded by the `MaxRecords` on its own URL, but that
   * bound lives in the request, not the ListKey — so an async answer would otherwise return
   * the full match set and the caller would read PubChem's ceiling as a real count. Omitted
   * for identifier lookups, which are unbounded by design. */
  private async fetchCids(url: string, init: FetchInit, maxRecords?: number): Promise<number[]> {
    try {
      const data = await this.fetchJson<CidListResponse | ListKeyResponse>(url, init);
      if ('Waiting' in data) return this.pollListKey(data.Waiting.ListKey, maxRecords, init.signal);
      return realCids(data.IdentifierList.CID);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Poll a PubChem ListKey until results are ready.
   *
   * `listkey_count` asks PubChem to trim the page; the slice enforces the same bound
   * locally, so the caller's saturation test holds whether or not the parameter is honored.
   * A cancellation ends the wait before the next poll. */
  private async pollListKey(
    listKey: string,
    maxRecords: number | undefined,
    signal: AbortSignal | undefined,
    maxAttempts = 20,
  ): Promise<number[]> {
    const query = maxRecords === undefined ? '' : `?listkey_count=${maxRecords}`;
    const pollUrl = `${this.pugBase}/compound/listkey/${listKey}/cids/JSON${query}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(1500, signal);
      try {
        const data = await this.fetchJson<CidListResponse | ListKeyResponse>(pollUrl, { signal });
        if ('Waiting' in data) continue;
        const cids = realCids(data.IdentifierList.CID);
        return maxRecords === undefined ? cids : cids.slice(0, maxRecords);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    }
    throw new Error('PubChem async search timed out after polling');
  }

  /** Resolve one caller-supplied identifier to its CIDs; [] when PubChem has no match.
   *
   * The identifier is the only variable in these requests, so an HTTP 400 is PubChem rejecting
   * that identifier — for SMILES, a string it cannot standardize into a structure, including
   * well-formed SMILES it cannot process such as a "*" wildcard atom. It is re-thrown as a
   * ValidationError tagged `identifier_rejected`, so a batch caller can set that one input
   * aside. Every other failure — 5xx, rate limit, timeout — keeps its own classification. */
  private async lookupIdentifier(url: string, init: FetchInit): Promise<number[]> {
    try {
      return await this.fetchCids(url, init);
    } catch (error) {
      if (!isBadRequest(error)) throw error;
      const fault = faultOf(error);
      throw validationError(
        'PubChem could not interpret the identifier.',
        { reason: 'identifier_rejected', ...(fault && { fault }) },
        { cause: error },
      );
    }
  }

  searchByName(name: string, signal?: AbortSignal): Promise<number[]> {
    return this.lookupIdentifier(
      `${this.pugBase}/compound/name/${encodeURIComponent(name)}/cids/JSON`,
      { signal },
    );
  }

  searchBySmiles(smiles: string, signal?: AbortSignal): Promise<number[]> {
    return this.lookupIdentifier(`${this.pugBase}/compound/smiles/cids/JSON`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ smiles }).toString(),
      signal,
    });
  }

  searchByInchiKey(inchikey: string, signal?: AbortSignal): Promise<number[]> {
    return this.lookupIdentifier(
      `${this.pugBase}/compound/inchikey/${encodeURIComponent(inchikey)}/cids/JSON`,
      { signal },
    );
  }

  /** Formula search, bounded server-side by `maxRecords`.
   *
   * `MaxRecords` is mandatory rather than optional because an unbounded fast search moves
   * PubChem's entire match set: a benzoic-acid substructure query returns 1,000,000 CIDs in
   * 16.3 MB, which is PubChem's own ceiling rather than a real count. Callers ask for the
   * window they will actually use.
   *
   * A response shorter than `maxRecords` is the complete match set; a response of exactly
   * `maxRecords` is saturated, and the true total is not recoverable — PubChem returns the
   * CID list alone, with no match count beside it. Callers that need to distinguish the two
   * compare the returned length against the cap they passed. */
  searchByFormula(
    formula: string,
    allowOther: boolean,
    maxRecords: number,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const params = new URLSearchParams({ MaxRecords: String(maxRecords) });
    if (allowOther) params.set('AllowOtherElements', 'true');
    return mapRejectedSearch(
      this.fetchCids(
        `${this.pugBase}/compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?${params}`,
        { signal },
        maxRecords,
      ),
      'PubChem could not run the formula search on this formula.',
      'Write the formula in Hill notation with valid element symbols, for example "C6H12O6" or "CaH2O2".',
    );
  }

  /** Substructure, superstructure, and 2D-similarity search, bounded server-side by
   * `maxRecords`. Same cap contract as {@link searchByFormula}; a query PubChem cannot search
   * on throws `search_query_rejected` the same way. */
  searchByStructure(
    mode: 'substructure' | 'superstructure' | 'similarity',
    query: string,
    queryType: 'smiles' | 'cid',
    threshold: number | undefined,
    maxRecords: number,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const endpoint =
      mode === 'similarity'
        ? 'fastsimilarity_2d'
        : mode === 'substructure'
          ? 'fastsubstructure'
          : 'fastsuperstructure';

    const params = new URLSearchParams({ MaxRecords: String(maxRecords) });
    if (mode === 'similarity') params.set('Threshold', String(threshold ?? 90));

    if (queryType === 'cid') {
      return mapRejectedSearch(
        this.fetchCids(
          `${this.pugBase}/compound/${endpoint}/cid/${query}/cids/JSON?${params}`,
          { signal },
          maxRecords,
        ),
        `PubChem could not run the ${mode} search on CID ${query}.`,
        `Confirm CID ${query} exists with pubchem_get_compound_details, or pass the structure as a SMILES query with queryType "smiles".`,
      );
    }

    // POST for SMILES to avoid encoding issues
    const url = `${this.pugBase}/compound/${endpoint}/smiles/cids/JSON?${params}`;
    return mapRejectedSearch(
      this.fetchCids(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ smiles: query }).toString(),
          signal,
        },
        maxRecords,
      ),
      `PubChem could not run the ${mode} search on this SMILES.`,
      'Check the SMILES syntax (balanced ring closures and parentheses, valid element symbols) and remove any "*" wildcard atoms, which PubChem structure search does not accept.',
    );
  }

  // ── Compound Data ───────────────────────────────────────────────

  async getProperties(
    cids: number[],
    properties: string[],
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown> & { CID: number }>> {
    if (cids.length === 0 || properties.length === 0) return [];

    const propsPath = properties.join(',');
    const cidStr = cids.join(',');

    // POST for large CID lists, GET for small ones
    const data =
      cids.length > 50
        ? await this.fetchJson<PropertyTableResponse>(
            `${this.pugBase}/compound/cid/property/${propsPath}/JSON`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ cid: cidStr }).toString(),
              signal,
            },
          )
        : await this.fetchJson<PropertyTableResponse>(
            `${this.pugBase}/compound/cid/${cidStr}/property/${propsPath}/JSON`,
            { signal },
          );

    // PubChem returns different field names than the request names for some properties.
    // Normalize so consumers see the names they requested.
    return data.PropertyTable.Properties.map(normalizePropertyNames);
  }

  async getSynonyms(cid: number, signal?: AbortSignal): Promise<string[]> {
    try {
      const data = await this.fetchJson<SynonymResponse>(
        `${this.pugBase}/compound/cid/${cid}/synonyms/JSON`,
        { signal },
      );
      return data.InformationList.Information[0]?.Synonym ?? [];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async getImage(
    cid: number,
    size: 'small' | 'large' = 'large',
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const sizeParam = size === 'small' ? '?image_size=small' : '?image_size=large';
    try {
      return await this.fetchBinary(`${this.pugBase}/compound/cid/${cid}/PNG${sizeParam}`, signal);
    } catch (error) {
      // The image endpoint returns binary, so absence can't be a structured success like
      // the other per-CID tools — surface a typed not-found instead. The recovery hint comes
      // from the `cid_not_found` entry each calling definition declares.
      if (isNotFound(error)) {
        throw notFound(`No PubChem compound found for CID ${cid}.`, {
          cid,
          reason: 'cid_not_found',
        });
      }
      throw error;
    }
  }

  async getXrefs(
    cid: number,
    xrefType: string,
    signal?: AbortSignal,
  ): Promise<(string | number)[]> {
    try {
      const data = await this.fetchJson<XrefResponse>(
        `${this.pugBase}/compound/cid/${cid}/xrefs/${xrefType}/JSON`,
        { signal },
      );
      const info = data.InformationList.Information[0];
      if (!info) return [];
      const values = info[xrefType];
      if (!Array.isArray(values)) return [];
      const ids = values as (string | number)[];
      /** PubChem sorts numeric IDs as strings ("10027656" before "1003266"), so its order is
       * neither oldest nor newest. Numeric types are sorted before any caller windows them:
       * PubMed IDs descending, a recency proxy since PMIDs are assigned roughly in time order;
       * the rest ascending. String types (CAS numbers, registry IDs, patents) keep PubChem's
       * order. */
      if (ids.every((id): id is number => typeof id === 'number')) {
        ids.sort(xrefType === 'PubMedID' ? (a, b) => b - a : (a, b) => a - b);
      }
      return ids;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // ── PUG View ────────────────────────────────────────────────────

  async getDescription(
    cid: number,
    signal?: AbortSignal,
  ): Promise<Array<{ source?: string; text: string }>> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Record+Description`,
        { signal },
      );

      const sections = data.Record.Section;
      if (!sections) return [];

      const descSection = findSection(sections, 'Record Description');
      if (!descSection) return [];

      const refToSource = referenceSources(data);
      const raw = extractDescriptionItems(descSection);
      const deduped = dedupByKey(raw, descriptionKey);
      return deduped.map((item) => {
        const source = item.refNum != null ? refToSource.get(item.refNum) : undefined;
        return source ? { source, text: item.text } : { text: item.text };
      });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Fetch a compound's GHS classification.
   *
   * Reports "this CID has no PubChem record" separately from "this compound has no deposited
   * GHS classification" — a nonexistent CID and a real compound without safety data are
   * different answers that call for different follow-up, and both used to surface as an
   * absent result.
   *
   * PubChem deposits one classification per source — EU harmonised, the ECHA C&L aggregate,
   * single-company ECHA notifications, NITE-CMC revisions — each a run of `Information` entries
   * sharing a `ReferenceNumber`. Each run is kept as its own classification, attributed through
   * that number rather than to `Record.Reference[0]`, which is not necessarily a GHS
   * contributor. The record-wide unions (pictograms, hazard and precautionary statements) are
   * kept alongside, and the record-wide signal word is the most severe any source assigns, so
   * it does not depend on the order PubChem lists the sources in. */
  async getSafetyData(cid: number, signal?: AbortSignal): Promise<SafetyLookup> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=GHS+Classification`,
        { signal },
      );

      const sections = data.Record.Section;
      if (!sections) return { status: 'no_ghs_data' };

      const ghsSection = findSection(sections, 'GHS Classification');
      if (!ghsSection) return { status: 'no_ghs_data' };

      const blocks = new Map<number | undefined, PugViewInformation[]>();
      for (const info of extractGHSInfo(ghsSection)) {
        const block = blocks.get(info.ReferenceNumber);
        if (block) block.push(info);
        else blocks.set(info.ReferenceNumber, [info]);
      }
      const references = new Map(
        (data.Record.Reference ?? []).map((ref) => [ref.ReferenceNumber, ref]),
      );

      const result: GHSClassification = {
        classifications: [],
        pictograms: [],
        hazardStatements: [],
        precautionaryStatements: [],
      };
      for (const [refNum, entries] of blocks) {
        const parsed = parseGhsBlock(
          entries,
          refNum === undefined ? undefined : references.get(refNum),
        );
        const { classification } = parsed;
        result.pictograms.push(...classification.pictograms);
        result.hazardStatements.push(...parsed.hazardStatements);
        result.precautionaryStatements.push(...parsed.precautionaryStatements);
        // A run that deposits only notes or P-codes is not a classification of its own.
        if (
          classification.signalWord ||
          classification.pictograms.length > 0 ||
          classification.hazardCodes.length > 0 ||
          classification.notClassified
        ) {
          result.classifications.push(classification);
        }
      }

      // Deduplicate across depositors
      result.pictograms = [...new Set(result.pictograms)];
      result.hazardStatements = dedupByKey(result.hazardStatements, (h) => h.code);
      result.precautionaryStatements = dedupByKey(result.precautionaryStatements, (p) => p.code);

      for (const { signalWord: word } of result.classifications) {
        if (word && signalRank(word) > signalRank(result.signalWord)) result.signalWord = word;
      }
      const sources = [
        ...new Set(result.classifications.flatMap((c) => (c.source ? [c.source] : []))),
      ];
      if (sources.length > 0) result.source = sources.join('; ');

      if (result.signalWord || result.pictograms.length > 0 || result.hazardStatements.length > 0) {
        return { status: 'ok', ghs: result };
      }
      return result.classifications.some((c) => c.notClassified)
        ? { status: 'not_classified', ghs: result }
        : { status: 'no_ghs_data' };
    } catch (error) {
      if (isMissingRecord(error)) return { status: 'cid_not_found' };
      if (isNotFound(error)) return { status: 'no_ghs_data' };
      throw error;
    }
  }

  async getClassification(
    cid: number,
    signal?: AbortSignal,
  ): Promise<CompoundClassification | null> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Pharmacology+and+Biochemistry`,
        { signal },
      );

      const sections = data.Record.Section;
      if (!sections) return null;

      const result: CompoundClassification = {
        atcCodes: [],
        fdaClasses: [],
        fdaMechanisms: [],
        meshClasses: [],
      };

      // FDA Pharmacological Classification — PubChem emits two redundant shapes
      // (either alone covers all classes):
      //   individual: "<Type> [TAG] - <Name>"        (name after the dash)
      //   combined:   "<Name> [TAG]; <Name> [TAG]; …" (name before the tag)
      // Bucket EPC → fdaClasses, MoA → fdaMechanisms; CS/PE have no output field.
      const fdaSection = findSection(sections, 'FDA Pharmacological Classification');
      if (fdaSection) {
        for (const s of extractStrings(fdaSection)) {
          for (const entry of s.split(';')) {
            const trimmed = entry.trim();
            if (!trimmed) continue;
            const individual = trimmed.match(/^.+\[(\w+)\]\s*-\s*(.+)$/);
            const tagAtEnd = individual ? null : trimmed.match(/^(.+?)\s*\[(\w+)\]$/);
            const tag = individual?.[1] ?? tagAtEnd?.[2];
            const name = (individual?.[2] ?? tagAtEnd?.[1])?.trim();
            if (!tag || !name) continue;
            if (tag === 'EPC') result.fdaClasses.push(name);
            else if (tag === 'MoA') result.fdaMechanisms.push(name);
          }
        }
        result.fdaClasses = [...new Set(result.fdaClasses)];
        result.fdaMechanisms = [...new Set(result.fdaMechanisms)];
      }

      // MeSH Pharmacological Classification
      const meshSection = findSection(sections, 'MeSH Pharmacological Classification');
      if (meshSection) {
        result.meshClasses = extractStrings(meshSection);
      }

      // ATC Code
      const atcSection = findSection(sections, 'ATC Code');
      if (atcSection) {
        result.atcCodes = parseAtcCodes(atcSection, referenceSources(data));
      }

      const hasData =
        result.fdaClasses.length > 0 ||
        result.fdaMechanisms.length > 0 ||
        result.meshClasses.length > 0 ||
        result.atcCodes.length > 0;
      return hasData ? result : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── Bioactivity ─────────────────────────────────────────────────

  async getAssaySummary(cid: number, signal?: AbortSignal): Promise<AssaySummary> {
    try {
      const data = await this.fetchJson<AssaySummaryTableResponse>(
        `${this.pugBase}/compound/cid/${cid}/assaysummary/JSON`,
        { signal },
      );
      return this.parseAssayTable(data);
    } catch (error) {
      if (isNotFound(error)) return { rows: [], targetGroups: [] };
      throw error;
    }
  }

  private parseAssayTable(data: AssaySummaryTableResponse): AssaySummary {
    const columns = data.Table.Columns.Column;
    const rows = data.Table.Row;

    // Build column index lookup — exact match
    const col = (name: string) => columns.indexOf(name);
    // Prefix match for columns with embedded units like "Activity Value [uM]"
    const colPrefix = (prefix: string) => columns.findIndex((c) => c.startsWith(prefix));

    const aidIdx = col('AID');
    const nameIdx = col('Assay Name');
    const outcomeIdx = col('Activity Outcome');
    const targetAccIdx = col('Target Accession');
    const geneIdIdx = col('Target GeneID');
    const actValueIdx = colPrefix('Activity Value');
    const actNameIdx = col('Activity Name');

    // Extract unit from column name if present, e.g. "Activity Value [uM]" → "uM"
    const actValueUnit =
      actValueIdx >= 0 ? (columns[actValueIdx]?.match(/\[(.+)\]/)?.[1] ?? '') : '';

    const targetOf = (cell: (string | number | null)[]) => {
      const accession =
        targetAccIdx >= 0 && cell[targetAccIdx] ? String(cell[targetAccIdx]) : undefined;
      const rawGeneId = geneIdIdx >= 0 && cell[geneIdIdx] != null ? Number(cell[geneIdIdx]) : NaN;
      return { accession, geneId: rawGeneId > 0 ? rawGeneId : undefined };
    };

    // Every row naming both identifiers pairs them, whichever row of its AID it is.
    const targetPairs: Array<[string, number]> = [];
    for (const { Cell: cell } of rows) {
      const { accession, geneId } = targetOf(cell);
      if (accession && geneId) targetPairs.push([accession, geneId]);
    }
    const targetGroups = groupTargetPairs(targetPairs);
    const groupIndex = new Map<string, number>();
    for (const [i, group] of targetGroups.entries()) {
      for (const accession of group.accessions) groupIndex.set(`a:${accession}`, i);
      for (const geneId of group.geneIds) groupIndex.set(`g:${geneId}`, i);
    }
    // Rows of one AID name the same target when their identifiers fall in one group — a row
    // missing one identifier, or naming another of the protein's accessions — or are equal.
    const targetKey = (accession: string | undefined, geneId: number | undefined): string => {
      const node = accession ? `a:${accession}` : geneId ? `g:${geneId}` : '';
      const group = groupIndex.get(node);
      return group === undefined ? node : `group:${group}`;
    };

    // One record per AID. Its first target fills the record; each further target the AID's
    // rows name joins otherTargets with its own outcome. Every activity value stays with the
    // target its row names.
    const byAid = new Map<
      number,
      { row: BioactivityRow; valuesByTarget: Map<string, ActivityValue[]> }
    >();

    for (const { Cell: cell } of rows) {
      const aid = Number(cell[aidIdx]);
      if (!aid || Number.isNaN(aid)) continue;

      const { accession, geneId } = targetOf(cell);
      const outcome = String(cell[outcomeIdx] ?? '');
      const key = targetKey(accession, geneId);

      let assay = byAid.get(aid);
      if (!assay) {
        const row: BioactivityRow = {
          aid,
          assayName: String(cell[nameIdx] ?? ''),
          outcome,
          activityValues: [],
        };
        if (accession) row.targetAccession = accession;
        if (geneId) row.targetGeneId = geneId;
        assay = { row, valuesByTarget: new Map([[key, row.activityValues]]) };
        byAid.set(aid, assay);
      }
      let values = assay.valuesByTarget.get(key);
      if (!values) {
        const other: AssayTargetActivity = { outcome, activityValues: [] };
        if (accession) other.accession = accession;
        if (geneId) other.geneId = geneId;
        assay.row.otherTargets ??= [];
        assay.row.otherTargets.push(other);
        values = other.activityValues;
        assay.valuesByTarget.set(key, values);
      }

      // Collect activity value if present — omit name/unit when genuinely unknown.
      // Empty cells in PubChem's table arrive as "" (not null); Number("") is 0, which
      // would otherwise produce a misleading "Value: 0 uM". Skip blanks before coercion.
      if (actValueIdx < 0) continue;
      const rawValue = cell[actValueIdx];
      if (rawValue == null || String(rawValue).trim().length === 0) continue;
      const value = Number(rawValue);
      if (!Number.isFinite(value)) continue;

      const entry: ActivityValue = { value };
      const rawName = actNameIdx >= 0 ? cell[actNameIdx] : null;
      if (rawName != null && String(rawName).trim().length > 0) {
        entry.name = String(rawName);
      }
      if (actValueUnit) entry.unit = actValueUnit;

      const entryKey = activityKey(entry);
      if (!values.some((v) => activityKey(v) === entryKey)) {
        values.push(entry);
      }
    }

    return { rows: [...byAid.values()].map(({ row }) => row), targetGroups };
  }

  // ── Assay Search ────────────────────────────────────────────────

  async searchAssaysByTarget(
    targetType: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<number[]> {
    // PubChem API expects "accession" not "proteinaccession"
    const apiTargetType = targetType === 'proteinaccession' ? 'accession' : targetType;
    try {
      const data = await this.fetchJson<AidListResponse>(
        `${this.pugBase}/assay/target/${apiTargetType}/${encodeURIComponent(query)}/aids/JSON`,
        { signal },
      );
      return data.IdentifierList.AID;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** One page of the compounds an assay tested (or found active), without moving the whole
   * list: PubChem stores the list behind a ListKey and reports its exact size, then serves
   * `count` CIDs from `offset`. A tested-CID list runs to 305,439 entries (AID 2551).
   *
   * Returns null when PubChem has no live assay with that AID. An assay with no CIDs of the
   * requested kind is an empty page with total 0 — PubChem answers both with HTTP 404 and
   * only the fault message tells them apart. No page is requested at or past the end, which
   * PubChem answers with HTTP 500. */
  async getAssayCidPage(
    aid: number,
    activeOnly: boolean,
    offset: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<AssayCidPage | null> {
    const cidsType = activeOnly ? 'active' : 'all';
    let list: AssayCidListKeyResponse['IdentifierList'];
    try {
      const data = await this.fetchJson<AssayCidListKeyResponse>(
        `${this.pugBase}/assay/aid/${aid}/cids/JSON?cids_type=${cidsType}&list_return=listkey`,
        { signal },
      );
      list = data.IdentifierList;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (faultOf(error)?.includes(NO_LIVE_AIDS_FAULT)) return null;
      return { total: 0, cids: [] };
    }

    if (offset >= list.Size) return { total: list.Size, cids: [] };
    const params = new URLSearchParams({
      listkey_start: String(offset),
      listkey_count: String(count),
    });
    const page = await this.fetchJson<CidListResponse>(
      `${this.pugBase}/compound/listkey/${list.ListKey}/cids/JSON?${params}`,
      { signal },
    );
    return { total: list.Size, cids: page.IdentifierList.CID };
  }

  // ── Entity Summaries ────────────────────────────────────────────

  async getEntitySummary(
    entityType: string,
    identifier: string | number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const pathMap: Record<string, string> = {
      assay: `/assay/aid/${identifier}/summary/JSON`,
      gene: `/gene/geneid/${identifier}/summary/JSON`,
      protein: `/protein/accession/${encodeURIComponent(String(identifier))}/summary/JSON`,
      taxonomy: `/taxonomy/taxid/${identifier}/summary/JSON`,
    };

    const path = pathMap[entityType];
    if (!path) throw new Error(`Unknown entity type: ${entityType}`);

    try {
      const data = await this.fetchJson<Record<string, unknown>>(`${this.pugBase}${path}`, {
        signal,
      });

      // Response shape: { XxxSummaries: { XxxSummary: [{...}] } }
      const summariesKey = Object.keys(data).find((k) => k.endsWith('Summaries'));
      if (!summariesKey) return null;

      const summaries = data[summariesKey] as Record<string, unknown>;
      const summaryKey = Object.keys(summaries).find((k) => k.endsWith('Summary'));
      if (!summaryKey) return null;

      const arr = summaries[summaryKey] as Record<string, unknown>[];
      return arr[0] ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      // PubChem returns HTTP 400 (not 404) for nonexistent entity IDs in some endpoints
      if (isBadRequest(error)) return null;
      throw error;
    }
  }

  // ── Interactions ────────────────────────────────────────────────

  /** Fetch drug-drug, drug-food, and/or chemical-target interactions for a compound.
   * Drug-drug and target data live in PubChem SDQ external tables (drugbankddi, bioactivity);
   * drug-food is inline PUG View text. Each kind reads a window of `maxEntries` entries
   * starting at `offset` records into that kind's own stream; absent data for a kind
   * contributes an empty page rather than erroring. A cancellation fails the whole call. */
  async getInteractions(
    cid: number,
    kinds: Array<'drug-drug' | 'drug-food' | 'target'>,
    maxEntries: number,
    offset: number,
    signal?: AbortSignal,
  ): Promise<InteractionsResult> {
    // Per-kind isolation: a failure in one source (upstream parse error, timeout, network)
    // must not discard the kinds that succeeded. Failures are reported, not thrown (#21).
    // Page state is recorded per kind from that kind's own result, so a failing kind leaves
    // the others' continuation signals untouched rather than zeroing them.
    const settled = await Promise.allSettled(
      kinds.map((kind) => this.getInteractionsForKind(cid, kind, maxEntries, offset, signal)),
    );
    // A cancelled kind is not a failed source — reporting it as one would hand a withdrawn
    // call a partial result.
    if (signal?.aborted) throw cancellation(signal.reason);
    const entries: InteractionEntry[] = [];
    const pages: InteractionKindPage[] = [];
    const failedKinds: InteractionsResult['failedKinds'] = [];
    kinds.forEach((kind, i) => {
      const result = settled[i];
      if (result?.status === 'fulfilled') {
        const { entries: kindEntries, totalRecords, recordsConsumed } = result.value;
        entries.push(...kindEntries);
        pages.push({ kind, returnedCount: kindEntries.length, totalRecords, recordsConsumed });
      } else if (result?.status === 'rejected') {
        const reason = result.reason;
        failedKinds.push({
          kind,
          message: reason instanceof Error ? reason.message : String(reason),
          ...(reason instanceof McpError &&
            reason.data?.reason === SDQ_UNAVAILABLE && { reason: SDQ_UNAVAILABLE }),
        });
      }
    });
    return { entries, pages, failedKinds };
  }

  private getInteractionsForKind(
    cid: number,
    kind: 'drug-drug' | 'drug-food' | 'target',
    maxEntries: number,
    offset: number,
    signal: AbortSignal | undefined,
  ): Promise<InteractionKindFetch> {
    switch (kind) {
      case 'drug-drug':
        return this.getDrugDrugInteractions(cid, maxEntries, offset, signal);
      case 'drug-food':
        return this.getDrugFoodInteractions(cid, maxEntries, offset, signal);
      case 'target':
        return this.getTargetInteractions(cid, maxEntries, offset, signal);
    }
  }

  private async getDrugDrugInteractions(
    cid: number,
    maxEntries: number,
    offset: number,
    signal: AbortSignal | undefined,
  ): Promise<InteractionKindFetch> {
    const { rows, totalCount } = await this.fetchSdq(
      'drugbankddi',
      cid,
      ['cid', 'name2', 'descr'],
      maxEntries,
      offset,
      signal,
    );
    const entries: InteractionEntry[] = [];
    for (const row of rows) {
      const text = typeof row.descr === 'string' ? row.descr : '';
      if (!text) continue;
      const entry: InteractionEntry = { kind: 'drug-drug', source: 'DrugBank', text };
      if (typeof row.name2 === 'string' && row.name2) entry.partner = row.name2;
      entries.push(entry);
    }
    return {
      entries,
      totalRecords: await this.resolveSdqTotal(
        'drugbankddi',
        cid,
        rows.length,
        totalCount,
        offset,
        signal,
      ),
      recordsConsumed: rows.length,
    };
  }

  /** Chemical-target binding/activity from PubChem's `bioactivity` SDQ collection (BindingDB,
   * ChEMBL, and others). That collection is cid-keyed and scopes correctly to the requested
   * compound; the `consolidatedcompoundtarget` collection used previously is gene-indexed, so
   * its `cid` filter was silently ignored — every CID returned the same default compound (#20).
   * Only rows naming a molecular target are returned; untargeted assay outcomes are the domain
   * of pubchem_get_bioactivity.
   *
   * Because most rows are dropped, the page position is an index into the activity records, not
   * into the entries returned — the walk records exactly how many rows it read so the next page
   * resumes at the first unread one. */
  private async getTargetInteractions(
    cid: number,
    maxEntries: number,
    offset: number,
    signal: AbortSignal | undefined,
  ): Promise<InteractionKindFetch> {
    // `targetname` is sparse (most rows are untargeted assay outcomes), so oversample and keep
    // the target-bearing rows, most-potent-first.
    const window = Math.min(Math.max(maxEntries * 4, 20), 100);
    const { rows, totalCount } = await this.fetchSdq(
      'bioactivity',
      cid,
      ['cid', 'targetname', 'acname', 'acqualifier', 'acvalue', 'aidsrcname'],
      window,
      offset,
      signal,
      ['acvalue,asc'],
    );
    const entries: InteractionEntry[] = [];
    // Collapse duplicate measurements of the same target/value reported across assays.
    const seen = new Set<string>();
    let recordsConsumed = 0;
    for (const row of rows) {
      if (entries.length === maxEntries) break;
      recordsConsumed++;
      const target = typeof row.targetname === 'string' ? row.targetname.trim() : '';
      if (!target) continue;
      const acname = typeof row.acname === 'string' ? row.acname : '';
      const qualifier = typeof row.acqualifier === 'string' ? row.acqualifier : '';
      const acvalue = row.acvalue == null ? '' : String(row.acvalue).trim();
      // The bioactivity collection exposes no unit column, but its acvalue is PubChem's
      // normalized micromolar figure: depositors must submit AC-summary metrics (IC50/EC50/
      // AC50/Ki/Potency) in µM, and these values cross-validate exactly against the
      // assaysummary endpoint's "Activity Value [uM]" column. We assert that documented µM
      // convention here — it is not a per-row unit fetched from SDQ (none exists to fetch).
      const activity =
        acname && acvalue ? `${acname} ${qualifier} ${acvalue} uM`.replace(/\s+/g, ' ').trim() : '';
      const text = activity || 'Activity reported';
      const key = `${target}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        kind: 'target',
        source: typeof row.aidsrcname === 'string' && row.aidsrcname ? row.aidsrcname : 'PubChem',
        partner: target,
        text,
      });
    }
    return {
      entries,
      totalRecords: await this.resolveSdqTotal(
        'bioactivity',
        cid,
        rows.length,
        totalCount,
        offset,
        signal,
      ),
      recordsConsumed,
    };
  }

  private async getDrugFoodInteractions(
    cid: number,
    maxEntries: number,
    offset: number,
    signal: AbortSignal | undefined,
  ): Promise<InteractionKindFetch> {
    const empty: InteractionKindFetch = { entries: [], totalRecords: 0, recordsConsumed: 0 };
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Drug-Food+Interactions`,
        { signal },
      );
      const sections = data.Record.Section;
      if (!sections) return empty;
      const section = findSection(sections, 'Drug-Food Interactions');
      if (!section) return empty;

      const refToSource = referenceSources(data);

      // PUG View returns the whole section inline, so the deduped item list is the complete
      // record stream and the page is a plain slice of it.
      const items = dedupByKey(extractDescriptionItems(section), descriptionKey);
      const page = items.slice(offset, offset + maxEntries);
      return {
        entries: page.map((item) => {
          const source = item.refNum != null ? refToSource.get(item.refNum) : undefined;
          return { kind: 'drug-food', source: source ?? 'PubChem', text: item.text };
        }),
        totalRecords: items.length,
        recordsConsumed: page.length,
      };
    } catch (error) {
      if (isNotFound(error)) return empty;
      throw error;
    }
  }

  /** Query a PubChem SDQ external table for a single CID, projecting only the columns the
   * caller maps. Projection keeps payloads small and excludes the free-text `citations` column
   * whose unescaped quotes make PubChem emit invalid JSON (#20).
   *
   * Uses SDQ's `select` projection rather than `download`: the `SDQOutputSet` envelope it
   * answers with carries `totalCount` — the records matching the query across all pages —
   * beside the requested window, which is the only way to tell a full page from the last one.
   * `start` is 1-based upstream; `offset` here is zero-based like every other paging input.
   *
   * Only a JSON body carrying `SDQOutputSet` is an SDQ answer; SDQ reports "no rows" inside
   * that envelope (`eNoHitsFound`, `totalCount` 0), never as an HTTP status. Anything else —
   * a non-2xx the retry policy does not treat as transient (404 included), an HTML page at 200
   * (the reCAPTCHA wall), JSON without the envelope — throws `sdq_unavailable`: the service is
   * not answering with data, and a retry does not change that. The error names the status,
   * never the page. A transient failure (5xx, rate limit, timeout) keeps its own class. A
   * rejected query is reported, never read as "no data": the `status.error` check covers it
   * inside a 2xx body, and a JSON-shaped body that fails to parse throws with a snippet. */
  private async fetchSdq(
    collection: string,
    cid: number,
    columns: string[],
    limit: number,
    offset: number,
    signal: AbortSignal | undefined,
    order?: string[],
  ): Promise<{ rows: Array<Record<string, unknown>>; totalCount: number }> {
    const query = JSON.stringify({
      select: columns,
      collection,
      where: { ands: [{ cid: String(cid) }] },
      ...(order ? { order } : {}),
      start: offset + 1,
      limit,
    });
    const url = `${this.sdqBase}?infmt=json&outfmt=json&query=${encodeURIComponent(query)}`;

    // Rejections that bypass fetchResponse's failure logging, so they log here.
    const reject = (message: string, data: Record<string, unknown>): never => {
      logFailedRequest('warning', url, 'GET', { error: message });
      throw serviceUnavailable(message, data);
    };

    // A refusal: `sdq_unavailable`, not retryable, carrying no part of the body.
    const unavailable = (answered: string, status?: number): never =>
      reject(
        `PubChem's SDQ service answered ${answered} instead of SDQ data for collection "${collection}".`,
        {
          reason: SDQ_UNAVAILABLE,
          retryable: false,
          collection,
          cid,
          ...(status !== undefined && { status }),
        },
      );

    let body: string;
    try {
      body = await this.fetchText(url, signal);
    } catch (error) {
      const status = error instanceof McpError ? error.data?.status : undefined;
      if (typeof status === 'number' && !defaultIsTransient(error)) {
        return unavailable(`HTTP ${status}`, status);
      }
      throw error;
    }

    const trimmed = body.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return unavailable('with a non-JSON page');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reject(`PubChem SDQ returned unparseable JSON for collection "${collection}"`, {
        collection,
        cid,
        snippet: body.slice(0, 200),
      });
    }

    const output = (parsed as SdqResponse).SDQOutputSet;
    if (!Array.isArray(output)) return unavailable('with JSON carrying no SDQOutputSet');
    const set = output[0];
    if (!set) return { rows: [], totalCount: 0 };
    if (set.status?.error) {
      return reject(
        `PubChem SDQ rejected the query for collection "${collection}": ${set.status.error}`,
        { collection, cid, sdqError: set.status.error },
      );
    }
    return { rows: set.rows ?? [], totalCount: set.totalCount ?? 0 };
  }

  /** Resolve a kind's record total for the page just fetched.
   *
   * SDQ reports `totalCount` alongside every non-empty page, but a `start` past the last record
   * answers `totalCount` 0 — so an offset that overshoots would otherwise report "no records"
   * for a compound that has thousands. A one-row probe from the top recovers the real bound,
   * and only runs on that case. */
  private async resolveSdqTotal(
    collection: string,
    cid: number,
    rowsReturned: number,
    reportedTotal: number,
    offset: number,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    if (rowsReturned > 0 || offset === 0) return reportedTotal;
    const { totalCount } = await this.fetchSdq(collection, cid, ['cid'], 1, 0, signal);
    return totalCount;
  }

  // ── 3D Structure ────────────────────────────────────────────────

  /** Fetch the default 3D conformer as raw V2000 SDF text. Throws a typed not-found on a 404,
   * which PubChem returns with the same fault both when the compound has no computed 3D
   * coordinates (large molecules, mixtures, undefined salts) and when the CID has no record.
   * The recovery hint comes from the `no_3d_structure` entry the calling tool declares. */
  async getSdf3d(cid: number, signal?: AbortSignal): Promise<string> {
    try {
      return await this.fetchText(
        `${this.pugBase}/compound/cid/${cid}/record/SDF?record_type=3d`,
        signal,
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw notFound(`No 3D conformer available for CID ${cid}.`, {
          cid,
          reason: 'no_3d_structure',
        });
      }
      throw error;
    }
  }

  /** List the conformer IDs PubChem has computed for a compound. Returns [] on not-found. */
  async getConformerIds(cid: number, signal?: AbortSignal): Promise<string[]> {
    try {
      const data = await this.fetchJson<ConformerListResponse>(
        `${this.pugBase}/compound/cid/${cid}/conformers/JSON`,
        { signal },
      );
      return data.InformationList.Information[0]?.ConformerID ?? [];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }
}

// ── Init/Accessor ────────────────────────────────────────────────────

let _client: PubChemClient | undefined;

export function initPubChemClient(): void {
  _client = new PubChemClient();
}

export function getPubChemClient(): PubChemClient {
  if (!_client)
    throw new Error('PubChemClient not initialized — call initPubChemClient() in setup()');
  return _client;
}
