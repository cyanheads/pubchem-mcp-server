/**
 * @fileoverview Get detailed compound information: physicochemical properties,
 * textual descriptions, synonyms, drug-likeness assessment, and pharmacological classification.
 * @module mcp-server/tools/definitions/get-compound-details
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import type {
  CompoundClassification,
  DrugLikenessAssessment,
  DrugLikenessRule,
} from '@/services/pubchem/types.js';
import { COMPOUND_PROPERTIES, DEFAULT_PROPERTIES, MAX_CID } from '@/services/pubchem/types.js';
import {
  type CappedInput,
  capPageSize,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
  renderUnprocessed,
  splitBatch,
} from './input-caps.js';
import { inlineData, quoteData } from './untrusted-text.js';

const propertyEnum = z.enum(COMPOUND_PROPERTIES as unknown as [string, ...string[]]);

const drugLikenessRuleSchema = z.object({
  limit: z.number().describe('Rule threshold.'),
  pass: z.boolean().nullable().describe('Whether the rule passes (null if value unavailable).'),
  value: z.number().nullable().describe('Measured value (null if unavailable).'),
});

const drugLikenessSchema = z.object({
  lipinski: z
    .object({
      hba: drugLikenessRuleSchema.describe('HBond acceptor count rule (≤10).'),
      hbd: drugLikenessRuleSchema.describe('HBond donor count rule (≤5).'),
      mw: drugLikenessRuleSchema.describe('Molecular weight rule (≤500 g/mol).'),
      violations: z.number().describe('Number of Lipinski violations (0-4).'),
      xLogP: drugLikenessRuleSchema.describe('XLogP rule (≤5; calculated logP).'),
    })
    .describe('Lipinski Rule of Five evaluation.'),
  pass: z
    .boolean()
    .nullable()
    .describe('Overall drug-likeness pass. Null when insufficient properties were available.'),
  veber: z
    .object({
      rotatableBonds: drugLikenessRuleSchema.describe('Rotatable bond count rule (≤10).'),
      tpsa: drugLikenessRuleSchema.describe('Topological polar surface area rule (≤140 Å²).'),
      violations: z.number().describe('Number of Veber violations (0-2).'),
    })
    .describe('Veber rules evaluation.'),
});

const classificationSchema = z.object({
  atcCodes: z
    .array(
      z
        .object({
          code: z.string().describe('ATC level-5 (substance) code, e.g. "N02BA01".'),
          description: z
            .string()
            .describe(
              'WHO ATC name for the code, e.g. "Acetylsalicylic acid". Empty when PubChem lists the code without a WHO ATC hierarchy entry.',
            ),
          levels: z
            .array(
              z
                .object({
                  code: z.string().describe('ATC code at this level, e.g. "N02".'),
                  description: z
                    .string()
                    .describe('WHO ATC name at this level, e.g. "Analgesics".'),
                })
                .describe('One ancestor level of the code.'),
            )
            .describe(
              'Levels 1-4 of the code, top-down: anatomical main group, therapeutic subgroup, pharmacological subgroup, chemical subgroup. Empty when PubChem lists the code without a WHO ATC hierarchy entry.',
            ),
        })
        .describe('One human ATC code with its WHO hierarchy.'),
    )
    .describe(
      'Human ATC codes in the order PubChem lists them. ATCvet codes and codes named only by a WHO Essential Medicines list are excluded.',
    ),
  fdaClasses: z.array(z.string()).describe('FDA Established Pharmacologic Classes.'),
  fdaMechanisms: z.array(z.string()).describe('FDA Mechanisms of Action.'),
  meshClasses: z.array(z.string()).describe('MeSH pharmacological class descriptions.'),
});

// ── Drug-likeness computation ──────────────────────────────────────────

/** Properties needed for drug-likeness — all included in DEFAULT_PROPERTIES */
const DRUG_LIKENESS_PROPS = [
  'MolecularWeight',
  'XLogP',
  'HBondDonorCount',
  'HBondAcceptorCount',
  'TPSA',
  'RotatableBondCount',
] as const;

