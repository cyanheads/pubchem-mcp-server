/**
 * @fileoverview Get a compound's bioactivity profile — which assays tested it,
 * activity outcomes, target information, and quantitative values.
 * @module mcp-server/tools/definitions/get-bioactivity
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const getBioactivity = tool('pubchem_get_bioactivity', {
  title: 'Get Bioactivity',
  description:
    "Get a compound's bioactivity profile: which assays tested it, activity outcomes " +
    '(Active/Inactive/Inconclusive), target information (gene symbols, protein names), ' +
    'and quantitative values (IC50, EC50, Ki, etc.). Filter by outcome to focus on active results.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z.number().int().positive().describe('PubChem Compound ID.'),
    outcomeFilter: z
      .enum(['active', 'inactive', 'all'])
      .default('all')
      .describe(
        'Filter by activity outcome. "active" shows only assays where the compound showed activity — ' +
          'most useful for understanding biological profile. Default: "all".',
      ),
    maxResults: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Max assay results to return (1-100). Well-studied compounds have thousands of records. Default: 20.',
      ),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    totalAssays: z.number().describe('Total unique assays for this compound.'),
    activeCount: z.number().describe('Assays with "Active" outcome.'),
    inactiveCount: z.number().describe('Assays with "Inactive" outcome.'),
    results: z
      .array(
        z.object({
          aid: z.number().describe('PubChem Assay ID.'),
          assayName: z.string().describe('Assay name/title.'),
          outcome: z
            .string()
            .describe('Activity outcome: Active, Inactive, Inconclusive, Unspecified.'),
          targetAccession: z
            .string()
            .optional()
            .describe('Target protein accession (UniProt/GenBank).'),
          targetGeneId: z.number().optional().describe('Target NCBI Gene ID.'),
          activityValues: z
            .array(
              z.object({
                name: z.string().describe('Measurement name (e.g. IC50, EC50, Ki).'),
                value: z.number().describe('Measured value.'),
                unit: z.string().describe('Unit of measurement (e.g. uM, nM).'),
              }),
            )
            .describe('Quantitative activity measurements.'),
        }),
      )
      .describe('Assay results matching the filter.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const allRows = await client.getAssaySummary(input.cid);

    const activeCount = allRows.filter((r) => r.outcome === 'Active').length;
    const inactiveCount = allRows.filter((r) => r.outcome === 'Inactive').length;

    // Filter by outcome
    let filtered = allRows;
    if (input.outcomeFilter === 'active') {
      filtered = allRows.filter((r) => r.outcome === 'Active');
    } else if (input.outcomeFilter === 'inactive') {
      filtered = allRows.filter((r) => r.outcome === 'Inactive');
    }

    const results = filtered.slice(0, input.maxResults);

    ctx.log.info('Bioactivity fetched', {
      cid: input.cid,
      total: allRows.length,
      active: activeCount,
      returned: results.length,
    });

    return {
      cid: input.cid,
      totalAssays: allRows.length,
      activeCount,
      inactiveCount,
      results,
    };
  },

  format(result) {
    const lines: string[] = [
      `## Bioactivity — CID ${result.cid}`,
      `Total assays: ${result.totalAssays} | Active: ${result.activeCount} | Inactive: ${result.inactiveCount}`,
      '',
    ];

    if (result.results.length === 0) {
      lines.push('No matching assay results.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      const target = [r.targetGeneId ? `GeneID:${r.targetGeneId}` : undefined, r.targetAccession]
        .filter(Boolean)
        .join(' — ');
      lines.push(`**AID ${r.aid}** — ${r.assayName} (${r.outcome})`);
      if (target) lines.push(`  Target: ${target}`);
      const meaningful = r.activityValues.filter((av) => av.name);
      for (const av of meaningful) {
        lines.push(`  ${av.name}: ${av.value} ${av.unit}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
