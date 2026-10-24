/**
 * @fileoverview Get a compound's bioactivity profile — which assays tested it,
 * activity outcomes, target information, and quantitative values.
 * @module mcp-server/tools/definitions/get-bioactivity
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import {
  type AssayTargetActivity,
  type BioactivityRow,
  MAX_CID,
  MAX_INT32,
  type TargetGroup,
} from '@/services/pubchem/types.js';
import { normalizeProteinAccession } from './identifier-case.js';
import {
  type CappedInput,
  capPageSize,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
} from './input-caps.js';
import { inlineData, inlineEcho } from './untrusted-text.js';

/** Assays served per page; a larger maxResults is clamped to this. */
const MAX_RESULTS_CAP = 100;

/** PubChem's assay types, lowercased — the vocabulary pubchem_get_summary reports as an
 * assay's method. */
const ASSAY_TYPES = ['confirmatory', 'screening', 'summary', 'other'] as const;

const activityValueSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe('Measurement name (e.g. IC50, EC50, Ki). Omitted when not reported.'),
    value: z.number().describe('Measured value.'),
    unit: z
      .string()
      .optional()
      .describe('Unit of measurement (e.g. uM, nM). Omitted when not reported.'),
  })
  .describe('Quantitative activity measurement entry.');

/** The identifiers a target filter matches. */
interface TargetMatch {
  accessions: Set<string>;
  geneIds: Set<number>;
}

/** What the target filter matches, resolved against the compound's identifier groups. */
type TargetFilter =
  | { kind: 'none' }
  | ({ kind: 'match'; label: string } & TargetMatch)
  | { kind: 'conflict'; geneGroup: TargetGroup; accessionGroup: TargetGroup; label: string };

const matchesTarget = (match: TargetMatch, accession?: string, geneId?: number): boolean =>
  (accession !== undefined && match.accessions.has(accession)) ||
  (geneId !== undefined && match.geneIds.has(geneId));

/**
 * The record as reported under a target filter: unchanged when its first target matches;
 * with the first matching later target reported in its place — and the first target moved
 * to the head of otherTargets — when only a later one does; undefined when none matches.
 */
function reportMatchingTarget(row: BioactivityRow, match: TargetMatch): BioactivityRow | undefined {
  if (matchesTarget(match, row.targetAccession, row.targetGeneId)) return row;
  const others = row.otherTargets ?? [];
  const reported = others.find((t) => matchesTarget(match, t.accession, t.geneId));
  if (!reported) return;

  const first: AssayTargetActivity = { outcome: row.outcome, activityValues: row.activityValues };
  if (row.targetAccession) first.accession = row.targetAccession;
  if (row.targetGeneId) first.geneId = row.targetGeneId;
  const promoted: BioactivityRow = {
    aid: row.aid,
    assayName: row.assayName,
    outcome: reported.outcome,
    activityValues: reported.activityValues,
    otherTargets: [first, ...others.filter((t) => t !== reported)],
  };
  if (reported.accession) promoted.targetAccession = reported.accession;
  if (reported.geneId) promoted.targetGeneId = reported.geneId;
  // The assay type and citations describe the AID, whichever target is reported.
  if (row.assayType) promoted.assayType = row.assayType;
  if (row.pmids) promoted.pmids = row.pmids;
  return promoted;
}

/** `frame` shapes each accession — a notice passes {@link inlineEcho}, since one may be the
 * caller's own string. */
const describeTargetIds = (
  geneIds: Iterable<number>,
  accessions: Iterable<string>,
  frame: (accession: string) => string = (a) => a,
): string =>
  [
    ...[...geneIds].map((id) => `GeneID:${id}`),
    ...[...accessions].map((a) => `accession:${frame(a)}`),
  ].join(' ');

/**
 * Expand the caller's Gene ID and/or accession to every identifier the compound's assay
 * table connects them to. Both inputs name one target: they match either, unless the table
 * places them in two different groups. An identifier the table never pairs matches exactly.
 */
function resolveTargetFilter(
  geneId: number | undefined,
  accession: string | undefined,
  groups: TargetGroup[],
): TargetFilter {
  if (geneId == null && !accession) return { kind: 'none' };
  const geneGroup = geneId != null ? groups.find((g) => g.geneIds.includes(geneId)) : undefined;
  const accessionGroup = accession
    ? groups.find((g) => g.accessions.includes(accession))
    : undefined;
  if (geneId != null && accession && geneGroup && accessionGroup && geneGroup !== accessionGroup) {
    return {
      kind: 'conflict',
      geneGroup,
      accessionGroup,
      label: describeTargetIds([geneId], [accession]),
    };
  }
  const geneIds = new Set(geneId != null ? [geneId] : []);
  const accessions = new Set(accession ? [accession] : []);
  for (const group of [geneGroup, accessionGroup]) {
    for (const id of group?.geneIds ?? []) geneIds.add(id);
    for (const a of group?.accessions ?? []) accessions.add(a);
  }
  return { kind: 'match', geneIds, accessions, label: describeTargetIds(geneIds, accessions) };
}

