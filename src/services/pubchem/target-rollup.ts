/**
 * @fileoverview Rolls a compound's parsed assay summary up to one summary per molecular target:
 * assay counts by outcome, the most potent Active value, and the identifier the target is named
 * and filtered by.
 * @module services/pubchem/target-rollup
 */

import type { ActivityValue, AssaySummary, TargetGroup } from './types.js';

/** The identifier a target is named by — one `pubchem_get_bioactivity` filters on. */
export type TargetIdentifier =
  | { kind: 'gene'; geneId: number }
  | { kind: 'accession'; accession: string };

/** One molecular target across every assay of a compound that names it. */
export interface TargetRollup {
  /** Distinct AIDs naming the target. */
  assayCount: number;
  /** The lowest Active value, with the AID that reported it. */
  bestActive?: { aid: number; value: ActivityValue };
  /** Gene IDs in the target's identifier group, set only when there are several: the group is
   * then named by a protein accession its Gene IDs share, never by one of the genes. */
  groupGeneIdCount?: number;
  identifier: TargetIdentifier;
  /** AIDs per outcome as PubChem writes it ("Active", "Inactive", …). */
  outcomes: Map<string, number>;
}

/** `GeneID:1956` / `accession:P00533` — the label `pubchem_get_bioactivity` reports its own
 * target filter with. */
export const identifierLabel = (id: TargetIdentifier): string =>
  id.kind === 'gene' ? `GeneID:${id.geneId}` : `accession:${id.accession}`;

/** Order of the non-Active outcomes in a statement; any other outcome follows alphabetically. */
const OUTCOME_ORDER = ['Inactive', 'Inconclusive', 'Unspecified'];

interface Tally {
  /** Per accession, the assays whose first row recorded for this target names it, to pick a
   * multi-gene group's name. */
  accessionAssays: Map<string, number>;
  aids: Set<number>;
  best?: { aid: number; value: ActivityValue };
  outcomes: Map<string, number>;
  target: { kind: 'group'; group: TargetGroup } | { kind: 'single'; identifier: TargetIdentifier };
}

/**
 * One rollup per target the compound's assays name: each identifier group the summary's
 * `targetGroups` holds, plus each identifier the table never pairs with the other kind. An
 * AID counts once per target, with the outcome and values the parser recorded for that target.
 * AIDs naming no target are left out.
 *
 * Ordered by what the compound does to the target: Active with a value first (lowest value
 * first, across activity names, as every value is µM), then Active without one, then the rest;
 * ties go to the target in more assays, then to the identifier label.
 */
