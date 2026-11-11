/**
 * @fileoverview Tests for get-compound-details tool.
 * @module mcp-server/tools/definitions/get-compound-details.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundDetails } from '@/mcp-server/tools/definitions/get-compound-details.tool.js';
import { readCommonMark, readTrailerValue } from '../../../helpers/commonmark.js';

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
    expect(mockClient.getDescription).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
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
    expect(mockClient.getDescription).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
    expect(mockClient.getSynonyms).toHaveBeenCalledTimes(1);
    expect(mockClient.getSynonyms).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
    expect(mockClient.getClassification).toHaveBeenCalledTimes(1);
    expect(mockClient.getClassification).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
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
    expect(result.compounds[0]!.synonymsTotal).toBe(3);
  });

  it('caps synonyms at maxSynonyms and reports total (#24)', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    const allSyns = Array.from({ length: 697 }, (_, i) => `Synonym ${i}`);
    mockClient.getSynonyms.mockResolvedValueOnce(allSyns);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeSynonyms: true,
      maxSynonyms: 5,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.synonyms).toHaveLength(5);
    // Head-of-list cap preserves PubChem's relevance ordering.
    expect(result.compounds[0]!.synonyms![0]).toBe('Synonym 0');
    expect(result.compounds[0]!.synonymsTotal).toBe(697);
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

    expect(mockClient.getProperties).toHaveBeenCalledWith(
      [2244],
      ['XLogP'],
      expect.any(AbortSignal),
    );
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
      atcCodes: [{ code: 'N02BA01', description: 'Acetylsalicylic acid', levels: [] }],
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
    expect(mockClient.getClassification).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
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

describe('getCompoundDetails — ATC hierarchy on both surfaces (#64)', () => {
  const aspirinAtc = [
    {
      code: 'N02BA01',
      description: 'Acetylsalicylic acid',
      levels: [
        { code: 'N', description: 'Nervous system' },
        { code: 'N02', description: 'Analgesics' },
        { code: 'N02B', description: 'Other analgesics and antipyretics' },
        { code: 'N02BA', description: 'Salicylic acid and derivatives' },
      ],
    },
    { code: 'C10AA05', description: '', levels: [] },
  ];

  it('carries each code’s levels in structuredContent and renders its path in content[]', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getClassification.mockResolvedValueOnce({
      atcCodes: aspirinAtc,
      fdaClasses: [],
      fdaMechanisms: [],
      meshClasses: [],
    });

    const result = await runToolContract(getCompoundDetails, {
      cids: [2244],
      includeClassification: true,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      compounds: Array<{ classification?: { atcCodes: unknown } }>;
    };
    expect(structured.compounds[0]!.classification!.atcCodes).toEqual(aspirinAtc);
    const text = result.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    // One nested list item per code; a bare-only code renders alone — no empty description
    // or "> " path behind it.
    expect(readCommonMark(text)).toContain(
      [
        'ATC:',
        '⟨bullet_list_open⟩',
        '⟨list_item_open⟩',
        'N02BA01: N Nervous system > N02 Analgesics > N02B Other analgesics and antipyretics > N02BA Salicylic acid and derivatives > N02BA01 Acetylsalicylic acid',
        '⟨list_item_close⟩',
        '⟨list_item_open⟩',
        'C10AA05',
        '⟨list_item_close⟩',
        '⟨bullet_list_close⟩',
      ].join('\n\n'),
    );
  });

  it('rejects an ATC entry without levels at the output schema', () => {
    const parse = () =>
      getCompoundDetails.output.parse({
        compounds: [
          {
            cid: 2244,
            found: true,
            properties: {},
            classification: {
              atcCodes: [{ code: 'N02BA01', description: 'Acetylsalicylic acid' }],
              fdaClasses: [],
              fdaMechanisms: [],
              meshClasses: [],
            },
          },
        ],
      });

    expect(parse).toThrow(/levels/);
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
    expect(text).toContain('`Aspirin` | `ASA`');
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
    // Description text is framed as a blockquote data block under the label (#27).
    expect(text).toContain('**Description:**');
    expect(text).toContain('> only one');
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
            atcCodes: [
              {
                code: 'N02BA01',
                description: 'Acetylsalicylic acid',
                levels: [{ code: 'N', description: 'Nervous system' }],
              },
            ],
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

  it('labels CanonicalSMILES as Canonical SMILES, keeping the isomeric line beside it', () => {
    const textOf = (properties: Record<string, unknown>) =>
      (
        getCompoundDetails.format!({ compounds: [{ cid: 1, found: true, properties }] })[0] as {
          text: string;
        }
      ).text;

    const both = textOf({ CanonicalSMILES: 'CC(N)O', IsomericSMILES: 'C[C@@H](N)O' });
    expect(readTrailerValue(both, 'Canonical SMILES')).toBe('CC(N)O');
    expect(readTrailerValue(both, 'Isomeric SMILES')).toBe('C[C@@H](N)O');
    // PubChem now calls the stereo form "SMILES", so no line carries that bare label.
    expect(readTrailerValue(both, 'SMILES')).toBeUndefined();

    const same = textOf({ CanonicalSMILES: 'CCC', IsomericSMILES: 'CCC' });
    expect(readTrailerValue(same, 'Canonical SMILES')).toBe('CCC');
    expect(readTrailerValue(same, 'Isomeric SMILES')).toBeUndefined();
  });
});

type Result = Awaited<ReturnType<typeof runToolContract>>;

type Rejection = {
  error: { code: number; message: string; data: { recovery: { hint: string } } };
};

/** The rejection a schema failure returns, asserted as -32602 before the handler ran. */
function rejectionOf(result: Result): Rejection['error'] {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as Rejection;
  expect(error.code).toBe(-32602);
  expect(mockClient.getProperties).not.toHaveBeenCalled();
  return error;
}

