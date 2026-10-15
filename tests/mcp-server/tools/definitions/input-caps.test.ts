/**
 * @fileoverview Over-cap read inputs (#70). Every read-side workload input keeps its per-call
 * cap but accepts values up to the 1000 ceiling: the handler serves the cap, an ID batch
 * returns the rest as `unprocessed` in input order, and `cappedInputs` discloses the clamp on
 * both surfaces. Values at or under the cap behave as before, and values past the ceiling
 * still fail at the schema. Runs the real schema, handler, enrichment, and format() through
 * `runToolContract`, with the PubChem client stubbed at its method boundary.
 * @module tests/mcp-server/tools/definitions/input-caps.test
 */

import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBioactivity } from '@/mcp-server/tools/definitions/get-bioactivity.tool.js';
import { getCompoundDetails } from '@/mcp-server/tools/definitions/get-compound-details.tool.js';
import { getCompoundInteractions } from '@/mcp-server/tools/definitions/get-compound-interactions.tool.js';
import { getCompoundSafety } from '@/mcp-server/tools/definitions/get-compound-safety.tool.js';
import { getCompoundXrefs } from '@/mcp-server/tools/definitions/get-compound-xrefs.tool.js';
import { getSummary } from '@/mcp-server/tools/definitions/get-summary.tool.js';
import { searchAssays } from '@/mcp-server/tools/definitions/search-assays.tool.js';
import { searchCompounds } from '@/mcp-server/tools/definitions/search-compounds.tool.js';

const mockClient = {
  getAssayCidPage: vi.fn(),
  getAssaySummary: vi.fn(),
  getClassification: vi.fn(),
  getDescription: vi.fn(),
  getEntitySummary: vi.fn(),
  getInteractions: vi.fn(),
  getProperties: vi.fn(),
  getSafetyData: vi.fn(),
  getSynonyms: vi.fn(),
  getXrefs: vi.fn(),
  searchAssaysByTarget: vi.fn(),
  searchByFormula: vi.fn(),
  searchByInchiKey: vi.fn(),
  searchByName: vi.fn(),
  searchBySmiles: vi.fn(),
  searchByStructure: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
  for (const fn of Object.values(mockClient)) {
    fn.mockRejectedValue(new Error('unmocked client call'));
  }
});

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Structured = Record<string, unknown> & {
  cappedInputs?: Array<{ input: string; requested: number; served: number; unprocessed?: number }>;
  unprocessed?: unknown[];
};

const range = (n: number, start = 1) => Array.from({ length: n }, (_, i) => start + i);

function structured(result: Result): Structured {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Structured;
}

function textOf(result: Result): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function expectSchemaRejection(result: Result): void {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as { error: { code: number } };
  expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
}

// ── Page sizes ───────────────────────────────────────────────────────────────

interface PageSizeCase {
  cap: number;
  field: string;
  name: string;
  /** Runs the tool with `field` set to `value` after stubbing a result set larger than the cap. */
  run: (value: number) => Promise<Result>;
  /** Items the call served, read from structuredContent. */
  served: (sc: Structured) => number;
}

