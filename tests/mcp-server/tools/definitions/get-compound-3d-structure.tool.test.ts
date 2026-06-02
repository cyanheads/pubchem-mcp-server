/**
 * @fileoverview Tests for get-compound-3d-structure tool.
 * @module mcp-server/tools/definitions/get-compound-3d-structure.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompound3dStructure } from '@/mcp-server/tools/definitions/get-compound-3d-structure.tool.js';

const mockClient = {
  getSdf3d: vi.fn(),
  getConformerIds: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const f4 = (n: number) => n.toFixed(4).padStart(10);
const atomLine = (x: number, y: number, z: number, el: string) =>
  `${f4(x)}${f4(y)}${f4(z)} ${el.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
const bondLine = (a1: number, a2: number, order: number) =>
  `${String(a1).padStart(3)}${String(a2).padStart(3)}${String(order).padStart(3)}  0  0  0  0`;

const SDF = [
  '2244',
  '  -OEChem-fixture',
  '',
  '  3  2  0     0  0  0  0  0  0999 V2000',
  atomLine(1, 2, 3, 'O'),
  atomLine(0, 0, 0, 'C'),
  atomLine(-1, 1, 0, 'N'),
  bondLine(1, 2, 2),
  bondLine(2, 3, 1),
  'M  END',
  '$$$$',
].join('\n');

describe('getCompound3dStructure handler', () => {
  it('format=json returns parsed atoms and bonds, omits sdf, no conformer call', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    const ctx = createMockContext();
    const input = getCompound3dStructure.input.parse({ cid: 2244, format: 'json' });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.atomCount).toBe(3);
    expect(result.bondCount).toBe(2);
    expect(result.atoms).toHaveLength(3);
    expect(result.bonds).toHaveLength(2);
    expect(result.atoms?.[0]).toEqual({ element: 'O', x: 1, y: 2, z: 3 });
    expect(result.sdf).toBeUndefined();
    expect(mockClient.getConformerIds).not.toHaveBeenCalled();
  });

  it('format=sdf returns raw text and counts, omits parsed atoms/bonds', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    const ctx = createMockContext();
    const input = getCompound3dStructure.input.parse({ cid: 2244, format: 'sdf' });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.sdf).toBe(SDF);
    expect(result.atoms).toBeUndefined();
    expect(result.bonds).toBeUndefined();
    expect(result.atomCount).toBe(3);
  });

  it('includeAlternateConformerIds sets conformerId and alternates', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    mockClient.getConformerIds.mockResolvedValueOnce(['A', 'B', 'C']);
    const ctx = createMockContext();
    const input = getCompound3dStructure.input.parse({
      cid: 2244,
      includeAlternateConformerIds: true,
    });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.conformerId).toBe('A');
    expect(result.alternateConformerIds).toEqual(['B', 'C']);
  });

  it('propagates a not-found thrown by the service', async () => {
    mockClient.getSdf3d.mockRejectedValueOnce(new Error('No 3D conformer available for CID 1.'));
    const ctx = createMockContext();
    const input = getCompound3dStructure.input.parse({ cid: 1 });

    await expect(getCompound3dStructure.handler(input, ctx)).rejects.toThrow('No 3D conformer');
  });
});

describe('getCompound3dStructure format', () => {
  it('renders counts and atoms for json output', () => {
    const blocks = getCompound3dStructure.format!({
      cid: 2244,
      atomCount: 1,
      bondCount: 0,
      atoms: [{ element: 'O', x: 1, y: 2, z: 3 }],
      bonds: [],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;

    expect(text).toContain('CID 2244');
    expect(text).toContain('Atoms: 1');
    expect(text).toContain('O: 1, 2, 3');
  });

  it('renders the raw SDF block for sdf output', () => {
    const blocks = getCompound3dStructure.format!({
      cid: 2244,
      atomCount: 0,
      bondCount: 0,
      sdf: 'RAWSDFBODY',
    });
    expect((blocks[0]! as { type: 'text'; text: string }).text).toContain('RAWSDFBODY');
  });
});
