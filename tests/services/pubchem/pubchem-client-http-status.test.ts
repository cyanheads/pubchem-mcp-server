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

const SYNONYMS_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/synonyms/JSON';

describe('PubChem HTTP retry classification', () => {
  it('retries an upstream 500 once and preserves its classified failure and fault', async () => {
    fetchMock.mockImplementation(async () => new Response('Upstream failed', { status: 500 }));
    const assertion = expect(new PubChemClient().getSynonyms(2244)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 500, fault: 'Upstream failed' },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails a 501 immediately with the framework retry opt-out', async () => {
    fetchMock.mockImplementation(async () => new Response('Not implemented', { status: 501 }));
    const assertion = expect(new PubChemClient().getSynonyms(2244)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 501, retryable: false, fault: 'Not implemented' },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the upstream request URL off client-facing error data', async () => {
    // `error.data` is forwarded to the caller as `structuredContent.error.data`, and a
    // PubChem request URL carries the caller's own query — a name, a SMILES string, an
    // SDQ query blob. The fault stays; the URL does not.
    fetchMock.mockImplementation(async () => new Response('Upstream failed', { status: 503 }));
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
    expect(error.data?.fault).toBe('Upstream failed');
  });
});

/** PubChem's JSON fault envelope, as the PUG REST routes send it. */
function pugRestFault(code: string, message: string, status: number): Response {
  return Response.json({ Fault: { Code: code, Message: message } }, { status });
}

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

describe('PubChem failed-request logging (#50)', () => {
  it('logs nothing from the client for a successful request', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const debug = vi.spyOn(logger, 'debug');
    fetchMock.mockResolvedValueOnce(
      Response.json({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } }),
    );

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual(['aspirin']);
    expect(warning).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
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

  it('logs nothing for a 503 that recovers on retry', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock
      .mockResolvedValueOnce(new Response('Upstream failed', { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } }),
      );

    await settle(new PubChemClient().getSynonyms(2244));

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
    expect(debug).toHaveBeenCalledTimes(1);
    expect(extrasOf(debug)[0]).toMatchObject({ url: SYNONYMS_URL, method: 'GET', status: 404 });
  });

  it('logs one warning with the URL after a network error exhausts its retry', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect(error).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({
      url: SYNONYMS_URL,
      method: 'GET',
      error: 'fetch failed',
    });
  });

  it('logs one warning with the URL after a timeout exhausts its retry', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const { error } = await settle(new PubChemClient().getSynonyms(2244));

    expect((error as Error).message).toBe('PubChem request timed out (30s)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(extrasOf(warning)[0]).toMatchObject({
      url: SYNONYMS_URL,
      error: 'PubChem request timed out (30s)',
    });
  });

  it('logs nothing for a network error that recovers on retry', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        Response.json({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } }),
      );

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual(['aspirin']);
    expect(warning).not.toHaveBeenCalled();
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
      { kind: 'drug-drug', message: expect.stringMatching(message) },
    ]);
    expect(warning).toHaveBeenCalledTimes(1);
    const extra = extrasOf(warning)[0];
    expect(extra?.url).toMatch(/^https:\/\/pubchem\.ncbi\.nlm\.nih\.gov\/sdq\/sdqagent\.cgi\?/);
    expect(decodeURIComponent(String(extra?.url))).toContain('"collection":"drugbankddi"');
    expect(extra).toMatchObject({ method: 'GET', error: expect.stringMatching(message) });
  });
});