const MESSAGE_PREFIX =
  'Input validation error: Invalid arguments for tool pubchem_get_compound_details: ';

type Structured = {
  compounds: Array<{ cid: number; found: boolean; properties: Record<string, unknown> }>;
  unprocessed?: number[];
  cappedInputs?: unknown[];
};

// ── cid and a lone CID read as cids (#91) ─────────────────────────────

describe('getCompoundDetails reads cid and a lone CID as cids (#91)', () => {
  beforeEach(() => {
    mockClient.getProperties.mockImplementation(async (cids: number[]) =>
      cids.map((CID) => ({ CID, MolecularFormula: 'C8H10N4O2' })),
    );
  });

  it.each<[string, unknown]>([
    ['cid as a number', { cid: 2519 }],
    ['cid as a numeric string', { cid: '2519' }],
    ['a lone CID', { cids: 2519 }],
    ['a lone numeric-string CID', { cids: '2519' }],
  ])('answers %s as it answers cids: [2519]', async (_label, input) => {
    const expected = await runToolContract(getCompoundDetails, { cids: [2519] });
    const result = await runToolContract(getCompoundDetails, input as never);

    expect(result.isError).toBeFalsy();
    expect(result).toEqual(expected);
    expect(mockClient.getProperties.mock.calls.map(([cids]) => cids)).toEqual([[2519], [2519]]);
  });

  it('rejects a cid that spells no CID, naming the key it validated', async () => {
    const error = rejectionOf(
      await runToolContract(getCompoundDetails, { cid: 'caffeine' } as never),
    );

    expect(error.message).toBe(
      `${MESSAGE_PREFIX}cids: Invalid input: expected array, received string`,
    );
    expect(error.data.recovery.hint).toMatch(/ Validated cid as cids\.$/);
  });

  it('rejects cid sent beside cids', async () => {
    const error = rejectionOf(
      await runToolContract(getCompoundDetails, { cid: 2519, cids: [702] } as never),
    );

    expect(error.data.recovery.hint).toContain(
      'cid is an alias of cids; send one of them, not both.',
    );
  });

  it.each<[unknown[], number[]]>([
    [['2519'], [2519]],
    [
      [2519, '702'],
      [2519, 702],
    ],
  ])('validates cids %j as %j on the first parse, with no argument repair', (sent, parsed) => {
    const result = getCompoundDetails.input.safeParse({ cids: sent });
    expect(result.success).toBe(true);
    expect(result.data?.cids).toEqual(parsed);
  });

  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const notANumber = [
    'cids.0: Invalid input: expected number, received string',
    'Send cids.0 as a number, not a string.',
  ] as const;

  it.each<[string, unknown[], string, string]>([
    [
      'an empty list',
      [],
      'cids: Too small: expected array to have >=1 items',
      'cids: Too small: expected array to have >=1 items',
    ],
    [
      '1,001 CIDs',
      range(1001),
      'cids: Too big: expected array to have <=1000 items',
      'cids: Too big: expected array to have <=1000 items',
    ],
    [
      'a zero',
      [0],
      'cids.0: Too small: expected number to be >=1',
      'cids.0: Too small: expected number to be >=1',
    ],
    [
      'a fraction',
      [2519.5],
      'cids.0: Invalid input: expected int, received number',
      'Send cids.0 as an integer, not a fractional number.',
    ],
    ['a decimal string', ['1.0'], ...notANumber],
    ['a zero-padded string', ['01'], ...notANumber],
    ['a negative-zero string', ['-0'], ...notANumber],
    ['an empty string', [''], ...notANumber],
  ])('rejects %s with the message and hint it got before', async (_label, cids, issue, hint) => {
    const error = rejectionOf(await runToolContract(getCompoundDetails, { cids } as never));

    expect(error.message).toBe(`${MESSAGE_PREFIX}${issue}`);
    expect(error.data.recovery.hint).toBe(hint);
  });

  it('still serves a list past the per-call cap up to the cap, the rest unprocessed', async () => {
    const result = await runToolContract(getCompoundDetails, { cids: range(101) });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Structured;

    expect(sc.compounds.map((c) => c.cid)).toEqual(range(100));
    expect(sc.unprocessed).toEqual([101]);
    expect(sc.cappedInputs).toEqual([
      { input: 'cids', requested: 101, served: 100, unprocessed: 1 },
    ]);
  });
});

