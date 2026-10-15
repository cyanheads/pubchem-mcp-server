/**
 * @fileoverview Extended tests for get-compound-xrefs tool — edge cases and security.
 * @module mcp-server/tools/definitions/get-compound-xrefs-extended.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundXrefs } from '@/mcp-server/tools/definitions/get-compound-xrefs.tool.js';

const mockClient = {
  getXrefs: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getCompoundXrefs handler — input validation', () => {
  it('rejects CID of 0', () => {
    expect(() => getCompoundXrefs.input.parse({ cid: 0, xrefTypes: ['PubMedID'] })).toThrow();
  });

  it('rejects negative CID', () => {
    expect(() => getCompoundXrefs.input.parse({ cid: -1, xrefTypes: ['GeneID'] })).toThrow();
  });

  it('rejects empty xrefTypes array', () => {
    expect(() => getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: [] })).toThrow();
  });

  it('rejects invalid xrefType values', () => {
    expect(() => getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['InvalidType'] })).toThrow();
  });

  it('rejects maxPerType below 1', () => {
    expect(() =>
      getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['GeneID'], maxPerType: 0 }),
    ).toThrow();
  });

  it('accepts maxPerType past the cap of 500 up to 1000, and rejects 1001 (#70)', () => {
    const parse = (maxPerType: number) => () =>
      getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['GeneID'], maxPerType });
    expect(parse(501)).not.toThrow();
    expect(parse(1000)).not.toThrow();
    expect(parse(1001)).toThrow();
  });

  it('accepts all valid xref types', () => {
    const validTypes = [
      'RegistryID',
      'RN',
      'PubMedID',
      'PatentID',
      'GeneID',
      'ProteinGI',
      'TaxonomyID',
    ];
    for (const xrefType of validTypes) {
      expect(() =>
        getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: [xrefType] }),
      ).not.toThrow();
    }
  });
});

describe('getCompoundXrefs handler — sequential fetching', () => {
  it('fetches each xref type sequentially', async () => {
    mockClient.getXrefs
      .mockResolvedValueOnce([11111, 22222])
      .mockResolvedValueOnce(['US-1234567', 'EP-9876543']);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID', 'PatentID'],
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(mockClient.getXrefs).toHaveBeenCalledTimes(2);
    expect(mockClient.getXrefs).toHaveBeenNthCalledWith(
      1,
      2244,
      'PubMedID',
      expect.any(AbortSignal),
    );
    expect(mockClient.getXrefs).toHaveBeenNthCalledWith(
      2,
      2244,
      'PatentID',
      expect.any(AbortSignal),
    );
    expect(result.xrefs[0]!.type).toBe('PubMedID');
    expect(result.xrefs[1]!.type).toBe('PatentID');
  });

  it('handles multiple xref types with mixed results', async () => {
    mockClient.getXrefs
      .mockResolvedValueOnce([]) // GeneID: none
      .mockResolvedValueOnce(['50-78-2']); // RN: one result
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['GeneID', 'RN'],
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs[0]!.ids).toHaveLength(0);
    expect(result.xrefs[0]!.truncated).toBe(false);
    expect(result.xrefs[1]!.ids).toEqual(['50-78-2']);
  });
});

describe('getCompoundXrefs handler — empty-result notice (#30)', () => {
  it('emits a notice when every requested type returns zero IDs', async () => {
    mockClient.getXrefs.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 999999999,
      xrefTypes: ['RN', 'PubMedID'],
    });
    const result = await getCompoundXrefs.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.xrefs.every((x) => x.totalAvailable === 0)).toBe(true);
    expect(enrichment.notice).toBeDefined();
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('999999999');
    expect(enrichment.notice).toContain('pubchem_search_compounds');
  });

  it('does not emit a notice when at least one type has results', async () => {
    mockClient.getXrefs.mockResolvedValueOnce([]).mockResolvedValueOnce([12345]);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['GeneID', 'PubMedID'],
    });
    await getCompoundXrefs.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeUndefined();
  });
});

describe('getCompoundXrefs handler — truncation boundary', () => {
  it('marks truncated=false when exactly at maxPerType', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    mockClient.getXrefs.mockResolvedValueOnce(ids);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID'],
      maxPerType: 50,
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs[0]!.truncated).toBe(false);
    expect(result.xrefs[0]!.ids).toHaveLength(50);
    expect(result.xrefs[0]!.totalAvailable).toBe(50);
  });

  it('marks truncated=true when one over maxPerType', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    mockClient.getXrefs.mockResolvedValueOnce(ids);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID'],
      maxPerType: 50,
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs[0]!.truncated).toBe(true);
    expect(result.xrefs[0]!.ids).toHaveLength(50);
    expect(result.xrefs[0]!.totalAvailable).toBe(51);
  });
});

describe('getCompoundXrefs handler — offset pagination (#38)', () => {
  const idPage = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('returns the slice starting at offset and reports the page boundary', async () => {
    mockClient.getXrefs.mockResolvedValueOnce(idPage(30));
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID'],
      offset: 10,
      maxPerType: 5,
    });
    const result = await getCompoundXrefs.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.xrefs[0]!.ids).toEqual([11, 12, 13, 14, 15]);
    expect(result.xrefs[0]!.totalAvailable).toBe(30);
    expect(result.xrefs[0]!.truncated).toBe(true);
    expect(enrichment.offset).toBe(10);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.nextOffset).toBe(15);
    expect(enrichment.notice).toContain('offset=15');
  });

  it('applies the same offset to every requested type', async () => {
    mockClient.getXrefs.mockResolvedValueOnce(idPage(10)).mockResolvedValueOnce(['a', 'b', 'c']);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID', 'RN'],
      offset: 2,
      maxPerType: 3,
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs[0]!.ids).toEqual([3, 4, 5]);
    expect(result.xrefs[1]!.ids).toEqual(['c']);
    expect(result.xrefs[1]!.truncated).toBe(false);
  });

  it('walks a type end to end without repeating or skipping an ID', async () => {
    const seen: (string | number)[] = [];
    for (let offset = 0; offset < 30; offset += 12) {
      mockClient.getXrefs.mockResolvedValueOnce(idPage(30));
      const ctx = createMockContext();
      const input = getCompoundXrefs.input.parse({
        cid: 2244,
        xrefTypes: ['PubMedID'],
        offset,
        maxPerType: 12,
      });
      const result = await getCompoundXrefs.handler(input, ctx);
      seen.push(...result.xrefs[0]!.ids);
    }

    expect(seen).toEqual(idPage(30));
  });

  it('marks the last page as complete rather than truncated', async () => {
    mockClient.getXrefs.mockResolvedValueOnce(idPage(30));
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID'],
      offset: 25,
      maxPerType: 10,
    });
    const result = await getCompoundXrefs.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.xrefs[0]!.ids).toEqual([26, 27, 28, 29, 30]);
    expect(result.xrefs[0]!.truncated).toBe(false);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('explains an offset that runs past every requested type', async () => {
    mockClient.getXrefs.mockResolvedValueOnce(idPage(3)).mockResolvedValueOnce(idPage(7));
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID', 'GeneID'],
      offset: 50,
    });
    const result = await getCompoundXrefs.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.xrefs.every((x) => x.ids.length === 0)).toBe(true);
    expect(enrichment.notice).toContain('offset 50 is past every requested type');
    expect(enrichment.notice).toContain('7 ID(s)');
  });

  it('keeps the nonexistent-CID notice distinct from the past-the-end notice', async () => {
    mockClient.getXrefs.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 999999999,
      xrefTypes: ['PubMedID'],
      offset: 50,
    });
    await getCompoundXrefs.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toContain('No cross-references found');
    expect(enrichment.notice).not.toContain('is past');
  });

  it('defaults offset to 0 and rejects a negative offset', () => {
    const parsed = getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['PubMedID'] });
    expect(parsed.offset).toBe(0);
    expect(() =>
      getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['PubMedID'], offset: -1 }),
    ).toThrow();
  });

  it('rejects a fractional maxPerType', () => {
    expect(() =>
      getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['RN'], maxPerType: 2.5 }),
    ).toThrow();
  });

  it('emits a nextOffset the offset input accepts, even for a fractional maxPerType', async () => {
    /* The schema now rejects a fractional cap, so this drives the handler directly: the guard
     * under test is that the stride comes from the returned page, not from the cap. A stride of
     * maxPerType would hand back a fractional nextOffset that this tool's own int-validated
     * offset then rejects — a dead end, reachable again if the derivation regresses. */
    mockClient.getXrefs.mockResolvedValueOnce(idPage(11));
    const ctx = createMockContext();
    const input = {
      ...getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['RN'], offset: 0 }),
      maxPerType: 2.5,
    };
    await getCompoundXrefs.handler(input, ctx);
    const nextOffset = getEnrichment(ctx).nextOffset as number;

    expect(nextOffset).toBe(2);
    expect(getEnrichment(ctx).notice).toContain('offset=2');
    expect(() =>
      getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['RN'], offset: nextOffset }),
    ).not.toThrow();
  });
});

