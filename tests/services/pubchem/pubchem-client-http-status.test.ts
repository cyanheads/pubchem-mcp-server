/**
 * @fileoverview Verifies PubChem's HTTP retry policy against framework classification,
 * and the server-side log line each failed request leaves behind.
 * @module tests/services/pubchem/pubchem-client-http-status
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { logger, type RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PubChemClient } from '@/services/pubchem/pubchem-client.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Settles a client call while fake timers drive its retry sleep. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const captured = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return captured;
}

/** The `extra` bag each call to a spied logger method carried. */
function extrasOf(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => ({ ...(call[1] as RequestContext | undefined)?.extra }));
}

/** The client's own failed-request records among a spied logger method's calls. The framework
 * fetch helper writes its own debug lines for every exchange; these tests pin the client's. */
function failedRequestRecords(spy: {
  mock: { calls: unknown[][] };
}): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => String(call[0]).startsWith('PubChem request failed'))
    .map((call) => ({ ...(call[1] as RequestContext | undefined)?.extra }));
}

/** A fetch PubChem never answers: settles only when its signal aborts, with the reason. */
const hangUntilAborted: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const SYNONYMS_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/synonyms/JSON';

const synonymsOk = () =>
  Response.json({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } });

/** A name only the request URL carries, so a trace of it in an error is a trace of the URL. */
const QUERY_TERM = 'zyxquerytermalpha';

/** What the caller receives of an error — its message and its data, as the wire serializes
 * them — checked for any trace of the request: the host, the REST path, the query. */
function expectNoRequestTrace(error: unknown): void {
  const { message, data } = error as { message: string; data?: unknown };
  const wire = JSON.stringify({ message, data });
  expect(wire).not.toContain('pubchem.ncbi.nlm.nih.gov');
  expect(wire).not.toContain('/rest/');
  expect(wire).not.toContain(QUERY_TERM);
}

/** PubChem's throttling answer: an HTML page, not a fault envelope. */
const html429 = () =>
  new Response(
    '<!doctype html><html><head><title>429 Too Many Requests</title></head><body><h1>Too Many Requests</h1></body></html>',
    { status: 429, headers: { 'Content-Type': 'text/html' } },
  );

describe('PubChem HTTP retry classification', () => {
  it('retries an upstream 500 once and preserves its classified failure, with no unparsed fault', async () => {
    fetchMock.mockImplementation(async () => new Response('Upstream failed', { status: 500 }));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 500 },
    });
    expect((error as { data?: object }).data).not.toHaveProperty('fault');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails a 501 immediately with the framework retry opt-out', async () => {
    fetchMock.mockImplementation(async () => new Response('Not implemented', { status: 501 }));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 501, retryable: false },
    });
    expect((error as { data?: object }).data).not.toHaveProperty('fault');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, JsonRpcErrorCode.InvalidParams],
    [408, JsonRpcErrorCode.Timeout],
    [429, JsonRpcErrorCode.RateLimited],
  ])('fails an HTTP %i on the first attempt, without a retry', async (status, code) => {
    fetchMock.mockImplementation(async () => new Response('refused', { status }));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code, data: { status } });
    expect((error as { data?: object }).data).not.toHaveProperty('fault');
  });

  it('keeps the upstream request URL off client-facing error data', async () => {
    // `error.data` is forwarded to the caller as `structuredContent.error.data`, and a
    // PubChem request URL carries the caller's own query — a name, a SMILES string, an
    // SDQ query blob. The fault stays; the URL does not.
    fetchMock.mockImplementation(async () =>
      pugRestFault('PUGREST.ServerBusy', 'Upstream failed', 503),
    );
    const captured = new PubChemClient()
      .getSynonyms(2244)
      .then<never, { data?: Record<string, unknown> }>(
        () => {
          throw new Error('expected the 503 to reject');
        },
        (e: unknown) => e as { data?: Record<string, unknown> },
      );
    await vi.runAllTimersAsync();
    const error = await captured;

    expect(error.data).toBeDefined();
    expect(error.data).not.toHaveProperty('url');
    expect(error.data?.fault).toBe('PUGREST.ServerBusy: Upstream failed');
  });
});

/** PubChem's JSON fault envelope, as the PUG REST routes send it. */
function pugRestFault(code: string, message: string, status: number): Response {
  return Response.json({ Fault: { Code: code, Message: message } }, { status });
}

