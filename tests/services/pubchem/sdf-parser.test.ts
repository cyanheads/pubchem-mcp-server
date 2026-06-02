/**
 * @fileoverview Tests for the V2000 SDF connection-table parser.
 * @module services/pubchem/sdf-parser.test
 */

import { describe, expect, it } from 'vitest';
import { parseSdfV2000 } from '@/services/pubchem/sdf-parser.js';

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