const pageSizeCases: PageSizeCase[] = [
  {
    name: 'pubchem_search_assays',
    field: 'maxResults',
    cap: 200,
    run: (value) => {
      mockClient.searchAssaysByTarget.mockResolvedValue(range(1500));
      return runToolContract(searchAssays, {
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        maxResults: value,
      });
    },
    served: (sc) => (sc.aids as number[]).length,
  },
  {
    name: 'pubchem_search_compounds',
    field: 'maxResults',
    cap: 200,
    run: (value) => {
      mockClient.searchByFormula.mockImplementation(
        async (_f: string, _o: boolean, recordCap: number) => range(Math.min(recordCap, 1500)),
      );
      return runToolContract(searchCompounds, {
        searchType: 'formula',
        formula: 'C6H12O6',
        maxResults: value,
      });
    },
    served: (sc) => (sc.results as unknown[]).length,
  },
  {
    name: 'pubchem_get_bioactivity',
    field: 'maxResults',
    cap: 100,
    run: (value) => {
      mockClient.getAssaySummary.mockResolvedValue({
        rows: range(1500).map((aid) => ({
          aid,
          assayName: `Assay ${aid}`,
          outcome: 'Active',
          activityValues: [],
        })),
        targetGroups: [],
      });
      return runToolContract(getBioactivity, { cid: 2244, maxResults: value });
    },
    served: (sc) => (sc.results as unknown[]).length,
  },
  {
    name: 'pubchem_get_compound_xrefs',
    field: 'maxPerType',
    cap: 500,
    run: (value) => {
      mockClient.getXrefs.mockResolvedValue(range(1500));
      return runToolContract(getCompoundXrefs, {
        cid: 2244,
        xrefTypes: ['PubMedID'],
        maxPerType: value,
      });
    },
    served: (sc) => (sc.xrefs as Array<{ ids: unknown[] }>)[0]?.ids.length ?? 0,
  },
  {
    name: 'pubchem_get_compound_interactions',
    field: 'maxEntries',
    cap: 50,
    run: (value) => {
      mockClient.getInteractions.mockImplementation(
        async (_cid: number, _kinds: string[], maxEntries: number) => ({
          entries: range(maxEntries).map((i) => ({
            kind: 'drug-food',
            source: 'Drugs.com',
            text: `Interaction ${i}`,
          })),
          pages: [
            {
              kind: 'drug-food',
              recordsConsumed: maxEntries,
              returnedCount: maxEntries,
              totalRecords: 1500,
            },
          ],
          failedKinds: [],
        }),
      );
      return runToolContract(getCompoundInteractions, {
        cid: 2244,
        kinds: ['drug-food'],
        maxEntries: value,
      });
    },
    served: (sc) => (sc.entries as unknown[]).length,
  },
  {
    name: 'pubchem_get_compound_details',
    field: 'maxSynonyms',
    cap: 100,
    run: (value) => {
      mockClient.getProperties.mockResolvedValue([{ CID: 2244, MolecularWeight: '180.16' }]);
      mockClient.getSynonyms.mockResolvedValue(range(1500).map((i) => `Synonym ${i}`));
      return runToolContract(getCompoundDetails, {
        cids: [2244],
        includeSynonyms: true,
        maxSynonyms: value,
      });
    },
    served: (sc) => (sc.compounds as Array<{ synonyms: unknown[] }>)[0]?.synonyms.length ?? 0,
  },
  {
    name: 'pubchem_get_compound_details',
    field: 'maxDescriptions',
    cap: 20,
    run: (value) => {
      mockClient.getProperties.mockResolvedValue([{ CID: 2244, MolecularWeight: '180.16' }]);
      mockClient.getDescription.mockResolvedValue(
        range(1500).map((i) => ({ source: 'Depositor', text: `Description ${i}` })),
      );
      return runToolContract(getCompoundDetails, {
        cids: [2244],
        includeDescription: true,
        maxDescriptions: value,
      });
    },
    served: (sc) =>
      (sc.compounds as Array<{ descriptions: unknown[] }>)[0]?.descriptions.length ?? 0,
  },
];

describe.each(pageSizeCases)('$name $field (cap $cap)', ({ field, cap, run, served }) => {
  it('serves the cap at the cap, with no cappedInputs', async () => {
    const sc = structured(await run(cap));
    expect(served(sc)).toBe(cap);
    expect(sc).not.toHaveProperty('cappedInputs');
  });

  it.each([1, cap - 1])('serves %d as requested, with no cappedInputs', async (value) => {
    const sc = structured(await run(value));
    expect(served(sc)).toBe(value);
    expect(sc).not.toHaveProperty('cappedInputs');
  });

  it.each([cap + 1, 1000])(
    'serves the cap for %d and discloses it on both surfaces',
    async (value) => {
      const result = await run(value);
      const sc = structured(result);
      expect(served(sc)).toBe(cap);
      expect(sc.cappedInputs).toEqual([{ input: field, requested: value, served: cap }]);
      expect(textOf(result)).toContain(
        `${field}: requested ${value}, served ${cap} (the per-call cap).`,
      );
    },
  );

  it('still rejects a value past the 1000 ceiling at the schema', async () => {
    expectSchemaRejection(await run(1001));
  });
});

