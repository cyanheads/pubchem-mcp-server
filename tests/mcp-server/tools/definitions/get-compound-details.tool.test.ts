/**
 * @fileoverview Tests for get-compound-details tool.
 * @module mcp-server/tools/definitions/get-compound-details.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundDetails } from '@/mcp-server/tools/definitions/get-compound-details.tool.js';

const mockClient = {
  getProperties: vi.fn(),
  getDescription: vi.fn(),
  getSynonyms: vi.fn(),
  getClassification: vi.fn(),
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

  it('computes drug-likeness from properties', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 2244,
        MolecularWeight: 180.16,
        XLogP: 1.2,
        HBondDonorCount: 1,
        HBondAcceptorCount: 4,
        TPSA: 63.6,
        RotatableBondCount: 3,
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDrugLikeness: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness;

    expect(dl).toBeDefined();
    expect(dl!.pass).toBe(true);
    expect(dl!.lipinski.violations).toBe(0);
    expect(dl!.lipinski.mw).toEqual({ limit: 500, pass: true, value: 180.16 });
    expect(dl!.veber.violations).toBe(0);
  });

  it('detects drug-likeness violations', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 99999,
        MolecularWeight: 900,
        XLogP: 8,
        HBondDonorCount: 7,
        HBondAcceptorCount: 15,
        TPSA: 200,
        RotatableBondCount: 15,
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [99999],
      includeDrugLikeness: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness;

    expect(dl!.pass).toBe(false);
    expect(dl!.lipinski.violations).toBe(4);
    expect(dl!.veber.violations).toBe(2);
    expect(dl!.lipinski.mw.pass).toBe(false);
    expect(dl!.lipinski.xLogP.pass).toBe(false);
  });

  it('returns null pass when properties are unavailable', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244 }]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDrugLikeness: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness;

    expect(dl!.pass).toBeNull();
    expect(dl!.lipinski.violations).toBe(0);
    expect(dl!.lipinski.mw.pass).toBeNull();
    expect(dl!.lipinski.mw.value).toBeNull();
  });

  it('coerces string-valued numeric properties (PubChem returns MW as string)', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 2244,
        MolecularWeight: '180.16',
        XLogP: 1.2,
        HBondDonorCount: 1,
        HBondAcceptorCount: 4,
        TPSA: 63.6,
        RotatableBondCount: 3,
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDrugLikeness: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness;

    expect(dl!.pass).toBe(true);
    expect(dl!.lipinski.mw).toEqual({ limit: 500, pass: true, value: 180.16 });
  });

  it('returns null pass when any rule is indeterminate', async () => {
    // MW, XLogP, HBD, HBA, TPSA present; RotatableBondCount missing → null
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 2244,
        MolecularWeight: 180.16,
        XLogP: 1.2,
        HBondDonorCount: 1,
        HBondAcceptorCount: 4,
        TPSA: 63.6,
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDrugLikeness: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.drugLikeness!.pass).toBeNull();
  });

  it('includes classification when requested', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244 }]);
    mockClient.getClassification.mockResolvedValueOnce({
      atcCodes: [{ code: 'N02BA01', description: 'Acetylsalicylic acid' }],
      fdaClasses: ['Nonsteroidal Anti-inflammatory Drug'],
      fdaMechanisms: ['Cyclooxygenase Inhibitors'],
      meshClasses: ['Anti-Inflammatory Agents, Non-Steroidal'],
    });
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeClassification: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.classification).toBeDefined();
    expect(result.compounds[0]!.classification!.fdaClasses).toContain(
      'Nonsteroidal Anti-inflammatory Drug',
    );
    expect(mockClient.getClassification).toHaveBeenCalledWith(2244);
  });

  it('handles null classification gracefully', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 241 }]);
    mockClient.getClassification.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [241],
      includeClassification: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.classification).toBeUndefined();
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

  it('formats drug-likeness assessment', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          properties: {},
          drugLikeness: {
            lipinski: {
              hba: { limit: 10, pass: true, value: 4 },
              hbd: { limit: 5, pass: true, value: 1 },
              mw: { limit: 500, pass: true, value: 180.16 },
              violations: 0,
              xLogP: { limit: 5, pass: true, value: 1.2 },
            },
            pass: true,
            veber: {
              rotatableBonds: { limit: 10, pass: true, value: 3 },
              tpsa: { limit: 140, pass: true, value: 63.6 },
              violations: 0,
            },
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Drug-likeness');
    expect(text).toContain('PASS');
    expect(text).toContain('0/4 violations');
    expect(text).toContain('0/2 violations');
  });

  it('formats classification', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          properties: {},
          classification: {
            atcCodes: [{ code: 'N02BA01', description: 'Acetylsalicylic acid' }],
            fdaClasses: ['Nonsteroidal Anti-inflammatory Drug'],
            fdaMechanisms: ['Cyclooxygenase Inhibitors'],
            meshClasses: ['Anti-Inflammatory Agents, Non-Steroidal'],
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Classification');
    expect(text).toContain('Nonsteroidal Anti-inflammatory Drug');
    expect(text).toContain('N02BA01');
    expect(text).toContain('Cyclooxygenase Inhibitors');
  });
});
