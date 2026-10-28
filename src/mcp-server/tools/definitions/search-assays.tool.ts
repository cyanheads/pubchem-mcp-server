/**
 * @fileoverview Find PubChem bioassays by biological target (gene symbol,
 * protein name, Gene ID, or UniProt accession).
 * @module mcp-server/tools/definitions/search-assays
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { normalizeProteinAccession } from './identifier-case.js';
import {
  type CappedInput,
  capPageSize,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
} from './input-caps.js';
import { clipEcho, renderNotice } from './untrusted-text.js';

/** AIDs served per page; a larger maxResults is clamped to this. */
const MAX_RESULTS_CAP = 200;

export const searchAssays = tool('pubchem_search_assays', {
  title: 'Search Assays',
  description:
    'Find PubChem bioassays associated with a biological target. Search by gene symbol (e.g. "EGFR"), protein name, NCBI Gene ID, or UniProt accession. Returns a page of assay IDs (AIDs) — page past maxResults with offset — which can be explored further with pubchem_get_summary.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    targetType: z
      .enum(['genesymbol', 'proteinname', 'geneid', 'proteinaccession'])
      .describe(
        'Target identifier type. "genesymbol" and "proteinname" accept text names; a genesymbol matches the symbol case-insensitively across species, so a human symbol also returns assays on other species\' orthologs. "geneid" accepts NCBI Gene IDs. "proteinaccession" accepts UniProt accessions. "geneid" and "proteinaccession" each pin one protein, but return overlapping, different assay sets for it, since PubChem records some assays under only one of the two identifiers; for a complete list for one protein, union both.',
      ),
    targetQuery: z
      .string()
      .describe(
        'Target identifier. Examples: "EGFR" (genesymbol), "Epidermal growth factor receptor" (proteinname), "1956" (geneid), "P00533" (proteinaccession; uppercased before lookup, except a PDB chain ID such as the "A" in "1ZHH_A", which is kept as given).',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first AID to return. Pass the nextOffset from a previous call to read the following page. Default: 0.',
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(INPUT_CEILING)
      .default(50)
      .describe(
        `Max AIDs to return per page. The per-call cap is ${MAX_RESULTS_CAP}: a larger value (up to ${INPUT_CEILING}) returns a page of ${MAX_RESULTS_CAP} and is reported in cappedInputs. Popular targets may have thousands of assays; use offset to reach the ones past this page. Default: 50.`,
      ),
  }),
  // `targetQuery` is the only search term this tool takes, so the bare nouns a caller
  // reaches for resolve to it with nothing to disambiguate against.
  inputAliases: { query: 'targetQuery', target: 'targetQuery' },
  output: z.object({
    aids: z.array(z.number()).describe('PubChem Assay IDs.'),
  }),
  // Agent-facing context — target echo, the total across all pages, the page boundary, and a
  // notice distinguishing "no match" from "offset past the end".
  // Reaches structuredContent and content[] automatically; not in the domain return.
  enrichment: {
    targetType: z
      .string()
      .describe(
        'Target identifier type used: genesymbol, proteinname, geneid, or proteinaccession.',
      ),
    targetQuery: z.string().describe('Target identifier searched.'),
    totalFound: z.number().describe('Total AIDs found for this target, across all pages.'),
    offset: z.number().describe('Zero-based index of the first AID returned.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue past this page. Omitted when no further AIDs match.',
      ),
    truncated: z.boolean().optional().describe('True when matching AIDs remain past this page.'),
    shown: z.number().optional().describe('AIDs returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The page size applied: maxResults, or the per-call cap when maxResults exceeds it.',
      ),
    cappedInputs: cappedInputsField,
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no assays matched, when the offset runs past the result set, or when further pages remain. Absent when this page is complete and non-empty.',
      ),
  },
  enrichmentTrailer: {
    cappedInputs: { render: renderCappedInputs },
    notice: { render: renderNotice },
  },
  errors: [
    {
      reason: 'blank_target_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'targetQuery is empty or whitespace-only',
      recovery:
        'Provide a non-empty target identifier, e.g. "EGFR" for genesymbol or "1956" for geneid.',
    },
    {
      reason: 'invalid_geneid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'targetType is "geneid" but targetQuery contains characters other than digits',
      recovery:
        'Pass a numeric NCBI Gene ID (e.g. "1956"), or switch targetType to genesymbol/proteinname for text queries.',
    },
    {
      reason: 'target_query_rejected',
      code: JsonRpcErrorCode.ValidationError,
      // Raised by PubChemClient.searchAssaysByTarget when PubChem answers the lookup with 400.
      thrownBy: 'service',
      when: 'PubChem refused the target lookup with HTTP 400 — its answer for a targetQuery carrying a line break, another C0 control character other than tab and NUL, or DEL',
      recovery:
        'Remove line breaks and other control characters from targetQuery, and check that it matches targetType: an official gene symbol for genesymbol (e.g. "EGFR"), a protein name for proteinname, a UniProt accession for proteinaccession.',
    },
  ],

  async handler(input, ctx) {
    const client = getPubChemClient();

    // Reject inputs that cannot represent a useful target before the upstream call (#26).
    const trimmedQuery = input.targetQuery.trim();
    const targetQuery =
      input.targetType === 'proteinaccession'
        ? normalizeProteinAccession(trimmedQuery)
        : trimmedQuery;
    if (targetQuery.length === 0) {
      throw ctx.fail('blank_target_query');
    }
    // geneid targets are numeric NCBI Gene IDs — a non-numeric value is refused here, with
    // a geneid-specific hint and no request, rather than as PubChem's 400.
    if (input.targetType === 'geneid' && !/^\d+$/.test(targetQuery)) {
      throw ctx.fail(
        'invalid_geneid_query',
        `targetType is "geneid" but targetQuery "${clipEcho(input.targetQuery)}" is not a positive integer Gene ID.`,
      );
    }

    const allAids = await client.searchAssaysByTarget(input.targetType, targetQuery, ctx.signal);

    const capped: CappedInput[] = [];
    const pageSize = capPageSize('maxResults', input.maxResults, MAX_RESULTS_CAP, capped);
    const totalFound = allAids.length;
    // Offset is applied client-side: PubChem's target-to-AID endpoint returns the whole AID
    // list in one response, so searchAssaysByTarget already holds every match.
    const aids = allAids.slice(input.offset, input.offset + pageSize);
    const nextOffset = input.offset + aids.length;
    const hasMore = nextOffset < totalFound;

    ctx.log.info('Assay search completed', {
      targetType: input.targetType,
      targetQuery,
      totalFound,
      offset: input.offset,
      returned: aids.length,
    });

    // Agent-facing context: target echo, total, page boundary, and recovery notices.
    ctx.enrich({ targetType: input.targetType, targetQuery, totalFound, offset: input.offset });
    if (hasMore) ctx.enrich({ nextOffset });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });
    if (totalFound === 0) {
      ctx.enrich.notice(
        `No assays found for "${clipEcho(targetQuery)}" (${input.targetType}). Try a different targetType (e.g. switch from proteinname to genesymbol) or verify the identifier spelling. genesymbol takes the official gene symbol, e.g. "PTGS2" rather than "COX-2".`,
      );
    } else if (aids.length === 0) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the ${totalFound} AID(s) found for "${clipEcho(targetQuery)}". Pass an offset below ${totalFound}.`,
      );
    } else if (hasMore) {
      ctx.enrich.truncated({
        shown: aids.length,
        cap: pageSize,
        guidance: `Showing AIDs ${input.offset + 1}-${nextOffset} of ${totalFound}. Pass offset=${nextOffset} for the next page.`,
      });
    }

    return { aids };
  },

  format(result) {
    if (result.aids.length > 0) {
      return [{ type: 'text', text: `AIDs: ${result.aids.join(', ')}` }];
    }
    // Neutral wording: an empty page is either "no match" or "offset past the end" — the
    // enrichment trailer's notice says which.
    return [{ type: 'text', text: 'No assays returned.' }];
  },
});
