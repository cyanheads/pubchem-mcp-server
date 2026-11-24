/**
 * @fileoverview Wire-level contract tests for pubchem_search_compounds mode-specific
 * arguments (#45): the advertised input schema, blank-field guards, and cross-mode
 * field tolerance. Runs the real handler and the real PubChemClient against a stubbed
 * `fetch`, so a guard that fails to fire shows up as an upstream request.
 * @module tests/mcp-server/tools/definitions/search-compounds-contract.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCompounds } from '@/mcp-server/tools/definitions/search-compounds.tool.js';
import { initPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { readBlockquotes } from '../../../helpers/commonmark.js';
import { fingerprintsByCid, readJsonFixture } from '../../../helpers/fixtures.js';

const fetchMock = vi.fn<typeof fetch>();

type SearchInput = z.input<typeof searchCompounds.input>;

/** PubChem's `Fingerprint2D` for each of the 201 hits of a CID 2244 (aspirin) similarity search
 * at threshold 75, as PUG REST served them (#97). */
const ASPIRIN_T75_FINGERPRINTS = fingerprintsByCid('fingerprint2d-2244-t75.json');
const ASPIRIN_FINGERPRINT = ASPIRIN_T75_FINGERPRINTS.get(2244)!;

/** The CIDs and property names of a PUG REST property request — GET with the CIDs in the path,
 * or POST with them in the body — or undefined for any other request. */
function propertyRequest(
  url: URL,
  init: RequestInit | undefined,
): { method: 'GET' | 'POST'; cids: number[]; names: string[] } | undefined {
  const get = /^\/rest\/pug\/compound\/cid\/([\d,]+)\/property\/([\w,]+)\/JSON$/.exec(url.pathname);
  if (get) {
    return { method: 'GET', cids: get[1]!.split(',').map(Number), names: get[2]!.split(',') };
  }
  const post = /^\/rest\/pug\/compound\/cid\/property\/([\w,]+)\/JSON$/.exec(url.pathname);
  if (!post) return;
  const cids = new URLSearchParams(String(init?.body)).get('cid') ?? '';
  return { method: 'POST', cids: cids.split(',').map(Number), names: post[1]!.split(',') };
}

function cidList(cids: number[]): Response {
  return new Response(JSON.stringify({ IdentifierList: { CID: cids } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fault = (status: number, code: string, message: string) =>
  Response.json({ Fault: { Code: code, Message: message } }, { status });

/** Advertised input schema, produced the way `tools/list` produces it: the framework hands
 * the SDK `input['~standard'].jsonSchema`, and the SDK calls `.input()` at draft-2020-12. */
function advertisedInputSchema(): Record<string, unknown> {
  return searchCompounds.input['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
}

type ErrorEnvelope = { code: number; message: string; data?: { reason?: string } };

function errorOf(result: Awaited<ReturnType<typeof runToolContract>>): ErrorEnvelope {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
  vi.stubGlobal('fetch', fetchMock);
  initPubChemClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pubchem_search_compounds advertised input schema (#45)', () => {
  it('keeps a flat object root with no top-level combinator and only searchType required', () => {
    const schema = advertisedInputSchema();

    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('allOf');
    expect(schema.required).toEqual(['searchType']);
  });

  it("names each mode's required fields in the searchType description", () => {
    const properties = advertisedInputSchema().properties as Record<
      string,
      { description?: string }
    >;
    const description = properties.searchType?.description ?? '';

    expect(description).toMatch(/"identifier"[^.]*requires identifierType and identifiers/);
    expect(description).toMatch(/"formula"[^.]*requires formula/);
    for (const mode of ['substructure', 'superstructure', 'similarity']) {
      expect(description).toContain(`"${mode}"`);
    }
    expect(description).toMatch(
      /substructure, superstructure, and similarity require query and queryType/,
    );
  });
});

describe('pubchem_search_compounds blank mode fields (#45)', () => {
  it('rejects a whitespace-only formula as missing_formula before any PubChem request', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: '   ',
    });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('missing_formula');
    expect(textOf(result)).toContain('Hill notation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['smiles', 'cid'] as const)(
    'rejects a whitespace-only query with queryType "%s" as missing_structure_args before any PubChem request',
    async (queryType) => {
      const result = await runToolContract(searchCompounds, {
        searchType: 'substructure',
        query: '  ',
        queryType,
      });

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('missing_structure_args');
      expect(textOf(result)).toContain('queryType');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a whitespace-only similarity query the same way', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'similarity',
      query: '\t \n',
      queryType: 'smiles',
    });

    expect(errorOf(result).data?.reason).toBe('missing_structure_args');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pubchem_search_compounds omitted mode fields keep their reasons (#45)', () => {
  it.each<[z.input<typeof searchCompounds.input>, string]>([
    [{ searchType: 'identifier' }, 'missing_identifier_args'],
    [{ searchType: 'identifier', identifierType: 'name' }, 'missing_identifier_args'],
    [{ searchType: 'identifier', identifiers: ['aspirin'] }, 'missing_identifier_args'],
    [{ searchType: 'formula' }, 'missing_formula'],
    [{ searchType: 'formula', formula: '' }, 'missing_formula'],
    [{ searchType: 'substructure' }, 'missing_structure_args'],
    [{ searchType: 'superstructure', query: 'CCO' }, 'missing_structure_args'],
    [{ searchType: 'similarity', queryType: 'cid' }, 'missing_structure_args'],
    [{ searchType: 'similarity', query: '', queryType: 'smiles' }, 'missing_structure_args'],
  ])('%j → %s', async (input, reason) => {
    const result = await runToolContract(searchCompounds, input);

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pubchem_search_compounds identifier mode reads query as identifiers[0] (#90)', () => {
  const readNotice = (query: string) =>
    `Read query "${query}" as identifiers[0]; identifier mode takes its lookups in identifiers.`;
  const notFound = () =>
    Response.json(
      { Fault: { Code: 'PUGREST.NotFound', Message: 'No CID found' } },
      { status: 404 },
    );
  const requested = () => fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
  type Content = {
    results: Array<{ cid: number; identifier?: string }>;
    unresolvedIdentifiers?: string[];
    notice?: string;
  };
  type Failure = { data?: { reason?: string; recovery?: { hint?: string } } };
  const hintOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (errorOf(result) as Failure).data?.recovery?.hint;

  it('looks up a query sent with identifierType and no identifiers, and says so in the notice', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2519]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      query: 'caffeine',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2519, identifier: 'caffeine' }],
      totalFound: 1,
      notice: readNotice('caffeine'),
    });
    expect(requested()).toEqual(['/rest/pug/compound/name/caffeine/cids/JSON']);
    expect(readBlockquotes(textOf(result)).at(-1)).toBe(readNotice('caffeine'));
  });

  it('fails a query sent with no identifierType as missing_identifier_args, its hint naming the query', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      query: 'caffeine',
    });

    expect(errorOf(result).data?.reason).toBe('missing_identifier_args');
    expect(hintOf(result)).toBe(
      'Set identifierType (name/smiles/inchi/inchikey) to the form of "caffeine", the identifier read from query.',
    );
    expect(textOf(result)).toContain('"caffeine", the identifier read from query');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cuts a long query to 100 characters in the missing_identifier_args hint', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      query: `${'n'.repeat(150)} **x**`,
    });

    expect(errorOf(result).data?.reason).toBe('missing_identifier_args');
    expect(hintOf(result)).toBe(
      `Set identifierType (name/smiles/inchi/inchikey) to the form of "${'n'.repeat(100)}…", the identifier read from query.`,
    );
  });

  it('uppercases a lowercase InChIKey query before lookup, as it does identifiers', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2519]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'inchikey',
      query: 'ryyvlzvuvijvgh-uhfffaoysa-n',
    });

    expect(requested()).toEqual([
      '/rest/pug/compound/inchikey/RYYVLZVUVIJVGH-UHFFFAOYSA-N/cids/JSON',
    ]);
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2519, identifier: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N' }],
      notice: readNotice('ryyvlzvuvijvgh-uhfffaoysa-n'),
    });
  });

  it('reads a query holding commas as one identifier, never split', async () => {
    fetchMock.mockResolvedValueOnce(cidList([1493]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      query: '2,4-dinitrophenol',
    });

    expect(requested()).toEqual(['/rest/pug/compound/name/2%2C4-dinitrophenol/cids/JSON']);
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 1493, identifier: '2,4-dinitrophenol' }],
    });
  });

  it.each(['', '   ', '\t\n'])(
    'fails a blank query %j as missing_identifier_args before any request, with the declared hint',
    async (query) => {
      const result = await runToolContract(searchCompounds, {
        searchType: 'identifier',
        identifierType: 'name',
        query,
      });

      expect(errorOf(result).data?.reason).toBe('missing_identifier_args');
      expect(hintOf(result)).toBe(
        searchCompounds.errors?.find((e) => e.reason === 'missing_identifier_args')?.recovery,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps identifiers over query when both are sent, with no notice', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2244]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin'],
      query: 'caffeine',
    });

    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: 'aspirin' }],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(requested()).toEqual(['/rest/pug/compound/name/aspirin/cids/JSON']);
  });

  it('joins the read notice with the not-found notice in one notice', async () => {
    fetchMock.mockResolvedValueOnce(notFound());

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      query: 'notreal1zzz',
    });

    const notice = `${readNotice('notreal1zzz')} 1 of 1 identifier(s) did not resolve to a CID: notreal1zzz. Verify spelling and that identifierType="name" matches the identifier form (name/smiles/inchi/inchikey).`;
    expect(result.structuredContent as Content).toMatchObject({
      results: [],
      unresolvedIdentifiers: ['notreal1zzz'],
      notice,
    });
    expect(readBlockquotes(textOf(result)).at(-1)).toBe(notice);
  });

  it('joins the read notice with the next-page guidance in one notice', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2519, 1, 2]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      query: 'caffeine',
      maxResults: 1,
    });

    const notice = `${readNotice('caffeine')} Showing matches 1-1 of 3. Pass offset=1 for the next page.`;
    expect(result.structuredContent).toMatchObject({ nextOffset: 1, truncated: true, notice });
    expect(readBlockquotes(textOf(result)).at(-1)).toBe(notice);
  });

  it('cuts a long query to 100 characters in the notice and keeps it whole in the echo', async () => {
    const query = `${'n'.repeat(150)} **x**`;
    fetchMock.mockResolvedValueOnce(cidList([2519]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      query,
    });

    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2519, identifier: query }],
      notice: readNotice(`${'n'.repeat(100)}…`),
    });
  });
});

