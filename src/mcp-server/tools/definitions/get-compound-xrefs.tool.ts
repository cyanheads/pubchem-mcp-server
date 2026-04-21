/**
 * @fileoverview Get external database cross-references for a PubChem compound.
 * @module mcp-server/tools/definitions/get-compound-xrefs
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { XREF_TYPES } from '@/services/pubchem/types.js';

const xrefTypeEnum = z.enum(XREF_TYPES as unknown as [string, ...string[]]);

export const getCompoundXrefs = tool('pubchem_get_compound_xrefs', {
  title: 'Get Compound Cross-References',
  description:
    'Get external database cross-references for a compound: PubMed citations, patent IDs, ' +
    'gene/protein associations, registry numbers, and taxonomy IDs. Results are capped per ' +
    'type with total counts reported.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z.number().int().positive().describe('PubChem Compound ID.'),
    xrefTypes: z
      .array(xrefTypeEnum)
      .min(1)
      .describe(
        'Cross-reference types to retrieve. Options: RegistryID, RN (CAS numbers), ' +
          'PubMedID, PatentID, GeneID, ProteinGI, TaxonomyID.',
      ),
    maxPerType: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .describe(
        'Max IDs to return per xref type (1-500). A compound may have thousands of PubMed ' +
          'references — this cap prevents bloat. Total count always reported. Default: 50.',
      ),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    xrefs: z
      .array(
        z.object({
          type: z.string().describe('Cross-reference type.'),
          ids: z
            .array(z.union([z.string(), z.number()]))
            .describe('Cross-reference IDs (capped by maxPerType).'),
          totalAvailable: z.number().describe('Total IDs available before truncation.'),
          truncated: z.boolean().describe('Whether results were truncated.'),
        }),
      )
      .describe('Cross-references grouped by type.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();

    // Sequential per type to avoid rate limit spikes
    const xrefs: Array<{
      type: string;
      ids: (string | number)[];
      totalAvailable: number;
      truncated: boolean;
    }> = [];

    for (const xrefType of input.xrefTypes) {
      const allIds = await client.getXrefs(input.cid, xrefType);
      const totalAvailable = allIds.length;
      const ids = allIds.slice(0, input.maxPerType);

      xrefs.push({
        type: xrefType,
        ids,
        totalAvailable,
        truncated: totalAvailable > input.maxPerType,
      });
    }

    ctx.log.info('Xrefs fetched', {
      cid: input.cid,
      types: input.xrefTypes,
      totalIds: xrefs.reduce((sum, x) => sum + x.ids.length, 0),
    });

    return { cid: input.cid, xrefs };
  },

  format(result) {
    const lines: string[] = [`Cross-references for CID ${result.cid}`, ''];

    for (const xref of result.xrefs) {
      const countInfo = xref.truncated
        ? `${xref.ids.length} of ${xref.totalAvailable} total — truncated`
        : `${xref.totalAvailable} total`;
      lines.push(`**${xref.type}** (${countInfo})`);

      if (xref.ids.length > 0) {
        const display = xref.ids.slice(0, 20);
        const more = xref.ids.length > 20 ? `, ... (+${xref.ids.length - 20} more)` : '';
        lines.push(`  ${display.join(', ')}${more}`);
      } else {
        lines.push('  None found');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
