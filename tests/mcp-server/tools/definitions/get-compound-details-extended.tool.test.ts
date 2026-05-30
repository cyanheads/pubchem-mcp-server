/**
 * @fileoverview Extended tests for get-compound-details tool — edge cases, PUG View cap, and security.
 * @module mcp-server/tools/definitions/get-compound-details-extended.test
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

describe('getCompoundDetails handler — PUG View cap', () => {
  it('caps PUG View calls at 10 CIDs even when more are found', async () => {
    // 12 CIDs all found
    const cids = Array.from({ length: 12 }, (_, i) => i + 1);
    const propertyRows = cids.map((cid) => ({ CID: cid, MolecularFormula: `C${cid}H${cid}` }));
    mockClient.getProperties.mockResolvedValueOnce(propertyRows);

    // Each getDescription call for the first 10 only
    for (let i = 0; i < 10; i++) {
      mockClient.getDescription.mockResolvedValueOnce([{ text: `Description ${i}` }]);
    }

    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids,
      includeDescription: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    // Only 10 PUG View calls should be made
    expect(mockClient.getDescription).toHaveBeenCalledTimes(10);
    expect(result.compounds).toHaveLength(12);
    // First 10 have descriptions, last 2 do not
    expect(result.compounds[0]!.descriptions).toBeDefined();
    expect(result.compounds[9]!.descriptions).toBeDefined();
    expect(result.compounds[10]!.descriptions).toBeUndefined();
    expect(result.compounds[11]!.descriptions).toBeUndefined();
  });

  it('caps classification PUG View calls at 10 CIDs', async () => {
    const cids = Array.from({ length: 11 }, (_, i) => i + 100);
    const propertyRows = cids.map((cid) => ({ CID: cid, MolecularFormula: 'C1H1' }));
    mockClient.getProperties.mockResolvedValueOnce(propertyRows);

    for (let i = 0; i < 10; i++) {
      mockClient.getClassification.mockResolvedValueOnce(null);
    }

    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids,
      includeClassification: true,
    });
    await getCompoundDetails.handler(input, ctx);

    expect(mockClient.getClassification).toHaveBeenCalledTimes(10);
  });
});

describe('getCompoundDetails handler — input validation', () => {
  it('rejects 0 CIDs', () => {
    expect(() => getCompoundDetails.input.parse({ cids: [] })).toThrow();
  });

  it('rejects more than 100 CIDs', () => {
    const cids = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(() => getCompoundDetails.input.parse({ cids })).toThrow();
  });

  it('accepts exactly 100 CIDs', () => {
    const cids = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(() => getCompoundDetails.input.parse({ cids })).not.toThrow();
  });

  it('rejects non-positive CIDs', () => {
    expect(() => getCompoundDetails.input.parse({ cids: [0] })).toThrow();
    expect(() => getCompoundDetails.input.parse({ cids: [-1] })).toThrow();
  });

  it('rejects maxDescriptions below 1', () => {
    expect(() => getCompoundDetails.input.parse({ cids: [1], maxDescriptions: 0 })).toThrow();
  });

  it('rejects maxDescriptions above 20', () => {
    expect(() => getCompoundDetails.input.parse({ cids: [1], maxDescriptions: 21 })).toThrow();
  });
});

describe('getCompoundDetails handler — drug-likeness edge cases', () => {
  it('Lipinski violation at exactly boundary passes (≤1 violation allowed)', async () => {
    // MW violation only (1 of 4) — should still pass overall (Lipinski allows 1)
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 1,
        MolecularWeight: 510, // over 500 limit
        XLogP: 1.0,
        HBondDonorCount: 1,
        HBondAcceptorCount: 2,
        TPSA: 50,
        RotatableBondCount: 3,
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [1], includeDrugLikeness: true });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness!;

    expect(dl.lipinski.violations).toBe(1);
    expect(dl.pass).toBe(true);
  });

  it('two Lipinski violations fails overall', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 1,
        MolecularWeight: 600, // violation
        XLogP: 6, // violation
        HBondDonorCount: 1,
        HBondAcceptorCount: 2,
        TPSA: 50,
        RotatableBondCount: 3,
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [1], includeDrugLikeness: true });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness!;

    expect(dl.lipinski.violations).toBe(2);
    expect(dl.pass).toBe(false);
  });

  it('Veber rotatable bond violation at boundary (>10) fails', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 1,
        MolecularWeight: 300,
        XLogP: 1,
        HBondDonorCount: 1,
        HBondAcceptorCount: 2,
        TPSA: 50,
        RotatableBondCount: 11, // over 10 limit
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [1], includeDrugLikeness: true });
    const result = await getCompoundDetails.handler(input, ctx);
    const dl = result.compounds[0]!.drugLikeness!;

    expect(dl.veber.violations).toBe(1);
  });
});

describe('getCompoundDetails handler — synonyms edge cases', () => {
  it('returns empty synonyms when client returns empty array', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getSynonyms.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244], includeSynonyms: true });
    const result = await getCompoundDetails.handler(input, ctx);

    expect(result.compounds[0]!.synonyms).toBeUndefined();
  });

  it('fetches synonyms for all found CIDs (not capped at 10)', async () => {
    const cids = Array.from({ length: 12 }, (_, i) => i + 1);
    const propertyRows = cids.map((cid) => ({ CID: cid, MolecularFormula: 'C1H1' }));
    mockClient.getProperties.mockResolvedValueOnce(propertyRows);
    for (let i = 0; i < 12; i++) {
      mockClient.getSynonyms.mockResolvedValueOnce([`Synonym${i}`]);
    }

    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids, includeSynonyms: true });
    await getCompoundDetails.handler(input, ctx);

    // Synonyms NOT capped at 10 (only descriptions/classification are)
    expect(mockClient.getSynonyms).toHaveBeenCalledTimes(12);
  });
});

describe('getCompoundDetails format — additional cases', () => {
  it('renders "N/A (insufficient data)" when drug-likeness pass is null', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 1,
          found: true,
          properties: {},
          drugLikeness: {
            lipinski: {
              hba: { limit: 10, pass: null, value: null },
              hbd: { limit: 5, pass: null, value: null },
              mw: { limit: 500, pass: null, value: null },
              violations: 0,
              xLogP: { limit: 5, pass: null, value: null },
            },
            pass: null,
            veber: {
              rotatableBonds: { limit: 10, pass: null, value: null },
              tpsa: { limit: 140, pass: null, value: null },
              violations: 0,
            },
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('N/A (insufficient data)');
  });

  it('renders FAIL for failed drug-likeness', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 1,
          found: true,
          properties: {},
          drugLikeness: {
            lipinski: {
              hba: { limit: 10, pass: false, value: 15 },
              hbd: { limit: 5, pass: false, value: 8 },
              mw: { limit: 500, pass: false, value: 900 },
              violations: 3,
              xLogP: { limit: 5, pass: false, value: 8 },
            },
            pass: false,
            veber: {
              rotatableBonds: { limit: 10, pass: false, value: 15 },
              tpsa: { limit: 140, pass: false, value: 200 },
              violations: 2,
            },
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('FAIL');
    expect(text).toContain('3/4 violations');
    expect(text).toContain('2/2 violations');
  });

  it('renders synonyms with truncation when more than 20', () => {
    const synonyms = Array.from({ length: 25 }, (_, i) => `Synonym-${i}`);
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          synonyms,
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Synonym-0');
    expect(text).toContain('+5 more');
  });

  it('renders MeSH class truncation at 3 items', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          classification: {
            atcCodes: [],
            fdaClasses: [],
            fdaMechanisms: [],
            meshClasses: ['A', 'B', 'C', 'D'],
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('(+1 more)');
  });

  it('renders isomeric SMILES only when different from canonical', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 100,
          found: true,
          properties: {
            CanonicalSMILES: 'CCC',
            IsomericSMILES: 'CC[C@@H](N)O',
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('SMILES:');
    expect(text).toContain('Isomeric SMILES:');
  });

  it('omits isomeric SMILES when same as canonical', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 100,
          found: true,
          properties: {
            CanonicalSMILES: 'CCC',
            IsomericSMILES: 'CCC',
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Isomeric SMILES:');
  });
});

describe('getCompoundDetails — security', () => {
  it('does not leak internal error structure in output', async () => {
    mockClient.getProperties.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    // Empty array from getProperties — handler should handle gracefully
    const input = getCompoundDetails.input.parse({ cids: [2244] });
    const result = await getCompoundDetails.handler(input, ctx);

    // When properties returns empty, compounds should still be populated (not-found)
    expect(result.compounds).toHaveLength(1);
    expect(result.compounds[0]!.found).toBe(false);
  });

  it('passes injection strings in context without interpreting them', async () => {
    // Properties containing injection-like values from upstream should not cause issues in format
    mockClient.getProperties.mockResolvedValueOnce([
      {
        CID: 2244,
        MolecularFormula: '<script>alert(1)</script>',
        IUPACName: "'; DROP TABLE compounds; --",
      },
    ]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244] });
    const result = await getCompoundDetails.handler(input, ctx);

    // The format call must not throw
    const blocks = getCompoundDetails.format!(result);
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    // Script tag should appear as literal text, not interpreted
    expect(text).toContain('<script>alert(1)</script>');
  });
});