describe('pubchem_search_compounds properties read PubChem’s current SMILES names (#92)', () => {
  const ISOMERIC = 'C[C@@H](C(=O)O)N';
  const CONNECTIVITY = 'CC(C(=O)O)N';

  /** Answers the L-alanine name lookup with CID 5950, and a property request the way PubChem
   * does: a SMILES asked for under either name comes back as "SMILES" or "ConnectivitySMILES". */
  const pubchem = async (input: string | URL | Request): Promise<Response> => {
    const { pathname } = new URL(String(input));
    if (pathname === '/rest/pug/compound/name/L-alanine/cids/JSON') return cidList([5950]);
    const names = /^\/rest\/pug\/compound\/cid\/5950\/property\/([^/]+)\/JSON$/.exec(pathname)?.[1];
    if (names === undefined) throw new Error(`unmocked fetch: ${pathname}`);
    const row: Record<string, unknown> = { CID: 5950 };
    for (const name of names.split(',')) {
      if (name === 'SMILES' || name === 'IsomericSMILES') row.SMILES = ISOMERIC;
      else if (name === 'ConnectivitySMILES' || name === 'CanonicalSMILES') {
        row.ConnectivitySMILES = CONNECTIVITY;
      } else if (name === 'MolecularWeight') row.MolecularWeight = '89.09';
      else throw new Error(`unmocked property: ${name}`);
    }
    return Response.json({ PropertyTable: { Properties: [row] } });
  };
  const propertyRequests = () =>
    fetchMock.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((path) => path.includes('/property/'));
  /** A lone string is sent as written, for the framework's argument repair to wrap. */
  const withProperties = (properties: unknown) =>
    runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['L-alanine'],
      properties: properties as string[],
    });
  const propertiesOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    expect(result.isError).toBeFalsy();
    return (result.structuredContent as { results: Array<{ properties?: unknown }> }).results[0]
      ?.properties;
  };

  it.each<[unknown, string, Record<string, unknown>]>([
    [['SMILES'], 'IsomericSMILES', { IsomericSMILES: ISOMERIC }],
    [['ConnectivitySMILES'], 'CanonicalSMILES', { CanonicalSMILES: CONNECTIVITY }],
    ['SMILES', 'IsomericSMILES', { IsomericSMILES: ISOMERIC }],
    [['SMILES', 'IsomericSMILES'], 'IsomericSMILES', { IsomericSMILES: ISOMERIC }],
    [
      ['SMILES', 'MolecularWeight', 'IsomericSMILES'],
      'IsomericSMILES,MolecularWeight',
      { IsomericSMILES: ISOMERIC, MolecularWeight: '89.09' },
    ],
  ])(
    'reads %j as a request for %s, keyed by this server’s names',
    async (properties, requestedNames, expected) => {
      fetchMock.mockImplementation(pubchem);

      const result = await withProperties(properties);

      expect(propertiesOf(result)).toEqual(expected);
      expect(propertyRequests()).toEqual([
        `/rest/pug/compound/cid/5950/property/${requestedNames}/JSON`,
      ]);
    },
  );

  it.each<[unknown, string, Record<string, unknown>]>([
    [['IsomericSMILES'], 'IsomericSMILES', { IsomericSMILES: ISOMERIC }],
    [['CanonicalSMILES'], 'CanonicalSMILES', { CanonicalSMILES: CONNECTIVITY }],
    [
      ['IsomericSMILES', 'CanonicalSMILES'],
      'IsomericSMILES,CanonicalSMILES',
      { IsomericSMILES: ISOMERIC, CanonicalSMILES: CONNECTIVITY },
    ],
    ['MolecularWeight', 'MolecularWeight', { MolecularWeight: '89.09' }],
  ])('returns %j as before', async (properties, requestedNames, expected) => {
    fetchMock.mockImplementation(pubchem);

    const result = await withProperties(properties);

    expect(propertiesOf(result)).toEqual(expected);
    expect(propertyRequests()).toEqual([
      `/rest/pug/compound/cid/5950/property/${requestedNames}/JSON`,
    ]);
  });

  it.each([[['smiles']], [['Foo']], ['connectivitysmiles']])(
    'still rejects %j at the schema',
    async (properties) => {
      const result = await withProperties(properties);

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('states the name pairing in the output properties description', () => {
    expect(searchCompounds.output.shape.results.element.shape.properties.description).toContain(
      'SMILES as IsomericSMILES, ConnectivitySMILES as CanonicalSMILES',
    );
  });
});

