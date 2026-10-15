/**
 * @fileoverview Tests for the compound bioactivity resource, run through the real client
 * against PubChem's assaysummary wire shape.
 * @module mcp-server/resources/definitions/compound-bioactivity.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compoundBioactivityResource } from '@/mcp-server/resources/definitions/compound-bioactivity.resource.js';
import type { BioactivityRow } from '@/services/pubchem/types.js';

/** Read the resource for CID 2244. */
const read = async () =>
  (await compoundBioactivityResource.handler({ cid: 2244 }, createMockContext())) as {
    cid: number;
    totalAssays: number;
    activeCount: number;
    results: BioactivityRow[];
  };

const mockClient = {
  getAssaySummary: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

const { PubChemClient } = await vi.importActual<
  typeof import('@/services/pubchem/pubchem-client.js')
>('@/services/pubchem/pubchem-client.js');

const COLUMNS = [
  'AID',
  'Assay Name',
  'Activity Outcome',
  'Target Accession',
  'Target GeneID',
  'Activity Value [uM]',
  'Activity Name',
];

function serveRows(rows: Array<Array<string | number>>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (
        url.hostname === 'pubchem.ncbi.nlm.nih.gov' &&
        url.pathname.endsWith('/assaysummary/JSON')
      ) {
        return Response.json({
          Table: { Columns: { Column: COLUMNS }, Row: rows.map((Cell) => ({ Cell })) },
        });
      }
      throw new Error('unmocked fetch');
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockClient.getAssaySummary.mockImplementation((cid: number, signal?: AbortSignal) =>
    new PubChemClient().getAssaySummary(cid, signal),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compoundBioactivityResource', () => {
  it('returns single-target records in their existing shape', async () => {
    serveRows([
      [1000, 'COX-1 inhibition', 'Active', 'P23219', 5742, 1.5, 'IC50'],
      [1000, 'COX-1 inhibition', 'Active', 'P23219', 5742, 2.5, 'IC50'],
      [2000, 'Cytotoxicity', 'Inactive', '', '', '', ''],
    ]);

    const result = await read();

    expect(result).toEqual({
      cid: 2244,
      totalAssays: 2,
      activeCount: 1,
      results: [
        {
          aid: 1000,
          assayName: 'COX-1 inhibition',
          outcome: 'Active',
          targetAccession: 'P23219',
          targetGeneId: 5742,
          activityValues: [
            { name: 'IC50', value: 1.5, unit: 'uM' },
            { name: 'IC50', value: 2.5, unit: 'uM' },
          ],
        },
        { aid: 2000, assayName: 'Cytotoxicity', outcome: 'Inactive', activityValues: [] },
      ],
    });
  });

  it('attributes each value of a multi-target assay to the target it was measured against (#73)', async () => {
    serveRows([
      [1801480, 'COX inhibition', 'Active', 'P05979', 443551, 1.7, 'IC50'],
      [1801480, 'COX inhibition', 'Inactive', 'P35354', 5743, 100, 'IC50'],
    ]);

    const result = await read();

    expect(result.results).toEqual([
      {
        aid: 1801480,
        assayName: 'COX inhibition',
        outcome: 'Active',
        targetAccession: 'P05979',
        targetGeneId: 443551,
        activityValues: [{ name: 'IC50', value: 1.7, unit: 'uM' }],
        otherTargets: [
          {
            accession: 'P35354',
            geneId: 5743,
            outcome: 'Inactive',
            activityValues: [{ name: 'IC50', value: 100, unit: 'uM' }],
          },
        ],
      },
    ]);
  });

  it('caps the results at 25 while counting every assay', async () => {
    serveRows(
      Array.from({ length: 30 }, (_, i) => [i + 1, `Assay ${i + 1}`, 'Active', '', '', '', '']),
    );

    const result = await read();

    expect(result.totalAssays).toBe(30);
    expect(result.activeCount).toBe(30);
    expect(result.results).toHaveLength(25);
  });
});
