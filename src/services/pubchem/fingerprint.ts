/**
 * @fileoverview Tanimoto similarity between two PubChem `Fingerprint2D` values: PubChem's 881-bit
 * substructure fingerprint, the one its 2D similarity search thresholds on.
 * @module services/pubchem/fingerprint
 */

/** The fingerprint bits of a `Fingerprint2D` value as one integer, or undefined when the value is
 * not in that layout.
 *
 * PUG REST serves `Fingerprint2D` as base64 of a 4-byte big-endian bit count (881) followed by
 * the bits, first bit in the high bit of the first byte, the last byte padded. The count is
 * length, not fingerprint: scored with the bits it shifts nearly every score off the one PubChem
 * thresholds on. The padding is shifted out, so only fingerprint bits are compared. Only the
 * canonical encoding PubChem serves is read: base64 decoders skip characters outside the
 * alphabet, so a damaged value can still decode to the right length with its bits shifted. */
function fingerprintBits(base64: string): { bitCount: number; bits: bigint } | undefined {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length < 4 || raw.toString('base64') !== base64) return undefined;
  const bitCount = raw.readUInt32BE(0);
  const body = raw.subarray(4);
  if (bitCount === 0 || body.length !== Math.ceil(bitCount / 8)) return undefined;
  const padding = BigInt(body.length * 8 - bitCount);
  return { bitCount, bits: BigInt(`0x${body.toString('hex')}`) >> padding };
}

/** Whether a `Fingerprint2D` value is in PubChem's layout, so it can be scored. */
export const isFingerprint2D = (value: string): boolean => fingerprintBits(value) !== undefined;

/** Set bits in a non-negative integer. */
const popcount = (value: bigint): number => value.toString(2).replaceAll('0', '').length;

/**
 * Tanimoto similarity of two PubChem `Fingerprint2D` values: bits set in both over bits set in
 * either, from 0 to 1, unrounded. 1 means identical fingerprints, which distinct compounds can
 * share (isotopologues, some positional isomers). Undefined when either value is not a
 * fingerprint in PubChem's layout, the two differ in bit count, or neither sets any bit.
 */
export function fingerprintSimilarity(a: string, b: string): number | undefined {
  const left = fingerprintBits(a);
  const right = fingerprintBits(b);
  if (!left || !right || left.bitCount !== right.bitCount) return undefined;
  const either = popcount(left.bits | right.bits);
  return either === 0 ? undefined : popcount(left.bits & right.bits) / either;
}