describe('PubChem fault text in the error message (#59)', () => {
  it('states a parsed PUG REST fault in the message of a 400', async () => {
    fetchMock.mockResolvedValueOnce(
      pugRestFault('PUGREST.BadRequest', 'Invalid ID, must be positive integer', 400),
    );

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { status: 400, fault: 'PUGREST.BadRequest: Invalid ID, must be positive integer' },
    });
    expect((error as Error).message).toContain(
      'PUGREST.BadRequest: Invalid ID, must be positive integer',
    );
  });

  it('states a parsed plain-text fault (the image route form) in the message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Status: 400\nCode: PUGREST.BadRequest\nMessage: Invalid ID\n', {
        status: 400,
      }),
    );

    const { error } = await settle(new PubChemClient().getImage(2244));

    expect((error as Error).message).toContain('PUGREST.BadRequest: Invalid ID');
  });

  it('keeps an unparsed body out of the message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><title>400 Bad Request</title>', { status: 400 }),
    );

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({ code: JsonRpcErrorCode.InvalidParams, data: { status: 400 } });
    expect((error as Error).message).toBe('PubChem returned HTTP 400.');
  });

  it('states a parsed fault once, though PubChem sends its code as the status text too', async () => {
    // PubChem's status line reads "400 PUGREST.BadRequest", so the status text repeats the
    // fault code the envelope already names.
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { Fault: { Code: 'PUGREST.BadRequest', Message: 'Invalid ID, must be positive integer' } },
        { status: 400, statusText: 'PUGREST.BadRequest' },
      ),
    );

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect((error as Error).message).toBe(
      'PubChem returned HTTP 400: PUGREST.BadRequest: Invalid ID, must be positive integer',
    );
    expect(error).toMatchObject({ data: { status: 400, statusText: 'PUGREST.BadRequest' } });
  });

  it('keeps the status text in the message when no fault was parsed', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><title>400</title>', { status: 400, statusText: 'Bad Request' }),
    );

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect((error as Error).message).toBe('PubChem returned HTTP 400 Bad Request.');
  });
});

describe('an HTTP failure that exhausts its retry reads as one sentence', () => {
  it('names the attempts in the head of an unparsed 503', async () => {
    fetchMock.mockImplementation(
      async () => new Response('', { status: 503, statusText: 'Service Unavailable' }),
    );

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((error as Error).message).toBe(
      'PubChem returned HTTP 503 Service Unavailable after 2 attempts.',
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503, statusText: 'Service Unavailable', retryAttempts: 2 },
    });
  });

  it('names the attempts before a parsed fault', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        { Fault: { Code: 'PUGREST.ServerBusy', Message: 'Too many requests or server too busy' } },
        { status: 503, statusText: 'PUGREST.ServerBusy' },
      ),
    );

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect((error as Error).message).toBe(
      'PubChem returned HTTP 503 after 2 attempts: PUGREST.ServerBusy: Too many requests or server too busy',
    );
    expect(error).toMatchObject({
      data: { fault: 'PUGREST.ServerBusy: Too many requests or server too busy', retryAttempts: 2 },
    });
  });
});

describe('data.fault holds only a fault PubChem stated', () => {
  it('omits fault for the HTML page PubChem answers a 429 with', async () => {
    fetchMock.mockImplementation(async () => html429());

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited, data: { status: 429 } });
    expect((error as { data?: object }).data).not.toHaveProperty('fault');
    expect((error as Error).message).toBe('PubChem returned HTTP 429.');
    expect(JSON.stringify((error as { data?: object }).data)).not.toMatch(/doctype|<html/i);
  });

  it.each([
    [400, 'refused'],
    [500, 'Upstream failed'],
    [503, '<!DOCTYPE html><title>503 Service Unavailable</title>'],
  ])('omits fault for an unparsed HTTP %i body', async (status, body) => {
    fetchMock.mockImplementation(async () => new Response(body, { status }));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({ data: { status } });
    expect((error as { data?: object }).data).not.toHaveProperty('fault');
  });

  it('logs an unparsed failure with its status and no fault field', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async () => html429());

    await settle(new PubChemClient().getSynonyms(2244));

    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({ url: SYNONYMS_URL, status: 429 });
    expect(extrasOf(warning)[0]).not.toHaveProperty('fault');
  });

  it('reads an unparsed 404 as "no data", logging it at debug without a fault field', async () => {
    const debug = vi.spyOn(logger, 'debug');
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual([]);
    const [record] = failedRequestRecords(debug);
    expect(record).toMatchObject({ url: SYNONYMS_URL, status: 404 });
    expect(record).not.toHaveProperty('fault');
  });

  it('rejects an identifier PubChem answered with an unparsed 400 without a fault', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><title>400 Bad Request</title>', { status: 400 }),
    );

    const { error } = await settle(new PubChemClient().searchByName(QUERY_TERM));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'identifier_rejected' },
    });
    expect((error as { data?: object }).data).not.toHaveProperty('fault');
  });

  it('rejects an InChI PubChem cannot standardize on the first attempt, keeping its fault and no trace of the InChI (#80)', async () => {
    const message =
      'Unable to standardize the given structure - perhaps some special characters need to be escaped or data packed in a MIME form?';
    fetchMock.mockImplementation(async () => pugRestFault('PUGREST.BadRequest', message, 400));

    const { error } = await settle(new PubChemClient().searchByInchi(`InChI=1S/${QUERY_TERM}`));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'identifier_rejected', fault: `PUGREST.BadRequest: ${message}` },
    });
    expectNoRequestTrace(error);
  });
});

