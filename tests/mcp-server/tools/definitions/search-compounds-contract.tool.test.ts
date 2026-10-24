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

const fetchMock = vi.fn<typeof fetch>();

function cidList(cids: number[]): Response {
  return new Response(JSON.stringify({ IdentifierList: { CID: cids } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Advertised input schema, produced the way `tools/list` produces it: the framework hands
 * the SDK `input['~standard'].jsonSchema`, and the SDK calls `.input()` at draft-2020-12. */
function advertisedInputSchema(): Record<string, unknown> {
  return searchCompounds.input['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
}

type ErrorEnvelope = { code: number; data?: { reason?: string } };

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
    expect(textOf(result)).toContain('2244 (aspirin)');
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

  const fault = (status: number, code: string, message: string) =>
    Response.json({ Fault: { Code: code, Message: message } }, { status });

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
    expect(textOf(result)).toContain(`Title: Compound ${AID_1000_ACTIVE[0]}`);
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
   * from `listkey_start` and answers a start past its end with HTTP 500. "aspirin" is CID 2244. */
  const pubchem: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error('unmocked fetch');
    const { pathname, searchParams } = url;
    if (/^\/rest\/pug\/compound\/fast[a-z_0-9]+\//.test(pathname)) {
      return cidList(range(1, Number(searchParams.get('MaxRecords')) + 1));
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

  type SearchInput = z.input<typeof searchCompounds.input>;
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
      expect(requested()).toEqual(['window 10006']);
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
