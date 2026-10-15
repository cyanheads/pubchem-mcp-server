/**
 * @fileoverview Tests for get-summary tool.
 * @module mcp-server/tools/definitions/get-summary.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({
      entityType: 'assay',
      identifiers: ['1000'],
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
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: ['4242'] });
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
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({
      entityType: 'gene',
      identifiers: ['1956'],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries[0]!.found).toBe(true);
    expect(result.summaries[0]!.data?.symbol).toBe('EGFR');
    expect(result.summaries[0]!.data?.geneId).toBe(1956);
  });

  it('handles not-found entities', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce(null);
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({
      entityType: 'protein',
      identifiers: ['NONEXISTENT'],
    });
    const result = await getSummary.handler(input, ctx);

    expect(result.summaries[0]!.found).toBe(false);
    expect(result.summaries[0]!.data).toBeUndefined();
  });

  it('uppercases a lowercase protein accession before lookup and in the echo (#67)', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      ProteinAccession: 'P00533',
      Name: 'Epidermal growth factor receptor',
    });
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({ entityType: 'protein', identifiers: ['p00533'] });
    const result = await getSummary.handler(input, ctx);
    const text = (getSummary.format!(result)[0] as { text: string }).text;

    expect(mockClient.getEntitySummary).toHaveBeenCalledWith(
      'protein',
      'P00533',
      expect.any(AbortSignal),
    );
    expect(result.summaries[0]!.identifier).toBe('P00533');
    expect(result.summaries[0]!.found).toBe(true);
    expect(text).toContain('identifier: P00533');
  });

  it('keeps a PDB chain ID as given and leaves numeric identifiers alone (#67)', async () => {
    mockClient.getEntitySummary.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getSummary.errors });
    await getSummary.handler(
      getSummary.input.parse({ entityType: 'protein', identifiers: ['4ug0_La', '578162'] }),
      ctx,
    );

    expect(mockClient.getEntitySummary).toHaveBeenCalledWith(
      'protein',
      '4UG0_La',
      expect.any(AbortSignal),
    );
    expect(mockClient.getEntitySummary).toHaveBeenCalledWith(
      'protein',
      '578162',
      expect.any(AbortSignal),
    );
  });

  it('handles mixed found/not-found', async () => {
    mockClient.getEntitySummary
      .mockResolvedValueOnce({ AID: 1000, Name: 'Found assay' })
      .mockResolvedValueOnce(null);
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({
      entityType: 'assay',
      identifiers: ['1000', '9999'],
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
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({
      entityType: 'taxonomy',
      identifiers: ['9606'],
    });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    expect(data.scientificName).toBe('Homo sapiens');
    expect(data.commonName).toBe('human');
    expect(data.rank).toBe('species');
  });
});

describe('getSummary assay method, targets, compound counts, and data date (#68)', () => {
  /** Live /assay/aid/{aid}/summary/JSON records for AIDs 1000, 1982, and 3365, key names
   * verbatim, with the long prose fields (Description, Protocol, Comment) dropped. */
  const LIVE = (
    JSON.parse(
      readFileSync(new URL('../../../fixtures/assay-summaries.json', import.meta.url), 'utf8'),
    ) as { AssaySummaries: { AssaySummary: Array<Record<string, unknown> & { AID: number }> } }
  ).AssaySummaries.AssaySummary;
  const record = (aid: number) => LIVE.find((r) => r.AID === aid)!;

  type AssayData = {
    method?: string;
    targets?: Array<{ accession?: string; name?: string }>;
    targetCount?: number;
    numCompounds?: number;
    numActiveCompounds?: number;
    lastDataChange?: string;
    numSubstances?: number;
    numActive?: number;
  };
  const dataOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { summaries: Array<{ data?: AssayData }> }).summaries[0]!.data!;
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

  it('AID 1000 → confirmatory, one target, 57 tested / 36 active compounds, 2008-03-05', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce(record(1000));

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: ['1000'],
    });

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      method: 'confirmatory',
      targets: [{ accession: 'YP_815859', name: 'mevalonate kinase' }],
      targetCount: 1,
      numCompounds: 57,
      numActiveCompounds: 36,
      lastDataChange: '2008-03-05',
      // The substance counts keep their meaning beside the new compound counts.
      numSubstances: 57,
      numActive: 36,
    });
    const text = textOf(result);
    expect(text).toContain('Method: confirmatory');
    expect(text).toContain('Targets: YP_815859 — mevalonate kinase');
    expect(text).toContain('Target Count: 1');
    expect(text).toContain('Num Compounds: 57');
    expect(text).toContain('Num Active Compounds: 36');
    expect(text).toContain('Last Data Change: 2008-03-05');
  });

  it('AID 1982 → the first 25 of 314 targets, in PubChem order, with targetCount 314', async () => {
    const raw = record(1982);
    const upstream = raw.Target as Array<{ Accession: string; Name: string }>;
    expect(upstream).toHaveLength(314);
    mockClient.getEntitySummary.mockResolvedValueOnce(raw);

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: ['1982'],
    });

    const data = dataOf(result);
    expect(data.targetCount).toBe(314);
    expect(data.targets).toEqual(
      upstream.slice(0, 25).map((t) => ({ accession: t.Accession, name: t.Name })),
    );
    const targetsLine = textOf(result)
      .split('\n')
      .find((l) => l.trimStart().startsWith('Targets: '))!;
    expect(targetsLine.split(' | ')).toHaveLength(25);
    expect(targetsLine).toContain(`${upstream[24]!.Accession} — `);
    expect(targetsLine).not.toContain(upstream[25]!.Accession);
    expect(targetsLine).not.toContain('[object Object]');
  });

  it('AID 3365 (no Method upstream) omits method rather than inventing one', async () => {
    const raw = record(3365);
    expect(raw).not.toHaveProperty('Method');
    mockClient.getEntitySummary.mockResolvedValueOnce(raw);

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: ['3365'],
    });

    const data = dataOf(result);
    expect(data).not.toHaveProperty('method');
    expect(data.numActiveCompounds).toBe(0);
    expect(textOf(result)).not.toContain('Method:');
  });

  it('omits targets, compound counts, and the date when upstream carries none', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      AID: 4242,
      Name: 'Sparse assay',
      LastDataChange: { Year: 2020, Month: 1 },
    });
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: ['4242'] });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    for (const key of [
      'method',
      'targets',
      'targetCount',
      'numCompounds',
      'numActiveCompounds',
      'lastDataChange',
    ]) {
      expect(data).not.toHaveProperty(key);
    }
  });

  it('counts an empty Target list as zero targets without emitting an empty targets array', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({
      AID: 4243,
      Name: 'No targets',
      Target: [],
    });
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: ['4243'] });
    const result = await getSummary.handler(input, ctx);

    const data = result.summaries[0]!.data!;
    expect(data.targetCount).toBe(0);
    expect(data).not.toHaveProperty('targets');
  });
});

