/**
 * @fileoverview Caller cancellation across the tool surface (#54). Every tool runs through
 * `runToolContract` with the real PubChemClient and a stubbed `fetch` that honors
 * `init.signal`, so a handler that fails to hand `ctx.signal` to the client shows up as an
 * upstream request, and a cancellation absorbed into a degraded success (an unresolved
 * identifier, a failed interaction kind) shows up as a non-error result.
 * @module tests/mcp-server/tools/definitions/tool-cancellation.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBioactivity } from '@/mcp-server/tools/definitions/get-bioactivity.tool.js';
import { getCompound3dStructure } from '@/mcp-server/tools/definitions/get-compound-3d-structure.tool.js';
import { getCompoundDetails } from '@/mcp-server/tools/definitions/get-compound-details.tool.js';
import { getCompoundImage } from '@/mcp-server/tools/definitions/get-compound-image.tool.js';
import { getCompoundInteractions } from '@/mcp-server/tools/definitions/get-compound-interactions.tool.js';
import { getCompoundSafety } from '@/mcp-server/tools/definitions/get-compound-safety.tool.js';
import { getCompoundXrefs } from '@/mcp-server/tools/definitions/get-compound-xrefs.tool.js';
import { getSummary } from '@/mcp-server/tools/definitions/get-summary.tool.js';
import { searchAssays } from '@/mcp-server/tools/definitions/search-assays.tool.js';
import { searchCompounds } from '@/mcp-server/tools/definitions/search-compounds.tool.js';
import { initPubChemClient } from '@/services/pubchem/pubchem-client.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initPubChemClient();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch PubChem never answers: rejects with the signal's reason once it aborts. */
const hangUntilAborted: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** True when a fetch targets this PubChem path. */
function isPubChemPath(input: Parameters<typeof fetch>[0], pathname: string): boolean {
  const url = new URL(String(input));
  return url.hostname === 'pubchem.ncbi.nlm.nih.gov' && url.pathname === pathname;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Observes a tool run without awaiting it, so fake timers can be driven in between. */
function track(run: Promise<ToolResult>): { result?: ToolResult } {
  const state: { result?: ToolResult } = {};
  void run.then((result) => {
    state.result = result;
  });
  return state;
}

/** Asserts the cancellation envelope on both client surfaces. */
function expectCancelled(result: ToolResult | undefined): void {
  if (!result) throw new Error('expected the tool call to have settled after the cancellation');
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as { error: { code: number; message: string } };
  expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
  expect(error.message).not.toMatch(/timed out/);
  const text = result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  expect(text).toContain(error.message);
  expect(result.structuredContent).not.toHaveProperty('results');
  expect(result.structuredContent).not.toHaveProperty('entries');
}

describe('tool handlers hand ctx.signal to PubChem (#54)', () => {
  const cases = [
    [
      'pubchem_search_compounds',
      () =>
        runWith(searchCompounds, {
          searchType: 'identifier',
          identifierType: 'name',
          identifiers: ['aspirin'],
        }),
    ],
    ['pubchem_get_compound_details', () => runWith(getCompoundDetails, { cids: [2244] })],
    ['pubchem_get_compound_image', () => runWith(getCompoundImage, { cid: 2244 })],
    ['pubchem_get_compound_3d_structure', () => runWith(getCompound3dStructure, { cid: 2244 })],
    ['pubchem_get_compound_safety', () => runWith(getCompoundSafety, { cids: [2244] })],
    [
      'pubchem_get_compound_xrefs',
      () => runWith(getCompoundXrefs, { cid: 2244, xrefTypes: ['RN'] }),
    ],
    ['pubchem_get_compound_interactions', () => runWith(getCompoundInteractions, { cid: 2244 })],
    ['pubchem_get_bioactivity', () => runWith(getBioactivity, { cid: 2244 })],
    [
      'pubchem_search_assays',
      () => runWith(searchAssays, { targetType: 'genesymbol', targetQuery: 'EGFR' }),
    ],
    ['pubchem_get_summary', () => runWith(getSummary, { entityType: 'assay', identifiers: ['1'] })],
  ] as const;

  let signal: AbortSignal;
  function runWith<D extends Parameters<typeof runToolContract>[0]>(
    definition: D,
    input: Parameters<typeof runToolContract<D>>[1],
  ): Promise<ToolResult> {
    return runToolContract(definition, input, { context: { signal } });
  }

  it.each(cases)('%s makes no request once the call is cancelled', async (_name, run) => {
    const controller = new AbortController();
    controller.abort();
    signal = controller.signal;

    const call = track(run());
    await vi.advanceTimersByTimeAsync(0);

    expectCancelled(call.result);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails an identifier batch cancelled mid-batch instead of listing the rest as unresolved', async () => {
    fetchMock.mockImplementation((input, init) =>
      isPubChemPath(input, '/rest/pug/compound/name/aspirin/cids/JSON')
        ? Promise.resolve(jsonResponse({ IdentifierList: { CID: [2244] } }))
        : hangUntilAborted(input, init),
    );
    const controller = new AbortController();
    signal = controller.signal;

    const call = track(
      runWith(searchCompounds, {
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: ['aspirin', 'ibuprofen', 'caffeine'],
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expectCancelled(call.result);
    expect(call.result?.structuredContent).not.toHaveProperty('unresolvedIdentifiers');
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops a similarity search on its second ListKey poll wait', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ Waiting: { ListKey: 'lk-tool' } }));
    const controller = new AbortController();
    signal = controller.signal;

    const call = track(
      runWith(searchCompounds, { searchType: 'similarity', query: 'CCO', queryType: 'smiles' }),
    );
    await vi.advanceTimersByTimeAsync(3700);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expectCancelled(call.result);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails an interactions call cancelled mid-fetch instead of reporting failed kinds', async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const controller = new AbortController();
    signal = controller.signal;

    const call = track(
      runWith(getCompoundInteractions, { cid: 2244, kinds: ['drug-drug', 'drug-food', 'target'] }),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expectCancelled(call.result);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('one time budget per tool call', () => {
  /** Answers with `body` `ms` after the request is sent, unless its signal aborts first. */
  const answerAfter = (ms: number, body: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(body)), ms);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });

  it('ends an assay search whose chained requests outrun 50 s as Timeout, before 60 s', async () => {
    // ListKey, then the page, 20 s each; the property hydration that follows never answers.
    fetchMock.mockImplementation((input, init) => {
      if (isPubChemPath(input, '/rest/pug/assay/aid/1000/cids/JSON')) {
        return answerAfter(20_000, { IdentifierList: { ListKey: 'lk-budget', Size: 3 } }, init);
      }
      if (isPubChemPath(input, '/rest/pug/compound/listkey/lk-budget/cids/JSON')) {
        return answerAfter(20_000, { IdentifierList: { CID: [11, 12, 13] } }, init);
      }
      return hangUntilAborted(input, init);
    });
    const signal = new AbortController().signal;

    const call = track(
      runToolContract(
        searchCompounds,
        { searchType: 'assay', aid: 1000, properties: ['MolecularWeight'] },
        { context: { signal } },
      ),
    );
    await vi.advanceTimersByTimeAsync(49_990);
    expect(call.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);

    const { result } = call;
    if (!result) throw new Error('expected the tool call to have settled at the budget');
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as { error: { code: number; message: string } };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'PubChem did not respond in time; the request timed out. Retry shortly.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
