/**
 * @fileoverview Caller cancellation across the resource surface (#54): each resource handler
 * hands `ctx.signal` to the real PubChemClient, so a cancelled read makes no further request
 * and surfaces `RequestCancelled`. `fetch` is stubbed with an implementation that honors
 * `init.signal`.
 * @module tests/mcp-server/resources/definitions/resource-cancellation.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assayResource } from '@/mcp-server/resources/definitions/assay.resource.js';
import { compoundResource } from '@/mcp-server/resources/definitions/compound.resource.js';
import { compoundBioactivityResource } from '@/mcp-server/resources/definitions/compound-bioactivity.resource.js';
import { compoundImageResource } from '@/mcp-server/resources/definitions/compound-image.resource.js';
import { compoundSafetyResource } from '@/mcp-server/resources/definitions/compound-safety.resource.js';
import { compoundXrefsResource } from '@/mcp-server/resources/definitions/compound-xrefs.resource.js';
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

const cancelled = { code: JsonRpcErrorCode.RequestCancelled };

type Ctx = ReturnType<typeof createMockContext>;

describe('resource handlers hand ctx.signal to PubChem (#54)', () => {
  const reads = [
    ['pubchem://compound/{cid}', (ctx: Ctx) => compoundResource.handler({ cid: 2244 }, ctx)],
    [
      'pubchem://compound/{cid}/safety',
      (ctx: Ctx) => compoundSafetyResource.handler({ cid: 2244 }, ctx),
    ],
    [
      'pubchem://compound/{cid}/image',
      (ctx: Ctx) => compoundImageResource.handler({ cid: 2244 }, ctx),
    ],
    [
      'pubchem://compound/{cid}/xrefs',
      (ctx: Ctx) => compoundXrefsResource.handler({ cid: 2244 }, ctx),
    ],
    [
      'pubchem://compound/{cid}/bioactivity',
      (ctx: Ctx) => compoundBioactivityResource.handler({ cid: 2244 }, ctx),
    ],
    ['pubchem://assay/{aid}', (ctx: Ctx) => assayResource.handler({ aid: 1 }, ctx)],
  ] as const;

  it.each(reads)('%s makes no request once the read is cancelled', async (_uri, read) => {
    const controller = new AbortController();
    controller.abort();

    await expect(read(createMockContext({ signal: controller.signal }))).rejects.toMatchObject(
      cancelled,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the xrefs read between its per-type requests', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return Response.json({ InformationList: { Information: [{ CID: 2244, RN: ['50-78-2'] }] } });
    });

    await expect(
      compoundXrefsResource.handler(
        { cid: 2244 },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject(cancelled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
