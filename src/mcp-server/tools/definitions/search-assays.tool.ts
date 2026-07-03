/**
 * @fileoverview Find PubChem bioassays by biological target (gene symbol,
 * protein name, Gene ID, or UniProt accession).
 * @module mcp-server/tools/definitions/search-assays
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const searchAssays = tool('pubchem_search_assays', {
  title: 'Search Assays',
  description:
    'Find PubChem bioassays associated with a biological target. Search by gene symbol (e.g. "EGFR"), protein name, NCBI Gene ID, or UniProt accession. Returns assay IDs (AIDs) which can be explored further with pubchem_get_summary.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    targetType: z
      .enum(['genesymbol', 'proteinname', 'geneid', 'proteinaccession'])
      .describe(
        'Target identifier type. "genesymbol" and "proteinname" accept text names. "geneid" accepts NCBI Gene IDs. "proteinaccession" accepts UniProt accessions.',
      ),
    targetQuery: z
      .string()
      .describe(
        'Target identifier. Examples: "EGFR" (genesymbol), "Epidermal growth factor receptor" (proteinname), "1956" (geneid), "P00533" (proteinaccession).',
      ),
    maxResults: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe(
        'Max AIDs to return (1-200). Popular targets may have thousands of assays. Default: 50.',
      ),
  }),
  output: z.object({
    aids: z.array(z.number()).describe('PubChem Assay IDs.'),
  }),
  // Agent-facing context — target echo, total before cap, and an empty-result notice.
  // Reaches structuredContent and content[] automatically; not in the domain return.
  enrichment: {
    targetType: z
      .string()
      .describe(
        'Target identifier type used: genesymbol, proteinname, geneid, or proteinaccession.',
      ),
    targetQuery: z.string().describe('Target identifier searched.'),
    totalFound: z.number().describe('Total AIDs found before the maxResults cap.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when AIDs were capped at maxResults — more assays exist than returned.'),
    shown: z.number().optional().describe('AIDs returned after the maxResults cap.'),
    cap: z.number().optional().describe('The maxResults cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no assays matched — echoes the target and suggests alternative search types. Absent when assays were returned.',
      ),
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
      when: 'targetType is "geneid" but targetQuery is not a positive integer',
      recovery:
        'Pass a numeric NCBI Gene ID (e.g. "1956"), or switch targetType to genesymbol/proteinname for text queries.',
    },
  ],

  async handler(input, ctx) {
    const client = getPubChemClient();

    // Reject inputs that cannot represent a useful target before the upstream call (#26).
    const targetQuery = input.targetQuery.trim();
    if (targetQuery.length === 0) {
      throw ctx.fail('blank_target_query', undefined, {
        ...ctx.recoveryFor('blank_target_query'),
      });
    }
    // geneid targets are numeric NCBI Gene IDs — a non-numeric value otherwise hits a raw
    // PubChem 400 (searchAssaysByTarget only special-cases 404).
    if (input.targetType === 'geneid' && !/^\d+$/.test(targetQuery)) {
      throw ctx.fail(
        'invalid_geneid_query',
        `targetType is "geneid" but targetQuery "${input.targetQuery}" is not a positive integer Gene ID.`,
        { ...ctx.recoveryFor('invalid_geneid_query') },
      );
    }

    const allAids = await client.searchAssaysByTarget(input.targetType, targetQuery);

    const totalFound = allAids.length;
    const aids = allAids.slice(0, input.maxResults);

    ctx.log.info('Assay search completed', {
      targetType: input.targetType,
      targetQuery,
      totalFound,
      returned: aids.length,
    });

    // Agent-facing context: target echo, total, and empty-result notice.
    ctx.enrich({ targetType: input.targetType, targetQuery, totalFound });
    if (aids.length === 0) {
      ctx.enrich.notice(
        `No assays found for "${targetQuery}" (${input.targetType}). Try a different targetType (e.g. switch from proteinname to genesymbol), verify the identifier spelling, or use pubchem_get_summary for gene/protein entity lookups.`,
      );
    } else if (totalFound > aids.length) {
      ctx.enrich.truncated({ shown: aids.length, cap: input.maxResults });
    }

    return { aids };
  },

  format(result) {
    if (result.aids.length > 0) {
      return [{ type: 'text', text: `AIDs: ${result.aids.join(', ')}` }];
    }
    return [{ type: 'text', text: 'No assays found.' }];
  },
});
