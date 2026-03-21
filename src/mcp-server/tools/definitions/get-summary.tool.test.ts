/**
 * @fileoverview Tests for get-summary tool.
 * @module mcp-server/tools/definitions/get-summary.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSummary } from './get-summary.tool.js';

const mockClient = {
  getEntitySummary: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getSummary handler', () => {
  it('fetches assay summary', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      AID: 1000,
      Name: 'COX-2 inhibitor screen',
      SourceName: 'ChEMBL',
      NumberOfSubstances: 500,
      ActiveSidCount: 42,
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'assay',
      identifiers: [1000],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.entityType).toBe('assay');
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.found).toBe(true);
    expect(result.summaries[0]!.data?.name).toBe('COX-2 inhibitor screen');
    expect(result.summaries[0]!.data?.aid).toBe(1000);
  });

  it('fetches gene summary', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      GeneID: 1956,
      Symbol: 'EGFR',
      Name: 'Epidermal growth factor receptor',
      TaxID: 9606,
      Description: 'A receptor tyrosine kinase.',
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'gene',
      identifiers: [1956],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries[0]!.found).toBe(true);
    expect(result.summaries[0]!.data?.symbol).toBe('EGFR');
    expect(result.summaries[0]!.data?.geneId).toBe(1956);
  });

  it('handles not-found entities', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'protein',
      identifiers: ['NONEXISTENT'],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries[0]!.found).toBe(false);
    expect(result.summaries[0]!.data).toBeUndefined();
  });

  it('handles mixed found/not-found', async () => {
    mockClient.getEntitySummary
      .mockResolvedValueOnce({ AID: 1000, Name: 'Found assay' })
      .mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'assay',
      identifiers: [1000, 9999],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]!.found).toBe(true);
    expect(result.summaries[1]!.found).toBe(false);
  });

  it('extracts taxonomy summary fields', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      TaxonomyID: 9606,
      ScientificName: 'Homo sapiens',
      CommonName: 'human',
      Rank: 'species',
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'taxonomy',
      identifiers: [9606],
    });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    expect(data.scientificName).toBe('Homo sapiens');
    expect(data.commonName).toBe('human');
    expect(data.rank).toBe('species');
  });
});

describe('getSummary format', () => {
  it('formats found summaries', () => {
    const blocks = getSummary.format!({
      entityType: 'gene',
      summaries: [
        {
          identifier: 1956,
          found: true,
          data: {
            geneId: 1956,
            symbol: 'EGFR',
            name: 'Epidermal growth factor receptor',
            taxonomyId: 9606,
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Gene Summaries');
    expect(text).toContain('Epidermal growth factor receptor');
    expect(text).toContain('Taxonomy Id: 9606');
  });

  it('formats not-found entities', () => {
    const blocks = getSummary.format!({
      entityType: 'protein',
      summaries: [{ identifier: 'XXXXXX', found: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('XXXXXX');
    expect(text).toContain('not found');
  });

  it('truncates long arrays in display', () => {
    const synonyms = Array.from({ length: 15 }, (_, i) => `Synonym-${i}`);
    const blocks = getSummary.format!({
      entityType: 'gene',
      summaries: [
        {
          identifier: 1,
          found: true,
          data: { name: 'Test Gene', synonyms },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('+5 more');
  });
});