export function rollUpTargets(summary: AssaySummary): TargetRollup[] {
  const groupOf = new Map<string, number>();
  for (const [i, group] of summary.targetGroups.entries()) {
    for (const accession of group.accessions) groupOf.set(`a:${accession}`, i);
    for (const geneId of group.geneIds) groupOf.set(`g:${geneId}`, i);
  }

  const tallies = new Map<string, Tally>();
  const record = (
    aid: number,
    accession: string | undefined,
    geneId: number | undefined,
    outcome: string,
    values: ActivityValue[],
  ) => {
    // A row naming both identifiers paired them, so an identifier outside every group is the
    // only one its row named — the same key the parser splits an AID's targets by.
    const single: TargetIdentifier | undefined = accession
      ? { kind: 'accession', accession }
      : geneId
        ? { kind: 'gene', geneId }
        : undefined;
    if (!single) return;
    const node = accession ? `a:${accession}` : `g:${geneId}`;
    const groupIndex = groupOf.get(node);
    const group = groupIndex === undefined ? undefined : summary.targetGroups[groupIndex];
    const key = group ? `group:${groupIndex}` : node;
    let tally = tallies.get(key);
    if (!tally) {
      tally = {
        aids: new Set(),
        accessionAssays: new Map(),
        outcomes: new Map(),
        target: group ? { kind: 'group', group } : { kind: 'single', identifier: single },
      };
      tallies.set(key, tally);
    }
    if (tally.aids.has(aid)) return;
    tally.aids.add(aid);
    tally.outcomes.set(outcome, (tally.outcomes.get(outcome) ?? 0) + 1);
    if (accession) {
      tally.accessionAssays.set(accession, (tally.accessionAssays.get(accession) ?? 0) + 1);
    }
    if (outcome !== 'Active') return;
    for (const value of values) {
      if (!tally.best || value.value < tally.best.value.value) tally.best = { aid, value };
    }
  };

  for (const row of summary.rows) {
    record(row.aid, row.targetAccession, row.targetGeneId, row.outcome, row.activityValues);
    for (const other of row.otherTargets ?? []) {
      record(row.aid, other.accession, other.geneId, other.outcome, other.activityValues);
    }
  }

  const rollups = [...tallies.values()].map((tally): TargetRollup => {
    const rollup: TargetRollup = {
      identifier: representative(tally),
      assayCount: tally.aids.size,
      outcomes: tally.outcomes,
    };
    if (tally.best) rollup.bestActive = tally.best;
    if (tally.target.kind === 'group' && tally.target.group.geneIds.length > 1) {
      rollup.groupGeneIdCount = tally.target.group.geneIds.length;
    }
    return rollup;
  });

  const tier = (t: TargetRollup) => (t.bestActive ? 0 : t.outcomes.has('Active') ? 1 : 2);
  return rollups.sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (a.bestActive && b.bestActive ? a.bestActive.value.value - b.bestActive.value.value : 0) ||
      b.assayCount - a.assayCount ||
      compareLabels(identifierLabel(a.identifier), identifierLabel(b.identifier)),
  );
}

const compareLabels = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The identifier a target is named by. A group with one Gene ID is that gene: its accessions
 * are the gene's products. A group joining several Gene IDs — strain genes deposited against
 * one multi-species accession, or a gene and its readthrough — is named by an accession, so no
 * one gene's name stands for the rest: the accession most often on the row an assay was first
 * recorded from for this target (later rows of the same AID, and rows naming no accession,
 * count for none), ties to the lowest accession.
 */
function representative({ target, accessionAssays }: Tally): TargetIdentifier {
  if (target.kind === 'single') return target.identifier;
  const { geneIds, accessions } = target.group;
  const [onlyGene] = geneIds;
  if (geneIds.length === 1 && onlyGene !== undefined) return { kind: 'gene', geneId: onlyGene };
  // A group comes from pairs, so it always holds an accession.
  const assays = (a: string) => accessionAssays.get(a) ?? 0;
  const accession = accessions.reduce((best, a) => {
    const lead = assays(a) - assays(best);
    return lead > 0 || (lead === 0 && a < best) ? a : best;
  });
  return { kind: 'accession', accession };
}

/** `Active in 253 of 351 assays (Inactive 1, Inconclusive 4, Unspecified 93); most potent
 * active: IC50 0.000029 uM (AID 1956454)`. */
export function targetStatement(t: TargetRollup): string {
  const active = t.outcomes.get('Active') ?? 0;
  const rank = (o: string) => {
    const i = OUTCOME_ORDER.indexOf(o);
    return i === -1 ? OUTCOME_ORDER.length : i;
  };
  const others = [...t.outcomes]
    .filter(([outcome]) => outcome !== 'Active')
    .sort(([a], [b]) => rank(a) - rank(b) || compareLabels(a, b))
    .map(([outcome, n]) => `${outcome || 'no outcome'} ${n}`);
  let text = `Active in ${active} of ${t.assayCount} assay${t.assayCount === 1 ? '' : 's'}`;
  if (others.length > 0) text += ` (${others.join(', ')})`;
  if (t.bestActive) {
    const { name, value, unit } = t.bestActive.value;
    const measure = [name, String(value), unit].filter(Boolean).join(' ');
    text += `; most potent active: ${measure} (AID ${t.bestActive.aid})`;
  }
  return text;
}
