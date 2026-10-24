/**
 * @fileoverview Tests for lookupXrefs — the per-type cross-reference lookup shared by the
 * pubchem_get_compound_xrefs tool and the pubchem://compound/{cid}/xrefs resource: routing
 * CAS/EC to PUG View, request order, per-type failure isolation, the stop on a throttling
 * answer, and an empty ProteinGI counting as no answer.
 * @module services/pubchem/xref-lookup.test
 */

import {
  invalidRequest,
  rateLimited,
  requestCancelled,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it, vi } from 'vitest';
import { lookupXrefs } from '@/services/pubchem/xref-lookup.js';

function fakeClient() {
  return {
    getXrefs:
      vi.fn<(cid: number, type: string, signal?: AbortSignal) => Promise<(string | number)[]>>(),
    getHeadingXrefs:
      vi.fn<
        (
          cid: number,
          type: 'CAS' | 'EC',
          signal?: AbortSignal,
        ) => Promise<Array<{ id: string; sourceCount: number }>>
      >(),
  };
}

describe('lookupXrefs — routing', () => {
  it('reads CAS and EC from PUG View and every other type from PUG REST, in request order', async () => {
    const client = fakeClient();
    client.getXrefs.mockResolvedValueOnce(['50-78-2']).mockResolvedValueOnce([1, 2]);
    client.getHeadingXrefs
      .mockResolvedValueOnce([{ id: '50-78-2', sourceCount: 19 }])
      .mockResolvedValueOnce([{ id: '200-064-1', sourceCount: 1 }]);
    const signal = new AbortController().signal;

    const result = await lookupXrefs(client, 2244, ['RN', 'CAS', 'GeneID', 'EC'], signal);

    expect(result).toEqual({
      groups: [
        { type: 'RN', ids: ['50-78-2'] },
        { type: 'CAS', ids: ['50-78-2'], sourceCounts: [19] },
        { type: 'GeneID', ids: [1, 2] },
        { type: 'EC', ids: ['200-064-1'], sourceCounts: [1] },
      ],
      failed: [],
    });
    expect(client.getXrefs.mock.calls).toEqual([
      [2244, 'RN', signal],
      [2244, 'GeneID', signal],
    ]);
    expect(client.getHeadingXrefs.mock.calls).toEqual([
      [2244, 'CAS', signal],
      [2244, 'EC', signal],
    ]);
  });

  it('starts each type only after the previous one settles', async () => {
    const client = fakeClient();
    let releaseFirst!: (ids: string[]) => void;
    client.getXrefs.mockReturnValueOnce(new Promise((resolve) => (releaseFirst = resolve)));
    client.getHeadingXrefs.mockResolvedValueOnce([]);

    const pending = lookupXrefs(client, 2244, ['RN', 'CAS'], new AbortController().signal);
    await Promise.resolve();
    expect(client.getHeadingXrefs).not.toHaveBeenCalled();

    releaseFirst(['50-78-2']);
    await pending;
    expect(client.getHeadingXrefs).toHaveBeenCalledTimes(1);
  });
});

describe('lookupXrefs — per-type failure isolation', () => {
  it('keeps the types on both sides of a failed one and reports the failure', async () => {
    const client = fakeClient();
    const failure = timeout(
      'PubChem did not respond in time; the request timed out. Retry shortly.',
    );
    client.getXrefs.mockResolvedValueOnce(['50-78-2']).mockResolvedValueOnce([38840409]);
    client.getHeadingXrefs.mockRejectedValueOnce(failure);

    const result = await lookupXrefs(
      client,
      2244,
      ['RN', 'CAS', 'PubMedID'],
      new AbortController().signal,
    );

    expect(result.groups).toEqual([
      { type: 'RN', ids: ['50-78-2'] },
      { type: 'PubMedID', ids: [38840409] },
    ]);
    expect(result.failed).toEqual([{ type: 'CAS', error: failure }]);
  });

  it('reports every failed type when only one answers', async () => {
    const client = fakeClient();
    const casFailure = serviceUnavailable('PubChem returned 503.');
    const rnFailure = serviceUnavailable('PubChem returned 502.');
    client.getHeadingXrefs
      .mockRejectedValueOnce(casFailure)
      .mockResolvedValueOnce([{ id: '200-064-1', sourceCount: 1 }]);
    client.getXrefs.mockRejectedValueOnce(rnFailure);

    const result = await lookupXrefs(
      client,
      2244,
      ['CAS', 'RN', 'EC'],
      new AbortController().signal,
    );

    expect(result.groups).toEqual([{ type: 'EC', ids: ['200-064-1'], sourceCounts: [1] }]);
    expect(result.failed).toEqual([
      { type: 'CAS', error: casFailure },
      { type: 'RN', error: rnFailure },
    ]);
  });

  it('throws the first failure when every type fails', async () => {
    const client = fakeClient();
    const first = serviceUnavailable('PubChem returned 503.');
    client.getXrefs.mockRejectedValueOnce(first);
    client.getHeadingXrefs.mockRejectedValueOnce(timeout('timed out'));

    await expect(
      lookupXrefs(client, 2244, ['RN', 'CAS'], new AbortController().signal),
    ).rejects.toBe(first);
  });

  it('rethrows a cancellation at once, without requesting the remaining types', async () => {
    const client = fakeClient();
    const controller = new AbortController();
    const cancelled = requestCancelled('PubChem request cancelled by the caller.');
    client.getXrefs.mockResolvedValueOnce(['50-78-2']);
    client.getHeadingXrefs.mockImplementationOnce(async () => {
      controller.abort();
      throw cancelled;
    });

    await expect(
      lookupXrefs(client, 2244, ['RN', 'CAS', 'PubMedID'], controller.signal),
    ).rejects.toBe(cancelled);
    expect(client.getXrefs).toHaveBeenCalledTimes(1);
  });
});