// ── PubChem's current property names (#92) ────────────────────────────

/** CID 5793 (glucose) as the client returns it: keyed by this server's names, which
 * `normalizePropertyNames` maps PubChem's `SMILES` / `ConnectivitySMILES` response keys to. */
const GLUCOSE: Record<string, unknown> = {
  IsomericSMILES: 'C([C@@H]1[C@H]([C@@H]([C@H](C(O1)O)O)O)O)O',
  CanonicalSMILES: 'C(C1C(C(C(C(O1)O)O)O)O)O',
  MolecularWeight: '180.16',
  XLogP: -2.6,
  HBondDonorCount: 5,
  HBondAcceptorCount: 6,
  TPSA: 110,
  RotatableBondCount: 1,
};

/** The properties each getProperties call asked PubChem for. */
const requestedProperties = () => mockClient.getProperties.mock.calls.map(([, props]) => props);

describe('getCompoundDetails reads PubChem current property names (#92)', () => {
  beforeEach(() => {
    mockClient.getProperties.mockImplementation(async (cids: number[], props: string[]) =>
      cids.map((CID) => ({ CID, ...Object.fromEntries(props.map((p) => [p, GLUCOSE[p]])) })),
    );
  });

  it.each<[string, unknown, string[]]>([
    ['SMILES', ['SMILES'], ['IsomericSMILES']],
    ['ConnectivitySMILES', ['ConnectivitySMILES'], ['CanonicalSMILES']],
    ['both forms of the stereo SMILES', ['SMILES', 'IsomericSMILES'], ['IsomericSMILES']],
    ['the lone string SMILES', 'SMILES', ['IsomericSMILES']],
    [
      'a repeated older name',
      ['IsomericSMILES', 'MolecularWeight', 'IsomericSMILES'],
      ['IsomericSMILES', 'MolecularWeight'],
    ],
  ])(
    'answers %s under this server’s name, naming each property once',
    async (_label, properties, read) => {
      const result = await runToolContract(getCompoundDetails, {
        cids: [5793],
        properties,
      } as never);

      expect(result.isError).toBeFalsy();
      expect(requestedProperties()).toEqual([read]);
      const sc = result.structuredContent as Structured;
      expect(sc.compounds[0]!.properties).toEqual(
        Object.fromEntries(read.map((p) => [p, GLUCOSE[p]])),
      );
    },
  );

  it('answers the current names exactly as it answers the older ones', async () => {
    const older = await runToolContract(getCompoundDetails, {
      cids: [5793],
      properties: ['IsomericSMILES', 'CanonicalSMILES'],
    });
    const current = await runToolContract(getCompoundDetails, {
      cids: [5793],
      properties: ['SMILES', 'ConnectivitySMILES'],
    } as never);

    expect(older.isError).toBeFalsy();
    expect(current).toEqual(older);
    expect(requestedProperties()).toEqual([
      ['IsomericSMILES', 'CanonicalSMILES'],
      ['IsomericSMILES', 'CanonicalSMILES'],
    ]);
  });

  it('still wraps the lone string MolecularWeight', async () => {
    const result = await runToolContract(getCompoundDetails, {
      cids: [5793],
      properties: 'MolecularWeight',
    } as never);

    expect(result.isError).toBeFalsy();
    expect(requestedProperties()).toEqual([['MolecularWeight']]);
  });

  it.each(['smiles', 'AbsoluteSMILES'])('still rejects %s', async (name) => {
    const error = rejectionOf(
      await runToolContract(getCompoundDetails, { cids: [5793], properties: [name] } as never),
    );
    expect(error.message).toContain('properties.0: Invalid option');
  });

  it.each<[string, string[], string[]]>([
    [
      'older names',
      ['MolecularWeight', 'TPSA'],
      [
        'MolecularWeight',
        'TPSA',
        'XLogP',
        'HBondDonorCount',
        'HBondAcceptorCount',
        'RotatableBondCount',
      ],
    ],
    [
      'a current name beside its older one',
      ['SMILES', 'IsomericSMILES', 'MolecularWeight'],
      [
        'IsomericSMILES',
        'MolecularWeight',
        'XLogP',
        'HBondDonorCount',
        'HBondAcceptorCount',
        'TPSA',
        'RotatableBondCount',
      ],
    ],
  ])(
    'appends the drug-likeness inputs to %s, naming each property once',
    async (_label, properties, read) => {
      const result = await runToolContract(getCompoundDetails, {
        cids: [5793],
        properties,
        includeDrugLikeness: true,
      } as never);

      expect(result.isError).toBeFalsy();
      expect(requestedProperties()).toEqual([read]);
    },
  );

  it('states the name pairing in the output properties description', () => {
    const schema = getCompoundDetails.output['~standard'].jsonSchema.output({
      target: 'draft-2020-12',
    }) as {
      properties: {
        compounds: { items: { properties: { properties: { description: string } } } };
      };
    };
    const { description } = schema.properties.compounds.items.properties.properties;
    expect(description).toMatch(/\bSMILES\b[^.]*\bIsomericSMILES\b/);
    expect(description).toMatch(/\bConnectivitySMILES\b[^.]*\bCanonicalSMILES\b/);
  });
});

