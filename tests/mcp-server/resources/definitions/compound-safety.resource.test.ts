/**
 * @fileoverview Tests for the compound-safety resource.
 * @module mcp-server/resources/definitions/compound-safety.resource.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compoundSafetyResource } from '@/mcp-server/resources/definitions/compound-safety.resource.js';

const mockClient = {
  getSafetyData: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * The resource declares no `output` schema, so `handler` types as `unknown`. This is the
 * payload it actually returns — kept next to the assertions that read it.
 */
type SafetyPayload = {
  cid: number;
  hasData: boolean;
  status: string;
  source?: string;
  ghs?: {
    signalWord: string;
    pictograms: string[];
    hazardStatements: { code: string; statement: string }[];
    precautionaryStatements: { code: string; statement: string; decoded: boolean }[];
  };
};

const readSafety = async (cid: number): Promise<SafetyPayload> =>
  (await compoundSafetyResource.handler({ cid }, createMockContext())) as SafetyPayload;

const ghs = {
  signalWord: 'Danger',
  pictograms: ['Flammable'],
  hazardStatements: [{ code: 'H225', statement: 'Highly flammable liquid and vapour' }],
  precautionaryStatements: [
    { code: 'P210', statement: 'Keep away from heat', decoded: true },
    { code: 'P501', statement: '', decoded: false },
  ],
  source: 'ECHA',
};

describe('compoundSafetyResource handler', () => {
  it('returns GHS data for a compound that has it', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'ok', ghs });

    const result = await readSafety(702);

    expect(result).toMatchObject({ cid: 702, hasData: true, status: 'ok', source: 'ECHA' });
    expect(result.ghs?.signalWord).toBe('Danger');
  });

  // #34 — the resource spreads the client's precautionary entries straight through, so the
  // decoded discriminator has to reach a raw-JSON reader unchanged.
  it('carries the decoded flag through to the raw JSON payload', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'ok', ghs });

    const result = await readSafety(702);

    expect(result.ghs?.precautionaryStatements).toEqual([
      { code: 'P210', statement: 'Keep away from heat', decoded: true },
      { code: 'P501', statement: '', decoded: false },
    ]);
  });

  // #42 — a resource has no notice surface, so `status` is the only thing separating a
  // mistyped CID from a real compound carrying no classification. Both were `hasData: false`.
  it('reports cid_not_found for a CID PubChem has no record for', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'cid_not_found' });

    const result = await readSafety(999999999);

    expect(result).toEqual({ cid: 999999999, hasData: false, status: 'cid_not_found' });
  });

  it('reports no_ghs_data for a real compound with no deposited classification', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'no_ghs_data' });

    const result = await readSafety(11979316);

    expect(result).toEqual({ cid: 11979316, hasData: false, status: 'no_ghs_data' });
  });

  it('gives the two no-data outcomes different payloads', async () => {
    mockClient.getSafetyData
      .mockResolvedValueOnce({ status: 'cid_not_found' })
      .mockResolvedValueOnce({ status: 'no_ghs_data' });

    const unknown = await readSafety(999999999);
    const noData = await readSafety(11979316);

    expect(unknown.status).not.toBe(noData.status);
  });
});

describe('compoundSafetyResource over captured PubChem records', () => {
  const fixtures = new URL('../../../fixtures/', import.meta.url);
  const fetchMock = vi.fn<typeof fetch>();

  type Classified = SafetyPayload & {
    ghs?: { classifications: Array<{ source?: string; notClassified?: boolean }> };
  };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/services/pubchem/pubchem-client.js')>(
      '@/services/pubchem/pubchem-client.js',
    );
    const client = new actual.PubChemClient();
    mockClient.getSafetyData.mockImplementation((cid: number, signal?: AbortSignal) =>
      client.getSafetyData(cid, signal),
    );
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const cid = url.pathname.match(/^\/rest\/pug_view\/data\/compound\/(\d+)\/JSON$/)?.[1];
      if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov' || !cid) throw new Error('unmocked fetch');
      return new Response(readFileSync(new URL(`ghs-${cid}.json`, fixtures), 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #63 — the resource shares the parser, so it carried the same merged label and misattribution.
  it('carries per-source classifications and the contributor source', async () => {
    const result = (await readSafety(8929)) as Classified;

    expect(result.status).toBe('ok');
    expect(result.ghs?.classifications.map((c) => c.source)).toEqual([
      'European Chemicals Agency (ECHA)',
      'NITE-CMC',
      'Hazardous Chemical Information System (HCIS), Safe Work Australia',
    ]);
    expect(result.source).toBe(
      'European Chemicals Agency (ECHA); NITE-CMC; Hazardous Chemical Information System (HCIS), Safe Work Australia',
    );
  });

  // #71 — notifier verdicts are a classification, not an absence.
  it('reports not_classified with the verdicts for D-glucose', async () => {
    const result = (await readSafety(5793)) as Classified;

    expect(result).toMatchObject({ cid: 5793, hasData: true, status: 'not_classified' });
    expect(result.ghs?.classifications).toHaveLength(3);
    expect(result.ghs?.classifications.every((c) => c.notClassified === true)).toBe(true);
    expect(result.source).toBe('European Chemicals Agency (ECHA)');
  });
});