describe('pubchem_search_compounds cross-mode fields and padding (#45 regression)', () => {
  it("accepts an identifier search carrying other modes' empty fields", async () => {
    fetchMock.mockResolvedValueOnce(cidList([2244]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin'],
      formula: '',
      query: '',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: 'aspirin' }],
    });
    expect(textOf(result)).toContain('2244 (`aspirin`)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/compound/name/aspirin/cids/JSON');
  });

  it('accepts a formula search carrying identifier-mode fields', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2244, 5161]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'C9H8O4',
      identifierType: 'name',
      identifiers: ['aspirin'],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244 }, { cid: 5161 }],
      totalFound: 2,
    });
    expect(textOf(result)).toContain('CIDs: 2244, 5161');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/compound/fastformula/C9H8O4/');
  });

  it('still searches a padded formula rather than treating it as blank', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2244]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: ' C9H8O4 ',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ results: [{ cid: 2244 }] });
    expect(textOf(result)).toContain('CIDs: 2244');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still searches a padded SMILES structure query', async () => {
    fetchMock.mockResolvedValueOnce(cidList([702]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'substructure',
      query: ' CCO ',
      queryType: 'smiles',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ results: [{ cid: 702 }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('pubchem_search_compounds rejected search query (#52)', () => {
  const rejected = () =>
    Response.json(
      { Fault: { Code: 'PUGREST.ServerError', Message: 'Search status indicates failure' } },
      { status: 500 },
    );

  type RejectedEnvelope = {
    code: number;
    data?: { reason?: string; fault?: string; recovery?: { hint?: string } };
  };

  function rejectionOf(result: Awaited<ReturnType<typeof runToolContract>>): RejectedEnvelope {
    return errorOf(result) as RejectedEnvelope;
  }

  it('declares search_query_rejected as a service-thrown ValidationError', () => {
    expect(searchCompounds.errors).toContainEqual(
      expect.objectContaining({
        reason: 'search_query_rejected',
        code: JsonRpcErrorCode.ValidationError,
        thrownBy: 'service',
      }),
    );
  });

  it('scopes the HTTP 400 in its when to every formula and structure search (#87)', () => {
    const when = searchCompounds.errors?.find((e) => e.reason === 'search_query_rejected')?.when;

    expect(when).toMatch(/refused any of these searches with HTTP 400/);
  });

  it.each([
    ['substructure', 'smiles', 'C1CC'],
    ['similarity', 'cid', '2244'],
  ] as const)(
    'fails a %s search answered with HTTP 400 as search_query_rejected (#87)',
    async (searchType, queryType, query) => {
      fetchMock.mockImplementation(async () => new Response('Bad Request', { status: 400 }));

      const result = await runToolContract(searchCompounds, { searchType, queryType, query });

      expect(rejectionOf(result).data?.reason).toBe('search_query_rejected');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a malformed SMILES substructure query as search_query_rejected after one request', async () => {
    fetchMock.mockImplementation(async () => rejected());

    const result = await runToolContract(searchCompounds, {
      searchType: 'substructure',
      query: 'not-a-smiles',
      queryType: 'smiles',
    });

    const error = rejectionOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('search_query_rejected');
    expect(error.data?.fault).toBe('PUGREST.ServerError: Search status indicates failure');
    expect(error.data?.recovery?.hint).toMatch(/SMILES syntax/);
    const text = textOf(result);
    expect(text).toMatch(/Recovery: .*SMILES syntax/);
    expect(text).toContain('search_query_rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the CID for a CID similarity query with no record', async () => {
    fetchMock.mockImplementation(async () => rejected());

    const result = await runToolContract(searchCompounds, {
      searchType: 'similarity',
      query: '999999999',
      queryType: 'cid',
    });

    const error = rejectionOf(result);
    expect(error.data?.reason).toBe('search_query_rejected');
    expect(error.data?.recovery?.hint).toContain('CID 999999999');
    expect(textOf(result)).toContain('pubchem_get_compound_details');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('points a malformed formula at Hill notation', async () => {
    fetchMock.mockImplementation(async () => rejected());

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'not-a-formula',
    });

    const error = rejectionOf(result);
    expect(error.data?.reason).toBe('search_query_rejected');
    expect(textOf(result)).toContain('Hill notation');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails a formula carrying a line break, answered with an HTML 400, as search_query_rejected (#87)', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response('<!DOCTYPE html><title>400 Bad Request</title>', {
          status: 400,
          headers: { 'Content-Type': 'text/html' },
        }),
    );

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'C6H\n12O6',
    });

    const error = rejectionOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('search_query_rejected');
    expect(error.data?.recovery?.hint).toMatch(/Hill notation.*no line breaks/);
    expect(error.data).not.toHaveProperty('fault');
    expect(textOf(result)).toMatch(/Recovery: .*Hill notation/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a formula carrying a NUL, answered with an HTML 404, an empty-match success (#87)', async () => {
    fetchMock.mockImplementation(async () => new Response('404: Not Found', { status: 404 }));

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'C6H\u000012O6',
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { results: unknown[] }).results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns CIDs for C6H12O6', async () => {
    fetchMock.mockImplementation(async () => cidList([5793, 107526]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'C6H12O6',
    });

    expect(result.isError).toBeFalsy();
    const { results } = result.structuredContent as { results: Array<{ cid: number }> };
    expect(results.map((r) => r.cid)).toEqual([5793, 107526]);
  });
});

describe('pubchem_search_compounds assay mode (#68)', () => {
  /** CID lists sized to AID 1000's live counts (57 tested, 36 active; CIDCountAll /
   * CIDCountActive), in the ascending order PubChem keeps them. */
  const AID_1000_ALL = Array.from({ length: 57 }, (_, i) => 16749963 + i);
  const AID_1000_ACTIVE = AID_1000_ALL.filter((_, i) => i % 8 !== 3 && i % 8 !== 6).slice(0, 36);
  const LISTS: Record<string, number[]> = {
    '1000-active': AID_1000_ACTIVE,
    '1000-all': AID_1000_ALL,
    // A list naming one CID twice, which the tool dedups within a page.
    '2000-all': [501, 501, 502, 503, 504],
  };

  /** Answers the two assay-listing requests the way PubChem does: the listkey request returns
   * the key and exact Size (envelope as captured live for AID 1000), the page request serves
   * `listkey_count` CIDs from `listkey_start`, and a start at or past the end is HTTP 500. */
  const pubchemAssayLists: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error('unmocked fetch');
    const listMatch = /^\/rest\/pug\/assay\/aid\/(\d+)\/cids\/JSON$/.exec(url.pathname);
    if (listMatch && url.searchParams.get('list_return') === 'listkey') {
      const aid = listMatch[1];
      if (aid === '99999999') {
        return fault(404, 'PUGREST.NotFound', 'No live AIDs in the supplied AID list');
      }
      const key = `${aid}-${url.searchParams.get('cids_type')}`;
      const list = LISTS[key];
      if (!list) return fault(404, 'PUGREST.NotFound', 'No CIDs found for the given AID(s)');
      return Response.json({
        IdentifierList: {
          ListKey: key,
          Size: list.length,
          EntrezDB: 'pccompound',
          EntrezWebEnv: 'MCID_6ad01b42e62f0ac05509fef1',
          EntrezQueryKey: 1,
        },
      });
    }
    const pageMatch = /^\/rest\/pug\/compound\/listkey\/([^/]+)\/cids\/JSON$/.exec(url.pathname);
    if (pageMatch) {
      const list = LISTS[pageMatch[1] ?? ''] ?? [];
      const start = Number(url.searchParams.get('listkey_start'));
      const count = Number(url.searchParams.get('listkey_count'));
      if (start >= list.length) return fault(500, 'PUGREST.ServerError', 'Invalid listkey start');
      return cidList(list.slice(start, start + count));
    }
    const propsMatch = /^\/rest\/pug\/compound\/cid\/([\d,]+)\/property\/Title\/JSON$/.exec(
      url.pathname,
    );
    if (propsMatch) {
      const cids = (propsMatch[1] ?? '').split(',').map(Number);
      return Response.json({
        PropertyTable: { Properties: cids.map((CID) => ({ CID, Title: `Compound ${CID}` })) },
      });
    }
    throw new Error('unmocked fetch');
  };

  /** Request kinds the stub received, in order. */
  const requestKinds = () =>
    fetchMock.mock.calls.map(([input]) => {
      const { pathname, searchParams } = new URL(String(input));
      if (pathname.includes('/compound/listkey/')) {
        return `page ${searchParams.get('listkey_start')}+${searchParams.get('listkey_count')}`;
      }
      if (pathname.includes('/assay/aid/')) return `listkey ${searchParams.get('cids_type')}`;
      return 'properties';
    });

  type AssayContent = {
    results: Array<{ cid: number; properties?: Record<string, unknown> }>;
    totalFound?: number;
    totalFoundAtLeast?: number;
    nextOffset?: number;
    activeOnly?: boolean;
    notice?: string;
  };
  const contentOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    expect(result.isError).toBeFalsy();
    return result.structuredContent as AssayContent;
  };

  it('lists an assay’s active compounds by default, with the exact active count as totalFound', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, { searchType: 'assay', aid: 1000 });

    const content = contentOf(result);
    expect(content.results.map((r) => r.cid)).toEqual(AID_1000_ACTIVE.slice(0, 20));
    expect(content.totalFound).toBe(36);
    expect(content).not.toHaveProperty('totalFoundAtLeast');
    expect(content.nextOffset).toBe(20);
    expect(content.activeOnly).toBe(true);
    expect(requestKinds()).toEqual(['listkey active', 'page 0+20']);
    const text = textOf(result);
    expect(text).toContain(`CIDs: ${AID_1000_ACTIVE.slice(0, 20).join(', ')}`);
    expect(text).toMatch(/activeOnly.*true/);
    expect(text).toContain('Showing matches 1-20 of 36');
  });

  it('advances nextOffset by the list page it read, not the deduped page it returned', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const walked: number[] = [];
    const starts: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      starts.push(offset);
      const result = await runToolContract(searchCompounds, {
        searchType: 'assay',
        aid: 2000,
        activeOnly: false,
        maxResults: 2,
        offset,
      });
      const content = contentOf(result);
      walked.push(...content.results.map((r) => r.cid));
      offset = content.nextOffset;
    }

    expect(starts).toEqual([0, 2, 4]);
    expect(walked).toEqual([501, 502, 503, 504]);
  });

  it('activeOnly: false lists every tested compound, totalFound = 57', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, {
      searchType: 'assay',
      aid: 1000,
      activeOnly: false,
      maxResults: 5,
    });

    const content = contentOf(result);
    expect(content.totalFound).toBe(57);
    expect(content.results.map((r) => r.cid)).toEqual(AID_1000_ALL.slice(0, 5));
    expect(content.activeOnly).toBe(false);
    expect(requestKinds()).toEqual(['listkey all', 'page 0+5']);
  });

  it('walking every page yields each CID once, in the full list’s order, and stops at the end', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const walked: number[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const result = await runToolContract(searchCompounds, {
        searchType: 'assay',
        aid: 1000,
        activeOnly: false,
        maxResults: 20,
        offset,
      });
      const content = contentOf(result);
      expect(content.totalFound).toBe(57);
      walked.push(...content.results.map((r) => r.cid));
      offset = content.nextOffset;
      pages++;
    }

    expect(pages).toBe(3);
    expect(walked).toEqual(AID_1000_ALL);
    expect(requestKinds().filter((k) => k.startsWith('page'))).toEqual([
      'page 0+20',
      'page 20+20',
      'page 40+20',
    ]);
  });

  it.each([36, 37, 10000])(
    'offset %i at or past the 36 actives returns an empty page and the past-the-end notice without a page request',
    async (offset) => {
      fetchMock.mockImplementation(pubchemAssayLists);

      const result = await runToolContract(searchCompounds, {
        searchType: 'assay',
        aid: 1000,
        offset,
      });

      const content = contentOf(result);
      expect(content.results).toEqual([]);
      expect(content.totalFound).toBe(36);
      expect(content).not.toHaveProperty('nextOffset');
      expect(content.notice).toBe(
        `offset ${offset} is past the 36 match(es) found. Pass an offset below 36.`,
      );
      expect(requestKinds()).toEqual(['listkey active']);
      expect(textOf(result)).toContain(content.notice!);
    },
  );

  it('serves the last partial page at offset 35 with no nextOffset', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, {
      searchType: 'assay',
      aid: 1000,
      offset: 35,
    });

    const content = contentOf(result);
    expect(content.results.map((r) => r.cid)).toEqual([AID_1000_ACTIVE[35]]);
    expect(content).not.toHaveProperty('nextOffset');
    expect(requestKinds()).toEqual(['listkey active', 'page 35+20']);
  });

  it('an assay with no active compounds is an empty result with a notice suggesting activeOnly: false', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, { searchType: 'assay', aid: 3365 });

    const content = contentOf(result);
    expect(content.results).toEqual([]);
    expect(content.totalFound).toBe(0);
    expect(content.notice).toBe(
      'AID 3365 has no compounds marked active. Pass activeOnly: false to list every compound it tested.',
    );
    expect(requestKinds()).toEqual(['listkey active']);
    const text = textOf(result);
    expect(text).toContain('No results.');
    expect(text).toContain('activeOnly: false');
  });

  it('an assay with no tested compounds at all says so without suggesting activeOnly', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, {
      searchType: 'assay',
      aid: 435008,
      activeOnly: false,
    });

    const content = contentOf(result);
    expect(content.totalFound).toBe(0);
    expect(content.notice).toBe('AID 435008 has no tested compounds recorded in PubChem.');
  });

  it('a nonexistent AID fails as aid_not_found after the one listkey request', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, { searchType: 'assay', aid: 99999999 });

    const error = errorOf(result) as ErrorEnvelope & { data?: { recovery?: { hint?: string } } };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('aid_not_found');
    expect(error.data?.recovery?.hint).toContain('pubchem_search_assays');
    expect(textOf(result)).toContain('AID 99999999');
    expect(requestKinds()).toEqual(['listkey active']);
  });

  it('rejects an assay search without aid as missing_aid before any PubChem request', async () => {
    const result = await runToolContract(searchCompounds, { searchType: 'assay' });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('missing_aid');
    expect(textOf(result)).toContain('pubchem_search_assays');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 2.5])('rejects aid %d at the schema', async (aid) => {
    const result = await runToolContract(searchCompounds, { searchType: 'assay', aid });

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hydrates the page with requested properties', async () => {
    fetchMock.mockImplementation(pubchemAssayLists);

    const result = await runToolContract(searchCompounds, {
      searchType: 'assay',
      aid: 1000,
      maxResults: 2,
      properties: ['Title'],
    });

    const content = contentOf(result);
    expect(content.results).toEqual([
      { cid: AID_1000_ACTIVE[0], properties: { Title: `Compound ${AID_1000_ACTIVE[0]}` } },
      { cid: AID_1000_ACTIVE[1], properties: { Title: `Compound ${AID_1000_ACTIVE[1]}` } },
    ]);
    expect(requestKinds()).toEqual(['listkey active', 'page 0+2', 'properties']);
    expect(textOf(result)).toContain(`Title: \`Compound ${AID_1000_ACTIVE[0]}\``);
  });

  it('does not echo activeOnly on other modes', async () => {
    fetchMock.mockResolvedValueOnce(cidList([2244]));

    const result = await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'C9H8O4',
    });

    expect(result.structuredContent).not.toHaveProperty('activeOnly');
  });

  it('names aid as the assay mode’s field in the searchType description', () => {
    const properties = advertisedInputSchema().properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.searchType?.description).toMatch(/"assay"[^.]*requires aid/);
    expect(properties.aid).toMatchObject({ type: 'integer', minimum: 1 });
    expect(advertisedInputSchema().required).toEqual(['searchType']);
  });
});

