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
    'Get external database cross-references for a compound: PubMed citations, patent IDs, gene/protein associations, registry numbers, and taxonomy IDs. Results are paged per type — capped at maxPerType with the total count reported; reach the IDs past a page with offset.',
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first ID to return within each xref type. The same offset is applied to every requested type. Pass the nextOffset from a previous call to read the following page. Default: 0.',
      ),
    maxPerType: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe(
        'Max IDs to return per xref type per page (1-500). A compound may have thousands of PubMed references; use offset to reach the ones past this page. Total count always reported. Default: 50.',
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
              .describe('Cross-reference IDs on this page (window of offset + maxPerType).'),
            totalAvailable: z
              .number()
              .describe('Total IDs available for this type, across all pages.'),
            truncated: z
              .boolean()
              .describe('True when IDs for this type remain past the current page.'),
          })
          .describe('Cross-reference group for one type.'),
      )
      .describe('Cross-references grouped by type.'),
  }),
  // Agent-facing context — the page boundary shared by every requested type, plus a notice
  // distinguishing a nonexistent CID from a real compound that simply has none of the
  // requested xref types. Reaches structuredContent and content[]; keys disjoint from output
  // (cid/xrefs live there).
  enrichment: {
    offset: z.number().describe('Zero-based index of the first ID returned within each type.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue past this page. Omitted when no requested type has further IDs.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when every requested xref type returned zero IDs, when the offset runs past every type, or when further pages remain. Absent when this page is complete and non-empty.',
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
      // Offset is applied client-side: PubChem's xref endpoint returns the whole list for a
      // type in one response, so getXrefs already holds every ID.
      const ids = allIds.slice(input.offset, input.offset + input.maxPerType);

      xrefs.push({
        type: xrefType,
        ids,
        totalAvailable,
        truncated: input.offset + ids.length < totalAvailable,
      });
    }

    ctx.log.info('Xrefs fetched', {
      cid: input.cid,
      types: input.xrefTypes,
      offset: input.offset,
      totalIds: xrefs.reduce((sum, x) => sum + x.ids.length, 0),
    });

    // Any type whose page is full has more behind it, and every full page is the same length —
    // so a single nextOffset covers every type that still has IDs left. The stride comes from a
    // returned page rather than maxPerType, which accepts a fractional value that would make
    // nextOffset non-integer and so rejected by this tool's own offset input.
    const remainingTypes = xrefs.filter((x) => x.truncated);
    const hasMore = remainingTypes.length > 0;
    const nextOffset = input.offset + (remainingTypes[0]?.ids.length ?? 0);
    const largestTotal = Math.max(...xrefs.map((x) => x.totalAvailable));

    ctx.enrich({ offset: input.offset });
    if (hasMore) ctx.enrich({ nextOffset });

    // Empty-result signal (#30): every requested type came back empty — either the CID
    // doesn't exist or it genuinely has none of these xref types. Point at CID verification.
    if (largestTotal === 0) {
      ctx.enrich.notice(
        `No cross-references found for CID ${input.cid} across the requested type(s): ${input.xrefTypes.join(', ')}. The compound may have none of these xref types, or verify the CID with pubchem_search_compounds.`,
      );
    } else if (xrefs.every((x) => x.ids.length === 0)) {
      ctx.enrich.notice(
        `offset ${input.offset} is past every requested type — the largest has ${largestTotal} ID(s). Pass an offset below ${largestTotal}.`,
      );
    } else if (hasMore) {
      const remaining = remainingTypes
        .map((x) => `${x.type} (${x.totalAvailable} total)`)
        .join(', ');
      ctx.enrich.notice(
        `More IDs remain for: ${remaining}. Pass offset=${nextOffset} for the next page.`,
      );
    }

    return { cid: input.cid, xrefs };
  },

  format(result) {
    const lines: string[] = [`Cross-references for CID ${result.cid}`, ''];

    for (const xref of result.xrefs) {
      // A page shorter than the total is disclosed as a window; "truncated" additionally
      // marks that IDs remain *after* it (an offset can also leave IDs before it).
      let countInfo = `${xref.totalAvailable} total`;
      if (xref.ids.length !== xref.totalAvailable) {
        countInfo = `${xref.ids.length} of ${xref.totalAvailable} total`;
        if (xref.truncated) countInfo += ' — truncated';
      }
      lines.push(`**${xref.type}** (${countInfo})`);

      if (xref.ids.length > 0) {
        // Rendered in full: the handler already capped ids at maxPerType and the header
        // discloses that cap, so a second slice here would hide IDs structuredContent returned.
        lines.push(`  ${xref.ids.join(', ')}`);
      } else {
        lines.push(xref.totalAvailable > 0 ? '  None on this page' : '  None found');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