function evaluateRule(value: unknown, limit: number): DrugLikenessRule {
  let num: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    num = value;
  } else if (typeof value === 'string') {
    // PubChem returns some numeric properties (MolecularWeight, ExactMass, ...) as strings.
    const parsed = Number(value);
    if (Number.isFinite(parsed)) num = parsed;
  }
  if (num === null) return { limit, pass: null, value: null };
  return { limit, pass: num <= limit, value: num };
}

function computeDrugLikeness(properties: Record<string, unknown>): DrugLikenessAssessment {
  const mw = evaluateRule(properties.MolecularWeight, 500);
  const xLogP = evaluateRule(properties.XLogP, 5);
  const hbd = evaluateRule(properties.HBondDonorCount, 5);
  const hba = evaluateRule(properties.HBondAcceptorCount, 10);
  const tpsa = evaluateRule(properties.TPSA, 140);
  const rotatableBonds = evaluateRule(properties.RotatableBondCount, 10);

  const lipinskiRules = [mw, xLogP, hbd, hba];
  const veberRules = [tpsa, rotatableBonds];
  const lipinskiViolations = lipinskiRules.filter((r) => r.pass === false).length;
  const veberViolations = veberRules.filter((r) => r.pass === false).length;

  // Any null rule means the underlying property was unavailable — refuse to invent a pass/fail.
  const hasGap = [...lipinskiRules, ...veberRules].some((r) => r.pass === null);
  const pass = hasGap ? null : lipinskiViolations <= 1 && veberViolations === 0;

  return {
    lipinski: { hba, hbd, mw, violations: lipinskiViolations, xLogP },
    pass,
    veber: { rotatableBonds, tpsa, violations: veberViolations },
  };
}

/**
 * PUG View is a per-CID endpoint, so descriptions and classification fan out one request per
 * compound. The batch serves up to CIDS_CAP CIDs; this bounds that fan-out. CIDs past it come back
 * without descriptions or classification — disclosed via enrichment (#40).
 */
const PUG_VIEW_CID_CAP = 10;

/** CIDs fetched per call; CIDs past this are returned in unprocessed. */
const CIDS_CAP = 100;

/** Per-compound page sizes; a larger maxSynonyms / maxDescriptions is clamped to these. */
const MAX_SYNONYMS_CAP = 100;
const MAX_DESCRIPTIONS_CAP = 20;

// ── Tool definition ────────────────────────────────────────────────────