export const getBioactivity = tool('pubchem_get_bioactivity', {
  title: 'Get Bioactivity',
  description:
    'Get a compound\'s bioactivity profile: which assays tested it, activity outcomes (Active/Inactive/Inconclusive), target identifiers (NCBI Gene ID, UniProt/GenBank accession), quantitative values (IC50, EC50, Ki, etc.), each assay\'s type (confirmatory, screening, summary, other), and the PubMed IDs it cites. Filter by outcome, a specific molecular target (NCBI Gene ID or protein accession), and/or assay type to focus the profile — e.g. "is this compound active against target T in confirmatory assays?".',
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
    outcomeFilter: z
      .enum(['active', 'inactive', 'all'])
      .default('all')
      .describe(
        'Filter by activity outcome against each assay\'s reported target: the target a target filter matched, else the first target the assay lists. For a multi-target assay, outcomes against its other targets (in otherTargets) do not count. "active" keeps assays where that outcome is Active — most useful for understanding biological profile. Default: "all".',
      ),
    targetGeneId: z
      .number()
      .int()
      .min(1)
      .max(MAX_INT32)
      .optional()
      .describe(
        `Filter to assays against this NCBI Gene ID (1 to ${MAX_INT32}), including assays recorded only under a protein accession this compound's assay table pairs with the Gene ID (e.g. 5742 also reaches rows carrying only P23219 when another row pairs the two). Obtain Gene IDs from pubchem_search_assays or the targetGeneId field of an unfiltered result here. Combine with outcomeFilter="active" to answer "is this compound active against target T?".`,
      ),
    targetAccession: z
      .string()
      .optional()
      .describe(
        'Filter to assays against this target protein accession (UniProt/RefSeq/GenBank/PDB chain), e.g. "P35354", including assays recorded only under a Gene ID or another accession this compound\'s assay table pairs with it. Uppercased before matching; a PDB chain ID (the "A" in "1ZHH_A") is kept as given. With targetGeneId, both must name the same target — when the table ties them to different targets, nothing matches. Obtain accessions from pubchem_search_assays or the targetAccession field of an unfiltered result here.',
      ),
    assayType: z
      .array(z.enum(ASSAY_TYPES))
      .min(1)
      .optional()
      .describe(
        'Keep only assays of these types: "confirmatory" (dose-response and other follow-up assays), "screening" (primary high-throughput screens), "summary" (records summarizing a project\'s assays), "other". Matched against PubChem\'s Assay Type regardless of case; an assay with no recorded type matches none. Combines with outcomeFilter and the target filters — an assay must pass all of them. Omit to keep every type.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first assay to return, applied after the outcome and target filters. Pass the nextOffset from a previous call to read the following page. Default: 0.',
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(INPUT_CEILING)
      .default(20)
      .describe(
        `Max assay results to return per page. The per-call cap is ${MAX_RESULTS_CAP}: a larger value (up to ${INPUT_CEILING}) returns a page of ${MAX_RESULTS_CAP} and is reported in cappedInputs. Well-studied compounds have thousands of records; use offset to reach the ones past this page. Default: 20.`,
      ),
  }),
  // The target filters are reached via pubchem_search_assays, whose targetType names
  // them `geneid` and `proteinaccession`; a caller carrying an identifier across sends
  // the bare noun. Each maps to exactly one declared filter.
  inputAliases: { geneId: 'targetGeneId', accession: 'targetAccession' },
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    totalAssays: z.number().describe('Total unique assays for this compound.'),
    activeCount: z
      .number()
      .describe(
        'Assays whose outcome against their first listed target is "Active", across all assays and before any filter. A multi-target assay counts by its first target only.',
      ),
    inactiveCount: z
      .number()
      .describe(
        'Assays whose outcome against their first listed target is "Inactive", across all assays and before any filter. A multi-target assay counts by its first target only.',
      ),
    results: z
      .array(
        z
          .object({
            aid: z.number().describe('PubChem Assay ID.'),
            assayName: z.string().describe('Assay name/title.'),
            assayType: z
              .string()
              .optional()
              .describe(
                "PubChem's assay type as written: Confirmatory, Screening, Summary, or Other. Omitted when PubChem records none.",
              ),
            pmids: z
              .array(z.number())
              .optional()
              .describe(
                'PubMed IDs of the publications the assay cites, highest (most recently assigned) first. Omitted when it cites none.',
              ),
            outcome: z
              .string()
              .describe(
                "Activity outcome against the reported target — the one a target filter matched, else the assay's first: Active, Inactive, Inconclusive, Unspecified.",
              ),
            targetAccession: z
              .string()
              .optional()
              .describe("Reported target's protein accession (UniProt/RefSeq/GenBank/PDB chain)."),
            targetGeneId: z.number().optional().describe("Reported target's NCBI Gene ID."),
            activityValues: z
              .array(activityValueSchema)
              .describe('Quantitative activity measurements against the reported target.'),
            otherTargets: z
              .array(
                z
                  .object({
                    accession: z
                      .string()
                      .optional()
                      .describe('Protein accession. Omitted when the row names none.'),
                    geneId: z
                      .number()
                      .optional()
                      .describe('NCBI Gene ID. Omitted when the row names none.'),
                    outcome: z.string().describe('Activity outcome against this target.'),
                    activityValues: z
                      .array(activityValueSchema)
                      .describe('Quantitative activity measurements against this target.'),
                  })
                  .describe('Another target of the assay, with its own outcome and values.'),
              )
              .optional()
              .describe(
                "The assay's other targets, each with its own outcome and measurements. Present only for an assay whose rows name more than one target.",
              ),
          })
          .describe('Assay result entry.'),
      )
      .describe('Assay results matching the filter.'),
  }),
  // Agent-facing context — filter echo, the page boundary, and a notice distinguishing
  // "no data" from "filter excluded everything". Reaches structuredContent and content[];
  // keys disjoint from output (cid/totalAssays live there).
  //
  // Bounded-total convention: a reported total states only what the server actually
  // observed, and pairs with an `…AtLeast` floor when the exact figure is unknowable.
  // Every count here is exact and needs no such twin — PubChem's assay summary has no
  // pagination of its own, so the full table is in hand before any filter runs.
  enrichment: {
    outcomeFilter: z.string().describe('Outcome filter applied: active, inactive, or all.'),
    targetFilter: z
      .string()
      .optional()
      .describe(
        "Target identifiers matched, when a target filter is set: those passed plus every Gene ID and accession the compound's assay table pairs with them. When the two inputs name different targets, only the two inputs.",
      ),
    assayTypeFilter: z
      .string()
      .optional()
      .describe(
        'Assay types kept, comma-separated (e.g. "confirmatory, summary"), when assayType is set.',
      ),
    filteredCount: z
      .number()
      .describe(
        'Exact number of assays matching the outcome, target, and assay-type filters, across all pages.',
      ),
    returnedCount: z.number().describe('Assays returned on this page.'),
    offset: z.number().describe('Zero-based index of the first assay returned.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue past this page. Omitted when no further assays match.',
      ),
    truncated: z.boolean().optional().describe('True when matching assays remain past this page.'),
    shown: z.number().optional().describe('Assays returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The page size applied: maxResults, or the per-call cap when maxResults exceeds it.',
      ),
    cappedInputs: cappedInputsField,
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when the filter yields no results or the compound has no bioactivity data.',
      ),
  },
  enrichmentTrailer: {
    // An accession in the label may be the caller's own string: framed, but never cut, since
    // structuredContent carries the same value whole. Only called for a populated field.
    targetFilter: { render: (label) => `**targetFilter:** ${inlineData(label ?? '')}` },
    cappedInputs: { render: renderCappedInputs },
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const { rows: allRows, targetGroups } = await client.getAssaySummary(input.cid, ctx.signal);

    const activeCount = allRows.filter((r) => r.outcome === 'Active').length;
    const inactiveCount = allRows.filter((r) => r.outcome === 'Inactive').length;

    // Filter by target, then by outcome, then by assay type — pure filters on rows already in
    // hand. The target filter expands each identifier through the pairs the compound's own
    // table records, matches any target an assay names, and reports the matching one; the
    // outcome filter then reads the reported target's outcome.
    const targetAccession = input.targetAccession
      ? normalizeProteinAccession(input.targetAccession)
      : undefined;
    const target = resolveTargetFilter(input.targetGeneId, targetAccession, targetGroups);
    let filtered = allRows;
    if (target.kind === 'conflict') {
      filtered = [];
    } else if (target.kind === 'match') {
      filtered = allRows.flatMap((r) => reportMatchingTarget(r, target) ?? []);
    }
    if (input.outcomeFilter === 'active') {
      filtered = filtered.filter((r) => r.outcome === 'Active');
    } else if (input.outcomeFilter === 'inactive') {
      filtered = filtered.filter((r) => r.outcome === 'Inactive');
    }
    const assayTypes = input.assayType ? [...new Set(input.assayType)] : [];
    if (assayTypes.length > 0) {
      const kept = new Set<string>(assayTypes);
      filtered = filtered.filter((r) => r.assayType && kept.has(r.assayType.trim().toLowerCase()));
    }
    const assayTypeFilter = assayTypes.join(', ');
    const targetLabel = target.kind === 'none' ? '' : target.label;

    // Offset is applied client-side: PubChem's assay summary endpoint accepts no
    // offset/start/limit/page parameter, so getAssaySummary already holds every row.
    const capped: CappedInput[] = [];
    const pageSize = capPageSize('maxResults', input.maxResults, MAX_RESULTS_CAP, capped);
    const results = filtered.slice(input.offset, input.offset + pageSize);
    const nextOffset = input.offset + results.length;
    const hasMore = nextOffset < filtered.length;

    ctx.log.info('Bioactivity fetched', {
      cid: input.cid,
      total: allRows.length,
      active: activeCount,
      filtered: filtered.length,
      offset: input.offset,
      returned: results.length,
    });

    ctx.enrich({
      outcomeFilter: input.outcomeFilter,
      filteredCount: filtered.length,
      returnedCount: results.length,
      offset: input.offset,
    });
    if (targetLabel) ctx.enrich({ targetFilter: targetLabel });
    if (assayTypeFilter) ctx.enrich({ assayTypeFilter });
    if (hasMore) ctx.enrich({ nextOffset });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });
    if (allRows.length === 0) {
      ctx.enrich.notice(
        `No bioactivity data found for CID ${input.cid}. The compound may be uncharacterized, or verify the CID with pubchem_search_compounds.`,
      );
    } else if (target.kind === 'conflict') {
      ctx.enrich.notice(
        `targetGeneId ${input.targetGeneId} and targetAccession ${targetAccession} name different targets in CID ${input.cid}'s assays: GeneID ${input.targetGeneId} belongs to [${describeTargetIds(target.geneGroup.geneIds, target.geneGroup.accessions)}], accession ${targetAccession} belongs to [${describeTargetIds(target.accessionGroup.geneIds, target.accessionGroup.accessions)}]. Pass one of the two, or call once per target.`,
      );
    } else if (filtered.length === 0) {
      const outcomeSet = input.outcomeFilter !== 'all';
      const filters = [
        ...(target.kind === 'match'
          ? [
              `the target filter (${describeTargetIds(target.geneIds, target.accessions, inlineEcho)})`,
            ]
          : []),
        ...(outcomeSet ? [`outcomeFilter="${input.outcomeFilter}"`] : []),
        ...(assayTypeFilter ? [`assayType="${assayTypeFilter}"`] : []),
      ];
      const recovery =
        target.kind === 'match'
          ? "Verify the target identifier appears in this compound's assays, or widen the filter."
          : assayTypeFilter
            ? `Widen or omit assayType${outcomeSet ? ', or use outcomeFilter="all",' : ''} to see them.`
            : 'Use outcomeFilter="all" to see them.';
      const [first, ...rest] = filters;
      ctx.enrich.notice(
        `CID ${input.cid} has ${allRows.length} assay(s) but none match ${first}${rest.length > 0 ? ` with ${rest.join(' and ')}` : ''}. ${recovery}`,
      );
    } else if (results.length === 0) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the ${filtered.length} assay(s) matching the filter. Pass an offset below ${filtered.length}.`,
      );
    } else if (hasMore) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: pageSize,
        guidance: `Showing assays ${input.offset + 1}-${nextOffset} of ${filtered.length}. Pass offset=${nextOffset} for the next page.`,
      });
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

    const targetIds = (geneId?: number, accession?: string) =>
      [geneId ? `GeneID:${geneId}` : undefined, accession].filter(Boolean).join(' — ');
    const pushValues = (
      values: (typeof result.results)[number]['activityValues'],
      indent: string,
    ) => {
      for (const av of values) {
        const label = av.name ?? 'Value';
        const unit = av.unit ?? '';
        lines.push(`${indent}${label}: ${av.value}${unit ? ` ${unit}` : ''}`);
      }
    };

    for (const r of result.results) {
      const target = targetIds(r.targetGeneId, r.targetAccession);
      lines.push(`**AID ${r.aid}** — ${inlineData(r.assayName)} (${r.outcome})`);
      if (r.assayType) lines.push(`  Assay type: ${inlineData(r.assayType)}`);
      if (r.pmids) lines.push(`  PMIDs: ${r.pmids.join(', ')}`);
      if (target) lines.push(`  Target: ${target}`);
      pushValues(r.activityValues, '  ');
      for (const other of r.otherTargets ?? []) {
        const ids = targetIds(other.geneId, other.accession) || 'not identified';
        lines.push(`  Other target: ${ids} (${other.outcome})`);
        pushValues(other.activityValues, '    ');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
