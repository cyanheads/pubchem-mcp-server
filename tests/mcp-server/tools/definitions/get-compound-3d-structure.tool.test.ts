/**
 * @fileoverview Tests for get-compound-3d-structure tool.
 * @module mcp-server/tools/definitions/get-compound-3d-structure.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompound3dStructure } from '@/mcp-server/tools/definitions/get-compound-3d-structure.tool.js';
import { readCommonMark } from '../../../helpers/commonmark.js';
import { readFixture } from '../../../helpers/fixtures.js';
import {
  asReadBack,
  formatBlock,
  ONE_LINE_FUZZ,
  READ_BACK_FUZZ,
} from '../../../helpers/read-back.js';

const mockClient = {
  getSdf3d: vi.fn(),
  getConformerIds: vi.fn(),
  getConformerSdf: vi.fn(),
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

/** {@link SDF} carrying `id` as its PUBCHEM_CONFORMER_ID data item. */
const sdfWithConformerId = (id: string) =>
  SDF.replace('M  END\n', `M  END\n> <PUBCHEM_CONFORMER_ID>\n${id}\n\n`);

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
    mockClient.getSdf3d.mockResolvedValueOnce(sdfWithConformerId('A'));
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

/** Aspirin's default conformer, from `/compound/cid/2244/record/SDF?record_type=3d`. */
const ASPIRIN_DEFAULT_SDF = readFixture('sdf-2244-default.sdf');

/** Aspirin's conformer list from `/compound/cid/2244/conformers/JSON`, the default first. */
const ASPIRIN_CONFORMERS = [
  '000008C400000001',
  '000008C40000000B',
  '000008C40000000A',
  '000008C400000003',
  '000008C40000000F',
  '000008C400000011',
  '000008C40000000D',
  '000008C400000005',
  '000008C400000010',
  '000008C400000007',
];

describe('getCompound3dStructure — the default conformer of a real record (#99)', () => {
  it('returns the default record, its ID, and the nine other listed IDs', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(ASPIRIN_DEFAULT_SDF);
    mockClient.getConformerIds.mockResolvedValueOnce(ASPIRIN_CONFORMERS);

    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      includeAlternateConformerIds: true,
    });
    const structured = result.structuredContent as {
      atoms: Array<{ element: string; x: number; y: number; z: number }>;
      bonds: Array<{ a1: number; a2: number; order: number }>;
    };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cid: 2244,
      conformerId: '000008C400000001',
      alternateConformerIds: [
        '000008C40000000B',
        '000008C40000000A',
        '000008C400000003',
        '000008C40000000F',
        '000008C400000011',
        '000008C40000000D',
        '000008C400000005',
        '000008C400000010',
        '000008C400000007',
      ],
      atomCount: 21,
      bondCount: 21,
    });
    expect(structured.atoms).toHaveLength(21);
    expect(structured.atoms[0]).toEqual({ element: 'O', x: 1.2333, y: 0.554, z: 0.7792 });
    expect(structured.bonds.at(-1)).toEqual({ a1: 13, a2: 20, order: 1 });
    expect(mockClient.getSdf3d).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
    expect(mockClient.getConformerIds).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
  });
});

/** Aspirin's conformer 000008C40000000B, from `/conformers/000008C40000000B/SDF`. */
const ASPIRIN_CONFORMER_B_SDF = readFixture('sdf-2244-conformer-000008C40000000B.sdf');

type ErrorEnvelope = {
  error: {
    code: number;
    message: string;
    data?: { reason?: string; recovery?: { hint?: string } };
  };
};

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((b) => (b as { type: 'text'; text: string }).text).join('\n');

