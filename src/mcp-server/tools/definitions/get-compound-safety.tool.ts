/**
 * @fileoverview Get GHS hazard classification and safety data for PubChem compounds (batched).
 * @module mcp-server/tools/definitions/get-compound-safety
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import type { GHSClassification } from '@/services/pubchem/types.js';

const ghsSchema = z
  .object({
    signalWord: z.string().optional().describe('GHS signal word: "Danger" or "Warning".'),
    pictograms: z.array(z.string()).describe('GHS pictogram labels (e.g. "Flammable", "Toxic").'),
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
  .describe('GHS classification data.');

/** Fan-out cap: at most this many PUG View calls in flight at once (mirrors get_compound_details). */
const MAX_IN_FLIGHT = 10;

export const getCompoundSafety = tool('pubchem_get_compound_safety', {
  title: 'Get Compound Safety',
  description:
    'Get GHS (Globally Harmonized System) hazard classification and safety data for one or more compounds by CID. Returns signal word, pictograms, hazard statements (H-codes), and precautionary statements (P-codes) per compound. Data sourced from PubChem depositors — source attribution included.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cids: z
      .array(z.number().int().positive())
      .min(1)
      .max(25)
      .describe(
        'PubChem Compound IDs to fetch safety data for (1-25). Resolve from names/SMILES with pubchem_search_compounds.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            cid: z.number().describe('PubChem Compound ID.'),
            hasData: z
              .boolean()
              .describe('Whether GHS safety data is available for this compound.'),
            ghs: ghsSchema.optional(),
            source: z.string().optional().describe('Data source attribution.'),
          })
          .describe('Per-CID safety result.'),
      )
      .describe('Safety results, one per requested CID (input order preserved).'),
  }),
  // Agent-facing context — requested/with-data counts and a cross-tool notice listing the CIDs
  // that lack GHS data. Reaches structuredContent and content[]; keys disjoint from output.
  enrichment: {
    requestedCount: z.number().describe('CIDs requested.'),
    withDataCount: z.number().describe('CIDs with GHS safety data available.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Cross-tool guidance when one or more CIDs have no GHS data, pointing to an alternative source.',
      ),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();

    // Fan out per CID, capped at MAX_IN_FLIGHT in flight.
    const dataByCid = new Map<number, GHSClassification | null>();
    for (let i = 0; i < input.cids.length; i += MAX_IN_FLIGHT) {
      const chunk = input.cids.slice(i, i + MAX_IN_FLIGHT);
      const chunkData = await Promise.all(
        chunk.map(async (cid) => [cid, await client.getSafetyData(cid)] as const),
      );
      for (const [cid, data] of chunkData) dataByCid.set(cid, data);
    }

    const results = input.cids.map((cid) => {
      const data = dataByCid.get(cid) ?? null;
      if (!data) return { cid, hasData: false as const };
      return {
        cid,
        hasData: true as const,
        ghs: {
          signalWord: data.signalWord,
          pictograms: data.pictograms,
          hazardStatements: data.hazardStatements,
          precautionaryStatements: data.precautionaryStatements,
        },
        source: data.source,
      };
    });

    const withDataCount = results.filter((r) => r.hasData).length;

    ctx.log.info('Safety data fetched', {
      requested: input.cids.length,
      withData: withDataCount,
    });

    ctx.enrich({ requestedCount: input.cids.length, withDataCount });
    if (withDataCount < input.cids.length) {
      const missing = results.filter((r) => !r.hasData).map((r) => r.cid);
      ctx.enrich.notice(
        `No GHS classification on file for ${missing.length} of ${input.cids.length} CID(s): ${missing.join(', ')}. Try pubchem_get_compound_details with includeDescription for hazard context, or those compounds may simply lack deposited safety data.`,
      );
    }

    return { results };
  },

  format(result) {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No compounds requested.' }];
    }

    const blocks: string[] = [];
    for (const r of result.results) {
      if (!r.hasData || !r.ghs) {
        blocks.push(`## CID ${r.cid} — no GHS safety data`, '');
        continue;
      }

      const lines: string[] = [`## GHS Safety Data — CID ${r.cid}`];
      const g = r.ghs;

      if (g.signalWord) lines.push(`**Signal Word:** ${g.signalWord}`);
      if (g.pictograms.length > 0) lines.push(`**Pictograms:** ${g.pictograms.join(', ')}`);

      if (g.hazardStatements.length > 0) {
        lines.push('', '**Hazard Statements:**');
        for (const h of g.hazardStatements) lines.push(`  ${h.code}: ${h.statement}`);
      }

      if (g.precautionaryStatements.length > 0) {
        lines.push('', '**Precautionary Statements:**');
        for (const p of g.precautionaryStatements) {
          lines.push(p.statement ? `  ${p.code}: ${p.statement}` : `  ${p.code}`);
        }
      }

      if (r.source) lines.push('', `*Source: ${r.source}*`);

      blocks.push(lines.join('\n'), '');
    }

    return [{ type: 'text', text: blocks.join('\n') }];
  },
});
