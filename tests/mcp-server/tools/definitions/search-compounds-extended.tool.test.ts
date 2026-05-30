/**
 * @fileoverview Extended tests for search-compounds tool — edge cases, validation, and security.
 * @module mcp-server/tools/definitions/search-compounds-extended.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCompounds } from '@/mcp-server/tools/definitions/search-compounds.tool.js';

const mockClient = {
  searchByName: vi.fn(),
  searchBySmiles: vi.fn(),
  searchByInchiKey: vi.fn(),
  searchByFormula: vi.fn(),
  searchByStructure: vi.fn(),
  getProperties: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('searchCompounds handler — superstructure search', () => {
  it('searches by superstructure', async () => {
    mockClient.searchByStructure.mockResolvedValueOnce([500, 600]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'superstructure',
      query: 'c1ccccc1',
      queryType: 'smiles',
    });
    const result = await searchCompounds.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(mockClient.searchByStructure).toHaveBeenCalledWith(
      'superstructure',
      'c1ccccc1',
      'smiles',
      90,
    );
    expect(enrichment.totalFound).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it('searches by superstructure with cid queryType', async () => {
    mockClient.searchByStructure.mockResolvedValueOnce([1, 2, 3]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'superstructure',
      query: '2244',
      queryType: 'cid',
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(mockClient.searchByStructure).toHaveBeenCalledWith('superstructure', '2244', 'cid', 90);
    expect(result.results).toHaveLength(3);
  });
});

describe('searchCompounds handler — identifier batch edge cases', () => {
  it('handles identifier that resolves to no CIDs', async () => {
    mockClient.searchByName.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['nonexistentcompound12345'],
    });
    const result = await searchCompounds.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.results).toHaveLength(0);
    expect(enrichment.totalFound).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('deduplicates across multiple identifiers resolving to overlapping CIDs', async () => {
    mockClient.searchByName.mockResolvedValueOnce([2244, 3672]).mockResolvedValueOnce([3672, 4999]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin', 'ibuprofen'],
    });
    const result = await searchCompounds.handler(input, ctx);

    // 2244 + 3672 + 4999 after dedup = 3
    expect(result.results).toHaveLength(3);
  });

  it('accepts maximum 25 identifiers', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `compound${i}`);
    expect(() =>
      searchCompounds.input.parse({
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: ids,
      }),
    ).not.toThrow();
  });

  it('rejects more than 25 identifiers', () => {
    const ids = Array.from({ length: 26 }, (_, i) => `compound${i}`);
    expect(() =>
      searchCompounds.input.parse({
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: ids,
      }),
    ).toThrow();
  });
});

describe('searchCompounds handler — boundary values', () => {
  it('accepts minimum maxResults of 1', async () => {
    mockClient.searchByFormula.mockResolvedValueOnce([1, 2, 3]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: 'C6H12O6',
      maxResults: 1,
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.results).toHaveLength(1);
  });

  it('accepts maximum maxResults of 200', async () => {
    const manyIds = Array.from({ length: 200 }, (_, i) => i + 1);
    mockClient.searchByFormula.mockResolvedValueOnce(manyIds);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: 'C6H12O6',
      maxResults: 200,
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.results).toHaveLength(200);
  });

  it('rejects maxResults below 1', () => {
    expect(() =>
      searchCompounds.input.parse({
        searchType: 'formula',
        formula: 'C6H12O6',
        maxResults: 0,
      }),
    ).toThrow();
  });

  it('similarity threshold minimum of 70 accepted', () => {
    expect(() =>
      searchCompounds.input.parse({
        searchType: 'similarity',
        query: '2244',
        queryType: 'cid',
        threshold: 70,
      }),
    ).not.toThrow();
  });

  it('similarity threshold below 70 rejected', () => {
    expect(() =>
      searchCompounds.input.parse({
        searchType: 'similarity',
        query: '2244',
        queryType: 'cid',
        threshold: 69,
      }),
    ).toThrow();
  });
});

describe('searchCompounds handler — security', () => {
  it('passes injection strings as identifiers without interpreting them', async () => {
    // SQL/script injection in identifier — must be passed through opaquely, not interpreted
    mockClient.searchByName.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const injected = "'; DROP TABLE compounds; --";
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: [injected],
    });
    const result = await searchCompounds.handler(input, ctx);

    // Handler must call the client with the raw identifier unchanged
    expect(mockClient.searchByName).toHaveBeenCalledWith(injected);
    // No results, but no crash
    expect(result.results).toHaveLength(0);
  });

  it('passes path traversal strings in formula without crashing', async () => {
    mockClient.searchByFormula.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: '../../etc/passwd',
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(mockClient.searchByFormula).toHaveBeenCalledWith('../../etc/passwd', false);
  });

  it('passes oversized formula string to client without crash', async () => {
    // 10KB formula string — handler must not crash on oversized input
    const bigFormula = 'C'.repeat(10000);
    mockClient.searchByFormula.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: bigFormula,
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.results).toHaveLength(0);
  });

  it('handles unicode identifiers without crashing', async () => {
    mockClient.searchByName.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['阿司匹林'],
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(mockClient.searchByName).toHaveBeenCalledWith('阿司匹林');
  });

  it('error message does not expose internal server paths', async () => {
    const ctx = createMockContext({ errors: searchCompounds.errors });
    const input = searchCompounds.input.parse({ searchType: 'formula' });
    await expect(searchCompounds.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_formula' },
    });
  });
});

describe('searchCompounds handler — properties hydration edge cases', () => {
  it('skips properties fetch when result set is empty', async () => {
    mockClient.searchByFormula.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: 'XXXXXX',
      properties: ['MolecularFormula'],
    });
    await searchCompounds.handler(input, ctx);

    expect(mockClient.getProperties).not.toHaveBeenCalled();
  });

  it('hydrates when properties requested and results present', async () => {
    mockClient.searchByName.mockResolvedValueOnce([2244]);
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4', MolecularWeight: 180.16 },
    ]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin'],
      properties: ['MolecularFormula', 'MolecularWeight'],
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(mockClient.getProperties).toHaveBeenCalledWith(
      [2244],
      ['MolecularFormula', 'MolecularWeight'],
    );
    expect(result.results[0]!.properties).toEqual({
      MolecularFormula: 'C9H8O4',
      MolecularWeight: 180.16,
    });
    // CID must not appear in properties
    expect(result.results[0]!.properties).not.toHaveProperty('CID');
  });
});

describe('searchCompounds format — additional cases', () => {
  it('formats single CID without identifier', () => {
    const blocks = searchCompounds.format!({
      results: [{ cid: 5988 }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('5988');
    expect(text).not.toContain('undefined');
  });

  it('formats multiple properties per CID', () => {
    const blocks = searchCompounds.format!({
      results: [
        {
          cid: 2244,
          identifier: 'aspirin',
          properties: { MolecularFormula: 'C9H8O4', MolecularWeight: 180.16 },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('MolecularFormula: C9H8O4');
    expect(text).toContain('MolecularWeight: 180.16');
    expect(text).toContain('CID 2244');
    expect(text).toContain('aspirin');
  });
});