describe('getCompoundXrefs handler — ID order through the real client (#69)', () => {
  /**
   * Aspirin (CID 2244) xref responses captured from PUG REST in PubChem's wire order — lexical
   * for the numeric types. PubMedID is sampled (every 100th ID plus the highest and lowest).
   */
  const aspirinXrefs = JSON.parse(
    readFileSync(new URL('../../../fixtures/pug-rest-xrefs-2244.json', import.meta.url), 'utf8'),
  ) as Record<string, { InformationList: { Information: Array<Record<string, unknown>> } }>;
  const wireIds = (type: string) =>
    aspirinXrefs[type]!.InformationList.Information[0]![type] as (string | number)[];
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const type = url.pathname.match(
        /^\/rest\/pug\/compound\/cid\/2244\/xrefs\/(\w+)\/JSON$/,
      )?.[1];
      if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov' || !type || !aspirinXrefs[type]) {
        throw new Error(`unrouted fetch: ${url}`);
      }
      return Response.json(aspirinXrefs[type]);
    });
    vi.stubGlobal('fetch', fetchMock);
    // The handler's client is the module mock; route its getXrefs to a real client so the
    // ordering under test runs on the wire response.
    const { PubChemClient } = await vi.importActual<
      typeof import('@/services/pubchem/pubchem-client.js')
    >('@/services/pubchem/pubchem-client.js');
    const real = new PubChemClient();
    mockClient.getXrefs.mockImplementation((cid: number, type: string, signal?: AbortSignal) =>
      real.getXrefs(cid, type, signal),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function page(type: string, offset: number, maxPerType: number) {
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: [type],
      offset,
      maxPerType,
    });
    const result = await getCompoundXrefs.handler(input, ctx);
    return { xref: result.xrefs[0]!, enrichment: getEnrichment(ctx) };
  }

  it('opens the first PubMedID page with the highest PMID', async () => {
    const { xref } = await page('PubMedID', 0, 50);

    expect(xref.ids[0]).toBe(38840409);
  });

  it('walks PubMedID pages strictly descending across boundaries, each ID exactly once', async () => {
    const total = wireIds('PubMedID').length;
    const seen: number[] = [];
    let offset = 0;
    for (;;) {
      const { xref, enrichment } = await page('PubMedID', offset, 50);
      expect(xref.totalAvailable).toBe(total);
      expect(xref.truncated).toBe(offset + 50 < total);
      seen.push(...(xref.ids as number[]));
      if (enrichment.nextOffset === undefined) break;
      expect(enrichment.nextOffset).toBe(offset + 50);
      offset = enrichment.nextOffset as number;
    }

    expect(seen).toHaveLength(total);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]!);
    expect(new Set(seen)).toEqual(new Set(wireIds('PubMedID')));
  });

  it.each(['GeneID', 'TaxonomyID'])('returns %s pages numerically ascending', async (type) => {
    const first = await page(type, 0, 5);
    const second = await page(type, 5, 5);
    const ids = [...first.xref.ids, ...second.xref.ids] as number[];

    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
  });

  it('opens the TaxonomyID page with 6239', async () => {
    const { xref } = await page('TaxonomyID', 0, 50);

    expect(xref.ids[0]).toBe(6239);
  });

  it.each(['PatentID', 'RN', 'RegistryID'])('keeps PubChem’s order for %s', async (type) => {
    const { xref } = await page(type, 0, 500);

    expect(xref.ids).toEqual(wireIds(type));
  });
});

