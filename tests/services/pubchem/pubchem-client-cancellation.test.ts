/**
 * @fileoverview Caller cancellation through the real PubChemClient (#54): a caller signal stops
 * the request before its first fetch, mid-fetch, during a retry backoff, while queued behind the
 * rate limiter, and between ListKey polls — surfacing `RequestCancelled`, never retried, never
 * logged as a failed request, and never absorbed as "no data" or a failed interaction kind. The
 * 30 s timeout keeps its own behavior alongside a live caller signal. `fetch` is stubbed with an
 * implementation that honors `init.signal` the way the platform fetch does.
 * @module tests/services/pubchem/pubchem-client-cancellation
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

/** Rejects the way the platform fetch does once `signal` aborts: with its reason. */
function rejectOnAbort(signal: AbortSignal | null | undefined, reject: (e: unknown) => void): void {
  if (!signal) return;
  const fail = () => reject(signal.reason);
  if (signal.aborted) fail();
  else signal.addEventListener('abort', fail, { once: true });
}

/** A fetch PubChem never answers: settles only when its signal aborts. */
const hangUntilAborted: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => rejectOnAbort(init?.signal, reject));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A 200 whose body never finishes arriving, and errors when the request's signal aborts —
 * the platform fetch ties the body stream to the same signal as the request. */
function stalledBody(init: RequestInit | undefined): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"InformationList":'));
      rejectOnAbort(init?.signal, (reason) => controller.error(reason));
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Observes a promise without awaiting it, so fake timers can be driven in between. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

/** Settles a client call while fake timers drive its sleeps and timeouts. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const captured = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return captured;
}

function extrasOf(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => ({ ...(call[1] as RequestContext | undefined)?.extra }));
}

const SYNONYMS_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/synonyms/JSON';

const cancelled = {
  code: JsonRpcErrorCode.RequestCancelled,
  message: expect.not.stringMatching(/timed out/),
};

describe('PubChem request timeout', () => {
  it.each([
    ['without a caller signal', undefined],
    ['beside a live caller signal', new AbortController().signal],
  ])(
    'times out a request PubChem never answers at 30 s, retries once, and logs one warning %s',
    async (_label, signal) => {
      const warning = vi.spyOn(logger, 'warning');
      fetchMock.mockImplementation(hangUntilAborted);

      const { error } = await settle(new PubChemClient().getSynonyms(2244, signal));

      expect((error as Error).message).toBe('PubChem request timed out (30s)');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(extrasOf(warning)[0]).toMatchObject({
        url: SYNONYMS_URL,
        method: 'GET',
        error: 'PubChem request timed out (30s)',
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('PubChem caller cancellation (#54)', () => {
  it('never fetches when the signal is already aborted', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const controller = new AbortController();
    controller.abort();

    const call = track(new PubChemClient().getSynonyms(2244, controller.signal));
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it('stops a fetch in flight without retrying, logging, or leaving a timer behind', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();

    const call = track(new PubChemClient().getSynonyms(2244, controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it('stops while the response body is still arriving', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async (_input, init) => stalledBody(init));
    const controller = new AbortController();

    const call = track(new PubChemClient().getSynonyms(2244, controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an upstream 503',
      () => fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 })),
    ],
    ['a network error', () => fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))],
  ])('stops during the retry backoff after %s', async (_label, failFirst) => {
    const warning = vi.spyOn(logger, 'warning');
    failFirst();
    const controller = new AbortController();

    const call = track(new PubChemClient().getSynonyms(2244, controller.signal));
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it('stops an async search between ListKey polls, past the first poll', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(async () => jsonResponse({ Waiting: { ListKey: 'lk-54' } }));
    const controller = new AbortController();

    const call = track(
      new PubChemClient().searchByStructure(
        'similarity',
        'CCO',
        'smiles',
        90,
        21,
        controller.signal,
      ),
    );
    // Initial request at 0 ms, poll 1 at 1500 ms, poll 2 at 3000 ms; poll 3 would be 4500 ms.
    await vi.advanceTimersByTimeAsync(3700);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/compound/listkey/lk-54/cids/JSON');
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warning).not.toHaveBeenCalled();
  });

  it('gives up its rate-limiter place when cancelled while queued', async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const client = new PubChemClient();
    const others = new AbortController();
    const inFlight = [1, 2, 3, 4, 5].map((cid) => track(client.getSynonyms(cid, others.signal)));
    const controller = new AbortController();

    const queued = track(client.getSynonyms(6, controller.signal));
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(queued.error).toMatchObject(cancelled);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    others.abort();
    await vi.runAllTimersAsync();
    for (const call of inFlight) expect(call.error).toMatchObject(cancelled);
  });

  it('fails an interactions call instead of reporting its kinds as failed', async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();

    const call = track(
      new PubChemClient().getInteractions(
        2244,
        ['drug-drug', 'drug-food', 'target'],
        5,
        0,
        controller.signal,
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.value).toBeUndefined();
    expect(call.error).toMatchObject(cancelled);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /** Every public method, including the ones that read a 404 or 400 as "no data" — a
   * cancellation must reach the caller, never an empty result. */
  const calls: Array<[string, (c: PubChemClient, s: AbortSignal) => Promise<unknown>]> = [
    ['searchByName', (c, s) => c.searchByName('aspirin', s)],
    ['searchBySmiles', (c, s) => c.searchBySmiles('CCO', s)],
    ['searchByInchiKey', (c, s) => c.searchByInchiKey('BSYNRYMUTXBXSQ-UHFFFAOYSA-N', s)],
    ['searchByFormula', (c, s) => c.searchByFormula('C6H12O6', false, 21, s)],
    ['searchByStructure', (c, s) => c.searchByStructure('substructure', '2244', 'cid', 90, 21, s)],
    ['getProperties', (c, s) => c.getProperties([2244], ['MolecularFormula'], s)],
    ['getSynonyms', (c, s) => c.getSynonyms(2244, s)],
    ['getImage', (c, s) => c.getImage(2244, 'small', s)],
    ['getXrefs', (c, s) => c.getXrefs(2244, 'RN', s)],
    ['getDescription', (c, s) => c.getDescription(2244, s)],
    ['getSafetyData', (c, s) => c.getSafetyData(2244, s)],
    ['getClassification', (c, s) => c.getClassification(2244, s)],
    ['getAssaySummary', (c, s) => c.getAssaySummary(2244, s)],
    ['searchAssaysByTarget', (c, s) => c.searchAssaysByTarget('genesymbol', 'EGFR', s)],
    ['getEntitySummary', (c, s) => c.getEntitySummary('assay', 1, s)],
    ['getInteractions', (c, s) => c.getInteractions(2244, ['drug-drug'], 5, 0, s)],
    ['getSdf3d', (c, s) => c.getSdf3d(2244, s)],
    ['getConformerIds', (c, s) => c.getConformerIds(2244, s)],
  ];

  it.each(calls)('%s surfaces a mid-fetch cancellation as RequestCancelled', async (_name, run) => {
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();

    const call = track(run(new PubChemClient(), controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
