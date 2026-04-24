/**
 * @fileoverview Get GHS hazard classification and safety data for a PubChem compound.
 * @module mcp-server/tools/definitions/get-compound-safety
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const getCompoundSafety = tool('pubchem_get_compound_safety', {
  title: 'Get Compound Safety',
  description:
    'Get GHS (Globally Harmonized System) hazard classification and safety data for a compound. ' +
    'Returns signal word, pictograms, hazard statements (H-codes), and precautionary statements (P-codes). ' +
    'Data sourced from PubChem depositors — source attribution included.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z.number().int().positive().describe('PubChem Compound ID.'),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    hasData: z.boolean().describe('Whether GHS safety data is available for this compound.'),
    ghs: z
      .object({
        signalWord: z.string().optional().describe('GHS signal word: "Danger" or "Warning".'),
        pictograms: z
          .array(z.string())
          .describe('GHS pictogram labels (e.g. "Flammable", "Toxic").'),
        hazardStatements: z
          .array(
            z
              .object({
                code: z.string().describe('H-code (e.g. "H225").'),
                statement: z.string().describe('Hazard statement text.'),
              })
              .describe('GHS hazard statement entry.'),
          )
          .describe('GHS hazard statements.'),
        precautionaryStatements: z
          .array(
            z
              .object({
                code: z.string().describe('P-code (e.g. "P210").'),
                statement: z.string().describe('Precautionary statement text.'),
              })
              .describe('GHS precautionary statement entry.'),
          )
          .describe('GHS precautionary statements.'),
      })
      .optional()
      .describe('GHS classification data.'),
    source: z.string().optional().describe('Data source attribution.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const data = await client.getSafetyData(input.cid);

    ctx.log.info('Safety data fetched', { cid: input.cid, hasData: data !== null });

    if (!data) {
      return { cid: input.cid, hasData: false };
    }

    return {
      cid: input.cid,
      hasData: true,
      ghs: {
        signalWord: data.signalWord,
        pictograms: data.pictograms,
        hazardStatements: data.hazardStatements,
        precautionaryStatements: data.precautionaryStatements,
      },
      source: data.source,
    };
  },

  format(result) {
    if (!result.hasData || !result.ghs) {
      return [{ type: 'text', text: `No GHS safety data available for CID ${result.cid}.` }];
    }

    const lines: string[] = [`## GHS Safety Data — CID ${result.cid}`, ''];
    const g = result.ghs;

    if (g.signalWord) lines.push(`**Signal Word:** ${g.signalWord}`);
    if (g.pictograms.length > 0) lines.push(`**Pictograms:** ${g.pictograms.join(', ')}`);

    if (g.hazardStatements.length > 0) {
      lines.push('', '**Hazard Statements:**');
      for (const h of g.hazardStatements) {
        lines.push(`  ${h.code}: ${h.statement}`);
      }
    }

    if (g.precautionaryStatements.length > 0) {
      lines.push('', '**Precautionary Statements:**');
      for (const p of g.precautionaryStatements) {
        lines.push(`  ${p.code}: ${p.statement}`);
      }
    }

    if (result.source) {
      lines.push('', `*Source: ${result.source}*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
