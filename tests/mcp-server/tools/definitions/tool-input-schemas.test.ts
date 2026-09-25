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