describe('page-size clamps reach every upstream read', () => {
  it('search_compounds asks a formula search for offset + cap + 1 records, never the raw value', async () => {
    mockClient.searchByFormula.mockResolvedValue(range(5));
    await runToolContract(searchCompounds, {
      searchType: 'formula',
      formula: 'C6H12O6',
      offset: 10,
      maxResults: 900,
    });
    expect(mockClient.searchByFormula).toHaveBeenCalledWith(
      'C6H12O6',
      false,
      211,
      expect.any(AbortSignal),
    );
  });

  it('search_compounds asks a structure search for offset + cap + 1 records', async () => {
    mockClient.searchByStructure.mockResolvedValue(range(5));
    await runToolContract(searchCompounds, {
      searchType: 'substructure',
      query: 'c1ccccc1',
      queryType: 'smiles',
      maxResults: 500,
    });
    expect(mockClient.searchByStructure).toHaveBeenCalledWith(
      'substructure',
      'c1ccccc1',
      'smiles',
      90,
      201,
      expect.any(AbortSignal),
    );
  });

  it('search_compounds asks an assay search for a page of the cap and pages on from it', async () => {
    mockClient.getAssayCidPage.mockResolvedValue({ cids: range(200), total: 1500 });
    const result = await runToolContract(searchCompounds, {
      searchType: 'assay',
      aid: 2551,
      maxResults: 700,
    });
    expect(mockClient.getAssayCidPage).toHaveBeenCalledWith(
      2551,
      true,
      0,
      200,
      expect.any(AbortSignal),
    );
    const sc = structured(result);
    expect(sc).toMatchObject({ totalFound: 1500, nextOffset: 200, shown: 200, cap: 200 });
    expect(sc.cappedInputs).toEqual([{ input: 'maxResults', requested: 700, served: 200 }]);
  });

  it('get_compound_interactions passes the cap to the client', async () => {
    await pageSizeCases.find((c) => c.field === 'maxEntries')?.run(400);
    expect(mockClient.getInteractions).toHaveBeenCalledWith(
      2244,
      ['drug-food'],
      50,
      0,
      expect.any(AbortSignal),
    );
  });

  it('search_assays reports the served size as the truncation cap and pages on from it', async () => {
    const sc = structured(await pageSizeCases[0]!.run(450));
    expect(sc).toMatchObject({ truncated: true, shown: 200, cap: 200, nextOffset: 200 });
  });

  it('search_assays pages a clamped size from a mid-list offset to the end', async () => {
    mockClient.searchAssaysByTarget.mockResolvedValue(range(450));
    const second = structured(
      await runToolContract(searchAssays, {
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        offset: 200,
        maxResults: 999,
      }),
    );
    expect(second.aids).toEqual(range(200, 201));
    expect(second.nextOffset).toBe(400);
    const last = structured(
      await runToolContract(searchAssays, {
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        offset: 400,
        maxResults: 999,
      }),
    );
    expect(last.aids).toEqual(range(50, 401));
    expect(last).not.toHaveProperty('nextOffset');
    expect(last.cappedInputs).toEqual([{ input: 'maxResults', requested: 999, served: 200 }]);
  });

  it.each([
    ['no match', [], 0, 'No assays found'],
    ['an offset past the end', [1, 2, 3], 10, 'offset 10 is past the 3 AID(s)'],
  ])(
    'search_assays keeps the clamp disclosure beside the %s notice',
    async (_l, aids, offset, notice) => {
      mockClient.searchAssaysByTarget.mockResolvedValue(aids);
      const result = await runToolContract(searchAssays, {
        targetType: 'genesymbol',
        targetQuery: 'EGFR',
        offset,
        maxResults: 500,
      });
      const sc = structured(result);
      expect(sc.aids).toEqual([]);
      expect(String(sc.notice)).toContain(notice);
      expect(sc.cappedInputs).toEqual([{ input: 'maxResults', requested: 500, served: 200 }]);
      const text = textOf(result);
      expect(text).toContain(notice);
      expect(text).toContain('maxResults: requested 500, served 200 (the per-call cap).');
    },
  );

  it('get_compound_details pages synonyms on from the served size', async () => {
    const sc = structured(await pageSizeCases.find((c) => c.field === 'maxSynonyms')!.run(300));
    expect(sc).toMatchObject({ nextSynonymOffset: 100, truncated: true });
  });

  it('get_compound_details reports both list clamps in one cappedInputs, in input order', async () => {
    mockClient.getProperties.mockResolvedValue([{ CID: 2244, MolecularWeight: '180.16' }]);
    mockClient.getSynonyms.mockResolvedValue(range(300).map((i) => `Synonym ${i}`));
    mockClient.getDescription.mockResolvedValue(range(30).map((i) => ({ text: `D${i}` })));
    const result = await runToolContract(getCompoundDetails, {
      cids: [2244],
      includeSynonyms: true,
      includeDescription: true,
      maxDescriptions: 25,
      maxSynonyms: 150,
    });
    const sc = structured(result);
    expect(sc.cappedInputs).toEqual([
      { input: 'maxDescriptions', requested: 25, served: 20 },
      { input: 'maxSynonyms', requested: 150, served: 100 },
    ]);
    const text = textOf(result);
    expect(text).toContain('maxDescriptions: requested 25, served 20 (the per-call cap).');
    expect(text).toContain('maxSynonyms: requested 150, served 100 (the per-call cap).');
  });
});

