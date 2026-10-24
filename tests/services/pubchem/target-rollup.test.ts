/**
 * @fileoverview Tests for the per-target rollup of a compound's assay summary (#78): grouping,
 * outcome counts, the most potent Active value, ordering, and the identifier each target is
 * named by — on erlotinib's real table and on constructed edge cases.
 * @module tests/services/pubchem/target-rollup
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PubChemClient } from '@/services/pubchem/pubchem-client.js';
import {
  identifierLabel,
  rollUpTargets,
  type TargetRollup,
  targetStatement,
} from '@/services/pubchem/target-rollup.js';
import type { AssaySummary, BioactivityRow } from '@/services/pubchem/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Erlotinib's assay summary, trimmed to its target-bearing rows and the parser's columns. */
async function erlotinib(): Promise<TargetRollup[]> {
  const table = readFileSync(
    new URL('../../fixtures/assaysummary-176870-targets.json', import.meta.url),
    'utf8',
  );
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error(`unmocked ${url.host}`);
    return new Response(table, { status: 200 });
  });
  return rollUpTargets(await new PubChemClient().getAssaySummary(176870));
}

const row = (
  aid: number,
  outcome: string,
  target: Partial<BioactivityRow> = {},
): BioactivityRow => ({
  aid,
  assayName: '',
  outcome,
  activityValues: [],
  ...target,
});

describe('rollUpTargets on erlotinib (CID 176870)', () => {
  it('counts one target per identifier group or unpaired identifier, 161 of them Active', async () => {
    const targets = await erlotinib();

    expect(targets).toHaveLength(738);
    expect(targets.filter((t) => t.outcomes.has('Active'))).toHaveLength(161);
  });

  it('leads with the EGFR group, matching get_bioactivity’s counts for GeneID 1956', async () => {
    const [first] = await erlotinib();

    expect(first?.identifier).toEqual({ kind: 'gene', geneId: 1956 });
    expect(targetStatement(first as TargetRollup)).toBe(
      'Active in 253 of 351 assays (Inactive 1, Inconclusive 4, Unspecified 93); most potent active: IC50 0.000029 uM (AID 1956454)',
    );
  });

  it('names a multi-species group by its shared accession, never by one strain gene', async () => {
    const targets = await erlotinib();
    const fixJ = targets.find((t) => identifierLabel(t.identifier) === 'accession:WP_006493245');

    expect(fixJ?.groupGeneIdCount).toBe(18);
    expect(targetStatement(fixJ as TargetRollup)).toBe('Active in 0 of 1 assay (Inactive 1)');
    // None of the group's 18 Gene IDs gets an entry of its own.
    for (const id of [98105341, 93191434, 45095325]) {
      expect(targets.some((t) => identifierLabel(t.identifier) === `GeneID:${id}`)).toBe(false);
    }
  });

  it('names a gene-and-readthrough group by the accession in most of its assays', async () => {
    const targets = await erlotinib();
    const tnni3k = targets.find((t) => identifierLabel(t.identifier) === 'accession:Q59H18');

    // Q59H18 is in AIDs 435200 and 625097; NP_057062, the group's other accession, in 1433 only.
    expect(tnni3k?.groupGeneIdCount).toBe(2);
    expect(targetStatement(tnni3k as TargetRollup)).toBe(
      'Active in 3 of 3 assays; most potent active: 0.57 uM (AID 1433)',
    );
    expect(targets.some((t) => identifierLabel(t.identifier) === 'accession:NP_057062')).toBe(
      false,
    );
  });
});

describe('rollUpTargets ordering and statements', () => {
  const summary = (rows: BioactivityRow[], targetGroups: AssaySummary['targetGroups'] = []) => ({
    rows,
    targetGroups,
  });

  it('orders Active-with-value by value, then Active without one, then by assay count and label', () => {
    const targets = rollUpTargets(
      summary([
        row(1, 'Inactive', { targetGeneId: 30 }),
        row(2, 'Inactive', { targetGeneId: 20 }),
        row(3, 'Inactive', { targetGeneId: 20 }),
        row(4, 'Active', { targetGeneId: 40 }),
        row(5, 'Active', {
          targetAccession: 'Q1',
          activityValues: [{ name: 'Ki', value: 9, unit: 'uM' }],
        }),
        row(6, 'Active', {
          targetGeneId: 50,
          activityValues: [
            { name: 'IC50', value: 2, unit: 'uM' },
            { name: 'Kd', value: 0.1, unit: 'uM' },
          ],
        }),
        row(7, 'Inactive', { targetAccession: 'A9' }),
        row(8, 'Inactive', { targetGeneId: 10 }),
      ]),
    );

    expect(targets.map((t) => identifierLabel(t.identifier))).toEqual([
      'GeneID:50',
      'accession:Q1',
      'GeneID:40',
      'GeneID:20',
      'GeneID:10',
      'GeneID:30',
      'accession:A9',
    ]);
    expect(targetStatement(targets[0] as TargetRollup)).toBe(
      'Active in 1 of 1 assay; most potent active: Kd 0.1 uM (AID 6)',
    );
  });

  it('lists non-Active outcomes in a fixed order, then any other outcome, with a blank one named', () => {
    const [target] = rollUpTargets(
      summary([
        row(1, 'Probe', { targetGeneId: 7 }),
        row(2, 'Unspecified', { targetGeneId: 7 }),
        row(3, '', { targetGeneId: 7 }),
        // A value on a non-Active row never becomes the most potent active.
        row(4, 'Inactive', { targetGeneId: 7, activityValues: [{ value: 0.5 }] }),
        row(5, 'Inconclusive', { targetGeneId: 7 }),
        row(6, 'Active', { targetGeneId: 7, activityValues: [{ value: 3 }] }),
      ]),
    );

    expect(targetStatement(target as TargetRollup)).toBe(
      'Active in 1 of 6 assays (Inactive 1, Inconclusive 1, Unspecified 1, no outcome 1, Probe 1); most potent active: 3 (AID 6)',
    );
  });

  it('counts an AID once per target, joining identifiers through their group', () => {
    const targets = rollUpTargets(
      summary(
        [
          row(1, 'Active', {
            targetAccession: 'P1',
            targetGeneId: 5,
            activityValues: [{ name: 'IC50', value: 4, unit: 'uM' }],
            otherTargets: [{ geneId: 6, outcome: 'Inactive', activityValues: [] }],
          }),
          row(2, 'Inactive', { targetAccession: 'NP_1' }),
          // A second row of AID 1 naming the same group through its other accession.
          row(1, 'Inactive', { targetAccession: 'NP_1' }),
          row(3, 'Unspecified', { targetGeneId: 5 }),
          // An AID with no target is left out.
          row(4, 'Active', { activityValues: [{ value: 0.001 }] }),
        ],
        [{ accessions: ['P1', 'NP_1'], geneIds: [5] }],
      ),
    );

    expect(targets.map((t) => [identifierLabel(t.identifier), targetStatement(t)])).toEqual([
      [
        'GeneID:5',
        'Active in 1 of 3 assays (Inactive 1, Unspecified 1); most potent active: IC50 4 uM (AID 1)',
      ],
      ['GeneID:6', 'Active in 0 of 1 assay (Inactive 1)'],
    ]);
    expect(targets.every((t) => t.groupGeneIdCount === undefined)).toBe(true);
  });

  it('returns no targets for an empty summary', () => {
    expect(rollUpTargets(summary([]))).toEqual([]);
  });
});
