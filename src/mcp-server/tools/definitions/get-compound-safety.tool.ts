/**
 * @fileoverview Get GHS hazard classification and safety data for PubChem compounds (batched).
 * @module mcp-server/tools/definitions/get-compound-safety
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { MAX_CID, type SafetyLookup } from '@/services/pubchem/types.js';
import {
  type CappedInput,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
  renderUnprocessed,
  splitBatch,
} from './input-caps.js';
import { inlineData } from './untrusted-text.js';

const classificationSchema = z
  .object({
    source: z
      .string()
      .optional()
      .describe(
        'Depositing source (e.g. "European Chemicals Agency (ECHA)", "NITE-CMC"). Omitted when PubChem names no reference for the classification.',
      ),
    sourceRecord: z
      .string()
      .optional()
      .describe(
        'The source\'s own record title (e.g. "Ethanol - FY2013 (Revised classification)", "Ethanol (EC: 200-578-6)"). Tells revisions of one source, and the ECHA C&L aggregate from single-company ECHA notifications, apart.',
      ),
    signalWord: z
      .string()
      .optional()
      .describe("This classification's signal word. Omitted when the source assigns none."),
    pictograms: z.array(z.string()).describe("This classification's pictogram labels."),
    hazardCodes: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'H-code (e.g. "H319"). Statement text is in the top-level hazardStatements.',
              ),
            agreement: z
              .string()
              .optional()
              .describe(
                'Share of notifying companies that assigned this code, exactly as PubChem prints it (e.g. "37.7%", "> 99.9%"). Present only where PubChem prints one beside the code, which is ECHA C&L classifications; read it against "notifications" — a single-company notification reports 100%.',
              ),
          })
          .describe('Hazard code assigned by this classification.'),
      )
      .describe('Hazard codes this classification assigns. Empty for a "Not Classified" verdict.'),
    notClassified: z
      .boolean()
      .optional()
      .describe(
        'True when this classification is ECHA\'s "Not Classified" verdict: notifiers assessed the compound and found it meets no GHS hazard criteria. Omitted otherwise.',
      ),
    notifications: z
      .string()
      .optional()
      .describe(
        'Notifier counts behind an ECHA classification: the first line of ECHA\'s C&L notifications summary (e.g. "Aggregated GHS information provided per 13886 reports by companies from 79 notifications…"), or for a "Not Classified" verdict the verdict line (e.g. "Reported as not meeting GHS hazard criteria by 188 of 203 companies…"). Omitted for sources that deposit no counts.',
      ),
  })
  .describe("One source's GHS classification, kept whole.");

const ghsSchema = z
  .object({
    signalWord: z
      .string()
      .optional()
      .describe(
        'GHS signal word, "Danger" or "Warning": the most severe any classification assigns. Omitted when none assigns one.',
      ),
    pictograms: z
      .array(z.string())
      .describe(
        'GHS pictogram labels (e.g. "Flammable", "Acute Toxic"), union across classifications.',
      ),
    hazardStatements: z
      .array(
        z
          .object({
            code: z.string().describe('H-code (e.g. "H225").'),
            statement: z.string().describe('Hazard statement text.'),
          })
          .describe('GHS hazard statement entry.'),
      )
      .describe(
        'GHS hazard statements, union across classifications. A code here may come from a single source — see classifications for which source assigned it and with what notifier agreement.',
      ),
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
      .describe('GHS precautionary statements, union across classifications.'),
    classifications: z
      .array(classificationSchema)
      .describe(
        "Each source's classification in PubChem's order — EU harmonised, the ECHA C&L aggregate, single-company ECHA notifications, NITE-CMC revisions, and others. Sources can disagree; the top-level fields merge them.",
      ),
  })
  .describe('GHS classification data.');

/** One line per source classification: who, which record, then its own label. */
function formatClassification(c: z.infer<typeof classificationSchema>): string {
  const who = [c.source ?? 'Source not named', c.sourceRecord]
    .filter((s): s is string => s !== undefined)
    .map(inlineData)
    .join(' — ');
  const parts = [
    c.notClassified && 'Not Classified',
    c.signalWord && inlineData(c.signalWord),
    c.pictograms.map(inlineData).join(', '),
    c.hazardCodes
      .map((h) => (h.agreement ? `${h.code} (${inlineData(h.agreement)})` : h.code))
      .join(', '),
    c.notifications && inlineData(c.notifications),
  ];
  return `${who}: ${parts.filter(Boolean).join(' · ')}`;
}