/** Requests sent, across both client methods. */
const requestCount = (client: ReturnType<typeof fakeClient>) =>
  client.getXrefs.mock.calls.length + client.getHeadingXrefs.mock.calls.length;

describe('lookupXrefs — PubChem throttling stops the sequence', () => {
  it.each([
    [503, serviceUnavailable('PubChem returned HTTP 503 after 2 attempts.', { status: 503 })],
    [429, rateLimited('PubChem returned HTTP 429.', { status: 429 })],
  ])(
    'a %i on the first type sends no further request and fails the call with it',
    async (_status, throttled) => {
      const client = fakeClient();
      client.getXrefs.mockRejectedValueOnce(throttled).mockResolvedValue(['unreached']);
      client.getHeadingXrefs.mockResolvedValue([{ id: 'unreached', sourceCount: 1 }]);

      await expect(
        lookupXrefs(client, 2244, ['RN', 'CAS', 'PubMedID', 'EC'], new AbortController().signal),
      ).rejects.toBe(throttled);
      expect(requestCount(client)).toBe(1);
    },
  );

  it('keeps the types that answered before the throttle and fails the rest with its error', async () => {
    const client = fakeClient();
    const throttled = serviceUnavailable('PubChem returned HTTP 503 after 2 attempts.', {
      status: 503,
    });
    client.getXrefs.mockResolvedValueOnce(['50-78-2']).mockResolvedValue(['unreached']);
    client.getHeadingXrefs.mockRejectedValueOnce(throttled);

    const result = await lookupXrefs(
      client,
      2244,
      ['RN', 'CAS', 'PubMedID', 'EC'],
      new AbortController().signal,
    );

    expect(result.groups).toEqual([{ type: 'RN', ids: ['50-78-2'] }]);
    expect(result.failed).toEqual([
      { type: 'CAS', error: throttled },
      { type: 'PubMedID', error: throttled },
      { type: 'EC', error: throttled },
    ]);
    expect(requestCount(client)).toBe(2);
  });

  it.each([
    ['a 500', serviceUnavailable('PubChem returned HTTP 500 after 2 attempts.', { status: 500 })],
    ['a 400', invalidRequest('PubChem returned HTTP 400: PUGVIEW.BadRequest', { status: 400 })],
    [
      'a timeout',
      timeout('PubChem did not respond in time; the request timed out. Retry shortly.'),
    ],
    [
      'a network error',
      serviceUnavailable('PubChem could not be reached (network error). Retry shortly.'),
    ],
  ])('%s fails only its own type and the sequence continues', async (_label, failure) => {
    const client = fakeClient();
    client.getHeadingXrefs.mockRejectedValueOnce(failure);
    client.getXrefs.mockResolvedValueOnce(['50-78-2']).mockResolvedValueOnce([38840409]);

    const result = await lookupXrefs(
      client,
      2244,
      ['CAS', 'RN', 'PubMedID'],
      new AbortController().signal,
    );

    expect(result.failed).toEqual([{ type: 'CAS', error: failure }]);
    expect(result.groups.map((g) => g.type)).toEqual(['RN', 'PubMedID']);
    expect(requestCount(client)).toBe(3);
  });
});

describe('lookupXrefs — an empty ProteinGI is not an answer (#72)', () => {
  it('throws the first failure when only an empty ProteinGI answered', async () => {
    const client = fakeClient();
    const rnFailure = serviceUnavailable('PubChem returned HTTP 500 after 2 attempts.', {
      status: 500,
    });
    client.getXrefs.mockResolvedValueOnce([]).mockRejectedValueOnce(rnFailure);

    await expect(
      lookupXrefs(client, 2244, ['ProteinGI', 'RN'], new AbortController().signal),
    ).rejects.toBe(rnFailure);
  });

  it('returns an empty ProteinGI beside another type that answered, even an empty one', async () => {
    const client = fakeClient();
    const failure = timeout('timed out');
    client.getXrefs.mockResolvedValueOnce([]).mockRejectedValueOnce(failure);
    client.getHeadingXrefs.mockResolvedValueOnce([]);

    const result = await lookupXrefs(
      client,
      170000000,
      ['ProteinGI', 'RN', 'CAS'],
      new AbortController().signal,
    );

    expect(result.groups).toEqual([
      { type: 'ProteinGI', ids: [] },
      { type: 'CAS', ids: [], sourceCounts: [] },
    ]);
    expect(result.failed).toEqual([{ type: 'RN', error: failure }]);
  });

  it('returns a ProteinGI group that carries IDs beside a failure', async () => {
    const client = fakeClient();
    const failure = timeout('timed out');
    client.getXrefs.mockResolvedValueOnce([1234]).mockRejectedValueOnce(failure);

    const result = await lookupXrefs(
      client,
      2244,
      ['ProteinGI', 'RN'],
      new AbortController().signal,
    );

    expect(result.groups).toEqual([{ type: 'ProteinGI', ids: [1234] }]);
    expect(result.failed).toEqual([{ type: 'RN', error: failure }]);
  });

  it('returns an empty ProteinGI on its own when nothing failed', async () => {
    const client = fakeClient();
    client.getXrefs.mockResolvedValueOnce([]);

    const result = await lookupXrefs(client, 2244, ['ProteinGI'], new AbortController().signal);

    expect(result).toEqual({ groups: [{ type: 'ProteinGI', ids: [] }], failed: [] });
  });
});
