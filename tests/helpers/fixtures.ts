/**
 * @fileoverview Readers for the captured PubChem responses under `tests/fixtures/`.
 * @module tests/helpers/fixtures
 */
import { readFileSync } from 'node:fs';

/** A fixture file's text. */
export const readFixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** A JSON fixture, typed as the caller says it is: fixtures are captured upstream data, not input. */
export const readJsonFixture = <T>(name: string): T => JSON.parse(readFixture(name)) as T;

/** `Fingerprint2D` by CID from a captured property table (`PropertyTable.Properties`). */
export function fingerprintsByCid(name: string): Map<number, string> {
  const { PropertyTable } = readJsonFixture<{
    PropertyTable: { Properties: Array<{ CID: number; Fingerprint2D: string }> };
  }>(name);
  return new Map(PropertyTable.Properties.map((row) => [row.CID, row.Fingerprint2D]));
}