describe('a 200 whose body cannot be read fails like a network error', () => {
  /** A 200 whose connection drops partway through the body. */
  const cutMidBody = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"IdentifierList":'));
          controller.error(new TypeError('The socket connection was closed unexpectedly.'));
        },
      }),
      { status: 200 },
    );

  it.each([
    ['a body that is not JSON', () => new Response('<!doctype html><title>Busy</title>')],
    ['a body cut off mid-stream', cutMidBody],
  ])(
    'fails %s as ServiceUnavailable after one retry, with nothing of the request',
    async (_label, respond) => {
      const warning = vi.spyOn(logger, 'warning');
      fetchMock.mockImplementation(async () => respond());

      const { error } = await settle(new PubChemClient().searchByName(QUERY_TERM));

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'PubChem sent a response that could not be read. Retry shortly.',
      });
      expect((error as { data?: unknown }).data).toEqual({ retryAttempts: 2 });
      expectNoRequestTrace(error);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The server log keeps the route.
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(extrasOf(warning)[0]?.url)).toContain(QUERY_TERM);
    },
  );

  it('returns the retry result when only the first body was unreadable', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<!doctype html><title>Busy</title>'))
      .mockResolvedValueOnce(synonymsOk());

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual(['aspirin']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a network failure reaches the caller with nothing of the request', () => {
  it.each([
    ['the runtime text', () => new TypeError('fetch failed')],
    [
      'runtime text that names the host',
      () =>
        Object.assign(new TypeError('getaddrinfo ENOTFOUND pubchem.ncbi.nlm.nih.gov'), {
          code: 'ENOTFOUND',
        }),
    ],
  ])('keeps the URL, host, and query off message and data (%s)', async (_label, failure) => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async () => {
      throw failure();
    });

    const { error } = await settle(new PubChemClient().searchByName(QUERY_TERM));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'PubChem could not be reached (network error). Retry shortly.',
      data: { retryAttempts: 2 },
    });
    expectNoRequestTrace(error);
    // Still retried once; the server log keeps the route and the runtime's own text.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(extrasOf(warning)[0]?.url)).toContain(QUERY_TERM);
    expect(String(extrasOf(warning)[0]?.error)).toContain(failure().message);
  });
});

describe('PubChem "Search status indicates failure" is fetched once (#52)', () => {
  const rejected = () =>
    pugRestFault('PUGREST.ServerError', 'Search status indicates failure', 500);

  it.each([
    [
      'a SMILES structure search',
      (c: PubChemClient) => c.searchByStructure('substructure', 'not-a-smiles', 'smiles', 90, 21),
    ],
    [
      'a CID structure search',
      (c: PubChemClient) => c.searchByStructure('similarity', '999999999', 'cid', 90, 21),
    ],
    ['a formula search', (c: PubChemClient) => c.searchByFormula('not-a-formula', false, 21)],
  ])('does not retry the fault on %s', async (_label, call) => {
    fetchMock.mockImplementation(async () => rejected());

    const { error } = await settle(call(new PubChemClient()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { fault: 'PUGREST.ServerError: Search status indicates failure' },
    });
  });

  it('skips the retry on any route drawing the fault, without re-labelling it', async () => {
    // Only fast-search routes have been seen to emit this fault; the retry gate keys on the
    // fault alone, while the typed mapping belongs to the search methods that know the form.
    fetchMock.mockImplementation(async () => rejected());

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 500, fault: 'PUGREST.ServerError: Search status indicates failure' },
    });
  });
});

