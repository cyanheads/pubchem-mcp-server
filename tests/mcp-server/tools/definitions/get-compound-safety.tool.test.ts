/**
 * @fileoverview Tests for get-compound-safety tool.
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

describe('getCompoundSafety handler', () => {
  it('returns GHS data when available', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({
      signalWord: 'Danger',
      pictograms: ['Flammable', 'Irritant'],
      hazardStatements: [{ code: 'H225', statement: 'Highly flammable liquid and vapour' }],
      precautionaryStatements: [{ code: 'P210', statement: 'Keep away from heat' }],
      source: 'European Chemicals Agency',
    });
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 702 });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.cid).toBe(702);
    expect(result.hasData).toBe(true);
    expect(result.ghs?.signalWord).toBe('Danger');
    expect(result.ghs?.pictograms).toEqual(['Flammable', 'Irritant']);
    expect(result.ghs?.hazardStatements).toHaveLength(1);
    expect(result.ghs?.precautionaryStatements).toHaveLength(1);
    expect(result.source).toBe('European Chemicals Agency');
  });

  it('returns hasData false when no safety data', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 999999 });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.cid).toBe(999999);
    expect(result.hasData).toBe(false);
    expect(result.ghs).toBeUndefined();
  });
});

describe('getCompoundSafety handler — enrichment', () => {
  it('adds a cross-tool notice when no GHS data is available', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 999999 });
    await getCompoundSafety.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('pubchem_get_compound_details');
  });

  it('does not add a notice when GHS data is present', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({
      signalWord: 'Danger',
      pictograms: ['Flammable'],
      hazardStatements: [{ code: 'H225', statement: 'Highly flammable liquid and vapour' }],
      precautionaryStatements: [],
    });
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 702 });
    await getCompoundSafety.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeUndefined();
  });
});

describe('getCompoundSafety format', () => {
  it('formats GHS data', () => {
    const blocks = getCompoundSafety.format!({
      cid: 702,
      hasData: true,
      ghs: {
        signalWord: 'Danger',
        pictograms: ['Flammable'],
        hazardStatements: [{ code: 'H225', statement: 'Highly flammable liquid and vapour' }],
        precautionaryStatements: [{ code: 'P210', statement: 'Keep away from heat' }],
      },
      source: 'ECHA',
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('GHS Safety');
    expect(text).toContain('Danger');
    expect(text).toContain('Flammable');
    expect(text).toContain('H225');
    expect(text).toContain('P210');
    expect(text).toContain('ECHA');
  });

  it('formats no-data response', () => {
    const blocks = getCompoundSafety.format!({
      cid: 999,
      hasData: false,
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('No GHS safety data');
  });
});
