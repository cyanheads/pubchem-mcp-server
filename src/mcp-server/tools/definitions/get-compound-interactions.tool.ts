/**
 * @fileoverview Get drug-drug, drug-food, and chemical-target interactions for a compound.
 * @module mcp-server/tools/definitions/get-compound-interactions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { inlineData, quoteData } from './untrusted-text.js';

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
            text: z.string().describe('The interaction statement.'),
          })
          .describe('A single interaction entry.'),
      )
      .describe('Interaction entries across the requested kinds.'),
  }),
  // Agent-facing context — kind echo, total returned, failed kinds, and an empty-result notice.
  // Reaches structuredContent and content[]; keys disjoint from output (cid/entries).
  enrichment: {
    requestedKinds: z.string().describe('Interaction kinds requested (comma-separated).'),
    returnedCount: z.number().describe('Total interaction entries returned across all kinds.'),
    failedKinds: z
      .string()
      .optional()
      .describe(
        'Interaction kinds that could not be retrieved (comma-separated). The returned entries cover the kinds that succeeded; retry to re-attempt the failed ones.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no interaction data was found for the requested kinds.'),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const { entries, failedKinds } = await client.getInteractions(
      input.cid,
      input.kinds,
      input.maxEntries,
    );

    for (const f of failedKinds) {
      ctx.log.warning('Interaction kind failed', {
        cid: input.cid,
        kind: f.kind,
        error: f.message,
      });
    }
    ctx.log.info('Interactions fetched', {
      cid: input.cid,
      kinds: input.kinds,
      returned: entries.length,
      failed: failedKinds.length,
    });

    ctx.enrich({ requestedKinds: input.kinds.join(', '), returnedCount: entries.length });

    if (failedKinds.length > 0) {
      const names = failedKinds.map((f) => f.kind).join(', ');
      const plural = failedKinds.length > 1;
      ctx.enrich({ failedKinds: names });
      ctx.enrich.notice(
        `Could not retrieve ${names} interaction${plural ? 's' : ''} for CID ${input.cid}.${
          entries.length > 0 ? ' Returned the kinds that succeeded.' : ''
        } Retry to re-attempt ${plural ? 'them' : 'it'}.`,
      );
    } else if (entries.length === 0) {
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
      const partner = e.partner ? ` **${inlineData(e.partner)}**` : '';
      lines.push(`- (${e.kind})${partner} _(source: ${inlineData(e.source)})_`);
      // The interaction statement is upstream free text — render it as an
      // indented blockquote so the data/instruction boundary is explicit.
      for (const q of quoteData(e.text).split('\n')) lines.push(`  ${q}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
