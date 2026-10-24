/**
 * @fileoverview Portability checks on every registered tool's advertised input schema, plus
 * the lower bound of each positive-integer input (#51). Copilot Studio fails to parse a
 * numeric `exclusiveMinimum`, so positive integers are bounded with `minimum: 1` instead.
 * @module tests/mcp-server/tools/definitions/tool-input-schemas.test
 */

import { describe, expect, it } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** The input schema as `tools/list` advertises it: the framework hands the SDK the definition's
 * `input['~standard'].jsonSchema`, and the SDK renders it with `.input()` at draft-2020-12. */
function advertisedInputSchema(tool: (typeof allToolDefinitions)[number]): unknown {
  return tool.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
}

/** JSON-pointer-style paths of every `key` occurrence anywhere in `node`. */
function pathsOfKey(node: unknown, key: string, path = ''): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => pathsOfKey(item, key, `${path}/${i}`));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => [
    ...(k === key ? [`${path}/${k}`] : []),
    ...pathsOfKey(v, key, `${path}/${k}`),
  ]);
}

/** Reads the value at a `/`-separated path inside a JSON Schema. */
function at(node: unknown, path: string): unknown {
  return path
    .split('/')
    .filter(Boolean)
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], node);
}

const toolByName = new Map(allToolDefinitions.map((t) => [t.name, t]));

/** Every positive-integer tool input: the tool, the field path to vary, a minimal valid call,
 * and where that field's bound sits in the advertised schema. */
const positiveIntegerInputs = [
  ['pubchem_get_compound_details', 'cids.0', { cids: [2244] }, '/properties/cids/items'],
  ['pubchem_get_compound_safety', 'cids.0', { cids: [2244] }, '/properties/cids/items'],
  ['pubchem_get_compound_image', 'cid', { cid: 2244 }, '/properties/cid'],
  ['pubchem_get_compound_xrefs', 'cid', { cid: 2244, xrefTypes: ['RN'] }, '/properties/cid'],
  ['pubchem_get_compound_interactions', 'cid', { cid: 2244 }, '/properties/cid'],
  ['pubchem_get_bioactivity', 'cid', { cid: 2244 }, '/properties/cid'],
  ['pubchem_get_bioactivity', 'targetGeneId', { cid: 2244 }, '/properties/targetGeneId'],
  ['pubchem_get_compound_3d_structure', 'cid', { cid: 2244 }, '/properties/cid'],
  ['pubchem_get_compound_3d_structure', 'maxAtoms', { cid: 2244 }, '/properties/maxAtoms'],
  ['pubchem_get_compound_3d_structure', 'maxBonds', { cid: 2244 }, '/properties/maxBonds'],
  ['pubchem_search_compounds', 'aid', { searchType: 'assay', aid: 1000 }, '/properties/aid'],
] as const;

/** Returns a copy of `base` with the dotted `field` path set to `value`. */
function withField(base: Record<string, unknown>, field: string, value: number) {
  const input = structuredClone(base) as Record<string, unknown>;
  const [head, index] = field.split('.');
  if (index === undefined) input[head as string] = value;
  else (input[head as string] as number[])[Number(index)] = value;
  return input;
}

describe('advertised tool input schemas (#51)', () => {
  it('covers every registered tool', () => {
    expect(allToolDefinitions.length).toBeGreaterThan(0);
    for (const tool of allToolDefinitions) {
      expect(advertisedInputSchema(tool)).toMatchObject({ type: 'object' });
    }
  });

  it.each(allToolDefinitions.map((t) => [t.name, t] as const))(
    '%s carries no exclusiveMinimum anywhere in its input schema',
    (_name, tool) => {
      expect(pathsOfKey(advertisedInputSchema(tool), 'exclusiveMinimum')).toEqual([]);
    },
  );
});

