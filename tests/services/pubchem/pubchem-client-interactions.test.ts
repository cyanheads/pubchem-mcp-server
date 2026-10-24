/**
 * @fileoverview Client-level tests for the interaction and 3D methods. Mocks `fetch` to
 * exercise the drug-drug SDQ mapping, the drug-food inline path, the target rollup over the
 * assay summary with its batched name lookups, and the 3D SDF / conformer endpoints.
 * @module services/pubchem/pubchem-client-interactions.test
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PubChemClient } from '@/services/pubchem/pubchem-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const textResponse = (body: string, status = 200, type = 'text/plain') =>
  new Response(body, { status, headers: { 'Content-Type': type } });

/** SDQ answers a `select` projection with an SDQOutputSet envelope carrying totalCount. */
const sdqResponse = (rows: Array<Record<string, unknown>>, totalCount = rows.length): Response =>
  jsonResponse({ SDQOutputSet: [{ status: { code: 0 }, totalCount, rows }] });

type AssayCell = string | number;
/** An assay summary table with the columns the target rollup reads, one row per cell tuple:
 * AID, outcome, accession, Gene ID, value (µM), activity name. */
const assayTable = (
  rows: Array<[number, string, AssayCell, AssayCell, AssayCell, AssayCell]>,
): unknown => ({
  Table: {
    Columns: {
      Column: [
        'AID',
        'Activity Outcome',
        'Target Accession',
        'Target GeneID',
        'Activity Value [uM]',
        'Activity Name',
      ],
    },
    Row: rows.map((Cell) => ({ Cell })),
  },
});

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PubChemClient.getInteractions (#12)', () => {
  it('maps drug-drug SDQ rows: descr → text, name2 → partner, source DrugBank', async () => {
    fetchMock.mockResolvedValueOnce(
      sdqResponse([
        { cid: 54678486, name2: 'Lepirudin', descr: 'Risk of bleeding increased.' },
        { cid: 54678486, descr: 'Metabolism increased.' },
        { cid: 54678486, name2: 'Empty', descr: '' }, // dropped — no text
      ]),
    );
    const client = new PubChemClient();
    const { entries } = await client.getInteractions(54678486, ['drug-drug'], 10, 0);

    expect(entries).toEqual([
      {
        kind: 'drug-drug',
        source: 'DrugBank',
        text: 'Risk of bleeding increased.',
        partner: 'Lepirudin',
      },
      { kind: 'drug-drug', source: 'DrugBank', text: 'Metabolism increased.' },
    ]);
    // SDQ query targets the drugbankddi collection for the CID.
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('sdqagent.cgi');
    expect(decodeURIComponent(url)).toContain('drugbankddi');
    expect(decodeURIComponent(url)).toContain('"cid":"54678486"');
  });

  it('maps drug-food PUG View StringWithMarkup with source attribution', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 54678486,
          Reference: [{ ReferenceNumber: 20, SourceName: 'DrugBank' }],
          Section: [
            {
              TOCHeading: 'Drug-Food Interactions',
              Information: [
                {
                  ReferenceNumber: 20,
                  Value: { StringWithMarkup: [{ String: 'Avoid foods rich in vitamin K.' }] },
                },
              ],
            },
          ],
        },
      }),
    );
    const client = new PubChemClient();
    const { entries } = await client.getInteractions(54678486, ['drug-food'], 10, 0);

    expect(entries).toEqual([
      { kind: 'drug-food', source: 'DrugBank', text: 'Avoid foods rich in vitamin K.' },
    ]);
  });

  it('returns [] for an empty SDQ result', async () => {
    fetchMock.mockResolvedValueOnce(sdqResponse([]));
    const client = new PubChemClient();
    expect((await client.getInteractions(962, ['drug-drug'], 10, 0)).entries).toEqual([]);
  });

  it('reports a malformed SDQ body as a failed kind, never an opaque parse error (#20)', async () => {
    // Unescaped quotes inside a value — the shape PubChem emits for citation-bearing rows.
    fetchMock.mockResolvedValueOnce(
      textResponse('[{"name2":"Drug "X"","descr":"Risk of bleeding increased."}]'),
    );
    const client = new PubChemClient();
    const { entries, failedKinds } = await client.getInteractions(5291, ['drug-drug'], 10, 0);

    expect(entries).toEqual([]);
    expect(failedKinds).toHaveLength(1);
    expect(failedKinds[0]!.kind).toBe('drug-drug');
    expect(failedKinds[0]!.message).toContain('unparseable');
  });

  it('isolates a failing kind — the others still return their entries (#21)', async () => {
    fetchMock.mockImplementation((input) => {
      const url = new URL(String(input));
      if (url.hostname === 'pubchem.ncbi.nlm.nih.gov' && url.pathname === '/sdq/sdqagent.cgi') {
        // drug-drug → malformed JSON, rejects inside the per-kind fetch
        return Promise.resolve(
          textResponse('[{"name2":"Kinase "X" (human)","descr":"Risk of bleeding"}]'),
        );
      }
      return Promise.resolve(
        jsonResponse({
          Record: {
            Section: [
              {
                TOCHeading: 'Drug-Food Interactions',
                Information: [{ Value: { StringWithMarkup: [{ String: 'Take with food.' }] } }],
              },
            ],
          },
        }),
      );
    });
    const client = new PubChemClient();
    const { entries, failedKinds } = await client.getInteractions(
      5291,
      ['drug-drug', 'drug-food'],
      10,
      0,
    );

    expect(entries).toEqual([{ kind: 'drug-food', source: 'PubChem', text: 'Take with food.' }]);
    expect(failedKinds.map((f) => f.kind)).toEqual(['drug-drug']);
  });

  it('reports an SDQ-rejected query as a failed kind rather than an empty page', async () => {
    // A populated status.error beside empty rows is a rejection, not an absence — asserted on a
    // 2xx body so the check holds even when the rejection does not arrive as a 5xx.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        SDQOutputSet: [
          { status: { code: -4, error: 'eSphinxSearchBusy' }, totalCount: 0, rows: [] },
        ],
      }),
    );
    const client = new PubChemClient();
    const { entries, pages, failedKinds } = await client.getInteractions(
      2244,
      ['drug-drug'],
      10,
      0,
    );

    expect(entries).toEqual([]);
    expect(pages).toEqual([]);
    expect(failedKinds[0]!.message).toContain('eSphinxSearchBusy');
  });
});

