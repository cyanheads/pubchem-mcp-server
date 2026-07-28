/**
 * @fileoverview Tests for the compound-safety resource.
 * @module mcp-server/resources/definitions/compound-safety.resource.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

    const result = await compoundSafetyResource.handler({ cid: 702 });

    expect(result).toMatchObject({ cid: 702, hasData: true, status: 'ok', source: 'ECHA' });
    expect(result.ghs?.signalWord).toBe('Danger');
  });

  // #34 — the resource spreads the client's precautionary entries straight through, so the
  // decoded discriminator has to reach a raw-JSON reader unchanged.
  it('carries the decoded flag through to the raw JSON payload', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'ok', ghs });

    const result = await compoundSafetyResource.handler({ cid: 702 });

    expect(result.ghs?.precautionaryStatements).toEqual([
      { code: 'P210', statement: 'Keep away from heat', decoded: true },
      { code: 'P501', statement: '', decoded: false },
    ]);
  });

  // #42 — a resource has no notice surface, so `status` is the only thing separating a
  // mistyped CID from a real compound carrying no classification. Both were `hasData: false`.
  it('reports cid_not_found for a CID PubChem has no record for', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'cid_not_found' });

    const result = await compoundSafetyResource.handler({ cid: 999999999 });

    expect(result).toEqual({ cid: 999999999, hasData: false, status: 'cid_not_found' });
  });

  it('reports no_ghs_data for a real compound with no deposited classification', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({ status: 'no_ghs_data' });

    const result = await compoundSafetyResource.handler({ cid: 11979316 });

    expect(result).toEqual({ cid: 11979316, hasData: false, status: 'no_ghs_data' });
  });

  it('gives the two no-data outcomes different payloads', async () => {
    mockClient.getSafetyData
      .mockResolvedValueOnce({ status: 'cid_not_found' })
      .mockResolvedValueOnce({ status: 'no_ghs_data' });

    const unknown = await compoundSafetyResource.handler({ cid: 999999999 });
    const noData = await compoundSafetyResource.handler({ cid: 11979316 });

    expect(unknown.status).not.toBe(noData.status);
  });
});
