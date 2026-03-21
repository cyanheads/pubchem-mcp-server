/**
 * @fileoverview PubChem API response types and shared constants.
 * @module services/pubchem/types
 */

// ── PUG REST response types ───────────────────────────────────────────

/** CID list from identifier/formula/structure searches */
export interface CidListResponse {
  IdentifierList: { CID: number[] };
}

/** Async search response — PubChem returns a ListKey when results aren't ready yet */
export interface ListKeyResponse {
  Waiting: { ListKey: string };
}

/** AID list from assay target searches */
export interface AidListResponse {
  IdentifierList: { AID: number[] };
}

/** Compound property table */
export interface PropertyTableResponse {
  PropertyTable: {
    Properties: Array<Record<string, unknown> & { CID: number }>;
  };
}

/** Synonym list for a compound */
export interface SynonymResponse {
  InformationList: {
    Information: Array<{ CID: number; Synonym: string[] }>;
  };
}

/** Cross-reference list for a compound */
export interface XrefResponse {
  InformationList: {
    Information: Array<Record<string, unknown> & { CID: number }>;
  };
}

/** Bioassay summary table (column-oriented) */
export interface AssaySummaryTableResponse {
  Table: {
    Columns: { Column: string[] };
    Row: Array<{ Cell: (string | number | null)[] }>;
  };
}

// ── PUG View response types ──────────────────────────────────────────

export interface PugViewResponse {
  Record: {
    RecordType: string;
    RecordNumber: number;
    Section?: PugViewSection[];
    Reference?: Array<{ ReferenceNumber: number; SourceName: string; SourceID?: string }>;
  };
}

export interface PugViewSection {
  Description?: string;
  Information?: PugViewInformation[];
  Section?: PugViewSection[];
  TOCHeading: string;
}

export interface PugViewInformation {
  Description?: string;
  Name?: string;
  ReferenceNumber?: number;
  Value: {
    StringWithMarkup?: Array<{
      String: string;
      Markup?: Array<{
        Start: number;
        Length: number;
        URL?: string;
        Type?: string;
        Extra?: string;
      }>;
    }>;
    Number?: number[];
    Boolean?: boolean[];
  };
}

// ── Parsed output types ──────────────────────────────────────────────

/** Parsed GHS hazard classification */
export interface GHSClassification {
  hazardStatements: Array<{ code: string; statement: string }>;
  pictograms: string[];
  precautionaryStatements: Array<{ code: string; statement: string }>;
  signalWord?: string;
  source?: string;
}

/** Parsed bioactivity row from assay summary table */
export interface BioactivityRow {
  activityValues: Array<{ name: string; value: number; unit: string }>;
  aid: number;
  assayName: string;
  outcome: string;
  targetAccession?: string;
  targetGeneId?: number;
}

// ── PubChem error ────────────────────────────────────────────────────

/** Structured error from PubChem API */
export class PubChemNotFoundError extends Error {
  override name = 'PubChemNotFoundError' as const;
}

// ── Constants ────────────────────────────────────────────────────────

/** All valid PubChem compound property names */
export const COMPOUND_PROPERTIES = [
  'MolecularFormula',
  'MolecularWeight',
  'CanonicalSMILES',
  'IsomericSMILES',
  'InChI',
  'InChIKey',
  'IUPACName',
  'Title',
  'XLogP',
  'ExactMass',
  'MonoisotopicMass',
  'TPSA',
  'Complexity',
  'Charge',
  'HBondDonorCount',
  'HBondAcceptorCount',
  'RotatableBondCount',
  'HeavyAtomCount',
  'IsotopeAtomCount',
  'AtomStereoCount',
  'DefinedAtomStereoCount',
  'UndefinedAtomStereoCount',
  'BondStereoCount',
  'DefinedBondStereoCount',
  'UndefinedBondStereoCount',
  'CovalentUnitCount',
  'Volume3D',
] as const;

/** Default properties when none specified */
export const DEFAULT_PROPERTIES = [
  'MolecularFormula',
  'MolecularWeight',
  'IUPACName',
  'CanonicalSMILES',
  'IsomericSMILES',
  'InChIKey',
  'XLogP',
  'TPSA',
  'HBondDonorCount',
  'HBondAcceptorCount',
  'RotatableBondCount',
  'HeavyAtomCount',
  'Charge',
  'Complexity',
] as const;

/** Supported cross-reference types */
export const XREF_TYPES = [
  'RegistryID',
  'RN',
  'PubMedID',
  'PatentID',
  'GeneID',
  'ProteinGI',
  'TaxonomyID',
] as const;
