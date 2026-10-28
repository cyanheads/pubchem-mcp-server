/**
 * @fileoverview Wire-level contract tests for pubchem_get_summary identifier handling (#66):
 * comma splitting, trimming, numeric-form validation, the over-cap `unprocessed` list, and
 * the request paths PubChem receives. Runs the real handler and the real PubChemClient
 * against a stubbed `fetch` that answers the way PubChem does — a comma in the ID segment,
 * raw or `%2C`, is a list separator and returns one summary per listed ID — so a split that
 * fails to happen shows up as a dropped or misattributed row.
 * @module tests/mcp-server/tools/definitions/get-summary-contract.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSummary } from '@/mcp-server/tools/definitions/get-summary.tool.js';
import { initPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { readBlockquotes, readCommonMark } from '../../../helpers/commonmark.js';

const fetchMock = vi.fn<typeof fetch>();

/** Per-type route shape and the records the stub knows, keyed by canonical ID. */
const ROUTES = {
  assay: {
    segment: /^\/rest\/pug\/assay\/aid\/([^/]*)\/summary\/JSON$/,
    envelope: ['AssaySummaries', 'AssaySummary'],
    numeric: 'AID',
    missing: 'No live AIDs in the supplied AID list',
    records: new Map<string, Record<string, unknown>>([
      ['1000', { AID: 1000, Name: 'Mevalonate kinase inhibitors' }],
      ['1001', { AID: 1001, Name: 'Second assay' }],
    ]),
  },
  gene: {
    segment: /^\/rest\/pug\/gene\/geneid\/([^/]*)\/summary\/JSON$/,
    envelope: ['GeneSummaries', 'GeneSummary'],
    numeric: 'GeneID',
    missing: 'No live GeneIDs in the supplied GeneID list',
    records: new Map<string, Record<string, unknown>>([
      ['1956', { GeneID: 1956, Symbol: 'EGFR', Name: 'epidermal growth factor receptor' }],
      ['2064', { GeneID: 2064, Symbol: 'ERBB2', Name: 'erb-b2 receptor tyrosine kinase 2' }],
    ]),
  },
  taxonomy: {
    segment: /^\/rest\/pug\/taxonomy\/taxid\/([^/]*)\/summary\/JSON$/,
    envelope: ['TaxonomySummaries', 'TaxonomySummary'],
    numeric: 'TaxonomyID',
    missing: 'No live TaxonomyIDs in the supplied TaxonomyID list',
    records: new Map<string, Record<string, unknown>>([
      ['9606', { TaxonomyID: 9606, ScientificName: 'Homo sapiens' }],
      ['10090', { TaxonomyID: 10090, ScientificName: 'Mus musculus' }],
    ]),
  },
  protein: {
    segment: /^\/rest\/pug\/protein\/accession\/([^/]*)\/summary\/JSON$/,
    envelope: ['ProteinSummaries', 'ProteinSummary'],
    numeric: undefined,
    missing: 'No `summary` data found with the given ProteinAccession(s)',
    records: new Map<string, Record<string, unknown>>([
      ['P00533', { ProteinAccession: 'P00533', Name: 'Epidermal growth factor receptor' }],
      ['P04626', { ProteinAccession: 'P04626', Name: 'Receptor tyrosine-protein kinase erbB-2' }],
      ['Q9BYF1', { ProteinAccession: 'Q9BYF1', Name: 'Angiotensin-converting enzyme 2' }],
    ]),
  },
} as const;

function fault(status: number, message: string): Response {
  return Response.json({ Fault: { Code: 'PUGREST.Fault', Message: message } }, { status });
}

/** Answers summary requests the way PubChem does: the ID segment is a comma list (`,` or
 * `%2C`), leading zeros resolve, a non-digit numeric piece is HTTP 400, and an all-unknown
 * list is HTTP 404. */
const pubchemSummaries: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov') throw new Error('unmocked fetch');
  for (const route of Object.values(ROUTES)) {
    const match = route.segment.exec(url.pathname);
    if (!match) continue;
    const pieces = decodeURIComponent(match[1] ?? '')
      .split(',')
      .filter((p) => p.length > 0);
    if (route.numeric && !pieces.every((p) => /^\d+$/.test(p))) {
      return fault(400, `Missing ${route.numeric} list`);
    }
    const found = pieces
      .map((p) => route.records.get(route.numeric ? String(Number(p)) : p))
      .filter((r) => r !== undefined);
    if (found.length === 0) return fault(404, route.missing);
    const [outer, inner] = route.envelope;
    return Response.json({ [outer]: { [inner]: found } });
  }
  throw new Error('unmocked fetch');
};