// ── properties: [] reads as unset (fold-in) ───────────────────────────

/** The core set `properties` defaults to, as its description lists it. */
const CORE_SET = [
  'MolecularFormula',
  'MolecularWeight',
  'IUPACName',
  'CanonicalSMILES',
  'IsomericSMILES',
  'InChIKey',
  'XLogP',
  'TPSA',
  'HBondDonorCount',
  'HBondAcceptorCount',
  'RotatableBondCount',
  'HeavyAtomCount',
  'Charge',
  'Complexity',
];

describe('getCompoundDetails reads an empty properties list as the default core set', () => {
  beforeEach(() => {
    // As the real client does: no properties, no request, no rows.
    mockClient.getProperties.mockImplementation(async (cids: number[], props: string[]) =>
      props.length === 0 ? [] : cids.map((CID) => ({ CID, MolecularFormula: 'C9H8O4' })),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['omitted', {}],
    ['empty', { properties: [] }],
  ])(
    'fetches the core set when properties is %s, and finds the compound',
    async (_label, extra) => {
      const result = await runToolContract(getCompoundDetails, { cids: [2244], ...extra });

      expect(result.isError).toBeFalsy();
      expect(requestedProperties()).toEqual([CORE_SET]);
      const sc = result.structuredContent as Structured;
      expect(sc.compounds[0]).toMatchObject({ cid: 2244, found: true });
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('## CID 2244 (found)');
      expect(readTrailerValue(text, 'Formula')).toBe('C9H8O4');
    },
  );
});