// ── ID batches ───────────────────────────────────────────────────────────────

describe('pubchem_get_compound_details cids (cap 100)', () => {
  beforeEach(() => {
    mockClient.getProperties.mockImplementation(async (cids: number[]) =>
      cids.map((CID) => ({ CID, MolecularWeight: '100' })),
    );
  });

  it('serves 100 CIDs with no unprocessed list or cappedInputs', async () => {
    const result = await runToolContract(getCompoundDetails, { cids: range(100) });
    const sc = structured(result);
    expect(sc.compounds).toHaveLength(100);
    expect(sc).not.toHaveProperty('unprocessed');
    expect(sc).not.toHaveProperty('cappedInputs');
    expect(sc.truncated).toBe(false);
  });

  it('fetches the first 100 CIDs and returns the rest as unprocessed, in input order', async () => {
    const cids = range(130, 1).reverse();
    const result = await runToolContract(getCompoundDetails, { cids });
    const sc = structured(result);

    expect(mockClient.getProperties).toHaveBeenCalledTimes(1);
    expect(mockClient.getProperties.mock.calls[0]?.[0]).toEqual(cids.slice(0, 100));
    expect((sc.compounds as Array<{ cid: number }>).map((c) => c.cid)).toEqual(cids.slice(0, 100));
    expect(sc.unprocessed).toEqual(cids.slice(100));
    expect(sc.truncated).toBe(true);
    expect(sc.cappedInputs).toEqual([
      { input: 'cids', requested: 130, served: 100, unprocessed: 30 },
    ]);
    const text = textOf(result);
    expect(text).toContain(
      'cids: requested 130, served 100 (the per-call cap); the remaining 30 are listed in unprocessed, in input order — pass them in a follow-up call.',
    );
    expect(text).toContain(
      `**Unprocessed (30, past the per-call cap):** ${cids.slice(100).join(', ')}`,
    );
  });

  it('accepts 1000 CIDs and rejects 1001 at the schema', async () => {
    const sc = structured(await runToolContract(getCompoundDetails, { cids: range(1000) }));
    expect(sc.unprocessed).toHaveLength(900);
    expectSchemaRejection(await runToolContract(getCompoundDetails, { cids: range(1001) }));
  });
});

