/**
 * @fileoverview PubChem API client with rate limiting, retry, and response parsing.
 * Wraps both PUG REST and PUG View APIs behind a shared rate limiter.
 * @module services/pubchem/pubchem-client
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import type {
  AidListResponse,
  AssaySummaryTableResponse,
  BioactivityRow,
  CidListResponse,
  CompoundClassification,
  ConformerListResponse,
  GHSClassification,
  InteractionEntry,
  InteractionsResult,
  ListKeyResponse,
  PropertyTableResponse,
  PugViewInformation,
  PugViewResponse,
  PugViewSection,
  SafetyLookup,
  SynonymResponse,
  XrefResponse,
} from './types.js';

const isNotFound = (error: unknown): boolean =>
  error instanceof McpError && error.code === JsonRpcErrorCode.NotFound;

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
const isMissingRecord = (error: unknown): boolean => {
  if (!isNotFound(error)) return false;
  const { fault } = ((error as McpError).data ?? {}) as { fault?: unknown };
  return typeof fault === 'string' && fault.includes('No record found');
};

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

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
 * its base, so both survive the later dedup-by-code. */
function parseCodedStatement(text: string): { code: string; statement: string } | undefined {
  const match = text.match(
    /^([HP]\d{3}[A-Za-z]{0,2}(?:\+[HP]\d{3}[A-Za-z]{0,2})*)\s*(?:(?:\([^)]*\)|\*+)\s*)*[:\-–]\s*(.+)/,
  );
  if (match?.[1] && match[2]) return { code: match[1], statement: match[2].trim() };
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

/** Identity key for bioactivity entry dedup within an AID. */
const activityKey = (v: { name?: string; value: number; unit?: string }) =>
  `${v.name ?? ''}|${v.value}|${v.unit ?? ''}`;

// ── Client ───────────────────────────────────────────────────────────

export class PubChemClient {
  private readonly pugBase = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
  private readonly viewBase = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view';
  private readonly sdqBase = 'https://pubchem.ncbi.nlm.nih.gov/sdq/sdqagent.cgi';
  private readonly rateLimiter = new RateLimiter(5);

  // ── Core HTTP ────────────────────────────────────────────────────

