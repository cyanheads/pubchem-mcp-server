/**
 * @fileoverview Verifies PubChem's HTTP retry policy against framework classification.
 * @module tests/services/pubchem/pubchem-client-http-status
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PubChemClient } from '@/services/pubchem/pubchem-client.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