describe('PubChem fast-search failures other than a rejected query (#52 regression)', () => {
  it('retries a 500 carrying any other PUGREST.ServerError fault once', async () => {
    fetchMock.mockImplementation(async () =>
      pugRestFault('PUGREST.ServerError', 'Internal server error', 500),
    );

    const { error } = await settle(
      new PubChemClient().searchByStructure('substructure', 'CCO', 'smiles', undefined, 21),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 500, fault: 'PUGREST.ServerError: Internal server error' },
    });
  });

  it('retries a 504 PUGREST.Timeout once and keeps its Timeout classification', async () => {
    fetchMock.mockImplementation(async () =>
      pugRestFault('PUGREST.Timeout', 'Request timed out', 504),
    );

    const { error } = await settle(
      new PubChemClient().searchByStructure('substructure', 'CCCC', 'smiles', undefined, 21),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { status: 504, fault: 'PUGREST.Timeout: Request timed out' },
    });
  });

  it('reads a 404 no-hits search as an empty match set after one request', async () => {
    fetchMock.mockResolvedValueOnce(
      pugRestFault('PUGREST.NotFound', 'Search returned no hits', 404),
    );

    const { value } = await settle(
      new PubChemClient().searchByStructure('similarity', '[H][H]', 'smiles', 90, 21),
    );

    expect(value).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('an HTTP 400 on a caller-built query is a typed rejection (#81, #87)', () => {
  /** PubChem's front-end answer to a path segment carrying a line break or other control
   * character: an HTML page, no PUG-REST fault. */
  const html400 = () =>
    new Response('<!DOCTYPE html><title>400 Bad Request</title>', {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });

  type Rejecting = [string, (c: PubChemClient) => Promise<unknown>, string, RegExp | undefined];
  const routes: Rejecting[] = [
    [
      'a target lookup',
      (c) => c.searchAssaysByTarget('genesymbol', `${QUERY_TERM}\nFR`),
      'target_query_rejected',
      undefined,
    ],
    [
      'a formula search',
      (c) => c.searchByFormula(`C6H\n${QUERY_TERM}`, false, 21),
      'search_query_rejected',
      /Hill notation/,
    ],
    [
      'a SMILES structure search',
      (c) => c.searchByStructure('substructure', `C${QUERY_TERM}`, 'smiles', 90, 21),
      'search_query_rejected',
      /SMILES syntax/,
    ],
    [
      'a CID structure search',
      (c) => c.searchByStructure('similarity', '2244', 'cid', 90, 21),
      'search_query_rejected',
      /CID 2244/,
    ],
    // Pins the existing identifier mapping the other routes now share.
    ['an identifier lookup', (c) => c.searchByName(QUERY_TERM), 'identifier_rejected', undefined],
  ];

  it.each(routes)(
    'fails %s answered with an unparsed 400 as a ValidationError with its reason and no fault, after one request',
    async (_label, call, reason, hint) => {
      fetchMock.mockImplementation(async () => html400());

      const { error } = await settle(call(new PubChemClient()));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError, data: { reason } });
      const data = (error as { data?: { recovery?: { hint?: string } } }).data;
      expect(data).not.toHaveProperty('fault');
      if (hint) expect(data?.recovery?.hint).toMatch(hint);
      expectNoRequestTrace(error);
    },
  );

  it.each(routes)(
    'carries the fault PubChem stated on a 400 from %s',
    async (_label, call, reason) => {
      fetchMock.mockImplementation(async () =>
        pugRestFault('PUGREST.BadRequest', 'Unable to parse the input', 400),
      );

      const { error } = await settle(call(new PubChemClient()));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason, fault: 'PUGREST.BadRequest: Unable to parse the input' },
      });
    },
  );

  it.each([
    ['an HTML 404 (NUL in the path)', () => new Response('404: Not Found', { status: 404 })],
    ['a PUG-REST 404 (tab in the path)', () => pugRestFault('PUGREST.NotFound', 'No data', 404)],
  ])('reads a target lookup answered with %s as no assays', async (_label, respond) => {
    fetchMock.mockImplementation(async () => respond());

    const { value } = await settle(
      new PubChemClient().searchAssaysByTarget('genesymbol', 'EG\u0000FR'),
    );

    expect(value).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 503', () => new Response('busy', { status: 503 }), JsonRpcErrorCode.ServiceUnavailable],
    [
      'a 504',
      () => pugRestFault('PUGREST.Timeout', 'Request timed out', 504),
      JsonRpcErrorCode.Timeout,
    ],
  ])(
    'retries a target lookup answered with %s once and keeps its classification',
    async (_label, respond, code) => {
      fetchMock.mockImplementation(async () => respond());

      const { error } = await settle(
        new PubChemClient().searchAssaysByTarget('genesymbol', 'EGFR'),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(error).toMatchObject({ code });
      expect((error as { data?: object }).data).not.toHaveProperty('reason');
    },
  );
});

