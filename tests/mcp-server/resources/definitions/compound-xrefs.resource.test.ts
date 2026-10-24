/**
 * @fileoverview Tests for the compound-xrefs resource. Runs the real PubChemClient against a
 * `fetch` stub serving captured aspirin (CID 2244) xref responses, so the resource's per-type
 * window is taken from the client's ordered list rather than from a mock.
 * @module mcp-server/resources/definitions/compound-xrefs.resource.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compoundXrefsResource } from '@/mcp-server/resources/definitions/compound-xrefs.resource.js';
import { initPubChemClient } from '@/services/pubchem/pubchem-client.js';

/**
 * Aspirin xref responses captured from PUG REST in PubChem's wire order — lexical for
 * PubMedID. PubMedID is sampled (every 100th ID plus the highest and lowest); RegistryID is the
 * first 25 IDs.
 */
const aspirinXrefs = JSON.parse(
  readFileSync(new URL('../../../fixtures/pug-rest-xrefs-2244.json', import.meta.url), 'utf8'),
) as Record<string, { InformationList: { Information: Array<Record<string, unknown>> } }>;

/** Aspirin's PUG View `heading=CAS` response, captured 2026-10-24. */
const aspirinCas = (
  JSON.parse(
    readFileSync(new URL('../../../fixtures/pug-view-cas-ec.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
)['CAS/2244'];

const wireIds = (type: string) =>
  aspirinXrefs[type]!.InformationList.Information[0]![type] as (string | number)[];

/** The resource declares no `output` schema, so `handler` types as `unknown`. */
type XrefsPayload = {
  cid: number;
  xrefs: Array<{
    type: string;
    ids: (string | number)[];
    sourceCounts?: number[];
    totalAvailable: number;
  }>;
  failedTypes?: string[];
};

const fetchMock = vi.fn<typeof fetch>();

/** The response the stub serves for aspirin's CAS heading; a test can swap in a failure. */
let casResponse: () => Response;

/** Per-type PUG REST responses that replace the captured ones; a test can add a failure. */
let xrefOverrides: Record<string, () => Response>;

beforeEach(() => {
  casResponse = () => Response.json(aspirinCas);
  xrefOverrides = {};
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error(`unrouted fetch: ${url}`);
    if (
      url.pathname === '/rest/pug_view/data/compound/2244/JSON' &&
      url.searchParams.get('heading') === 'CAS'
    ) {
      return casResponse();
    }
    const type = url.pathname.match(/^\/rest\/pug\/compound\/cid\/2244\/xrefs\/(\w+)\/JSON$/)?.[1];
    if (!type || !aspirinXrefs[type]) throw new Error(`unrouted fetch: ${url}`);
    return xrefOverrides[type]?.() ?? Response.json(aspirinXrefs[type]);
  });
  vi.stubGlobal('fetch', fetchMock);
  initPubChemClient();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const read = async () =>
  (await compoundXrefsResource.handler({ cid: 2244 }, createMockContext())) as XrefsPayload;

describe('compoundXrefsResource handler', () => {
  it('serves the 25 highest PubMed IDs, newest first (#69)', async () => {
    const result = await read();
    const pubmed = result.xrefs.find((x) => x.type === 'PubMedID')!;
    const highest25 = (wireIds('PubMedID') as number[]).toSorted((a, b) => b - a).slice(0, 25);

    expect(pubmed.ids).toEqual(highest25);
    expect(pubmed.ids[0]).toBe(38840409);
    expect(pubmed.totalAvailable).toBe(wireIds('PubMedID').length);
  });

  it('keeps PubChem’s order for the string RN and RegistryID types', async () => {
    const result = await read();

    expect(result.xrefs.map((x) => x.type)).toEqual(['RN', 'RegistryID', 'PubMedID', 'CAS']);
    expect(result.xrefs[0]!.ids).toEqual(wireIds('RN'));
    expect(result.xrefs[1]!.ids).toEqual(wireIds('RegistryID'));
  });

  it('includes the attested CAS number with its source count in the default set (#77)', async () => {
    const result = await read();

    expect(result.xrefs.find((x) => x.type === 'CAS')).toEqual({
      type: 'CAS',
      ids: ['50-78-2'],
      sourceCounts: [19],
      totalAvailable: 1,
    });
    expect(result.xrefs.find((x) => x.type === 'RN')).not.toHaveProperty('sourceCounts');
    expect(result).not.toHaveProperty('failedTypes');
  });

  it('serves the other types and names CAS when its heading read fails', async () => {
    casResponse = () =>
      Response.json(
        {
          Fault: {
            Code: 'PUGVIEW.BadRequest',
            Message: 'Heading is either not found or ambiguous',
          },
        },
        { status: 400 },
      );

    const result = await read();

    expect(result.xrefs.map((x) => x.type)).toEqual(['RN', 'RegistryID', 'PubMedID']);
    expect(result.failedTypes).toEqual(['CAS']);
  });

  it('stops at a 503, naming the unrequested types as failed', async () => {
    vi.useFakeTimers();
    xrefOverrides.RegistryID = () =>
      new Response('', { status: 503, statusText: 'Service Unavailable' });

    const pending = read();
    await vi.runAllTimersAsync();
    const result = await pending;

    // RN once, RegistryID twice (the 503 and its one retry), then nothing.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.xrefs.map((x) => x.type)).toEqual(['RN']);
    expect(result.failedTypes).toEqual(['RegistryID', 'PubMedID', 'CAS']);
  });

  it('describes the CAS counts as source records', () => {
    const description = compoundXrefsResource.description ?? '';

    expect(description).toContain('source records');
    expect(description).not.toMatch(/\bsources\b/);
  });

  it('describes RN as unranked registry numbers rather than the CAS number', () => {
    const description = compoundXrefsResource.description ?? '';

    expect(description).not.toContain('(CAS RN,');
    expect(description).toMatch(/RN \(every registry number[^)]*unranked/);
  });
});