/** Arguments as a client puts them on the wire — numbers included — before the framework's
 * repair and the schema see them. */
const wire = (args: Record<string, unknown>) => args as z.input<typeof getSummary.input>;

type Row = { identifier: string | number; found: boolean; invalid?: boolean };
type Result = Awaited<ReturnType<typeof runToolContract>>;

function rowsOf(result: Result): Row[] {
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { summaries: Row[] }).summaries.map(
    ({ identifier, found, invalid }) =>
      invalid === undefined ? { identifier, found } : { identifier, found, invalid },
  );
}

function textOf(result: Result): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Pathnames of every request the stub received, in order. */
function requestedPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

/** The raw (still percent-encoded) URL of every request — `pathname` would hide nothing here,
 * but the raw string is what PubChem parses. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
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

describe('pubchem_get_summary comma-joined identifiers (#66)', () => {
  it.each([
    ['assay', '1000,1001', [1000, 1001]],
    ['gene', '1956,2064', [1956, 2064]],
    ['taxonomy', '9606,10090', [9606, 10090]],
  ] as const)(
    '%s ["%s"] → one found row per piece, requestedCount 2',
    async (entityType, joined, ids) => {
      fetchMock.mockImplementation(pubchemSummaries);

      const result = await runToolContract(getSummary, { entityType, identifiers: [joined] });

      expect(rowsOf(result)).toEqual(ids.map((identifier) => ({ identifier, found: true })));
      expect(result.structuredContent).toMatchObject({ requestedCount: 2, foundCount: 2 });
      // One request per piece, none carrying the list separator.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const url of requestedUrls()) expect(url).not.toMatch(/,|%2C/i);
      const text = textOf(result);
      for (const id of ids) expect(text).toContain(`identifier: ${id}, found`);
    },
  );

  it('does not attribute a found AID to a nonexistent one joined before it', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: ['99999999,1000'],
    });

    expect(rowsOf(result)).toEqual([
      { identifier: 99999999, found: false },
      { identifier: 1000, found: true },
    ]);
    const summaries = (
      result.structuredContent as { summaries: Array<{ data?: { aid?: number } }> }
    ).summaries;
    expect(summaries[1]?.data?.aid).toBe(1000);
    expect(summaries[0]?.data).toBeUndefined();
  });

  it('splits a comma-joined protein accession list and sends neither "," nor "%2C"', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'protein',
      identifiers: ['P00533,P04626'],
    });

    expect(rowsOf(result)).toEqual([
      { identifier: 'P00533', found: true },
      { identifier: 'P04626', found: true },
    ]);
    expect(requestedPaths()).toEqual([
      '/rest/pug/protein/accession/P00533/summary/JSON',
      '/rest/pug/protein/accession/P04626/summary/JSON',
    ]);
    for (const url of requestedUrls()) expect(url).not.toMatch(/,|%2C/i);
  });
});

describe('pubchem_get_summary numeric identifier normalization (#66)', () => {
  it.each([['1000,'], [' 1000 '], ['01000']])(
    '["%s"] → one row, identifier 1000, found',
    async (raw) => {
      fetchMock.mockImplementation(pubchemSummaries);

      const result = await runToolContract(getSummary, { entityType: 'assay', identifiers: [raw] });

      expect(rowsOf(result)).toEqual([{ identifier: 1000, found: true }]);
      expect(requestedPaths()).toEqual(['/rest/pug/assay/aid/1000/summary/JSON']);
      expect(result.structuredContent).toMatchObject({ requestedCount: 1, foundCount: 1 });
    },
  );

  it('keeps an integer identifier working through the framework repair: [1000]', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(
      getSummary,
      wire({ entityType: 'assay', identifiers: [1000] }),
    );

    expect(rowsOf(result)).toEqual([{ identifier: 1000, found: true }]);
    expect(requestedPaths()).toEqual(['/rest/pug/assay/aid/1000/summary/JSON']);
  });

  it.each([
    'AID1000',
    '1000 1001',
    '1000+1001',
    '1000;1001',
    '1000/1001',
    '1000?x',
    '1000#x',
    '-5',
    '0',
    '2.5',
  ])('marks "%s" invalid, names it in the notice, and sends no request for it', async (bad) => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: ['1000', bad],
    });

    expect(rowsOf(result)).toEqual([
      { identifier: 1000, found: true },
      { identifier: bad, found: false, invalid: true },
    ]);
    expect(requestedPaths()).toEqual(['/rest/pug/assay/aid/1000/summary/JSON']);
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain(bad);
    expect(notice).toMatch(/positive integer AID/);
    const text = textOf(result);
    expect(text).toContain('invalid');
    expect(text).toContain(notice);
  });

  it('marks an all-digit piece past Number.MAX_SAFE_INTEGER invalid instead of rounding it', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'gene',
      identifiers: ['1956', '9007199254740993'],
    });

    expect(rowsOf(result)).toEqual([
      { identifier: 1956, found: true },
      { identifier: '9007199254740993', found: false, invalid: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the expected form per numeric entityType in the notice', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const gene = await runToolContract(getSummary, {
      entityType: 'gene',
      identifiers: ['1956', 'EGFR'],
    });
    expect((gene.structuredContent as { notice?: string }).notice).toMatch(
      /"EGFR".*positive integer NCBI Gene ID/,
    );

    const taxonomy = await runToolContract(getSummary, {
      entityType: 'taxonomy',
      identifiers: ['9606', 'human'],
    });
    expect((taxonomy.structuredContent as { notice?: string }).notice).toMatch(
      /"human".*positive integer NCBI Taxonomy ID/,
    );
  });

  it.each(['assay', 'gene', 'taxonomy', 'protein'] as const)(
    '%s: a call whose pieces are all blank fails as invalid_identifier before any request',
    async (entityType) => {
      for (const identifiers of [[''], [','], [' , ,']]) {
        const result = await runToolContract(getSummary, { entityType, identifiers });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: { code: number; data?: { reason?: string } };
        };
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data?.reason).toBe('invalid_identifier');
        expect(textOf(result)).toContain('invalid_identifier');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['assay', 'gene', 'taxonomy'] as const)(
    '%s: a call whose pieces are all malformed fails as invalid_identifier, naming them',
    async (entityType) => {
      const result = await runToolContract(getSummary, {
        entityType,
        identifiers: ['AID1000', '1000 1001'],
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data?: { reason?: string } };
      };
      expect(error.data?.reason).toBe('invalid_identifier');
      expect(error.message).toContain('AID1000');
      expect(error.message).toContain('1000 1001');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([[1000.5], [Number.MAX_SAFE_INTEGER + 2]])(
    'rejects the number %d at the schema',
    async (value) => {
      const result = await runToolContract(
        getSummary,
        wire({ entityType: 'assay', identifiers: [value] }),
      );

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: number } };
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('pubchem_get_summary numeric identifiers above 2147483647 (#74)', () => {
  const FIRST_KNOWN = { assay: '1000', gene: '1956', taxonomy: '9606' } as const;
  const ID_FORM = {
    assay: 'positive integer AID up to 2147483647',
    gene: 'positive integer NCBI Gene ID up to 2147483647',
    taxonomy: 'positive integer NCBI Taxonomy ID up to 2147483647',
  } as const;

  it.each([
    ['assay', '4294968296'],
    ['assay', '2147483648'],
    ['gene', '4294968296'],
    ['gene', '2147483648'],
    ['taxonomy', '4294968296'],
    ['taxonomy', '2147483648'],
  ] as const)('%s: marks %s invalid and sends no request for it', async (entityType, big) => {
    fetchMock.mockImplementation(pubchemSummaries);
    const known = FIRST_KNOWN[entityType];

    const result = await runToolContract(getSummary, { entityType, identifiers: [known, big] });

    expect(rowsOf(result)).toEqual([
      { identifier: Number(known), found: true },
      { identifier: big, found: false, invalid: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedPaths().some((p) => p.includes(big))).toBe(false);
    const notice = `Not looked up (1 invalid): "${big}" — each ${entityType} identifier must be a ${ID_FORM[entityType]}.`;
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });

  it.each(['assay', 'gene', 'taxonomy'] as const)(
    '%s: still looks up 2147483647',
    async (entityType) => {
      fetchMock.mockImplementation(pubchemSummaries);

      const result = await runToolContract(getSummary, {
        entityType,
        identifiers: ['2147483647'],
      });

      expect(rowsOf(result)).toEqual([{ identifier: 2147483647, found: false }]);
      expect(requestedPaths()).toHaveLength(1);
      expect(requestedPaths()[0]).toContain('/2147483647/summary/JSON');
    },
  );

  it('splits ["1000,4294968296"] into AID 1000 found and an invalid row', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: ['1000,4294968296'],
    });

    expect(rowsOf(result)).toEqual([
      { identifier: 1000, found: true },
      { identifier: '4294968296', found: false, invalid: true },
    ]);
    expect(requestedPaths()).toEqual(['/rest/pug/assay/aid/1000/summary/JSON']);
  });

  it.each(['assay', 'gene', 'taxonomy'] as const)(
    '%s: a call whose every piece is out of range fails as invalid_identifier, as ["abc"] does',
    async (entityType) => {
      fetchMock.mockImplementation(pubchemSummaries);

      for (const identifiers of [['4294968296'], ['2147483648, 9999999999'], ['abc']]) {
        const result = await runToolContract(getSummary, { entityType, identifiers });

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: { code: number; message: string; data?: { reason?: string } };
        };
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data?.reason).toBe('invalid_identifier');
        expect(error.message).toContain(`"${identifiers[0]?.split(',')[0]}"`);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('pubchem_get_summary keeps caller text in the notice and error message (#74)', () => {
  const HOSTILE = 'x1 **b** `c`\n# INJECTED';
  const LONG = 'y'.repeat(500);

  it('keeps and cuts invalid pieces in the Not-looked-up notice, keeping each identifier as sent', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'gene',
      identifiers: ['1956', HOSTILE, LONG],
    });

    expect(rowsOf(result)).toEqual([
      { identifier: 1956, found: true },
      { identifier: HOSTILE, found: false, invalid: true },
      { identifier: LONG, found: false, invalid: true },
    ]);
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      `Not looked up (2 invalid): "${HOSTILE}", "${'y'.repeat(100)}…" — each gene identifier must be a positive integer NCBI Gene ID up to 2147483647.`,
    );
    const text = textOf(result);
    expect(readBlockquotes(text).at(-1)).toBe(notice);
    // format() opens with its own "Gene Summaries" heading; the caller text forms none.
    expect(readCommonMark(text)).not.toMatch(/⟨heading_open⟩\n\n[^⟨]*INJECTED/);
  });

  it('keeps and cuts the pieces an invalid_identifier message names', async () => {
    const result = await runToolContract(getSummary, {
      entityType: 'taxonomy',
      identifiers: [HOSTILE, LONG],
    });

    const { error } = result.structuredContent as { error: { message: string } };
    expect(error.message).toBe(
      `No taxonomy identifier is a positive integer NCBI Taxonomy ID up to 2147483647: "${HOSTILE}", "${'y'.repeat(100)}…".`,
    );
    const read = readCommonMark(textOf(result));
    expect(read).toContain(`Error: ${error.message}`);
    expect(read).not.toContain('⟨heading_open⟩');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pubchem_get_summary over-cap split (#66 with the per-call cap of 10)', () => {
  it('serves the first 10 pieces of a split and returns the rest as unprocessed, in input order', async () => {
    fetchMock.mockImplementation(pubchemSummaries);
    const pieces = Array.from({ length: 13 }, (_, i) => String(2000 + i));

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: [pieces.slice(0, 7).join(','), pieces.slice(7).join(', ')],
    });

    const rows = rowsOf(result);
    expect(rows.map((r) => r.identifier)).toEqual(pieces.slice(0, 10).map(Number));
    expect(result.structuredContent).toMatchObject({
      unprocessed: ['2010', '2011', '2012'],
      requestedCount: 13,
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // The cap is disclosed once, in cappedInputs (#70), in the wording every capped tool uses.
    expect(result.structuredContent).toMatchObject({
      cappedInputs: [{ input: 'identifiers', requested: 13, served: 10, unprocessed: 3 }],
    });
    const text = textOf(result);
    expect(text).toContain('2010, 2011, 2012');
    expect(text).toContain(
      'identifiers: requested 13, served 10 (the per-call cap); the remaining 3 are listed in unprocessed',
    );
  });

  it('serves exactly 10 pieces with no unprocessed list or cap notice', async () => {
    fetchMock.mockImplementation(pubchemSummaries);
    const pieces = ['1000', '1001', ...Array.from({ length: 8 }, () => '1000')];

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: [pieces.join(',')],
    });

    expect(rowsOf(result)).toHaveLength(10);
    expect(result.structuredContent).not.toHaveProperty('unprocessed');
    expect(result.structuredContent).not.toHaveProperty('cappedInputs');
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('accepts a split of exactly 1000 pieces, returning 990 unprocessed', async () => {
    fetchMock.mockImplementation(pubchemSummaries);
    const pieces = Array.from({ length: 1000 }, (_, i) => String(3000 + i));

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: [pieces.join(',')],
    });

    expect(rowsOf(result)).toHaveLength(10);
    expect((result.structuredContent as { unprocessed: string[] }).unprocessed).toHaveLength(990);
  });

  it('fails a split past 1000 pieces as too_many_identifiers, naming the ceiling, before any request', async () => {
    const pieces = Array.from({ length: 100_000 }, (_, i) => String(i + 1));

    const result = await runToolContract(getSummary, {
      entityType: 'assay',
      identifiers: [pieces.join(',')],
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: {
        code: number;
        message: string;
        data?: { reason?: string; recovery?: { hint?: string } };
      };
    };
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('too_many_identifiers');
    expect(error.message).toBe(
      '100000 identifier pieces after comma splitting exceed the ceiling of 1000 per call.',
    );
    expect(error.data?.recovery?.hint).toMatch(/at most 10 identifier pieces per call/);
    const text = textOf(result);
    expect(text).toContain(error.message);
    expect(text).toContain(error.data?.recovery?.hint);
    expect(text.length).toBeLessThan(2_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pubchem_get_summary invalid_identifier names a bounded list', () => {
  it('names the first 10 malformed pieces and counts the rest', async () => {
    const pieces = Array.from({ length: 25 }, (_, i) => `x${i + 1}`);

    const result = await runToolContract(getSummary, {
      entityType: 'gene',
      identifiers: [pieces.join(',')],
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { message: string; data?: { reason?: string } };
    };
    expect(error.data?.reason).toBe('invalid_identifier');
    expect(error.message).toBe(
      `No gene identifier is a positive integer NCBI Gene ID up to 2147483647: ${pieces
        .slice(0, 10)
        .map((p) => `"${p}"`)
        .join(', ')}, and 15 more.`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names every piece when there are 10 or fewer', async () => {
    const result = await runToolContract(getSummary, {
      entityType: 'gene',
      identifiers: ['x1,x2'],
    });

    const { error } = result.structuredContent as { error: { message: string } };
    expect(error.message).toBe(
      'No gene identifier is a positive integer NCBI Gene ID up to 2147483647: "x1", "x2".',
    );
  });
});

describe('pubchem_get_summary protein pass-through (#66 regression)', () => {
  it.each(['P00533', 'Q9BYF1'])('["%s"] resolves unchanged', async (accession) => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'protein',
      identifiers: [accession],
    });

    expect(rowsOf(result)).toEqual([{ identifier: accession, found: true }]);
    expect(requestedPaths()).toEqual([`/rest/pug/protein/accession/${accession}/summary/JSON`]);
  });

  it('sends a protein string with no comma trimmed and otherwise as sent', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'protein',
      identifiers: ['  NP_005219.2 '],
    });

    expect(rowsOf(result)).toEqual([{ identifier: 'NP_005219.2', found: false }]);
    expect(requestedPaths()).toEqual(['/rest/pug/protein/accession/NP_005219.2/summary/JSON']);
  });
});

describe('pubchem_get_summary frames caller text in content[]', () => {
  it('renders a not-found protein identifier as inline data, not markdown', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'protein',
      identifiers: ['X1\n# INJECTED **BOLD**'],
    });

    expect(rowsOf(result)).toEqual([{ identifier: 'X1\n# INJECTED **BOLD**', found: false }]);
    const text = textOf(result);
    expect(text).toContain('**Identifier X1 # INJECTED \\*\\*BOLD\\*\\*** — not found');
    expect(text).not.toMatch(/^# INJECTED/m);
  });

  it('renders a found protein identifier as inline data', async () => {
    fetchMock.mockImplementation(pubchemSummaries);

    const result = await runToolContract(getSummary, {
      entityType: 'protein',
      identifiers: ['P00533'],
    });

    expect(textOf(result)).toContain('(identifier: P00533, found)');
  });
});

describe('pubchem_get_summary numCompounds pointer', () => {
  it('names activeOnly: false, since the assay search lists only actives by default', () => {
    const summaries = getSummary.output.shape.summaries.element.shape.data.unwrap();
    expect(summaries.shape.numCompounds.description).toMatch(
      /searchType "assay" and activeOnly: false/,
    );
  });
});
