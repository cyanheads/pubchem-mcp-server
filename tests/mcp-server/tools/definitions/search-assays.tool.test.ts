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

describe('searchAssays handler — offset pagination (#38)', () => {
  const aidPage = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('returns the slice starting at offset', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce(aidPage(30));
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
      offset: 10,
      maxResults: 5,
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.aids).toEqual([11, 12, 13, 14, 15]);
    expect(enrichment.offset).toBe(10);
    expect(enrichment.totalFound).toBe(30);
    expect(enrichment.nextOffset).toBe(15);
    expect(enrichment.notice).toContain('offset=15');
  });

  it('walks the whole result set without repeating or skipping an AID', async () => {
    const seen: number[] = [];
    for (let offset = 0; offset < 30; offset += 12) {
      mockClient.searchAssaysByTarget.mockResolvedValueOnce(aidPage(30));
      const ctx = createMockContext();
      const input = searchAssays.input.parse({
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        offset,
        maxResults: 12,
      });
      const result = await searchAssays.handler(input, ctx);
      seen.push(...result.aids);
    }

    expect(seen).toEqual(aidPage(30));
  });

  it('marks the last page as complete rather than truncated', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce(aidPage(30));
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
      offset: 25,
      maxResults: 10,
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.aids).toEqual([26, 27, 28, 29, 30]);
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('explains an offset that runs past the result set', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce(aidPage(3));
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
      offset: 50,
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.aids).toEqual([]);
    expect(enrichment.totalFound).toBe(3);
    expect(enrichment.notice).toContain('offset 50 is past the 3 AID(s)');
    expect(enrichment.truncated).toBeUndefined();
  });

  it('keeps the no-match notice distinct from the past-the-end notice', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'NOTATARGET',
      offset: 50,
    });
    await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toContain('No assays found');
    expect(enrichment.notice).not.toContain('is past');
  });

  it('defaults offset to 0 and rejects a negative offset', () => {
    const parsed = searchAssays.input.parse({ targetType: 'genesymbol', targetQuery: 'EGFR' });
    expect(parsed.offset).toBe(0);
    expect(() =>
      searchAssays.input.parse({ targetType: 'genesymbol', targetQuery: 'EGFR', offset: -1 }),
    ).toThrow();
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
    expect(text).toContain('No assays returned');
  });
});
