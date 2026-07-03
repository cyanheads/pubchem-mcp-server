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
      jsonResponse([
        { cid: '54678486', name2: 'Lepirudin', descr: 'Risk of bleeding increased.' },
        { cid: '54678486', descr: 'Metabolism increased.' },
        { cid: '54678486', name2: 'Empty', descr: '' }, // dropped — no text
      ]),
    );
    const client = new PubChemClient();
    const { entries } = await client.getInteractions(54678486, ['drug-drug'], 10);

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
      jsonResponse([
        {
          cid: '5291',
          targetname: 'ABL1 - ABL proto-oncogene 1, non-receptor tyrosine kinase (human)',
          acname: 'Kd',
          acqualifier: '=',
          acvalue: '0.001',
          aidsrcname: 'ChEMBL',
        },
        // No acqualifier → activity rendered without it.
        {
          cid: '5291',
          targetname: 'KIT proto-oncogene (human)',
          acname: 'GI50',
          acvalue: '0.001',
          aidsrcname: 'ChEMBL',
        },
        // No targetname → dropped (untargeted assay outcome, covered by pubchem_get_bioactivity).
        { cid: '5291', acname: 'Potency', acvalue: '0.5', aidsrcname: 'NCATS' },
      ]),
    );
    const client = new PubChemClient();
    const { entries } = await client.getInteractions(5291, ['target'], 10);

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
    const { entries } = await client.getInteractions(54678486, ['drug-food'], 10);

    expect(entries).toEqual([
      { kind: 'drug-food', source: 'DrugBank', text: 'Avoid foods rich in vitamin K.' },
    ]);
  });

  it('returns [] for an empty SDQ result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const client = new PubChemClient();
    expect((await client.getInteractions(962, ['drug-drug'], 10)).entries).toEqual([]);
  });

  it('reports a malformed SDQ body as a failed kind, never an opaque parse error (#20)', async () => {
    // Unescaped quotes inside a value — the shape PubChem emits for citation-bearing rows.
    fetchMock.mockResolvedValueOnce(
      textResponse('[{"targetname":"Kinase "X" (human)","acname":"Ki","acvalue":"1"}]'),
    );
    const client = new PubChemClient();
    const { entries, failedKinds } = await client.getInteractions(5291, ['target'], 10);

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
          jsonResponse([{ cid: '5291', name2: 'Lepirudin', descr: 'Risk of bleeding increased.' }]),
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
