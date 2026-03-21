/**
 * @fileoverview Tests for search-assays tool.
 * @module mcp-server/tools/definitions/search-assays.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

    expect(result.targetType).toBe('genesymbol');
    expect(result.targetQuery).toBe('EGFR');
    expect(result.totalFound).toBe(3);
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

    expect(result.totalFound).toBe(200);
    expect(result.aids).toHaveLength(10);
  });

  it('handles no results', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'proteinaccession',
      targetQuery: 'XXXXXX',
    });
    const result = await searchAssays.handler(input, ctx);

    expect(result.totalFound).toBe(0);
    expect(result.aids).toEqual([]);
  });
});

describe('searchAssays format', () => {
  it('formats found assays', () => {
    const blocks = searchAssays.format!({
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
      totalFound: 3,
      aids: [1000, 2000, 3000],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('3 assays');
    expect(text).toContain('EGFR');
    expect(text).toContain('1000, 2000, 3000');
  });

  it('formats single assay without plural', () => {
    const blocks = searchAssays.format!({
      targetType: 'geneid',
      targetQuery: '1956',
      totalFound: 1,
      aids: [5000],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('1 assay ');
    expect(text).not.toContain('1 assays');
  });

  it('formats empty results', () => {
    const blocks = searchAssays.format!({
      targetType: 'genesymbol',
      targetQuery: 'NONEXISTENT',
      totalFound: 0,
      aids: [],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('No assays found');
  });

  it('shows truncation notice', () => {
    const blocks = searchAssays.format!({
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
      totalFound: 500,
      aids: [1, 2, 3],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('showing 3 of 500');
  });
});
