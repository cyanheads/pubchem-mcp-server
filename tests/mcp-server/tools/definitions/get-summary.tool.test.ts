/**
 * @fileoverview Tests for get-summary tool.
 * @module mcp-server/tools/definitions/get-summary.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

describe('getSummary handler', () => {
  it('fetches assay summary and maps the SIDCount substance counts (#39)', async () => {
    // Key names mirror the live /assay/aid/{aid}/summary/JSON payload for AID 1000.
    mockClient.getEntitySummary.mockResolvedValueOnce({
      AID: 1000,
      Name: 'Screening for Inhibitors of the Mevalonate Pathway in Streptococcus Pneumoniae',
      SourceName: 'SRMLSC',
      SIDCountAll: 57,
      SIDCountActive: 36,
      SIDCountInactive: 21,
      CIDCountAll: 57,
      CIDCountActive: 36,
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
    const data = result.summaries[0]!.data!;
    expect(data.aid).toBe(1000);
    expect(data.sourceName).toBe('SRMLSC');
    // Substance counts, not the parallel CIDCount* compound counts.
    expect(data.numSubstances).toBe(57);
    expect(data.numActive).toBe(36);
  });

  it('omits assay counts when upstream carries none', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      AID: 4242,
      Name: 'Assay without deposited counts',
    });
    const ctx = createMockContext();
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: [4242] });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    expect(data.numSubstances).toBeUndefined();
    expect(data.numActive).toBeUndefined();
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

describe('getSummary handler — enrichment', () => {
  it('echoes requested and found counts with no notice when all resolve', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({ AID: 1000, Name: 'Found assay' });
    const ctx = createMockContext();
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: [1000] });
    await getSummary.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.requestedCount).toBe(1);
    expect(enrichment.foundCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('adds a notice when at least one identifier is not found', async () => {
    mockClient.getEntitySummary
      .mockResolvedValueOnce({ AID: 1000, Name: 'Found assay' })
      .mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: [1000, 9999] });
    await getSummary.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.requestedCount).toBe(2);
    expect(enrichment.foundCount).toBe(1);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('not found');
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

  it('renders every array element structuredContent carries (#37)', () => {
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
    for (const synonym of synonyms) expect(text).toContain(synonym);
    expect(text).not.toContain('more)');
  });
});
