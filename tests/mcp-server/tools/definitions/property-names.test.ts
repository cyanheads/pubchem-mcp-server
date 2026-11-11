/**
 * @fileoverview The shared `properties` input element (#92): PubChem's current property names
 * read as this server's names before the enum check, the dedupe that follows the read, and the
 * two facts the element's placement guarantees — the advertised JSON Schema is the enum's own,
 * and the framework's argument repair still wraps a lone string.
 * @module tests/mcp-server/tools/definitions/property-names.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  dedupeProperties,
  propertyNameSchema,
} from '@/mcp-server/tools/definitions/property-names.js';
import { COMPOUND_PROPERTIES } from '@/services/pubchem/types.js';

const propertiesSchema = z.array(propertyNameSchema);

describe('propertyNameSchema', () => {
  it.each([
    ['SMILES', 'IsomericSMILES'],
    ['ConnectivitySMILES', 'CanonicalSMILES'],
    ['IsomericSMILES', 'IsomericSMILES'],
    ['CanonicalSMILES', 'CanonicalSMILES'],
    ['MolecularWeight', 'MolecularWeight'],
  ])('reads %s as %s', (sent, read) => {
    expect(propertyNameSchema.safeParse(sent)).toEqual({ success: true, data: read });
  });

  it.each<[string, unknown]>([
    ['an unknown name', 'AbsoluteSMILES'],
    ['a lowercase current name', 'smiles'],
    ['a prototype key', '__proto__'],
    ['an inherited property name', 'constructor'],
    ['the empty string', ''],
    ['a number', 42],
    ['null', null],
    ['a list', ['SMILES']],
  ])('rejects %s at the enum', (_label, sent) => {
    const result = propertyNameSchema.safeParse(sent);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['invalid_value']);
  });

  it('reads every element of a list, keeping the order and the repeats', () => {
    expect(
      propertiesSchema.parse(['ConnectivitySMILES', 'MolecularWeight', 'SMILES', 'IsomericSMILES']),
    ).toEqual(['CanonicalSMILES', 'MolecularWeight', 'IsomericSMILES', 'IsomericSMILES']);
  });

  it('advertises the JSON Schema of the bare enum array', () => {
    const advertised = (schema: z.ZodType) =>
      JSON.stringify(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }));
    expect(advertised(propertiesSchema)).toBe(advertised(z.array(z.enum(COMPOUND_PROPERTIES))));
  });

  describe('through the framework argument repair', () => {
    const echo = tool('scratch_properties_echo', {
      description: 'Echoes the properties input as parsed.',
      input: z.object({
        properties: z.array(propertyNameSchema).optional().describe('Property names.'),
      }),
      output: z.object({
        properties: z.array(z.string()).optional().describe('Property names as parsed.'),
      }),
      handler: (input) => ({ properties: input.properties }),
      format: (result) => [{ type: 'text', text: (result.properties ?? []).join(', ') }],
    });

    it.each([
      ['MolecularWeight', ['MolecularWeight']],
      ['SMILES', ['IsomericSMILES']],
    ])('wraps the lone string %s, then reads it', async (sent, parsed) => {
      const result = await runToolContract(echo, { properties: sent } as never);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ properties: parsed });
    });

    it('still rejects a lone unknown name', async () => {
      const result = await runToolContract(echo, { properties: 'smiles' } as never);
      expect(result.isError).toBe(true);
    });
  });
});

describe('dedupeProperties', () => {
  it.each<[string, string[], string[]]>([
    ['both forms of SMILES, read', ['IsomericSMILES', 'IsomericSMILES'], ['IsomericSMILES']],
    [
      'repeats in both forms, at their first occurrence',
      [
        'CanonicalSMILES',
        'MolecularWeight',
        'CanonicalSMILES',
        'IsomericSMILES',
        'MolecularWeight',
      ],
      ['CanonicalSMILES', 'MolecularWeight', 'IsomericSMILES'],
    ],
    ['a list without repeats, unchanged', ['XLogP', 'TPSA'], ['XLogP', 'TPSA']],
    ['an empty list', [], []],
  ])('keeps %s', (_label, names, deduped) => {
    expect(dedupeProperties(names)).toEqual(deduped);
  });

  it('names each property once after the read', () => {
    const read = propertiesSchema.parse([
      'SMILES',
      'IsomericSMILES',
      'ConnectivitySMILES',
      'CanonicalSMILES',
    ]);
    expect(dedupeProperties(read)).toEqual(['IsomericSMILES', 'CanonicalSMILES']);
  });
});