/** Fan-out cap: at most this many PUG View calls in flight at once (mirrors get_compound_details). */
const MAX_IN_FLIGHT = 10;

/** CIDs looked up per call; CIDs past this are returned in unprocessed. */
const CIDS_CAP = 25;

export const getCompoundSafety = tool('pubchem_get_compound_safety', {
  title: 'Get Compound Safety',
  description:
    'Get GHS (Globally Harmonized System) hazard classification and safety data for one or more compounds by CID. Returns signal word, pictograms, hazard statements (H-codes), and precautionary statements (P-codes) per compound, merged across sources, plus each source\'s own classification — its signal word, pictograms, H-codes with ECHA notifier agreement percentages, and notification counts — since sources often disagree. Reports ECHA "Not Classified" verdicts as their own status.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cids: z
      .array(z.number().int().min(1).max(MAX_CID))
      .min(1)
      .max(INPUT_CEILING)
      .describe(
        `PubChem Compound IDs to fetch safety data for. The per-call cap is ${CIDS_CAP}: the first ${CIDS_CAP} are looked up, and any past that (up to ${INPUT_CEILING} in all) are returned in unprocessed, in input order, and reported in cappedInputs. Resolve from names/SMILES with pubchem_search_compounds.`,
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
              .describe(
                'Whether a GHS classification is on file for this compound (status "ok" or "not_classified"); "ghs" is present exactly when this is true.',
              ),
            status: z
              .enum(['ok', 'not_classified', 'no_ghs_data', 'cid_not_found'])
              .describe(
                'Outcome for this CID. "ok": GHS hazard classification returned. "not_classified": every deposited classification is an ECHA "Not Classified" verdict — notifiers assessed the compound and found it meets no GHS hazard criteria; the verdicts and their notifier counts are in ghs.classifications. "no_ghs_data": the compound exists in PubChem but has no deposited GHS classification. "cid_not_found": PubChem has no record for this CID at all — the identifier is wrong, so verify it with pubchem_search_compounds rather than concluding the compound is unclassified.',
              ),
            ghs: ghsSchema.optional(),
            source: z
              .string()
              .optional()
              .describe(
                'Sources that deposited a GHS classification, in PubChem\'s order, joined with "; ".',
              ),
          })
          .describe('Per-CID safety result.'),
      )
      .describe(
        'Safety results, one per CID looked up (input order preserved). CIDs past the per-call cap are in unprocessed instead.',
      ),
    unprocessed: z
      .array(z.number())
      .optional()
      .describe(
        `CIDs past the per-call cap of ${CIDS_CAP}, in input order, not looked up. Pass them in a follow-up call. Omitted when every CID was looked up.`,
      ),
  }),
  // Agent-facing context — requested/with-data counts and a notice that names the CIDs behind
  // each non-ok status separately. Reaches structuredContent and content[]; keys disjoint from
  // output.
  enrichment: {
    requestedCount: z
      .number()
      .describe('CIDs requested, including any past the per-call cap left in unprocessed.'),
    withDataCount: z
      .number()
      .describe('CIDs with a GHS classification on file (status "ok" or "not_classified").'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when one or more CIDs returned no hazard classification, listing the unrecognized CIDs to verify, the CIDs that exist but carry no deposited classification, and the CIDs whose only classifications are "Not Classified" verdicts, each separately.',
      ),
    cappedInputs: cappedInputsField,
  },
  enrichmentTrailer: { cappedInputs: { render: renderCappedInputs } },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const capped: CappedInput[] = [];
    const { served: cids, unprocessed } = splitBatch('cids', input.cids, CIDS_CAP, capped);

    // Fan out per CID, capped at MAX_IN_FLIGHT in flight.
    const lookupByCid = new Map<number, SafetyLookup>();
    for (let i = 0; i < cids.length; i += MAX_IN_FLIGHT) {
      const chunk = cids.slice(i, i + MAX_IN_FLIGHT);
      const chunkData = await Promise.all(
        chunk.map(async (cid) => [cid, await client.getSafetyData(cid, ctx.signal)] as const),
      );
      for (const [cid, lookup] of chunkData) lookupByCid.set(cid, lookup);
    }

    const results = cids.map((cid) => {
      const lookup = lookupByCid.get(cid) ?? { status: 'no_ghs_data' as const };
      if (lookup.status === 'no_ghs_data' || lookup.status === 'cid_not_found') {
        return { cid, hasData: false, status: lookup.status };
      }
      return {
        cid,
        hasData: true,
        status: lookup.status,
        ghs: {
          signalWord: lookup.ghs.signalWord,
          pictograms: lookup.ghs.pictograms,
          hazardStatements: lookup.ghs.hazardStatements,
          precautionaryStatements: lookup.ghs.precautionaryStatements,
          classifications: lookup.ghs.classifications,
        },
        source: lookup.ghs.source,
      };
    });

    const withDataCount = results.filter((r) => r.hasData).length;
    const unknownCids = results.filter((r) => r.status === 'cid_not_found').map((r) => r.cid);
    const noDataCids = results.filter((r) => r.status === 'no_ghs_data').map((r) => r.cid);
    const notClassifiedCids = results
      .filter((r) => r.status === 'not_classified')
      .map((r) => r.cid);

    ctx.log.info('Safety data fetched', {
      requested: input.cids.length,
      unprocessed: unprocessed.length,
      withData: withDataCount,
      notFound: unknownCids.length,
    });

    ctx.enrich({ requestedCount: input.cids.length, withDataCount });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });

    // Unknown CIDs lead: a wrong identifier invalidates the question, whereas a real compound
    // without GHS data is a real answer. Collapsing the two is what made a mistyped CID read
    // as a confident "no hazards on file".
    const notices: string[] = [];
    if (unknownCids.length > 0) {
      notices.push(
        `PubChem has no record for ${unknownCids.length} of ${cids.length} CID(s): ${unknownCids.join(', ')} — verify the CID with pubchem_search_compounds. Nothing was evaluated for these identifiers, so they say nothing about any compound's hazards.`,
      );
    }
    if (noDataCids.length > 0) {
      notices.push(
        `No GHS classification on file for ${noDataCids.length} of ${cids.length} CID(s): ${noDataCids.join(', ')}. These compounds exist in PubChem but have no deposited safety data — try pubchem_get_compound_details with includeDescription for hazard context.`,
      );
    }
    if (notClassifiedCids.length > 0) {
      notices.push(
        `Not classified under GHS for ${notClassifiedCids.length} of ${cids.length} CID(s): ${notClassifiedCids.join(', ')}. Every deposited classification is an ECHA "Not Classified" verdict — notifiers assessed these compounds and found they meet no GHS hazard criteria, which is an assessment, not missing data. The notifier counts are in ghs.classifications[].notifications.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return unprocessed.length > 0 ? { results, unprocessed } : { results };
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

      const lines: string[] = [
        `## GHS Safety Data — CID ${r.cid}`,
        r.status === 'not_classified'
          ? '**Status:** not_classified — every deposited classification is an ECHA "Not Classified" verdict: notifiers assessed the compound and found it meets no GHS hazard criteria.'
          : `**Status:** ${r.status}`,
      ];
      const g = r.ghs;

      if (g.signalWord) lines.push(`**Signal Word:** ${g.signalWord}`);
      if (g.pictograms.length > 0) lines.push(`**Pictograms:** ${g.pictograms.join(', ')}`);

      if (g.hazardStatements.length > 0) {
        lines.push('', '**Hazard Statements:**');
        for (const h of g.hazardStatements) lines.push(`  ${h.code}: ${inlineData(h.statement)}`);
      }

      if (g.classifications.length > 0) {
        lines.push('', `**Classifications by source (${g.classifications.length}):**`);
        for (const c of g.classifications) lines.push(`  - ${formatClassification(c)}`);
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

    if (result.unprocessed && result.unprocessed.length > 0) {
      blocks.push(renderUnprocessed(result.unprocessed));
    }

    return [{ type: 'text', text: blocks.join('\n') }];
  },
});
