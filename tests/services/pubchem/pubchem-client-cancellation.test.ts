/**
 * @fileoverview Caller cancellation through the real PubChemClient (#54): a caller signal stops
 * the request before its first fetch, mid-fetch, during a retry backoff, while queued behind the
 * rate limiter, and between ListKey polls — surfacing `RequestCancelled`, never retried, never
 * logged as a failed request, and never absorbed as "no data" or a failed interaction kind. The
 * per-call time budget (#57) — 50 s shared by every request of one call, 30 s per attempt, one
 * retry, settled before an MCP client's 60 s timeout, stalled bodies included — keeps its own
 * behavior alongside a live caller signal. `fetch` is stubbed with an
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

/** The MCP SDK client's default request timeout. A PubChem request must settle before it, or
 * the caller sees its own client's timeout instead of this server's classified failure. */
const CLIENT_TIMEOUT_MS = 60_000;

describe('PubChem per-call time budget (#57)', () => {
  it.each([
    ['without a caller signal', undefined],
    ['beside a live caller signal', new AbortController().signal],
  ])(
    'times out a request PubChem never answers: 30 s per attempt, one retry, Timeout before 60 s, one warning %s',
    async (_label, signal) => {
      const warning = vi.spyOn(logger, 'warning');
      fetchMock.mockImplementation(hangUntilAborted);

      const call = track(new PubChemClient().getSynonyms(2244, signal));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Attempt 1 times out at 30 s; the retry goes out after a 1 s backoff.
      await vi.advanceTimersByTimeAsync(1_002);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS - 1 - 31_001);

      expect(call.settled).toBe(true);
      expect(call.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect((call.error as Error).message).not.toContain('/rest/pug');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(1);
      // The log line names the clock that fired; the caller's message does not.
      expect(extrasOf(warning)[0]).toMatchObject({
        url: SYNONYMS_URL,
        method: 'GET',
        error: expect.stringContaining('retry deadline'),
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  const bodyReaders: Array<[string, (c: PubChemClient) => Promise<unknown>]> = [
    ['fetchJson', (c) => c.getSynonyms(2244)],
    ['fetchText', (c) => c.getSdf3d(2244)],
    ['fetchBinary', (c) => c.getImage(2244)],
  ];

  it.each(bodyReaders)(
    'ends a 200 whose body stalls after the headers with Timeout before 60 s (%s)',
    async (_reader, run) => {
      fetchMock.mockImplementation(async (_input, init) => stalledBody(init));

      const call = track(run(new PubChemClient()));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS - 1);

      expect(call.settled).toBe(true);
      expect(call.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      // The stalled attempt counts as transient: retried once, still inside the one deadline.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ends a retry cancelled mid-body as RequestCancelled, not as the deadline', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock
      .mockImplementationOnce(hangUntilAborted)
      .mockImplementationOnce(async (_input, init) => stalledBody(init));
    const controller = new AbortController();

    const call = track(new PubChemClient().getSynonyms(2244, controller.signal));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(warning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  /** A name only the request URL carries, so a trace of it in an error is a trace of the URL. */
  const queryTerm = 'zyxquerytermbeta';
  const unavailable = () => new Response('Service Unavailable', { status: 503 });

  it.each([
    ['PubChem never answers: the request deadline ends it', () => hangUntilAborted],
    [
      'a 503, then a retry that never answers: the attempt timer ends it',
      () => {
        fetchMock.mockResolvedValueOnce(unavailable());
        return hangUntilAborted;
      },
    ],
    [
      'a 503, then a retry whose body stalls: the attempt timer ends it mid-body',
      () => {
        fetchMock.mockResolvedValueOnce(unavailable());
        return (async (_input, init) => stalledBody(init)) satisfies typeof fetch;
      },
    ],
  ])(
    'reaches the caller as one Timeout with nothing of the request in it (%s)',
    async (_label, arrange) => {
      const warning = vi.spyOn(logger, 'warning');
      fetchMock.mockImplementation(arrange());

      const { error } = await settle(new PubChemClient().searchByName(queryTerm));

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'PubChem did not respond in time; the request timed out. Retry shortly.',
      });
      expect((error as { data?: unknown }).data).toEqual({ retryAttempts: 2 });
      const wire = JSON.stringify({
        message: (error as Error).message,
        data: (error as { data?: unknown }).data,
      });
      expect(wire).not.toContain('pubchem.ncbi.nlm.nih.gov');
      expect(wire).not.toContain('/rest/');
      expect(wire).not.toContain(queryTerm);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The server log keeps the route and which clock fired.
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(extrasOf(warning)[0]?.url)).toContain(queryTerm);
      expect(String(extrasOf(warning)[0]?.error)).toMatch(/retry deadline|timed out/);
    },
  );

  it('settles a stalled body that a recovering retry follows with the retry result', async () => {
    fetchMock
      .mockImplementationOnce(async (_input, init) => stalledBody(init))
      .mockResolvedValueOnce(
        jsonResponse({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } }),
      );

    const { value } = await settle(new PubChemClient().getSynonyms(2244));

    expect(value).toEqual(['aspirin']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('one time budget per call, shared by every request on its signal', () => {
  const TIMEOUT_MESSAGE = 'PubChem did not respond in time; the request timed out. Retry shortly.';
  const synonyms = () =>
    jsonResponse({ InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin'] }] } });

  /** A fetch PubChem answers `ms` after it is sent, unless the request's signal aborts first.
   * Kept under the 30 s attempt cap, so each answer lands on its first attempt. */
  const answersAfter =
    (ms: number): typeof fetch =>
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(synonyms()), ms);
        rejectOnAbort(init?.signal, (reason) => {
          clearTimeout(timer);
          reject(reason);
        });
      });

  /** Two requests in sequence, as a tool chaining them makes them. */
  async function chain(client: PubChemClient, first?: AbortSignal, second?: AbortSignal) {
    await client.getSynonyms(2244, first);
    return client.getSynonyms(2244, second);
  }

  it('ends a second request on the same signal when the call has spent 50 s, not 50 s later', async () => {
    fetchMock.mockImplementationOnce(answersAfter(20_000)).mockImplementation(hangUntilAborted);
    const signal = new AbortController().signal;

    const call = track(chain(new PubChemClient(), signal, signal));
    await vi.advanceTimersByTimeAsync(49_990);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);

    expect(call.settled).toBe(true);
    expect(call.error).toMatchObject({ code: JsonRpcErrorCode.Timeout, message: TIMEOUT_MESSAGE });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a request on a spent signal at once, without sending it', async () => {
    const warning = vi.spyOn(logger, 'warning');
    fetchMock.mockImplementation(hangUntilAborted);
    const signal = new AbortController().signal;
    const client = new PubChemClient();

    const first = track(client.getSynonyms(2244, signal));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(first.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    const sent = fetchMock.mock.calls.length;

    const second = track(client.getSynonyms(2244, signal));
    await vi.advanceTimersByTimeAsync(0);

    expect(second.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: TIMEOUT_MESSAGE,
    });
    expect(fetchMock).toHaveBeenCalledTimes(sent);
    // The server log names the spent budget and the route it stopped.
    expect(extrasOf(warning).at(-1)).toMatchObject({
      url: SYNONYMS_URL,
      error: expect.stringContaining('budget'),
    });
  });

  it('gives a request on another signal a budget of its own', async () => {
    // 25 s + 28 s outruns one 50 s budget, not two.
    fetchMock
      .mockImplementationOnce(answersAfter(25_000))
      .mockImplementationOnce(answersAfter(28_000));

    const call = track(
      chain(new PubChemClient(), new AbortController().signal, new AbortController().signal),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(call.value).toEqual(['aspirin']);
  });

  it('still ends a budgeted call the caller cancels as RequestCancelled', async () => {
    fetchMock.mockImplementationOnce(answersAfter(20_000)).mockImplementation(hangUntilAborted);
    const controller = new AbortController();

    const call = track(chain(new PubChemClient(), controller.signal, controller.signal));
    await vi.advanceTimersByTimeAsync(45_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.error).toMatchObject(cancelled);
    expect(vi.getTimerCount()).toBe(0);
  });
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
    ['getAssayCidPage', (c, s) => c.getAssayCidPage(1000, true, 0, 20, s)],
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
