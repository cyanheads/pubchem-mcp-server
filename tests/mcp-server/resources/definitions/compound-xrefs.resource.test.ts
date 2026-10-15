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

const wireIds = (type: string) =>
  aspirinXrefs[type]!.InformationList.Information[0]![type] as (string | number)[];

/** The resource declares no `output` schema, so `handler` types as `unknown`. */
type XrefsPayload = {
  cid: number;
  xrefs: Array<{ type: string; ids: (string | number)[]; totalAvailable: number }>;
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    const type = url.pathname.match(/^\/rest\/pug\/compound\/cid\/2244\/xrefs\/(\w+)\/JSON$/)?.[1];
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov' || !type || !aspirinXrefs[type]) {
      throw new Error(`unrouted fetch: ${url}`);
    }
    return Response.json(aspirinXrefs[type]);
  });
  vi.stubGlobal('fetch', fetchMock);
  initPubChemClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compoundXrefsResource handler', () => {
  it('serves the 25 highest PubMed IDs, newest first (#69)', async () => {
    const result = (await compoundXrefsResource.handler(
      { cid: 2244 },
      createMockContext(),
    )) as XrefsPayload;
    const pubmed = result.xrefs.find((x) => x.type === 'PubMedID')!;
    const highest25 = (wireIds('PubMedID') as number[]).toSorted((a, b) => b - a).slice(0, 25);

    expect(pubmed.ids).toEqual(highest25);
    expect(pubmed.ids[0]).toBe(38840409);
    expect(pubmed.totalAvailable).toBe(wireIds('PubMedID').length);
  });

  it('keeps PubChem’s order for the string RN and RegistryID types', async () => {
    const result = (await compoundXrefsResource.handler(
      { cid: 2244 },
      createMockContext(),
    )) as XrefsPayload;

    expect(result.xrefs.map((x) => x.type)).toEqual(['RN', 'RegistryID', 'PubMedID']);
    expect(result.xrefs[0]!.ids).toEqual(wireIds('RN'));
    expect(result.xrefs[1]!.ids).toEqual(wireIds('RegistryID'));
  });
});
