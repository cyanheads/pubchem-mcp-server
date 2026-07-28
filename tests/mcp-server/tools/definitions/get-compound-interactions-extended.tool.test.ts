/**
 * @fileoverview Extended tests for get-compound-interactions — per-kind offset continuation,
 * terminal pages, out-of-range offsets, and notice composition (#38).
 * @module mcp-server/tools/definitions/get-compound-interactions-extended.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundInteractions } from '@/mcp-server/tools/definitions/get-compound-interactions.tool.js';
import type { InteractionEntry } from '@/services/pubchem/types.js';

const mockClient = {
  getInteractions: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const ddi = (n: number): InteractionEntry => ({
  kind: 'drug-drug',
  partner: `Partner ${n}`,
  source: 'DrugBank',
  text: `Statement ${n}.`,
});
const targetEntry = (n: number): InteractionEntry => ({
  kind: 'target',
  partner: `Target ${n}`,
  source: 'ChEMBL',
  text: `IC50 = ${n} uM`,
});

describe('getCompoundInteractions — offset input', () => {
  it('defaults to 0 and forwards the requested offset to the client', async () => {
    mockClient.getInteractions.mockResolvedValue({
      entries: [],
      pages: [{ kind: 'drug-drug', returnedCount: 0, totalRecords: 0, recordsConsumed: 0 }],
      failedKinds: [],
    });
    const ctx = createMockContext();

    await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244 }),
      createMockContext(),
    );
    expect(mockClient.getInteractions).toHaveBeenLastCalledWith(2244, ['drug-drug'], 10, 0);

    await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, offset: 40 }),
      ctx,
    );
    expect(mockClient.getInteractions).toHaveBeenLastCalledWith(2244, ['drug-drug'], 10, 40);
    expect(getEnrichment(ctx).offset).toBe(40);
  });

  it('rejects a negative or fractional offset', () => {
    expect(() => getCompoundInteractions.input.parse({ cid: 1, offset: -1 })).toThrow();
    expect(() => getCompoundInteractions.input.parse({ cid: 1, offset: 2.5 })).toThrow();
  });

  it('rejects an offset past PubChem’s 32-bit record cursor', () => {
    expect(() => getCompoundInteractions.input.parse({ cid: 1, offset: 2147483646 })).not.toThrow();
    expect(() => getCompoundInteractions.input.parse({ cid: 1, offset: 2147483647 })).toThrow();
  });
});

describe('getCompoundInteractions — per-kind continuation', () => {
  it('derives nextOffset from the records the page read, never from maxEntries', async () => {
    // 10 records read for 4 entries — a maxEntries-derived stride would skip 6 records.
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [1, 2, 3, 4].map(targetEntry),
      pages: [{ kind: 'target', returnedCount: 4, totalRecords: 7253, recordsConsumed: 10 }],
      failedKinds: [],
    });
    const ctx = createMockContext();
    const result = await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, kinds: ['target'], maxEntries: 4 }),
      ctx,
    );

    expect(result.paging).toEqual([
      {
        kind: 'target',
        returnedCount: 4,
        totalRecords: 7253,
        nextOffset: 10,
        truncated: true,
      },
    ]);
    expect(getEnrichment(ctx).nextOffset).toBe(10);
  });

  it('omits nextOffset on the terminal page', async () => {
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [ddi(1)],
      pages: [{ kind: 'drug-drug', returnedCount: 1, totalRecords: 41, recordsConsumed: 1 }],
      failedKinds: [],
    });
    const ctx = createMockContext();
    const result = await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, offset: 40 }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(result.paging[0]).toEqual({
      kind: 'drug-drug',
      returnedCount: 1,
      totalRecords: 41,
      truncated: false,
    });
    expect(result.paging[0]).not.toHaveProperty('nextOffset');
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('emits a scalar nextOffset for one remaining kind but not for two at different positions', async () => {
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [ddi(1), targetEntry(1)],
      pages: [
        { kind: 'drug-drug', returnedCount: 1, totalRecords: 1777, recordsConsumed: 1 },
        { kind: 'target', returnedCount: 1, totalRecords: 7253, recordsConsumed: 12 },
      ],
      failedKinds: [],
    });
    const ctx = createMockContext();
    const result = await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, kinds: ['drug-drug', 'target'] }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(result.paging.map((p) => p.nextOffset)).toEqual([1, 12]);
    // Two kinds advance to different positions — no single value can stand for both.
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toContain('drug-drug: pass offset=1 of 1777 total');
    expect(enrichment.notice).toContain('target: pass offset=12 of 7253 total');
  });

  it('walks every page of a kind without repeating or skipping an entry', async () => {
    const collected: InteractionEntry[] = [];
    const records = [1, 2, 3, 4, 5].map(ddi);
    let offset = 0;

    for (let page = 0; page < 3; page++) {
      const slice = records.slice(offset, offset + 2);
      mockClient.getInteractions.mockResolvedValueOnce({
        entries: slice,
        pages: [
          {
            kind: 'drug-drug',
            returnedCount: slice.length,
            totalRecords: records.length,
            recordsConsumed: slice.length,
          },
        ],
        failedKinds: [],
      });
      const result = await getCompoundInteractions.handler(
        getCompoundInteractions.input.parse({ cid: 2244, offset, maxEntries: 2 }),
        createMockContext(),
      );
      collected.push(...result.entries);
      const next = result.paging[0]?.nextOffset;
      if (next === undefined) break;
      offset = next;
    }

    expect(collected).toEqual(records);
  });
});

describe('getCompoundInteractions — empty-page notices', () => {
  it('names the valid bound when the offset runs past every requested kind', async () => {
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [],
      pages: [{ kind: 'drug-drug', returnedCount: 0, totalRecords: 1777, recordsConsumed: 0 }],
      failedKinds: [],
    });
    const ctx = createMockContext();
    await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, offset: 5000 }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toBe(
      'offset 5000 is past every requested kind — the largest has 1777 record(s). Pass an offset below 1777.',
    );
  });

  it('separates "records exist but none named an interaction" from "no data at all"', async () => {
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [],
      pages: [{ kind: 'target', returnedCount: 0, totalRecords: 7253, recordsConsumed: 20 }],
      failedKinds: [],
    });
    const ctx = createMockContext();
    await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, kinds: ['target'] }),
      ctx,
    );
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('none read on this page carried a reportable interaction');
    expect(notice).toContain('pass offset=20');
  });
});

describe('getCompoundInteractions — failure isolation', () => {
  it('leaves the surviving kind’s continuation intact and omits the failed kind from paging', async () => {
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [ddi(1)],
      pages: [{ kind: 'drug-drug', returnedCount: 1, totalRecords: 1777, recordsConsumed: 1 }],
      failedKinds: [{ kind: 'target', message: 'PubChem SDQ returned unparseable JSON' }],
    });
    const ctx = createMockContext();
    const result = await getCompoundInteractions.handler(
      getCompoundInteractions.input.parse({ cid: 2244, kinds: ['drug-drug', 'target'] }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(result.paging.map((p) => p.kind)).toEqual(['drug-drug']);
    expect(result.paging[0]!.nextOffset).toBe(1);
    // The failure notice and the continuation guidance compose — notice is last-wins.
    expect(enrichment.failedKinds).toBe('target');
    expect(enrichment.notice).toContain('Could not retrieve target interaction');
    expect(enrichment.notice).toContain('pass offset=1');
  });

  it('does not report "no interaction data" when every kind failed', async () => {
    mockClient.getInteractions.mockResolvedValueOnce({
      entries: [],
      pages: [],
      failedKinds: [{ kind: 'drug-drug', message: 'timeout' }],
    });
    const ctx = createMockContext();
    await getCompoundInteractions.handler(getCompoundInteractions.input.parse({ cid: 2244 }), ctx);
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('Could not retrieve drug-drug interaction');
    expect(notice).not.toContain('No drug-drug interaction data found');
  });
});

describe('getCompoundInteractions format — paging block', () => {
  it('renders each kind’s entry count, record total, truncation, and next offset', () => {
    const blocks = getCompoundInteractions.format!({
      cid: 2244,
      entries: [ddi(1)],
      paging: [
        {
          kind: 'drug-drug',
          returnedCount: 1,
          totalRecords: 1777,
          nextOffset: 1,
          truncated: true,
        },
        { kind: 'drug-food', returnedCount: 0, totalRecords: 0, truncated: false },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('**drug-drug** — 1 entry from 1777 source record(s) — truncated');
    expect(text).toContain('Next offset: 1');
    expect(text).toContain('**drug-food** — 0 entries from 0 source record(s)');
  });

  it('renders the paging block even when the page carried no entries', () => {
    const blocks = getCompoundInteractions.format!({
      cid: 2244,
      entries: [],
      paging: [
        { kind: 'target', returnedCount: 0, totalRecords: 7253, nextOffset: 20, truncated: true },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('7253 source record(s)');
    expect(text).toContain('No interaction entries returned.');
  });
});
