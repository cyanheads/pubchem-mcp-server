/**
 * @fileoverview The `properties` input element shared by the tools that fetch compound
 * properties: PubChem's current name for a property reads as this server's name before the enum
 * check, so a caller may send either while the advertised enum, the request PubChem receives,
 * and the output keys stay one name per property.
 * @module mcp-server/tools/definitions/property-names
 */

import { z } from '@cyanheads/mcp-ts-core';
import { COMPOUND_PROPERTIES, PROPERTY_NAME_MAP } from '@/services/pubchem/types.js';

/**
 * One element of a `properties` input: a {@link COMPOUND_PROPERTIES} name, with `SMILES` read as
 * `IsomericSMILES` and `ConnectivitySMILES` as `CanonicalSMILES` ({@link PROPERTY_NAME_MAP});
 * anything else reaches the enum as sent, so a lowercase or unknown name is still rejected. The
 * read sits on the element, not the array, so the framework's argument repair still wraps a
 * lone string into a one-element list, and the advertised JSON Schema is the enum's own.
 */
export const propertyNameSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (PROPERTY_NAME_MAP.get(value) ?? value) : value),
  z.enum(COMPOUND_PROPERTIES),
);

/** `names` with each property kept at its first occurrence, so `["SMILES", "IsomericSMILES"]`,
 * read as two `IsomericSMILES`, names the property once in the PubChem request. */
export function dedupeProperties<T extends string>(names: readonly T[]): T[] {
  return [...new Set(names)];
}
