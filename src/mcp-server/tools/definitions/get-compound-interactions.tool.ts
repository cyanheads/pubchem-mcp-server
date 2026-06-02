/**
 * @fileoverview Get drug-drug, drug-food, and chemical-target interactions for a compound.
 * @module mcp-server/tools/definitions/get-compound-interactions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const getCompoundInteractions = tool('pubchem_get_compound_interactions', {
  title: 'Get Compound Interactions',
  description:
    "Get a compound's interaction data: drug-drug interactions (DrugBank), drug-food interactions, and chemical-target interactions (binding/activity from BindingDB, ChEMBL, and others). Each entry carries its originating source. Richest for approved drugs; many compounds have no deposited interaction records.",
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
    kinds: z
      .array(z.enum(['drug-drug', 'drug-food', 'target']))
      .min(1)
      .default(['drug-drug'])
      .describe(
        'Interaction kinds to fetch. "drug-drug" (interactions with other drugs), "drug-food" (dietary interactions), "target" (binding/activity against molecular targets). Default: ["drug-drug"].',
      ),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Max entries per kind (1-50). Well-studied drugs have a long tail of interactions. Default: 10.',
      ),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    entries: z
      .array(
        z
          .object({
            kind: z.enum(['drug-drug', 'drug-food', 'target']).describe('Interaction category.'),
            partner: z
              .string()
              .optional()
              .describe('Interacting compound, food, or target name as the source reports it.'),
            source: z.string().describe('Originating source (e.g. "DrugBank", "BindingDB").'),
            severity: z
              .string()
              .optional()
              .describe(
                'Raw severity as the source reports it — not normalized across sources, and frequently unset (most sources embed severity in the statement text).',
              ),
            text: z.string().describe('The interaction statement.'),
          })
          .describe('A single interaction entry.'),
      )
      .describe('Interaction entries across the requested kinds.'),
  }),
  // Agent-facing context — kind echo, total returned, and an empty-result notice.
  // Reaches structuredContent and content[]; keys disjoint from output (cid/entries).
  enrichment: {
    requestedKinds: z.string().describe('Interaction kinds requested (comma-separated).'),
    returnedCount: z.number().describe('Total interaction entries returned across all kinds.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no interaction data was found for the requested kinds.'),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const entries = await client.getInteractions(input.cid, input.kinds, input.maxEntries);

    ctx.log.info('Interactions fetched', {
      cid: input.cid,
      kinds: input.kinds,
      returned: entries.length,
    });

    ctx.enrich({ requestedKinds: input.kinds.join(', '), returnedCount: entries.length });
    if (entries.length === 0) {
      ctx.enrich.notice(
        `No ${input.kinds.join('/')} interaction data found for CID ${input.cid}. PubChem has no deposited interaction records for this compound — coverage is richest for approved drugs.`,
      );
    }

    return { cid: input.cid, entries };
  },

  format(result) {
    const lines: string[] = [`## Interactions — CID ${result.cid}`, ''];

    if (result.entries.length === 0) {
      lines.push('No interaction data found.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const e of result.entries) {
      const partner = e.partner ? ` **${e.partner}**` : '';
      const severity = e.severity ? ` [severity: ${e.severity}]` : '';
      lines.push(`- (${e.kind})${partner}${severity} ${e.text} _(source: ${e.source})_`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
