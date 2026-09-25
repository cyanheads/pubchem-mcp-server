/**
 * @fileoverview Wire-level tests for pubchem_search_compounds identifier-mode batches: how
 * each identifier's upstream outcome — a CID list, a 404, CID 0 (#56), a 400 rejection
 * (#55), or a call-fatal failure — lands in results, unresolvedIdentifiers, the notice,
 * or the error envelope. Runs the real handler and the real PubChemClient against a
 * `fetch` stub routed per identifier, so status mapping and retry run unmocked.
 * @module tests/mcp-server/tools/definitions/search-compounds-identifier-batch.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCompounds } from '@/mcp-server/tools/definitions/search-compounds.tool.js';
import { initPubChemClient } from '@/services/pubchem/pubchem-client.js';

const fetchMock = vi.fn<typeof fetch>();

const PUG = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';

/** What PubChem answers for one identifier. */
type Upstream = number[] | { status: number; code: string; message: string };

const unreadable: Upstream = {
  status: 400,
  code: 'PUGREST.BadRequest',
  message:
    'Unable to standardize the given structure - perhaps some special characters need to be escaped or data packed in a MIME form?',
};
const noCid: Upstream = { status: 404, code: 'PUGREST.NotFound', message: 'No CID found' };
const unavailable: Upstream = { status: 503, code: 'PUGREST.ServerBusy', message: 'Server busy' };
const throttled: Upstream = {
  status: 429,
  code: 'PUGREST.ServerBusy',
  message: 'Too many requests or server too busy',
};

function answer(upstream: Upstream): Response {
  if (Array.isArray(upstream)) return Response.json({ IdentifierList: { CID: upstream } });
  return Response.json(
    { Fault: { Code: upstream.code, Message: upstream.message } },
    { status: upstream.status },
  );
}

/** Routes each identifier lookup to its scripted answer: SMILES arrive in the POST body,
 * names in the URL path. `fixed` answers any other exact URL (a property hydration).
 * An unscripted request is a test bug, so it rejects. */
function routeIdentifiers(
  table: Record<string, Upstream>,
  fixed: Record<string, unknown> = {},
): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url in fixed) return Response.json(fixed[url]);
    let identifier: string | null = null;
    if (url === `${PUG}/compound/smiles/cids/JSON`) {
      identifier = new URLSearchParams(String(init?.body)).get('smiles');
    } else {
      const name = url.match(/\/compound\/name\/([^/]+)\/cids\/JSON$/)?.[1];
      if (name) identifier = decodeURIComponent(name);
    }
    const upstream = identifier === null ? undefined : table[identifier];
    if (!upstream) throw new Error(`unrouted fetch: ${url}`);
    return answer(upstream);
  });
}

/** Upstream requests made for one identifier. */
function requestsFor(identifier: string): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const body = new URLSearchParams(String(init?.body ?? '')).get('smiles');
    return (
      body === identifier || String(input).includes(`/name/${encodeURIComponent(identifier)}/`)
    );
  }).length;
}

type ErrorEnvelope = {
  code: number;
  message: string;
  data?: { reason?: string; fault?: string; recovery?: { hint?: string } };
};

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

function smilesBatch(identifiers: string[], extra: Record<string, unknown> = {}) {
  return {
    searchType: 'identifier' as const,
    identifierType: 'smiles' as const,
    identifiers,
    ...extra,
  };
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

describe('identifier batch — call-fatal upstream failures are never absorbed', () => {
  it('fails the whole batch when one identifier draws a 5xx that survives its retry', async () => {
    routeIdentifiers({ CCO: [702], CCC: unavailable });

    const result = await runToolContract(searchCompounds, smilesBatch(['CCO', 'CCC']));

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(requestsFor('CCC')).toBe(2);
  });

  it('fails the whole batch when one identifier is rate-limited', async () => {
    routeIdentifiers({ CCO: [702], CCC: throttled });

    const result = await runToolContract(searchCompounds, smilesBatch(['CCO', 'CCC']));

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RateLimited);
  });
});

