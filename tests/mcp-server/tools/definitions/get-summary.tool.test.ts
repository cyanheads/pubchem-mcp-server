/**
 * @fileoverview Tests for get-summary tool.
 * @module mcp-server/tools/definitions/get-summary.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSummary } from '@/mcp-server/tools/definitions/get-summary.tool.js';
import { readBlockquotes, readCommonMark } from '../../../helpers/commonmark.js';
import { expectReadBack, formatBlock, READ_BACK_FUZZ } from '../../../helpers/read-back.js';

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
    expect(text).toContain('**Identifier found:** `P00533`');
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
    expect(text).toContain('Targets: `YP_815859` — `mevalonate kinase`');
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
    expect(targetsLine).toContain(`\`${upstream[24]!.Accession}\` — `);
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

describe('getSummary assay comment and depositor source ID (#100)', () => {
  /** Live /assay/aid/{aid}/summary/JSON records, verbatim: AID 1751838 (ChEMBL — active
   * threshold, citation, target notes), 410 (no Comment), 1259407 (Comment `[""]`), 1 (a
   * free-text SourceID), and 2284432 (the longest Comment across 71 sampled AIDs). */
  const LIVE = (
    JSON.parse(
      readFileSync(
        new URL('../../../fixtures/assay-summaries-comment.json', import.meta.url),
        'utf8',
      ),
    ) as { AssaySummaries: { AssaySummary: Array<Record<string, unknown> & { AID: number }> } }
  ).AssaySummaries.AssaySummary;
  const record = (aid: number) => LIVE.find((r) => r.AID === aid)!;

  type AssayData = { description?: string; comment?: string; sourceId?: string };
  const dataOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { summaries: Array<{ data?: AssayData }> }).summaries[0]!.data!;
  /** The mock answers with a copy, so a handler that edits the record in place cannot move an
   * expectation read from the fixture along with its result. */
  const summarize = (raw: Record<string, unknown>) => {
    mockClient.getEntitySummary.mockResolvedValueOnce(structuredClone(raw));
    return runToolContract(getSummary, { entityType: 'assay', identifiers: [String(raw.AID)] });
  };

  it('AID 1751838 → sourceId CHEMBL4810382 and the comment, threshold line first, on both surfaces', async () => {
    const raw = record(1751838);
    const result = await summarize(raw);
    const data = dataOf(result);
    const text = formatBlock(result);

    expect(result.isError).toBeFalsy();
    expect(data.sourceId).toBe('CHEMBL4810382');
    expect(data.comment?.split('\n')[0]).toBe(
      'Compounds with activity <= 10uM or explicitly reported as active by ChEMBL are flagged as active in this PubChem assay presentation.',
    );
    // Every Comment line, the blank paragraph separators included, joined as description is.
    expect(data.comment).toBe((raw.Comment as string[]).join('\n'));
    expect(data.comment).toContain('\n\nJournal: J Med Chem\n');
    // The target notes close the comment, after the citation block.
    const lines = data.comment!.split('\n');
    expect(lines).toHaveLength(15);
    expect(lines.slice(9)).toEqual([
      '',
      'Target ChEMBL ID: CHEMBL230',
      'ChEMBL Target Name: Cyclooxygenase-2',
      'ChEMBL Target Type: SINGLE PROTEIN - Target is a single protein chain',
      'Relationship Type: D - Direct protein target assigned',
      'Confidence: Direct single protein target assigned',
    ]);
    expect(readBlockquotes(text)).toEqual([data.description, data.comment]);
    expect(readCommonMark(text)).toContain('Source Id: ⟨code_inline:CHEMBL4810382⟩');
  });

  it('AID 1 → a free-text sourceId reads back as one code span', async () => {
    const result = await summarize(record(1));
    const data = dataOf(result);

    expect(data.sourceId).toBe(
      'NCI human tumor cell line growth inhibition assay. Data for the NCI-H23 Non-Small Cell Lung cell line',
    );
    expect(readCommonMark(formatBlock(result))).toContain(
      `Source Id: ⟨code_inline:${data.sourceId}⟩`,
    );
  });

  it.each([
    [410, 'absent', 'p450-cyp1a2'],
    [1259407, '[""]', 'CCRIS-mstu'],
  ])(
    'AID %d (Comment %s) → no comment on either surface, sourceId kept',
    async (aid, _shape, sourceId) => {
      const result = await summarize(record(aid));
      const data = dataOf(result);

      expect(data).not.toHaveProperty('comment');
      expect(data.sourceId).toBe(sourceId);
      expect(formatBlock(result)).not.toContain('Comment:');
    },
  );

  it.each([
    ['two empty lines', ['', '']],
    ['whitespace-only lines', [' ', '\t']],
  ])('a Comment of %s reads as blank: no comment on either surface', async (_shape, lines) => {
    const result = await summarize({ AID: 1, Name: 'n', Comment: lines, SourceID: 's' });
    const data = dataOf(result);

    expect(data).not.toHaveProperty('comment');
    expect(data.sourceId).toBe('s');
    expect(formatBlock(result)).not.toContain('Comment:');
  });

  it('AID 2284432 → the longest sampled comment whole, its quote closed before the next field', async () => {
    const raw = record(2284432);
    const result = await summarize(raw);
    const data = dataOf(result);
    const text = formatBlock(result);

    expect(data.comment).toBe((raw.Comment as string[]).join('\n'));
    expect(readBlockquotes(text)).toEqual([data.description, data.comment]);
    expect(readCommonMark(text)).toContain('⟨blockquote_close⟩\n\nSource Name: 30476');
  });

  it('frames a comment and a sourceId holding markdown as data, keeping structuredContent raw', async () => {
    const comment = 'Active below 10 uM.\n\n# INJECTED **x**';
    const result = await summarize({
      AID: 1,
      Name: 'n',
      Comment: comment.split('\n'),
      SourceID: 'a`b',
    });
    const data = dataOf(result);
    const read = readCommonMark(formatBlock(result));

    expect(data).toMatchObject({ comment, sourceId: 'a`b' });
    expect(readBlockquotes(formatBlock(result))).toEqual([comment]);
    expect(read).toContain('Source Id: ⟨code_inline:a`b⟩');
    expect(read).not.toMatch(/⟨heading_open⟩\n\n[^⟨]*INJECTED/);
  });

  it.each([
    ['gene', '1956', { GeneID: 1956, Symbol: 'EGFR' }],
    ['protein', 'P00533', { ProteinAccession: 'P00533', Name: 'EGFR' }],
    ['taxonomy', '9606', { TaxonomyID: 9606, ScientificName: 'Homo sapiens' }],
  ] as const)(
    'a %s summary maps no comment or sourceId from Comment/SourceID keys',
    async (entityType, id, raw) => {
      mockClient.getEntitySummary.mockResolvedValueOnce({ ...raw, Comment: ['c'], SourceID: 's' });
      const result = await runToolContract(getSummary, { entityType, identifiers: [id] });
      const data = dataOf(result);

      expect(data).not.toHaveProperty('comment');
      expect(data).not.toHaveProperty('sourceId');
    },
  );
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

  it('marks an invalid identifier row, keeping a newline in it inside a code block (#66, #88)', () => {
    const result = getSummary.output.parse({
      entityType: 'assay',
      summaries: [
        { identifier: 1000, found: true, data: { aid: 1000, name: 'Found assay' } },
        { identifier: 'AID\n# 1000', found: false, invalid: true },
      ],
    });
    const text = (getSummary.format!(result)[0] as { type: 'text'; text: string }).text;

    const read = readCommonMark(text);
    expect(read).toContain(
      '⟨strong⟩Identifier invalid for this entityType, not looked up:⟨/strong⟩\n\n⟨fence:AID\n# 1000⟩',
    );
    expect(read.match(/⟨heading_open⟩/g)).toHaveLength(1);
  });

  it('lists unprocessed identifiers past the per-call cap (#66)', () => {
    const result = getSummary.output.parse({
      entityType: 'assay',
      summaries: [{ identifier: 1000, found: false }],
      unprocessed: ['2010', '2011'],
    });
    const text = (getSummary.format!(result)[0] as { type: 'text'; text: string }).text;

    expect(result.unprocessed).toEqual(['2010', '2011']);
    expect(text).toContain('**Unprocessed (2, past the per-call cap):** `2010`, `2011`');
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

describe('getSummary content[] reads caller and upstream values back (#88)', () => {
  type Content = {
    summaries: Array<{ identifier: string | number; data?: Record<string, unknown> }>;
    unprocessed?: string[];
  };

  it.each(READ_BACK_FUZZ)(
    'reads an invalid and an unprocessed identifier holding %s back as the piece sent',
    async (_l, value) => {
      mockClient.getEntitySummary.mockResolvedValue(null);
      const valid = Array.from({ length: 8 }, (_, i) => String(1001 + i));
      await expectReadBack(
        async (v) => {
          const result = await runToolContract(getSummary, {
            entityType: 'assay',
            identifiers: ['1000', v, ...valid, v],
          });
          const content = result.structuredContent as Content;
          expect(content.summaries[1]!.identifier).toBe(v.trim());
          expect(content.unprocessed).toEqual([v.trim()]);
          return formatBlock(result);
        },
        value,
        { expected: value.trim() },
      );
    },
  );

  it.each(READ_BACK_FUZZ)(
    'reads a not-found protein identifier holding %s back as looked up',
    async (_l, value) => {
      mockClient.getEntitySummary.mockResolvedValue(null);
      await expectReadBack(
        async (v) => {
          const result = await runToolContract(getSummary, {
            entityType: 'protein',
            identifiers: [v],
          });
          expect((result.structuredContent as Content).summaries[0]!.identifier).toBe(
            v.trim().toUpperCase(),
          );
          return formatBlock(result);
        },
        value,
        { expected: value.trim().toUpperCase() },
      );
    },
  );

  /** Per entityType: an identifier, the upstream record with `v` in every string field, and the
   * summary data structuredContent carries for it. Copy-back fields read back as code literals,
   * labels as escaped text (`isCopyBack` in the tool). */
  const FOUND: [
    'assay' | 'gene' | 'protein' | 'taxonomy',
    string,
    (v: string) => Record<string, unknown>,
    (v: string) => Record<string, unknown>,
  ][] = [
    [
      'assay',
      '1000',
      (v) => ({
        AID: 1000,
        Name: v,
        SourceName: v,
        Method: v,
        Target: [{ Accession: v, Name: v }],
      }),
      (v) => ({
        aid: 1000,
        name: v,
        sourceName: v,
        method: v,
        targets: [{ accession: v, name: v }],
        targetCount: 1,
      }),
    ],
    [
      'gene',
      '1956',
      (v) => ({ GeneID: 1956, Symbol: v, Name: v, Taxonomy: v, Synonym: [v] }),
      (v) => ({ geneId: 1956, symbol: v, name: v, taxonomy: v, synonyms: [v] }),
    ],
    [
      'protein',
      'P00533',
      (v) => ({ ProteinAccession: v, Name: v, Taxonomy: v, Synonym: [v] }),
      (v) => ({ proteinAccession: v, name: v, taxonomy: v, synonyms: [v] }),
    ],
    [
      'taxonomy',
      '9606',
      (v) => ({
        TaxonomyID: 9606,
        ScientificName: v,
        CommonName: v,
        Rank: v,
        RankedLineage: { Superkingdom: v, Species: v },
        Synonym: [v],
      }),
      (v) => ({
        taxonomyId: 9606,
        scientificName: v,
        commonName: v,
        rank: v,
        lineage: [v, v],
        synonyms: [v],
      }),
    ],
  ];

  describe.each(FOUND)('a found %s summary', (entityType, identifier, record, data) => {
    it.each(READ_BACK_FUZZ)(
      'reads every string field holding %s back as PubChem sent it',
      async (_l, value) => {
        await expectReadBack(
          async (v) => {
            mockClient.getEntitySummary.mockResolvedValueOnce(record(v));
            const result = await runToolContract(getSummary, {
              entityType,
              identifiers: [identifier],
            });
            expect((result.structuredContent as Content).summaries[0]!.data).toEqual(data(v));
            return formatBlock(result);
          },
          value,
          { allowEscapedText: true },
        );
      },
    );
  });

  it('reads gene and protein names, symbols, and accessions as code literals, assay and taxonomy names as text', async () => {
    mockClient.getEntitySummary
      .mockResolvedValueOnce({ GeneID: 1956, Symbol: 'EGFR', Name: 'egfr gene', Taxonomy: 'Hs' })
      .mockResolvedValueOnce({ AID: 1000, Name: 'An assay', SourceName: 'NCGC' })
      .mockResolvedValueOnce({ ProteinAccession: 'P00533', Name: 'EGFR protein', Taxonomy: 'Hs' });
    const gene = formatBlock(
      await runToolContract(getSummary, { entityType: 'gene', identifiers: ['1956'] }),
    );
    const assay = formatBlock(
      await runToolContract(getSummary, { entityType: 'assay', identifiers: ['1000'] }),
    );
    const protein = formatBlock(
      await runToolContract(getSummary, { entityType: 'protein', identifiers: ['P00533'] }),
    );

    expect(gene).toContain(
      '**Identifier found:** 1956\n  Name: `egfr gene`\n  Gene Id: 1956\n  Symbol: `EGFR`\n  Taxonomy: Hs\n',
    );
    expect(protein).toContain(
      '**Identifier found:** `P00533`\n  Name: `EGFR protein`\n  Taxonomy: Hs\n  Protein Accession: `P00533`\n',
    );
    expect(assay).toContain(
      '**Identifier found:** 1000\n  Aid: 1000\n  Name: An assay\n  Source Name: NCGC\n',
    );
  });

  it('closes the description quote before the next field, so the field is not read into it', async () => {
    const description = 'Measures X.\n\n# INJECTED';
    mockClient.getEntitySummary.mockResolvedValueOnce({
      AID: 1000,
      Name: 'n',
      Description: description,
      SourceName: 'NCGC',
    });

    const text = formatBlock(
      await runToolContract(getSummary, { entityType: 'assay', identifiers: ['1000'] }),
    );

    expect(readBlockquotes(text)).toEqual([description]);
    expect(readCommonMark(text)).toContain('⟨blockquote_close⟩\n\nSource Name: NCGC');
  });
});