describe('pubchem_get_compound_safety cids (cap 25)', () => {
  beforeEach(() => {
    mockClient.getSafetyData.mockResolvedValue({ status: 'no_ghs_data' });
  });

  it('serves 25 CIDs with no unprocessed list or cappedInputs', async () => {
    const sc = structured(await runToolContract(getCompoundSafety, { cids: range(25) }));
    expect(sc.results).toHaveLength(25);
    expect(sc).not.toHaveProperty('unprocessed');
    expect(sc).not.toHaveProperty('cappedInputs');
  });

  it('looks up the first 25 CIDs and returns the rest as unprocessed, in input order', async () => {
    const cids = [9, 8, 7, ...range(25, 100), 3];
    const result = await runToolContract(getCompoundSafety, { cids });
    const sc = structured(result);

    expect(mockClient.getSafetyData).toHaveBeenCalledTimes(25);
    expect(mockClient.getSafetyData.mock.calls.map(([cid]) => cid)).toEqual(cids.slice(0, 25));
    expect((sc.results as Array<{ cid: number }>).map((r) => r.cid)).toEqual(cids.slice(0, 25));
    expect(sc.unprocessed).toEqual([122, 123, 124, 3]);
    expect(sc.requestedCount).toBe(29);
    expect(sc.cappedInputs).toEqual([{ input: 'cids', requested: 29, served: 25, unprocessed: 4 }]);
    // Per-status counts are over the CIDs looked up, not the ones left unprocessed.
    expect(sc.notice).toContain('25 of 25 CID(s)');
    const text = textOf(result);
    expect(text).toContain(
      'cids: requested 29, served 25 (the per-call cap); the remaining 4 are listed in unprocessed, in input order — pass them in a follow-up call.',
    );
    expect(text).toContain('**Unprocessed (4, past the per-call cap):** 122, 123, 124, 3');
  });

  it('accepts 1000 CIDs and rejects 1001 at the schema', async () => {
    const sc = structured(await runToolContract(getCompoundSafety, { cids: range(1000) }));
    expect(sc.unprocessed).toHaveLength(975);
    expectSchemaRejection(await runToolContract(getCompoundSafety, { cids: range(1001) }));
  });
});

describe('pubchem_search_compounds identifiers (cap 25)', () => {
  const names = (n: number) => range(n).map((i) => `compound-${i}`);

  beforeEach(() => {
    mockClient.searchByName.mockImplementation(async (name: string) => [
      Number(name.split('-')[1]),
    ]);
  });

  it('serves 25 identifiers with no unprocessed list or cappedInputs', async () => {
    const sc = structured(
      await runToolContract(searchCompounds, {
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: names(25),
      }),
    );
    expect(mockClient.searchByName).toHaveBeenCalledTimes(25);
    expect(sc).not.toHaveProperty('unprocessed');
    expect(sc).not.toHaveProperty('cappedInputs');
  });

  it('looks up the first 25 identifiers and returns the rest as unprocessed, in input order', async () => {
    const identifiers = names(28).reverse();
    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers,
      maxResults: 200,
    });
    const sc = structured(result);

    expect(mockClient.searchByName.mock.calls.map(([n]) => n)).toEqual(identifiers.slice(0, 25));
    expect(sc.unprocessed).toEqual(['compound-3', 'compound-2', 'compound-1']);
    expect(sc.totalFound).toBe(25);
    expect(sc.cappedInputs).toEqual([
      { input: 'identifiers', requested: 28, served: 25, unprocessed: 3 },
    ]);
    const text = textOf(result);
    expect(text).toContain(
      'identifiers: requested 28, served 25 (the per-call cap); the remaining 3 are listed in unprocessed, in input order — pass them in a follow-up call.',
    );
    expect(text).toContain(
      '**Unprocessed (3, past the per-call cap):** compound-3, compound-2, compound-1',
    );
  });

  it('reports both an identifier and a page-size clamp in one cappedInputs', async () => {
    const sc = structured(
      await runToolContract(searchCompounds, {
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: names(26),
        maxResults: 300,
      }),
    );
    expect(sc.cappedInputs).toEqual([
      { input: 'identifiers', requested: 26, served: 25, unprocessed: 1 },
      { input: 'maxResults', requested: 300, served: 200 },
    ]);
  });

  it('accepts 1000 identifiers and rejects 1001 at the schema', async () => {
    const sc = structured(
      await runToolContract(searchCompounds, {
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: names(1000),
      }),
    );
    expect(sc.unprocessed).toHaveLength(975);
    expectSchemaRejection(
      await runToolContract(searchCompounds, {
        searchType: 'identifier',
        identifierType: 'name',
        identifiers: names(1001),
      }),
    );
  });

  it('words a one-identifier clamp in the singular', async () => {
    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: names(26),
    });

    expect(textOf(result)).toContain(
      'identifiers: requested 26, served 25 (the per-call cap); the remaining 1 is listed in unprocessed, in input order — pass it in a follow-up call.',
    );
  });

  it('counts the identifiers past the cap when every one looked up was rejected', async () => {
    mockClient.searchByName.mockRejectedValue(
      validationError('PubChem could not interpret the identifier.', {
        reason: 'identifier_rejected',
      }),
    );

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: names(30),
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { message: string; data?: { reason?: string } };
    };
    expect(error.data?.reason).toBe('identifier_rejected');
    expect(error.message).toBe(
      `PubChem could not interpret any of the 25 identifier(s) as compound names: ${names(25).join(', ')}. The 5 identifier(s) past the per-call cap of 25 were not looked up.`,
    );
    expect(mockClient.searchByName).toHaveBeenCalledTimes(25);
  });

  it('renders caller identifiers in content[] as inline data', async () => {
    const odd = 'x*y\n# HEADING';
    mockClient.searchByName.mockImplementation(async (name: string) =>
      name === 'a*b' ? [7] : name.startsWith('compound-') ? [Number(name.split('-')[1])] : [],
    );

    const result = await runToolContract(searchCompounds, {
      searchType: 'identifier',
      identifierType: 'name',
      identifiers: ['a*b', '**none**', ...names(23), odd],
    });

    const sc = structured(result);
    expect(sc.unprocessed).toEqual([odd]);
    expect(sc.unresolvedIdentifiers).toEqual(['**none**']);
    const text = textOf(result);
    expect(text).toContain('**Unprocessed (1, past the per-call cap):** x\\*y # HEADING');
    expect(text).toContain('Unresolved identifiers (1): \\*\\*none\\*\\*');
    expect(text).toContain('7 (a\\*b)');
    expect(text).not.toMatch(/^# HEADING/m);
  });
});

