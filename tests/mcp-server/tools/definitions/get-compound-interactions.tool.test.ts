/**
 * @fileoverview Tests for get-compound-interactions tool.
 * @module mcp-server/tools/definitions/get-compound-interactions.test
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

const ddi: InteractionEntry = {
  kind: 'drug-drug',
  partner: 'Lepirudin',
  source: 'DrugBank',
  text: 'The risk of bleeding can be increased.',
};
const target: InteractionEntry = {
  kind: 'target',
  partner: 'CDK4',
  source: 'BindingDB',
  text: 'CDK4 — IC50 (nM): 120',
};

describe('getCompoundInteractions handler', () => {
  it('returns entries and echoes kinds + count', async () => {
    mockClient.getInteractions.mockResolvedValueOnce([ddi, target]);
    const ctx = createMockContext();
    const input = getCompoundInteractions.input.parse({
      cid: 54678486,
      kinds: ['drug-drug', 'target'],
    });
    const result = await getCompoundInteractions.handler(input, ctx);

    expect(result.entries).toHaveLength(2);
    expect(mockClient.getInteractions).toHaveBeenCalledWith(54678486, ['drug-drug', 'target'], 10);
    const e = getEnrichment(ctx);
    expect(e.requestedKinds).toBe('drug-drug, target');
    expect(e.returnedCount).toBe(2);
    expect(e.notice).toBeUndefined();
  });

  it('defaults kinds to drug-drug and maxEntries to 10', async () => {
    mockClient.getInteractions.mockResolvedValueOnce([ddi]);
    const ctx = createMockContext();
    const input = getCompoundInteractions.input.parse({ cid: 2244 });
    await getCompoundInteractions.handler(input, ctx);

    expect(mockClient.getInteractions).toHaveBeenCalledWith(2244, ['drug-drug'], 10);
  });

  it('notices when no interactions are found', async () => {
    mockClient.getInteractions.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getCompoundInteractions.input.parse({ cid: 962 });
    const result = await getCompoundInteractions.handler(input, ctx);

    expect(result.entries).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('No drug-drug interaction data');
  });

  it('rejects an empty kinds array and out-of-range maxEntries', () => {
    expect(() => getCompoundInteractions.input.parse({ cid: 1, kinds: [] })).toThrow();
    expect(() => getCompoundInteractions.input.parse({ cid: 1, maxEntries: 51 })).toThrow();
  });
});

describe('getCompoundInteractions format', () => {
  it('renders kind, partner, source, and text for each entry', () => {
    const blocks = getCompoundInteractions.format!({ cid: 54678486, entries: [ddi, target] });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('drug-drug');
    expect(text).toContain('Lepirudin');
    expect(text).toContain('DrugBank');
    expect(text).toContain('target');
    expect(text).toContain('CDK4');
    expect(text).toContain('BindingDB');
  });

  it('renders an empty-state line', () => {
    const blocks = getCompoundInteractions.format!({ cid: 1, entries: [] });
    expect((blocks[0]! as { type: 'text'; text: string }).text).toContain('No interaction data');
  });
});
