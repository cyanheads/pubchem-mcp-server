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

/** Routes each identifier lookup to its scripted answer: SMILES and InChI arrive in the POST
 * body, names in the URL path. `fixed` answers any other exact URL (a property hydration).
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
    } else if (url === `${PUG}/compound/inchi/cids/JSON`) {
      identifier = new URLSearchParams(String(init?.body)).get('inchi');
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
    const form = new URLSearchParams(String(init?.body ?? ''));
    return (
      form.get('smiles') === identifier ||
      form.get('inchi') === identifier ||
      String(input).includes(`/name/${encodeURIComponent(identifier)}/`)
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

  it.each([
    [
      'one identifier is rate-limited',
      { CCO: [702], CCC: throttled },
      ['CCO', 'CCC'],
      JsonRpcErrorCode.RateLimited,
    ],
    [
      'a rejected SMILES sits beside a 5xx',
      { 'not-a-smiles': unreadable, CCC: unavailable },
      ['not-a-smiles', 'CCC'],
      JsonRpcErrorCode.ServiceUnavailable,
    ],
    [
      'a rejected SMILES sits beside a rate limit',
      { CCO: [702], 'not-a-smiles': unreadable, CCC: throttled },
      ['CCO', 'not-a-smiles', 'CCC'],
      JsonRpcErrorCode.RateLimited,
    ],
  ])('fails the whole batch when %s', async (_label, table, identifiers, code) => {
    routeIdentifiers(table);

    const result = await runToolContract(searchCompounds, smilesBatch(identifiers));

    expect(errorOf(result).code).toBe(code);
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

  it('fails an all-rejected batch with no fault field when PubChem stated none', async () => {
    fetchMock.mockImplementation(
      async () => new Response('<!DOCTYPE html><title>400 Bad Request</title>', { status: 400 }),
    );

    const result = await runToolContract(searchCompounds, smilesBatch(['not-a-smiles']));

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('identifier_rejected');
    expect(Object.keys(error.data ?? {})).not.toContain('fault');
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/doctype/i);
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

describe('identifier batch — caller text in notices and error messages (#74)', () => {
  const HOSTILE = 'zzqq **bold** `c`\n# INJECTED';
  const HOSTILE_FRAMED = 'zzqq \\*\\*bold\\*\\* \\`c\\` # INJECTED';
  const LONG = 'n'.repeat(500);
  const LONG_ECHO = `${'n'.repeat(100)}…`;

  function noticeOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
    return (result.structuredContent as { notice?: string }).notice ?? '';
  }

  function nameBatch(identifiers: string[]) {
    return { searchType: 'identifier' as const, identifierType: 'name' as const, identifiers };
  }

  it('frames and cuts not-found identifiers in the notice, keeping unresolvedIdentifiers as sent', async () => {
    routeIdentifiers({ aspirin: [2244], [HOSTILE]: noCid, [LONG]: noCid });

    const result = await runToolContract(searchCompounds, nameBatch(['aspirin', HOSTILE, LONG]));

    expect(result.structuredContent).toMatchObject({ unresolvedIdentifiers: [HOSTILE, LONG] });
    expect(noticeOf(result)).toBe(
      `2 of 3 identifier(s) did not resolve to a CID: ${HOSTILE_FRAMED}, ${LONG_ECHO}. Verify spelling and that identifierType="name" matches the identifier form (name/smiles/inchi/inchikey).`,
    );
    const text = textOf(result);
    expect(text).toContain(`> ${noticeOf(result)}`);
    expect(text).not.toMatch(/^# INJECTED/m);
  });

  it('frames and cuts rejected identifiers in the notice', async () => {
    routeIdentifiers({ CCO: [702], [HOSTILE]: unreadable, [LONG]: unreadable });

    const result = await runToolContract(searchCompounds, smilesBatch(['CCO', HOSTILE, LONG]));

    expect(result.structuredContent).toMatchObject({ unresolvedIdentifiers: [HOSTILE, LONG] });
    expect(noticeOf(result)).toBe(
      `PubChem could not interpret 2 of 3 identifier(s) as SMILES: ${HOSTILE_FRAMED}, ${LONG_ECHO}. Check the SMILES syntax (balanced ring closures and parentheses, valid element symbols) and remove any "*" wildcard atoms.`,
    );
    const text = textOf(result);
    expect(text).toContain(`> ${noticeOf(result)}`);
    expect(text).not.toMatch(/^# INJECTED/m);
  });

  it('frames and cuts identifiers in the identifier_rejected message', async () => {
    routeIdentifiers({ [HOSTILE]: unreadable, [LONG]: unreadable });

    const result = await runToolContract(searchCompounds, smilesBatch([HOSTILE, LONG]));

    const error = errorOf(result);
    expect(error.data?.reason).toBe('identifier_rejected');
    expect(error.message).toBe(
      `PubChem could not interpret any of the 2 identifier(s) as SMILES: ${HOSTILE_FRAMED}, ${LONG_ECHO}.`,
    );
    expect(textOf(result)).not.toMatch(/^# INJECTED/m);
  });

  it('frames and cuts every identifier the collision notice names, keeping the row echo as sent', async () => {
    routeIdentifiers({ [HOSTILE]: [702], [LONG]: [702], plain: [702] });

    const result = await runToolContract(searchCompounds, nameBatch([HOSTILE, LONG, 'plain']));

    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 702, identifier: HOSTILE }],
    });
    expect(noticeOf(result)).toBe(
      `identifiers[0] "${HOSTILE_FRAMED}", identifiers[1] "${LONG_ECHO}", identifiers[2] "plain" all resolved to CID 702; the result row echoes only identifiers[0] for it.`,
    );
    expect(textOf(result)).not.toMatch(/^# INJECTED/m);
  });

  it('names an ordinary collision by input position, skipping inputs that went elsewhere', async () => {
    routeIdentifiers({ ethanol: [702], aspirin: [2244], alcohol: [702] });

    const result = await runToolContract(
      searchCompounds,
      nameBatch(['ethanol', 'aspirin', 'alcohol']),
    );

    expect(noticeOf(result)).toBe(
      'identifiers[0] "ethanol", identifiers[2] "alcohol" all resolved to CID 702; the result row echoes only identifiers[0] for it.',
    );
    expect(textOf(result)).toContain(noticeOf(result));
  });

  it('tells apart two long colliders whose cut echoes are identical by their positions', async () => {
    const LONG_180 = 'n'.repeat(180);
    const LONG_180_BROKEN = `${LONG_180}\n`;
    routeIdentifiers({ aspirin: [2244], [LONG_180]: [702], [LONG_180_BROKEN]: [702] });

    const result = await runToolContract(
      searchCompounds,
      nameBatch(['aspirin', LONG_180, LONG_180_BROKEN]),
    );

    expect(result.structuredContent).toMatchObject({
      results: [
        { cid: 2244, identifier: 'aspirin' },
        { cid: 702, identifier: LONG_180 },
      ],
    });
    const notice = `identifiers[1] "${LONG_ECHO}", identifiers[2] "${LONG_ECHO}" all resolved to CID 702; the result row echoes only identifiers[1] for it.`;
    expect(noticeOf(result)).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });
});

describe('identifier batch — full InChI strings (#80)', () => {
  const ASPIRIN = 'InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)';
  const ASPIRIN_NONSTANDARD = 'InChI=1/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)';
  const ASPIRIN_PADDED = `  ${ASPIRIN}  `;
  const ASPIRIN_LOWER = ASPIRIN.toLowerCase();
  const ASPIRIN_TRUNCATED = ASPIRIN.slice(0, -1);
  /** n-C123H248: a valid InChI PubChem has no record for, answered with CID 0. */
  const ALKANE_C123 = `InChI=1S/C123H248/c${[
    ...Array.from({ length: 62 }, (_, i) => 1 + 2 * i),
    ...Array.from({ length: 61 }, (_, i) => 122 - 2 * i),
  ].join('-')}/h3-123H2,1-2H3`;
  const INCHI_GUIDANCE =
    'Pass the complete InChI string starting with "InChI=" ("InChI=1S/" standard, "InChI=1/" non-standard), with its case kept as written.';

  function inchiBatch(identifiers: string[]) {
    return { searchType: 'identifier' as const, identifierType: 'inchi' as const, identifiers };
  }

  /** The `inchi` form field of every InChI lookup, in request order. */
  const inchiBodies = () =>
    fetchMock.mock.calls
      .filter(([input]) => String(input) === `${PUG}/compound/inchi/cids/JSON`)
      .map(([, init]) => {
        expect(init?.method).toBe('POST');
        return new URLSearchParams(String(init?.body)).get('inchi');
      });

  it('resolves a standard InChI to CID 2244, echoing it verbatim', async () => {
    routeIdentifiers({ [ASPIRIN]: [2244] });

    const result = await runToolContract(searchCompounds, inchiBatch([ASPIRIN]));

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: ASPIRIN }],
      totalFound: 1,
    });
    expect(result.structuredContent).not.toHaveProperty('unresolvedIdentifiers');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).toContain(`CIDs: 2244 (${ASPIRIN})`);
    expect(inchiBodies()).toEqual([ASPIRIN]);
  });

  it('sends a non-standard and a space-padded InChI byte for byte, and both resolve', async () => {
    routeIdentifiers({ [ASPIRIN_NONSTANDARD]: [2244], [ASPIRIN_PADDED]: [2244] });

    const result = await runToolContract(
      searchCompounds,
      inchiBatch([ASPIRIN_NONSTANDARD, ASPIRIN_PADDED]),
    );

    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: ASPIRIN_NONSTANDARD }],
    });
    expect(result.structuredContent).not.toHaveProperty('unresolvedIdentifiers');
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `identifiers[0] "${ASPIRIN_NONSTANDARD}", identifiers[1] "${ASPIRIN}" all resolved to CID 2244; the result row echoes only identifiers[0] for it.`,
    );
    expect(inchiBodies()).toEqual([ASPIRIN_NONSTANDARD, ASPIRIN_PADDED]);
  });

  it('lists a lowercased or truncated InChI as unresolved with the InChI guidance, keeping its case', async () => {
    routeIdentifiers({
      [ASPIRIN]: [2244],
      [ASPIRIN_LOWER]: unreadable,
      [ASPIRIN_TRUNCATED]: unreadable,
    });

    const result = await runToolContract(
      searchCompounds,
      inchiBatch([ASPIRIN, ASPIRIN_LOWER, ASPIRIN_TRUNCATED]),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: ASPIRIN }],
      unresolvedIdentifiers: [ASPIRIN_LOWER, ASPIRIN_TRUNCATED],
    });
    const notice = `PubChem could not interpret 2 of 3 identifier(s) as InChI strings: ${ASPIRIN_LOWER}, ${ASPIRIN_TRUNCATED}. ${INCHI_GUIDANCE}`;
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain(notice);
    expect(text).toContain(`Unresolved identifiers (2): ${ASPIRIN_LOWER}, ${ASPIRIN_TRUNCATED}`);
    // No case normalization: the lowercased string went upstream as written.
    expect(inchiBodies()).toEqual([ASPIRIN, ASPIRIN_LOWER, ASPIRIN_TRUNCATED]);
  });

  it('fails a batch where every InChI is rejected as identifier_rejected', async () => {
    routeIdentifiers({ [ASPIRIN_LOWER]: unreadable, aspirin: unreadable });

    const result = await runToolContract(searchCompounds, inchiBatch([ASPIRIN_LOWER, 'aspirin']));

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('identifier_rejected');
    expect(error.data?.fault).toBe(`${unreadable.code}: ${unreadable.message}`);
    expect(error.message).toBe(
      `PubChem could not interpret any of the 2 identifier(s) as InChI strings: ${ASPIRIN_LOWER}, aspirin.`,
    );
    expect(error.data?.recovery?.hint).toContain(
      'for InChI, the complete string starting with "InChI=", case kept as written',
    );
    expect(textOf(result)).toMatch(/Recovery: .*for InChI/);
    expect(requestsFor(ASPIRIN_LOWER)).toBe(1);
    expect(requestsFor('aspirin')).toBe(1);
  });

  it('reports a valid InChI PubChem answers with CID 0 as unresolved, cut in the notice and whole elsewhere', async () => {
    routeIdentifiers({ [ASPIRIN]: [2244], [ALKANE_C123]: [0] });

    const result = await runToolContract(searchCompounds, inchiBatch([ASPIRIN, ALKANE_C123]));

    expect(ALKANE_C123.length).toBeGreaterThan(100);
    expect(result.structuredContent).toMatchObject({
      results: [{ cid: 2244, identifier: ASPIRIN }],
      unresolvedIdentifiers: [ALKANE_C123],
      totalFound: 1,
    });
    const notice = `1 of 2 identifier(s) did not resolve to a CID: ${ALKANE_C123.slice(0, 100)}…. Verify spelling and that identifierType="inchi" matches the identifier form (name/smiles/inchi/inchikey).`;
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain(notice);
    expect(text).toContain(`Unresolved identifiers (1): ${ALKANE_C123}`);
    expect(text).not.toMatch(/CIDs: [^\n]*\b0\b/);
    expect(inchiBodies()).toEqual([ASPIRIN, ALKANE_C123]);
  });
});
