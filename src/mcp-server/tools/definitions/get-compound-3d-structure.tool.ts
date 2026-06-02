/**
 * @fileoverview Fetch the 3D conformer (atomic coordinates + bonds) for a PubChem compound.
 * @module mcp-server/tools/definitions/get-compound-3d-structure
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { parseSdfV2000 } from '@/services/pubchem/sdf-parser.js';

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

    if (input.format === 'json') {
      out.atoms = parsed.atoms;
      out.bonds = parsed.bonds;
    } else {
      out.sdf = sdf;
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
    }

    if (result.bonds && result.bonds.length > 0) {
      lines.push('', '**Bonds** (a1–a2, order):');
      for (const b of result.bonds) {
        lines.push(`  ${b.a1}–${b.a2}, order ${b.order}`);
      }
    }

    if (result.sdf) {
      lines.push('', '**SDF (V2000):**', '```', result.sdf.trimEnd(), '```');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
