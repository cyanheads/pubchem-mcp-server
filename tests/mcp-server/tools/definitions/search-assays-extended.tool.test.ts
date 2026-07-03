/**
 * @fileoverview Extended tests for search-assays tool — all target types, validation, and security.
 * @module mcp-server/tools/definitions/search-assays-extended.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

describe('searchAssays handler — all target types', () => {
  it('searches by proteinname', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([100, 200]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'proteinname',
      targetQuery: 'Epidermal growth factor receptor',
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith(
      'proteinname',
      'Epidermal growth factor receptor',
    );
    expect(result.aids).toEqual([100, 200]);
    expect(enrichment.targetType).toBe('proteinname');
    expect(enrichment.targetQuery).toBe('Epidermal growth factor receptor');
  });

  it('searches by proteinaccession', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([300, 400, 500]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'proteinaccession',
      targetQuery: 'P00533',
    });
    const result = await searchAssays.handler(input, ctx);

    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('proteinaccession', 'P00533');
    expect(result.aids).toEqual([300, 400, 500]);
  });

  it('searches by geneid', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([600]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'geneid',
      targetQuery: '5743',
    });
    const result = await searchAssays.handler(input, ctx);

    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('geneid', '5743');
    expect(result.aids).toEqual([600]);
  });
});

describe('searchAssays handler — target query validation (#26)', () => {
  it('throws blank_target_query for an empty targetQuery', async () => {
    const ctx = createMockContext({ errors: searchAssays.errors });
    const input = searchAssays.input.parse({ targetType: 'genesymbol', targetQuery: '' });
    await expect(searchAssays.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'blank_target_query' },
    });
    expect(mockClient.searchAssaysByTarget).not.toHaveBeenCalled();
  });

  it('throws blank_target_query for a whitespace-only targetQuery', async () => {
    const ctx = createMockContext({ errors: searchAssays.errors });
    const input = searchAssays.input.parse({ targetType: 'genesymbol', targetQuery: '   ' });
    await expect(searchAssays.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'blank_target_query' },
    });
    expect(mockClient.searchAssaysByTarget).not.toHaveBeenCalled();
  });

  it('throws invalid_geneid_query for a non-numeric geneid targetQuery', async () => {
    const ctx = createMockContext({ errors: searchAssays.errors });
    const input = searchAssays.input.parse({ targetType: 'geneid', targetQuery: 'not-a-number' });
    await expect(searchAssays.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_geneid_query' },
    });
    // Rejected before the upstream call — no raw PubChem 400.
    expect(mockClient.searchAssaysByTarget).not.toHaveBeenCalled();
  });

  it('accepts a numeric geneid targetQuery', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([600]);
    const ctx = createMockContext({ errors: searchAssays.errors });
    const input = searchAssays.input.parse({ targetType: 'geneid', targetQuery: '1956' });
    const result = await searchAssays.handler(input, ctx);

    expect(result.aids).toEqual([600]);
    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('geneid', '1956');
  });

  it('does not apply the geneid shape check to text target types', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([1]);
    const ctx = createMockContext({ errors: searchAssays.errors });
    const input = searchAssays.input.parse({ targetType: 'genesymbol', targetQuery: 'EGFR' });
    const result = await searchAssays.handler(input, ctx);

    expect(result.aids).toEqual([1]);
  });

  it('trims surrounding whitespace before searching', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([7]);
    const ctx = createMockContext({ errors: searchAssays.errors });
    const input = searchAssays.input.parse({ targetType: 'genesymbol', targetQuery: '  EGFR  ' });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.aids).toEqual([7]);
    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('genesymbol', 'EGFR');
    expect(enrichment.targetQuery).toBe('EGFR');
  });
});

describe('searchAssays handler — input validation', () => {
  it('rejects invalid targetType', () => {
    expect(() =>
      searchAssays.input.parse({
        targetType: 'invalidtype' as unknown as 'genesymbol',
        targetQuery: 'EGFR',
      }),
    ).toThrow();
  });

  it('rejects maxResults below 1', () => {
    expect(() =>
      searchAssays.input.parse({
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        maxResults: 0,
      }),
    ).toThrow();
  });

  it('rejects maxResults above 200', () => {
    expect(() =>
      searchAssays.input.parse({
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        maxResults: 201,
      }),
    ).toThrow();
  });

  it('accepts maxResults at boundary values', () => {
    expect(() =>
      searchAssays.input.parse({
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        maxResults: 1,
      }),
    ).not.toThrow();

    expect(() =>
      searchAssays.input.parse({
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        maxResults: 200,
      }),
    ).not.toThrow();
  });
});

describe('searchAssays handler — enrichment details', () => {
  it('enrichment notice contains targetQuery and targetType when no assays found', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'NONEXISTENT_GENE_XYZ',
    });
    await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('NONEXISTENT_GENE_XYZ');
    expect(enrichment.notice).toContain('genesymbol');
  });

  it('totalFound reflects capped pre-maxResults count', async () => {
    const manyAids = Array.from({ length: 150 }, (_, i) => i + 1);
    mockClient.searchAssaysByTarget.mockResolvedValueOnce(manyAids);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: 'TP53',
      maxResults: 50,
    });
    const result = await searchAssays.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.totalFound).toBe(150);
    expect(result.aids).toHaveLength(50);
  });
});

describe('searchAssays handler — security', () => {
  it('passes injection strings as targetQuery without interpreting them', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const injected = "'; DROP TABLE assays; --";
    const input = searchAssays.input.parse({
      targetType: 'proteinname',
      targetQuery: injected,
    });
    const result = await searchAssays.handler(input, ctx);

    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('proteinname', injected);
    expect(result.aids).toHaveLength(0);
  });

  it('handles unicode in targetQuery without crashing', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchAssays.input.parse({
      targetType: 'proteinname',
      targetQuery: '受体激酶',
    });
    const result = await searchAssays.handler(input, ctx);

    expect(result.aids).toHaveLength(0);
    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith('proteinname', '受体激酶');
  });

  it('handles very long targetQuery without crashing', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const longQuery = 'EGFR'.repeat(1000);
    const input = searchAssays.input.parse({
      targetType: 'genesymbol',
      targetQuery: longQuery,
    });
    const result = await searchAssays.handler(input, ctx);

    expect(result.aids).toHaveLength(0);
  });
});

describe('searchAssays format — additional cases', () => {
  it('formats large number of AIDs', () => {
    const aids = Array.from({ length: 200 }, (_, i) => i + 1);
    const blocks = searchAssays.format!({ aids });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('1');
    expect(text).toContain('200');
  });

  it('format contains all AID values', () => {
    const blocks = searchAssays.format!({ aids: [100, 200, 300] });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('100');
    expect(text).toContain('200');
    expect(text).toContain('300');
  });
});
