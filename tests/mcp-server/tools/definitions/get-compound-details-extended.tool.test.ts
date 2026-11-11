/**
 * @fileoverview Extended tests for get-compound-details tool — edge cases, PUG View cap, and security.
 * @module mcp-server/tools/definitions/get-compound-details-extended.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundDetails } from '@/mcp-server/tools/definitions/get-compound-details.tool.js';
import { readCommonMark, readTrailerValue } from '../../../helpers/commonmark.js';
import { asReadBack, literalRead, READ_BACK_FUZZ } from '../../../helpers/read-back.js';

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

  it('accepts more than 100 CIDs up to 1000, and rejects 1001 (#70)', () => {
    const cids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(() => getCompoundDetails.input.parse({ cids: cids(101) })).not.toThrow();
    expect(() => getCompoundDetails.input.parse({ cids: cids(1000) })).not.toThrow();
    expect(() => getCompoundDetails.input.parse({ cids: cids(1001) })).toThrow();
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

  it('accepts maxDescriptions past the cap of 20 up to 1000, and rejects 1001 (#70)', () => {
    const parse = (maxDescriptions: number) => () =>
      getCompoundDetails.input.parse({ cids: [1], maxDescriptions });
    expect(parse(21)).not.toThrow();
    expect(parse(1000)).not.toThrow();
    expect(parse(1001)).toThrow();
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

describe('getCompoundDetails handler — PUG View cap disclosure (#40)', () => {
  /** 12 found CIDs, descriptions requested — two land past the fan-out limit. */
  const setUpOverflowBatch = () => {
    const cids = Array.from({ length: 12 }, (_, i) => i + 1);
    mockClient.getProperties.mockResolvedValueOnce(
      cids.map((cid) => ({ CID: cid, MolecularFormula: 'C1H1' })),
    );
    for (let i = 0; i < 10; i++) {
      mockClient.getDescription.mockResolvedValueOnce([{ text: `Description ${i}` }]);
    }
    return cids;
  };

  it('names the enriched and skipped CIDs instead of dropping them silently', async () => {
    const cids = setUpOverflowBatch();
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids, includeDescription: true });
    await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.enrichedCids).toEqual(cids.slice(0, 10));
    expect(enrichment.skippedCids).toEqual([11, 12]);
    expect(enrichment.notice).toContain('first 10 of 12 found CIDs');
    expect(enrichment.notice).toContain('11, 12');
    expect(enrichment.notice).toContain('follow-up call');
  });

  it('stays silent when the batch fits inside the limit', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4' },
      { CID: 3672, MolecularFormula: 'C13H18O2' },
    ]);
    mockClient.getDescription
      .mockResolvedValueOnce([{ text: 'Aspirin.' }])
      .mockResolvedValueOnce([{ text: 'Ibuprofen.' }]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244, 3672],
      includeDescription: true,
    });
    await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.enrichedCids).toBeUndefined();
    expect(enrichment.skippedCids).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('does not disclose a cap when neither PUG View flag is set', async () => {
    const cids = Array.from({ length: 12 }, (_, i) => i + 1);
    mockClient.getProperties.mockResolvedValueOnce(
      cids.map((cid) => ({ CID: cid, MolecularFormula: 'C1H1' })),
    );
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids });
    await getCompoundDetails.handler(input, ctx);

    expect(getEnrichment(ctx).skippedCids).toBeUndefined();
  });

  it('counts only found CIDs toward the limit', async () => {
    // 4 missing CIDs at the head still leave the 11 real ones one over the limit.
    const missing = [900, 901, 902, 903];
    const found = Array.from({ length: 11 }, (_, i) => i + 1);
    mockClient.getProperties.mockResolvedValueOnce([
      ...missing.map((cid) => ({ CID: cid })),
      ...found.map((cid) => ({ CID: cid, MolecularFormula: 'C1H1' })),
    ]);
    for (let i = 0; i < 10; i++) {
      mockClient.getClassification.mockResolvedValueOnce(null);
    }
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [...missing, ...found],
      includeClassification: true,
    });
    await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.enrichedCids).toEqual(found.slice(0, 10));
    expect(enrichment.skippedCids).toEqual([11]);
  });
});

