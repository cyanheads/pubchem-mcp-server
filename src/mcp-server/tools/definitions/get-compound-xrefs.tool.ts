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
    'Get external database cross-references for a compound: PubMed citations, patent IDs, gene/protein associations, registry numbers, and taxonomy IDs. Results are capped per type with total counts reported.',
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
    xrefTypes: z
      .array(xrefTypeEnum)
      .min(1)
      .describe(
        'Cross-reference types to retrieve. String IDs: RegistryID (DSSTox/EPA registry numbers), RN (CAS numbers), PatentID. Numeric IDs: PubMedID, GeneID (NCBI Gene), ProteinGI (legacy NCBI Protein GI), TaxonomyID.',
      ),
    maxPerType: z
      .number()
      .min(1)
      .max(500)
      .default(50)
      .describe(
        'Max IDs to return per xref type (1-500). A compound may have thousands of PubMed references. Total count always reported. Default: 50.',
      ),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    xrefs: z
      .array(
        z
          .object({
            type: z
              .string()
              .describe(
                'Cross-reference type: RegistryID, RN, PubMedID, PatentID, GeneID, ProteinGI, or TaxonomyID.',
              ),
            ids: z
              .array(
                z
                  .union([
                    z
                      .string()
                      .describe('String-form cross-reference ID (e.g. CAS number, patent).'),
                    z.number().describe('Numeric cross-reference ID (e.g. PubMed ID, Gene ID).'),
                  ])
                  .describe('Cross-reference identifier — string or number depending on type.'),
              )
              .describe('Cross-reference IDs (capped by maxPerType).'),
            totalAvailable: z.number().describe('Total IDs available before truncation.'),
            truncated: z.boolean().describe('Whether results were truncated.'),
          })
          .describe('Cross-reference group for one type.'),
      )
      .describe('Cross-references grouped by type.'),
  }),
  // Agent-facing context — an empty-result notice distinguishing a nonexistent CID from a
  // real compound that simply has none of the requested xref types. Reaches structuredContent
  // and content[]; keys disjoint from output (cid/xrefs live there).
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when every requested xref type returned zero IDs — hints to verify the CID. Absent when any cross-references were found.',
      ),
  },

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

    // Empty-result signal (#30): every requested type came back empty — either the CID
    // doesn't exist or it genuinely has none of these xref types. Point at CID verification.
    if (xrefs.every((x) => x.totalAvailable === 0)) {
      ctx.enrich.notice(
        `No cross-references found for CID ${input.cid} across the requested type(s): ${input.xrefTypes.join(', ')}. The compound may have none of these xref types, or verify the CID with pubchem_search_compounds.`,
      );
    }

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
        // Rendered in full: the handler already capped ids at maxPerType and the header
        // discloses that cap, so a second slice here would hide IDs structuredContent returned.
        lines.push(`  ${xref.ids.join(', ')}`);
      } else {
        lines.push('  None found');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
