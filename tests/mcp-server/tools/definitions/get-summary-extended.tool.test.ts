/**
 * @fileoverview Extended tests for get-summary tool — protein/taxonomy types, edge cases, security.
 * @module mcp-server/tools/definitions/get-summary-extended.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSummary } from '@/mcp-server/tools/definitions/get-summary.tool.js';

const mockClient = {
  getEntitySummary: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getSummary handler — protein entity type', () => {
  it('fetches protein summary and maps fields', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      ProteinAccession: 'P00533',
      Name: 'Epidermal growth factor receptor',
      TaxID: 9606,
      ScientificName: 'Homo sapiens',
      Synonym: ['ERBB1', 'HER1'],
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'protein',
      identifiers: ['P00533'],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries[0]!.found).toBe(true);
    const data = result.summaries[0]!.data!;
    expect(data.proteinAccession).toBe('P00533');
    expect(data.name).toBe('Epidermal growth factor receptor');
    expect(data.taxonomyId).toBe(9606);
    expect(data.synonyms).toContain('ERBB1');
  });

  it('handles protein not found', async () => {
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
});

describe('getSummary handler — taxonomy entity type with lineage', () => {
  it('extracts lineage array from taxonomy response', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      TaxonomyID: 9606,
      ScientificName: 'Homo sapiens',
      CommonName: 'human',
      Rank: 'species',
      Lineage: ['Mammalia', 'Primates', 'Hominidae'],
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'taxonomy',
      identifiers: [9606],
    });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    expect(data.lineage).toEqual(['Mammalia', 'Primates', 'Hominidae']);
    expect(data.scientificName).toBe('Homo sapiens');
    expect(data.rank).toBe('species');
    expect(data.commonName).toBe('human');
  });

  it('handles taxonomy without lineage gracefully', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      TaxonomyID: 1,
      ScientificName: 'Bacteria',
      Rank: 'superkingdom',
      // no Lineage field
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'taxonomy',
      identifiers: [1],
    });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    expect(data.lineage).toBeUndefined();
    expect(data.scientificName).toBe('Bacteria');
  });
});

describe('getSummary handler — batch behavior', () => {
  it('fetches all identifiers in parallel', async () => {
    mockClient.getEntitySummary
      .mockResolvedValueOnce({ AID: 100, Name: 'Assay A' })
      .mockResolvedValueOnce({ AID: 200, Name: 'Assay B' })
      .mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'assay',
      identifiers: [100, 200, 999],
    });
    const result = await getSummary.handler(input, ctx);

    expect(mockClient.getEntitySummary).toHaveBeenCalledTimes(3);
    expect(result.summaries).toHaveLength(3);
    expect(result.summaries[0]!.found).toBe(true);
    expect(result.summaries[2]!.found).toBe(false);
  });

  it('reports correct entityType in output', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      GeneID: 1956,
      Symbol: 'EGFR',
      Name: 'EGFR gene',
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({
      entityType: 'gene',
      identifiers: [1956],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.entityType).toBe('gene');
  });
});

describe('getSummary handler — input validation', () => {
  it('rejects empty identifiers array', () => {
    expect(() => getSummary.input.parse({ entityType: 'assay', identifiers: [] })).toThrow();
  });

  it('rejects more than 10 identifiers', () => {
    const ids = Array.from({ length: 11 }, (_, i) => i + 1);
    expect(() => getSummary.input.parse({ entityType: 'assay', identifiers: ids })).toThrow();
  });

  it('accepts exactly 10 identifiers', () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(() => getSummary.input.parse({ entityType: 'assay', identifiers: ids })).not.toThrow();
  });

  it('rejects invalid entityType', () => {
    expect(() => getSummary.input.parse({ entityType: 'compound', identifiers: [1] })).toThrow();
  });

  it('accepts string identifiers for protein', () => {
    expect(() =>
      getSummary.input.parse({ entityType: 'protein', identifiers: ['P00533'] }),
    ).not.toThrow();
  });
});

describe('getSummary format — additional cases', () => {
  it('shows description field when present', () => {
    const blocks = getSummary.format!({
      entityType: 'gene',
      summaries: [
        {
          identifier: 1956,
          found: true,
          data: {
            geneId: 1956,
            symbol: 'EGFR',
            name: 'EGFR',
            description: 'A receptor tyrosine kinase involved in cell growth.',
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('receptor tyrosine kinase');
  });

  it('truncates arrays with more than 10 items to +N more', () => {
    const synonyms = Array.from({ length: 15 }, (_, i) => `Syn-${i}`);
    const blocks = getSummary.format!({
      entityType: 'gene',
      summaries: [
        {
          identifier: 1,
          found: true,
          data: { name: 'TestGene', synonyms },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('+5 more');
    expect(text).toContain('Syn-0');
  });

  it('omits empty arrays from display', () => {
    const blocks = getSummary.format!({
      entityType: 'gene',
      summaries: [
        {
          identifier: 1,
          found: true,
          data: { name: 'TestGene', synonyms: [] },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    // Empty array should not appear as "Synonyms:"
    expect(text).not.toContain('Synonyms: ');
  });

  it('formats taxonomy lineage array', () => {
    const blocks = getSummary.format!({
      entityType: 'taxonomy',
      summaries: [
        {
          identifier: 9606,
          found: true,
          data: {
            scientificName: 'Homo sapiens',
            commonName: 'human',
            rank: 'species',
            lineage: ['Mammalia', 'Primates', 'Hominidae'],
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Homo sapiens');
    expect(text).toContain('Mammalia');
    expect(text).toContain('Primates');
  });

  it('formats assay summary fields', () => {
    const blocks = getSummary.format!({
      entityType: 'assay',
      summaries: [
        {
          identifier: 1000,
          found: true,
          data: {
            aid: 1000,
            name: 'COX-2 inhibitor screen',
            sourceName: 'ChEMBL',
            numSubstances: 500,
            numActive: 42,
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('COX-2 inhibitor screen');
    expect(text).toContain('ChEMBL');
    expect(text).toContain('500');
    expect(text).toContain('42');
  });

  it('shows identifier in not-found block', () => {
    const blocks = getSummary.format!({
      entityType: 'protein',
      summaries: [{ identifier: 'Q9BYF1', found: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Q9BYF1');
    expect(text).toContain('not found');
  });
});

describe('getSummary — security', () => {
  it('injection string as identifier does not cause crash', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const injection = "' OR 1=1; --";
    const input = getSummary.input.parse({
      entityType: 'protein',
      identifiers: [injection],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries[0]!.found).toBe(false);
    // Client called with raw identifier
    expect(mockClient.getEntitySummary).toHaveBeenCalledWith('protein', injection);
  });
});
