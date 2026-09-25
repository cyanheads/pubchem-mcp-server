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
