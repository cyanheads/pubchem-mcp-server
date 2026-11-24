/**
 * @fileoverview fingerprintSimilarity (#97): Tanimoto over PubChem's 881-bit `Fingerprint2D`,
 * checked against real rows from an aspirin similarity search at threshold 75 (PubChem's own
 * threshold is the oracle: it returned every one of those hits at 0.75 or above) and against
 * crafted bit patterns for the layout's edges.
 * @module tests/services/pubchem/fingerprint.test
 */

import { describe, expect, it } from 'vitest';
import { fingerprintSimilarity, isFingerprint2D } from '@/services/pubchem/fingerprint.js';
import { fingerprintsByCid } from '../../helpers/fixtures.js';

/** `Fingerprint2D` by CID for the 201 hits of `fastsimilarity_2d/cid/2244` at Threshold 75. */
const FINGERPRINTS = fingerprintsByCid('fingerprint2d-2244-t75.json');
const ASPIRIN = FINGERPRINTS.get(2244)!;

/** A `Fingerprint2D` value in PubChem's layout: the bit count, big-endian, then `bitCount` bits
 * with the listed ones set, first bit in the high bit of the first byte. `padding` sets the bits
 * past the count in the last byte. */
function craft(bitCount: number, setBits: number[], padding = false): string {
  const bytes = new Uint8Array(4 + Math.ceil(bitCount / 8));
  new DataView(bytes.buffer).setUint32(0, bitCount);
  for (const bit of setBits) bytes[4 + (bit >> 3)]! |= 0x80 >> (bit & 7);
  if (padding) bytes[bytes.length - 1]! |= 0xff >> (bitCount % 8 || 8);
  return Buffer.from(bytes).toString('base64');
}

/** `craft(881, [1])` with one byte past its 111-byte body, still canonical base64: the bit count
 * says 881, the body holds 896. */
const LONG_BODY = Buffer.concat([
  Buffer.from(craft(881, [1]), 'base64'),
  Buffer.from([0xff]),
]).toString('base64');

describe('fingerprintSimilarity on real Fingerprint2D rows (#97)', () => {
  it('decodes every row to 881 bits after the 4-byte length prefix', () => {
    for (const value of FINGERPRINTS.values()) {
      const raw = Buffer.from(value, 'base64');
      expect(raw.length).toBe(115);
      expect(raw.readUInt32BE(0)).toBe(881);
    }
    expect(FINGERPRINTS.size).toBe(201);
  });

  it('scores aspirin against itself 1, CID 135 0.7541, CID 4133 0.9060, CID 5161 0.9580', () => {
    expect(fingerprintSimilarity(ASPIRIN, ASPIRIN)).toBe(1);
    expect(fingerprintSimilarity(ASPIRIN, FINGERPRINTS.get(135)!)).toBeCloseTo(0.7541, 4);
    expect(fingerprintSimilarity(ASPIRIN, FINGERPRINTS.get(4133)!)).toBeCloseTo(0.906, 4);
    expect(fingerprintSimilarity(ASPIRIN, FINGERPRINTS.get(5161)!)).toBeCloseTo(0.958, 4);
  });

  it('scores every hit PubChem returned at threshold 75 at 0.75 or above, and is symmetric', () => {
    const scores = [...FINGERPRINTS.values()].map((value) => fingerprintSimilarity(ASPIRIN, value));
    expect(scores.every((score) => score !== undefined && score >= 0.75 && score <= 1)).toBe(true);
    expect(Math.min(...(scores as number[]))).toBe(0.75);
    for (const value of FINGERPRINTS.values()) {
      expect(fingerprintSimilarity(value, ASPIRIN)).toBe(fingerprintSimilarity(ASPIRIN, value));
    }
  });
});

describe('fingerprintSimilarity on crafted bit patterns (#97)', () => {
  it('leaves the length prefix out of the score', () => {
    // Bits {0, 1} against {0}: 1/2. Counting the prefix (881 = 0x371, six bits set in both)
    // would give 7/8.
    expect(fingerprintSimilarity(craft(881, [0, 1]), craft(881, [0]))).toBe(0.5);
  });

  it('leaves padding bits past the bit count out of the score', () => {
    // Counted, the seven padding bits would give 2/9 and 8/9.
    expect(fingerprintSimilarity(craft(881, [0, 880], true), craft(881, [0, 880]))).toBe(1);
    expect(fingerprintSimilarity(craft(881, [0], true), craft(881, [0, 880], true))).toBe(0.5);
  });

  it('reads the first bit from the high bit of the first byte and the last from bit 880', () => {
    expect(fingerprintSimilarity(craft(881, [0]), craft(881, [0, 880]))).toBe(0.5);
    expect(fingerprintSimilarity(craft(881, [880]), craft(881, [0, 880]))).toBe(0.5);
  });

  it('scores disjoint fingerprints 0', () => {
    expect(fingerprintSimilarity(craft(881, [3, 4]), craft(881, [5]))).toBe(0);
  });

  it.each<[string, string, string]>([
    ['neither sets a bit', craft(881, []), craft(881, [])],
    ['the bit counts differ', craft(881, [1]), craft(880, [1])],
    ['a body is shorter than its count', craft(881, [1]).slice(0, -8), craft(881, [1])],
    ['a body is longer than its count', LONG_BODY, craft(881, [1])],
    ['a value is shorter than the prefix', 'AAA=', craft(881, [1])],
    ['the prefix states no bits', 'AAAAAA==', 'AAAAAA=='],
    ['a value is not base64 at all', '!!!!', craft(881, [1])],
    // Base64 decoders skip characters outside the alphabet, so each of these still decodes to
    // 115 bytes; the first with every bit after the swap shifted.
    [
      'a character is swapped for one outside base64 and a valid one is added further on',
      `${ASPIRIN.slice(0, 20)}!${ASPIRIN.slice(21, 60)}A${ASPIRIN.slice(60, -2)}`,
      ASPIRIN,
    ],
    [
      'a character outside base64 is inserted',
      `${ASPIRIN.slice(0, 20)}!${ASPIRIN.slice(20)}`,
      ASPIRIN,
    ],
    ['a line break is inserted', `${ASPIRIN.slice(0, 76)}\n${ASPIRIN.slice(76)}`, ASPIRIN],
    ['data follows the padding', `${ASPIRIN}AAAA`, ASPIRIN],
  ])('is undefined when %s', (_label, a, b) => {
    expect(fingerprintSimilarity(a, b)).toBeUndefined();
    expect(fingerprintSimilarity(b, a)).toBeUndefined();
  });
});

describe('isFingerprint2D (#97)', () => {
  it('accepts every real row and every crafted value in the layout', () => {
    expect([...FINGERPRINTS.values()].every(isFingerprint2D)).toBe(true);
    expect(isFingerprint2D(craft(881, [0, 880], true))).toBe(true);
  });

  it.each([
    ['cut short', ASPIRIN.slice(0, 100)],
    ['a byte longer than its count', LONG_BODY],
    ['hex-encoded', Buffer.from(ASPIRIN, 'base64').toString('hex')],
    ['empty', ''],
    ['stating no bits', 'AAAAAA=='],
    ['with a character outside base64 inserted', `${ASPIRIN.slice(0, 20)}!${ASPIRIN.slice(20)}`],
  ])('rejects a value %s', (_label, value) => {
    expect(isFingerprint2D(value)).toBe(false);
  });
});