describe('identifier batch — not-found inputs (#29 path through the real client)', () => {
  it('lists a 404 name as unresolved and still returns the resolvable one', async () => {
    routeIdentifiers({ aspirin: [2244], notreal1zzz: noCid });

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin', 'notreal1zzz'],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: 'aspirin' }],
      unresolvedIdentifiers: ['notreal1zzz'],
      totalFound: 1,
    });
    const text = textOf(result);
    expect(text).toContain('2244 (aspirin)');
    expect(text).toContain('Unresolved identifiers (1): notreal1zzz');
    expect(text).toContain('1 of 2 identifier(s) did not resolve to a CID: notreal1zzz');
  });
});

describe('identifier batch — a SMILES PubChem cannot interpret (#55)', () => {
  it('lists the rejected SMILES as unresolved and returns the rest of the batch', async () => {
    routeIdentifiers({ CCO: [702], 'not-a-smiles': unreadable });

    const result = await runToolContract(searchCompounds, smilesBatch(['CCO', 'not-a-smiles']));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 702, identifier: 'CCO' }],
      unresolvedIdentifiers: ['not-a-smiles'],
      totalFound: 1,
    });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain(
      'PubChem could not interpret 1 of 2 identifier(s) as SMILES: not-a-smiles',
    );
    expect(notice).toContain('SMILES syntax');
    expect(notice).not.toContain('did not resolve to a CID');
    const text = textOf(result);
    expect(text).toContain('702 (CCO)');
    expect(text).toContain('Unresolved identifiers (1): not-a-smiles');
    expect(text).toContain('could not interpret 1 of 2');
    expect(requestsFor('not-a-smiles')).toBe(1);
  });

  it.each([[['not-a-smiles']], [['not-a-smiles', 'C1CC']]])(
    'fails a batch where every identifier is rejected (%j) with identifier_rejected',
    async (identifiers) => {
      routeIdentifiers(Object.fromEntries(identifiers.map((id) => [id, unreadable])));

      const result = await runToolContract(searchCompounds, smilesBatch(identifiers));

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('identifier_rejected');
      expect(error.data?.fault).toBe(`${unreadable.code}: ${unreadable.message}`);
      expect(error.message).toContain(identifiers.join(', '));
      expect(error.data?.recovery?.hint).toMatch(/SMILES/);
      expect(textOf(result)).toMatch(/Recovery: /);
      for (const id of identifiers) expect(requestsFor(id)).toBe(1);
    },
  );

  it('does not let a rejected SMILES mask a call-fatal failure elsewhere in the batch', async () => {
    routeIdentifiers({ 'not-a-smiles': unreadable, CCC: unavailable });

    const result = await runToolContract(searchCompounds, smilesBatch(['not-a-smiles', 'CCC']));

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('does not let a rejected SMILES mask a rate limit elsewhere in the batch', async () => {
    routeIdentifiers({ CCO: [702], 'not-a-smiles': unreadable, CCC: throttled });

    const result = await runToolContract(
      searchCompounds,
      smilesBatch(['CCO', 'not-a-smiles', 'CCC']),
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it('treats a 400 on a name lookup the same way', async () => {
    routeIdentifiers({
      aspirin: [2244],
      'bad name': { status: 400, code: 'PUGREST.BadRequest', message: 'Invalid input' },
    });

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['aspirin', 'bad name'],
    });

    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: 'aspirin' }],
      unresolvedIdentifiers: ['bad name'],
    });
    expect(textOf(result)).toContain('could not interpret 1 of 2 identifier(s) as compound names');
  });
});

describe('identifier batch — CID 0 is never a match (#56)', () => {
  const NOVEL = 'FC(F)(F)C1=CC(=CC(=C1)C#CC#CC#CC2=CC=CC=N2)OCCCCCCCCBr';

  it('reports a SMILES PubChem answers with CID 0 as unresolved, not as a match', async () => {
    routeIdentifiers({ [NOVEL]: [0] });

    const result = await runToolContract(searchCompounds, smilesBatch([NOVEL]));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [],
      unresolvedIdentifiers: [NOVEL],
      totalFound: 0,
    });
    const text = textOf(result);
    expect(text).toContain('No results.');
    expect(text).not.toMatch(/CIDs: 0\b/);
    expect(text).toContain(`1 of 1 identifier(s) did not resolve to a CID: ${NOVEL}`);
  });
});

