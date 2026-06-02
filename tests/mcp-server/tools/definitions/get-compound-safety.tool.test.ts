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
  precautionaryStatements: [{ code: 'P210', statement: 'Keep away from heat' }],
  source: 'European Chemicals Agency',
};

describe('getCompoundSafety handler — batch', () => {
  it('returns one result per CID, preserving input order', async () => {
    mockClient.getSafetyData.mockImplementation(async (cid: number) => (cid === 702 ? ghs : null));
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [702, 999999] });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ cid: 702, hasData: true });
    expect(result.results[0]!.ghs?.signalWord).toBe('Danger');
    expect(result.results[0]!.source).toBe('European Chemicals Agency');
    expect(result.results[1]).toEqual({ cid: 999999, hasData: false });
  });

  it('fans out one getSafetyData call per CID', async () => {
    mockClient.getSafetyData.mockResolvedValue(ghs);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [1, 2, 3] });
    await getCompoundSafety.handler(input, ctx);

    expect(mockClient.getSafetyData).toHaveBeenCalledTimes(3);
  });
});

describe('getCompoundSafety handler — enrichment', () => {
  it('counts requested vs with-data and notices the missing CIDs', async () => {
    mockClient.getSafetyData.mockImplementation(async (cid: number) => (cid === 702 ? ghs : null));
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cids: [702, 999999] });
    await getCompoundSafety.handler(input, ctx);
    const e = getEnrichment(ctx);

    expect(e.requestedCount).toBe(2);
    expect(e.withDataCount).toBe(1);
    expect(e.notice).toContain('999999');
    expect(e.notice).toContain('pubchem_get_compound_details');
  });

  it('adds no notice when every CID has data', async () => {
    mockClient.getSafetyData.mockResolvedValue(ghs);
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
          ghs: {
            signalWord: 'Danger',
            pictograms: ['Flammable'],
            hazardStatements: [{ code: 'H225', statement: 'Highly flammable' }],
            precautionaryStatements: [{ code: 'P210', statement: 'Keep away' }],
          },
          source: 'ECHA',
        },
        { cid: 999, hasData: false },
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
});