describe('getCompoundXrefs format — structuredContent parity', () => {
  it('renders every returned ID, past the old 20-item display cap (#37)', () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids, totalAvailable: 25, truncated: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    for (const id of ids) expect(text).toMatch(new RegExp(`\\b${id}\\b`));
    expect(text).not.toContain('more)');
    expect(text).toContain('25 total');
  });

  it('renders all IDs the handler kept while disclosing the maxPerType cap', () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids, totalAvailable: 3000, truncated: true }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    for (const id of ids) expect(text).toMatch(new RegExp(`\\b${id}\\b`));
    // The only disclosed omission is the handler's cap — the IDs it returned are all present.
    expect(text).toContain('50 of 3000 total — truncated');
  });

  it('discloses a mid-list page that reaches the end of a type', () => {
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids: [91, 92], totalAvailable: 92, truncated: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    // Two of 92 shown, nothing after them — a window, but not truncated.
    expect(text).toContain('2 of 92 total');
    expect(text).not.toContain('truncated');
  });

  it('distinguishes an empty page from a type with no IDs at all', () => {
    const empty = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids: [], totalAvailable: 92, truncated: false }],
    });
    expect((empty[0]! as { type: 'text'; text: string }).text).toContain('None on this page');

    const none = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids: [], totalAvailable: 0, truncated: false }],
    });
    expect((none[0]! as { type: 'text'; text: string }).text).toContain('None found');
  });
});
