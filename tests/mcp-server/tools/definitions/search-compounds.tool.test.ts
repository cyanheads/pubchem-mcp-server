/**
 * @fileoverview Tests for search-compounds tool.
 * @module mcp-server/tools/definitions/search-compounds.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('searchCompounds handler', () => {
  it('resolves identifiers by name', async () => {
    mockClient.searchByName.mockResolvedValueOnce([2244]).mockResolvedValueOnce([3672]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin', 'ibuprofen'],
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.searchType).toBe('identifier');
    expect(result.totalFound).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!).toEqual({ cid: 2244, identifier: 'aspirin' });
    expect(result.results[1]!).toEqual({ cid: 3672, identifier: 'ibuprofen' });
  });

  it('resolves identifiers by SMILES', async () => {
    mockClient.searchBySmiles.mockResolvedValueOnce([2244]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'smiles',
      identifiers: ['CC(=O)OC1=CC=CC=C1C(=O)O'],
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.totalFound).toBe(1);
    expect(mockClient.searchBySmiles).toHaveBeenCalledWith('CC(=O)OC1=CC=CC=C1C(=O)O');
  });

  it('resolves identifiers by InChIKey', async () => {
    mockClient.searchByInchiKey.mockResolvedValueOnce([2244]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'inchikey',
      identifiers: ['BSYNRYMUTXBXSQ-UHFFFAOYSA-N'],
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.totalFound).toBe(1);
    expect(mockClient.searchByInchiKey).toHaveBeenCalledWith('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
  });

  it('searches by formula', async () => {
    mockClient.searchByFormula.mockResolvedValueOnce([5988, 79025]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: 'C6H12O6',
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.totalFound).toBe(2);
    expect(mockClient.searchByFormula).toHaveBeenCalledWith('C6H12O6', false);
  });

  it('passes allowOtherElements for formula search', async () => {
    mockClient.searchByFormula.mockResolvedValueOnce([1]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: 'C6H12O6',
      allowOtherElements: true,
    });
    await searchCompounds.handler(input, ctx);

    expect(mockClient.searchByFormula).toHaveBeenCalledWith('C6H12O6', true);
  });

  it('searches by similarity', async () => {
    mockClient.searchByStructure.mockResolvedValueOnce([2244, 3672, 1983]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'similarity',
      query: '2244',
      queryType: 'cid',
      threshold: 85,
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.totalFound).toBe(3);
    expect(mockClient.searchByStructure).toHaveBeenCalledWith('similarity', '2244', 'cid', 85);
  });

  it('searches by substructure', async () => {
    mockClient.searchByStructure.mockResolvedValueOnce([100, 200]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'substructure',
      query: 'c1ccccc1',
      queryType: 'smiles',
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(mockClient.searchByStructure).toHaveBeenCalledWith(
      'substructure',
      'c1ccccc1',
      'smiles',
      90,
    );
    expect(result.totalFound).toBe(2);
  });

  it('deduplicates CIDs', async () => {
    mockClient.searchByName.mockResolvedValue([2244]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin', 'acetylsalicylic acid'],
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.totalFound).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it('caps results at maxResults', async () => {
    mockClient.searchByFormula.mockResolvedValueOnce([1, 2, 3, 4, 5]);
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({
      searchType: 'formula',
      formula: 'H2O',
      maxResults: 2,
    });
    const result = await searchCompounds.handler(input, ctx);

    expect(result.totalFound).toBe(5);
    expect(result.results).toHaveLength(2);
  });

  it('hydrates results with properties', async () => {
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

    expect(result.results[0]!.properties).toEqual({
      MolecularFormula: 'C9H8O4',
      MolecularWeight: 180.16,
    });
  });

  it('throws when identifier search missing required fields', async () => {
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({ searchType: 'identifier' });
    await expect(searchCompounds.handler(input, ctx)).rejects.toThrow(
      /identifierType and identifiers are required/,
    );
  });

  it('throws when formula search missing formula', async () => {
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({ searchType: 'formula' });
    await expect(searchCompounds.handler(input, ctx)).rejects.toThrow(/formula is required/);
  });

  it('throws when structure search missing query', async () => {
    const ctx = createMockContext();
    const input = searchCompounds.input.parse({ searchType: 'similarity' });
    await expect(searchCompounds.handler(input, ctx)).rejects.toThrow(
      /query and queryType are required/,
    );
  });

  it('rejects empty-string entries in identifiers from form-based clients', () => {
    expect(() =>
      searchCompounds.input.parse({
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: [''],
      }),
    ).toThrow(/non-empty/);

    expect(() =>
      searchCompounds.input.parse({
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: ['aspirin', '   '],
      }),
    ).toThrow(/non-empty/);
  });
});

describe('searchCompounds format', () => {
  it('formats results without properties', () => {
    const blocks = searchCompounds.format!({
      searchType: 'identifier',
      totalFound: 2,
      results: [
        { cid: 2244, identifier: 'aspirin' },
        { cid: 3672, identifier: 'ibuprofen' },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Found 2 compounds');
    expect(text).toContain('2244 (aspirin)');
  });

  it('formats results with properties', () => {
    const blocks = searchCompounds.format!({
      searchType: 'formula',
      totalFound: 1,
      results: [{ cid: 2244, properties: { MolecularFormula: 'C9H8O4' } }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('CID 2244');
    expect(text).toContain('MolecularFormula: C9H8O4');
  });

  it('formats empty results', () => {
    const blocks = searchCompounds.format!({
      searchType: 'identifier',
      totalFound: 0,
      results: [],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('No results');
  });

  it('shows truncation notice', () => {
    const blocks = searchCompounds.format!({
      searchType: 'formula',
      totalFound: 100,
      results: [{ cid: 1 }, { cid: 2 }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('showing 2 of 100');
  });
});