describe('pubchem_get_summary identifiers (cap 10)', () => {
  beforeEach(() => {
    mockClient.getEntitySummary.mockResolvedValue(null);
  });

  it('serves 10 identifiers with no unprocessed list or cappedInputs', async () => {
    const sc = structured(
      await runToolContract(getSummary, {
        entityType: 'assay',
        identifiers: range(10).map(String),
      }),
    );
    expect(sc.summaries).toHaveLength(10);
    expect(sc).not.toHaveProperty('unprocessed');
    expect(sc).not.toHaveProperty('cappedInputs');
  });

  it('accepts an array past 10 entries: serves 10, returns the rest as unprocessed', async () => {
    const identifiers = range(12).map((i) => String(3000 - i));
    const result = await runToolContract(getSummary, { entityType: 'assay', identifiers });
    const sc = structured(result);

    expect(mockClient.getEntitySummary.mock.calls.map(([, id]) => id)).toEqual(
      identifiers.slice(0, 10).map(Number),
    );
    expect(sc.unprocessed).toEqual(['2989', '2988']);
    expect(sc.cappedInputs).toEqual([
      { input: 'identifiers', requested: 12, served: 10, unprocessed: 2 },
    ]);
    // One disclosure: the cap sentence lives in cappedInputs, not repeated in notice.
    expect(String(sc.notice ?? '')).not.toContain('unprocessed');
    expect(textOf(result)).toContain(
      'identifiers: requested 12, served 10 (the per-call cap); the remaining 2 are listed in unprocessed, in input order — pass them in a follow-up call.',
    );
  });

  it('accepts 1000 entries and rejects 1001 at the schema', async () => {
    const sc = structured(
      await runToolContract(getSummary, {
        entityType: 'assay',
        identifiers: range(1000).map(String),
      }),
    );
    expect(sc.unprocessed).toHaveLength(990);
    expectSchemaRejection(
      await runToolContract(getSummary, {
        entityType: 'assay',
        identifiers: range(1001).map(String),
      }),
    );
  });
});
