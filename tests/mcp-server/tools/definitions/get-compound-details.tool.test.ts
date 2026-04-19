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
    expect(result.compounds[0]!.found).toBe(true);
    expect(result.compounds[0]!.properties).toEqual({
      MolecularFormula: 'C9H8O4',
      MolecularWeight: 180.16,
    });
    expect(result.compounds[0]!.descriptions).toBeUndefined();
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
    expect(result.compounds.every((c) => c.found)).toBe(true);
  });

  it('includes descriptions when requested', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getDescription.mockResolvedValueOnce([
      { source: 'DrugBank', text: 'Aspirin is an NSAID.' },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.descriptions).toEqual([
      { source: 'DrugBank', text: 'Aspirin is an NSAID.' },
    ]);
    expect(result.compounds[0]!.descriptionsTotal).toBe(1);
    expect(mockClient.getDescription).toHaveBeenCalledWith(2244);
  });

  it('handles empty descriptions gracefully', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 999, MolecularFormula: 'C1H1' }]);
    mockClient.getDescription.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [999],
      includeDescription: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.descriptions).toBeUndefined();
    expect(result.compounds[0]!.descriptionsTotal).toBeUndefined();
  });

  it('caps descriptions at maxDescriptions and reports total (#7 regression)', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    const allDescs = Array.from({ length: 11 }, (_, i) => ({
      source: `Source ${i}`,
      text: `Description ${i} with sufficient unique prefix to avoid dedup collision.`,
    }));
    mockClient.getDescription.mockResolvedValueOnce(allDescs);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
      maxDescriptions: 3,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.descriptions).toHaveLength(3);
    expect(result.compounds[0]!.descriptionsTotal).toBe(11);
    // First three are preserved in order
    expect(result.compounds[0]!.descriptions![0]!.source).toBe('Source 0');
    expect(result.compounds[0]!.descriptions![2]!.source).toBe('Source 2');
  });

  it('respects maxDescriptions=20 upper bound', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    const allDescs = Array.from({ length: 25 }, (_, i) => ({
      text: `Description ${i} unique prefix.`,
    }));
    mockClient.getDescription.mockResolvedValueOnce(allDescs);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
      maxDescriptions: 20,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.descriptions).toHaveLength(20);
    expect(result.compounds[0]!.descriptionsTotal).toBe(25);
  });

  it('signals not-found for nonexistent CIDs (#5 regression)', async () => {
    // PubChem returns {CID: x} with no other fields when the CID does not exist.
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 999999999 }]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [999999999] });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds).toHaveLength(1);
    expect(result.compounds[0]!.found).toBe(false);
    expect(result.compounds[0]!.properties).toEqual({});
  });

  it('mixes found and not-found CIDs in batch (#5 regression)', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4' },
      { CID: 999999999 }, // not found
      { CID: 3672, MolecularFormula: 'C13H18O2' },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244, 999999999, 3672] });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds.map((c) => c.found)).toEqual([true, false, true]);
    expect(result.compounds[1]!.properties).toEqual({});
  });

  it('skips PUG View calls for not-found CIDs (#5 regression)', async () => {
    // Only the found CID should trigger a description / synonym / classification call.
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4' },
      { CID: 999999999 },
    ]);
    mockClient.getDescription.mockResolvedValueOnce([{ text: 'Aspirin.' }]);
    mockClient.getSynonyms.mockResolvedValueOnce(['Aspirin']);
    mockClient.getClassification.mockResolvedValueOnce(null);

    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244, 999999999],
      includeDescription: true,
      includeSynonyms: true,
      includeClassification: true,
    });
    await getCompoundDetails.handler(input, ctx);

    expect(mockClient.getDescription).toHaveBeenCalledTimes(1);
    expect(mockClient.getDescription).toHaveBeenCalledWith(2244);
    expect(mockClient.getSynonyms).toHaveBeenCalledTimes(1);
    expect(mockClient.getSynonyms).toHaveBeenCalledWith(2244);
    expect(mockClient.getClassification).toHaveBeenCalledTimes(1);
    expect(mockClient.getClassification).toHaveBeenCalledWith(2244);
  });

  it('includes synonyms when requested', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
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
    // Compound exists (has IUPACName) but the drug-likeness inputs are missing.
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, IUPACName: '2-acetyloxybenzoic acid' },
    ]);
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
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
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
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 241, MolecularFormula: 'H2O' }]);
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
          found: true,
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

  it('formats compound with descriptions and synonyms', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          descriptions: [{ source: 'DrugBank', text: 'A non-steroidal anti-inflammatory drug.' }],
          descriptionsTotal: 1,
          synonyms: ['Aspirin', 'ASA'],
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('non-steroidal');
    expect(text).toContain('Description (DrugBank)');
    expect(text).toContain('Aspirin, ASA');
  });

  it('renders truncation marker when descriptions exceed cap (#7 regression)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          descriptions: [
            { source: 'A', text: 'first' },
            { source: 'B', text: 'second' },
            { source: 'C', text: 'third' },
          ],
          descriptionsTotal: 11,
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('+8 more descriptions from other sources');
    expect(text).toContain('Description (A)');
    expect(text).toContain('Description (C)');
  });

  it('omits truncation marker when descriptions fit (#7 regression)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          descriptions: [{ text: 'only one' }],
          descriptionsTotal: 1,
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).not.toContain('more description');
    expect(text).toContain('**Description:** only one');
  });

  it('renders not-found header for missing CIDs (#5 regression)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [{ cid: 999999999, found: false, properties: {} }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('CID 999999999 — not found in PubChem');
    expect(text).not.toContain('**Formula:**');
  });

  it('formats drug-likeness assessment', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
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
          found: true,
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