describe('pubchem_search_compounds offset ceiling (#76)', () => {
  /** AID 2551's tested-CID count; the list behind its ListKey is synthetic, position i → CID. */
  const AID_2551_SIZE = 305439;
  const assayCid = (position: number) => 5_000_000 + position;
  const range = (start: number, end: number) =>
    Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);

  /** PubChem stand-in for every mode the ceiling touches. A bounded fast search saturates —
   * it answers MaxRecords CIDs 1..MaxRecords, as a common substructure does — so the window
   * always proves more matches past it. AID 2551's ListKey serves `listkey_count` positions
   * from `listkey_start` and answers a start past its end with HTTP 500. "aspirin" is CID 2244.
   * A similarity page's fingerprint requests get aspirin's fingerprint for every CID. */
  const pubchem: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error('unmocked fetch');
    const { pathname, searchParams } = url;
    if (/^\/rest\/pug\/compound\/fast[a-z_0-9]+\//.test(pathname)) {
      return cidList(range(1, Number(searchParams.get('MaxRecords')) + 1));
    }
    const fingerprints = propertyRequest(url, init);
    if (fingerprints) {
      return Response.json({
        PropertyTable: {
          Properties: fingerprints.cids.map((CID) => ({ CID, Fingerprint2D: ASPIRIN_FINGERPRINT })),
        },
      });
    }
    if (pathname === '/rest/pug/compound/smiles/property/Fingerprint2D/JSON') {
      return Response.json({
        PropertyTable: { Properties: [{ CID: 2244, Fingerprint2D: ASPIRIN_FINGERPRINT }] },
      });
    }
    if (pathname === '/rest/pug/assay/aid/2551/cids/JSON') {
      return Response.json({ IdentifierList: { ListKey: 'aid2551', Size: AID_2551_SIZE } });
    }
    if (pathname === '/rest/pug/compound/listkey/aid2551/cids/JSON') {
      const start = Number(searchParams.get('listkey_start'));
      const count = Number(searchParams.get('listkey_count'));
      if (start >= AID_2551_SIZE) {
        return Response.json(
          { Fault: { Code: 'PUGREST.ServerError', Message: 'Invalid listkey start' } },
          { status: 500 },
        );
      }
      return cidList(range(start, Math.min(start + count, AID_2551_SIZE)).map(assayCid));
    }
    if (pathname === '/rest/pug/compound/name/aspirin/cids/JSON') return cidList([2244]);
    throw new Error('unmocked fetch');
  };

  /** What each upstream request asked for: a bounded search's record window, or a ListKey page. */
  const requested = () =>
    fetchMock.mock.calls.map(([input]) => {
      const { pathname, searchParams } = new URL(String(input));
      if (searchParams.has('MaxRecords')) return `window ${searchParams.get('MaxRecords')}`;
      if (searchParams.has('listkey_start')) {
        return `page ${searchParams.get('listkey_start')}+${searchParams.get('listkey_count')}`;
      }
      if (searchParams.get('list_return') === 'listkey') return 'listkey';
      return pathname;
    });

  type PageContent = {
    results: Array<{ cid: number }>;
    totalFound?: number;
    totalFoundAtLeast?: number;
    offset: number;
    nextOffset?: number;
    truncated?: boolean;
    notice?: string;
  };
  const pageOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    expect(result.isError).toBeFalsy();
    return result.structuredContent as PageContent;
  };

  type CeilingEnvelope = {
    code: number;
    data?: { reason?: string; recovery?: { hint?: string } };
  };

  const quinoline = {
    searchType: 'substructure',
    query: 'c1ccc2ncccc2c1',
    queryType: 'smiles',
  } satisfies SearchInput;

  beforeEach(() => {
    fetchMock.mockImplementation(pubchem);
  });

  it('keeps nextOffset on a bounded page whose next offset is exactly the ceiling', async () => {
    const result = await runToolContract(searchCompounds, {
      ...quinoline,
      maxResults: 10,
      offset: 9990,
    });

    const page = pageOf(result);
    expect(page.results.map((r) => r.cid)).toEqual(range(9991, 10001));
    expect(page.totalFoundAtLeast).toBe(10001);
    expect(page.nextOffset).toBe(10000);
    expect(page.truncated).toBe(true);
    expect(page.notice).toContain('Pass offset=10000 for the next page.');
    expect(requested()).toEqual(['window 10001']);
  });

  it('omits nextOffset on a bounded page that would continue past the ceiling, and names the page at the ceiling and how to narrow', async () => {
    const result = await runToolContract(searchCompounds, {
      ...quinoline,
      maxResults: 3,
      offset: 9998,
    });

    const page = pageOf(result);
    expect(page.results.map((r) => r.cid)).toEqual([9999, 10000, 10001]);
    expect(page.totalFoundAtLeast).toBe(10002);
    expect(page).not.toHaveProperty('totalFound');
    expect(page).not.toHaveProperty('nextOffset');
    expect(page.truncated).toBe(true);
    const notice =
      'Showing matches 9999-10001; more exist, but PubChem reports no match count for a substructure search. A substructure search pages only to offset 10000, so pass offset=10000 with maxResults=200 to reach matches through 10200; past 10200, narrow it to fewer matches: use a larger, more specific query structure.';
    expect(page.notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain('CIDs: 9999, 10000, 10001');
    expect(text).toContain(notice);
    expect(text).not.toMatch(/nextOffset/i);
    expect(requested()).toEqual(['window 10002']);
  });

  it('names the page at the ceiling when this page stops one match short of what it reaches', async () => {
    const result = await runToolContract(searchCompounds, {
      ...quinoline,
      maxResults: 200,
      offset: 9999,
    });

    const page = pageOf(result);
    expect(page.results.map((r) => r.cid)).toEqual(range(10000, 10200));
    expect(page).not.toHaveProperty('nextOffset');
    expect(page.truncated).toBe(true);
    const nextStep =
      'A substructure search pages only to offset 10000, so pass offset=10000 with maxResults=200 to reach matches through 10200; past 10200, narrow it to fewer matches: use a larger, more specific query structure.';
    expect(page.notice).toBe(
      `Showing matches 10000-10199; more exist, but PubChem reports no match count for a substructure search. ${nextStep}`,
    );
    expect(textOf(result)).toContain(nextStep);
    expect(requested()).toEqual(['window 10200']);
  });

  it('serves matches 10001-10200 at the ceiling, then says no further page can be requested', async () => {
    const result = await runToolContract(searchCompounds, {
      ...quinoline,
      maxResults: 200,
      offset: 10000,
    });

    const page = pageOf(result);
    expect(page.results.map((r) => r.cid)).toEqual(range(10001, 10201));
    expect(page).not.toHaveProperty('nextOffset');
    expect(page.truncated).toBe(true);
    const notice =
      'Showing matches 10001-10200; more exist, but PubChem reports no match count for a substructure search. A substructure search pages only to offset 10000, so no further page can be requested; narrow it to fewer matches: use a larger, more specific query structure.';
    expect(page.notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain(notice);
    expect(text).not.toContain('maxResults=200');
    expect(requested()).toEqual(['window 10201']);
  });

  it.each<[string, SearchInput, string]>([
    ['formula', { searchType: 'formula', formula: 'C6H12O6' }, 'search a more specific formula'],
    [
      'formula with allowOtherElements',
      { searchType: 'formula', formula: 'C6H12O6', allowOtherElements: true },
      'set allowOtherElements to false, or search a more specific formula',
    ],
    [
      'superstructure',
      { ...quinoline, searchType: 'superstructure' },
      'use a smaller query structure',
    ],
    [
      'similarity',
      { ...quinoline, searchType: 'similarity', threshold: 80 },
      'raise threshold above 80',
    ],
  ])(
    'serves offset 10000 for a %s search and names its narrowing at the ceiling',
    async (_label, args, narrowing) => {
      const result = await runToolContract(searchCompounds, {
        ...args,
        maxResults: 5,
        offset: 10000,
      });

      const page = pageOf(result);
      expect(page.results.map((r) => r.cid)).toEqual(range(10001, 10006));
      expect(page).not.toHaveProperty('nextOffset');
      const mode = args.searchType;
      const notice = `Showing matches 10001-10005; more exist, but PubChem reports no match count for a ${mode} search. A ${mode} search pages only to offset 10000, so pass offset=10000 with maxResults=200 to reach matches through 10200; past 10200, narrow it to fewer matches: ${narrowing}.`;
      expect(page.notice).toBe(notice);
      expect(textOf(result)).toContain(notice);
      // A similarity page also asks for its fingerprints, and a SMILES query's (#97).
      expect(requested()).toEqual(
        mode === 'similarity'
          ? [
              'window 10006',
              '/rest/pug/compound/cid/10001,10002,10003,10004,10005/property/Fingerprint2D/JSON',
              '/rest/pug/compound/smiles/property/Fingerprint2D/JSON',
            ]
          : ['window 10006'],
      );
    },
  );

  it.each<[string, SearchInput, string]>([
    ['formula', { searchType: 'formula', formula: 'C6H12O6' }, 'search a more specific formula'],
    ['substructure', quinoline, 'use a larger, more specific query structure'],
    [
      'superstructure',
      { ...quinoline, searchType: 'superstructure' },
      'use a smaller query structure',
    ],
    ['similarity', { ...quinoline, searchType: 'similarity' }, 'raise threshold above 90'],
  ])(
    'rejects a %s search at offset 10001 as offset_ceiling_exceeded before any PubChem request',
    async (mode, args, narrowing) => {
      const result = await runToolContract(searchCompounds, { ...args, offset: 10001 });

      const error = errorOf(result) as CeilingEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('offset_ceiling_exceeded');
      expect(error.data?.recovery?.hint).toBe(`Pass an offset of 10000 or less, or ${narrowing}.`);
      const text = textOf(result);
      expect(text).toContain(`offset 10001 is past the 10000 offset ceiling for a ${mode} search.`);
      expect(text).toContain(narrowing);
      expect(text).toContain('offset_ceiling_exceeded');
      // The stub answers every mode, so a check that ran after the request would show here.
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('pages an assay ListKey past the old ceiling: AID 2551 at offset 10005', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'assay',
      aid: 2551,
      activeOnly: false,
      maxResults: 5,
      offset: 10005,
    });

    const page = pageOf(result);
    expect(page.results.map((r) => r.cid)).toEqual(range(10005, 10010).map(assayCid));
    expect(page.totalFound).toBe(AID_2551_SIZE);
    expect(page.nextOffset).toBe(10010);
    expect(page.notice).toBe(
      'Showing matches 10006-10010 of 305439. Pass offset=10010 for the next page.',
    );
    expect(textOf(result)).toContain('Showing matches 10006-10010 of 305439.');
    expect(requested()).toEqual(['listkey', 'page 10005+5']);
  });

  it('pages deep into the ListKey and serves its last partial page with no nextOffset', async () => {
    const deep = pageOf(
      await runToolContract(searchCompounds, {
        searchType: 'assay',
        aid: 2551,
        activeOnly: false,
        maxResults: 5,
        offset: 300000,
      }),
    );
    expect(deep.results.map((r) => r.cid)).toEqual(range(300000, 300005).map(assayCid));
    expect(deep.nextOffset).toBe(300005);

    const last = pageOf(
      await runToolContract(searchCompounds, {
        searchType: 'assay',
        aid: 2551,
        activeOnly: false,
        maxResults: 10,
        offset: 305434,
      }),
    );
    expect(last.results.map((r) => r.cid)).toEqual(range(305434, AID_2551_SIZE).map(assayCid));
    expect(last).not.toHaveProperty('nextOffset');
    expect(last).not.toHaveProperty('truncated');
    expect(requested()).toEqual(['listkey', 'page 300000+5', 'listkey', 'page 305434+10']);
  });

  it.each([AID_2551_SIZE, 400000])(
    'answers assay offset %i, at or past the total, with the past-the-end notice and no page request',
    async (offset) => {
      const result = await runToolContract(searchCompounds, {
        searchType: 'assay',
        aid: 2551,
        activeOnly: false,
        offset,
      });

      const page = pageOf(result);
      expect(page.results).toEqual([]);
      expect(page.totalFound).toBe(AID_2551_SIZE);
      expect(page).not.toHaveProperty('nextOffset');
      const notice = `offset ${offset} is past the 305439 match(es) found. Pass an offset below 305439.`;
      expect(page.notice).toBe(notice);
      expect(textOf(result)).toContain(notice);
      expect(requested()).toEqual(['listkey']);
    },
  );

  it('answers an identifier search at offset 10001 with an empty page and the past-the-end notice', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin'],
      offset: 10001,
    });

    const page = pageOf(result);
    expect(page.results).toEqual([]);
    expect(page.totalFound).toBe(1);
    const notice = 'offset 10001 is past the 1 match(es) found. Pass an offset below 1.';
    expect(page.notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });

  describe('rejects exactly the offsets the old schema bound rejected, in bounded modes only', () => {
    const OFFSETS = [-1, 0, 1, 1.5, 9999, 10000, 10001, 10002, 20000, 305434, 2 ** 31, 2 ** 53 - 1];
    /** Not a whole offset from 0: the schema rejects these in every mode. */
    const MALFORMED = [-1, 1.5];
    /** Past the 10000 maximum the offset field once carried: only bounded modes still reject. */
    const PAST_CEILING = [10001, 10002, 20000, 305434, 2 ** 31, 2 ** 53 - 1];
    const MODES: Array<[string, SearchInput, boolean]> = [
      ['formula', { searchType: 'formula', formula: 'C6H12O6' }, true],
      ['substructure', quinoline, true],
      ['superstructure', { ...quinoline, searchType: 'superstructure' }, true],
      ['similarity', { ...quinoline, searchType: 'similarity' }, true],
      ['assay', { searchType: 'assay', aid: 2551, activeOnly: false }, false],
      [
        'identifier',
        { searchType: 'identifier', identifierType: 'name', identifiers: ['aspirin'] },
        false,
      ],
    ];

    it.each(MODES)('%s', async (_mode, args, bounded) => {
      const outcomes: Array<[number, string]> = [];
      for (const offset of OFFSETS) {
        // A fresh client per row, so the rows don't queue behind one 5-per-second limiter.
        initPubChemClient();
        const result = await runToolContract(searchCompounds, { ...args, maxResults: 1, offset });
        outcomes.push([offset, result.isError ? String(errorOf(result).data?.reason) : 'served']);
      }

      expect(outcomes).toEqual(
        OFFSETS.map((offset) => [
          offset,
          MALFORMED.includes(offset)
            ? 'invalid_arguments'
            : bounded && PAST_CEILING.includes(offset)
              ? 'offset_ceiling_exceeded'
              : 'served',
        ]),
      );
    });
  });
});