describe('getCompoundDetails handler — synonym/description continuation (#38)', () => {
  const synonyms = Array.from({ length: 30 }, (_, i) => `Synonym-${i}`);
  const descriptions = Array.from({ length: 8 }, (_, i) => ({ text: `Description ${i}` }));

  it('returns the synonym slice starting at synonymOffset', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getSynonyms.mockResolvedValueOnce(synonyms);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeSynonyms: true,
      synonymOffset: 10,
      maxSynonyms: 5,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.compounds[0]!.synonyms).toEqual([
      'Synonym-10',
      'Synonym-11',
      'Synonym-12',
      'Synonym-13',
      'Synonym-14',
    ]);
    // The total stays the compound's full count, not the page length.
    expect(result.compounds[0]!.synonymsTotal).toBe(30);
    expect(enrichment.synonymOffset).toBe(10);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.nextSynonymOffset).toBe(15);
    expect(enrichment.notice).toContain('synonymOffset=15');
  });

  it('walks one compound of synonyms end to end without repeats or gaps', async () => {
    const seen: string[] = [];
    for (let synonymOffset = 0; synonymOffset < 30; synonymOffset += 12) {
      mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
      mockClient.getSynonyms.mockResolvedValueOnce(synonyms);
      const ctx = createMockContext();
      const input = getCompoundDetails.input.parse({
        cids: [2244],
        includeSynonyms: true,
        synonymOffset,
        maxSynonyms: 12,
      });
      const result = await getCompoundDetails.handler(input, ctx);
      seen.push(...(result.compounds[0]!.synonyms ?? []));
    }

    expect(seen).toEqual(synonyms);
  });

  it('marks the last synonym page as complete', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getSynonyms.mockResolvedValueOnce(synonyms);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeSynonyms: true,
      synonymOffset: 25,
      maxSynonyms: 10,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.compounds[0]!.synonyms).toHaveLength(5);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.nextSynonymOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('explains a synonymOffset past every compound in the batch', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4' },
      { CID: 3672, MolecularFormula: 'C13H18O2' },
    ]);
    mockClient.getSynonyms
      .mockResolvedValueOnce(['a', 'b', 'c'])
      .mockResolvedValueOnce(['d', 'e', 'f', 'g']);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244, 3672],
      includeSynonyms: true,
      synonymOffset: 50,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.compounds[0]!.synonyms).toEqual([]);
    // The full count survives the empty page, so the caller can pick a valid offset.
    expect(result.compounds[0]!.synonymsTotal).toBe(3);
    expect(enrichment.notice).toContain('synonymOffset 50 is past every compound');
    // Bound comes from the longest list in the batch, not the first compound's.
    expect(enrichment.notice).toContain('has 4 entries');
  });

  it('keeps paging open while any compound in the batch has more', async () => {
    mockClient.getProperties.mockResolvedValueOnce([
      { CID: 2244, MolecularFormula: 'C9H8O4' },
      { CID: 3672, MolecularFormula: 'C13H18O2' },
    ]);
    mockClient.getSynonyms.mockResolvedValueOnce(['a', 'b']).mockResolvedValueOnce(synonyms);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244, 3672],
      includeSynonyms: true,
      maxSynonyms: 5,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.compounds[0]!.synonyms).toEqual(['a', 'b']);
    expect(result.compounds[1]!.synonyms).toHaveLength(5);
    expect(enrichment.nextSynonymOffset).toBe(5);
  });

  it('pages descriptions independently of synonyms', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getDescription.mockResolvedValueOnce(descriptions);
    mockClient.getSynonyms.mockResolvedValueOnce(['a', 'b']);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
      includeSynonyms: true,
      descriptionOffset: 3,
      maxDescriptions: 2,
      maxSynonyms: 20,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.compounds[0]!.descriptions).toEqual([
      { text: 'Description 3' },
      { text: 'Description 4' },
    ]);
    expect(result.compounds[0]!.descriptionsTotal).toBe(8);
    expect(enrichment.descriptionOffset).toBe(3);
    expect(enrichment.nextDescriptionOffset).toBe(5);
    // Synonyms fit on one page, so only the description continuation is open.
    expect(enrichment.synonymOffset).toBe(0);
    expect(enrichment.nextSynonymOffset).toBeUndefined();
  });

  it('explains a descriptionOffset past every compound in the batch', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getDescription.mockResolvedValueOnce(descriptions);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
      descriptionOffset: 20,
    });
    const result = await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.compounds[0]!.descriptions).toEqual([]);
    expect(result.compounds[0]!.descriptionsTotal).toBe(8);
    expect(enrichment.notice).toContain('descriptionOffset 20 is past every compound');
  });

  it('composes the skipped-CID and continuation notices into one string', async () => {
    const cids = Array.from({ length: 12 }, (_, i) => i + 1);
    mockClient.getProperties.mockResolvedValueOnce(
      cids.map((cid) => ({ CID: cid, MolecularFormula: 'C1H1' })),
    );
    for (let i = 0; i < 10; i++) {
      mockClient.getDescription.mockResolvedValueOnce(descriptions);
    }
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids,
      includeDescription: true,
      maxDescriptions: 2,
    });
    await getCompoundDetails.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('re-request those CIDs');
    expect(notice).toContain('descriptionOffset=2');
  });

  it('omits offset echoes for lists that were not requested', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({ cids: [2244] });
    await getCompoundDetails.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.synonymOffset).toBeUndefined();
    expect(enrichment.descriptionOffset).toBeUndefined();
  });

  it('defaults both offsets to 0 and rejects negatives', () => {
    const parsed = getCompoundDetails.input.parse({ cids: [2244] });
    expect(parsed.synonymOffset).toBe(0);
    expect(parsed.descriptionOffset).toBe(0);
    expect(() => getCompoundDetails.input.parse({ cids: [2244], synonymOffset: -1 })).toThrow();
    expect(() => getCompoundDetails.input.parse({ cids: [2244], descriptionOffset: -1 })).toThrow();
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

  it('renders synonyms with the total and a truncation marker (#24)', () => {
    // The handler caps `synonyms` to maxSynonyms and reports the full count via synonymsTotal.
    const synonyms = Array.from({ length: 20 }, (_, i) => `Synonym-${i}`);
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          synonyms,
          synonymsTotal: 25,
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Synonym-0');
    expect(text).toContain('25 total');
    expect(text).toContain('+5 more');
  });

  it('renders an empty synonym page as a page boundary, not as "no synonyms" (#38)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [{ cid: 2244, found: true, properties: {}, synonyms: [], synonymsTotal: 698 }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('**Synonyms** (698 total): none at this synonymOffset');
  });

  it('renders an empty description page as a page boundary (#38)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        { cid: 2244, found: true, properties: {}, descriptions: [], descriptionsTotal: 7 },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('**Descriptions** (7 total): none at this descriptionOffset');
  });

  it('points at both the cap and the offset when descriptions are windowed (#38)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          descriptions: [{ text: 'first' }],
          descriptionsTotal: 7,
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('raise maxDescriptions or page with descriptionOffset');
  });

  it('renders every MeSH class structuredContent carries (#37)', () => {
    // structuredContent applies no cap to meshClasses, so format() must not either.
    const meshClasses = [
      'Anti-Inflammatory Agents, Non-Steroidal',
      'Antipyretics',
      'Cyclooxygenase Inhibitors',
      'Fibrinolytic Agents',
      'Platelet Aggregation Inhibitors',
    ];
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          classification: { atcCodes: [], fdaClasses: [], fdaMechanisms: [], meshClasses },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    for (const cls of meshClasses) expect(text).toContain(cls);
    expect(text).not.toContain('more)');
  });

  it('keeps a MeSH class containing "; " as one recoverable entry', () => {
    // Aspirin's real NSAID scope note ends "...platelet-inhibitory actions; other mechanisms
    // may contribute...". Under the old '; ' joiner that internal semicolon was
    // indistinguishable from an entry boundary.
    const meshClasses = [
      'Anti-inflammatory agents that are non-steroidal in nature. They act by blocking the synthesis of prostaglandins; other mechanisms may contribute to their anti-inflammatory effects.',
      'Drugs that are used to reduce body temperature in fever.',
    ];
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          classification: { atcCodes: [], fdaClasses: [], fdaMechanisms: [], meshClasses },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    // Two inputs must round-trip to exactly two list items, each intact.
    expect(readCommonMark(text)).toContain(meshListRead(meshClasses));
  });

  it('reads a MeSH class holding a line break and a list marker back as one entry (#88)', () => {
    const meshClasses = ['a\n- forged', 'b'];
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 2244,
          found: true,
          properties: {},
          classification: { atcCodes: [], fdaClasses: [], fdaMechanisms: [], meshClasses },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(readCommonMark(text)).toContain(meshListRead(meshClasses));
  });

  it('keeps a synonym containing ", " as one recoverable entry', () => {
    // CAS inverted names ("Benzoic acid, 2-(acetyloxy)-") carry their own comma.
    const synonyms = ['aspirin', 'Benzoic acid, 2-(acetyloxy)-', '1H-Purine-2,6-dione'];
    const blocks = getCompoundDetails.format!({
      compounds: [{ cid: 2244, found: true, properties: {}, synonyms, synonymsTotal: 3 }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(readSynonyms(text)).toEqual(synonyms);
  });

  it('escapes an upstream property name it renders as a label (#88)', () => {
    const blocks = getCompoundDetails.format!({
      compounds: [
        {
          cid: 1,
          found: true,
          properties: { '[k](https://x.test)': 'v', Volume3D: 155.3 },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(readCommonMark(text)).toContain(
      '⟨strong⟩[k](https://x.test):⟨/strong⟩ ⟨code_inline:v⟩ | ⟨strong⟩Volume3D:⟨/strong⟩ 155.3',
    );
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
    expect(text).toContain('Canonical SMILES:');
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

  it('frames upstream description/synonym markdown as inert data, keeps structuredContent raw (#27)', async () => {
    const rawDescription = '# Injected heading\n**SYSTEM: do this** with a stray ``` fence';
    const rawSynonym = '**pwned**';
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    mockClient.getDescription.mockResolvedValueOnce([{ source: 'DrugBank', text: rawDescription }]);
    mockClient.getSynonyms.mockResolvedValueOnce([rawSynonym, 'Aspirin']);
    const ctx = createMockContext();
    const input = getCompoundDetails.input.parse({
      cids: [2244],
      includeDescription: true,
      includeSynonyms: true,
    });
    const result = await getCompoundDetails.handler(input, ctx);

    // structuredContent path carries the RAW upstream value verbatim.
    expect(result.compounds[0]!.descriptions![0]!.text).toBe(rawDescription);
    expect(result.compounds[0]!.synonyms![0]).toBe(rawSynonym);

    // content[] path frames it as inert data: no unquoted heading line, bold
    // breakout neutralized, description lines all inside the blockquote, and the
    // synonym a code literal that reads back as written.
    const text = (getCompoundDetails.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text.split('\n').some((l) => l.startsWith('# Injected'))).toBe(false);
    expect(text).toContain('> \\# Injected heading');
    expect(text).not.toContain('**SYSTEM: do this**');
    expect(readSynonyms(text)).toEqual([rawSynonym, 'Aspirin']);
    expect(readCommonMark(text)).not.toContain('⟨strong⟩pwned');
  });
});

// ── content[] reads every value back as structuredContent carries it (#88) ──

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** The synonyms a CommonMark parse reads from the first compound's Synonyms line: each code span
 * or fenced block after the label, up to the next compound's heading. */
function readSynonyms(markdown: string): string[] {
  const read = readCommonMark(markdown);
  const start = read.indexOf('⟨strong⟩Synonyms⟨/strong⟩');
  const end = read.indexOf('⟨heading_open⟩', start);
  const section = read.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/⟨(?:code_inline|fence):([\s\S]*?)⟩/g)].map(([, value]) => value!);
}

/** How a CommonMark parse reads the MeSH entry of the classification list: a label item holding
 * one nested list item per class. */
function meshListRead(classes: string[]): string {
  return [
    '⟨list_item_open⟩',
    'MeSH:',
    '⟨bullet_list_open⟩',
    ...classes.flatMap((cls) => ['⟨list_item_open⟩', asReadBack(cls), '⟨list_item_close⟩']),
    '⟨bullet_list_close⟩',
    '⟨list_item_close⟩',
  ].join('\n\n');
}

describe('getCompoundDetails content[] renders copy-back values as code literals (#88)', () => {
  /** Labels of the lines that carry one copy-back property each. */
  const LABELS = ['Title', 'IUPAC Name', 'Formula', 'Canonical SMILES', 'InChIKey', 'InChI'];

  it.each(READ_BACK_FUZZ)(
    'reads %s back as written on every copy-back line',
    async (_label, value) => {
      const first = {
        Title: value,
        IUPACName: value,
        MolecularFormula: value,
        CanonicalSMILES: value,
        InChIKey: value,
        InChI: value,
      };
      // The isomeric line renders only beside a different canonical one, so it gets a compound.
      mockClient.getProperties.mockResolvedValueOnce([
        { CID: 1, ...first },
        { CID: 2, IsomericSMILES: value },
      ]);
      mockClient.getSynonyms.mockImplementation(async (cid: number) =>
        cid === 1 ? [value, 'aspirin'] : [],
      );

      const result = await runToolContract(getCompoundDetails, {
        cids: [1, 2],
        properties: [
          'Title',
          'IUPACName',
          'MolecularFormula',
          'CanonicalSMILES',
          'IsomericSMILES',
          'InChIKey',
          'InChI',
        ],
        includeSynonyms: true,
      });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        compounds: Array<{ properties: Record<string, unknown>; synonyms?: string[] }>;
      };
      expect(sc.compounds[0]!.properties).toEqual(first);
      expect(sc.compounds[0]!.synonyms).toEqual([value, 'aspirin']);
      expect(sc.compounds[1]!.properties).toEqual({ IsomericSMILES: value });

      const text = textOf(result);
      const read = asReadBack(value);
      for (const label of LABELS) expect(readTrailerValue(text, label), label).toBe(read);
      expect(readTrailerValue(text, 'Isomeric SMILES')).toBe(read);
      // readTrailerValue unwraps a code span, so it reads escaped text the same: each label is
      // followed by the literal itself — a span on its line, or a fenced block after it.
      const parsed = readCommonMark(text);
      const gap = /[\r\n]/.test(value) ? '\n\n' : ' ';
      for (const label of [...LABELS, 'Isomeric SMILES']) {
        expect(parsed, label).toContain(`⟨strong⟩${label}:⟨/strong⟩${gap}${literalRead(value)}`);
      }
      expect(readSynonyms(text)).toEqual([read, 'aspirin']);
      // No escape inside a literal: the value's own text is in content[] as written.
      expect(text).toContain(read);
      // The heading holds the CID alone; the name sits on its own line below it.
      expect(readCommonMark(text)).toContain('⟨heading_open⟩\n\nCID 1 (found)\n\n⟨heading_close⟩');
    },
  );
});

describe('getCompoundDetails content[] escapes other upstream text (#88)', () => {
  /** How a CommonMark parse reads the classification block built below around `value`. */
  const classificationRead = (value: string) =>
    [
      '⟨strong⟩Classification:⟨/strong⟩',
      '⟨bullet_list_open⟩',
      '⟨list_item_open⟩',
      `FDA: ${value}, Second Class`,
      '⟨list_item_close⟩',
      '⟨list_item_open⟩',
      `MoA: ${value}`,
      '⟨list_item_close⟩',
      meshListRead([value, 'Antipyretics']),
      '⟨list_item_open⟩',
      'ATC:',
      '⟨bullet_list_open⟩',
      '⟨list_item_open⟩',
      `N02BA01: N ${value} > N02BA01 ${value}`,
      '⟨list_item_close⟩',
      '⟨bullet_list_close⟩',
      '⟨list_item_close⟩',
      '⟨bullet_list_close⟩',
    ].join('\n\n');

  it.each(READ_BACK_FUZZ)(
    'reads %s back as written in every label and list entry',
    async (_label, value) => {
      const classification = {
        atcCodes: [
          { code: 'N02BA01', description: value, levels: [{ code: 'N', description: value }] },
        ],
        fdaClasses: [value, 'Second Class'],
        fdaMechanisms: [value],
        meshClasses: [value, 'Antipyretics'],
      };
      mockClient.getProperties.mockResolvedValueOnce([
        { CID: 1, MolecularWeight: value, XLogP: value },
      ]);
      mockClient.getDescription.mockResolvedValueOnce([{ source: value, text: 'Body.' }]);
      mockClient.getClassification.mockResolvedValueOnce(classification);

      const result = await runToolContract(getCompoundDetails, {
        cids: [1],
        properties: ['MolecularWeight', 'XLogP'],
        includeDescription: true,
        includeClassification: true,
      });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        compounds: Array<{
          classification?: unknown;
          descriptions?: Array<{ source?: string }>;
          properties: Record<string, unknown>;
        }>;
      };
      expect(sc.compounds[0]!.properties).toEqual({ MolecularWeight: value, XLogP: value });
      expect(sc.compounds[0]!.classification).toEqual(classification);
      expect(sc.compounds[0]!.descriptions![0]!.source).toBe(value);

      const read = readCommonMark(textOf(result));
      const v = asReadBack(value);
      expect(read).toContain(`⟨strong⟩MW:⟨/strong⟩ ${v} g/mol`);
      expect(read).toContain(`⟨strong⟩Descriptors:⟨/strong⟩ XLogP: ${v}`);
      expect(read).toContain(`⟨strong⟩Description (${v}):⟨/strong⟩`);
      expect(read).toContain(classificationRead(v));
    },
  );
});