  /** Shared HTTP core: rate-limit, 30s timeout, retry once on 5xx and once on a transient
   * network error, and surface a clean timeout message. Returns the ok Response; callers
   * extract the body (JSON, bytes, or text). Centralizing this keeps every fetch variant on
   * one resilience contract — the divergence that left fetchBinary without retry or a clean
   * timeout message (#16) cannot recur. */
  private async fetchResponse(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.rateLimiter.acquire();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });

        if (response.ok) return response;

        const text = await response.text();
        const fault = parseFaultMessage(text) ?? text.slice(0, 300);

        // Retry once on 5xx
        if (response.status >= 500 && attempt < 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }

        throw await httpErrorFromResponse(response, {
          captureBody: false,
          service: 'PubChem',
          data: { fault, url },
        });
      } catch (error) {
        // HTTP errors are already classified — surface them, don't retry.
        if (error instanceof McpError) throw error;

        // Retry once on network errors
        if (attempt < 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('PubChem request timed out (30s)');
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchResponse(url, init);
    return (await response.json()) as T;
  }

  private async fetchBinary(url: string): Promise<ArrayBuffer> {
    const response = await this.fetchResponse(url);
    return response.arrayBuffer();
  }

  /** Fetch a text/plain body (e.g. an SDF record). Non-2xx is classified and thrown. */
  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchResponse(url);
    return response.text();
  }

  // ── CID Resolution ──────────────────────────────────────────────

  /** Fetch CID list, with automatic ListKey polling for async searches.
   *
   * `maxRecords` carries a bounded search's cap into the ListKey retrieval. A search that
   * answers synchronously is already bounded by the `MaxRecords` on its own URL, but that
   * bound lives in the request, not the ListKey — so an async answer would otherwise return
   * the full match set and the caller would read PubChem's ceiling as a real count. Omitted
   * for identifier lookups, which are unbounded by design. */
  private async fetchCids(url: string, init?: RequestInit, maxRecords?: number): Promise<number[]> {
    try {
      const data = await this.fetchJson<CidListResponse | ListKeyResponse>(url, init);
      if ('Waiting' in data) return this.pollListKey(data.Waiting.ListKey, maxRecords);
      return data.IdentifierList.CID;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Poll a PubChem ListKey until results are ready.
   *
   * `listkey_count` asks PubChem to trim the page; the slice enforces the same bound
   * locally, so the caller's saturation test holds whether or not the parameter is honored. */
  private async pollListKey(
    listKey: string,
    maxRecords?: number,
    maxAttempts = 20,
  ): Promise<number[]> {
    const query = maxRecords === undefined ? '' : `?listkey_count=${maxRecords}`;
    const pollUrl = `${this.pugBase}/compound/listkey/${listKey}/cids/JSON${query}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(1500);
      try {
        const data = await this.fetchJson<CidListResponse | ListKeyResponse>(pollUrl);
        if ('Waiting' in data) continue;
        const cids = data.IdentifierList.CID;
        return maxRecords === undefined ? cids : cids.slice(0, maxRecords);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    }
    throw new Error('PubChem async search timed out after polling');
  }

  searchByName(name: string): Promise<number[]> {
    return this.fetchCids(`${this.pugBase}/compound/name/${encodeURIComponent(name)}/cids/JSON`);
  }

  searchBySmiles(smiles: string): Promise<number[]> {
    return this.fetchCids(`${this.pugBase}/compound/smiles/cids/JSON`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ smiles }).toString(),
    });
  }

  searchByInchiKey(inchikey: string): Promise<number[]> {
    return this.fetchCids(
      `${this.pugBase}/compound/inchikey/${encodeURIComponent(inchikey)}/cids/JSON`,
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
  searchByFormula(formula: string, allowOther: boolean, maxRecords: number): Promise<number[]> {
    const params = new URLSearchParams({ MaxRecords: String(maxRecords) });
    if (allowOther) params.set('AllowOtherElements', 'true');
    return this.fetchCids(
      `${this.pugBase}/compound/fastformula/${encodeURIComponent(formula)}/cids/JSON?${params}`,
      undefined,
      maxRecords,
    );
  }

  /** Substructure, superstructure, and 2D-similarity search, bounded server-side by
   * `maxRecords`. Same cap contract as {@link searchByFormula}. */
  searchByStructure(
    mode: 'substructure' | 'superstructure' | 'similarity',
    query: string,
    queryType: 'smiles' | 'cid',
    threshold: number | undefined,
    maxRecords: number,
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
      return this.fetchCids(
        `${this.pugBase}/compound/${endpoint}/cid/${query}/cids/JSON?${params}`,
        undefined,
        maxRecords,
      );
    }

    // POST for SMILES to avoid encoding issues
    const url = `${this.pugBase}/compound/${endpoint}/smiles/cids/JSON?${params}`;
    return this.fetchCids(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ smiles: query }).toString(),
      },
      maxRecords,
    );
  }

  // ── Compound Data ───────────────────────────────────────────────

  async getProperties(
    cids: number[],
    properties: string[],
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
            },
          )
        : await this.fetchJson<PropertyTableResponse>(
            `${this.pugBase}/compound/cid/${cidStr}/property/${propsPath}/JSON`,
          );

    // PubChem returns different field names than the request names for some properties.
    // Normalize so consumers see the names they requested.
    return data.PropertyTable.Properties.map(normalizePropertyNames);
  }

  async getSynonyms(cid: number): Promise<string[]> {
    try {
      const data = await this.fetchJson<SynonymResponse>(
        `${this.pugBase}/compound/cid/${cid}/synonyms/JSON`,
      );
      return data.InformationList.Information[0]?.Synonym ?? [];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async getImage(cid: number, size: 'small' | 'large' = 'large'): Promise<ArrayBuffer> {
    const sizeParam = size === 'small' ? '?image_size=small' : '?image_size=large';
    try {
      return await this.fetchBinary(`${this.pugBase}/compound/cid/${cid}/PNG${sizeParam}`);
    } catch (error) {
      // The image endpoint returns binary, so absence can't be a structured success like
      // the other per-CID tools — surface a typed not-found with a recovery hint instead.
      if (isNotFound(error)) {
        throw notFound(`No PubChem compound found for CID ${cid}.`, {
          cid,
          reason: 'cid_not_found',
          recovery: { hint: 'Verify the CID with pubchem_search_compounds before retrying.' },
        });
      }
      throw error;
    }
  }

  async getXrefs(cid: number, xrefType: string): Promise<(string | number)[]> {
    try {
      const data = await this.fetchJson<XrefResponse>(
        `${this.pugBase}/compound/cid/${cid}/xrefs/${xrefType}/JSON`,
      );
      const info = data.InformationList.Information[0];
      if (!info) return [];
      const values = info[xrefType];
      return Array.isArray(values) ? (values as (string | number)[]) : [];
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // ── PUG View ────────────────────────────────────────────────────

  async getDescription(cid: number): Promise<Array<{ source?: string; text: string }>> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Record+Description`,
      );

      const sections = data.Record.Section;
      if (!sections) return [];

      const descSection = findSection(sections, 'Record Description');
      if (!descSection) return [];

      // Build refNum → SourceName lookup so each description can carry attribution.
      const refToSource = new Map<number, string>();
      for (const ref of data.Record.Reference ?? []) {
        refToSource.set(ref.ReferenceNumber, ref.SourceName);
      }

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
   * absent result. */
  async getSafetyData(cid: number): Promise<SafetyLookup> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Safety+and+Hazards`,
      );

      const sections = data.Record.Section;
      if (!sections) return { status: 'no_ghs_data' };

      const ghsSection = findSection(sections, 'GHS Classification');
      if (!ghsSection) return { status: 'no_ghs_data' };

      const infos = extractGHSInfo(ghsSection);
      const result: GHSClassification = {
        pictograms: [],
        hazardStatements: [],
        precautionaryStatements: [],
      };

      for (const info of infos) {
        const name = info.Name?.toLowerCase() ?? '';
        const strings = info.Value.StringWithMarkup?.map((s) => s.String).filter(Boolean) ?? [];

        if (name.includes('signal') && strings[0]) {
          result.signalWord = strings[0];
        } else if (name.includes('pictogram')) {
          const extras =
            info.Value.StringWithMarkup?.flatMap(
              (s) => s.Markup?.map((m) => m.Extra).filter((e): e is string => e != null) ?? [],
            ) ?? [];
          result.pictograms.push(...(extras.length > 0 ? extras : strings).map(parsePictogram));
        } else if (name.includes('hazard') && name.includes('statement')) {
          for (const s of strings) {
            const parsed = parseCodedStatement(s);
            if (parsed) result.hazardStatements.push(parsed);
          }
        } else if (name.includes('precautionary') && name.includes('statement')) {
          // PubChem deposits precautionary statements as a single comma-separated code
          // list (codes only, no text) — not the "Pxxx: text" shape parseCodedStatement
          // expects. Split each list into individual code entries.
          for (const s of strings) {
            result.precautionaryStatements.push(...parsePrecautionaryCodes(s));
          }
        }
      }

      // Deduplicate across depositors
      result.pictograms = [...new Set(result.pictograms)];
      result.hazardStatements = dedupByKey(result.hazardStatements, (h) => h.code);
      result.precautionaryStatements = dedupByKey(result.precautionaryStatements, (p) => p.code);

      // Extract source from references
      const refs = data.Record.Reference;
      if (refs?.[0]?.SourceName) {
        result.source = refs[0].SourceName;
      }

      return result.signalWord || result.pictograms.length > 0 || result.hazardStatements.length > 0
        ? { status: 'ok', ghs: result }
        : { status: 'no_ghs_data' };
    } catch (error) {
      if (isMissingRecord(error)) return { status: 'cid_not_found' };
      if (isNotFound(error)) return { status: 'no_ghs_data' };
      throw error;
    }
  }

  async getClassification(cid: number): Promise<CompoundClassification | null> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Pharmacology+and+Biochemistry`,
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
        const strings = extractStrings(atcSection);
        for (const s of strings) {
          // Match leaf codes like "N02BA01 - Acetylsalicylic acid" or bare "N02BA01"
          const match = s.match(/^([A-Z]\d{2}[A-Z]{2}\d{2})\b/);
          if (match) {
            const desc = s.includes(' - ') ? s.split(' - ').slice(1).join(' - ').trim() : '';
            result.atcCodes.push({ code: match[1] ?? '', description: desc });
          }
        }
        result.atcCodes = dedupByKey(result.atcCodes, (a) => a.code);
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

  async getAssaySummary(cid: number): Promise<BioactivityRow[]> {
    try {
      const data = await this.fetchJson<AssaySummaryTableResponse>(
        `${this.pugBase}/compound/cid/${cid}/assaysummary/JSON`,
      );
      return this.parseAssayTable(data);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private parseAssayTable(data: AssaySummaryTableResponse): BioactivityRow[] {
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

    // Group by AID to collect multiple activity values
    const byAid = new Map<number, BioactivityRow>();

    for (const row of rows) {
      const cell = row.Cell;
      const aid = Number(cell[aidIdx]);
      if (!aid || Number.isNaN(aid)) continue;

      if (!byAid.has(aid)) {
        const entry: BioactivityRow = {
          aid,
          assayName: String(cell[nameIdx] ?? ''),
          outcome: String(cell[outcomeIdx] ?? ''),
          activityValues: [],
        };
        if (targetAccIdx >= 0 && cell[targetAccIdx])
          entry.targetAccession = String(cell[targetAccIdx]);
        if (geneIdIdx >= 0 && cell[geneIdIdx] != null) {
          const gid = Number(cell[geneIdIdx]);
          if (!Number.isNaN(gid) && gid > 0) entry.targetGeneId = gid;
        }
        byAid.set(aid, entry);
      }

      // Collect activity value if present — omit name/unit when genuinely unknown.
      // Empty cells in PubChem's table arrive as "" (not null); Number("") is 0, which
      // would otherwise produce a misleading "Value: 0 uM". Skip blanks before coercion.
      if (actValueIdx < 0) continue;
      const rawValue = cell[actValueIdx];
      if (rawValue == null || String(rawValue).trim().length === 0) continue;
      const value = Number(rawValue);
      if (!Number.isFinite(value)) continue;
      const bucket = byAid.get(aid);
      if (!bucket) continue;

      const entry: { name?: string; value: number; unit?: string } = { value };
      const rawName = actNameIdx >= 0 ? cell[actNameIdx] : null;
      if (rawName != null && String(rawName).trim().length > 0) {
        entry.name = String(rawName);
      }
      if (actValueUnit) entry.unit = actValueUnit;

      const key = activityKey(entry);
      if (!bucket.activityValues.some((v) => activityKey(v) === key)) {
        bucket.activityValues.push(entry);
      }
    }

    return [...byAid.values()];
  }

  // ── Assay Search ────────────────────────────────────────────────

  async searchAssaysByTarget(targetType: string, query: string): Promise<number[]> {
    // PubChem API expects "accession" not "proteinaccession"
    const apiTargetType = targetType === 'proteinaccession' ? 'accession' : targetType;
    try {
      const data = await this.fetchJson<AidListResponse>(
        `${this.pugBase}/assay/target/${apiTargetType}/${encodeURIComponent(query)}/aids/JSON`,
      );
      return data.IdentifierList.AID;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // ── Entity Summaries ────────────────────────────────────────────

  async getEntitySummary(
    entityType: string,
    identifier: string | number,
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
      const data = await this.fetchJson<Record<string, unknown>>(`${this.pugBase}${path}`);

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
      if (error instanceof McpError && (error.data as { status?: number })?.status === 400) {
        return null;
      }
      throw error;
    }
  }

  // ── Interactions ────────────────────────────────────────────────

  /** Fetch drug-drug, drug-food, and/or chemical-target interactions for a compound.
   * Drug-drug and target data live in PubChem SDQ external tables (drugbankddi,
   * consolidatedcompoundtarget); drug-food is inline PUG View text. Each kind is capped
   * at maxEntries; absent data for a kind contributes nothing rather than erroring. */
  async getInteractions(
    cid: number,
    kinds: Array<'drug-drug' | 'drug-food' | 'target'>,
    maxEntries: number,
  ): Promise<InteractionsResult> {
    // Per-kind isolation: a failure in one source (upstream parse error, timeout, network)
    // must not discard the kinds that succeeded. Failures are reported, not thrown (#21).
    const settled = await Promise.allSettled(
      kinds.map((kind) => this.getInteractionsForKind(cid, kind, maxEntries)),
    );
    const entries: InteractionEntry[] = [];
    const failedKinds: Array<{ kind: string; message: string }> = [];
    kinds.forEach((kind, i) => {
      const result = settled[i];
      if (result?.status === 'fulfilled') {
        entries.push(...result.value);
      } else if (result?.status === 'rejected') {
        const reason = result.reason;
        failedKinds.push({
          kind,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });
    return { entries, failedKinds };
  }

  private getInteractionsForKind(
    cid: number,
    kind: 'drug-drug' | 'drug-food' | 'target',
    maxEntries: number,
  ): Promise<InteractionEntry[]> {
    switch (kind) {
      case 'drug-drug':
        return this.getDrugDrugInteractions(cid, maxEntries);
      case 'drug-food':
        return this.getDrugFoodInteractions(cid, maxEntries);
      case 'target':
        return this.getTargetInteractions(cid, maxEntries);
    }
  }

  private async getDrugDrugInteractions(
    cid: number,
    maxEntries: number,
  ): Promise<InteractionEntry[]> {
    const rows = await this.fetchSdq('drugbankddi', cid, ['cid', 'name2', 'descr'], maxEntries);
    const entries: InteractionEntry[] = [];
    for (const row of rows) {
      const text = typeof row.descr === 'string' ? row.descr : '';
      if (!text) continue;
      const entry: InteractionEntry = { kind: 'drug-drug', source: 'DrugBank', text };
      if (typeof row.name2 === 'string' && row.name2) entry.partner = row.name2;
      entries.push(entry);
    }
    return entries;
  }

  /** Chemical-target binding/activity from PubChem's `bioactivity` SDQ collection (BindingDB,
   * ChEMBL, and others). That collection is cid-keyed and scopes correctly to the requested
   * compound; the `consolidatedcompoundtarget` collection used previously is gene-indexed, so
   * its `cid` filter was silently ignored — every CID returned the same default compound (#20).
   * Only rows naming a molecular target are returned; untargeted assay outcomes are the domain
   * of pubchem_get_bioactivity. */
  private async getTargetInteractions(
    cid: number,
    maxEntries: number,
  ): Promise<InteractionEntry[]> {
    // `targetname` is sparse (most rows are untargeted assay outcomes), so oversample and keep
    // the target-bearing rows, most-potent-first.
    const window = Math.min(Math.max(maxEntries * 4, 20), 100);
    const rows = await this.fetchSdq(
      'bioactivity',
      cid,
      ['cid', 'targetname', 'acname', 'acqualifier', 'acvalue', 'aidsrcname'],
      window,
      ['acvalue,asc'],
    );
    const entries: InteractionEntry[] = [];
    for (const row of rows) {
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
      entries.push({
        kind: 'target',
        source: typeof row.aidsrcname === 'string' && row.aidsrcname ? row.aidsrcname : 'PubChem',
        partner: target,
        text: activity || 'Activity reported',
      });
    }
    // Collapse duplicate measurements of the same target/value reported across assays.
    return dedupByKey(entries, (e) => `${e.partner ?? ''}|${e.text}`).slice(0, maxEntries);
  }

  private async getDrugFoodInteractions(
    cid: number,
    maxEntries: number,
  ): Promise<InteractionEntry[]> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Drug-Food+Interactions`,
      );
      const sections = data.Record.Section;
      if (!sections) return [];
      const section = findSection(sections, 'Drug-Food Interactions');
      if (!section) return [];

      const refToSource = new Map<number, string>();
      for (const ref of data.Record.Reference ?? []) {
        refToSource.set(ref.ReferenceNumber, ref.SourceName);
      }

      const items = dedupByKey(extractDescriptionItems(section), descriptionKey);
      return items.slice(0, maxEntries).map((item) => {
        const source = item.refNum != null ? refToSource.get(item.refNum) : undefined;
        return { kind: 'drug-food', source: source ?? 'PubChem', text: item.text };
      });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Query a PubChem SDQ external table for a single CID, projecting only the columns the
   * caller maps. Projection keeps payloads small and excludes the free-text `citations` column
   * whose unescaped quotes make PubChem emit invalid JSON (#20). Returns [] on not-found; on an
   * unparseable body throws a contextful error rather than the bare `Failed to parse JSON`, so
   * the caller and per-kind isolation can report it cleanly. */
  private async fetchSdq(
    collection: string,
    cid: number,
    columns: string[],
    limit: number,
    order?: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const query = JSON.stringify({
      download: columns,
      collection,
      where: { ands: [{ cid: String(cid) }] },
      ...(order ? { order } : {}),
      start: 1,
      limit,
    });
    const url = `${this.sdqBase}?infmt=json&outfmt=json&query=${encodeURIComponent(query)}`;

    let body: string;
    try {
      body = await this.fetchText(url);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    try {
      const data = JSON.parse(body) as unknown;
      return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    } catch {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `PubChem SDQ returned unparseable JSON for collection "${collection}"`,
        { collection, cid, snippet: body.slice(0, 200) },
      );
    }
  }

  // ── 3D Structure ────────────────────────────────────────────────

  /** Fetch the default 3D conformer as raw V2000 SDF text. Throws a typed not-found when
   * PubChem has no computed 3D coordinates (large molecules, mixtures, undefined salts). */
  async getSdf3d(cid: number): Promise<string> {
    try {
      return await this.fetchText(`${this.pugBase}/compound/cid/${cid}/record/SDF?record_type=3d`);
    } catch (error) {
      if (isNotFound(error)) {
        throw notFound(`No 3D conformer available for CID ${cid}.`, {
          cid,
          reason: 'no_3d_structure',
          recovery: {
            hint: 'PubChem has no computed 3D coordinates for this compound (common for very large molecules, mixtures, and undefined salts). Use pubchem_get_compound_image for the 2D structure.',
          },
        });
      }
      throw error;
    }
  }

  /** List the conformer IDs PubChem has computed for a compound. Returns [] on not-found. */
  async getConformerIds(cid: number): Promise<string[]> {
    try {
      const data = await this.fetchJson<ConformerListResponse>(
        `${this.pugBase}/compound/cid/${cid}/conformers/JSON`,
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
