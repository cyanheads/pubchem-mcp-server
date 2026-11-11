/**
 * @fileoverview Tests for get-compound-3d-structure tool.
 * @module mcp-server/tools/definitions/get-compound-3d-structure.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompound3dStructure } from '@/mcp-server/tools/definitions/get-compound-3d-structure.tool.js';
import { readCommonMark } from '../../../helpers/commonmark.js';
import {
  asReadBack,
  formatBlock,
  ONE_LINE_FUZZ,
  READ_BACK_FUZZ,
} from '../../../helpers/read-back.js';

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
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
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
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
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
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
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
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({ cid: 1 });

    await expect(getCompound3dStructure.handler(input, ctx)).rejects.toThrow('No 3D conformer');
  });

  it('fills the declared no_3d_structure recovery hint onto the error envelope', async () => {
    mockClient.getSdf3d.mockRejectedValueOnce(
      notFound('No 3D conformer available for CID 1.', { cid: 1, reason: 'no_3d_structure' }),
    );

    const result = await runToolContract(getCompound3dStructure, { cid: 1 });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('no_3d_structure');
    expect(error.data?.recovery?.hint).toContain('pubchem_get_compound_image');
    expect(error.data?.recovery?.hint).toContain('pubchem_search_compounds');
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

  it('wraps the SDF in an injection-safe fence so a stray ``` cannot break out (#27)', () => {
    const blocks = getCompound3dStructure.format!({
      cid: 2244,
      atomCount: 0,
      bondCount: 0,
      sdf: 'header\n```\nmalicious markdown',
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    // The fence is lengthened past the 3-backtick run in the payload.
    expect(text).toContain('````');
    // Content is preserved verbatim inside the fence.
    expect(text).toContain('header\n```\nmalicious markdown');
  });
});

// ── Upstream text reads back as structuredContent carries it (#88) ────

const SENTINEL = 'SENTINEL';

describe('getCompound3dStructure renders upstream text as itself (#88)', () => {
  it.each(READ_BACK_FUZZ)('reads an element holding %s back, adding no construct', (_l, value) => {
    const render = (element: string) =>
      (
        getCompound3dStructure.format!({
          cid: 2244,
          atomCount: 2,
          bondCount: 0,
          atoms: [
            { element, x: 1, y: 2, z: 3 },
            { element: 'C', x: 0, y: 0, z: 0 },
          ],
        })[0] as { type: 'text'; text: string }
      ).text;

    expect(readCommonMark(render(value))).toBe(
      readCommonMark(render(SENTINEL)).replaceAll(SENTINEL, () => asReadBack(value)),
    );
  });

  /** The tool's content[] with conformer IDs `ids`, after asserting structuredContent holds them. */
  async function renderConformers(ids: string[]) {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    mockClient.getConformerIds.mockResolvedValueOnce(ids);
    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      includeAlternateConformerIds: true,
    });
    expect(result.structuredContent).toMatchObject({
      conformerId: ids[0],
      alternateConformerIds: ids.slice(1),
    });
    return formatBlock(result);
  }

  it.each(ONE_LINE_FUZZ)(
    'renders conformer IDs holding %s verbatim in code spans',
    async (_label, value) => {
      const baselineRead = readCommonMark(await renderConformers([SENTINEL, SENTINEL]));
      const text = await renderConformers([value, value]);

      expect(baselineRead).toContain(`Default conformer: ⟨code_inline:${SENTINEL}⟩`);
      expect(baselineRead).toContain(`Alternate conformers: ⟨code_inline:${SENTINEL}⟩`);
      expect(readCommonMark(text)).toBe(baselineRead.replaceAll(SENTINEL, () => value));
      expect(text).toContain(value);
    },
  );

  it('fences a conformer ID holding a line break on lines of its own', async () => {
    const read = readCommonMark(await renderConformers(['x\r\n# INJECTED', 'x\r\n# INJECTED']));

    expect(read.split('⟨fence:x\n# INJECTED⟩')).toHaveLength(3);
    expect(read.split('⟨heading_open⟩')).toHaveLength(2);
  });

  /** The SDF block's text as content[] carries it, after the call returns `sdf` as sent. */
  async function readSdfBlock(sdf: string) {
    mockClient.getSdf3d.mockResolvedValueOnce(sdf);
    const result = await runToolContract(getCompound3dStructure, { cid: 2244, format: 'sdf' });
    expect((result.structuredContent as { sdf: string }).sdf).toBe(sdf);
    return readCommonMark(formatBlock(result)).match(/⟨fence:([\s\S]*)⟩/)?.[1];
  }

  it('reads an SDF record back byte for byte, its final newline included', async () => {
    expect(await readSdfBlock(`${SDF}\n`)).toBe(`${SDF}\n`);
  });

  it('reads an SDF record without a final newline back as sent', async () => {
    expect(await readSdfBlock(SDF)).toBe(SDF);
  });
});