describe('getSummary handler — enrichment', () => {
  it('echoes requested and found counts with no notice when all resolve', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({ AID: 1000, Name: 'Found assay' });
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: ['1000'] });
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
    const ctx = createMockContext({ errors: getSummary.errors });
    const input = getSummary.input.parse({ entityType: 'assay', identifiers: ['1000', '9999'] });
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

  it('marks an invalid identifier row and keeps a newline in it from starting a block (#66)', () => {
    const result = getSummary.output.parse({
      entityType: 'assay',
      summaries: [
        { identifier: 1000, found: true, data: { aid: 1000, name: 'Found assay' } },
        { identifier: 'AID\n# 1000', found: false, invalid: true },
      ],
    });
    const text = (getSummary.format!(result)[0] as { type: 'text'; text: string }).text;

    expect(text).toContain(
      '**Identifier AID # 1000** — invalid for this entityType, not looked up',
    );
    expect(text.split('\n').some((l) => l.startsWith('# 1000'))).toBe(false);
  });

  it('lists unprocessed identifiers past the per-call cap (#66)', () => {
    const result = getSummary.output.parse({
      entityType: 'assay',
      summaries: [{ identifier: 1000, found: false }],
      unprocessed: ['2010', '2011'],
    });
    const text = (getSummary.format!(result)[0] as { type: 'text'; text: string }).text;

    expect(result.unprocessed).toEqual(['2010', '2011']);
    expect(text).toContain('**Unprocessed (2, past the per-call cap):** 2010, 2011');
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
