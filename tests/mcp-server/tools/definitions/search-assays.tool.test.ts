/**
 * @fileoverview Tests for search-assays tool.
 * @module mcp-server/tools/definitions/search-assays.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAssays } from '@/mcp-server/tools/definitions/search-assays.tool.js';

const mockClient = {
  searchAssaysByTarget: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('searchAssays handler', () => {
  it('searches assays by gene symbol', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([1000, 2000, 3000]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.targetType).toBe('genesymbol');
    expect(enrichment.targetQuery).toBe('EGFR');
    expect(enrichment.totalFound).toBe(3);
    expect(result.aids).toEqual([1000, 2000, 3000]);
    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('genesymbol', 'EGFR');
  });

  it('caps results at maxResults', async () => {
    const manyAids = Array.from({ length: 200 }, (_, i) => i + 1);
    mockClient.searchAssaysByTarget.mockResolvedValueOnce(manyAids);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'geneid',
      targetQuery: '1956',
      maxResults: 10,
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.totalFound).toBe(200);
    expect(result.aids).toHaveLength(10);
  });

  it('handles no results and populates notice enrichment', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'proteinaccession',
      targetQuery: 'XXXXXX',
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.totalFound).toBe(0);
    expect(result.aids).toEqual([]);
    expect(enrichment.notice).toBeDefined();
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('XXXXXX');
  });

  it('does not populate notice when assays found', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([500, 600]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'TP53',
    });
    await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeUndefined();
  });
});

describe('searchAssays format', () => {
  it('formats found assays', () => {
    const blocks = searchAssays.format!({
      aids: [1000, 2000, 3000],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('1000, 2000, 3000');
  });

  it('formats empty results', () => {
    const blocks = searchAssays.format!({
      aids: [],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('No assays found');
  });
});