describe('identifier batch — mixed outcomes across pages (#29, #55, #56)', () => {
  // Two resolvable, one CID 0, one rejected, one 404 — in that interleaved input order.
  const MIXED = ['CCO', 'novel', 'not-a-smiles', 'CCC', 'ghost'];
  const MIXED_TABLE: Record<string, Upstream> = {
    CCO: [702],
    novel: [0],
    'not-a-smiles': unreadable,
    CCC: [6334],
    ghost: noCid,
  };
  const UNRESOLVED = ['novel', 'not-a-smiles', 'ghost'];

  function noticeOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
    return (result.structuredContent as { notice?: string }).notice ?? '';
  }

  it('returns the first page with every unresolved input named by cause', async () => {
    routeIdentifiers(MIXED_TABLE);

    const result = await runToolContract(searchCompounds, smilesBatch(MIXED, { maxResults: 1 }));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 702, identifier: 'CCO' }],
      unresolvedIdentifiers: UNRESOLVED,
      totalFound: 2,
      nextOffset: 1,
      truncated: true,
    });
    const notice = noticeOf(result);
    expect(notice).toContain('2 of 5 identifier(s) did not resolve to a CID: novel, ghost');
    expect(notice).toContain(
      'PubChem could not interpret 1 of 5 identifier(s) as SMILES: not-a-smiles',
    );
    expect(notice).toContain('Pass offset=1 for the next page');
    expect(textOf(result)).toContain(`Unresolved identifiers (3): ${UNRESOLVED.join(', ')}`);
  });

  it('pages to the second match, hydrating it, and keeps reporting the unresolved inputs', async () => {
    routeIdentifiers(MIXED_TABLE, {
      [`${PUG}/compound/cid/6334/property/MolecularWeight/JSON`]: {
        PropertyTable: { Properties: [{ CID: 6334, MolecularWeight: '44.10' }] },
      },
    });

    const result = await runToolContract(
      searchCompounds,
      smilesBatch(MIXED, { maxResults: 1, offset: 1, properties: ['MolecularWeight'] }),
    );

    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 6334, identifier: 'CCC', properties: { MolecularWeight: '44.10' } }],
      unresolvedIdentifiers: UNRESOLVED,
      totalFound: 2,
    });
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    const text = textOf(result);
    expect(text).toContain('CID 6334 — CCC');
    expect(text).toContain('MolecularWeight: 44.10');
    expect(text).toContain('could not interpret 1 of 5');
  });

  it('names the bound when the offset runs past the resolved matches', async () => {
    routeIdentifiers(MIXED_TABLE);

    const result = await runToolContract(searchCompounds, smilesBatch(MIXED, { offset: 2 }));

    expect(result.structuredContent).toMatchObject({
      results: [],
      unresolvedIdentifiers: UNRESOLVED,
      totalFound: 2,
    });
    const notice = noticeOf(result);
    expect(notice).toContain('offset 2 is past the 2 match(es) found');
    expect(notice).toContain('not-a-smiles');
  });

  it('returns an empty success, not an error, when nothing resolves but not every input was rejected', async () => {
    routeIdentifiers(MIXED_TABLE);

    const result = await runToolContract(searchCompounds, smilesBatch(['novel', 'not-a-smiles']));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [],
      unresolvedIdentifiers: ['novel', 'not-a-smiles'],
      totalFound: 0,
    });
    const notice = noticeOf(result);
    expect(notice).toContain('1 of 2 identifier(s) did not resolve to a CID: novel');
    expect(notice).toContain('could not interpret 1 of 2 identifier(s) as SMILES: not-a-smiles');
    expect(textOf(result)).toContain('No results.');
  });
});
