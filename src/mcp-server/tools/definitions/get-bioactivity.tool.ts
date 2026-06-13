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
    'Get a compound\'s bioactivity profile: which assays tested it, activity outcomes (Active/Inactive/Inconclusive), target identifiers (NCBI Gene ID, UniProt/GenBank accession), and quantitative values (IC50, EC50, Ki, etc.). Filter by outcome and/or a specific molecular target (NCBI Gene ID or protein accession) to focus the profile — e.g. "is this compound active against target T?".',
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
    outcomeFilter: z
      .enum(['active', 'inactive', 'all'])
      .default('all')
      .describe(
        'Filter by activity outcome. "active" shows only assays where the compound showed activity — most useful for understanding biological profile. Default: "all".',
      ),
    targetGeneId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Filter to assays against this NCBI Gene ID. Obtain Gene IDs from pubchem_search_assays or the targetGeneId field of an unfiltered result here. Combine with outcomeFilter="active" to answer "is this compound active against target T?".',
      ),
    targetAccession: z
      .string()
      .optional()
      .describe(
        'Filter to assays against this target protein accession (UniProt/GenBank), e.g. "P35354". Obtain accessions from pubchem_search_assays or the targetAccession field of an unfiltered result here.',
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
        z
          .object({
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
                z
                  .object({
                    name: z
                      .string()
                      .optional()
                      .describe(
                        'Measurement name (e.g. IC50, EC50, Ki). Omitted when not reported.',
                      ),
                    value: z.number().describe('Measured value.'),
                    unit: z
                      .string()
                      .optional()
                      .describe('Unit of measurement (e.g. uM, nM). Omitted when not reported.'),
                  })
                  .describe('Quantitative activity measurement entry.'),
              )
              .describe('Quantitative activity measurements.'),
          })
          .describe('Assay result entry.'),
      )
      .describe('Assay results matching the filter.'),
  }),
  // Agent-facing context — filter echo, the filtered/returned cap boundary, and a notice
  // distinguishing "no data" from "filter excluded everything". Reaches structuredContent
  // and content[]; keys disjoint from output (cid/totalAssays live there).
  enrichment: {
    outcomeFilter: z.string().describe('Outcome filter applied: active, inactive, or all.'),
    targetFilter: z
      .string()
      .optional()
      .describe('Target filter applied (gene ID and/or protein accession), when set.'),
    filteredCount: z
      .number()
      .describe('Assays matching the outcome and target filters, before the maxResults cap.'),
    returnedCount: z.number().describe('Assays returned after the maxResults cap.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when results were capped at maxResults — more matching assays exist.'),
    shown: z.number().optional().describe('Assays returned after the maxResults cap.'),
    cap: z.number().optional().describe('The maxResults cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when the filter yields no results or the compound has no bioactivity data.',
      ),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const allRows = await client.getAssaySummary(input.cid);

    const activeCount = allRows.filter((r) => r.outcome === 'Active').length;
    const inactiveCount = allRows.filter((r) => r.outcome === 'Inactive').length;

    // Filter by outcome, then by target — pure filters on rows already in hand
    // (targetGeneId/targetAccession are populated on every row by the assay summary parser).
    let filtered = allRows;
    if (input.outcomeFilter === 'active') {
      filtered = filtered.filter((r) => r.outcome === 'Active');
    } else if (input.outcomeFilter === 'inactive') {
      filtered = filtered.filter((r) => r.outcome === 'Inactive');
    }

    const targetLabel = [
      input.targetGeneId != null ? `GeneID:${input.targetGeneId}` : undefined,
      input.targetAccession ? `accession:${input.targetAccession}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (input.targetGeneId != null) {
      filtered = filtered.filter((r) => r.targetGeneId === input.targetGeneId);
    }
    if (input.targetAccession) {
      filtered = filtered.filter((r) => r.targetAccession === input.targetAccession);
    }

    const results = filtered.slice(0, input.maxResults);

    ctx.log.info('Bioactivity fetched', {
      cid: input.cid,
      total: allRows.length,
      active: activeCount,
      filtered: filtered.length,
      returned: results.length,
    });

    ctx.enrich({
      outcomeFilter: input.outcomeFilter,
      filteredCount: filtered.length,
      returnedCount: results.length,
    });
    if (targetLabel) ctx.enrich({ targetFilter: targetLabel });
    if (allRows.length === 0) {
      ctx.enrich.notice(
        `No bioactivity data found for CID ${input.cid}. The compound may be uncharacterized, or verify the CID with pubchem_search_compounds.`,
      );
    } else if (filtered.length === 0) {
      ctx.enrich.notice(
        targetLabel
          ? `CID ${input.cid} has ${allRows.length} assay(s) but none match the target filter (${targetLabel})${input.outcomeFilter !== 'all' ? ` with outcomeFilter="${input.outcomeFilter}"` : ''}. Verify the target identifier appears in this compound's assays, or widen the filter.`
          : `CID ${input.cid} has ${allRows.length} assay(s) but none match outcomeFilter="${input.outcomeFilter}". Use outcomeFilter="all" to see them.`,
      );
    } else if (filtered.length > results.length) {
      ctx.enrich.truncated({ shown: results.length, cap: input.maxResults });
    }

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
      for (const av of r.activityValues) {
        const label = av.name ?? 'Value';
        const unit = av.unit ?? '';
        lines.push(`  ${label}: ${av.value}${unit ? ` ${unit}` : ''}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
