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
    "Get a compound's interaction data: drug-drug interactions (DrugBank), drug-food interactions, and chemical-target interactions (binding/activity from BindingDB, ChEMBL, and others). Each entry carries its originating source. Results are paged per kind, with the source-record total and the next offset reported for each. Richest for approved drugs; many compounds have no deposited interaction records.",
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
        "Zero-based start position within each requested kind, counted in source records rather than returned entries. The same offset applies to every kind in the call, and the kinds advance at different rates — when paging past the first page, request one kind per call and pass that kind's nextOffset. Default: 0.",
      ),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Max entries per kind per page (1-50). Well-studied drugs have a long tail of interactions; use offset to reach the ones past this page. Default: 10.',
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
                'Source records available for this kind, across all pages. Entries are derived from these records and can be fewer: a "target" record naming no molecular target and a "drug-drug" record carrying no statement both yield nothing, and duplicate measurements collapse within a page. Pages divide the records, not the entries, so a duplicate split across two pages is reported on both.',
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
        'Interaction kinds that could not be retrieved (comma-separated). The returned entries cover the kinds that succeeded; retry to re-attempt the failed ones.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a kind failed, when no interaction data was found, when the offset runs past every requested kind, or when further pages remain. Absent when this page is complete and every kind resolved.',
      ),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const { entries, pages, failedKinds } = await client.getInteractions(
      input.cid,
      input.kinds,
      input.maxEntries,
      input.offset,
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

    ctx.enrich({
      requestedKinds: input.kinds.join(', '),
      returnedCount: entries.length,
      offset: input.offset,
    });

    const remaining = paging.filter((p) => p.truncated);
    // A single scalar nextOffset only means something when one kind is still going; with two
    // it would have to pick one and silently skip the other's records.
    const soleNextOffset = remaining.length === 1 ? remaining[0]?.nextOffset : undefined;
    if (soleNextOffset !== undefined) ctx.enrich({ nextOffset: soleNextOffset });

    // Notice is last-wins, so every applicable signal composes into one string.
    const noticeParts: string[] = [];

    if (failedKinds.length > 0) {
      const names = failedKinds.map((f) => f.kind).join(', ');
      const plural = failedKinds.length > 1;
      ctx.enrich({ failedKinds: names });
      noticeParts.push(
        `Could not retrieve ${names} interaction${plural ? 's' : ''} for CID ${input.cid}.${
          entries.length > 0 ? ' Returned the kinds that succeeded.' : ''
        } Retry to re-attempt ${plural ? 'them' : 'it'}.`,
      );
    }

    const largestTotal = paging.reduce((max, p) => Math.max(max, p.totalRecords), 0);
    if (entries.length === 0 && paging.length > 0) {
      if (largestTotal === 0) {
        noticeParts.push(
          `No ${paging.map((p) => p.kind).join('/')} interaction data found for CID ${input.cid}. PubChem has no deposited interaction records for this compound — coverage is richest for approved drugs.`,
        );
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
      const summary = `${p.returnedCount} entr${p.returnedCount === 1 ? 'y' : 'ies'} from ${p.totalRecords} source record(s)`;
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
