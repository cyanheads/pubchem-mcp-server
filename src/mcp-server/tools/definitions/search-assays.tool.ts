/**
 * @fileoverview Find PubChem bioassays by biological target (gene symbol,
 * protein name, Gene ID, or UniProt accession).
 * @module mcp-server/tools/definitions/search-assays
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const searchAssays = tool('pubchem_search_assays', {
  title: 'Search Assays',
  description:
    'Find PubChem bioassays associated with a biological target. Search by gene symbol ' +
    '(e.g. "EGFR"), protein name, NCBI Gene ID, or UniProt accession. Returns assay IDs (AIDs) ' +
    'which can be explored further with pubchem_get_summary.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    targetType: z
      .enum(['genesymbol', 'proteinname', 'geneid', 'proteinaccession'])
      .describe(
        'Target identifier type. "genesymbol" and "proteinname" accept text names. ' +
          '"geneid" accepts NCBI Gene IDs. "proteinaccession" accepts UniProt accessions.',
      ),
    targetQuery: z
      .string()
      .describe(
        'Target identifier. Examples: "EGFR" (genesymbol), "Epidermal growth factor receptor" ' +
          '(proteinname), "1956" (geneid), "P00533" (proteinaccession).',
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
    targetType: z.string().describe('Target identifier type used.'),
    targetQuery: z.string().describe('Target identifier searched.'),
    totalFound: z.number().describe('Total AIDs found.'),
    aids: z.array(z.number()).describe('PubChem Assay IDs.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const allAids = await client.searchAssaysByTarget(input.targetType, input.targetQuery);

    const totalFound = allAids.length;
    const aids = allAids.slice(0, input.maxResults);

    ctx.log.info('Assay search completed', {
      targetType: input.targetType,
      targetQuery: input.targetQuery,
      totalFound,
      returned: aids.length,
    });

    return {
      targetType: input.targetType,
      targetQuery: input.targetQuery,
      totalFound,
      aids,
    };
  },

  format(result) {
    const truncated =
      result.totalFound > result.aids.length
        ? ` (showing ${result.aids.length} of ${result.totalFound})`
        : '';

    const lines = [
      `Found ${result.totalFound} assay${result.totalFound !== 1 ? 's' : ''} for "${result.targetQuery}" (${result.targetType})${truncated}`,
      '',
    ];

    if (result.aids.length > 0) {
      lines.push(`AIDs: ${result.aids.join(', ')}`);
    } else {
      lines.push('No assays found.');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