// A 3-header + counts + 600 atom lines + terminators SDF: > DEFAULT_SDF_LINE_CAP (500).
const bigSdf = [
  'big',
  '  -OEChem-fixture',
  '',
  '600  0  0     0  0  0  0  0  0999 V2000',
  ...Array.from({ length: 600 }, () => atomLine(0, 0, 0, 'C')),
  'M  END',
  '$$$$',
].join('\n');

describe('getCompound3dStructure — output controls (#28)', () => {
  it('default output is full for a small compound — no caps hit, no truncation disclosure', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({ cid: 2244 });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.atoms).toHaveLength(3);
    expect(result.bonds).toHaveLength(2);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('caps atoms and bonds, discloses truncation, and preserves the totals', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({ cid: 2244, maxAtoms: 2, maxBonds: 1 });
    const result = await getCompound3dStructure.handler(input, ctx);

    // Preview is bounded...
    expect(result.atoms).toHaveLength(2);
    expect(result.bonds).toHaveLength(1);
    // ...but atomCount/bondCount still report the full totals.
    expect(result.atomCount).toBe(3);
    expect(result.bondCount).toBe(2);

    const e = getEnrichment(ctx);
    expect(e.truncated).toBe(true);
    expect(e.shownAtoms).toBe(2);
    expect(e.shownBonds).toBe(1);
    expect(e.atomCap).toBe(2);
    expect(e.bondCap).toBe(1);
    expect(e.notice).toContain('maxAtoms');
    expect(e.notice).toContain('maxBonds');
  });

  it('renders a truncation note in content[] when the preview is capped', () => {
    const blocks = getCompound3dStructure.format!({
      cid: 2244,
      atomCount: 3,
      bondCount: 2,
      atoms: [{ element: 'O', x: 1, y: 2, z: 3 }],
      bonds: [{ a1: 1, a2: 2, order: 1 }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('Showing 1 of 3 atoms');
    expect(text).toContain('Showing 1 of 2 bonds');
  });

  it('line-caps a large raw SDF by default and discloses it', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(bigSdf);
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({ cid: 2244, format: 'sdf' });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.sdf!.split('\n')).toHaveLength(500);
    expect(result.sdf!.length).toBeLessThan(bigSdf.length);
    const e = getEnrichment(ctx);
    expect(e.truncated).toBe(true);
    expect(e.shownSdfLines).toBe(500);
    expect(e.notice).toContain('includeRawSdf');
  });

  it('returns the full raw SDF when includeRawSdf is set', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(bigSdf);
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({
      cid: 2244,
      format: 'sdf',
      includeRawSdf: true,
    });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.sdf).toBe(bigSdf);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('leaves a record of exactly the line cap unchanged, its final newline included', async () => {
    const atLineCap = `${bigSdf.split('\n').slice(0, 500).join('\n')}\n`;
    mockClient.getSdf3d.mockResolvedValueOnce(atLineCap);
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({ cid: 2244, format: 'sdf' });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.sdf).toBe(atLineCap);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('leaves a small raw SDF unchanged by default (under the line cap)', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(SDF);
    const ctx = createMockContext({ errors: getCompound3dStructure.errors });
    const input = getCompound3dStructure.input.parse({ cid: 2244, format: 'sdf' });
    const result = await getCompound3dStructure.handler(input, ctx);

    expect(result.sdf).toBe(SDF);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });
});
