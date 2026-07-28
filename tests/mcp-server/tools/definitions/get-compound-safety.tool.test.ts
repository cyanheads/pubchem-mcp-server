/**
 * @fileoverview Tests for get-compound-safety tool (batched CIDs).
 * @module mcp-server/tools/definitions/get-compound-safety.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundSafety } from '@/mcp-server/tools/definitions/get-compound-safety.tool.js';

const mockClient = {
  getSafetyData: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const ghs = {
  signalWord: 'Danger',
  pictograms: ['Flammable', 'Irritant'],
  hazardStatements: [{ code: 'H225', statement: 'Highly flammable liquid and vapour' }],
  precautionaryStatements: [{ code: 'P210', statement: 'Keep away from heat', decoded: true }],
  source: 'European Chemicals Agency',
};

const found = { status: 'ok' as const, ghs };
const noData = { status: 'no_ghs_data' as const };
const notFound = { status: 'cid_not_found' as const };

describe('getCompoundSafety handler — batch', () => {
  it('returns one result per CID, preserving input order', async () => {
    mockClient.getSafetyData.mockImplementation(async (cid: number) =>
      cid === 702 ? found : noData,
    );
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [702, 999999] });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ cid: 702, hasData: true, status: 'ok' });
    expect(result.results[0]!.ghs?.signalWord).toBe('Danger');
    expect(result.results[0]!.source).toBe('European Chemicals Agency');
    expect(result.results[1]).toEqual({ cid: 999999, hasData: false, status: 'no_ghs_data' });
  });

  it('fans out one getSafetyData call per CID', async () => {
    mockClient.getSafetyData.mockResolvedValue(found);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [1, 2, 3] });
    await getCompoundSafety.handler(input, ctx);

    expect(mockClient.getSafetyData).toHaveBeenCalledTimes(3);
  });

  // #42 — a nonexistent CID and a real compound with no classification both used to surface
  // as hasData:false with nothing to tell them apart.
  it('separates a nonexistent CID from a compound with no GHS data in structuredContent', async () => {
    mockClient.getSafetyData.mockImplementation(async (cid: number) => {
      if (cid === 702) return found;
      if (cid === 11979316) return noData;
      return notFound;
    });
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [702, 11979316, 999999999] });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.results.map((r) => r.status)).toEqual(['ok', 'no_ghs_data', 'cid_not_found']);
    // Both non-ok rows still report hasData:false — the discriminator is `status`, and the
    // two rows must not be interchangeable.
    expect(result.results[1]).toEqual({ cid: 11979316, hasData: false, status: 'no_ghs_data' });
    expect(result.results[2]).toEqual({ cid: 999999999, hasData: false, status: 'cid_not_found' });
  });
});

describe('getCompoundSafety handler — enrichment', () => {
  it('counts requested vs with-data and notices the missing CIDs', async () => {
    mockClient.getSafetyData.mockImplementation(async (cid: number) =>
      cid === 702 ? found : noData,
    );
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [702, 999999] });
    await getCompoundSafety.handler(input, ctx);
    const e = getEnrichment(ctx);

    expect(e.requestedCount).toBe(2);
    expect(e.withDataCount).toBe(1);
    expect(e.notice).toContain('999999');
    expect(e.notice).toContain('pubchem_get_compound_details');
  });

  // #42 — the old notice offered only "may simply lack deposited safety data", so a typo'd
  // CID read as a confident statement about a compound.
  it('leads the notice with CID verification when a CID has no PubChem record', async () => {
    mockClient.getSafetyData.mockResolvedValue(notFound);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [999999999] });
    await getCompoundSafety.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('999999999');
    expect(notice).toContain('pubchem_search_compounds');
    expect(notice).toContain('no record');
    // Must not tell the caller the compound simply lacks safety data — it has no record.
    expect(notice).not.toContain('No GHS classification on file');
  });

  it('names CID verification before the no-data guidance in a mixed batch', async () => {
    mockClient.getSafetyData.mockImplementation(async (cid: number) =>
      cid === 11979316 ? noData : notFound,
    );
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [11979316, 999999999] });
    await getCompoundSafety.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;

    expect(notice).toContain('pubchem_search_compounds');
    expect(notice).toContain('pubchem_get_compound_details');
    // Verification guidance leads; the no-data guidance follows.
    expect(notice.indexOf('pubchem_search_compounds')).toBeLessThan(
      notice.indexOf('pubchem_get_compound_details'),
    );
    // Each CID is attributed to its own case, not lumped into one list.
    expect(notice).toMatch(/no record for 1 of 2 CID\(s\): 999999999/);
    expect(notice).toMatch(/No GHS classification on file for 1 of 2 CID\(s\): 11979316/);
  });

  it('adds no notice when every CID has data', async () => {
    mockClient.getSafetyData.mockResolvedValue(found);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [702] });
    await getCompoundSafety.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});

describe('getCompoundSafety input validation', () => {
  it('rejects an empty cids array', () => {
    expect(() => getCompoundSafety.input.parse({ cids: [] })).toThrow();
  });

  it('rejects more than 25 CIDs', () => {
    expect(() =>
      getCompoundSafety.input.parse({ cids: Array.from({ length: 26 }, (_, i) => i + 1) }),
    ).toThrow();
  });

  it('rejects a non-positive CID', () => {
    expect(() => getCompoundSafety.input.parse({ cids: [0] })).toThrow();
  });
});

describe('getCompoundSafety format', () => {
  it('renders a per-CID GHS block and a no-data block', () => {
    const blocks = getCompoundSafety.format!({
      results: [
        {
          cid: 702,
          hasData: true,
          status: 'ok',
          ghs: {
            signalWord: 'Danger',
            pictograms: ['Flammable'],
            hazardStatements: [{ code: 'H225', statement: 'Highly flammable' }],
            precautionaryStatements: [{ code: 'P210', statement: 'Keep away', decoded: true }],
          },
          source: 'ECHA',
        },
        { cid: 999, hasData: false, status: 'no_ghs_data' },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('CID 702');
    expect(text).toContain('Danger');
    expect(text).toContain('Flammable');
    expect(text).toContain('H225');
    expect(text).toContain('P210');
    expect(text).toContain('ECHA');
    expect(text).toContain('CID 999 — no GHS safety data');
  });

  // #42 — content[]-only clients (Claude Desktop and friends) never see structuredContent, so
  // the distinction has to survive into the rendered markdown too.
  it('distinguishes a nonexistent CID from a no-data compound in the rendered text', () => {
    const blocks = getCompoundSafety.format!({
      results: [
        { cid: 11979316, hasData: false, status: 'no_ghs_data' },
        { cid: 999999999, hasData: false, status: 'cid_not_found' },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('## CID 11979316 — no GHS safety data');
    expect(text).toContain('no_ghs_data — the compound exists in PubChem');
    expect(text).toContain('## CID 999999999 — no PubChem record');
    expect(text).toContain('cid_not_found — PubChem has no compound with this CID');
    expect(text).toContain('pubchem_search_compounds');
  });

  // #34 — an undecoded P-code used to render as a bare code, indistinguishable from a decoded
  // one whose text happened to be empty.
  it('marks an undecoded P-code rather than rendering it as a bare code', () => {
    const blocks = getCompoundSafety.format!({
      results: [
        {
          cid: 702,
          hasData: true,
          status: 'ok',
          ghs: {
            pictograms: [],
            hazardStatements: [],
            precautionaryStatements: [
              { code: 'P210', statement: 'Keep away from heat', decoded: true },
              { code: 'P241', statement: '', decoded: false },
            ],
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('P210: Keep away from heat');
    expect(text).toContain('P241: (not decoded)');
  });
});