describe('positive-integer tool inputs (#51)', () => {
  it.each(positiveIntegerInputs)(
    '%s %s advertises an integer with minimum 1',
    (name, _field, _base, schemaPath) => {
      const tool = toolByName.get(name);
      expect(tool).toBeDefined();
      const bound = at(advertisedInputSchema(tool!), schemaPath);
      expect(bound).toMatchObject({ type: 'integer', minimum: 1 });
    },
  );

  it.each(positiveIntegerInputs)(
    '%s %s accepts 1 and rejects 0 and negatives',
    (name, field, base) => {
      const tool = toolByName.get(name)!;
      expect(tool.input.safeParse(withField(base, field, 1)).success).toBe(true);
      for (const value of [0, -1, -2244]) {
        expect(tool.input.safeParse(withField(base, field, value)).success).toBe(false);
      }
      expect(tool.input.safeParse(withField(base, field, 1.5)).success).toBe(false);
    },
  );
});

/** PubChem's CID is a signed 32-bit integer: PUG REST wraps 2147483648-4294967295 into
 * negative IDs and answers HTTP 400 from 4294967296 up. */
const MAX_CID = 2147483647;

const cidInputs = positiveIntegerInputs.filter(([, field]) => field.startsWith('cid'));

describe('CID tool inputs carry the 32-bit upper bound (#59)', () => {
  it('covers the seven tool CID fields', () => {
    expect(cidInputs).toHaveLength(7);
  });

  it.each(cidInputs)(
    '%s %s advertises maximum 2147483647 and no exclusiveMaximum',
    (name, _field, _base, schemaPath) => {
      const schema = advertisedInputSchema(toolByName.get(name)!);
      expect(at(schema, schemaPath)).toMatchObject({ type: 'integer', maximum: MAX_CID });
      expect(pathsOfKey(schema, 'exclusiveMaximum')).toEqual([]);
    },
  );

  it.each(cidInputs)('%s %s accepts 2147483647 and rejects 2147483648', (name, field, base) => {
    const tool = toolByName.get(name)!;
    expect(tool.input.safeParse(withField(base, field, MAX_CID)).success).toBe(true);
    for (const value of [MAX_CID + 1, 4294967296, 99999999999]) {
      expect(tool.input.safeParse(withField(base, field, value)).success).toBe(false);
    }
  });
});

/** AIDs and NCBI Gene IDs share the CID's signed 32-bit range; an AID past it reaches PubChem as
 * a wrapped negative ID or a raw HTTP 400. */
const int32IdInputs = positiveIntegerInputs.filter(
  ([, field]) => field === 'aid' || field === 'targetGeneId',
);

describe('AID and Gene ID tool inputs carry the 32-bit upper bound', () => {
  it('covers search_compounds aid and get_bioactivity targetGeneId', () => {
    expect(int32IdInputs.map(([name, field]) => `${name}.${field}`)).toEqual([
      'pubchem_get_bioactivity.targetGeneId',
      'pubchem_search_compounds.aid',
    ]);
  });

  it.each(int32IdInputs)(
    '%s %s advertises maximum 2147483647 and names it in the description',
    (name, _field, _base, schemaPath) => {
      const node = at(advertisedInputSchema(toolByName.get(name)!), schemaPath) as Record<
        string,
        unknown
      >;
      expect(node).toMatchObject({ type: 'integer', maximum: MAX_CID });
      expect(String(node.description)).toContain('2147483647');
    },
  );

  it.each(int32IdInputs)('%s %s accepts 2147483647 and rejects 3000000000', (name, field, base) => {
    const tool = toolByName.get(name)!;
    expect(tool.input.safeParse(withField(base, field, MAX_CID)).success).toBe(true);
    for (const value of [MAX_CID + 1, 3000000000, 99999999999]) {
      expect(tool.input.safeParse(withField(base, field, value)).success).toBe(false);
    }
  });

  it('pubchem://assay/{aid} accepts "2147483647" and rejects "3000000000"', () => {
    const assay = allResourceDefinitions.find((r) => r.uriTemplate === 'pubchem://assay/{aid}');
    expect(assay?.params?.safeParse({ aid: String(MAX_CID) }).success).toBe(true);
    for (const value of [String(MAX_CID + 1), '3000000000']) {
      expect(assay?.params?.safeParse({ aid: value }).success).toBe(false);
    }
  });
});

