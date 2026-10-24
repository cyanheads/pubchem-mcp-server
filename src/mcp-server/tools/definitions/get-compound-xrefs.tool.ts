/**
 * @fileoverview Get external database cross-references for a PubChem compound.
 * @module mcp-server/tools/definitions/get-compound-xrefs
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { defaultIsTransient } from '@cyanheads/mcp-ts-core/utils';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { MAX_CID, XREF_TYPES } from '@/services/pubchem/types.js';
import { lookupXrefs } from '@/services/pubchem/xref-lookup.js';
import {
  type CappedInput,
  capPageSize,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
} from './input-caps.js';

/** IDs served per xref type per page; a larger maxPerType is clamped to this. */
const MAX_PER_TYPE_CAP = 500;

export const getCompoundXrefs = tool('pubchem_get_compound_xrefs', {
  title: 'Get Compound Cross-References',
  description:
    "Get external database cross-references for a compound: PubMed citations, patent IDs, gene associations, CAS and EC numbers with the number of source records that deposited each, other registry numbers, and taxonomy IDs. Results are paged per type — capped at maxPerType with the total count reported; reach the IDs past a page with offset. PubMed IDs come highest (most recently assigned) first and the other numeric types in ascending order; CAS and EC come most-attested first; the other string IDs keep PubChem's order. A type that fails to load is named in failedTypes while the others still return; the call fails only when a type fails and no type other than ProteinGI (which PubChem no longer serves) loads.",
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
    xrefTypes: z
      .array(z.enum(XREF_TYPES))
      .min(1)
      .describe(
        'Cross-reference types to retrieve. String IDs: CAS (the CAS Registry Numbers deposited for this compound, most-attested first, each with the number of source records that deposited it — the first is the value most source records agree on), EC (European Community numbers, ordered and counted the same way), RN (every registry number PubChem associates with the record, unranked: the CAS number alongside deprecated and related CAS RNs, CAS RNs of other substances mapped to the structure, and EC numbers), RegistryID (DSSTox/EPA registry numbers), PatentID. Numeric IDs: PubMedID, GeneID (NCBI Gene — use it for gene/protein associations), ProteinGI (legacy NCBI Protein GI; PubChem currently returns no data for it, so use GeneID instead), TaxonomyID.',
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
      .max(INPUT_CEILING)
      .default(50)
      .describe(
        `Max IDs to return per xref type per page. The per-call cap is ${MAX_PER_TYPE_CAP}: a larger value (up to ${INPUT_CEILING}) returns ${MAX_PER_TYPE_CAP} per type and is reported in cappedInputs. A compound may have thousands of PubMed references; use offset to reach the ones past this page. Total count always reported. Default: 50.`,
      ),
  }),
  // Every other paging tool here names its page size `maxResults`; this one caps per
  // xref type, so a caller arriving from pubchem_search_compounds reaches for the
  // sibling spelling. One page-size input exists, so the mapping is unambiguous.
  inputAliases: { maxResults: 'maxPerType' },
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    xrefs: z
      .array(
        z
          .object({
            type: z
              .string()
              .describe(
                'Cross-reference type: CAS, EC, RN, RegistryID, PubMedID, PatentID, GeneID, ProteinGI, or TaxonomyID. PubChem currently returns no data for ProteinGI; GeneID carries gene/protein associations.',
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
              .describe(
                "Cross-reference IDs on this page (window of offset + maxPerType). PubMedID is sorted numerically descending, so page one holds the highest, most recently assigned PMIDs; GeneID, ProteinGI and TaxonomyID numerically ascending; CAS and EC by the number of source records that deposited each, most first (ties in PubChem's order), so ids[0] is the value most source records agree on; RegistryID, RN and PatentID keep PubChem's order.",
              ),
            sourceCounts: z
              .array(
                z
                  .number()
                  .describe('Number of source records that deposited the ID at this index.'),
              )
              .optional()
              .describe(
                'CAS and EC only: how many source records deposited each ID on this page, aligned with ids — sourceCounts[i] is the count for ids[i]. One source can deposit several records, so this counts records, not distinct source names. More than one ID means the source records disagree; the counts show by how much.',
              ),
            totalAvailable: z
              .number()
              .describe('Total IDs available for this type, across all pages.'),
            truncated: z
              .boolean()
              .describe('True when IDs for this type remain past the current page.'),
          })
          .describe('Cross-reference group for one type.'),
      )
      .describe(
        'Cross-references grouped by type, one group per requested type that loaded. A type listed in failedTypes is absent — its IDs are unknown, not empty.',
      ),
  }),
  // Agent-facing context — the page boundary shared by every requested type, the types that
  // failed to load, plus a notice distinguishing a nonexistent CID from a real compound that
  // simply has none of the requested xref types. Reaches structuredContent and content[]; keys
  // disjoint from output (cid/xrefs live there).
  enrichment: {
    offset: z.number().describe('Zero-based index of the first ID returned within each type.'),
    truncated: z
      .boolean()
      .describe(
        'True when at least one requested type has IDs remaining past this page. Which types, and how many IDs each holds in total, is in xrefs[].truncated / xrefs[].totalAvailable.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue past this page. Omitted when no requested type has further IDs.',
      ),
    failedTypes: z
      .string()
      .optional()
      .describe(
        'Requested xref types that could not be retrieved (comma-separated). The returned groups cover the types that loaded. A retry can recover a type that failed transiently (a timeout, network error, rate limit, or 5xx), and the notice names those; a type PubChem rejected fails the same way again.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a type failed to load, when every requested xref type returned zero IDs, when the offset runs past every type, when further pages remain, or when ProteinGI came back empty (PubChem serves no ProteinGI data). Absent when this page is complete and non-empty.',
      ),
    cappedInputs: cappedInputsField,
  },
  enrichmentTrailer: { cappedInputs: { render: renderCappedInputs } },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const capped: CappedInput[] = [];
    const pageSize = capPageSize('maxPerType', input.maxPerType, MAX_PER_TYPE_CAP, capped);
    const { groups, failed } = await lookupXrefs(client, input.cid, input.xrefTypes, ctx.signal);

    // Offset is applied client-side: PubChem returns a type's whole list in one response, so
    // every group already holds every ID.
    const window = <T>(items: T[]) => items.slice(input.offset, input.offset + pageSize);
    const xrefs = groups.map((group) => {
      const ids = window(group.ids);
      return {
        type: group.type,
        ids,
        ...(group.sourceCounts && { sourceCounts: window(group.sourceCounts) }),
        totalAvailable: group.ids.length,
        truncated: input.offset + ids.length < group.ids.length,
      };
    });

    for (const f of failed) {
      ctx.log.warning('Xref type failed', {
        cid: input.cid,
        type: f.type,
        error: f.error instanceof Error ? f.error.message : String(f.error),
      });
    }
    ctx.log.info('Xrefs fetched', {
      cid: input.cid,
      types: input.xrefTypes,
      offset: input.offset,
      totalIds: xrefs.reduce((sum, x) => sum + x.ids.length, 0),
      failed: failed.length,
    });

    // Any type whose page is full has more behind it, and every full page is the same length —
    // so a single nextOffset covers every type that still has IDs left. The stride comes from a
    // returned page rather than maxPerType, which accepts a fractional value that would make
    // nextOffset non-integer and so rejected by this tool's own offset input.
    const remainingTypes = xrefs.filter((x) => x.truncated);
    const hasMore = remainingTypes.length > 0;
    const nextOffset = input.offset + (remainingTypes[0]?.ids.length ?? 0);

    ctx.enrich({ offset: input.offset, truncated: hasMore });
    if (hasMore) ctx.enrich({ nextOffset });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });

    // Notice is last-wins, so every applicable signal composes into one string.
    const noticeParts: string[] = [];

    if (failed.length > 0) {
      const failedTypes = failed.map((f) => f.type);
      ctx.enrich({ failedTypes: failedTypes.join(', ') });
      // A retry can clear a timeout, network error, rate limit, or 5xx — never a rejection
      // such as a 400, which PubChem repeats on every re-send.
      const retryable = failed.filter((f) => defaultIsTransient(f.error)).map((f) => f.type);
      noticeParts.push(
        `Could not retrieve ${failedTypes.join(', ')} for CID ${input.cid}; the other requested types are returned.${retryable.length > 0 ? ` Retry to re-attempt ${retryable.join(', ')}.` : ''}`,
      );
    }

    // PubChem serves ProteinGI for no compound (#72), so an empty ProteinGI list says nothing
    // about the CID and is left out of the checks below that judge it.
    const isUnserved = (x: (typeof xrefs)[number]) =>
      x.type === 'ProteinGI' && x.totalAvailable === 0;
    const judged = xrefs.filter((x) => !isUnserved(x));
    const largestTotal = Math.max(0, ...judged.map((x) => x.totalAvailable));

    // Empty-result signal (#30): every judged type came back empty — either the CID doesn't
    // exist or it genuinely has none of these xref types. Point at CID verification.
    if (judged.length > 0 && largestTotal === 0) {
      noticeParts.push(
        `No cross-references found for CID ${input.cid} across the requested type(s): ${judged.map((x) => x.type).join(', ')}. The compound may have none of these xref types, or verify the CID with pubchem_search_compounds.`,
      );
    } else if (judged.length > 0 && judged.every((x) => x.ids.length === 0)) {
      // A failed type's size is unknown, so the claim covers only the types that loaded.
      const scope = failed.length > 0 ? 'every type that loaded' : 'every requested type';
      noticeParts.push(
        `offset ${input.offset} is past ${scope} — the largest has ${largestTotal} ID(s). Pass an offset below ${largestTotal}.`,
      );
    } else if (hasMore) {
      const remaining = remainingTypes
        .map((x) => `${x.type} (${x.totalAvailable} total)`)
        .join(', ');
      noticeParts.push(
        `More IDs remain for: ${remaining}. Pass offset=${nextOffset} for the next page.`,
      );
    }

    if (xrefs.some(isUnserved)) {
      noticeParts.push(
        `PubChem currently returns no ProteinGI cross-references for any compound, so the empty ProteinGI list says nothing about CID ${input.cid}. Use GeneID for gene/protein associations.`,
      );
    }

    if (noticeParts.length > 0) ctx.enrich.notice(noticeParts.join(' '));

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
        const counts = xref.sourceCounts;
        const rendered = counts
          ? xref.ids.map(
              (id, i) => `${id} (${counts[i]} source record${counts[i] === 1 ? '' : 's'})`,
            )
          : xref.ids;
        lines.push(`  ${rendered.join(', ')}`);
      } else {
        lines.push(xref.totalAvailable > 0 ? '  None on this page' : '  None found');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
