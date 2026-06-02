/**
 * @fileoverview Minimal parser for the V2000 SDF connection table (atom + bond blocks).
 * PubChem emits V2000 for 3D conformer records; the format is fixed-column and has been
 * stable since 1991, so a focused slice-based parser is more robust than a dependency.
 * @module services/pubchem/sdf-parser
 */

import type { Sdf3DStructure } from './types.js';

/**
 * Parse the first molecule's atom and bond blocks from a V2000 SDF record.
 *
 * Layout: three header lines, then a counts line (atom count at columns 0–3, bond count at
 * columns 3–6), then one fixed-column line per atom (x/y/z as `F10.4` at columns 0–10/10–20/
 * 20–30, element symbol at columns 31–34), then one line per bond (atom1/atom2/order as
 * three-column integers). The block is terminated by `M  END`.
 *
 * Throws when the counts line is missing or unparseable — a malformed record is a hard
 * failure, not a silently-empty success.
 */
export function parseSdfV2000(sdf: string): Sdf3DStructure {
  const lines = sdf.split('\n');

  // Header is three lines (title, program/timestamp, comment); the counts line is index 3.
  const countsLine = lines[3];
  if (countsLine === undefined) throw new Error('Malformed SDF: missing counts line');

  const atomCount = Number.parseInt(countsLine.slice(0, 3), 10);
  const bondCount = Number.parseInt(countsLine.slice(3, 6), 10);
  if (!Number.isInteger(atomCount) || !Number.isInteger(bondCount)) {
    throw new Error('Malformed SDF: unparseable atom/bond counts');
  }

  const atoms: Sdf3DStructure['atoms'] = [];
  for (let i = 0; i < atomCount; i++) {
    const line = lines[4 + i];
    if (line === undefined) break;
    atoms.push({
      x: Number.parseFloat(line.slice(0, 10)),
      y: Number.parseFloat(line.slice(10, 20)),
      z: Number.parseFloat(line.slice(20, 30)),
      element: line.slice(31, 34).trim(),
    });
  }

  const bonds: Sdf3DStructure['bonds'] = [];
  const bondStart = 4 + atomCount;
  for (let i = 0; i < bondCount; i++) {
    const line = lines[bondStart + i];
    if (line === undefined) break;
    bonds.push({
      a1: Number.parseInt(line.slice(0, 3), 10),
      a2: Number.parseInt(line.slice(3, 6), 10),
      order: Number.parseInt(line.slice(6, 9), 10),
    });
  }

  return { atomCount, bondCount, atoms, bonds };
}