export const getCompoundDetails = tool('pubchem_get_compound_details', {
  title: 'Get Compound Details',
  description:
    'Get detailed compound information by CID. Returns physicochemical properties (molecular weight, SMILES, InChIKey, XLogP, TPSA, etc.), optionally with a textual description (pharmacology, mechanism, therapeutic use), known synonyms, drug-likeness assessment (Lipinski/Veber rules), and/or pharmacological classification (FDA classes, MeSH classes, ATC codes). Fetches up to 100 CIDs per call; CIDs past that are returned in unprocessed for a follow-up call.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cids: z
      .array(z.number().int().min(1).max(MAX_CID))
      .min(1)
      .max(INPUT_CEILING)
      .describe(
        `PubChem Compound IDs to fetch. The per-call cap is ${CIDS_CAP}: the first ${CIDS_CAP} are fetched, and any past that (up to ${INPUT_CEILING} in all) are returned in unprocessed, in input order, and reported in cappedInputs. Resolve from names/SMILES with pubchem_search_compounds.`,
      ),
    properties: z
      .array(propertyEnum)
      .optional()
      .describe(
        'Properties to retrieve. Defaults to a core set: MolecularFormula, MolecularWeight, IUPACName, CanonicalSMILES, IsomericSMILES, InChIKey, XLogP, TPSA, HBondDonorCount, HBondAcceptorCount, RotatableBondCount, HeavyAtomCount, Charge, Complexity.',
      ),
    includeDescription: z
      .boolean()
      .default(false)
      .describe(
        `Include textual descriptions (pharmacology, mechanism, therapeutic use) attributed by source. Well-studied compounds have many overlapping summaries — paged via descriptionOffset/maxDescriptions. Fetched only for the first ${PUG_VIEW_CID_CAP} CIDs in the batch; remaining CIDs return without descriptions and are listed in the response's skippedCids.`,
      ),
    descriptionOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Zero-based index of the first description to return within each compound's description list. The same offset is applied to every compound in the batch. Pass the nextDescriptionOffset from a previous call to read the following page. Default: 0.",
      ),
    maxDescriptions: z
      .number()
      .int()
      .min(1)
      .max(INPUT_CEILING)
      .default(3)
      .describe(
        `Max number of distinct description entries per compound per page. The per-call cap is ${MAX_DESCRIPTIONS_CAP}: a larger value (up to ${INPUT_CEILING}) returns ${MAX_DESCRIPTIONS_CAP} per compound and is reported in cappedInputs. PubChem returns near-duplicate summaries from many depositors; duplicates are collapsed before this cap applies. Default: 3.`,
      ),
    includeSynonyms: z
      .boolean()
      .default(false)
      .describe(
        'Fetch known names and synonyms (trade names, systematic names, registry numbers), paged via synonymOffset/maxSynonyms. Fetched for every found CID in the batch. Slower for large CID lists.',
      ),
    synonymOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Zero-based index of the first synonym to return within each compound's synonym list. The same offset is applied to every compound in the batch. Pass the nextSynonymOffset from a previous call to read the following page. Default: 0.",
      ),
    maxSynonyms: z
      .number()
      .int()
      .min(1)
      .max(INPUT_CEILING)
      .default(20)
      .describe(
        `Max synonyms returned per compound per page. The per-call cap is ${MAX_SYNONYMS_CAP}: a larger value (up to ${INPUT_CEILING}) returns ${MAX_SYNONYMS_CAP} per compound and is reported in cappedInputs. PubChem lists hundreds for common drugs; use synonymOffset to reach the ones past this page. Default: 20.`,
      ),
    includeDrugLikeness: z
      .boolean()
      .default(false)
      .describe(
        'Compute drug-likeness assessment: Lipinski Rule of Five (MW, XLogP, HBD, HBA) and Veber rules (TPSA, rotatable bonds). Computed from the returned properties, so it adds no latency.',
      ),
    includeClassification: z
      .boolean()
      .default(false)
      .describe(
        `Include pharmacological classification: FDA Established Pharmacologic Classes, mechanisms of action, MeSH classes, and ATC codes. Fetched only for the first ${PUG_VIEW_CID_CAP} CIDs in the batch; remaining CIDs return without classification and are listed in the response's skippedCids.`,
      ),
  }),
  output: z.object({
    compounds: z
      .array(
        z
          .object({
            cid: z.number().describe('PubChem Compound ID.'),
            found: z
              .boolean()
              .describe(
                'False when the CID does not exist in PubChem (properties, description, etc. are empty).',
              ),
            properties: z
              .record(z.string(), z.unknown())
              .describe(
                'Physicochemical properties keyed by name (echoes input.properties or the default core set; drug-likeness inputs are appended automatically when includeDrugLikeness is true).',
              ),
            descriptions: z
              .array(
                z
                  .object({
                    source: z
                      .string()
                      .optional()
                      .describe('Depositor source (e.g. "DrugBank", "Wikipedia", "ChEBI").'),
                    text: z.string().describe('Description text.'),
                  })
                  .describe('Description entry with optional source attribution.'),
              )
              .optional()
              .describe(
                'Textual descriptions on this page, deduplicated then windowed by descriptionOffset/maxDescriptions. Each entry carries optional source attribution. Empty when descriptionOffset runs past descriptionsTotal.',
              ),
            descriptionsTotal: z
              .number()
              .optional()
              .describe(
                'Total distinct descriptions available for this compound, across all pages. Larger than descriptions.length when more sources exist — raise maxDescriptions or page with descriptionOffset to see them.',
              ),
            synonyms: z
              .array(z.string())
              .optional()
              .describe(
                'Known names and synonyms on this page, windowed by synonymOffset/maxSynonyms. Empty when synonymOffset runs past synonymsTotal.',
              ),
            synonymsTotal: z
              .number()
              .optional()
              .describe(
                'Total synonyms available for this compound, across all pages. Larger than synonyms.length when more exist — raise maxSynonyms or page with synonymOffset to see them.',
              ),
            drugLikeness: drugLikenessSchema
              .optional()
              .describe(
                'Drug-likeness assessment. lipinski.violations ≤ 1 and veber.violations = 0 → pass.',
              ),
            classification: classificationSchema
              .optional()
              .describe('Pharmacological classification (FDA, MeSH, ATC).'),
          })
          .describe('Per-CID compound detail record.'),
      )
      .describe(
        'Compound detail records, one per CID fetched, in input order. CIDs past the per-call cap are in unprocessed instead.',
      ),
    unprocessed: z
      .array(z.number())
      .optional()
      .describe(
        `CIDs past the per-call cap of ${CIDS_CAP}, in input order, not fetched. Pass them in a follow-up call. Omitted when every CID was fetched.`,
      ),
  }),
  // Agent-facing context for the two things a per-compound record cannot say on its own:
  // which CIDs the PUG View fan-out reached (#40), and where the synonym/description windows
  // sit within each compound's full list (#38). Both are batch-wide — one offset and one cap
  // apply to every compound — so they belong here rather than repeated per record. Reaches
  // structuredContent and content[]; keys disjoint from output (compounds lives there).
  //
  // A full page is exactly maxSynonyms/maxDescriptions long, so one nextOffset serves every
  // compound that still has entries left, whatever its individual total.
  enrichment: {
    enrichedCids: z
      .array(z.number())
      .optional()
      .describe(
        'CIDs whose descriptions and classification were fetched. Present only when the batch exceeded the per-call fan-out limit and other CIDs were skipped.',
      ),
    skippedCids: z
      .array(z.number())
      .optional()
      .describe(
        'CIDs found in PubChem whose descriptions and classification were NOT fetched because the batch exceeded the per-call fan-out limit. Their absence from a record means "not requested", not "PubChem has none" — re-request these CIDs in a follow-up call. Present only when CIDs were skipped.',
      ),
    synonymOffset: z
      .number()
      .optional()
      .describe(
        "Zero-based index of the first synonym returned within each compound's list. Present when includeSynonyms is true.",
      ),
    nextSynonymOffset: z
      .number()
      .optional()
      .describe(
        'synonymOffset to pass on the next call to continue past this page. Omitted when no compound in the batch has further synonyms.',
      ),
    descriptionOffset: z
      .number()
      .optional()
      .describe(
        "Zero-based index of the first description returned within each compound's list. Present when includeDescription is true.",
      ),
    nextDescriptionOffset: z
      .number()
      .optional()
      .describe(
        'descriptionOffset to pass on the next call to continue past this page. Omitted when no compound in the batch has further descriptions.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when this response is not the whole picture: a compound has further synonyms or descriptions past this page, CIDs were skipped by the per-call fan-out limit, or CIDs past the per-call cap were left unfetched. Per-compound totals are in compounds[].synonymsTotal / compounds[].descriptionsTotal; the skipped CIDs are in skippedCids, the unfetched ones in unprocessed.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance covering the skipped CIDs, an offset that runs past every compound, and pages that remain. Absent when nothing was skipped or truncated.',
      ),
    cappedInputs: cappedInputsField,
  },
  // Both fields are optional, so `render` sees `number[] | undefined` at the type level; the
  // framework only calls it for a populated field.
  enrichmentTrailer: {
    enrichedCids: {
      render: (cids) =>
        `**Descriptions/classification fetched for:** CID ${(cids ?? []).join(', ')}`,
    },
    skippedCids: {
      render: (cids) =>
        `**Descriptions/classification skipped for:** CID ${(cids ?? []).join(', ')}`,
    },
    cappedInputs: { render: renderCappedInputs },
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const requestedProps = input.properties ?? [...DEFAULT_PROPERTIES];

    // Clamp in schema order so cappedInputs lists inputs as declared. A page size is clamped
    // (and reported) only when its list is fetched — otherwise it has no effect.
    const capped: CappedInput[] = [];
    const { served: cids, unprocessed } = splitBatch('cids', input.cids, CIDS_CAP, capped);
    const maxDescriptions = input.includeDescription
      ? capPageSize('maxDescriptions', input.maxDescriptions, MAX_DESCRIPTIONS_CAP, capped)
      : input.maxDescriptions;
    const maxSynonyms = input.includeSynonyms
      ? capPageSize('maxSynonyms', input.maxSynonyms, MAX_SYNONYMS_CAP, capped)
      : input.maxSynonyms;

    // Ensure drug-likeness properties are fetched when needed
    let props = requestedProps;
    if (input.includeDrugLikeness) {
      const propsSet = new Set(requestedProps);
      const missing = DRUG_LIKENESS_PROPS.filter((p) => !propsSet.has(p));
      if (missing.length > 0) props = [...requestedProps, ...missing];
    }

    // Batch property fetch
    const propertyRows = await client.getProperties(cids, props, ctx.signal);
    const propsMap = new Map(propertyRows.map((r) => [r.CID, r]));

    // PubChem returns HTTP 200 with `{CID: x}` and no other fields for nonexistent CIDs.
    // Treat a row with only the CID key as not-found.
    const isFound = (cid: number): boolean => {
      const row = propsMap.get(cid);
      if (!row) return false;
      return Object.keys(row).some((k) => k !== 'CID');
    };

    // PUG View calls (per-CID, capped) — skip CIDs that aren't in PubChem
    const foundCids = cids.filter(isFound);
    const viewCids = foundCids.slice(0, PUG_VIEW_CID_CAP);
    const skippedViewCids = foundCids.slice(PUG_VIEW_CID_CAP);
    const viewCapEngaged =
      (input.includeDescription || input.includeClassification) && skippedViewCids.length > 0;
    if (viewCapEngaged) {
      ctx.log.info('PUG View fetch capped', {
        cap: PUG_VIEW_CID_CAP,
        requested: foundCids.length,
        fetching: viewCids.length,
      });
    }

    // Optional: descriptions — deduped by client, capped here.
    let descMap: Map<number, Array<{ source?: string; text: string }>> | undefined;
    if (input.includeDescription) {
      const entries = await Promise.all(
        viewCids.map(async (cid) => [cid, await client.getDescription(cid, ctx.signal)] as const),
      );
      descMap = new Map(entries.filter((e) => e[1].length > 0));
    }

    // Optional: synonyms (per-CID) — skip CIDs that aren't in PubChem
    let synMap: Map<number, string[]> | undefined;
    if (input.includeSynonyms) {
      const entries = await Promise.all(
        foundCids.map(async (cid) => [cid, await client.getSynonyms(cid, ctx.signal)] as const),
      );
      synMap = new Map(entries.filter((e): e is [number, string[]] => e[1].length > 0));
    }

    // Optional: classification
    let classMap: Map<number, CompoundClassification> | undefined;
    if (input.includeClassification) {
      const entries = await Promise.all(
        viewCids.map(
          async (cid) => [cid, await client.getClassification(cid, ctx.signal)] as const,
        ),
      );
      classMap = new Map(
        entries.filter((e): e is [number, CompoundClassification] => e[1] !== null),
      );
    }

    ctx.log.info('Details fetched', {
      cids: cids.length,
      unprocessed: unprocessed.length,
      withDescription: input.includeDescription,
      withSynonyms: input.includeSynonyms,
      withDrugLikeness: input.includeDrugLikeness,
      withClassification: input.includeClassification,
    });

    const compounds = cids.map((cid) => {
      const found = isFound(cid);
      const { CID: _CID, ...properties } = propsMap.get(cid) ?? { CID: cid };

      const compound: {
        cid: number;
        classification?: CompoundClassification;
        descriptions?: Array<{ source?: string; text: string }>;
        descriptionsTotal?: number;
        drugLikeness?: DrugLikenessAssessment;
        found: boolean;
        properties: Record<string, unknown>;
        synonyms?: string[];
        synonymsTotal?: number;
      } = { cid, found, properties };

      // Skip enrichment for CIDs not in PubChem — properties is already empty.
      if (!found) return compound;

      const allDescs = descMap?.get(cid);
      if (allDescs && allDescs.length > 0) {
        compound.descriptions = allDescs.slice(
          input.descriptionOffset,
          input.descriptionOffset + maxDescriptions,
        );
        compound.descriptionsTotal = allDescs.length;
      }
      const syns = synMap?.get(cid);
      if (syns) {
        compound.synonyms = syns.slice(input.synonymOffset, input.synonymOffset + maxSynonyms);
        compound.synonymsTotal = syns.length;
      }
      if (input.includeDrugLikeness) compound.drugLikeness = computeDrugLikeness(properties);
      const cls = classMap?.get(cid);
      if (cls) compound.classification = cls;

      return compound;
    });

    const notices: string[] = [];
    // One depth-0 signal for "you are not seeing everything" — the per-compound totals and
    // the skipped-CID list say which part is missing.
    let truncated = false;

    // #40 — the PUG View fan-out cap is otherwise invisible: a capped-out CID looks exactly
    // like a compound PubChem has no description for.
    if (viewCapEngaged) {
      truncated = true;
      ctx.enrich({ enrichedCids: viewCids, skippedCids: skippedViewCids });
      notices.push(
        `Descriptions and classification were fetched for the first ${viewCids.length} of ${foundCids.length} found CIDs (limit: ${PUG_VIEW_CID_CAP} per call). CID ${skippedViewCids.join(', ')} returned without them — re-request those CIDs in a follow-up call.`,
      );
    }

    if (input.includeSynonyms) {
      const page = listPage(
        [...(synMap?.values() ?? [])].map((s) => s.length),
        input.synonymOffset,
        maxSynonyms,
      );
      ctx.enrich({ synonymOffset: input.synonymOffset });
      if (page.hasMore) {
        truncated = true;
        ctx.enrich({ nextSynonymOffset: page.nextOffset });
      }
      if (page.allEmpty) {
        notices.push(
          `synonymOffset ${input.synonymOffset} is past every compound in this batch — the longest synonym list has ${page.largestTotal} entries. Pass a synonymOffset below ${page.largestTotal}.`,
        );
      } else if (page.hasMore) {
        notices.push(`More synonyms remain — pass synonymOffset=${page.nextOffset} to continue.`);
      }
    }

    if (input.includeDescription) {
      const page = listPage(
        [...(descMap?.values() ?? [])].map((d) => d.length),
        input.descriptionOffset,
        maxDescriptions,
      );
      ctx.enrich({ descriptionOffset: input.descriptionOffset });
      if (page.hasMore) {
        truncated = true;
        ctx.enrich({ nextDescriptionOffset: page.nextOffset });
      }
      if (page.allEmpty) {
        notices.push(
          `descriptionOffset ${input.descriptionOffset} is past every compound in this batch — the longest description list has ${page.largestTotal} entries. Pass a descriptionOffset below ${page.largestTotal}.`,
        );
      } else if (page.hasMore) {
        notices.push(
          `More descriptions remain — pass descriptionOffset=${page.nextOffset} to continue.`,
        );
      }
    }

    if (unprocessed.length > 0) truncated = true;
    ctx.enrich({ truncated });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });

    // One notice field, so the sources are composed rather than overwriting one another.
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return unprocessed.length > 0 ? { compounds, unprocessed } : { compounds };
  },

  format(result) {
    const blocks: string[] = [];

    for (const c of result.compounds) {
      if (!c.found) {
        blocks.push(`## CID ${c.cid} — not found in PubChem`, '');
        continue;
      }

      const p = c.properties as Record<string, unknown>;
      const name = (p.IUPACName as string) ?? (p.Title as string) ?? '';
      const header = name
        ? `## CID ${c.cid} — ${inlineData(name)} (found)`
        : `## CID ${c.cid} (found)`;
      blocks.push(header);

      const lines: string[] = ['**Properties:**'];

      // Key identifiers
      if (p.MolecularFormula) lines.push(`**Formula:** ${p.MolecularFormula}`);
      const mw = p.MolecularWeight;
      if (mw != null) lines.push(`**MW:** ${mw} g/mol`);
      if (p.CanonicalSMILES) lines.push(`**SMILES:** ${p.CanonicalSMILES}`);
      if (p.IsomericSMILES && p.IsomericSMILES !== p.CanonicalSMILES) {
        lines.push(`**Isomeric SMILES:** ${p.IsomericSMILES}`);
      }
      if (p.InChIKey) lines.push(`**InChIKey:** ${p.InChIKey}`);

      // Drug-likeness properties
      const drugProps: string[] = [];
      if (p.XLogP != null) drugProps.push(`XLogP: ${p.XLogP}`);
      if (p.TPSA != null) drugProps.push(`TPSA: ${p.TPSA}`);
      if (p.Complexity != null) drugProps.push(`Complexity: ${p.Complexity}`);
      if (drugProps.length > 0) lines.push(`**Descriptors:** ${drugProps.join(' | ')}`);

      // Atom/bond counts
      const counts: string[] = [];
      if (p.HBondDonorCount != null) counts.push(`HBD: ${p.HBondDonorCount}`);
      if (p.HBondAcceptorCount != null) counts.push(`HBA: ${p.HBondAcceptorCount}`);
      if (p.RotatableBondCount != null) counts.push(`Rotatable: ${p.RotatableBondCount}`);
      if (p.HeavyAtomCount != null) counts.push(`Heavy: ${p.HeavyAtomCount}`);
      if (p.Charge != null && p.Charge !== 0) counts.push(`Charge: ${p.Charge}`);
      if (counts.length > 0) lines.push(`**Counts:** ${counts.join(' | ')}`);

      // Remaining properties not already shown
      const shown = new Set([
        'MolecularFormula',
        'MolecularWeight',
        'CanonicalSMILES',
        'IsomericSMILES',
        'InChIKey',
        'IUPACName',
        'Title',
        'XLogP',
        'TPSA',
        'Complexity',
        'HBondDonorCount',
        'HBondAcceptorCount',
        'RotatableBondCount',
        'HeavyAtomCount',
        'Charge',
      ]);
      const extra = Object.entries(p).filter(([k]) => !shown.has(k));
      if (extra.length > 0) {
        lines.push(extra.map(([k, v]) => `**${k}:** ${v}`).join(' | '));
      }

      blocks.push(lines.join('\n'));

      // Drug-likeness assessment
      if (c.drugLikeness) {
        const dl = c.drugLikeness;
        const status = dl.pass === null ? 'N/A (insufficient data)' : dl.pass ? 'PASS' : 'FAIL';
        lines.length = 0;
        lines.push(`\n**Drug-likeness:** ${status}`);
        lines.push(
          `  Lipinski (${dl.lipinski.violations}/4 violations): ` +
            formatRules([
              ['MW', dl.lipinski.mw],
              ['XLogP', dl.lipinski.xLogP],
              ['HBD', dl.lipinski.hbd],
              ['HBA', dl.lipinski.hba],
            ]),
        );
        lines.push(
          `  Veber (${dl.veber.violations}/2 violations): ` +
            formatRules([
              ['TPSA', dl.veber.tpsa],
              ['RotBonds', dl.veber.rotatableBonds],
            ]),
        );
        blocks.push(lines.join('\n'));
      }

      // Classification
      if (c.classification) {
        const cls = c.classification;
        lines.length = 0;
        lines.push('\n**Classification:**');
        if (cls.fdaClasses.length > 0) lines.push(`  FDA: ${cls.fdaClasses.join(', ')}`);
        if (cls.fdaMechanisms.length > 0) lines.push(`  MoA: ${cls.fdaMechanisms.join(', ')}`);
        /**
         * MeSH classes render in full — structuredContent carries the whole list uncapped.
         * Each value is a multi-sentence scope note that routinely contains both "; " and
         * ", ", so no inline separator can mark an entry boundary unambiguously. One entry
         * per line instead: inlineData collapses embedded newlines, so a value cannot forge
         * a bullet of its own and the line break is an unforgeable entry boundary.
         */
        if (cls.meshClasses.length > 0) {
          lines.push('  MeSH:');
          for (const meshClass of cls.meshClasses) lines.push(`    - ${inlineData(meshClass)}`);
        }
        /** One code per line, its hierarchy top-down: WHO level names carry commas
         * ("Systemic hormonal preparations, excl. sex hormones and insulins"). */
        if (cls.atcCodes.length > 0) {
          lines.push('  ATC:');
          for (const atc of cls.atcCodes) {
            const path = [...atc.levels, atc]
              .filter((level) => level.description)
              .map((level) => `${level.code} ${inlineData(level.description)}`)
              .join(' > ');
            lines.push(`    - ${atc.code}${path ? `: ${path}` : ''}`);
          }
        }
        blocks.push(lines.join('\n'));
      }

      // An empty list with a non-zero total means the offset ran past this compound —
      // distinct from having no descriptions at all, which omits the field entirely.
      if (c.descriptions?.length === 0) {
        blocks.push(
          `\n**Descriptions** (${c.descriptionsTotal ?? 0} total): none at this descriptionOffset`,
        );
      }

      // Descriptions (with source attribution; windowed by descriptionOffset/maxDescriptions)
      if (c.descriptions && c.descriptions.length > 0) {
        const total = c.descriptionsTotal ?? c.descriptions.length;
        const shown = c.descriptions.length;
        const header =
          total > shown
            ? `\n**Descriptions** (showing ${shown} of ${total} total)`
            : `\n**Descriptions** (${total} total)`;
        const descLines: string[] = [header];
        for (const d of c.descriptions) {
          // Upstream free text — render the statement as a blockquote data block
          // so it reads as retrieved data, not server instructions.
          const label = d.source
            ? `**Description (${inlineData(d.source)}):**`
            : '**Description:**';
          descLines.push(`${label}\n${quoteData(d.text)}`);
        }
        const more = total - shown;
        if (more > 0) {
          descLines.push(
            `_+${more} more description${more === 1 ? '' : 's'} from other sources — raise maxDescriptions or page with descriptionOffset to see them._`,
          );
        }
        blocks.push(descLines.join('\n\n'));
      }

      if (c.synonyms?.length === 0) {
        blocks.push(`\n**Synonyms** (${c.synonymsTotal ?? 0} total): none at this synonymOffset`);
      }

      // Synonyms (windowed by synonymOffset/maxSynonyms in the handler; total reported)
      if (c.synonyms && c.synonyms.length > 0) {
        const total = c.synonymsTotal ?? c.synonyms.length;
        const more = total - c.synonyms.length;
        const suffix = more > 0 ? ` (+${more} more not on this page)` : '';
        /**
         * Pipe-separated: CAS-style inverted names ("Benzoic acid, 2-(acetyloxy)-") carry
         * their own ", ", which would split one synonym into two. " | " is this formatter's
         * existing inline multi-value separator. A bare "|" does turn up in depositor
         * synonyms as mangled Greek letters ("17|A-Oestradiol"), so the delimiter is the
         * space-padded form; that exact sequence was absent from every synonym sampled,
         * but unlike the MeSH line break it is a rare-collision separator, not a proof.
         */
        const syns = c.synonyms.map(inlineData).join(' | ');
        blocks.push(`\n**Synonyms** (${total} total): ${syns}${suffix}`);
      }

      blocks.push('');
    }

    if (result.unprocessed && result.unprocessed.length > 0) {
      blocks.push(renderUnprocessed(result.unprocessed));
    }

    return [{ type: 'text', text: blocks.join('\n') }];
  },
});

/**
 * Batch-wide page state for one of the per-compound lists. `totals` holds each compound's
 * full list length; a page is windowed at the same offset and cap for every compound.
 */
function listPage(
  totals: number[],
  offset: number,
  cap: number,
): { allEmpty: boolean; hasMore: boolean; largestTotal: number; nextOffset: number } {
  const largestTotal = totals.reduce((max, t) => Math.max(max, t), 0);
  return {
    allEmpty: largestTotal > 0 && totals.every((t) => t <= offset),
    hasMore: totals.some((t) => t > offset + cap),
    largestTotal,
    nextOffset: offset + cap,
  };
}

function formatRules(rules: Array<[string, DrugLikenessRule]>): string {
  return rules
    .map(([label, r]) => {
      if (r.pass === null) return `${label}: N/A`;
      const icon = r.pass ? 'ok' : 'FAIL';
      return `${label}: ${r.value}/${r.limit} ${icon}`;
    })
    .join(' | ');
}