describe('PubChem failed-request logging (#50)', () => {
  it('logs nothing from the client for a successful request', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const debug = vi.spyOn(logger, 'debug');
    fetchMock.mockResolvedValueOnce(synonymsOk());

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual(['aspirin']);
    expect(warning).not.toHaveBeenCalled();
    expect(failedRequestRecords(debug)).toEqual([]);
  });

  it('logs one warning with the URL after a 503 exhausts its retry, keeping url off error.data', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async () => new Response('Upstream failed', { status: 503 }));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({ url: SYNONYMS_URL, method: 'GET', status: 503 });
    expect((error as { data?: Record<string, unknown> }).data).not.toHaveProperty('url');
  });

  it.each([
    ['a 503', () => Promise.resolve(new Response('Upstream failed', { status: 503 }))],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('logs nothing for %s that recovers on retry', async (_label, firstAttempt) => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementationOnce(firstAttempt).mockResolvedValueOnce(synonymsOk());

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual(['aspirin']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
  });

  it('logs a non-retried 501 at warning once', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async () => new Response('Not implemented', { status: 501 }));

    await settle(new PubChemClient().getSynonyms(2244));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({ url: SYNONYMS_URL, status: 501 });
  });

  it('logs a 400 at warning with the fault and the POST method', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          Fault: {
            Code: 'PUGREST.BadRequest',
            Message: 'Unable to standardize the given structure',
          },
        },
        { status: 400 },
      ),
    );

    const { error } = await settle(new PubChemClient().searchBySmiles('not-a-smiles'));

    expect(error).toBeDefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({
      url: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/cids/JSON',
      method: 'POST',
      status: 400,
      fault: 'PUGREST.BadRequest: Unable to standardize the given structure',
    });
  });

  it('logs a 404 at debug with the URL and never at warning', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const debug = vi.spyOn(logger, 'debug');
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { Fault: { Code: 'PUGREST.NotFound', Message: 'No CID found' } },
        { status: 404 },
      ),
    );

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
    expect(failedRequestRecords(debug)).toEqual([
      expect.objectContaining({
        url: SYNONYMS_URL,
        method: 'GET',
        status: 404,
        fault: 'PUGREST.NotFound: No CID found',
      }),
    ]);
  });

  it('logs one warning with the URL after a network error exhausts its retry', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    // The framework fetch classifies a network failure; the runtime's text rides the log line,
    // never the caller's message.
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect((error as Error).message).not.toContain('fetch failed');
    expect((error as Error).message).not.toContain('/rest/pug');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({
      url: SYNONYMS_URL,
      method: 'GET',
      error: expect.stringContaining('fetch failed'),
    });
  });

  it('logs one warning with the URL after a timeout exhausts its retry', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(hangUntilAborted);

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    // The log line names the clock that fired; the caller's message does not.
    expect(extrasOf(warning)[0]).toMatchObject({
      url: SYNONYMS_URL,
      error: expect.stringContaining('retry deadline'),
    });
  });

  it.each([
    [
      'an SDQ status.error in a 2xx body',
      () => Response.json({ SDQOutputSet: [{ status: { error: 'bad collection' } }] }),
      /rejected the query/,
    ],
    [
      'an unparseable SDQ body',
      () => new Response('{"SDQOutputSet": [ {"rows": [', { status: 200 }),
      /unparseable JSON/,
    ],
  ])('logs the SDQ URL at warning for %s', async (_label, respond, message) => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async () => respond());

    const { value } = await settle(new PubChemClient().getInteractions(2244, ['drug-drug'], 5, 0));

    expect(value?.failedKinds).toEqual([
      { kind: 'drug-drug', message: expect.stringMatching(message), retryable: true },
    ]);
    expect(warning).toHaveBeenCalledTimes(1);
    const extra = extrasOf(warning)[0];
    expect(extra?.url).toMatch(/^https:\/\/pubchem\.ncbi\.nlm\.nih\.gov\/sdq\/sdqagent\.cgi\?/);
    expect(decodeURIComponent(String(extra?.url))).toContain('"collection":"drugbankddi"');
    expect(extra).toMatchObject({ method: 'GET', error: expect.stringMatching(message) });
  });
});
