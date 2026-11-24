/**
 * @fileoverview Fetch a 3D conformer (atomic coordinates + bonds) for a PubChem compound: its
 * default conformer, or one named by conformer ID.
 * @module mcp-server/tools/definitions/get-compound-3d-structure
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { parseSdfV2000 } from '@/services/pubchem/sdf-parser.js';
import { MAX_CID } from '@/services/pubchem/types.js';
import { clipEcho, fencedData, literalData } from './untrusted-text.js';

/**
 * Safe-default ceilings applied when the caller sets no explicit cap. Sized to
 * pass small drug-like conformers (aspirin: 21 atoms/bonds, ~200 SDF lines)
 * through unchanged while bounding pathologically large records.
 */
const DEFAULT_ATOM_CAP = 200;
const DEFAULT_BOND_CAP = 200;
const DEFAULT_SDF_LINE_CAP = 500;

/** A PubChem conformer ID: 16 hexadecimal digits, the first 8 being the compound's CID. */
const CONFORMER_ID = /^[0-9a-f]{16}$/i;

export const getCompound3dStructure = tool('pubchem_get_compound_3d_structure', {
  title: 'Get Compound 3D Structure',
  description:
    'Get one 3D conformer of a compound — atomic coordinates and bonds — for one CID: its default conformer, or the one conformerId names. format="json" (default) returns atoms and bonds parsed into structured fields; format="sdf" returns the raw V2000 SDF text for passthrough to docking, rendering, or conformer tools. Optionally lists the compound\'s other conformer IDs, each one a value for conformerId. Not every compound has computed 3D coordinates (large molecules, mixtures, and some salts do not).',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z
      .number()
      .int()
      .min(1)
      .max(MAX_CID)
      .describe('PubChem Compound ID. Resolve from name/SMILES with pubchem_search_compounds.'),
    conformerId: z
      .string()
      .optional()
      .describe(
        'Fetch this conformer of the compound instead of its default: a conformer ID from alternateConformerIds (includeAlternateConformerIds: true), 16 hexadecimal digits whose first 8 are the CID in hexadecimal (e.g. "000008C40000000B" for CID 2244). Either case is accepted. Omit, or leave blank, for the default conformer.',
      ),
    format: z
      .enum(['sdf', 'json'])
      .default('json')
      .describe(
        'Output format. "json" (default) returns parsed atoms and bonds. "sdf" returns the raw V2000 SDF text for passthrough to other tools.',
      ),
    includeAlternateConformerIds: z
      .boolean()
      .default(false)
      .describe(
        "List the IDs of the compound's other computed conformers, each one a value for conformerId. Slower than the default response. Default: false.",
      ),
    maxAtoms: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Cap the atoms returned in the format="json" preview. atomCount always reports the full total; omitted rows are disclosed via the truncated/shownAtoms enrichment. Defaults to the first 200 atoms.',
      ),
    maxBonds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Cap the bonds returned in the format="json" preview. bondCount always reports the full total; omitted rows are disclosed via the truncated/shownBonds enrichment. Defaults to the first 200 bonds.',
      ),
    includeRawSdf: z
      .boolean()
      .default(false)
      .describe(
        'For format="sdf", return the complete raw V2000 SDF even when it exceeds the safe line cap. Default false: an SDF longer than 500 lines is line-capped with disclosure. No effect when format="json".',
      ),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    conformerId: z
      .string()
      .optional()
      .describe(
        "ID of the conformer returned: the requested conformerId, or the compound's default conformer. Read from the record's PUBCHEM_CONFORMER_ID data item; omitted when the record carries none.",
      ),
    atomCount: z.number().describe('Number of atoms in the conformer.'),
    bondCount: z.number().describe('Number of bonds in the conformer.'),
    atoms: z
      .array(
        z
          .object({
            element: z.string().describe('Element symbol (e.g. "C", "O", "N").'),
            x: z.number().describe('X coordinate (Angstroms).'),
            y: z.number().describe('Y coordinate (Angstroms).'),
            z: z.number().describe('Z coordinate (Angstroms).'),
          })
          .describe('Atom with 3D Cartesian coordinates.'),
      )
      .optional()
      .describe('Parsed atoms. Populated when format="json".'),
    bonds: z
      .array(
        z
          .object({
            a1: z.number().describe('First atom index (1-based).'),
            a2: z.number().describe('Second atom index (1-based).'),
            order: z.number().describe('Bond order (1=single, 2=double, 3=triple, 4=aromatic).'),
          })
          .describe('Bond between two atoms.'),
      )
      .optional()
      .describe('Parsed bonds. Populated when format="json".'),
    sdf: z.string().optional().describe('Raw V2000 SDF text. Populated when format="sdf".'),
    alternateConformerIds: z
      .array(z.string())
      .optional()
      .describe(
        "The compound's other conformer IDs — every listed ID except the one returned, the default included when another was requested. Pass one as conformerId to fetch that conformer. Present when includeAlternateConformerIds is set and other conformers exist.",
      ),
  }),
  // Agent-facing context — truncation disclosure when a preview is capped below
  // the total. Reaches structuredContent and content[]; keys disjoint from output
  // (atomCount/bondCount always report the full totals). Follows the sibling
  // truncated/shown/cap convention, split per-list because atoms, bonds, and the
  // raw SDF cap independently.
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the atom list, bond list, or raw SDF was capped below its total. atomCount/bondCount always report the full totals.',
      ),
    shownAtoms: z
      .number()
      .optional()
      .describe(
        'Atoms returned after the cap, when fewer than atomCount. Raise maxAtoms for more.',
      ),
    shownBonds: z
      .number()
      .optional()
      .describe(
        'Bonds returned after the cap, when fewer than bondCount. Raise maxBonds for more.',
      ),
    atomCap: z
      .number()
      .optional()
      .describe(
        'The atom cap applied (explicit maxAtoms or the safe default), when the atom list was capped.',
      ),
    bondCap: z
      .number()
      .optional()
      .describe(
        'The bond cap applied (explicit maxBonds or the safe default), when the bond list was capped.',
      ),
    shownSdfLines: z
      .number()
      .optional()
      .describe(
        'SDF lines returned when format="sdf" and the raw text was line-capped. Set includeRawSdf for the full record.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance naming which lists were capped and how to widen them.'),
  },
  errors: [
    {
      reason: 'no_3d_structure',
      code: JsonRpcErrorCode.NotFound,
      // Raised by PubChemClient.getSdf3d, which distinguishes "no 3D record" from a
      // transport failure while reading the SDF body.
      thrownBy: 'service',
      when: "PubChem returned 404 for the CID's 3D record, its answer both when the compound has no computed 3D conformer (common for very large molecules, mixtures, and undefined salts) and when no compound has the CID",
      recovery:
        'Use pubchem_get_compound_image for the 2D structure; if the CID itself may be wrong, verify it with pubchem_search_compounds.',
    },
    {
      reason: 'invalid_conformer_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'conformerId is not 16 hexadecimal digits whose first 8 name a CID, or the CID they name is not cid',
      recovery:
        'Pass a conformer ID listed for this CID by includeAlternateConformerIds: true, or omit conformerId for the default conformer.',
    },
    {
      reason: 'conformer_not_found',
      code: JsonRpcErrorCode.NotFound,
      // Raised by PubChemClient.getConformerSdf on PubChem's 404 for the conformer path.
      thrownBy: 'service',
      when: 'PubChem returned 404 for the requested conformerId, its answer both for an ID the compound has no conformer under and for any ID of a compound with no computed 3D conformer',
      recovery:
        'Call again without conformerId and with includeAlternateConformerIds: true to list the conformer IDs PubChem holds for this CID.',
    },
  ],

  async handler(input, ctx) {
    const client = getPubChemClient();

    // A blank conformerId reads as omitted. Any other is checked before a request is sent, so
    // a conformer of another compound never comes back under this CID.
    const requested = input.conformerId?.trim();
    let conformerId: string | undefined;
    if (requested) {
      const owner = Number.parseInt(requested.slice(0, 8), 16);
      if (!CONFORMER_ID.test(requested) || owner < 1 || owner > MAX_CID) {
        throw ctx.fail(
          'invalid_conformer_id',
          `conformerId "${clipEcho(requested)}" is not a PubChem conformer ID: 16 hexadecimal digits, the first 8 being the CID.`,
        );
      }
      conformerId = requested.toUpperCase();
      if (owner !== input.cid) {
        throw ctx.fail(
          'invalid_conformer_id',
          `Conformer ID ${conformerId} belongs to CID ${owner} (its first 8 hexadecimal digits), not CID ${input.cid}.`,
          {
            recovery: {
              hint: `Call again with cid ${owner} to fetch this conformer, or list CID ${input.cid}'s own conformer IDs with includeAlternateConformerIds: true.`,
            },
          },
        );
      }
    }

    // getSdf3d throws a typed no_3d_structure not-found when PubChem has no 3D record;
    // getConformerSdf a typed conformer_not_found when it holds none under the requested ID.
    const sdf = conformerId
      ? await client.getConformerSdf(conformerId, ctx.signal)
      : await client.getSdf3d(input.cid, ctx.signal);
    const parsed = parseSdfV2000(sdf);

    const out: {
      cid: number;
      conformerId?: string;
      atomCount: number;
      bondCount: number;
      atoms?: typeof parsed.atoms;
      bonds?: typeof parsed.bonds;
      sdf?: string;
      alternateConformerIds?: string[];
    } = { cid: input.cid, atomCount: parsed.atomCount, bondCount: parsed.bondCount };
    // PubChem's 3D records name their own conformer, so naming it takes no list request.
    if (parsed.conformerId) out.conformerId = parsed.conformerId;

    const atomCap = input.maxAtoms ?? DEFAULT_ATOM_CAP;
    const bondCap = input.maxBonds ?? DEFAULT_BOND_CAP;

    let sdfTruncated = false;
    let shownSdfLines = 0;

    if (input.format === 'json') {
      out.atoms = parsed.atoms.slice(0, atomCap);
      out.bonds = parsed.bonds.slice(0, bondCap);
    } else {
      const sdfLines = sdf.split(/\r\n?|\n/);
      // A final line ending ends the last line; it does not start one more.
      const lineCount = sdfLines.at(-1) === '' ? sdfLines.length - 1 : sdfLines.length;
      if (input.includeRawSdf || lineCount <= DEFAULT_SDF_LINE_CAP) {
        out.sdf = sdf;
      } else {
        out.sdf = sdfLines.slice(0, DEFAULT_SDF_LINE_CAP).join('\n');
        sdfTruncated = true;
        shownSdfLines = DEFAULT_SDF_LINE_CAP;
      }
    }

    if (input.includeAlternateConformerIds) {
      const ids = await client.getConformerIds(input.cid, ctx.signal);
      // A named conformer is the one returned even when its record carries no ID of its own.
      const returned = out.conformerId ?? conformerId;
      const alternates = ids.filter((id) => id !== returned);
      if (alternates.length > 0) out.alternateConformerIds = alternates;
    }

    ctx.log.info('3D structure fetched', {
      cid: input.cid,
      conformerId: out.conformerId,
      format: input.format,
      atoms: parsed.atomCount,
      bonds: parsed.bondCount,
    });

    // Truncation disclosure — atoms, bonds, and SDF each cap independently.
    const atomsTruncated = out.atoms !== undefined && parsed.atomCount > out.atoms.length;
    const bondsTruncated = out.bonds !== undefined && parsed.bondCount > out.bonds.length;
    if (atomsTruncated || bondsTruncated || sdfTruncated) {
      ctx.enrich({
        truncated: true,
        ...(atomsTruncated ? { shownAtoms: out.atoms?.length, atomCap } : {}),
        ...(bondsTruncated ? { shownBonds: out.bonds?.length, bondCap } : {}),
        ...(sdfTruncated ? { shownSdfLines } : {}),
      });
      const parts: string[] = [];
      if (atomsTruncated) {
        parts.push(`atoms (${out.atoms?.length} of ${parsed.atomCount}; raise maxAtoms)`);
      }
      if (bondsTruncated) {
        parts.push(`bonds (${out.bonds?.length} of ${parsed.bondCount}; raise maxBonds)`);
      }
      if (sdfTruncated) {
        parts.push(`SDF (first ${shownSdfLines} lines; set includeRawSdf for the full record)`);
      }
      ctx.enrich.notice(`Output capped — ${parts.join('; ')}.`);
    }

    return out;
  },

  format(result) {
    const lines: string[] = [
      `## 3D Structure — CID ${result.cid}`,
      `Atoms: ${result.atomCount} | Bonds: ${result.bondCount}`,
    ];

    // Conformer IDs are PubChem identifiers an agent copies, so they render as code literals.
    if (result.conformerId) lines.push(`Conformer: ${literalData(result.conformerId)}`);
    if (result.alternateConformerIds && result.alternateConformerIds.length > 0) {
      lines.push(
        `Alternate conformers: ${result.alternateConformerIds.map(literalData).join(', ')}`,
      );
    }

    if (result.atoms && result.atoms.length > 0) {
      lines.push('', '**Atoms** (element: x, y, z):');
      for (const a of result.atoms) {
        lines.push(`  ${escapeMarkdownInline(a.element)}: ${a.x}, ${a.y}, ${a.z}`);
      }
      if (result.atomCount > result.atoms.length) {
        lines.push(
          `  _Showing ${result.atoms.length} of ${result.atomCount} atoms — raise maxAtoms for the rest._`,
        );
      }
    }

    if (result.bonds && result.bonds.length > 0) {
      lines.push('', '**Bonds** (a1–a2, order):');
      for (const b of result.bonds) {
        lines.push(`  ${b.a1}–${b.a2}, order ${b.order}`);
      }
      if (result.bondCount > result.bonds.length) {
        lines.push(
          `  _Showing ${result.bonds.length} of ${result.bondCount} bonds — raise maxBonds for the rest._`,
        );
      }
    }

    if (result.sdf) {
      // Verbatim, final newline included, so the block reads back as the record
      // structuredContent carries. fencedData lengthens the fence past any backtick run in the
      // payload so a stray ``` in the SDF cannot break out of the code block.
      lines.push('', '**SDF (V2000):**', fencedData(result.sdf));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
