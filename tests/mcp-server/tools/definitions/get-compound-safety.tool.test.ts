/**
 * @fileoverview Tests for get-compound-safety tool (batched CIDs).
 * @module mcp-server/tools/definitions/get-compound-safety.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('accepts more than 25 CIDs up to 1000, and rejects 1001 (#70)', () => {
    const cids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(() => getCompoundSafety.input.parse({ cids: cids(26) })).not.toThrow();
    expect(() => getCompoundSafety.input.parse({ cids: cids(1000) })).not.toThrow();
    expect(() => getCompoundSafety.input.parse({ cids: cids(1001) })).toThrow();
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
            classifications: [],
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
            classifications: [],
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('P210: Keep away from heat');
    expect(text).toContain('P241: (not decoded)');
  });

  it('renders a classification with no named source or signal word without inventing either', () => {
    const blocks = getCompoundSafety.format!({
      results: [
        {
          cid: 1,
          hasData: true,
          status: 'ok',
          ghs: {
            pictograms: [],
            hazardStatements: [{ code: 'H401', statement: 'Toxic to aquatic life' }],
            precautionaryStatements: [],
            classifications: [{ pictograms: [], hazardCodes: [{ code: 'H401' }] }],
          },
        },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('**Classifications by source (1):**');
    expect(text).toContain('  - Source not named: H401');
    expect(text).not.toContain('Danger');
    expect(text).not.toContain('Warning');
  });
});

// ── Real parser over captured PubChem records ─────────────────────────

const FIXTURES = new URL('../../../fixtures/', import.meta.url);

/** Serves the captured PUG View GHS records; the two fault CIDs answer as PUG View does. */
async function pugView(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const cid = url.pathname.match(/^\/rest\/pug_view\/data\/compound\/(\d+)\/JSON$/)?.[1];
  if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov' || !cid) throw new Error('unmocked fetch');
  const json = { 'Content-Type': 'application/json' };
  if (cid === '11979316' || cid === '999999999') {
    const message = cid === '11979316' ? 'No data found' : 'No record found';
    return new Response(JSON.stringify({ Fault: { Code: 'PUGVIEW.NotFound', Message: message } }), {
      status: 404,
      headers: json,
    });
  }
  return new Response(readFileSync(new URL(`ghs-${cid}.json`, FIXTURES), 'utf8'), {
    status: 200,
    headers: json,
  });
}

type SafetyResult = {
  cid: number;
  hasData: boolean;
  status: string;
  source?: string;
  ghs?: {
    signalWord?: string;
    pictograms: string[];
    hazardStatements: Array<{ code: string }>;
    classifications: Array<{
      source?: string;
      sourceRecord?: string;
      signalWord?: string;
      hazardCodes: Array<{ code: string; agreement?: string }>;
      notClassified?: boolean;
      notifications?: string;
    }>;
  };
};

