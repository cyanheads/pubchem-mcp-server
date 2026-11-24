/**
 * @fileoverview Tests for the V2000 SDF connection-table parser.
 * @module services/pubchem/sdf-parser.test
 */

import { describe, expect, it } from 'vitest';
import { parseSdfV2000 } from '@/services/pubchem/sdf-parser.js';
import { readFixture } from '../../helpers/fixtures.js';

/** Build a fixed-column V2000 atom line (3× F10.4 coords, element at columns 31-34). */
const f4 = (n: number) => n.toFixed(4).padStart(10);
const atomLine = (x: number, y: number, z: number, el: string) =>
  `${f4(x)}${f4(y)}${f4(z)} ${el.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
const bondLine = (a1: number, a2: number, order: number) =>
  `${String(a1).padStart(3)}${String(a2).padStart(3)}${String(order).padStart(3)}  0  0  0  0`;

const SDF = [
  '2244',
  '  -OEChem-fixture',
  '',
  '  3  2  0     0  0  0  0  0  0999 V2000',
  atomLine(1.2333, 0.554, 0.7792, 'O'),
  atomLine(0, 0, 0, 'C'),
  atomLine(-1.5, 0.5, 0.25, 'N'),
  bondLine(1, 2, 2),
  bondLine(2, 3, 1),
  'M  END',
  '$$$$',
].join('\n');

describe('parseSdfV2000', () => {
  it('parses counts, coordinates, elements, and bond orders from fixed columns', () => {
    const r = parseSdfV2000(SDF);

    expect(r.atomCount).toBe(3);
    expect(r.bondCount).toBe(2);
    expect(r.atoms).toHaveLength(3);
    expect(r.bonds).toHaveLength(2);

    expect(r.atoms[0]).toEqual({ element: 'O', x: 1.2333, y: 0.554, z: 0.7792 });
    expect(r.atoms[1]).toEqual({ element: 'C', x: 0, y: 0, z: 0 });
    expect(r.atoms[2]).toEqual({ element: 'N', x: -1.5, y: 0.5, z: 0.25 });

    expect(r.bonds[0]).toEqual({ a1: 1, a2: 2, order: 2 });
    expect(r.bonds[1]).toEqual({ a1: 2, a2: 3, order: 1 });
  });

  it('throws on a record missing the counts line', () => {
    expect(() => parseSdfV2000('only one line')).toThrow(/Malformed SDF/);
  });
});

/** `SDF` with SD data items after `M  END`, each `[header, value]`. */
const withItems = (items: Array<[string, string]>, sdf = SDF) =>
  sdf.replace('M  END\n', `M  END\n${items.map(([h, v]) => `${h}\n${v}\n\n`).join('')}`);

describe('parseSdfV2000 conformer ID (#99)', () => {
  it.each([
    ['sdf-2244-default.sdf', '000008C400000001'],
    ['sdf-2244-conformer-000008C40000000B.sdf', '000008C40000000B'],
  ])('reads the PUBCHEM_CONFORMER_ID data item of %s', (file, id) => {
    const r = parseSdfV2000(readFixture(file));

    expect(r.conformerId).toBe(id);
    expect(r).toMatchObject({ atomCount: 21, bondCount: 21 });
  });

  it('leaves conformerId out of a record without the data item', () => {
    const r = parseSdfV2000(withItems([['> <PUBCHEM_COMPOUND_CID>', '2244']]));

    expect(r).not.toHaveProperty('conformerId');
    expect(r.atoms).toHaveLength(3);
  });

  it('reads the item past other items, under a header with a data number, from CRLF lines', () => {
    const sdf = withItems([
      ['> <PUBCHEM_COMPOUND_CID>', '2244'],
      ['>  25  <PUBCHEM_CONFORMER_ID>  (1)', '000008C40000000B'],
    ]).replaceAll('\n', '\r\n');

    const r = parseSdfV2000(sdf);

    expect(r.conformerId).toBe('000008C40000000B');
    expect(r.atoms[0]).toEqual({ element: 'O', x: 1.2333, y: 0.554, z: 0.7792 });
  });

  it("reads only the first record's items, never a later record's", () => {
    const second = withItems([['> <PUBCHEM_CONFORMER_ID>', '000008C40000000B']]);

    expect(parseSdfV2000(`${SDF}\n${second}`)).not.toHaveProperty('conformerId');
  });

  it('leaves conformerId out when the item holds no value', () => {
    expect(parseSdfV2000(withItems([['> <PUBCHEM_CONFORMER_ID>', '  ']]))).not.toHaveProperty(
      'conformerId',
    );
  });
});
