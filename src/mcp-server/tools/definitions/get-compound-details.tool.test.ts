/**
 * @fileoverview Tests for get-compound-details tool.
 * @module mcp-server/tools/definitions/get-compound-details.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundDetails } from './get-compound-details.tool.js';

const mockClient = {
  getProperties: vi.fn(),
  getDescription: vi.fn(),
  getSynonyms: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getCompoundDetails handler', () => {
  it('fetches properties for a single CID', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4', MolecularWeight: 180.16 },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244] });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds).toHaveLength(1);
    expect(result.compounds[0]!.cid).toBe(2244);
    expect(result.compounds[0]!.properties).toEqual({
      MolecularFormula: 'C9H8O4',
      MolecularWeight: 180.16,
    });
    expect(result.compounds[0]!.description).toBeUndefined();
    expect(result.compounds[0]!.synonyms).toBeUndefined();
  });

  it('fetches multiple CIDs', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4' },
      { CID: 3672, MolecularFormula: 'C13H18O2' },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244, 3672] });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds).toHaveLength(2);
    expect(result.compounds[0]!.cid).toBe(2244);
    expect(result.compounds[1]!.cid).toBe(3672);
  });

  it('includes descriptions when requested', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244 }]);
    mockClient.getDescription.mockResolvedValueOnce('Aspirin is an NSAID.');
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.description).toBe('Aspirin is an NSAID.');
    expect(mockClient.getDescription).toHaveBeenCalledWith(2244);
  });

  it('handles null descriptions gracefully', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 999 }]);
    mockClient.getDescription.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [999],
      includeDescription: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.description).toBeUndefined();
  });

  it('includes synonyms when requested', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244 }]);
    mockClient.getSynonyms.mockResolvedValueOnce(['Aspirin', 'ASA', 'Acetylsalicylic acid']);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeSynonyms: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.synonyms).toEqual(['Aspirin', 'ASA', 'Acetylsalicylic acid']);
  });

  it('strips CID from properties', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244] });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.properties).not.toHaveProperty('CID');
  });

  it('uses custom properties when specified', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, XLogP: 1.2 }]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      properties: ['XLogP'],
    });
    await getCompoundDetails.handler(input, ctx);

    expect(mockClient.getProperties).toHaveBeenCalledWith([2244], ['XLogP']);
  });
});

describe('getCompoundDetails format', () => {
  it('formats compound with properties', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          properties: {
            IUPACName: '2-acetoxybenzoic acid',
            MolecularFormula: 'C9H8O4',
            MolecularWeight: 180.16,
            CanonicalSMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O',
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('CID 2244');
    expect(text).toContain('2-acetoxybenzoic acid');
    expect(text).toContain('C9H8O4');
    expect(text).toContain('180.16');
  });

  it('formats compound with description and synonyms', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          properties: {},
          description: 'A non-steroidal anti-inflammatory drug.',
          synonyms: ['Aspirin', 'ASA'],
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('non-steroidal');
    expect(text).toContain('Aspirin, ASA');
  });
});
