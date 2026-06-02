/**
 * @fileoverview Tests for get-bioactivity tool.
 * @module mcp-server/tools/definitions/get-bioactivity.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBioactivity } from '@/mcp-server/tools/definitions/get-bioactivity.tool.js';
import type { BioactivityRow } from '@/services/pubchem/types.js';

const mockClient = {
  getAssaySummary: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const activeRow: BioactivityRow = {
  aid: 1000,
  assayName: 'COX-2 inhibition',
  outcome: 'Active',
  targetAccession: 'P35354',
  targetGeneId: 5743,
  activityValues: [{ name: 'IC50', value: 0.35, unit: 'uM' }],
};

const inactiveRow: BioactivityRow = {
  aid: 2000,
  assayName: 'hERG binding',
  outcome: 'Inactive',
  activityValues: [],
};

const inconclusiveRow: BioactivityRow = {
  aid: 3000,
  assayName: 'Cytotoxicity',
  outcome: 'Inconclusive',
  activityValues: [],
};

describe('getBioactivity handler', () => {
  it('returns all assay results by default', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inactiveRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244 });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.cid).toBe(2244);
    expect(result.totalAssays).toBe(3);
    expect(result.activeCount).toBe(1);
    expect(result.inactiveCount).toBe(1);
    expect(result.results).toHaveLength(3);
  });

  it('filters to active only', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inactiveRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'active' });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.outcome).toBe('Active');
    expect(result.totalAssays).toBe(3);
  });

  it('filters to inactive only', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inactiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'inactive' });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.outcome).toBe('Inactive');
  });

  it('caps results at maxResults', async () => {
    const manyRows = Array.from({ length: 50 }, (_, i) => ({
      ...activeRow,
      aid: i + 1,
    }));
    mockClient.getAssaySummary.mockResolvedValueOnce(manyRows);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, maxResults: 5 });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.totalAssays).toBe(50);
    expect(result.results).toHaveLength(5);
  });

  it('handles compound with no assay data', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 999 });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.totalAssays).toBe(0);
    expect(result.activeCount).toBe(0);
    expect(result.inactiveCount).toBe(0);
    expect(result.results).toEqual([]);
  });
});

describe('getBioactivity handler — enrichment', () => {
  it('echoes outcomeFilter and the filtered/returned cap boundary', async () => {
    const manyRows = Array.from({ length: 30 }, (_, i) => ({ ...activeRow, aid: i + 1 }));
    mockClient.getAssaySummary.mockResolvedValueOnce(manyRows);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({
      cid: 2244,
      outcomeFilter: 'active',
      maxResults: 10,
    });
    await getBioactivity.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.outcomeFilter).toBe('active');
    expect(enrichment.filteredCount).toBe(30);
    expect(enrichment.returnedCount).toBe(10);
    expect(enrichment.notice).toBeUndefined();
  });

  it('adds a notice when the compound has no bioactivity data', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 999 });
    await getBioactivity.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.filteredCount).toBe(0);
    expect(enrichment.returnedCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No bioactivity data');
  });

  it('adds a notice when the filter excludes every assay', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([inactiveRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'active' });
    await getBioactivity.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.filteredCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('outcomeFilter="active"');
  });
});

describe('getBioactivity format', () => {
  it('formats bioactivity results', () => {
    const blocks = getBioactivity.format!({
      cid: 2244,
      totalAssays: 3,
      activeCount: 1,
      inactiveCount: 1,
      results: [activeRow],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('CID 2244');
    expect(text).toContain('Total assays: 3');
    expect(text).toContain('Active: 1');
    expect(text).toContain('AID 1000');
    expect(text).toContain('COX-2 inhibition');
    expect(text).toContain('GeneID:5743');
    expect(text).toContain('IC50: 0.35 uM');
  });

  it('formats empty results', () => {
    const blocks = getBioactivity.format!({
      cid: 999,
      totalAssays: 0,
      activeCount: 0,
      inactiveCount: 0,
      results: [],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('No matching assay results');
  });

  it('omits the value line entirely when activityValues is empty (#6 regression)', () => {
    // After the #6 fix, parseAssayTable filters phantom 0s so most categorical assays land here
    // with no activityValues. Format must NOT print "Value: 0 uM" for those.
    const noValueRow: BioactivityRow = {
      aid: 1195,
      assayName: 'DSSTox FDAMDD',
      outcome: 'Active',
      activityValues: [],
    };
    const blocks = getBioactivity.format!({
      cid: 2244,
      totalAssays: 1,
      activeCount: 1,
      inactiveCount: 0,
      results: [noValueRow],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('AID 1195');
    expect(text).not.toContain('Value: 0');
    expect(text).not.toContain('0 uM');
  });
});
