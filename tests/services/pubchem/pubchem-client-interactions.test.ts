/**
 * @fileoverview Client-level tests for the interaction (SDQ + PUG View) and 3D methods.
 * Mocks `fetch` to exercise the SDQ external-table mapping, the drug-food inline path,
 * and the 3D SDF / conformer endpoints.
 * @module services/pubchem/pubchem-client-interactions.test
 */

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

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
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

  it('maps target bioactivity rows: targetname → partner, activity → text, aidsrcname → source', async () => {
    fetchMock.mockResolvedValueOnce(
      sdqResponse([
        {
          cid: 5291,
          targetname: 'ABL1 - ABL proto-oncogene 1, non-receptor tyrosine kinase (human)',
          acname: 'Kd',
          acqualifier: '=',
          acvalue: '0.001',
          aidsrcname: 'ChEMBL',
        },
        // No acqualifier → activity rendered without it.
        {
          cid: 5291,
          targetname: 'KIT proto-oncogene (human)',
          acname: 'GI50',
          acvalue: '0.001',
          aidsrcname: 'ChEMBL',
        },
        // No targetname → dropped (untargeted assay outcome, covered by pubchem_get_bioactivity).
        { cid: 5291, acname: 'Potency', acvalue: '0.5', aidsrcname: 'NCATS' },
      ]),
    );
    const client = new PubChemClient();
    const { entries } = await client.getInteractions(5291, ['target'], 10, 0);

    // acvalue is PubChem's normalized micromolar figure — the asserted `uM` unit rides the
    // text, and the numeric value is preserved (including the no-qualifier row).
    expect(entries).toEqual([
      {
        kind: 'target',
        source: 'ChEMBL',
        partner: 'ABL1 - ABL proto-oncogene 1, non-receptor tyrosine kinase (human)',
        text: 'Kd = 0.001 uM',
      },
      {
        kind: 'target',
        source: 'ChEMBL',
        partner: 'KIT proto-oncogene (human)',
        text: 'GI50 0.001 uM',
      },
    ]);

    // Scopes via the cid-keyed `bioactivity` collection — not the gene-indexed
    // `consolidatedcompoundtarget` collection whose cid filter was silently ignored (#20).
    const url = decodeURIComponent(fetchMock.mock.calls[0]![0] as string);
    expect(url).toContain('bioactivity');
    expect(url).not.toContain('consolidatedcompoundtarget');
    expect(url).toContain('"cid":"5291"');
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
      textResponse('[{"targetname":"Kinase "X" (human)","acname":"Ki","acvalue":"1"}]'),
    );
    const client = new PubChemClient();
    const { entries, failedKinds } = await client.getInteractions(5291, ['target'], 10, 0);

    expect(entries).toEqual([]);
    expect(failedKinds).toHaveLength(1);
    expect(failedKinds[0]!.kind).toBe('target');
    expect(failedKinds[0]!.message).toContain('unparseable');
  });

  it('isolates a failing kind — the others still return their entries (#21)', async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes('drugbankddi')) {
        return Promise.resolve(
          sdqResponse([{ cid: 5291, name2: 'Lepirudin', descr: 'Risk of bleeding increased.' }]),
        );
      }
      // target → malformed JSON, rejects inside the per-kind fetch
      return Promise.resolve(textResponse('[{"targetname":"Kinase "X" (human)","acname":"Ki"}]'));
    });
    const client = new PubChemClient();
    const { entries, failedKinds } = await client.getInteractions(
      5291,
      ['drug-drug', 'target'],
      10,
      0,
    );

    expect(entries).toEqual([
      {
        kind: 'drug-drug',
        source: 'DrugBank',
        text: 'Risk of bleeding increased.',
        partner: 'Lepirudin',
      },
    ]);
    expect(failedKinds.map((f) => f.kind)).toEqual(['target']);
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
    const { entries, pages, failedKinds } = await client.getInteractions(2244, ['target'], 10, 0);

    expect(entries).toEqual([]);
    expect(pages).toEqual([]);
    expect(failedKinds[0]!.message).toContain('eSphinxSearchBusy');
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

  it('counts records read, not entries produced, so the next target page skips nothing', async () => {
    // Row 1 is untargeted and yields no entry; the walk still consumed it.
    fetchMock.mockResolvedValueOnce(
      sdqResponse(
        [
          { cid: 2244, acname: 'Potency', acvalue: '0.5', aidsrcname: 'NCATS' },
          { cid: 2244, targetname: 'PTGS1 (human)', acname: 'IC50', acvalue: '1', aidsrcname: 'C' },
          { cid: 2244, targetname: 'PTGS2 (human)', acname: 'IC50', acvalue: '2', aidsrcname: 'C' },
          { cid: 2244, targetname: 'ALOX5 (human)', acname: 'IC50', acvalue: '3', aidsrcname: 'C' },
        ],
        7253,
      ),
    );
    const client = new PubChemClient();
    const { entries, pages } = await client.getInteractions(2244, ['target'], 2, 0);

    expect(entries.map((e) => e.partner)).toEqual(['PTGS1 (human)', 'PTGS2 (human)']);
    // Stopped after the third row — the fourth is left for the next page.
    expect(pages[0]).toEqual({
      kind: 'target',
      returnedCount: 2,
      totalRecords: 7253,
      recordsConsumed: 3,
    });
  });

  it('collapses duplicate target measurements within a page and still counts both records', async () => {
    fetchMock.mockResolvedValueOnce(
      sdqResponse(
        [
          { cid: 2244, targetname: 'PTGS1 (human)', acname: 'IC50', acvalue: '1', aidsrcname: 'C' },
          { cid: 2244, targetname: 'PTGS1 (human)', acname: 'IC50', acvalue: '1', aidsrcname: 'C' },
        ],
        7253,
      ),
    );
    const client = new PubChemClient();
    const { entries, pages } = await client.getInteractions(2244, ['target'], 10, 0);

    expect(entries).toHaveLength(1);
    expect(pages[0]!.recordsConsumed).toBe(2);
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
