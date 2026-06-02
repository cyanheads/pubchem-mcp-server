/**
 * @fileoverview Extended tests for get-bioactivity tool — inconclusive filter, validation, edge cases.
 * @module mcp-server/tools/definitions/get-bioactivity-extended.test
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
  assayName: 'Cytotoxicity screen',
  outcome: 'Inconclusive',
  activityValues: [],
};

describe('getBioactivity handler — outcomeFilter inconclusive', () => {
  it('"all" filter includes all outcome types', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inactiveRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'all' });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results).toHaveLength(3);
    const outcomes = result.results.map((r) => r.outcome);
    expect(outcomes).toContain('Active');
    expect(outcomes).toContain('Inactive');
    expect(outcomes).toContain('Inconclusive');
  });

  it('inconclusive rows are counted in totalAssays but not in activeCount/inactiveCount', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244 });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.totalAssays).toBe(2);
    expect(result.activeCount).toBe(1);
    expect(result.inactiveCount).toBe(0);
  });
});

describe('getBioactivity handler — input validation', () => {
  it('rejects CID of 0', () => {
    expect(() => getBioactivity.input.parse({ cid: 0 })).toThrow();
  });

  it('rejects negative CID', () => {
    expect(() => getBioactivity.input.parse({ cid: -1 })).toThrow();
  });

  it('rejects maxResults below 1', () => {
    expect(() => getBioactivity.input.parse({ cid: 2244, maxResults: 0 })).toThrow();
  });

  it('rejects maxResults above 100', () => {
    expect(() => getBioactivity.input.parse({ cid: 2244, maxResults: 101 })).toThrow();
  });

  it('accepts exactly maxResults=100', () => {
    expect(() => getBioactivity.input.parse({ cid: 2244, maxResults: 100 })).not.toThrow();
  });

  it('rejects invalid outcomeFilter values', () => {
    expect(() =>
      getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'pending' as unknown as 'all' }),
    ).toThrow();
  });
});

describe('getBioactivity handler — counting', () => {
  it('counts only exact "Active"/"Inactive" strings, not variants', async () => {
    const rows: BioactivityRow[] = [
      { aid: 1, assayName: 'A', outcome: 'Active', activityValues: [] },
      { aid: 2, assayName: 'B', outcome: 'Inactive', activityValues: [] },
      { aid: 3, assayName: 'C', outcome: 'Unspecified', activityValues: [] },
      { aid: 4, assayName: 'D', outcome: 'Probe', activityValues: [] },
    ];
    mockClient.getAssaySummary.mockResolvedValueOnce(rows);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 1 });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.activeCount).toBe(1);
    expect(result.inactiveCount).toBe(1);
    expect(result.totalAssays).toBe(4);
  });

  it('active filter does not include inactive rows', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inactiveRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'active' });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results.every((r) => r.outcome === 'Active')).toBe(true);
    // But totalAssays still reflects all assays
    expect(result.totalAssays).toBe(3);
  });

  it('inactive filter does not include active rows', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([activeRow, inactiveRow, inconclusiveRow]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, outcomeFilter: 'inactive' });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results.every((r) => r.outcome === 'Inactive')).toBe(true);
    expect(result.totalAssays).toBe(3);
  });
});

describe('getBioactivity handler — target filter (#9)', () => {
  const cox2: BioactivityRow = {
    aid: 1,
    assayName: 'COX-2',
    outcome: 'Active',
    targetGeneId: 5743,
    targetAccession: 'P35354',
    activityValues: [],
  };
  const cox1: BioactivityRow = {
    aid: 2,
    assayName: 'COX-1',
    outcome: 'Active',
    targetGeneId: 5742,
    targetAccession: 'P23219',
    activityValues: [],
  };
  const noTarget: BioactivityRow = {
    aid: 3,
    assayName: 'Cytotox',
    outcome: 'Active',
    activityValues: [],
  };

  it('filters by targetGeneId; global counts are unaffected', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([cox2, cox1, noTarget]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, targetGeneId: 5743 });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.targetGeneId).toBe(5743);
    expect(result.totalAssays).toBe(3);
  });

  it('filters by targetAccession', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([cox2, cox1, noTarget]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, targetAccession: 'P23219' });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.targetAccession).toBe('P23219');
  });

  it('combines outcome and target filters', async () => {
    const inactiveCox2: BioactivityRow = { ...cox2, aid: 9, outcome: 'Inactive' };
    mockClient.getAssaySummary.mockResolvedValueOnce([cox2, inactiveCox2]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({
      cid: 2244,
      outcomeFilter: 'active',
      targetGeneId: 5743,
    });
    const result = await getBioactivity.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.aid).toBe(1);
  });

  it('echoes the target filter and notices when nothing matches', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([cox1, noTarget]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244, targetGeneId: 99999 });
    const result = await getBioactivity.handler(input, ctx);
    const e = getEnrichment(ctx);

    expect(result.results).toHaveLength(0);
    expect(e.targetFilter).toBe('GeneID:99999');
    expect(e.notice).toContain('target filter');
  });

  it('omits the targetFilter echo when no target filter is set', async () => {
    mockClient.getAssaySummary.mockResolvedValueOnce([cox2]);
    const ctx = createMockContext();
    const input = getBioactivity.input.parse({ cid: 2244 });
    await getBioactivity.handler(input, ctx);

    expect(getEnrichment(ctx).targetFilter).toBeUndefined();
  });
});

describe('getBioactivity format — target and activity edge cases', () => {
  it('renders target accession without Gene ID', () => {
    const row: BioactivityRow = {
      aid: 999,
      assayName: 'Binding assay',
      outcome: 'Active',
      targetAccession: 'P00533',
      activityValues: [],
    };
    const blocks = getBioactivity.format!({
      cid: 1,
      totalAssays: 1,
      activeCount: 1,
      inactiveCount: 0,
      results: [row],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('P00533');
    expect(text).not.toContain('GeneID:');
  });

  it('renders Gene ID without accession', () => {
    const row: BioactivityRow = {
      aid: 999,
      assayName: 'Inhibition screen',
      outcome: 'Active',
      targetGeneId: 5743,
      activityValues: [],
    };
    const blocks = getBioactivity.format!({
      cid: 1,
      totalAssays: 1,
      activeCount: 1,
      inactiveCount: 0,
      results: [row],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('GeneID:5743');
  });

  it('renders multiple activity values for same assay', () => {
    const row: BioactivityRow = {
      aid: 555,
      assayName: 'Multi-value assay',
      outcome: 'Active',
      activityValues: [
        { name: 'IC50', value: 1.5, unit: 'uM' },
        { name: 'EC50', value: 3.2, unit: 'uM' },
        { name: 'Ki', value: 0.8, unit: 'nM' },
      ],
    };
    const blocks = getBioactivity.format!({
      cid: 2244,
      totalAssays: 1,
      activeCount: 1,
      inactiveCount: 0,
      results: [row],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('IC50: 1.5 uM');
    expect(text).toContain('EC50: 3.2 uM');
    expect(text).toContain('Ki: 0.8 nM');
  });

  it('renders activity value without unit when unit is absent', () => {
    const row: BioactivityRow = {
      aid: 777,
      assayName: 'Percent inhibition',
      outcome: 'Active',
      activityValues: [{ name: 'Inhibition', value: 65 }],
    };
    const blocks = getBioactivity.format!({
      cid: 1,
      totalAssays: 1,
      activeCount: 1,
      inactiveCount: 0,
      results: [row],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Inhibition: 65');
    // No trailing space before newline
    expect(text).not.toContain('65 \n');
  });

  it('renders activity value without name using "Value" fallback', () => {
    const row: BioactivityRow = {
      aid: 888,
      assayName: 'Unnamed value assay',
      outcome: 'Active',
      activityValues: [{ value: 42, unit: 'nM' }],
    };
    const blocks = getBioactivity.format!({
      cid: 1,
      totalAssays: 1,
      activeCount: 1,
      inactiveCount: 0,
      results: [row],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Value: 42 nM');
  });
});
