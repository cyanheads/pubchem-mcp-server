/**
 * @fileoverview Get drug-food interactions, assay-summary molecular targets, and (when SDQ answers) drug-drug interactions for a compound.
 * @module mcp-server/tools/definitions/get-compound-interactions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { MAX_CID } from '@/services/pubchem/types.js';
import {
  type CappedInput,
  capPageSize,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
} from './input-caps.js';
import { inlineData, quoteData } from './untrusted-text.js';

/** Entries served per kind per page; a larger maxEntries is clamped to this. */
const MAX_ENTRIES_CAP = 50;

export const getCompoundInteractions = tool('pubchem_get_compound_interactions', {
  title: 'Get Compound Interactions',
  description:
    "Get a compound's interaction data: drug-food interactions, and the molecular targets its bioassays name — one entry per target as kinds defines it, with its assay counts by outcome and most potent active value, Active targets first, most potent first. Each entry carries its originating source. Results are paged per kind, with the record total and the next offset reported for each. Drug-food coverage is richest for approved drugs; target covers any compound PubChem has assay data for, and pubchem_get_bioactivity lists one target's assays when given the entry's GeneID or accession. Drug-drug interactions (DrugBank) are unavailable while PubChem's SDQ service refuses automated requests: an explicit drug-drug request is reported in failedKinds while the other kinds still return.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z
      .number()
      .int()
      .min(1)
      .max(MAX_CID)
      .describe('PubChem Compound ID. Resolve from name/SMILES with pubchem_search_compounds.'),
    kinds: z
      .array(z.enum(['drug-drug', 'drug-food', 'target']))
      .min(1)
      .default(['drug-food'])
      .describe(
        'Interaction kinds to fetch. "drug-food" (dietary interactions, from PUG View), "target" (molecular targets from the compound\'s assay summary: one entry per Gene ID with the accessions the table pairs with it, and one per identifier it never pairs, so a Gene ID and an accession that no row pairs are separate entries even when they name the same protein), "drug-drug" (interactions with other drugs, from PubChem\'s SDQ service, which refuses automated requests, so it is reported in failedKinds). Default: ["drug-food"].',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      // PubChem's record cursor is a signed 32-bit integer; a larger start makes the upstream
      // query fail outright, which would surface as a retryable kind failure that no retry can
      // clear. Rejecting it here names the bound instead.
      .max(2147483646)
      .default(0)
      .describe(
        "Zero-based start position within each requested kind, counted in records (molecular targets, for target) rather than returned entries. The same offset applies to every kind in the call, and the kinds advance at different rates — when paging past the first page, request one kind per call and pass that kind's nextOffset. Default: 0.",
      ),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(INPUT_CEILING)
      .default(10)
      .describe(
        `Max entries per kind per page. The per-call cap is ${MAX_ENTRIES_CAP}: a larger value (up to ${INPUT_CEILING}) reads a page of ${MAX_ENTRIES_CAP} per kind and is reported in cappedInputs. Well-studied drugs have a long tail of interactions; use offset to reach the ones past this page. Default: 10.`,
      ),
  }),
  // `maxEntries` is this tool's page size; the sibling search tools call the same
  // concept `maxResults`, and only one page-size input exists here.
  inputAliases: { maxResults: 'maxEntries' },
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
              .describe(
                'Interacting compound as the source reports it. For a target: its gene or protein name and organism, then the identifier pubchem_get_bioactivity filters on (GeneID:N → targetGeneId, accession:X → targetAccession); the identifier alone when no name resolves. A target whose identifiers join several Gene IDs is named by the accession they share and says "group of N Gene IDs".',
              ),
            source: z
              .string()
              .describe('Originating source (e.g. "DrugBank", "PubChem BioAssay").'),
            text: z
              .string()
              .describe(
                'The interaction statement. For a target: the assays naming it by outcome and its most potent Active value with that AID, in µM.',
              ),
          })
          .describe('A single interaction entry.'),
      )
      .describe('Interaction entries across the requested kinds.'),
    paging: z
      .array(
        z
          .object({
            kind: z
              .enum(['drug-drug', 'drug-food', 'target'])
              .describe('Interaction category this page covers.'),
            returnedCount: z.number().describe('Interaction entries returned for this kind.'),
            totalRecords: z
              .number()
              .describe(
                'Records available for this kind, across all pages: interaction records for drug-drug and drug-food, molecular targets for target. Entries are derived from these records and can be fewer: a drug-drug record carrying no statement yields nothing. Pages divide the records, not the entries.',
              ),
            nextOffset: z
              .number()
              .optional()
              .describe(
                'Offset to pass on the next call to continue this kind past the current page. Omitted when no records remain.',
              ),
            truncated: z
              .boolean()
              .describe('True when source records remain for this kind past the current page.'),
          })
          .describe('Page position for one interaction kind.'),
      )
      .describe(
        'Per-kind page position, one entry per requested kind that was retrieved. A kind listed in failedKinds is absent — its position is unknown, not exhausted.',
      ),
  }),
  // Agent-facing context — kind echo, total returned, the page boundary, failed kinds, and
  // an empty-result notice. Reaches structuredContent and content[]; keys disjoint from
  // output (cid/entries/paging).
  enrichment: {
    requestedKinds: z.string().describe('Interaction kinds requested (comma-separated).'),
    returnedCount: z.number().describe('Total interaction entries returned across all kinds.'),
    truncated: z
      .boolean()
      .describe(
        'True when at least one requested kind has source records remaining past this page. Which kinds, and how many records each holds, is in paging[].truncated / paging[].totalRecords.',
      ),
    offset: z.number().describe('Zero-based start position read within each requested kind.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call, reported when exactly one requested kind has records remaining. Omitted when none do, and when several do — those advance to different positions, so read paging[].nextOffset instead.',
      ),
    failedKinds: z
      .string()
      .optional()
      .describe(
        "Interaction kinds that could not be retrieved (comma-separated). The returned entries cover the kinds that succeeded. The notice says, per failed kind, whether a retry can help: a timeout, rate limit, network error, unreadable response, or upstream 5xx other than 501 can clear, while an HTTP 400, 403, or 501, a response in a shape the server does not expect, or a refusal from PubChem's SDQ service (drug-drug) does not.",
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a kind failed, when no interaction data was found, when the offset runs past every requested kind, when target names could not be retrieved, or when further pages remain. Absent when this page is complete and every kind resolved.',
      ),
    cappedInputs: cappedInputsField,
  },
  enrichmentTrailer: { cappedInputs: { render: renderCappedInputs } },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const capped: CappedInput[] = [];
    const pageSize = capPageSize('maxEntries', input.maxEntries, MAX_ENTRIES_CAP, capped);
    const { entries, pages, failedKinds } = await client.getInteractions(
      input.cid,
      input.kinds,
      pageSize,
      input.offset,
      ctx.signal,
    );

    for (const f of failedKinds) {
      ctx.log.warning('Interaction kind failed', {
        cid: input.cid,
        kind: f.kind,
        error: f.message,
        retryable: f.retryable,
      });
    }
    ctx.log.info('Interactions fetched', {
      cid: input.cid,
      kinds: input.kinds,
      offset: input.offset,
      returned: entries.length,
      failed: failedKinds.length,
    });

    // Each kind advances by the records it actually read, never by maxEntries — a kind that
    // stopped early (or whose window ran short) would otherwise emit a next offset that skips
    // records, and a cap-derived stride can also land off an integer boundary.
    const paging = pages.map((p) => {
      const next = input.offset + p.recordsConsumed;
      const truncated = next < p.totalRecords;
      return {
        kind: p.kind,
        returnedCount: p.returnedCount,
        totalRecords: p.totalRecords,
        truncated,
        ...(truncated ? { nextOffset: next } : {}),
      };
    });

    const remaining = paging.filter((p) => p.truncated);

    ctx.enrich({
      requestedKinds: input.kinds.join(', '),
      returnedCount: entries.length,
      truncated: remaining.length > 0,
      offset: input.offset,
    });

    // A single scalar nextOffset only means something when one kind is still going; with two
    // it would have to pick one and silently skip the other's records.
    const soleNextOffset = remaining.length === 1 ? remaining[0]?.nextOffset : undefined;
    if (soleNextOffset !== undefined) ctx.enrich({ nextOffset: soleNextOffset });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });

    // Notice is last-wins, so every applicable signal composes into one string.
    const noticeParts: string[] = [];

    if (failedKinds.length > 0) {
      ctx.enrich({ failedKinds: failedKinds.map((f) => f.kind).join(', ') });
      // Retry advice only where a retry can clear the failure (the client's `retryable`): a
      // timeout, an unreadable body, or a 5xx other than 501 can; a 400, 403, or 501, or a body
      // in an unexpected shape cannot; a refusal from PubChem's SDQ service gets its own
      // explanation.
      const refused = failedKinds.filter((f) => f.reason === 'sdq_unavailable').map((f) => f.kind);
      const retryable = failedKinds.filter((f) => f.retryable).map((f) => f.kind);
      const permanent = failedKinds
        .filter((f) => !f.retryable && f.reason !== 'sdq_unavailable')
        .map((f) => f.kind);
      const couldNot = (kinds: string[]) =>
        `Could not retrieve ${kinds.join(', ')} interaction${kinds.length > 1 ? 's' : ''} for CID ${input.cid}`;
      if (retryable.length > 0) {
        noticeParts.push(
          `${couldNot(retryable)}. Retry to re-attempt ${retryable.length > 1 ? 'them' : 'it'}.`,
        );
      }
      if (permanent.length > 0) {
        noticeParts.push(
          `${couldNot(permanent)}: PubChem rejected the request or answered in a shape this server does not expect, and repeating the call fails the same way.`,
        );
      }
      if (refused.length > 0) {
        noticeParts.push(
          `${couldNot(refused)}: PubChem's SDQ service, the source of drug-drug interactions, did not answer with data. It can refuse automated requests, and repeating the call does not change that.`,
        );
      }
      if (entries.length > 0) noticeParts.push('Returned the kinds that succeeded.');
    }

    const largestTotal = paging.reduce((max, p) => Math.max(max, p.totalRecords), 0);
    if (entries.length === 0 && paging.length > 0) {
      if (largestTotal === 0) {
        const kinds = paging.map((p) => p.kind);
        noticeParts.push(`No ${kinds.join('/')} interaction data found for CID ${input.cid}.`);
        if (kinds.some((k) => k !== 'target')) {
          noticeParts.push(
            'PubChem has no deposited interaction records for this compound — coverage is richest for approved drugs.',
          );
        }
        if (kinds.includes('target')) {
          noticeParts.push(
            'None of its assays names a molecular target, or PubChem holds no assay data for it.',
          );
        }
      } else if (input.offset >= largestTotal) {
        noticeParts.push(
          `offset ${input.offset} is past every requested kind — the largest has ${largestTotal} record(s). Pass an offset below ${largestTotal}.`,
        );
      } else {
        noticeParts.push(
          `CID ${input.cid} has ${largestTotal} record(s) for the requested kind(s), but none read on this page carried a reportable interaction.`,
        );
      }
    }

    // Drug-food answers for approved drugs only; target answers for any assayed compound.
    const food = paging.find((p) => p.kind === 'drug-food');
    if (food?.totalRecords === 0 && !input.kinds.includes('target')) {
      noticeParts.push(
        `For the molecular targets CID ${input.cid}'s assays name, request kinds: ["target"].`,
      );
    }

    if (pages.some((p) => p.namesUnavailable)) {
      noticeParts.push(
        'Target names could not be retrieved for this page, so those partners carry their identifier alone. Retry to fetch the names.',
      );
    }

    if (remaining.length > 0) {
      noticeParts.push(
        `More records remain — ${remaining
          .map((p) => `${p.kind}: pass offset=${p.nextOffset} of ${p.totalRecords} total`)
          .join('; ')}.`,
      );
    }

    if (noticeParts.length > 0) ctx.enrich.notice(noticeParts.join(' '));

    return { cid: input.cid, entries, paging };
  },

  format(result) {
    const lines: string[] = [`## Interactions — CID ${result.cid}`, ''];

    for (const p of result.paging) {
      const unit = p.kind === 'target' ? 'target(s)' : 'source record(s)';
      const summary = `${p.returnedCount} entr${p.returnedCount === 1 ? 'y' : 'ies'} from ${p.totalRecords} ${unit}`;
      lines.push(`- **${p.kind}** — ${summary}${p.truncated ? ' — truncated' : ''}`);
      if (p.nextOffset !== undefined) lines.push(`  Next offset: ${p.nextOffset}`);
    }
    if (result.paging.length > 0) lines.push('');

    if (result.entries.length === 0) {
      // Neutral wording: an empty page is "no data", "offset past the end", or "the records
      // read named no interaction" — the enrichment trailer's notice says which.
      lines.push('No interaction entries returned.');
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
