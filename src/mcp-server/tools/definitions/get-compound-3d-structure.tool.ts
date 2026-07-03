/**
 * @fileoverview Fetch the 3D conformer (atomic coordinates + bonds) for a PubChem compound.
 * @module mcp-server/tools/definitions/get-compound-3d-structure
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { parseSdfV2000 } from '@/services/pubchem/sdf-parser.js';
import { fencedData } from './untrusted-text.js';

/**
 * Safe-default ceilings applied when the caller sets no explicit cap. Sized to
 * pass small drug-like conformers (aspirin: 21 atoms/bonds, ~60 SDF lines)
 * through unchanged while bounding pathologically large records.
 */
const DEFAULT_ATOM_CAP = 200;
const DEFAULT_BOND_CAP = 200;
const DEFAULT_SDF_LINE_CAP = 500;

export const getCompound3dStructure = tool('pubchem_get_compound_3d_structure', {
  title: 'Get Compound 3D Structure',
  description:
    'Get a compound\'s default 3D conformer — atomic coordinates and bonds — for one CID. format="json" (default) returns parsed atoms and bonds the model can reason over directly; format="sdf" returns the raw V2000 SDF text for passthrough to docking, rendering, or conformer tools. Optionally lists alternate conformer IDs. Not every compound has computed 3D coordinates (large molecules, mixtures, and some salts do not).',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z
      .number()
      .int()
      .positive()
      .describe('PubChem Compound ID. Resolve from name/SMILES with pubchem_search_compounds.'),
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
        'List the IDs of additional computed conformers beyond the default. Adds one extra API call. Default: false.',
      ),
    maxAtoms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Cap the atoms returned in the format="json" preview. atomCount always reports the full total; omitted rows are disclosed via the truncated/shownAtoms enrichment. Defaults to the first 200 atoms.',
      ),
    maxBonds: z
      .number()
      .int()
      .positive()
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
        'Default (primary) conformer ID. Present when includeAlternateConformerIds is set.',
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
        'Conformer IDs beyond the default. Present when includeAlternateConformerIds is set and alternates exist.',
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
      when: 'PubChem has no computed 3D conformer for the requested CID',
      recovery:
        'Use pubchem_get_compound_image for the 2D structure, or verify the CID with pubchem_search_compounds.',
    },
  ],

  async handler(input, ctx) {
    const client = getPubChemClient();

    // getSdf3d throws a typed no_3d_structure not-found when PubChem has no 3D record.
    const sdf = await client.getSdf3d(input.cid);
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

    const atomCap = input.maxAtoms ?? DEFAULT_ATOM_CAP;
    const bondCap = input.maxBonds ?? DEFAULT_BOND_CAP;

    let sdfTruncated = false;
    let shownSdfLines = 0;

    if (input.format === 'json') {
      out.atoms = parsed.atoms.slice(0, atomCap);
      out.bonds = parsed.bonds.slice(0, bondCap);
    } else {
      const sdfLines = sdf.split(/\r\n?|\n/);
      if (input.includeRawSdf || sdfLines.length <= DEFAULT_SDF_LINE_CAP) {
        out.sdf = sdf;
      } else {
        out.sdf = sdfLines.slice(0, DEFAULT_SDF_LINE_CAP).join('\n');
        sdfTruncated = true;
        shownSdfLines = DEFAULT_SDF_LINE_CAP;
      }
    }

    if (input.includeAlternateConformerIds) {
      const ids = await client.getConformerIds(input.cid);
      if (ids[0]) {
        out.conformerId = ids[0];
        const alternates = ids.slice(1);
        if (alternates.length > 0) out.alternateConformerIds = alternates;
      }
    }

    ctx.log.info('3D structure fetched', {
      cid: input.cid,
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

    if (result.conformerId) lines.push(`Default conformer: ${result.conformerId}`);
    if (result.alternateConformerIds && result.alternateConformerIds.length > 0) {
      lines.push(`Alternate conformers: ${result.alternateConformerIds.join(', ')}`);
    }

    if (result.atoms && result.atoms.length > 0) {
      lines.push('', '**Atoms** (element: x, y, z):');
      for (const a of result.atoms) {
        lines.push(`  ${a.element}: ${a.x}, ${a.y}, ${a.z}`);
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
      // fencedData lengthens the fence past any backtick run in the payload so a
      // stray ``` in the SDF cannot break out of the code block.
      lines.push('', '**SDF (V2000):**', fencedData(result.sdf.trimEnd()));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
