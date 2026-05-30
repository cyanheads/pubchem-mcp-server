/**
 * @fileoverview Extended tests for get-compound-safety tool — edge cases and validation.
 * @module mcp-server/tools/definitions/get-compound-safety-extended.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('getCompoundSafety handler — input validation', () => {
  it('rejects CID of 0', () => {
    expect(() => getCompoundSafety.input.parse({ cid: 0 })).toThrow();
  });

  it('rejects negative CID', () => {
    expect(() => getCompoundSafety.input.parse({ cid: -5 })).toThrow();
  });

  it('rejects non-integer CID', () => {
    expect(() => getCompoundSafety.input.parse({ cid: 1.5 })).toThrow();
  });
});

describe('getCompoundSafety handler — output shape', () => {
  it('returns minimal hasData=false shape for compounds without safety data', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce(null);
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 241 });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result).toEqual({ cid: 241, hasData: false });
    expect(result.ghs).toBeUndefined();
    expect(result.source).toBeUndefined();
  });

  it('returns all GHS fields when present', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({
      signalWord: 'Warning',
      pictograms: ['Irritant'],
      hazardStatements: [{ code: 'H315', statement: 'Causes skin irritation' }],
      precautionaryStatements: [{ code: 'P264', statement: 'Wash hands thoroughly' }],
      source: 'ECHA',
    });
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 5234 });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.hasData).toBe(true);
    expect(result.ghs!.signalWord).toBe('Warning');
    expect(result.ghs!.pictograms).toEqual(['Irritant']);
    expect(result.ghs!.hazardStatements).toHaveLength(1);
    expect(result.ghs!.precautionaryStatements).toHaveLength(1);
    expect(result.source).toBe('ECHA');
  });

  it('returns GHS data without signal word when absent', async () => {
    mockClient.getSafetyData.mockResolvedValueOnce({
      pictograms: ['Flammable'],
      hazardStatements: [{ code: 'H225', statement: 'Highly flammable' }],
      precautionaryStatements: [],
      // signalWord intentionally absent
    });
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 702 });
    const result = await getCompoundSafety.handler(input, ctx);

    expect(result.hasData).toBe(true);
    expect(result.ghs!.signalWord).toBeUndefined();
    expect(result.ghs!.pictograms).toEqual(['Flammable']);
  });

  it('propagates upstream errors', async () => {
    mockClient.getSafetyData.mockRejectedValueOnce(new Error('Network error'));
    const ctx = createMockContext();
    const input = getCompoundSafety.input.parse({ cid: 1 });

    await expect(getCompoundSafety.handler(input, ctx)).rejects.toThrow('Network error');
  });
});

describe('getCompoundSafety format — additional cases', () => {
  it('shows source attribution when present', () => {
    const blocks = getCompoundSafety.format!({
      cid: 702,
      hasData: true,
      ghs: {
        signalWord: 'Danger',
        pictograms: ['Flammable'],
        hazardStatements: [],
        precautionaryStatements: [],
      },
      source: 'European Chemicals Agency',
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('European Chemicals Agency');
  });

  it('handles empty hazard and precautionary statement arrays', () => {
    const blocks = getCompoundSafety.format!({
      cid: 702,
      hasData: true,
      ghs: {
        signalWord: 'Warning',
        pictograms: ['Irritant'],
        hazardStatements: [],
        precautionaryStatements: [],
      },
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Warning');
    expect(text).toContain('Irritant');
    // No statements sections shown when empty
    expect(text).not.toContain('Hazard Statements:');
    expect(text).not.toContain('Precautionary Statements:');
  });

  it('renders multiple hazard codes correctly', () => {
    const blocks = getCompoundSafety.format!({
      cid: 1,
      hasData: true,
      ghs: {
        pictograms: [],
        hazardStatements: [
          { code: 'H225', statement: 'Highly flammable liquid and vapour' },
          { code: 'H302', statement: 'Harmful if swallowed' },
          { code: 'H315', statement: 'Causes skin irritation' },
        ],
        precautionaryStatements: [],
      },
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('H225');
    expect(text).toContain('H302');
    expect(text).toContain('H315');
  });

  it('formats no-data for CID clearly', () => {
    const blocks = getCompoundSafety.format!({ cid: 12345, hasData: false });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('12345');
    expect(text).toContain('No GHS safety data');
  });
});
