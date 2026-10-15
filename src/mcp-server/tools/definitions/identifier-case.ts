/**
 * @fileoverview Case normalization for identifiers PubChem matches case-sensitively.
 * InChIKeys and protein accessions are uppercase by definition, but PubChem returns
 * 404 for a lowercased one, so a caller's casing would otherwise read as "not found".
 * Applied in each handler rather than the schema: these values share their input slot
 * with identifier types whose case is significant (SMILES, names, gene symbols).
 * @module mcp-server/tools/definitions/identifier-case
 */

/** PDB chain accession: a four-character PDB ID, an underscore, then a chain ID. */
const PDB_CHAIN_ACCESSION = /^\d[A-Za-z0-9]{3}_./;

/** Uppercase an InChIKey. Its grammar is A–Z and hyphens, so the mapping is one-to-one. */
export function normalizeInchiKey(value: string): string {
  return value.toUpperCase();
}

/**
 * Uppercase a protein accession (UniProt, RefSeq, GenBank, PIR). A PDB chain accession
 * (`1zhh_A`) uppercases only its PDB ID: chain IDs are case-significant (`4UG0_La` and
 * `4UG0_LA` are different proteins), so the chain is kept as given.
 */
export function normalizeProteinAccession(value: string): string {
  if (PDB_CHAIN_ACCESSION.test(value)) return value.slice(0, 4).toUpperCase() + value.slice(4);
  return value.toUpperCase();
}