describe('PubChemClient.getInteractions — SDQ answers that are not SDQ data (#62)', () => {
  /** The NCBI site 404 page SDQ answers every request with — the live shape, abridged. */
  const NCBI_404_PAGE =
    '<!DOCTYPE html> <html lang="en"> <head> <meta charset="UTF-8"> <title>404: Not Found</title> </head><body>Page not found</body></html>';
  const RECAPTCHA_PAGE =
    '<!DOCTYPE html><html><head><title>reCAPTCHA</title></head><body><form>Verify you are human</form></body></html>';

  const sdqHost = (input: unknown) =>
    new URL(String(input)).pathname.startsWith('/sdq/') ? 'sdq' : 'pugview';

  it.each([
    ['an HTTP 404 HTML page', () => textResponse(NCBI_404_PAGE, 404, 'text/html')],
    ['an HTTP 403 HTML page', () => textResponse(NCBI_404_PAGE, 403, 'text/html')],
    ['an HTTP 200 reCAPTCHA page', () => textResponse(RECAPTCHA_PAGE, 200, 'text/html')],
    ['HTTP 200 JSON without SDQOutputSet', () => jsonResponse({ error: 'not an SDQ envelope' })],
  ])('fails drug-drug as sdq_unavailable on %s, never as zero records', async (_l, respond) => {
    fetchMock.mockImplementation(async () => respond());

    const { entries, pages, failedKinds } = await new PubChemClient().getInteractions(
      2244,
      ['drug-drug'],
      10,
      0,
    );

    expect(entries).toEqual([]);
    expect(pages).toEqual([]);
    expect(failedKinds).toEqual([
      { kind: 'drug-drug', reason: 'sdq_unavailable', message: expect.any(String) },
    ]);
    for (const { message } of failedKinds) {
      expect(message).toContain('SDQ');
      expect(message).not.toMatch(
        /DOCTYPE|<html|reCAPTCHA|Verify you are human|not an SDQ envelope/,
      );
    }
    // A refusal is not retried: one request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers target beside a refused drug-drug without asking SDQ for it (#78)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const { pathname } = new URL(String(input));
      if (pathname.startsWith('/sdq/')) return textResponse(NCBI_404_PAGE, 404, 'text/html');
      if (pathname.endsWith('/assaysummary/JSON')) {
        return jsonResponse(assayTable([[1, 'Active', '', 1956, 0.5, 'IC50']]));
      }
      return jsonResponse({ Fault: { Code: 'PUGREST.NotFound', Message: 'No summary' } }, 404);
    });

    const { entries, pages, failedKinds } = await new PubChemClient().getInteractions(
      2244,
      ['drug-drug', 'target'],
      10,
      0,
    );

    expect(failedKinds).toEqual([
      { kind: 'drug-drug', reason: 'sdq_unavailable', message: expect.any(String) },
    ]);
    expect(entries).toEqual([
      {
        kind: 'target',
        partner: 'GeneID:1956',
        source: 'PubChem BioAssay',
        text: 'Active in 1 of 1 assay; most potent active: IC50 0.5 uM (AID 1)',
      },
    ]);
    expect(pages).toEqual([
      { kind: 'target', returnedCount: 1, totalRecords: 1, recordsConsumed: 1 },
    ]);
    const sdqQueries = fetchMock.mock.calls
      .map(([u]) => new URL(String(u)))
      .filter((u) => u.pathname.startsWith('/sdq/'))
      .map((u) => JSON.parse(u.searchParams.get('query') ?? '{}').collection);
    expect(sdqQueries).toEqual(['drugbankddi']);
  });

  it('keeps a 5xx a plain retryable failure with no sdq_unavailable reason', async () => {
    fetchMock.mockImplementation(async () => textResponse('busy', 503));

    const { failedKinds } = await new PubChemClient().getInteractions(2244, ['drug-drug'], 10, 0);

    expect(failedKinds).toHaveLength(1);
    expect(failedKinds[0]).not.toHaveProperty('reason');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('still returns drug-food from PUG View beside a refused SDQ kind', async () => {
    fetchMock.mockImplementation(async (input) =>
      sdqHost(input) === 'sdq'
        ? textResponse(NCBI_404_PAGE, 404, 'text/html')
        : jsonResponse({
            Record: {
              Reference: [{ ReferenceNumber: 1, SourceName: 'DrugBank' }],
              Section: [
                {
                  TOCHeading: 'Drug-Food Interactions',
                  Information: [
                    {
                      ReferenceNumber: 1,
                      Value: { StringWithMarkup: [{ String: 'Take with food.' }] },
                    },
                  ],
                },
              ],
            },
          }),
    );

    const { entries, pages, failedKinds } = await new PubChemClient().getInteractions(
      2244,
      ['drug-drug', 'drug-food'],
      10,
      0,
    );

    expect(entries).toEqual([{ kind: 'drug-food', source: 'DrugBank', text: 'Take with food.' }]);
    expect(pages.map((p) => p.kind)).toEqual(['drug-food']);
    expect(failedKinds.map((f) => f.kind)).toEqual(['drug-drug']);
  });

  it('keeps a drug-food PUG View 404 as zero records, not a failed kind', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Fault: { Code: 'PUGVIEW.NotFound', Message: 'No data found' } }, 404),
    );

    const { pages, failedKinds } = await new PubChemClient().getInteractions(
      241,
      ['drug-food'],
      10,
      0,
    );

    expect(failedKinds).toEqual([]);
    expect(pages).toEqual([
      { kind: 'drug-food', returnedCount: 0, totalRecords: 0, recordsConsumed: 0 },
    ]);
  });
});

