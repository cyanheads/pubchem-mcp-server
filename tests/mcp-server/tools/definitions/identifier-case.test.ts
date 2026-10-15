/**
 * @fileoverview Tests for the InChIKey and protein-accession case normalizers (#67).
 * @module mcp-server/tools/definitions/identifier-case.test
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeInchiKey,
  normalizeProteinAccession,
} from '@/mcp-server/tools/definitions/identifier-case.js';

describe('normalizeInchiKey', () => {
  it('uppercases the whole key', () => {
    expect(normalizeInchiKey('bsynrymutxbxsq-uhfffaoysa-n')).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
    expect(normalizeInchiKey('Bsynrymutxbxsq-UHFFFAOYSA-n')).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
  });

  it('leaves an uppercase key unchanged', () => {
    expect(normalizeInchiKey('BSYNRYMUTXBXSQ-UHFFFAOYSA-N')).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
  });
});

describe('normalizeProteinAccession', () => {
  it.each([
    ['p00533', 'P00533'], // UniProt, 6 characters
    ['a0a0g2jz79', 'A0A0G2JZ79'], // UniProt, 10 characters
    ['p00533-1', 'P00533-1'], // UniProt isoform
    ['aad14062', 'AAD14062'], // GenBank
    ['np_000953.2', 'NP_000953.2'], // RefSeq, versioned
    ['np_000953', 'NP_000953'], // RefSeq
    ['b45705', 'B45705'], // PIR
  ])('uppercases %s whole', (input, expected) => {
    expect(normalizeProteinAccession(input)).toBe(expected);
  });

  it('uppercases only the PDB ID of a PDB chain accession', () => {
    expect(normalizeProteinAccession('1zhh_A')).toBe('1ZHH_A');
    expect(normalizeProteinAccession('1zhh_a')).toBe('1ZHH_a');
    expect(normalizeProteinAccession('4ug0_La')).toBe('4UG0_La');
  });

  it('keeps a case-significant chain ID as given', () => {
    // NCBI resolves 4UG0_La and 4UG0_LA to two different proteins.
    expect(normalizeProteinAccession('4UG0_La')).toBe('4UG0_La');
    expect(normalizeProteinAccession('4UG0_LA')).toBe('4UG0_LA');
  });

  it('leaves uppercase accessions and digit-only GI numbers unchanged', () => {
    for (const value of ['P00533', 'NP_542158', '1ZHH_A', '578162']) {
      expect(normalizeProteinAccession(value)).toBe(value);
    }
  });
});
