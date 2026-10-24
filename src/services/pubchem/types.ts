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

/** An assay's CID list stored server-side (`list_return=listkey`): the key to page it with
 * and the exact number of CIDs it holds. */
export interface AssayCidListKeyResponse {
  IdentifierList: { ListKey: string; Size: number };
}

/** One page of an assay's CIDs. `total` is the exact count across all pages. */
export interface AssayCidPage {
  cids: number[];
  total: number;
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

/** Batched gene summaries (`/gene/geneid/{ids}/summary/JSON`). PubChem leaves out an ID it has
 * no gene for and does not keep the requested order. `Name` can be blank. */
export interface GeneSummaryResponse {
  GeneSummaries: {
    GeneSummary: Array<{ GeneID: number; Name?: string; Symbol?: string; Taxonomy?: string }>;
  };
}

/** Batched protein summaries (`/protein/accession/{ids}/summary/JSON`), with the same omissions
 * and ordering as {@link GeneSummaryResponse}. */
export interface ProteinSummaryResponse {
  ProteinSummaries: {
    ProteinSummary: Array<{ ProteinAccession: string; Name?: string; Taxonomy?: string }>;
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
    Reference?: Array<{
      ReferenceNumber: number;
      SourceName: string;
      SourceID?: string;
      /** The depositor's own record title, e.g. "Ethanol - FY2013 (Revised classification)". */
      Name?: string;
    }>;
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
      /** Absent on some entries (a markup-only deposit), so every reader guards it. */
      String?: string;
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

/** One source's GHS classification — a run of PUG View `Information` entries sharing a
 * `ReferenceNumber`. A classification is one authority's coherent label (signal word,
 * pictograms, and hazard codes together), so it is kept whole rather than merged. */
export interface GHSSourceClassification {
  hazardCodes: Array<{
    /** Notifier agreement exactly as PubChem prints it ("37.7%", "> 99.9%"). Only ECHA C&L
     * blocks carry one. */
    agreement?: string;
    code: string;
  }>;
  /** Set when the block is ECHA's "Not Classified" verdict: notifiers assessed the substance
   * and found it meets no GHS hazard criteria. Such a block carries no hazard codes. */
  notClassified?: true;
  /** The notification counts behind the classification: the first line of ECHA's
   * "C&L Notifications Summary" for a hazard classification, or ECHA's verdict line for a
   * "Not Classified" block. ECHA blocks only. */
  notifications?: string;
  pictograms: string[];
  signalWord?: string;
  /** `Reference.SourceName` for the block's `ReferenceNumber`. Absent when PubChem names no
   * reference for the block. */
  source?: string;
  /** `Reference.Name` — the depositor's record title, which tells NITE-CMC revisions and ECHA
   * aggregate vs single-company notifications apart. */
  sourceRecord?: string;
}

/** Parsed GHS hazard classification */
export interface GHSClassification {
  /** Each source's classification, in PubChem's order. */
  classifications: GHSSourceClassification[];
  /** Union across classifications, first-seen order. */
  hazardStatements: Array<{ code: string; statement: string }>;
  /** Union across classifications, first-seen order. */
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
  /** Most severe across classifications: Danger > Warning > absent. */
  signalWord?: string;
  /** Distinct `classifications[].source` values in PubChem's order, joined "; ". */
  source?: string;
}

/** Outcome of a GHS safety lookup for one CID.
 *
 * PUG View answers "no such compound" and "this compound has no GHS Classification data" with
 * the same HTTP 404, discriminated only by the fault message ("No record found" vs "No data
 * found"). The two need opposite recovery advice — verify the identifier, versus accept that
 * the compound carries no deposited classification — so they are kept apart here rather than
 * collapsed into one absent value. `not_classified` is a third answer: classifications are on
 * file, and every one is an ECHA "Not Classified" verdict. */
export type SafetyLookup =
  | { status: 'ok'; ghs: GHSClassification }
  | { status: 'not_classified'; ghs: GHSClassification }
  | { status: 'no_ghs_data' }
  | { status: 'cid_not_found' };

/** A quantitative measurement from one assay-summary row. */
export interface ActivityValue {
  name?: string;
  unit?: string;
  value: number;
}

/** A target an assay names beyond the one its record reports, with that target's own outcome
 * and measurements. */
export interface AssayTargetActivity {
  accession?: string;
  activityValues: ActivityValue[];
  geneId?: number;
  outcome: string;
}

/** Parsed bioactivity record for one AID from the assay summary table. The target fields,
 * outcome and values describe the AID's first target; an AID whose rows name more than one
 * target lists the rest, in table order, under `otherTargets`. `assayType` and `pmids` belong
 * to the AID itself, whichever target is reported. */
export interface BioactivityRow {
  activityValues: ActivityValue[];
  aid: number;
  assayName: string;
  /** PubChem's `Assay Type` as written ("Confirmatory", "Screening", "Summary", "Other");
   * omitted when blank. */
  assayType?: string;
  otherTargets?: AssayTargetActivity[];
  outcome: string;
  /** Distinct PubMed IDs across the AID's rows, highest (newest) first; omitted when none. */
  pmids?: number[];
  targetAccession?: string;
  targetGeneId?: number;
}

/** Target identifiers a compound's assay table ties together: every protein accession and
 * NCBI Gene ID connected through rows that carry both (e.g. P23219 ↔ 5742 ↔ NP_542158). */
export interface TargetGroup {
  accessions: string[];
  geneIds: number[];
}

/** A compound's parsed assay summary. */
export interface AssaySummary {
  /** One record per AID. */
  rows: BioactivityRow[];
  /** Connected identifier groups over every raw row of the table, later rows of an AID
   * included. An identifier the table never pairs with the other kind is in no group. */
  targetGroups: TargetGroup[];
}

/** A single compound interaction entry (drug-drug, drug-food, or chemical-target). */
export interface InteractionEntry {
  /** Interaction category. */
  kind: 'drug-drug' | 'drug-food' | 'target';
  /** Interacting compound name as DrugBank reports it, or a target's gene or protein name with
   * its identifier (the identifier alone when no name resolved). Absent for food interactions
   * and any entry where the source carries no distinct partner. */
  partner?: string;
  /** Originating source (e.g. "DrugBank", "PubChem BioAssay"). */
  source: string;
  /** The interaction statement; for a target, its assay counts and most potent active value. */
  text: string;
}

/** Where one interaction kind's page landed in that kind's source-record stream.
 *
 * Every kind is backed by an ordered stream of source records, and entries are derived from
 * them: a drug-drug row whose `descr` is empty produces no entry. So `returnedCount` counts
 * entries while `totalRecords` and `recordsConsumed` count records. A target record is one
 * molecular target, so for that kind the two are 1:1. */
export interface InteractionKindPage {
  /** Interaction category this page covers. */
  kind: 'drug-drug' | 'drug-food' | 'target';
  /** Set when a target page's name lookup failed: its entries name their identifier alone. */
  namesUnavailable?: true;
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
  /** Set when a target page's name lookup failed: its entries name their identifier alone. */
  namesUnavailable?: true;
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
  /** Kinds whose fetch failed, with the failure message. Empty when every kind resolved.
   * `reason` is set when the failure is typed: `sdq_unavailable` means PubChem's SDQ service
   * answered with something other than SDQ data — a refusal a retry does not clear. */
  failedKinds: Array<{ kind: string; message: string; reason?: 'sdq_unavailable' }>;
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
  /**
   * Human ATC codes (level 5) in first-appearance order. `levels` holds levels 1-4 top-down
   * (anatomical group → chemical subgroup); a code PubChem lists only bare, with no WHO ATC
   * hierarchy entry, carries `description: ""` and `levels: []`.
   */
  atcCodes: Array<{
    code: string;
    description: string;
    levels: Array<{ code: string; description: string }>;
  }>;
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

/** Largest signed 32-bit integer: the ceiling of PubChem's numeric IDs (CID, AID) and NCBI's
 * Gene IDs. Past it PUG REST wraps to a negative ID. */
export const MAX_INT32 = 2147483647;

/** Largest valid CID. */
export const MAX_CID = MAX_INT32;

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

/** Cross-reference types read from a PUG View heading rather than PUG REST's xrefs endpoint:
 * the depositor-attested CAS and EC numbers, one `Information` entry per source. */
export const HEADING_XREF_TYPES = ['CAS', 'EC'] as const;

export type HeadingXrefType = (typeof HEADING_XREF_TYPES)[number];

/** Supported cross-reference types. Every one but the heading types is a PUG REST xrefs type.
 *
 * `ProteinGI` stays although PubChem answers 404 "No xrefs found" for it on every compound
 * probed: PubChem still recognizes the type (an unknown one answers 400), so a request for it
 * returns data again without a code change if PubChem resumes serving it, and dropping it would
 * reject calls that pair it with a type that does return data. */
export const XREF_TYPES = [
  'RegistryID',
  'RN',
  'PubMedID',
  'PatentID',
  'GeneID',
  'ProteinGI',
  'TaxonomyID',
  ...HEADING_XREF_TYPES,
] as const;

export type XrefType = (typeof XREF_TYPES)[number];