describe('pubchem_search_compounds mass mode (#98)', () => {
  /** The 180.0630–180.0640 monoisotopic window as PubChem lists it: 1,182 CIDs, glucose first,
   * in PubChem's order (the first five as captured live, then synthetic). */
  const MONO_180 = [
    5793,
    2723872,
    892,
    439312,
    6036,
    ...Array.from({ length: 1177 }, (_, i) => 100_000_000 + i),
  ];

  /** The first 20 of the 79 CIDs PubChem lists for monoisotopic_mass 0–10, as captured live:
   * hydrogen (783) second, helium (23987) fourth. */
  const MONO_0_10_HEAD = [
    5460467, 783, 3028194, 23987, 107649, 24523, 28486, 24824, 62714, 6914554, 5362549, 1038,
    167583, 5460653, 6857639, 166653, 6337039, 129012201, 5460631, 5460634,
  ];

  /** Every window the stub knows, by its `{massType}/{min}/{max}` path; each stored list's
   * ListKey is its position here. A window not listed answers HTTP 404 "Search returned no
   * hits", as PubChem answers an empty, inverted, or negative window. The 300–303 window is
   * past PubChem's count: Size stops at 1,000,000 and the list pages that many. */
  const WINDOWS: Array<[string, { size: number; cidAt: (i: number) => number }]> = [
    ['monoisotopic_mass/180.063/180.064', { size: 1182, cidAt: (i) => MONO_180[i]! }],
    ['monoisotopic_mass/180.0633881/180.0633881', { size: 1111, cidAt: (i) => MONO_180[i]! }],
    ['exact_mass/551.5034/551.5044', { size: 2, cidAt: (i) => [6905, 59271344][i]! }],
    ['monoisotopic_mass/551.5034/551.5044', { size: 1, cidAt: () => 59271344 }],
    ['monoisotopic_mass/300/302', { size: 800_342, cidAt: (i) => 179_338_105 - i }],
    ['monoisotopic_mass/300/303', { size: 1_000_000, cidAt: (i) => 132_970_840 - i }],
    ['monoisotopic_mass/0/10', { size: 79, cidAt: (i) => MONO_0_10_HEAD[i]! }],
  ];

  const pubchemMass: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error('unmocked fetch');
    const search = /^\/rest\/pug\/compound\/(\w+)\/range\/([^/]+)\/([^/]+)\/cids\/JSON$/.exec(
      url.pathname,
    );
    if (search && url.searchParams.get('list_return') === 'listkey') {
      const index = WINDOWS.findIndex(([key]) => key === search.slice(1).join('/'));
      if (index < 0) return fault(404, 'PUGREST.NotFound', 'Search returned no hits');
      return Response.json({
        IdentifierList: { ListKey: String(index), Size: WINDOWS[index]![1].size },
      });
    }
    const page = /^\/rest\/pug\/compound\/listkey\/(\d+)\/cids\/JSON$/.exec(url.pathname);
    if (page) {
      const { size, cidAt } = WINDOWS[Number(page[1])]![1];
      const start = Number(url.searchParams.get('listkey_start'));
      const count = Number(url.searchParams.get('listkey_count'));
      if (start >= size) return fault(500, 'PUGREST.ServerError', 'EFetch failed');
      const end = Math.min(start + count, size);
      return cidList(Array.from({ length: end - start }, (_, i) => cidAt(start + i)));
    }
    const props = /^\/rest\/pug\/compound\/cid\/([\d,]+)\/property\/MonoisotopicMass\/JSON$/.exec(
      url.pathname,
    );
    if (props) {
      const cids = (props[1] ?? '').split(',').map(Number);
      return Response.json({
        PropertyTable: { Properties: cids.map((CID) => ({ CID, MonoisotopicMass: CID / 1000 })) },
      });
    }
    throw new Error('unmocked fetch');
  };

  /** Request kinds the stub received, in order. */
  const requestKinds = () =>
    fetchMock.mock.calls.map(([input]) => {
      const { pathname, searchParams } = new URL(String(input));
      const search = /^\/rest\/pug\/compound\/(\w+)\/range\/([^/]+)\/([^/]+)\//.exec(pathname);
      if (search) return `search ${search[1]} ${search[2]}-${search[3]}`;
      if (pathname.includes('/compound/listkey/')) {
        return `page ${searchParams.get('listkey_start')}+${searchParams.get('listkey_count')}`;
      }
      return 'properties';
    });

  type MassContent = {
    results: Array<{ cid: number; properties?: Record<string, unknown> }>;
    totalFound?: number;
    totalFoundAtLeast?: number;
    offset: number;
    nextOffset?: number;
    truncated?: boolean;
    notice?: string;
  };
  const contentOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    expect(result.isError).toBeFalsy();
    return result.structuredContent as MassContent;
  };

  const glucoseWindow = {
    searchType: 'mass',
    massType: 'monoisotopic_mass',
    massMin: 180.063,
    massMax: 180.064,
  } satisfies SearchInput;
  const cappedWindow = { ...glucoseWindow, massMin: 300, massMax: 303 } satisfies SearchInput;

  const NARROW =
    'narrow the mass window (raise massMin or lower massMax) to one with fewer than 1000000 matches';

  beforeEach(() => {
    fetchMock.mockImplementation(pubchemMass);
  });

  it('searches monoisotopic_mass 180.0630–180.0640: totalFound 1182, glucose first, on both surfaces', async () => {
    const result = await runToolContract(searchCompounds, glucoseWindow);

    const content = contentOf(result);
    expect(content.results.map((r) => r.cid)).toEqual(MONO_180.slice(0, 20));
    expect(content.totalFound).toBe(1182);
    expect(content).not.toHaveProperty('totalFoundAtLeast');
    expect(content.nextOffset).toBe(20);
    expect(content.truncated).toBe(true);
    expect(content.notice).toBe('Showing matches 1-20 of 1182. Pass offset=20 for the next page.');
    expect(content).not.toHaveProperty('activeOnly');
    expect(requestKinds()).toEqual(['search monoisotopic_mass 180.063-180.064', 'page 0+20']);
    const text = textOf(result);
    expect(text).toContain(`CIDs: ${MONO_180.slice(0, 20).join(', ')}`);
    expect(text).toContain(content.notice!);
  });

  it('pages a large window past offset 10000 to its last match, with no ceiling', async () => {
    const window = { ...glucoseWindow, massMin: 300, massMax: 302 } satisfies SearchInput;

    const deep = contentOf(
      await runToolContract(searchCompounds, { ...window, maxResults: 5, offset: 10001 }),
    );
    expect(deep.results.map((r) => r.cid)).toEqual(
      [10001, 10002, 10003, 10004, 10005].map((i) => 179_338_105 - i),
    );
    expect(deep.totalFound).toBe(800_342);
    expect(deep.nextOffset).toBe(10006);

    const last = await runToolContract(searchCompounds, {
      ...window,
      maxResults: 20,
      offset: 800_340,
    });
    const content = contentOf(last);
    expect(content.results.map((r) => r.cid)).toEqual(
      [800_340, 800_341].map((i) => 179_338_105 - i),
    );
    expect(content.totalFound).toBe(800_342);
    expect(content).not.toHaveProperty('nextOffset');
    expect(content).not.toHaveProperty('truncated');
    expect(content).not.toHaveProperty('notice');
    expect(requestKinds()).toEqual([
      'search monoisotopic_mass 300-302',
      'page 10001+5',
      'search monoisotopic_mass 300-302',
      'page 800340+20',
    ]);
  });

  it('finds hexabromobenzene (CID 6905) at 551.5034–551.5044 under exact_mass, not monoisotopic_mass', async () => {
    const window = { massMin: 551.5034, massMax: 551.5044 };

    const exact = contentOf(
      await runToolContract(searchCompounds, {
        searchType: 'mass',
        massType: 'exact_mass',
        ...window,
      }),
    );
    const mono = contentOf(
      await runToolContract(searchCompounds, {
        searchType: 'mass',
        massType: 'monoisotopic_mass',
        ...window,
      }),
    );

    expect(exact.results.map((r) => r.cid)).toEqual([6905, 59271344]);
    expect(mono.results.map((r) => r.cid)).toEqual([59271344]);
    expect(requestKinds()).toEqual([
      'search exact_mass 551.5034-551.5044',
      'page 0+20',
      'search monoisotopic_mass 551.5034-551.5044',
      'page 0+20',
    ]);
  });

  it('accepts massMin equal to massMax as a one-value window', async () => {
    const result = await runToolContract(searchCompounds, {
      ...glucoseWindow,
      massMin: 180.0633881,
      massMax: 180.0633881,
    });

    expect(contentOf(result).totalFound).toBe(1111);
    expect(requestKinds()[0]).toBe('search monoisotopic_mass 180.0633881-180.0633881');
  });

  it('answers an empty window with no results, totalFound 0, and a notice naming the mass type and window', async () => {
    const result = await runToolContract(searchCompounds, {
      ...glucoseWindow,
      massType: 'exact_mass',
      massMin: 1.5,
      massMax: 1.6,
    });

    const content = contentOf(result);
    expect(content.results).toEqual([]);
    expect(content.totalFound).toBe(0);
    expect(content).not.toHaveProperty('nextOffset');
    const notice =
      'No compounds have exact_mass from 1.5 to 1.6. Widen the window (lower massMin or raise massMax), or check massType: exact_mass differs from monoisotopic_mass for compounds rich in Cl or Br and for molecules of about 90 or more carbons, and molecular_weight is the isotope-averaged weight.';
    expect(content.notice).toBe(notice);
    expect(requestKinds()).toEqual(['search exact_mass 1.5-1.6']);
    const text = textOf(result);
    expect(text).toContain('No results.');
    expect(text).toContain(notice);
  });

  it('answers an offset at the end of an exact list with the past-the-end notice and no page request', async () => {
    const content = contentOf(
      await runToolContract(searchCompounds, { ...glucoseWindow, offset: 1182 }),
    );

    expect(content.results).toEqual([]);
    expect(content.totalFound).toBe(1182);
    expect(content).not.toHaveProperty('nextOffset');
    expect(content.notice).toBe(
      'offset 1182 is past the 1182 match(es) found. Pass an offset below 1182.',
    );
    expect(requestKinds()).toEqual(['search monoisotopic_mass 180.063-180.064']);
  });

  it('reports a capped window as totalFoundAtLeast 1000000, with the next offset and how to narrow', async () => {
    const result = await runToolContract(searchCompounds, cappedWindow);

    const content = contentOf(result);
    expect(content.results.map((r) => r.cid)).toEqual(
      Array.from({ length: 20 }, (_, i) => 132_970_840 - i),
    );
    expect(content.totalFoundAtLeast).toBe(1_000_000);
    expect(content).not.toHaveProperty('totalFound');
    expect(content.nextOffset).toBe(20);
    expect(content.truncated).toBe(true);
    const notice = `Showing matches 1-20 of at least 1000000; PubChem stops counting this search at 1000000 matches and pages only those. Pass offset=20 for the next page, or ${NARROW}.`;
    expect(content.notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });

  it.each([
    [999_980, 20, 'Showing matches 999981-1000000'],
    [999_990, 20, 'Showing matches 999991-1000000'],
  ])(
    'serves a capped window to entry 1000000 from offset %i with no nextOffset',
    async (offset, shown, range) => {
      const result = await runToolContract(searchCompounds, {
        ...cappedWindow,
        maxResults: 20,
        offset,
      });

      const content = contentOf(result);
      expect(content.results).toHaveLength(1_000_000 - offset);
      expect(content.results.at(-1)?.cid).toBe(132_970_840 - 999_999);
      expect(content.totalFoundAtLeast).toBe(1_000_000);
      expect(content).not.toHaveProperty('nextOffset');
      expect(content.truncated).toBe(true);
      const notice = `${range} of at least 1000000; PubChem stops counting this search at 1000000 matches and pages only those. No further page can be requested; ${NARROW}.`;
      expect(content.notice).toBe(notice);
      const text = textOf(result);
      expect(text).toContain(notice);
      expect(text).not.toMatch(/nextOffset/i);
      expect(requestKinds()).toEqual([
        'search monoisotopic_mass 300-303',
        `page ${offset}+${shown}`,
      ]);
    },
  );

  it('answers an offset at the cap with the narrowing notice and no page request', async () => {
    const result = await runToolContract(searchCompounds, {
      ...cappedWindow,
      offset: 1_000_000,
    });

    const content = contentOf(result);
    expect(content.results).toEqual([]);
    expect(content.totalFoundAtLeast).toBe(1_000_000);
    expect(content).not.toHaveProperty('nextOffset');
    const notice = `offset 1000000 is past the 1000000 matches PubChem pages for this search, the most it counts. Pass an offset below 1000000, or ${NARROW}.`;
    expect(content.notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
    expect(requestKinds()).toEqual(['search monoisotopic_mass 300-303']);
  });

  it('hydrates the page with requested properties', async () => {
    const result = await runToolContract(searchCompounds, {
      ...glucoseWindow,
      maxResults: 2,
      properties: ['MonoisotopicMass'],
    });

    expect(contentOf(result).results).toEqual([
      { cid: 5793, properties: { MonoisotopicMass: 5.793 } },
      { cid: 2723872, properties: { MonoisotopicMass: 2723.872 } },
    ]);
    expect(requestKinds()).toEqual([
      'search monoisotopic_mass 180.063-180.064',
      'page 0+2',
      'properties',
    ]);
    expect(textOf(result)).toContain('MonoisotopicMass: 5.793');
  });

  it.each<[SearchInput, string]>([
    [{ searchType: 'mass' }, 'massType, massMin, massMax missing'],
    [{ searchType: 'mass', massType: 'exact_mass', massMin: 180 }, 'massMax missing'],
    [{ searchType: 'mass', massMin: 180, massMax: 181 }, 'massType missing'],
    [{ searchType: 'mass', massType: 'molecular_weight', massMax: 181 }, 'massMin missing'],
  ])('rejects %j as missing_mass_args before any PubChem request', async (input, missing) => {
    const result = await runToolContract(searchCompounds, input);

    const error = errorOf(result) as ErrorEnvelope & { data?: { recovery?: { hint?: string } } };
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('missing_mass_args');
    expect(error.data?.recovery?.hint).toContain('massType ("monoisotopic_mass", "exact_mass", or');
    const text = textOf(result);
    expect(text).toContain(`A mass search needs massType, massMin, and massMax; ${missing}.`);
    expect(text).toContain('massMin 180.063 and massMax 180.064');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects massMin above massMax as inverted_mass_window before any PubChem request', async () => {
    const result = await runToolContract(searchCompounds, {
      ...glucoseWindow,
      massMin: 181,
      massMax: 180,
    });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('inverted_mass_window');
    const text = textOf(result);
    expect(text).toContain('massMin 181 is greater than massMax 180.');
    expect(text).toContain('Pass massMin no greater than massMax');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { massMin: -5, massMax: 10 },
    { massMin: 0, massMax: -1 },
    { massMin: -0.001, massMax: -0.0001 },
  ])('rejects a negative bound %j at the schema', async (bounds) => {
    const result = await runToolContract(searchCompounds, { ...glucoseWindow, ...bounds });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a window starting at 0: 79 CIDs, hydrogen and helium among the first page', async () => {
    const content = contentOf(
      await runToolContract(searchCompounds, { ...glucoseWindow, massMin: 0, massMax: 10 }),
    );

    expect(content.totalFound).toBe(79);
    expect(content.results.map((r) => r.cid)).toEqual(MONO_0_10_HEAD);
    expect(content.results.map((r) => r.cid)).toEqual(expect.arrayContaining([783, 23987]));
    expect(content.nextOffset).toBe(20);
    expect(requestKinds()).toEqual(['search monoisotopic_mass 0-10', 'page 0+20']);
  });

  describe('a search PubChem cannot finish in time', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails a 504 PUGREST.Timeout as mass_search_timeout with the narrow-the-window hint', async () => {
      fetchMock.mockImplementation(async () => fault(504, 'PUGREST.Timeout', 'Request timed out'));

      const call = runToolContract(searchCompounds, {
        ...glucoseWindow,
        massMin: 200,
        massMax: 500,
      });
      await vi.runAllTimersAsync();
      const result = await call;

      const error = errorOf(result) as ErrorEnvelope & {
        data?: { recovery?: { hint?: string }; status?: number };
      };
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data?.reason).toBe('mass_search_timeout');
      expect(error.data?.status).toBe(504);
      const hint =
        'Narrow the mass window (raise massMin or lower massMax) so PubChem can finish the search, then retry.';
      expect(error.data?.recovery?.hint).toBe(hint);
      const text = textOf(result);
      expect(text).toContain('PubChem did not finish the mass search in time.');
      expect(text).toContain(hint);
      expect(requestKinds()).toEqual([
        'search monoisotopic_mass 200-500',
        'search monoisotopic_mass 200-500',
      ]);
    });
  });

  describe('an assay list PubChem stopped counting takes the same capped path', () => {
    const assayCid = (position: number) => 7_000_000 + position;
    const cappedAssay: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/rest/pug/assay/aid/1000/cids/JSON') {
        return Response.json({ IdentifierList: { ListKey: 'big', Size: 1_000_000 } });
      }
      const start = Number(url.searchParams.get('listkey_start'));
      const count = Number(url.searchParams.get('listkey_count'));
      const end = Math.min(start + count, 1_000_000);
      return cidList(Array.from({ length: end - start }, (_, i) => assayCid(start + i)));
    };

    it('offers activeOnly: true as the narrower list on a page of every tested compound', async () => {
      fetchMock.mockImplementation(cappedAssay);

      const content = contentOf(
        await runToolContract(searchCompounds, {
          searchType: 'assay',
          aid: 1000,
          activeOnly: false,
          maxResults: 2,
        }),
      );

      expect(content.totalFoundAtLeast).toBe(1_000_000);
      expect(content.nextOffset).toBe(2);
      expect(content.notice).toBe(
        'Showing matches 1-2 of at least 1000000; PubChem stops counting this search at 1000000 matches and pages only those. Pass offset=2 for the next page, or pass activeOnly: true for the shorter list of compounds the assay marked active.',
      );
    });

    it('names no narrower list once the active list itself ends at the cap', async () => {
      fetchMock.mockImplementation(cappedAssay);

      const content = contentOf(
        await runToolContract(searchCompounds, {
          searchType: 'assay',
          aid: 1000,
          maxResults: 2,
          offset: 999_998,
        }),
      );

      expect(content.results.map((r) => r.cid)).toEqual([assayCid(999_998), assayCid(999_999)]);
      expect(content).not.toHaveProperty('nextOffset');
      expect(content.notice).toBe(
        'Showing matches 999999-1000000 of at least 1000000; PubChem stops counting this search at 1000000 matches and pages only those. No further page can be requested.',
      );
    });
  });

  it('names massType, massMin, and massMax as the mass mode’s fields in the searchType description', () => {
    const properties = advertisedInputSchema().properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.searchType?.description).toMatch(
      /"mass"[^.]*requires massType, massMin, and massMax/,
    );
    expect(advertisedInputSchema().required).toEqual(['searchType']);
  });
});