describe('getCompoundSafety over captured PubChem records', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/services/pubchem/pubchem-client.js')>(
      '@/services/pubchem/pubchem-client.js',
    );
    const client = new actual.PubChemClient();
    mockClient.getSafetyData.mockImplementation((cid: number, signal?: AbortSignal) =>
      client.getSafetyData(cid, signal),
    );
    fetchMock.mockReset();
    fetchMock.mockImplementation(pugView);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #63 — every source used to be merged into one label credited to Record.Reference[0].
  it('returns per-source classifications and contributor attribution on both surfaces', async () => {
    const result = await runToolContract(getCompoundSafety, { cids: [702, 2244] });

    expect(result.isError).toBeFalsy();
    const [ethanol, aspirin] = (result.structuredContent as { results: SafetyResult[] }).results;
    expect(ethanol!.ghs!.classifications).toHaveLength(11);
    expect(ethanol!.ghs!.classifications[0]).toMatchObject({
      source: 'Regulation (EC) No 1272/2008 of the European Parliament and of the Council',
      hazardCodes: [{ code: 'H225' }],
    });
    expect(ethanol!.ghs!.classifications[1]!.hazardCodes).toEqual([
      { code: 'H225', agreement: '> 99.9%' },
      { code: 'H319', agreement: '37.7%' },
    ]);
    expect(ethanol!.source).toBe(
      'Regulation (EC) No 1272/2008 of the European Parliament and of the Council; European Chemicals Agency (ECHA); NITE-CMC; Hazardous Chemical Information System (HCIS), Safe Work Australia; Hazardous Substances Data Bank (HSDB)',
    );
    expect(aspirin!.ghs!.signalWord).toBe('Danger');
    expect(aspirin!.ghs!.classifications[0]).toMatchObject({
      source: 'European Chemicals Agency (ECHA)',
      signalWord: 'Warning',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('**Classifications by source (11):**');
    expect(text).toContain(
      '  - European Chemicals Agency (ECHA) — Ethanol (EC: 200-578-6): Danger · Flammable, Irritant · H225 (> 99.9%), H319 (37.7%) · Aggregated GHS information provided per 13886 reports by companies from 79 notifications to the ECHA C&L Inventory. Each notification may be associated with multiple companies.',
    );
    expect(text).toMatch(
      /NITE-CMC — Ethanol - FY2013 \(Revised classification\): Danger · [^\n]*H350/,
    );
    expect(text).toContain('*Source: Regulation (EC) No 1272/2008');
    expect(text).not.toContain('Australian Industrial Chemicals Introduction Scheme');
  });

  // #71 — notifier "Not Classified" verdicts used to read as no deposited classification.
  it('reports ECHA "Not Classified" verdicts as not_classified, apart from the two absences', async () => {
    const result = await runToolContract(getCompoundSafety, {
      cids: [135398658, 5793, 11979316, 999999999],
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: SafetyResult[];
      withDataCount: number;
      notice?: string;
    };
    expect(structured.results.map((r) => [r.status, r.hasData])).toEqual([
      ['not_classified', true],
      ['not_classified', true],
      ['no_ghs_data', false],
      ['cid_not_found', false],
    ]);
    const folic = structured.results[0]!;
    expect(folic.ghs!.classifications).toEqual([
      {
        source: 'European Chemicals Agency (ECHA)',
        sourceRecord: 'Folic acid (EC: 200-419-0)',
        pictograms: [],
        hazardCodes: [],
        notClassified: true,
        notifications:
          'Reported as not meeting GHS hazard criteria by 188 of 203 companies (only 7.4% companies provided GHS information).',
      },
    ]);
    expect(folic.ghs!.hazardStatements).toEqual([]);
    expect(folic.ghs!.signalWord).toBeUndefined();
    expect(structured.results[1]!.ghs!.classifications.every((c) => c.notClassified)).toBe(true);
    expect(structured.withDataCount).toBe(2);
    expect(structured.notice).toContain(
      'Not classified under GHS for 2 of 4 CID(s): 135398658, 5793.',
    );
    expect(structured.notice).toContain(
      'No GHS classification on file for 1 of 4 CID(s): 11979316.',
    );
    expect(structured.notice).toContain('no record for 1 of 4 CID(s): 999999999');

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('## GHS Safety Data — CID 135398658');
    expect(text).toContain(
      '**Status:** not_classified — every deposited classification is an ECHA "Not Classified" verdict',
    );
    expect(text).toContain(
      '  - European Chemicals Agency (ECHA) — Folic acid (EC: 200-419-0): Not Classified · Reported as not meeting GHS hazard criteria by 188 of 203 companies (only 7.4% companies provided GHS information).',
    );
    expect(text).not.toContain('CID 135398658 — no GHS safety data');
    expect(text).toContain('## CID 11979316 — no GHS safety data');
    expect(text).toContain('## CID 999999999 — no PubChem record');
  });
});