describe('PubChemClient.getInteractions paging (#38)', () => {
  it('projects with select and translates the zero-based offset to SDQ start', async () => {
    fetchMock.mockResolvedValueOnce(
      sdqResponse([{ cid: 2244, name2: 'Warfarin', descr: 'Bleeding risk increased.' }], 1777),
    );
    const client = new PubChemClient();
    const { pages } = await client.getInteractions(2244, ['drug-drug'], 10, 40);

    const query = decodeURIComponent(fetchMock.mock.calls[0]![0] as string);
    expect(query).toContain('"select":["cid","name2","descr"]');
    expect(query).toContain('"start":41');
    expect(query).toContain('"limit":10');
    expect(pages).toEqual([
      { kind: 'drug-drug', returnedCount: 1, totalRecords: 1777, recordsConsumed: 1 },
    ]);
  });

  it('slices the inline drug-food list at the offset and reports the full item total', async () => {
    const item = (s: string) => ({ Value: { StringWithMarkup: [{ String: s }] } });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 2244,
          Section: [
            {
              TOCHeading: 'Drug-Food Interactions',
              Information: [
                item('Take with food.'),
                item('Avoid alcohol.'),
                item('Avoid grapefruit.'),
              ],
            },
          ],
        },
      }),
    );
    const client = new PubChemClient();
    const { entries, pages } = await client.getInteractions(2244, ['drug-food'], 1, 1);

    expect(entries.map((e) => e.text)).toEqual(['Avoid alcohol.']);
    expect(pages[0]).toEqual({
      kind: 'drug-food',
      returnedCount: 1,
      totalRecords: 3,
      recordsConsumed: 1,
    });
  });

  it('recovers the record total with a probe when the offset overshoots the last SDQ record', async () => {
    // SDQ reports totalCount 0 alongside an eNoHitsFound page, so the bound needs a second read.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          SDQOutputSet: [
            { status: { code: 0, warning: ['eNoHitsFound (227.22)'] }, totalCount: 0, rows: [] },
          ],
        }),
      )
      .mockResolvedValueOnce(sdqResponse([{ cid: 2244 }], 1777));
    const client = new PubChemClient();
    const { entries, pages } = await client.getInteractions(2244, ['drug-drug'], 10, 5000);

    expect(entries).toEqual([]);
    expect(pages[0]).toEqual({
      kind: 'drug-drug',
      returnedCount: 0,
      totalRecords: 1777,
      recordsConsumed: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(fetchMock.mock.calls[1]![0] as string)).toContain('"start":1');
  });

  it('does not probe for a total when an empty page was requested from the start', async () => {
    fetchMock.mockResolvedValueOnce(sdqResponse([], 0));
    const client = new PubChemClient();
    const { pages } = await client.getInteractions(962, ['drug-drug'], 10, 0);

    expect(pages[0]!.totalRecords).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PubChemClient.getInteractions — target from the assay summary (#78)', () => {
  /** Five targets: a Gene ID group (1956 with P00533, NP_005219), an unpaired accession, an
   * Active target with no value, an unpaired Gene ID, and a group joining two Gene IDs through
   * WP_1. AID 50 names two targets; AID 60 names none. */
  const TABLE = assayTable([
    [10, 'Active', 'P00533', 1956, 0.5, 'IC50'],
    [11, 'Active', 'P00533', '', 0.02, 'IC50'],
    [12, 'Inactive', 'NP_005219', 1956, '', ''],
    [13, 'Unspecified', '', 1956, '', ''],
    [20, 'Active', 'Q99999', '', 5, 'Ki'],
    [21, 'Inactive', '', 7777, '', ''],
    [22, 'Inactive', '', 7777, '', ''],
    [30, 'Inconclusive', 'WP_1', 501, '', ''],
    [31, 'Inactive', 'WP_1', 502, '', ''],
    [32, 'Inactive', 'NP_9', 501, '', ''],
    [40, 'Active', '', 8888, '', ''],
    [50, 'Active', 'P00533', 1956, 3, 'EC50'],
    [50, 'Inactive', '', 7777, '', ''],
    [60, 'Active', '', '', 1, 'IC50'],
  ]);
  /** Returned out of request order, with 8888 left out. */
  const GENES = {
    GeneSummaries: {
      GeneSummary: [
        { GeneID: 7777, Symbol: 'Abc1', Name: '', Taxonomy: 'Mus musculus (house mouse)' },
        {
          GeneID: 1956,
          Symbol: 'EGFR',
          Name: 'epidermal growth factor receptor',
          Taxonomy: 'Homo sapiens (human)',
        },
      ],
    },
  };
  /** Q99999 left out. */
  const PROTEINS = {
    ProteinSummaries: {
      ProteinSummary: [
        {
          ProteinAccession: 'WP_1',
          Name: 'MULTISPECIES: response regulator FixJ',
          Taxonomy: 'Burkholderia',
        },
      ],
    },
  };
  const notFound = () =>
    jsonResponse({ Fault: { Code: 'PUGREST.NotFound', Message: 'No summary data' } }, 404);

  /** Routes PUG REST by path; anything else rejects as an unmocked call. */
  function route(answers: {
    summary: () => Response;
    genes?: () => Response;
    proteins?: () => Response;
  }) {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error(`unmocked ${url.host}`);
      if (url.pathname.endsWith('/assaysummary/JSON')) return answers.summary();
      if (url.pathname.startsWith('/rest/pug/gene/geneid/') && answers.genes)
        return answers.genes();
      if (url.pathname.startsWith('/rest/pug/protein/accession/') && answers.proteins) {
        return answers.proteins();
      }
      throw new Error(`unmocked ${url.pathname}`);
    });
  }
  const paths = () => fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname);

  /** Runs a call under fake timers, so the client's rate limiter and retry backoff never wait
   * in real time. */
  async function settled<T>(call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const pending = call();
      await vi.runAllTimersAsync();
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  const FULL = [
    {
      kind: 'target',
      partner: 'EGFR - epidermal growth factor receptor [Homo sapiens (human)] (GeneID:1956)',
      source: 'PubChem BioAssay',
      text: 'Active in 3 of 5 assays (Inactive 1, Unspecified 1); most potent active: IC50 0.02 uM (AID 11)',
    },
    {
      kind: 'target',
      partner: 'accession:Q99999',
      source: 'PubChem BioAssay',
      text: 'Active in 1 of 1 assay; most potent active: Ki 5 uM (AID 20)',
    },
    {
      kind: 'target',
      partner: 'GeneID:8888',
      source: 'PubChem BioAssay',
      text: 'Active in 1 of 1 assay',
    },
    {
      kind: 'target',
      partner: 'Abc1 [Mus musculus (house mouse)] (GeneID:7777)',
      source: 'PubChem BioAssay',
      text: 'Active in 0 of 3 assays (Inactive 3)',
    },
    {
      kind: 'target',
      partner:
        'MULTISPECIES: response regulator FixJ [Burkholderia] (accession:WP_1, group of 2 Gene IDs)',
      source: 'PubChem BioAssay',
      text: 'Active in 0 of 3 assays (Inactive 2, Inconclusive 1)',
    },
  ];

  it('rolls the summary up to one entry per target, named by the ID each lookup returned', async () => {
    route({
      summary: () => jsonResponse(TABLE),
      genes: () => jsonResponse(GENES),
      proteins: () => jsonResponse(PROTEINS),
    });

    const { entries, pages, failedKinds } = await new PubChemClient().getInteractions(
      1,
      ['target'],
      10,
      0,
    );

    expect(failedKinds).toEqual([]);
    expect(entries).toEqual(FULL);
    expect(pages).toEqual([
      { kind: 'target', returnedCount: 5, totalRecords: 5, recordsConsumed: 5 },
    ]);
    // One summary read and one batched lookup per identifier kind, in page order; no SDQ.
    expect(paths()).toEqual([
      '/rest/pug/compound/cid/1/assaysummary/JSON',
      '/rest/pug/gene/geneid/1956,8888,7777/summary/JSON',
      '/rest/pug/protein/accession/Q99999,WP_1/summary/JSON',
    ]);
  });

  it('pages over targets — first, second, last, past the end — looking up only each page', async () => {
    route({
      summary: () => jsonResponse(TABLE),
      genes: () => jsonResponse(GENES),
      proteins: () => jsonResponse(PROTEINS),
    });
    const client = new PubChemClient();
    const walked: unknown[] = [];

    for (const [offset, consumed, lookups] of [
      [
        0,
        2,
        [
          '/rest/pug/gene/geneid/1956/summary/JSON',
          '/rest/pug/protein/accession/Q99999/summary/JSON',
        ],
      ],
      [2, 2, ['/rest/pug/gene/geneid/8888,7777/summary/JSON']],
      [4, 1, ['/rest/pug/protein/accession/WP_1/summary/JSON']],
      [5, 0, []],
    ] as const) {
      fetchMock.mockClear();
      const { entries, pages } = await settled(() =>
        client.getInteractions(1, ['target'], 2, offset),
      );
      walked.push(...entries);
      expect(pages).toEqual([
        { kind: 'target', returnedCount: consumed, totalRecords: 5, recordsConsumed: consumed },
      ]);
      expect(paths()).toEqual(['/rest/pug/compound/cid/1/assaysummary/JSON', ...lookups]);
    }
    // The walk reaches every target once, in the single-page order.
    expect(walked).toEqual(FULL);
  });

  it.each([
    [
      'a rejected (400)',
      () => jsonResponse({ Fault: { Code: 'PUGREST.BadRequest', Message: 'Bad request' } }, 400),
    ],
    ['a transient (503)', () => textResponse('busy', 503)],
  ])(
    'keeps identifiers and flags the page, without retrying or failing the kind, on %s name lookup',
    async (_label, genes) => {
      route({ summary: () => jsonResponse(TABLE), genes, proteins: () => jsonResponse(PROTEINS) });

      const { entries, pages, failedKinds } = await settled(() =>
        new PubChemClient().getInteractions(1, ['target'], 10, 0),
      );

      expect(failedKinds).toEqual([]);
      expect(entries.map((e) => e.partner)).toEqual([
        'GeneID:1956',
        'accession:Q99999',
        'GeneID:8888',
        'GeneID:7777',
        'MULTISPECIES: response regulator FixJ [Burkholderia] (accession:WP_1, group of 2 Gene IDs)',
      ]);
      expect(entries.map((e) => e.text)).toEqual(FULL.map((e) => e.text));
      expect(pages).toEqual([
        {
          kind: 'target',
          returnedCount: 5,
          totalRecords: 5,
          recordsConsumed: 5,
          namesUnavailable: true,
        },
      ]);
      expect(paths()).toEqual([
        '/rest/pug/compound/cid/1/assaysummary/JSON',
        '/rest/pug/gene/geneid/1956,8888,7777/summary/JSON',
        '/rest/pug/protein/accession/Q99999,WP_1/summary/JSON',
      ]);
    },
  );

  it('reads a lookup PubChem matches nothing in as names absent, not as a failure', async () => {
    route({ summary: () => jsonResponse(TABLE), genes: notFound, proteins: notFound });

    const { entries, pages } = await new PubChemClient().getInteractions(1, ['target'], 10, 0);

    expect(entries.map((e) => e.partner)).toEqual([
      'GeneID:1956',
      'accession:Q99999',
      'GeneID:8888',
      'GeneID:7777',
      'accession:WP_1 (group of 2 Gene IDs)',
    ]);
    expect(pages[0]).not.toHaveProperty('namesUnavailable');
  });

  it('reports zero targets, with no lookup, for a compound with no assay summary', async () => {
    route({ summary: notFound });

    const { entries, pages, failedKinds } = await new PubChemClient().getInteractions(
      962,
      ['target'],
      10,
      0,
    );

    expect(entries).toEqual([]);
    expect(failedKinds).toEqual([]);
    expect(pages).toEqual([
      { kind: 'target', returnedCount: 0, totalRecords: 0, recordsConsumed: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails the kind as retryable when the assay summary has a transient failure', async () => {
    route({ summary: () => textResponse('busy', 503) });

    const { pages, failedKinds } = await settled(() =>
      new PubChemClient().getInteractions(2244, ['target'], 10, 0),
    );

    expect(pages).toEqual([]);
    expect(failedKinds).toEqual([{ kind: 'target', message: expect.stringContaining('503') }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports erlotinib’s 738 targets with the EGFR group first (real assay summary)', async () => {
    const table = readFileSync(
      new URL('../../fixtures/assaysummary-176870-targets.json', import.meta.url),
      'utf8',
    );
    route({
      summary: () => new Response(table, { status: 200 }),
      genes: () => jsonResponse(GENES),
      proteins: notFound,
    });

    const { entries, pages } = await new PubChemClient().getInteractions(176870, ['target'], 50, 0);

    expect(pages).toEqual([
      { kind: 'target', returnedCount: 50, totalRecords: 738, recordsConsumed: 50 },
    ]);
    expect(entries[0]).toEqual({
      kind: 'target',
      partner: 'EGFR - epidermal growth factor receptor [Homo sapiens (human)] (GeneID:1956)',
      source: 'PubChem BioAssay',
      text: 'Active in 253 of 351 assays (Inactive 1, Inconclusive 4, Unspecified 93); most potent active: IC50 0.000029 uM (AID 1956454)',
    });
    // Entries are fixed-size: one partner and one statement each, whatever the group size.
    for (const e of entries)
      expect(Object.keys(e).sort()).toEqual(['kind', 'partner', 'source', 'text']);
  });
});

describe('PubChemClient 3D structure (#15)', () => {
  it('getConformerIds parses the ConformerID list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ InformationList: { Information: [{ CID: 2244, ConformerID: ['A', 'B'] }] } }),
    );
    const client = new PubChemClient();
    expect(await client.getConformerIds(2244)).toEqual(['A', 'B']);
  });

  it('getConformerIds returns [] on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));
    const client = new PubChemClient();
    expect(await client.getConformerIds(999999999)).toEqual([]);
  });

  it('getSdf3d returns the raw SDF body', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('SDF-BODY', 200, 'chemical/x-mdl-sdfile'));
    const client = new PubChemClient();
    expect(await client.getSdf3d(2244)).toBe('SDF-BODY');
  });

  it('getSdf3d throws a typed no_3d_structure not-found on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));
    const client = new PubChemClient();
    await expect(client.getSdf3d(1)).rejects.toMatchObject({
      data: { reason: 'no_3d_structure' },
    });
  });

  it('getSdf3d retries once on 5xx then returns the SDF — fetchText shares the resilient core (#16)', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('Service Unavailable', 503))
      .mockResolvedValueOnce(textResponse('SDF-BODY', 200, 'chemical/x-mdl-sdfile'));
    const client = new PubChemClient();
    expect(await client.getSdf3d(2244)).toBe('SDF-BODY');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);
});
