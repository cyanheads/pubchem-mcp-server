/**
 * @fileoverview Get GHS hazard classification and safety data for PubChem compounds (batched).
 * @module mcp-server/tools/definitions/get-compound-safety
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import type { SafetyLookup } from '@/services/pubchem/types.js';
import { inlineData } from './untrusted-text.js';

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
            statement: z
              .string()
              .describe(
                'Standard precautionary statement text for the code. Empty string when "decoded" is false — PubChem deposits P-codes without text, so a blank statement means the code was not decoded, never that the depositor supplied an empty statement.',
              ),
            decoded: z
              .boolean()
              .describe(
                'Whether "statement" carries the standard text. False for codes needing label-specific fill text the depositor must supply (disposal method, firefighting agent, first-aid reference) and for codes outside the decoder table; the code itself is still authoritative.',
              ),
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
            status: z
              .enum(['ok', 'no_ghs_data', 'cid_not_found'])
              .describe(
                'Outcome for this CID. "ok": GHS data returned. "no_ghs_data": the compound exists in PubChem but has no deposited GHS classification. "cid_not_found": PubChem has no record for this CID at all — the identifier is wrong, so verify it with pubchem_search_compounds rather than concluding the compound is unclassified.',
              ),
            ghs: ghsSchema.optional(),
            source: z.string().optional().describe('Data source attribution.'),
          })
          .describe('Per-CID safety result.'),
      )
      .describe('Safety results, one per requested CID (input order preserved).'),
  }),
  // Agent-facing context — requested/with-data counts and a notice that names the CIDs behind
  // each non-ok status separately. Reaches structuredContent and content[]; keys disjoint from
  // output.
  enrichment: {
    requestedCount: z.number().describe('CIDs requested.'),
    withDataCount: z.number().describe('CIDs with GHS safety data available.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when one or more CIDs returned no GHS data, listing the unrecognized CIDs to verify separately from the CIDs that exist but carry no deposited classification.',
      ),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();

    // Fan out per CID, capped at MAX_IN_FLIGHT in flight.
    const lookupByCid = new Map<number, SafetyLookup>();
    for (let i = 0; i < input.cids.length; i += MAX_IN_FLIGHT) {
      const chunk = input.cids.slice(i, i + MAX_IN_FLIGHT);
      const chunkData = await Promise.all(
        chunk.map(async (cid) => [cid, await client.getSafetyData(cid)] as const),
      );
      for (const [cid, lookup] of chunkData) lookupByCid.set(cid, lookup);
    }

    const results = input.cids.map((cid) => {
      const lookup = lookupByCid.get(cid) ?? { status: 'no_ghs_data' as const };
      if (lookup.status !== 'ok') return { cid, hasData: false, status: lookup.status };
      return {
        cid,
        hasData: true,
        status: lookup.status,
        ghs: {
          signalWord: lookup.ghs.signalWord,
          pictograms: lookup.ghs.pictograms,
          hazardStatements: lookup.ghs.hazardStatements,
          precautionaryStatements: lookup.ghs.precautionaryStatements,
        },
        source: lookup.ghs.source,
      };
    });

    const withDataCount = results.filter((r) => r.hasData).length;
    const unknownCids = results.filter((r) => r.status === 'cid_not_found').map((r) => r.cid);
    const noDataCids = results.filter((r) => r.status === 'no_ghs_data').map((r) => r.cid);

    ctx.log.info('Safety data fetched', {
      requested: input.cids.length,
      withData: withDataCount,
      notFound: unknownCids.length,
    });

    ctx.enrich({ requestedCount: input.cids.length, withDataCount });

    // Unknown CIDs lead: a wrong identifier invalidates the question, whereas a real compound
    // without GHS data is a real answer. Collapsing the two is what made a mistyped CID read
    // as a confident "no hazards on file".
    const notices: string[] = [];
    if (unknownCids.length > 0) {
      notices.push(
        `PubChem has no record for ${unknownCids.length} of ${input.cids.length} CID(s): ${unknownCids.join(', ')} — verify the CID with pubchem_search_compounds. Nothing was evaluated for these identifiers, so they say nothing about any compound's hazards.`,
      );
    }
    if (noDataCids.length > 0) {
      notices.push(
        `No GHS classification on file for ${noDataCids.length} of ${input.cids.length} CID(s): ${noDataCids.join(', ')}. These compounds exist in PubChem but have no deposited safety data — try pubchem_get_compound_details with includeDescription for hazard context.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { results };
  },

  format(result) {
    if (result.results.length === 0) {
      return [{ type: 'text', text: 'No compounds requested.' }];
    }

    const blocks: string[] = [];
    for (const r of result.results) {
      if (!r.hasData || !r.ghs) {
        blocks.push(
          ...(r.status === 'cid_not_found'
            ? [
                `## CID ${r.cid} — no PubChem record`,
                '**Status:** cid_not_found — PubChem has no compound with this CID, so nothing was evaluated for safety. Verify it with pubchem_search_compounds.',
              ]
            : [
                `## CID ${r.cid} — no GHS safety data`,
                '**Status:** no_ghs_data — the compound exists in PubChem but has no deposited GHS classification.',
              ]),
          '',
        );
        continue;
      }

      const lines: string[] = [`## GHS Safety Data — CID ${r.cid}`, `**Status:** ${r.status}`];
      const g = r.ghs;

      if (g.signalWord) lines.push(`**Signal Word:** ${g.signalWord}`);
      if (g.pictograms.length > 0) lines.push(`**Pictograms:** ${g.pictograms.join(', ')}`);

      if (g.hazardStatements.length > 0) {
        lines.push('', '**Hazard Statements:**');
        for (const h of g.hazardStatements) lines.push(`  ${h.code}: ${inlineData(h.statement)}`);
      }

      if (g.precautionaryStatements.length > 0) {
        lines.push(
          '',
          '**Precautionary Statements:** (PubChem deposits bare P-codes; any not decoded below is a decoder gap or a code needing label-specific fill text, not an empty statement)',
        );
        for (const p of g.precautionaryStatements) {
          lines.push(
            p.decoded ? `  ${p.code}: ${inlineData(p.statement)}` : `  ${p.code}: (not decoded)`,
          );
        }
      }

      if (r.source) lines.push('', `*Source: ${inlineData(r.source)}*`);

      blocks.push(lines.join('\n'), '');
    }

    return [{ type: 'text', text: blocks.join('\n') }];
  },
});