describe('getCompound3dStructure — a conformer named by conformerId (#99)', () => {
  it('returns the named conformer and its ID without fetching the default record', async () => {
    mockClient.getConformerSdf.mockResolvedValueOnce(ASPIRIN_CONFORMER_B_SDF);

    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      conformerId: '000008C40000000B',
    });
    const structured = result.structuredContent as {
      atoms: Array<{ element: string; x: number; y: number; z: number }>;
    };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cid: 2244,
      conformerId: '000008C40000000B',
      atomCount: 21,
      bondCount: 21,
    });
    expect(structured.atoms[0]).toEqual({ element: 'O', x: 1.267, y: 0.3852, z: -0.8565 });
    expect(result.structuredContent).not.toHaveProperty('alternateConformerIds');
    expect(mockClient.getConformerSdf).toHaveBeenCalledWith(
      '000008C40000000B',
      expect.any(AbortSignal),
    );
    expect(mockClient.getSdf3d).not.toHaveBeenCalled();
    expect(mockClient.getConformerIds).not.toHaveBeenCalled();
  });

  it.each([
    ['lowercase', '000008c40000000b'],
    ['mixed case with edge spaces', '  000008c40000000B '],
  ])('accepts a %s ID and requests and returns it uppercased', async (_label, conformerId) => {
    mockClient.getConformerSdf.mockResolvedValueOnce(ASPIRIN_CONFORMER_B_SDF);

    const result = await runToolContract(getCompound3dStructure, { cid: 2244, conformerId });

    expect(result.structuredContent).toMatchObject({ conformerId: '000008C40000000B' });
    expect(mockClient.getConformerSdf).toHaveBeenCalledWith(
      '000008C40000000B',
      expect.any(AbortSignal),
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('reads an %s conformerId as omitted: the default conformer', async (_label, conformerId) => {
    mockClient.getSdf3d.mockResolvedValueOnce(ASPIRIN_DEFAULT_SDF);

    const result = await runToolContract(getCompound3dStructure, { cid: 2244, conformerId });

    expect(result.structuredContent).toMatchObject({ conformerId: '000008C400000001' });
    expect(mockClient.getSdf3d).toHaveBeenCalledOnce();
    expect(mockClient.getConformerSdf).not.toHaveBeenCalled();
  });

  it('names the default conformer on every call, with or without the alternates list', async () => {
    mockClient.getSdf3d.mockResolvedValueOnce(ASPIRIN_DEFAULT_SDF);

    const result = await runToolContract(getCompound3dStructure, { cid: 2244 });

    expect(result.structuredContent).toMatchObject({ conformerId: '000008C400000001' });
    expect(result.structuredContent).not.toHaveProperty('alternateConformerIds');
    expect(mockClient.getConformerIds).not.toHaveBeenCalled();
    expect(formatBlock(result)).toContain('Conformer: `000008C400000001`');
  });

  it('lists every other conformer, the default included, beside a named one', async () => {
    mockClient.getConformerSdf.mockResolvedValueOnce(ASPIRIN_CONFORMER_B_SDF);
    mockClient.getConformerIds.mockResolvedValueOnce(ASPIRIN_CONFORMERS);

    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      conformerId: '000008C40000000B',
      includeAlternateConformerIds: true,
    });

    expect(result.structuredContent).toMatchObject({
      conformerId: '000008C40000000B',
      alternateConformerIds: [
        '000008C400000001',
        '000008C40000000A',
        '000008C400000003',
        '000008C40000000F',
        '000008C400000011',
        '000008C40000000D',
        '000008C400000005',
        '000008C400000010',
        '000008C400000007',
      ],
    });
    expect(mockClient.getConformerIds).toHaveBeenCalledWith(2244, expect.any(AbortSignal));
  });

  it('never lists the named conformer as an alternate when its record names no conformer ID', async () => {
    mockClient.getConformerSdf.mockResolvedValueOnce(SDF);
    mockClient.getConformerIds.mockResolvedValueOnce(['000008C400000001', '000008C40000000B']);

    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      conformerId: '000008C40000000B',
      includeAlternateConformerIds: true,
    });

    expect(result.structuredContent).not.toHaveProperty('conformerId');
    expect(result.structuredContent).toMatchObject({ alternateConformerIds: ['000008C400000001'] });
  });

  it('labels a named conformer in content[] as the conformer returned, never the default', async () => {
    mockClient.getConformerSdf.mockResolvedValueOnce(ASPIRIN_CONFORMER_B_SDF);
    mockClient.getConformerIds.mockResolvedValueOnce(ASPIRIN_CONFORMERS);

    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      conformerId: '000008C40000000B',
      includeAlternateConformerIds: true,
    });
    const read = readCommonMark(formatBlock(result));

    expect(read).toContain('Conformer: ⟨code_inline:000008C40000000B⟩');
    expect(read).toContain('Alternate conformers: ⟨code_inline:000008C400000001⟩, ');
    expect(read).not.toContain('Default conformer');
  });

  it('fails an ID naming another CID before any request, naming the CID it belongs to', async () => {
    const result = await runToolContract(getCompound3dStructure, {
      cid: 2662,
      conformerId: '000008C40000000B',
    });
    const { error } = result.structuredContent as ErrorEnvelope;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_conformer_id');
    expect(error.message).toBe(
      'Conformer ID 000008C40000000B belongs to CID 2244 (its first 8 hexadecimal digits), not CID 2662.',
    );
    expect(error.data?.recovery?.hint).toBe(
      "Call again with cid 2244 to fetch this conformer, or list CID 2662's own conformer IDs with includeAlternateConformerIds: true.",
    );
    expect(textOf(result)).toContain('belongs to CID 2244');
    expect(mockClient.getConformerSdf).not.toHaveBeenCalled();
    expect(mockClient.getSdf3d).not.toHaveBeenCalled();
    expect(mockClient.getConformerIds).not.toHaveBeenCalled();
  });

  it.each([
    ['three letters', 'XYZ'],
    ['15 digits', '000008C40000000'],
    ['17 digits', '000008C40000000B0'],
    ['a non-hex digit', '000008C4000000G1'],
    ['inner whitespace', '000008C4 0000000B'],
    ['a CID part of 0', '0000000000000001'],
    ['a CID part past the 32-bit CID range', '8000000000000001'],
  ])('fails %s with the typed reason before any request', async (_label, conformerId) => {
    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      includeAlternateConformerIds: true,
      conformerId,
    });
    const { error } = result.structuredContent as ErrorEnvelope;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_conformer_id');
    expect(error.message).toBe(
      `conformerId "${conformerId}" is not a PubChem conformer ID: 16 hexadecimal digits, the first 8 being the CID.`,
    );
    expect(error.data?.recovery?.hint).toContain('includeAlternateConformerIds: true');
    expect(mockClient.getConformerSdf).not.toHaveBeenCalled();
    expect(mockClient.getSdf3d).not.toHaveBeenCalled();
    expect(mockClient.getConformerIds).not.toHaveBeenCalled();
  });

  it.each([
    ['the first CID', 1, '0000000100000001'],
    ['the last CID', 2147483647, '7FFFFFFF00000001'],
  ])(
    'sends an ID naming %s and reads its 404 as conformer_not_found',
    async (_label, cid, conformerId) => {
      mockClient.getConformerSdf.mockRejectedValueOnce(
        notFound(`PubChem has no 3D record for conformer ${conformerId}.`, {
          conformerId,
          reason: 'conformer_not_found',
        }),
      );

      const result = await runToolContract(getCompound3dStructure, { cid, conformerId });
      const { error } = result.structuredContent as ErrorEnvelope;

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('conformer_not_found');
      expect(mockClient.getConformerSdf).toHaveBeenCalledWith(conformerId, expect.any(AbortSignal));
    },
  );

  it('cuts a long malformed ID to 100 characters in the message', async () => {
    const conformerId = `${'A'.repeat(150)}Z`;
    const result = await runToolContract(getCompound3dStructure, { cid: 2244, conformerId });
    const { error } = result.structuredContent as ErrorEnvelope;

    expect(error.message).toContain(`"${'A'.repeat(100)}…"`);
    expect(error.message).not.toContain('Z');
  });

  it('fails an ID PubChem holds no record for with conformer_not_found, not no_3d_structure', async () => {
    mockClient.getConformerSdf.mockRejectedValueOnce(
      notFound('PubChem has no 3D record for conformer 000008C4FFFFFFFE.', {
        conformerId: '000008C4FFFFFFFE',
        reason: 'conformer_not_found',
      }),
    );

    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      conformerId: '000008C4FFFFFFFE',
    });
    const { error } = result.structuredContent as ErrorEnvelope;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('conformer_not_found');
    expect(error.data?.recovery?.hint).toBe(
      'Call again without conformerId and with includeAlternateConformerIds: true to list the conformer IDs PubChem holds for this CID.',
    );
    expect(mockClient.getSdf3d).not.toHaveBeenCalled();
  });

  /** One call's structuredContent, the record served as the named conformer or the default. */
  async function served(sdf: string, input: Record<string, unknown>, named: boolean) {
    const source = named ? mockClient.getConformerSdf : mockClient.getSdf3d;
    source.mockResolvedValueOnce(sdf);
    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      ...input,
      ...(named && { conformerId: '000008C40000000B' }),
    });
    return result.structuredContent;
  }

  it.each([
    ['format "sdf"', ASPIRIN_CONFORMER_B_SDF, { format: 'sdf' }],
    ['maxAtoms and maxBonds', ASPIRIN_CONFORMER_B_SDF, { maxAtoms: 5, maxBonds: 4 }],
    ['the SDF line cap', () => bigSdf, { format: 'sdf' }],
    ['includeRawSdf', () => bigSdf, { format: 'sdf', includeRawSdf: true }],
  ])('applies %s to a named conformer as to the default', async (_label, sdf, input) => {
    const record = typeof sdf === 'function' ? sdf() : sdf;
    const named = await served(record, input, true);
    const fallback = await served(record, input, false);

    expect(named).toEqual(fallback);
  });

  it('caps and discloses a named conformer as it does the default', async () => {
    const capped = await served(ASPIRIN_CONFORMER_B_SDF, { maxAtoms: 5, maxBonds: 4 }, true);

    expect(capped).toMatchObject({
      atomCount: 21,
      bondCount: 21,
      truncated: true,
      shownAtoms: 5,
      shownBonds: 4,
      atomCap: 5,
      bondCap: 4,
    });
    expect(await served(bigSdf, { format: 'sdf' }, true)).toMatchObject({
      truncated: true,
      shownSdfLines: 500,
    });
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

  /** The tool's content[] for a record carrying conformer ID `RECORD_ID` with `alternates`
   * listed beside it, after asserting structuredContent holds them. */
  const RECORD_ID = '000008C400000001';
  async function renderConformers(alternates: string[]) {
    mockClient.getSdf3d.mockResolvedValueOnce(sdfWithConformerId(RECORD_ID));
    mockClient.getConformerIds.mockResolvedValueOnce([RECORD_ID, ...alternates]);
    const result = await runToolContract(getCompound3dStructure, {
      cid: 2244,
      includeAlternateConformerIds: true,
    });
    expect(result.structuredContent).toMatchObject({
      conformerId: RECORD_ID,
      alternateConformerIds: alternates,
    });
    return formatBlock(result);
  }

  it.each(ONE_LINE_FUZZ)(
    'renders alternate conformer IDs holding %s verbatim in code spans',
    async (_label, value) => {
      const baselineRead = readCommonMark(await renderConformers([SENTINEL, SENTINEL]));
      const text = await renderConformers([value, value]);

      expect(baselineRead).toContain(`Conformer: ⟨code_inline:${RECORD_ID}⟩`);
      expect(baselineRead).toContain(
        `Alternate conformers: ⟨code_inline:${SENTINEL}⟩, ⟨code_inline:${SENTINEL}⟩`,
      );
      expect(readCommonMark(text)).toBe(baselineRead.replaceAll(SENTINEL, () => value));
      expect(text).toContain(value);
    },
  );

  /** format()'s text for a result naming conformer `conformerId`. */
  const renderConformerId = (conformerId: string) =>
    (
      getCompound3dStructure.format!({ cid: 2244, conformerId, atomCount: 0, bondCount: 0 })[0] as {
        type: 'text';
        text: string;
      }
    ).text;

  it.each(ONE_LINE_FUZZ)(
    'renders a conformer ID holding %s verbatim in a code span',
    (_l, value) => {
      const baselineRead = readCommonMark(renderConformerId(SENTINEL));

      expect(baselineRead).toContain(`Conformer: ⟨code_inline:${SENTINEL}⟩`);
      expect(readCommonMark(renderConformerId(value))).toBe(
        baselineRead.replaceAll(SENTINEL, () => value),
      );
    },
  );

  it('fences conformer IDs holding a line break on lines of their own', async () => {
    const alternates = readCommonMark(
      await renderConformers(['x\r\n# INJECTED', 'x\r\n# INJECTED']),
    );
    const own = readCommonMark(renderConformerId('x\r\n# INJECTED'));

    expect(alternates.split('⟨fence:x\n# INJECTED⟩')).toHaveLength(3);
    expect(alternates.split('⟨heading_open⟩')).toHaveLength(2);
    expect(own.split('⟨fence:x\n# INJECTED⟩')).toHaveLength(2);
    expect(own.split('⟨heading_open⟩')).toHaveLength(2);
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
