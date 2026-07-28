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

/** Conformer ID list for a compound */
export interface ConformerListResponse {
  InformationList: {
    Information: Array<{ CID: number; ConformerID: string[] }>;
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

// ── SDQ response types ───────────────────────────────────────────────

/** Envelope returned by the SDQ agent for a `select` projection.
 *
 * `totalCount` is the number of records matching the query across all pages, independent of
 * the `limit` window — with one exception: a `start` past the last record reports `totalCount`
 * 0 alongside an `eNoHitsFound` warning, so an empty page cannot be read as a total.
 *
 * `status` separates a rejection from an absence. SDQ reports a malformed query as a 5xx
 * carrying `status.error`, so an empty `rows` beside a populated `status.error` is a failure
 * whatever the HTTP status was — while an empty `rows` under `status.code` 0 is a real absence. */
export interface SdqResponse {
  SDQOutputSet?: Array<{
    status?: { code?: number; error?: string; warning?: string[] };
    totalCount?: number;
    collection?: string;
    rows?: Array<Record<string, unknown>>;
  }>;
}

// ── Parsed output types ──────────────────────────────────────────────

/** Parsed GHS hazard classification */
export interface GHSClassification {
  hazardStatements: Array<{ code: string; statement: string }>;
  pictograms: string[];
  precautionaryStatements: Array<{
    code: string;
    /** Standard statement text, or "" when `decoded` is false. */
    statement: string;
    /** Whether `statement` carries the standard text for this code. False when the code is
     * absent from the static table — PubChem deposits precautionary statements as bare codes,
     * so an undecoded code is a decoder-coverage gap or a free-fill placeholder, never a
     * statement the depositor left blank. */
    decoded: boolean;
  }>;
  signalWord?: string;
  source?: string;
}

/** Outcome of a GHS safety lookup for one CID.
 *
 * PUG View answers "no such compound" and "this compound has no Safety and Hazards data" with
 * the same HTTP 404, discriminated only by the fault message ("No record found" vs "No data
 * found"). The two need opposite recovery advice — verify the identifier, versus accept that
 * the compound carries no deposited classification — so they are kept apart here rather than
 * collapsed into one absent value. */
export type SafetyLookup =
  | { status: 'ok'; ghs: GHSClassification }
  | { status: 'no_ghs_data' }
  | { status: 'cid_not_found' };

/** Parsed bioactivity row from assay summary table */
export interface BioactivityRow {
  activityValues: Array<{ name?: string; value: number; unit?: string }>;
  aid: number;
  assayName: string;
  outcome: string;
  targetAccession?: string;
  targetGeneId?: number;
}

/** A single compound interaction entry (drug-drug, drug-food, or chemical-target). */
export interface InteractionEntry {
  /** Interaction category. */
  kind: 'drug-drug' | 'drug-food' | 'target';
  /** Interacting compound, food, or target name as the source reports it. Absent for food
   * interactions and any entry where the source carries no distinct partner. */
  partner?: string;
  /** Originating source (e.g. "DrugBank", "BindingDB"). */
  source: string;
  /** The interaction statement. */
  text: string;
}

/** Where one interaction kind's page landed in that kind's source-record stream.
 *
 * Every kind is backed by an ordered stream of source records, and entries are derived from
 * them: an SDQ row whose `targetname` is blank or whose `descr` is empty produces no entry, and
 * duplicate measurements collapse within a page. So `returnedCount` counts entries while
 * `totalRecords` and `recordsConsumed` count records, and the two are not interchangeable —
 * paging divides the records, so a duplicate split across two pages survives on both. */
export interface InteractionKindPage {
  /** Interaction category this page covers. */
  kind: 'drug-drug' | 'drug-food' | 'target';
  /** Source records this page read, starting at the requested offset. The next page resumes
   * at the first record it did not read. */
  recordsConsumed: number;
  /** Interaction entries this page produced. */
  returnedCount: number;
  /** Source records available for this kind, across all pages. */
  totalRecords: number;
}

/** One kind's page: the entries it produced, plus where it landed in that kind's record
 * stream. `getInteractions` turns this into an {@link InteractionKindPage} per kind. */
export interface InteractionKindFetch {
  entries: InteractionEntry[];
  /** Source records this page read, starting at the requested offset. */
  recordsConsumed: number;
  /** Source records available for this kind, across all pages. */
  totalRecords: number;
}

/** Result of a multi-kind interaction fetch. Kinds are fetched independently so a failure in
 * one (upstream parse error, timeout, network) never discards the kinds that succeeded. */
export interface InteractionsResult {
  /** Interaction entries across the kinds that resolved successfully. */
  entries: InteractionEntry[];
  /** Kinds whose fetch failed, with the failure message. Empty when every kind resolved. */
  failedKinds: Array<{ kind: string; message: string }>;
  /** Page state for each kind that resolved successfully, in the order requested. A kind
   * present in `failedKinds` is absent here — its page state is unknown, not zero. */
  pages: InteractionKindPage[];
}

/** A single atom in a 3D conformer (Cartesian coordinates, Angstroms). */
export interface Sdf3DAtom {
  element: string;
  x: number;
  y: number;
  z: number;
}

/** A single bond in a 3D conformer (1-based atom indices). */
export interface Sdf3DBond {
  a1: number;
  a2: number;
  order: number;
}

/** Parsed atoms and bonds from a V2000 SDF connection table. */
export interface Sdf3DStructure {
  atomCount: number;
  atoms: Sdf3DAtom[];
  bondCount: number;
  bonds: Sdf3DBond[];
}

/** Pharmacological classification from PUG View */
export interface CompoundClassification {
  /** ATC codes with hierarchical descriptions */
  atcCodes: Array<{ code: string; description: string }>;
  /** FDA Established Pharmacologic Classes (e.g. "Nonsteroidal Anti-inflammatory Drug") */
  fdaClasses: string[];
  /** FDA Mechanisms of Action (e.g. "Cyclooxygenase Inhibitors") */
  fdaMechanisms: string[];
  /** MeSH pharmacological class descriptions */
  meshClasses: string[];
}

/** Drug-likeness rule evaluation */
export interface DrugLikenessRule {
  limit: number;
  pass: boolean | null;
  value: number | null;
}

/** Computed drug-likeness assessment (Lipinski + Veber) */
export interface DrugLikenessAssessment {
  lipinski: {
    hba: DrugLikenessRule;
    hbd: DrugLikenessRule;
    mw: DrugLikenessRule;
    violations: number;
    xLogP: DrugLikenessRule;
  };
  /** Overall pass, or null when insufficient properties were available to assess. */
  pass: boolean | null;
  veber: {
    rotatableBonds: DrugLikenessRule;
    tpsa: DrugLikenessRule;
    violations: number;
  };
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
