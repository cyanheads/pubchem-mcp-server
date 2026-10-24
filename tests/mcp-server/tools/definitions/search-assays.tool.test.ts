/**
 * @fileoverview Tests for search-assays tool.
 * @module mcp-server/tools/definitions/search-assays.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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
    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith(
      'genesymbol',
      'EGFR',
      expect.any(AbortSignal),
    );
  });

  it.each([
    ['p00533', 'P00533'],
    ['a0a0g2jz79', 'A0A0G2JZ79'],
    ['aad14062', 'AAD14062'],
    ['np_000953.2', 'NP_000953.2'],
    ['b45705', 'B45705'],
    ['1zhh_A', '1ZHH_A'],
    ['P00533', 'P00533'],
  ])(
    'uppercases proteinaccession %s to %s before lookup and in the echo (#67)',
    async (raw, normalized) => {
      mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);
      const ctx = createMockContext({ errors: searchAssays.errors });
      await searchAssays.handler(
        searchAssays.input.parse({ targetType: 'proteinaccession', targetQuery: raw }),
        ctx,
      );
      const enrichment = getEnrichment(ctx);

      expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith(
        'proteinaccession',
        normalized,
        expect.any(AbortSignal),
      );
      expect(enrichment.targetQuery).toBe(normalized);
      expect(enrichment.notice).toContain(`"${normalized}"`);
    },
  );

  it.each([
    ['genesymbol', 'egfr'],
    ['proteinname', 'epidermal growth factor receptor'],
    ['geneid', '1956'],
  ] as const)('passes a %s query through with its case intact (#67)', async (targetType, query) => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([1]);
    const ctx = createMockContext({ errors: searchAssays.errors });
    await searchAssays.handler(searchAssays.input.parse({ targetType, targetQuery: query }), ctx);

    expect(mockClient.searchAssaysByTarget).toHaveBeenCalledWith(
      targetType,
      query,
      expect.any(AbortSignal),
    );
  });

  it('caps results at maxResults', async () => {
    const manyAids = Array.from({ length: 200 }, (_, i) => i + 1);
    mockClient.searchAssaysByTarget.mockResolvedValueOnce(manyAids);
    const ctx = createMockContext({ errors: searchAssays.errors });
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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
      const ctx = createMockContext({ errors: searchAssays.errors });
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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
    const ctx = createMockContext({ errors: searchAssays.errors });
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

describe('searchAssays caller-text framing (#74)', () => {
  type Result = Awaited<ReturnType<typeof runToolContract>>;
  const textOf = (result: Result) =>
    result.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  const structuredOf = (result: Result) =>
    result.structuredContent as { targetQuery?: string; notice?: string };

  const HOSTILE = 'zzqq `code` ~~x~~ **b**\n# INJECTED';
  const HOSTILE_FRAMED = 'zzqq \\`code\\` \\~\\~x\\~\\~ \\*\\*b\\*\\* # INJECTED';
  const LONG = 'x'.repeat(500);
  const NO_ASSAYS_ADVICE =
    'Try a different targetType (e.g. switch from proteinname to genesymbol), verify the identifier spelling, or use pubchem_get_summary for gene/protein entity lookups.';

  it('frames the no-assays notice and the targetQuery line, keeping the structured echo as sent', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);

    const result = await runToolContract(searchAssays, {
      targetType: 'proteinname',
      targetQuery: HOSTILE,
    });

    expect(structuredOf(result).targetQuery).toBe(HOSTILE);
    const notice = `No assays found for "${HOSTILE_FRAMED}" (proteinname). ${NO_ASSAYS_ADVICE}`;
    expect(structuredOf(result).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain(`**targetQuery:** ${HOSTILE_FRAMED}\n`);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toMatch(/^# INJECTED/m);
  });

  it('cuts a long targetQuery to 100 characters in the notice and echoes it whole on the targetQuery line', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);

    const result = await runToolContract(searchAssays, {
      targetType: 'genesymbol',
      targetQuery: LONG,
    });

    expect(structuredOf(result).targetQuery).toBe(LONG);
    expect(structuredOf(result).notice).toBe(
      `No assays found for "${'x'.repeat(100)}…" (genesymbol). ${NO_ASSAYS_ADVICE}`,
    );
    expect(textOf(result)).toContain(`**targetQuery:** ${LONG}\n`);
  });

  it('frames and cuts the past-the-end notice', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([1, 2, 3]);

    const hostile = await runToolContract(searchAssays, {
      targetType: 'proteinname',
      targetQuery: HOSTILE,
      offset: 10,
    });
    expect(structuredOf(hostile).notice).toBe(
      `offset 10 is past the 3 AID(s) found for "${HOSTILE_FRAMED}". Pass an offset below 3.`,
    );

    mockClient.searchAssaysByTarget.mockResolvedValueOnce([1, 2, 3]);
    const long = await runToolContract(searchAssays, {
      targetType: 'proteinname',
      targetQuery: LONG,
      offset: 10,
    });
    expect(structuredOf(long).notice).toBe(
      `offset 10 is past the 3 AID(s) found for "${'x'.repeat(100)}…". Pass an offset below 3.`,
    );
  });

  it('frames and cuts the invalid_geneid_query message', async () => {
    const hostile = await runToolContract(searchAssays, {
      targetType: 'geneid',
      targetQuery: HOSTILE,
    });
    const hostileError = (hostile.structuredContent as { error: { message: string } }).error;
    expect(hostileError.message).toBe(
      `targetType is "geneid" but targetQuery "${HOSTILE_FRAMED}" is not a positive integer Gene ID.`,
    );
    expect(textOf(hostile)).not.toMatch(/^# INJECTED/m);

    const long = await runToolContract(searchAssays, { targetType: 'geneid', targetQuery: LONG });
    expect((long.structuredContent as { error: { message: string } }).error.message).toBe(
      `targetType is "geneid" but targetQuery "${'x'.repeat(100)}…" is not a positive integer Gene ID.`,
    );
    expect(mockClient.searchAssaysByTarget).not.toHaveBeenCalled();
  });

  it('renders an ordinary target exactly as before', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValueOnce([]);

    const result = await runToolContract(searchAssays, {
      targetType: 'genesymbol',
      targetQuery: 'EGFR',
    });

    expect(textOf(result)).toContain('**targetQuery:** EGFR\n');
    expect(structuredOf(result).notice).toBe(
      `No assays found for "EGFR" (genesymbol). ${NO_ASSAYS_ADVICE}`,
    );
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