describe('search_compounds offset leaves its ceiling to the handler (#76)', () => {
  const offsetNode = () =>
    at(advertisedInputSchema(toolByName.get('pubchem_search_compounds')!), '/properties/offset') as
      | Record<string, unknown>
      | undefined;

  it('advertises an integer from 0 with no maximum below the safe-integer range', () => {
    const node = offsetNode();
    expect(node).toMatchObject({ type: 'integer', minimum: 0 });
    expect(node?.maximum ?? Number.MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
    expect(node).not.toHaveProperty('exclusiveMaximum');
  });

  it('scopes the 10000 ceiling to the four bounded modes in its description', () => {
    expect(String(offsetNode()?.description)).toMatch(
      /Formula, substructure, superstructure, and similarity searches[^.]*those four accept an offset up to 10000\./,
    );
  });

  it.each([10001, 305434, 2 ** 31])('accepts offset %i at the schema', (offset) => {
    const tool = toolByName.get('pubchem_search_compounds')!;
    expect(tool.input.safeParse({ searchType: 'assay', aid: 2551, offset }).success).toBe(true);
  });
});

/** Read-side workload inputs (#70): each serves up to its per-call cap and advertises only the
 * 1000 ceiling, so a value between the two is clamped by the handler, not rejected. */
const cappedWorkloadInputs = [
  ['pubchem_get_compound_details', '/properties/cids', 'maxItems'],
  ['pubchem_get_compound_details', '/properties/maxSynonyms', 'maximum'],
  ['pubchem_get_compound_details', '/properties/maxDescriptions', 'maximum'],
  ['pubchem_get_compound_safety', '/properties/cids', 'maxItems'],
  ['pubchem_search_compounds', '/properties/identifiers', 'maxItems'],
  ['pubchem_search_compounds', '/properties/maxResults', 'maximum'],
  ['pubchem_get_summary', '/properties/identifiers', 'maxItems'],
  ['pubchem_search_assays', '/properties/maxResults', 'maximum'],
  ['pubchem_get_bioactivity', '/properties/maxResults', 'maximum'],
  ['pubchem_get_compound_xrefs', '/properties/maxPerType', 'maximum'],
  ['pubchem_get_compound_interactions', '/properties/maxEntries', 'maximum'],
] as const;

describe('capped workload inputs advertise the 1000 ceiling (#70)', () => {
  it.each(cappedWorkloadInputs)('%s %s advertises %s 1000', (name, schemaPath, bound) => {
    const node = at(advertisedInputSchema(toolByName.get(name)!), schemaPath) as Record<
      string,
      unknown
    >;
    expect(node[bound]).toBe(1000);
    expect(String(node.description)).toMatch(/per-call cap/);
  });
});

describe('compound resource CID params carry the 32-bit upper bound (#59)', () => {
  const compoundResources = allResourceDefinitions.filter((r) =>
    r.uriTemplate.startsWith('pubchem://compound/{cid}'),
  );

  it('covers the five compound resources', () => {
    expect(compoundResources).toHaveLength(5);
  });

  it.each(compoundResources.map((r) => [r.name, r] as const))(
    '%s accepts "2147483647" and rejects "2147483648"',
    (_name, resource) => {
      expect(resource.params!.safeParse({ cid: String(MAX_CID) }).success).toBe(true);
      for (const value of [String(MAX_CID + 1), '4294967296']) {
        expect(resource.params!.safeParse({ cid: value }).success).toBe(false);
      }
    },
  );
});

describe('resource template ID params (#51)', () => {
  it.each(allResourceDefinitions.map((r) => [r.name, r] as const))(
    '%s accepts "1" and rejects "0" and negatives',
    (_name, resource) => {
      const params = resource.params;
      expect(params).toBeDefined();
      const [key] = Object.keys(params!.shape);
      expect(key).toBeDefined();

      expect(params!.safeParse({ [key!]: '1' }).success).toBe(true);
      for (const value of ['0', '-1', '1.5']) {
        expect(params!.safeParse({ [key!]: value }).success).toBe(false);
      }
    },
  );
});
