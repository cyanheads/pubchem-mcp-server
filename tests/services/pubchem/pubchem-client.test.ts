/**
 * @fileoverview Client-level tests for PubChemClient parsing logic.
 * Mocks `fetch` directly to exercise getAssaySummary (parseAssayTable) and getDescription
 * with realistic PubChem response shapes — including the empty-cell and duplicate-row
 * cases that drove issues #6 and #7.
 * @module services/pubchem/pubchem-client.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PubChemClient } from '@/services/pubchem/pubchem-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PubChemClient.getAssaySummary parseAssayTable (#6)', () => {
  it('skips empty-string activity values instead of producing 0 uM (regression)', async () => {
    // Mirrors PubChem's actual response for AID 1195 (FDAMDD) — empty string in Activity Value.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: [
              'AID',
              'Assay Name',
              'Activity Outcome',
              'Target Accession',
              'Target GeneID',
              'Activity Value [uM]',
              'Activity Name',
            ],
          },
          Row: [
            { Cell: [1195, 'FDAMDD', 'Active', '', '', '', ''] },
            { Cell: [1811, 'PDB binding affinity', 'Active', '1OXR_A', '', '   ', ''] },
            { Cell: [240795, 'COX-1 inhibition', 'Active', 'P05979', '443551', '0.3', 'IC50'] },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(2244);

    expect(rows).toHaveLength(3);
    // Empty-cell AIDs must NOT have a phantom 0-µM activity value.
    expect(rows.find((r) => r.aid === 1195)!.activityValues).toEqual([]);
    expect(rows.find((r) => r.aid === 1811)!.activityValues).toEqual([]);
    // Real value should still come through unchanged.
    expect(rows.find((r) => r.aid === 240795)!.activityValues).toEqual([
      { name: 'IC50', value: 0.3, unit: 'uM' },
    ]);
  });

  it('does NOT filter genuine zero values when delivered as numbers', async () => {
    // A literal numeric 0 is real (e.g. depositor reported 0% inhibition); only blanks should be dropped.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: [
              'AID',
              'Assay Name',
              'Activity Outcome',
              'Activity Value [%]',
              'Activity Name',
            ],
          },
          Row: [{ Cell: [50000, 'Inhibition assay', 'Inactive', 0, 'Inhibition'] }],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(1);

    expect(rows[0]!.activityValues).toEqual([{ name: 'Inhibition', value: 0, unit: '%' }]);
  });

  it('dedupes identical activity entries within an AID (regression)', async () => {
    // PubChem returns multiple replicate rows for AID 92967 — same IC50 value appears twice.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: [
              'AID',
              'Assay Name',
              'Activity Outcome',
              'Target Accession',
              'Target GeneID',
              'Activity Value [uM]',
              'Activity Name',
            ],
          },
          Row: [
            {
              Cell: [
                92967,
                'Arachidonic acid platelet aggregation',
                'Active',
                'P05106',
                3690,
                5,
                'IC50',
              ],
            },
            {
              Cell: [
                92967,
                'Arachidonic acid platelet aggregation',
                'Active',
                'P05106',
                3690,
                5,
                'IC50',
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(2244);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.activityValues).toEqual([{ name: 'IC50', value: 5, unit: 'uM' }]);
  });

  it('keeps distinct activity entries that share the same AID', async () => {
    // Same AID, different IC50 values (e.g. against COX-1 and COX-2) — must NOT dedup.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: [
              'AID',
              'Assay Name',
              'Activity Outcome',
              'Activity Value [uM]',
              'Activity Name',
            ],
          },
          Row: [
            { Cell: [12345, 'Multi-target', 'Active', 0.3, 'IC50'] },
            { Cell: [12345, 'Multi-target', 'Active', 2.4, 'IC50'] },
            { Cell: [12345, 'Multi-target', 'Active', 0.3, 'EC50'] },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(2244);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.activityValues).toEqual([
      { name: 'IC50', value: 0.3, unit: 'uM' },
      { name: 'IC50', value: 2.4, unit: 'uM' },
      { name: 'EC50', value: 0.3, unit: 'uM' },
    ]);
  });

  it('handles an empty result set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: { Column: ['AID', 'Assay Name', 'Activity Outcome'] },
          Row: [],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(99999999);

    expect(rows).toEqual([]);
  });

  it('rejects NaN/Infinity activity values', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: [
              'AID',
              'Assay Name',
              'Activity Outcome',
              'Activity Value [uM]',
              'Activity Name',
            ],
          },
          Row: [
            { Cell: [1, 'NaN cell', 'Active', 'not a number', 'IC50'] },
            { Cell: [2, 'Real value', 'Active', 1.5, 'IC50'] },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(2244);

    expect(rows.find((r) => r.aid === 1)!.activityValues).toEqual([]);
    expect(rows.find((r) => r.aid === 2)!.activityValues).toEqual([
      { name: 'IC50', value: 1.5, unit: 'uM' },
    ]);
  });
});

describe('PubChemClient fast-search record cap (#41)', () => {
  const cidResponse = (cids: number[]) => jsonResponse({ IdentifierList: { CID: cids } });
  const requestedUrl = () => String(fetchMock.mock.calls[0]![0]);

  it('bounds fastformula with MaxRecords', async () => {
    fetchMock.mockResolvedValueOnce(cidResponse([5988, 79025]));

    const client = new PubChemClient();
    const cids = await client.searchByFormula('C6H12O6', false, 21);

    expect(cids).toEqual([5988, 79025]);
    expect(requestedUrl()).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastformula/C6H12O6/cids/JSON?MaxRecords=21',
    );
  });

  it('keeps AllowOtherElements alongside the cap', async () => {
    fetchMock.mockResolvedValueOnce(cidResponse([5988]));

    const client = new PubChemClient();
    await client.searchByFormula('C6H12O6', true, 21);

    const url = requestedUrl();
    expect(url).toContain('MaxRecords=21');
    expect(url).toContain('AllowOtherElements=true');
  });

  it('bounds fastsubstructure on the SMILES POST path', async () => {
    fetchMock.mockResolvedValueOnce(cidResponse([135, 243]));

    const client = new PubChemClient();
    await client.searchByStructure('substructure', 'c1ccccc1C(=O)O', 'smiles', undefined, 21);

    expect(requestedUrl()).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastsubstructure/smiles/cids/JSON?MaxRecords=21',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('smiles=c1ccccc1C%28%3DO%29O');
  });

  it('bounds fastsuperstructure on the CID GET path', async () => {
    fetchMock.mockResolvedValueOnce(cidResponse([2244]));

    const client = new PubChemClient();
    await client.searchByStructure('superstructure', '2244', 'cid', undefined, 21);

    expect(requestedUrl()).toBe(
      'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastsuperstructure/cid/2244/cids/JSON?MaxRecords=21',
    );
  });

  it('bounds fastsimilarity_2d alongside Threshold', async () => {
    fetchMock.mockResolvedValueOnce(cidResponse([2244]));

    const client = new PubChemClient();
    await client.searchByStructure('similarity', '2244', 'cid', 85, 21);

    const url = requestedUrl();
    expect(url).toContain('/compound/fastsimilarity_2d/cid/2244/cids/JSON?');
    expect(url).toContain('MaxRecords=21');
    expect(url).toContain('Threshold=85');
  });

  it('defaults the similarity threshold to 90 when unset', async () => {
    fetchMock.mockResolvedValueOnce(cidResponse([2244]));

    const client = new PubChemClient();
    await client.searchByStructure('similarity', '2244', 'cid', undefined, 21);

    expect(requestedUrl()).toContain('Threshold=90');
  });

  /* The MaxRecords on a search URL bounds that request, not the ListKey PubChem hands back
   * when it answers asynchronously. Without carrying the cap into the retrieval, an async
   * answer returns the whole match set and the caller reads PubChem's 1,000,000 ceiling as
   * a floor — the misreport the cap exists to prevent. */
  it('carries the cap into an async ListKey retrieval and enforces it locally', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ Waiting: { ListKey: 'abc123' } }));
      // PubChem ignoring listkey_count is the case the slice covers: 5 CIDs for a cap of 3.
      fetchMock.mockResolvedValueOnce(cidResponse([1, 2, 3, 4, 5]));

      const client = new PubChemClient();
      const pending = client.searchByStructure('substructure', 'C', 'smiles', undefined, 3);
      await vi.advanceTimersByTimeAsync(1500);
      const cids = await pending;

      expect(cids).toEqual([1, 2, 3]);
      expect(String(fetchMock.mock.calls[1]![0])).toBe(
        'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/listkey/abc123/cids/JSON?listkey_count=3',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an unbounded identifier lookup unbounded when it goes async', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ Waiting: { ListKey: 'def456' } }));
      fetchMock.mockResolvedValueOnce(cidResponse([1, 2, 3, 4, 5]));

      const client = new PubChemClient();
      const pending = client.searchByName('aspirin');
      await vi.advanceTimersByTimeAsync(1500);
      const cids = await pending;

      expect(cids).toEqual([1, 2, 3, 4, 5]);
      expect(String(fetchMock.mock.calls[1]![0])).toBe(
        'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/listkey/def456/cids/JSON',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PubChemClient.getDescription (#7)', () => {
  it('dedupes byte-identical descriptions reposted by multiple depositors and tags sources', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 2244,
          Reference: [
            { ReferenceNumber: 1, SourceName: 'DrugBank' },
            { ReferenceNumber: 2, SourceName: 'Wikipedia' },
            { ReferenceNumber: 3, SourceName: 'ChEBI' },
          ],
          Section: [
            {
              TOCHeading: 'Names and Identifiers',
              Section: [
                {
                  TOCHeading: 'Record Description',
                  Information: [
                    {
                      ReferenceNumber: 1,
                      Value: {
                        StringWithMarkup: [
                          { String: 'Aspirin is a commonly used drug for pain and fever.' },
                        ],
                      },
                    },
                    {
                      // Exact byte-duplicate from a different depositor — should be dropped.
                      ReferenceNumber: 2,
                      Value: {
                        StringWithMarkup: [
                          { String: 'Aspirin is a commonly used drug for pain and fever.' },
                        ],
                      },
                    },
                    {
                      ReferenceNumber: 3,
                      Value: {
                        StringWithMarkup: [
                          { String: 'Acetylsalicylic acid is a member of the benzoic acids.' },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const descriptions = await client.getDescription(2244);

    // Two distinct entries: the duplicate Wikipedia repost is dropped.
    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]).toEqual({
      source: 'DrugBank',
      text: 'Aspirin is a commonly used drug for pain and fever.',
    });
    expect(descriptions[1]).toEqual({
      source: 'ChEBI',
      text: 'Acetylsalicylic acid is a member of the benzoic acids.',
    });
  });

  it('keeps paraphrased descriptions that share a theme but differ in wording', async () => {
    // Real-world depositor descriptions rarely share an exact prefix; we should NOT collapse them.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 2244,
          Reference: [
            { ReferenceNumber: 1, SourceName: 'A' },
            { ReferenceNumber: 2, SourceName: 'B' },
          ],
          Section: [
            {
              TOCHeading: 'Record Description',
              Information: [
                {
                  ReferenceNumber: 1,
                  Value: {
                    StringWithMarkup: [{ String: 'Aspirin is an NSAID used for pain.' }],
                  },
                },
                {
                  ReferenceNumber: 2,
                  Value: {
                    StringWithMarkup: [
                      { String: 'Aspirin is a non-steroidal anti-inflammatory used for pain.' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const descriptions = await client.getDescription(2244);

    expect(descriptions).toHaveLength(2);
  });

  it('preserves descriptions without source attribution when ReferenceNumber is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Section: [
            {
              TOCHeading: 'Record Description',
              Information: [
                {
                  Value: {
                    StringWithMarkup: [{ String: 'A description without a reference.' }],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const descriptions = await client.getDescription(1);

    expect(descriptions).toEqual([{ text: 'A description without a reference.' }]);
  });

  it('returns an empty array when no Record Description section exists', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Section: [{ TOCHeading: 'Some Other Section' }],
        },
      }),
    );

    const client = new PubChemClient();
    const descriptions = await client.getDescription(1);

    expect(descriptions).toEqual([]);
  });

  it('returns an empty array when the API returns 404', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
    );

    const client = new PubChemClient();
    const descriptions = await client.getDescription(999999999);

    expect(descriptions).toEqual([]);
  });

  it('case-insensitive dedup ignores whitespace differences', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Reference: [
            { ReferenceNumber: 1, SourceName: 'A' },
            { ReferenceNumber: 2, SourceName: 'B' },
          ],
          Section: [
            {
              TOCHeading: 'Record Description',
              Information: [
                {
                  ReferenceNumber: 1,
                  Value: { StringWithMarkup: [{ String: 'The Same Description Text Here' }] },
                },
                {
                  ReferenceNumber: 2,
                  Value: {
                    StringWithMarkup: [{ String: 'the   same\ndescription   text\there' }],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const descriptions = await client.getDescription(1);

    // Whitespace and casing differences alone should not bypass dedup.
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]!.source).toBe('A');
  });
});