describe('pubchem_search_compounds similarity scores (#97)', () => {
  /** PubChem's 201 hits for CID 2244 at Threshold 75, in its order, as captured live. */
  const HITS = readJsonFixture<{ IdentifierList: { CID: number[] } }>(
    'fastsimilarity-2244-t75.json',
  ).IdentifierList.CID;

  /** The first 20 hits with their Tanimoto to aspirin, to three decimals, as the issue's scoring
   * script printed them from the same fingerprints. */
  const FIRST_20: ReadonlyArray<readonly [number, number]> = [
    [135, 0.754],
    [7456, 0.798],
    [338, 0.853],
    [2244, 1],
    [7175, 0.8],
    [7184, 0.8],
    [5280343, 0.752],
    [5280961, 0.781],
    [5053, 0.766],
    [54678486, 0.831],
    [5585, 0.762],
    [323, 0.812],
    [4133, 0.906],
    [4632, 0.805],
    [8434, 0.8],
    [10228, 0.756],
    [15797, 0.809],
    [5280443, 0.82],
    [54676038, 0.833],
    [3469, 0.813],
  ];
  const scored = FIRST_20.map(([cid, similarity]) => ({ cid, similarity }));

  const ASPIRIN_SMILES = 'CC(=O)OC1=CC=CC=C1C(=O)O';
  /** A structure PubChem has no record of; its search at threshold 70 found these five hits,
   * whose fingerprints are the captured ones. */
  const NOVEL_SMILES =
    'C1=CC=C(C=C1)C2=CC=C(C=C2)C3=CC=C(C=C3)C4=CC=C(C=C4)OCCCCCCCCCCCCCCCCCCCCCCCC(F)(F)Cl';
  const NOVEL_FINGERPRINTS = fingerprintsByCid('fingerprint2d-novel-smiles-hits.json');
  const NOVEL_HITS = [40326, 637563, 5281873, 3347, 8815];
  const FINGERPRINTS = new Map([...ASPIRIN_T75_FINGERPRINTS, ...NOVEL_FINGERPRINTS]);

  /** The first page's notice, as it read before scores existed. */
  const PAGE_1_NOTICE =
    'Showing matches 1-20; more exist, but PubChem reports no match count for a similarity search. Pass offset=20 for the next page.';
  const PAGE_OF_3 =
    'Showing matches 1-3; more exist, but PubChem reports no match count for a similarity search. Pass offset=3 for the next page.';

  /** CIDs whose rows the stub leaves without Fingerprint2D (property rows, and the aspirin SMILES
   * lookup's row for 2244), CIDs it serves a damaged Fingerprint2D for, lookups it fails, and
   * lookups it answers HTTP 200 with the given JSON in place of a property table. */
  let withoutFingerprint: Set<number>;
  let damaged: Map<number, string>;
  let failing: Set<'properties' | 'smiles fingerprint'>;
  let answeringFault: Map<'properties' | 'smiles fingerprint', unknown>;

  const FAULT_ENVELOPE = { Fault: { Code: 'PUGREST.ServerBusy', Message: 'Server too busy' } };
  const NULL_ROW_TABLE = { PropertyTable: { Properties: [null] } };

  const smilesOf = (init: RequestInit | undefined) =>
    new URLSearchParams(String(init?.body)).get('smiles');

  /** PubChem stand-in: every fast search answers the captured aspirin hits (the novel SMILES its
   * own five), up to MaxRecords; property requests answer each CID's captured fingerprint and a
   * placeholder for any other property; a SMILES fingerprint lookup answers aspirin's, or CID 0
   * with no properties, as PubChem answers a structure it has no record of. */
  const pubchemSimilarity: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error('unmocked fetch');
    const unavailable = () =>
      fault(503, 'PUGREST.ServerBusy', 'Too many requests or server too busy');
    if (url.pathname.startsWith('/rest/pug/compound/fast')) {
      const hits = smilesOf(init) === NOVEL_SMILES ? NOVEL_HITS : HITS;
      return cidList(hits.slice(0, Number(url.searchParams.get('MaxRecords'))));
    }
    const properties = propertyRequest(url, init);
    if (properties) {
      if (failing.has('properties')) return unavailable();
      if (answeringFault.has('properties')) return Response.json(answeringFault.get('properties'));
      const rows = properties.cids.map((CID) => {
        const row: Record<string, unknown> = { CID };
        for (const name of properties.names) {
          const fingerprint = withoutFingerprint.has(CID)
            ? undefined
            : (damaged.get(CID) ?? FINGERPRINTS.get(CID));
          if (name !== 'Fingerprint2D') row[name] = `${name} of ${CID}`;
          else if (fingerprint !== undefined) row[name] = fingerprint;
        }
        return row;
      });
      return Response.json({ PropertyTable: { Properties: rows } });
    }
    if (url.pathname === '/rest/pug/compound/smiles/property/Fingerprint2D/JSON') {
      if (failing.has('smiles fingerprint')) return unavailable();
      if (answeringFault.has('smiles fingerprint')) {
        return Response.json(answeringFault.get('smiles fingerprint'));
      }
      const row =
        smilesOf(init) === ASPIRIN_SMILES
          ? {
              CID: 2244,
              ...(!withoutFingerprint.has(2244) && { Fingerprint2D: ASPIRIN_FINGERPRINT }),
            }
          : { CID: 0 };
      return Response.json({ PropertyTable: { Properties: [row] } });
    }
    throw new Error('unmocked fetch');
  };

  /** Each request the stub received, in order. */
  const requests = () =>
    fetchMock.mock.calls.map(([input, init]) => {
      const url = new URL(String(input));
      const search = /^\/rest\/pug\/compound\/(fast\w+)\/([^/]+)\//.exec(url.pathname);
      if (search) return `search ${search[1]}/${search[2]}`;
      const properties = propertyRequest(url, init);
      if (properties) return `properties ${properties.method} ${properties.names.join(',')}`;
      return `smiles fingerprint ${smilesOf(init)} (${init?.method})`;
    });
  /** The CIDs every property request asked for. */
  const propertyCids = () =>
    fetchMock.mock.calls.flatMap(
      ([input, init]) => propertyRequest(new URL(String(input)), init)?.cids ?? [],
    );

  type ScoredContent = {
    results: Array<{ cid: number; similarity?: number; properties?: Record<string, unknown> }>;
    totalFound?: number;
    nextOffset?: number;
    notice?: string;
  };
  const contentOf = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    expect(result.isError).toBeFalsy();
    return result.structuredContent as ScoredContent;
  };

  const aspirinT75 = {
    searchType: 'similarity',
    query: '2244',
    queryType: 'cid',
    threshold: 75,
  } satisfies SearchInput;
  const aspirinSmilesT75 = {
    ...aspirinT75,
    query: ASPIRIN_SMILES,
    queryType: 'smiles',
  } satisfies SearchInput;

  beforeEach(() => {
    withoutFingerprint = new Set();
    damaged = new Map();
    failing = new Set();
    answeringFault = new Map();
    fetchMock.mockImplementation(pubchemSimilarity);
  });

  it("scores aspirin's first page at threshold 75 — CID 135 0.754, CID 4133 0.906, CID 2244 1 — in PubChem's order, on both surfaces", async () => {
    const result = await runToolContract(searchCompounds, aspirinT75);

    const content = contentOf(result);
    expect(content.results).toEqual(scored);
    expect(content.notice).toBe(PAGE_1_NOTICE);
    expect(requests()).toEqual(['search fastsimilarity_2d/cid', 'properties GET Fingerprint2D']);
    expect(propertyCids()).toEqual(HITS.slice(0, 20));
    const text = textOf(result);
    expect(text).toContain(
      'CIDs: 135 (similarity 0.754), 7456 (similarity 0.798), 338 (similarity 0.853), 2244 (similarity 1), 7175 (similarity 0.8),',
    );
    expect(text).toContain('4133 (similarity 0.906)');
    expect(readBlockquotes(text).at(-1)).toBe(PAGE_1_NOTICE);
  });

  it("adds the query CID to the page's fingerprint request when the page lacks it, and returns no row for it", async () => {
    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinT75, maxResults: 3 }),
    );

    expect(content.results).toEqual(scored.slice(0, 3));
    expect(content.notice).toBe(PAGE_OF_3);
    expect(requests()).toEqual(['search fastsimilarity_2d/cid', 'properties GET Fingerprint2D']);
    expect(propertyCids()).toEqual([135, 7456, 338, 2244]);
  });

  it('scores a full 200-hit page from one POSTed request, every hit at 0.75 or above, CID 5161 at 0.958', async () => {
    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinT75, maxResults: 200 }),
    );

    expect(content.results.map((r) => r.cid)).toEqual(HITS.slice(0, 200));
    const scores = content.results.map((r) => r.similarity);
    expect(scores.every((s) => s !== undefined && s >= 0.75 && s <= 1)).toBe(true);
    expect(content.results[46]).toEqual({ cid: 5161, similarity: 0.958 });
    expect(requests()).toEqual(['search fastsimilarity_2d/cid', 'properties POST Fingerprint2D']);
    expect(propertyCids()).toEqual(HITS.slice(0, 200));
  });

  it("scores the last page of the match list, past the first, with the query's CID added", async () => {
    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinT75, offset: 195, maxResults: 10 }),
    );

    expect(content.results.map((r) => r.cid)).toEqual(HITS.slice(195));
    expect(content.results.every((r) => r.similarity !== undefined && r.similarity >= 0.75)).toBe(
      true,
    );
    expect(content.totalFound).toBe(201);
    expect(content).not.toHaveProperty('nextOffset');
    expect(propertyCids()).toEqual([...HITS.slice(195), 2244]);
  });

  it('asks for no fingerprints when the offset runs past the matches', async () => {
    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinT75, offset: 300, maxResults: 5 }),
    );

    expect(content.results).toEqual([]);
    expect(content.notice).toBe(
      'offset 300 is past the 201 match(es) found. Pass an offset below 201.',
    );
    expect(requests()).toEqual(['search fastsimilarity_2d/cid']);
  });

  it('asks for no fingerprints when a similarity search finds nothing', async () => {
    fetchMock.mockImplementation(async () => cidList([]));

    const content = contentOf(await runToolContract(searchCompounds, aspirinT75));

    expect(content.results).toEqual([]);
    expect(content.totalFound).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves properties and scores from one property request, and keeps Fingerprint2D out of properties', async () => {
    const result = await runToolContract(searchCompounds, {
      ...aspirinT75,
      maxResults: 2,
      properties: ['MolecularFormula'],
    });

    expect(contentOf(result).results).toEqual([
      { cid: 135, similarity: 0.754, properties: { MolecularFormula: 'MolecularFormula of 135' } },
      {
        cid: 7456,
        similarity: 0.798,
        properties: { MolecularFormula: 'MolecularFormula of 7456' },
      },
    ]);
    expect(requests()).toEqual([
      'search fastsimilarity_2d/cid',
      'properties GET MolecularFormula,Fingerprint2D',
    ]);
    expect(propertyCids()).toEqual([135, 7456, 2244]);
    const text = textOf(result);
    expect(text).toContain('**CID 135** (similarity 0.754)\n**Properties:**\nMolecularFormula: ');
    expect(text).toContain('**CID 7456** (similarity 0.798)\n**Properties:**\n');
    expect(text).not.toContain('Fingerprint2D');
  });

  it('scores a SMILES query for aspirin the same as the 2244 query, from its own fingerprint lookup', async () => {
    const result = await runToolContract(searchCompounds, aspirinSmilesT75);

    const content = contentOf(result);
    expect(content.results).toEqual(scored);
    expect(content.notice).toBe(PAGE_1_NOTICE);
    expect(requests()).toEqual([
      'search fastsimilarity_2d/smiles',
      'properties GET Fingerprint2D',
      `smiles fingerprint ${ASPIRIN_SMILES} (POST)`,
    ]);
    expect(propertyCids()).toEqual(HITS.slice(0, 20));
  });

  it('returns the hits of a SMILES not in PubChem unscored, with a notice saying why', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'similarity',
      query: NOVEL_SMILES,
      queryType: 'smiles',
      threshold: 70,
    });

    const content = contentOf(result);
    expect(content.results).toEqual(NOVEL_HITS.map((cid) => ({ cid })));
    expect(content.totalFound).toBe(5);
    const notice =
      'The query SMILES is not a compound in PubChem, which publishes no fingerprint for a structure it has no record of, so these hits carry no similarity score.';
    expect(content.notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain('CIDs: 40326, 637563, 5281873, 3347, 8815\n');
    expect(readBlockquotes(text).at(-1)).toBe(notice);
    expect(requests()).toEqual([
      'search fastsimilarity_2d/smiles',
      'properties GET Fingerprint2D',
      `smiles fingerprint ${NOVEL_SMILES} (POST)`,
    ]);
  });

  it('leaves similarity off a hit whose row has no Fingerprint2D, never 0, and scores the rest', async () => {
    withoutFingerprint.add(4133);

    const content = contentOf(await runToolContract(searchCompounds, aspirinT75));

    expect(content.results).toEqual(scored.map((row) => (row.cid === 4133 ? { cid: 4133 } : row)));
    expect(content.notice).toBe(PAGE_1_NOTICE);
  });

  it('scores no hit, saying so, when PubChem returns no fingerprint for the query CID', async () => {
    withoutFingerprint.add(2244);

    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinT75, maxResults: 3 }),
    );

    expect(content.results).toEqual([{ cid: 135 }, { cid: 7456 }, { cid: 338 }]);
    expect(content.notice).toBe(
      `PubChem returned no fingerprint for the query, so these hits carry no similarity score. ${PAGE_OF_3}`,
    );
  });

  it('scores no hit, naming the missing fingerprint rather than a missing compound, when the SMILES lookup finds a CID without one', async () => {
    withoutFingerprint.add(2244);

    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinSmilesT75, maxResults: 3 }),
    );

    expect(content.results).toEqual([{ cid: 135 }, { cid: 7456 }, { cid: 338 }]);
    expect(content.notice).toBe(
      `PubChem returned no fingerprint for the query, so these hits carry no similarity score. ${PAGE_OF_3}`,
    );
  });

  /** Aspirin's fingerprint with one character swapped for "!" and a valid one added further on:
   * the same length, so a decoder that skips "!" reads 115 bytes with every later bit shifted. */
  const swappedAndPadded = (value: string) =>
    `${value.slice(0, 20)}!${value.slice(21, 60)}A${value.slice(60, -2)}`;

  it.each<[string, (value: string) => string]>([
    ['cut short', (value) => value.slice(0, 100)],
    ['hex-encoded', (value) => Buffer.from(value, 'base64').toString('hex')],
    ['empty', () => ''],
    ['damaged to its own length', swappedAndPadded],
  ])(
    'scores no hit, saying so, when the query CID’s fingerprint is %s',
    async (_damage, damage) => {
      damaged.set(2244, damage(ASPIRIN_FINGERPRINT));

      const content = contentOf(
        await runToolContract(searchCompounds, { ...aspirinT75, maxResults: 3 }),
      );

      expect(content.results).toEqual([{ cid: 135 }, { cid: 7456 }, { cid: 338 }]);
      expect(content.notice).toBe(
        `PubChem returned no fingerprint for the query, so these hits carry no similarity score. ${PAGE_OF_3}`,
      );
    },
  );

  it('leaves similarity off a hit whose fingerprint is damaged to its own length, never a score from shifted bits', async () => {
    damaged.set(135, swappedAndPadded(FINGERPRINTS.get(135) as string));

    const content = contentOf(
      await runToolContract(searchCompounds, { ...aspirinT75, maxResults: 3 }),
    );

    expect(content.results).toEqual([{ cid: 135 }, ...scored.slice(1, 3)]);
    expect(content.notice).toBe(PAGE_OF_3);
  });

  it.each(['properties', 'smiles fingerprint'] as const)(
    'returns the page unscored after one %s request when PubChem fails that lookup',
    async (lookup) => {
      failing.add(lookup);

      const result = await runToolContract(searchCompounds, {
        ...aspirinSmilesT75,
        maxResults: 3,
      });

      const content = contentOf(result);
      expect(content.results).toEqual([{ cid: 135 }, { cid: 7456 }, { cid: 338 }]);
      const notice = `PubChem did not return the fingerprints to score this page against the query, so its hits carry no similarity score. Retry the call to score them. ${PAGE_OF_3}`;
      expect(content.notice).toBe(notice);
      expect(readBlockquotes(textOf(result)).at(-1)).toBe(notice);
      // A side lookup is not retried: one request each.
      expect(requests()).toEqual([
        'search fastsimilarity_2d/smiles',
        'properties GET Fingerprint2D',
        `smiles fingerprint ${ASPIRIN_SMILES} (POST)`,
      ]);
    },
  );

  it.each([
    ['properties', 'a fault envelope', FAULT_ENVELOPE],
    ['smiles fingerprint', 'a fault envelope', FAULT_ENVELOPE],
    ['properties', 'a null row', NULL_ROW_TABLE],
    ['smiles fingerprint', 'a null row', NULL_ROW_TABLE],
  ] as const)(
    'returns the page unscored when PubChem answers the %s lookup HTTP 200 with %s in place of a property table',
    async (lookup, _body, body) => {
      answeringFault.set(lookup, body);

      const result = await runToolContract(searchCompounds, {
        ...aspirinSmilesT75,
        maxResults: 3,
      });

      const content = contentOf(result);
      expect(content.results).toEqual([{ cid: 135 }, { cid: 7456 }, { cid: 338 }]);
      expect(content.notice).toBe(
        `PubChem did not return the fingerprints to score this page against the query, so its hits carry no similarity score. Retry the call to score them. ${PAGE_OF_3}`,
      );
    },
  );

  describe('with properties, the shared request is the call’s', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fails the call when PubChem fails it, after its one retry, as hydration always has', async () => {
      failing.add('properties');

      const call = runToolContract(searchCompounds, {
        ...aspirinT75,
        maxResults: 3,
        properties: ['MolecularFormula'],
      });
      await vi.runAllTimersAsync();
      const result = await call;

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(requests()).toEqual([
        'search fastsimilarity_2d/cid',
        'properties GET MolecularFormula,Fingerprint2D',
        'properties GET MolecularFormula,Fingerprint2D',
      ]);
    });

    it('fails the call as PubChem unavailable, after its one retry, when PubChem answers it HTTP 200 with no property table', async () => {
      answeringFault.set('properties', FAULT_ENVELOPE);

      const call = runToolContract(searchCompounds, {
        ...aspirinT75,
        maxResults: 3,
        properties: ['MolecularFormula'],
      });
      await vi.runAllTimersAsync();
      const result = await call;

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('PubChem sent a response that could not be read. Retry shortly.');
      expect(requests()).toEqual([
        'search fastsimilarity_2d/cid',
        'properties GET MolecularFormula,Fingerprint2D',
        'properties GET MolecularFormula,Fingerprint2D',
      ]);
    });
  });

  it.each<[string, SearchInput, string]>([
    [
      'substructure',
      { searchType: 'substructure', query: '2244', queryType: 'cid' },
      'search fastsubstructure/cid',
    ],
    [
      'superstructure',
      { searchType: 'superstructure', query: ASPIRIN_SMILES, queryType: 'smiles' },
      'search fastsuperstructure/smiles',
    ],
    ['formula', { searchType: 'formula', formula: 'C9H8O4' }, 'search fastformula/C9H8O4'],
  ])(
    'a %s search carries no similarity and asks for no fingerprint',
    async (_mode, args, search) => {
      const plain = contentOf(await runToolContract(searchCompounds, { ...args, maxResults: 3 }));
      expect(plain.results).toEqual([{ cid: 135 }, { cid: 7456 }, { cid: 338 }]);
      expect(requests()).toEqual([search]);

      fetchMock.mockClear();
      const hydrated = contentOf(
        await runToolContract(searchCompounds, {
          ...args,
          maxResults: 3,
          properties: ['MolecularFormula'],
        }),
      );
      expect(hydrated.results.map((r) => Object.keys(r))).toEqual([
        ['cid', 'properties'],
        ['cid', 'properties'],
        ['cid', 'properties'],
      ]);
      expect(requests()).toEqual([search, 'properties GET MolecularFormula']);
      expect(propertyCids()).toEqual([135, 7456, 338]);
    },
  );

  it("says in the searchType and threshold descriptions that hits come in PubChem's order, a higher threshold narrows them, and 1 is not identity", () => {
    const properties = advertisedInputSchema().properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.searchType?.description).toContain(
      '"similarity": 2D Tanimoto similarity to the query, each hit with its score — hits come in PubChem\'s order, not ranked by score, so raise threshold to narrow to closer analogs.',
    );
    expect(properties.threshold?.description).toContain(
      "Hits come in PubChem's order, not ranked by score, so raising threshold is how to narrow a page to closer analogs. 100 means a fingerprint identical to the query's, not an identical compound",
    );
    const similarity = searchCompounds.output.shape.results.element.shape.similarity.description;
    expect(similarity).toContain('rounded to three decimals');
    expect(similarity).toContain(
      "1 means a fingerprint identical to the query's, not an identical compound",
    );
  });
});
