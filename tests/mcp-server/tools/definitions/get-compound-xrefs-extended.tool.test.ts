/**
 * @fileoverview Extended tests for get-compound-xrefs tool — edge cases and security.
 * @module mcp-server/tools/definitions/get-compound-xrefs-extended.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('rejects maxPerType above 500', () => {
    expect(() =>
      getCompoundXrefs.input.parse({ cid: 2244, xrefTypes: ['GeneID'], maxPerType: 501 }),
    ).toThrow();
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
    expect(mockClient.getXrefs).toHaveBeenNthCalledWith(1, 2244, 'PubMedID');
    expect(mockClient.getXrefs).toHaveBeenNthCalledWith(2, 2244, 'PatentID');
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

describe('getCompoundXrefs format — display cap', () => {
  it('shows all IDs up to 20 without ellipsis', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids, totalAvailable: 20, truncated: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).not.toContain('+');
    expect(text).toContain('20 total');
  });

  it('shows ellipsis when more than 20 IDs in display', () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids, totalAvailable: 25, truncated: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('+5 more');
  });
});
