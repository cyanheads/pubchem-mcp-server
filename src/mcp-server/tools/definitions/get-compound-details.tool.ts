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
import { COMPOUND_PROPERTIES, DEFAULT_PROPERTIES } from '@/services/pubchem/types.js';

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
      mw: drugLikenessRuleSchema.describe('Molecular weight rule (≤500).'),
      violations: z.number().describe('Number of Lipinski violations (0-4).'),
      xLogP: drugLikenessRuleSchema.describe('XLogP rule (≤5).'),
    })
    .describe('Lipinski Rule of Five evaluation.'),
  pass: z.boolean().describe('Overall drug-likeness pass.'),
  veber: z
    .object({
      rotatableBonds: drugLikenessRuleSchema.describe('Rotatable bond count rule (≤10).'),
      tpsa: drugLikenessRuleSchema.describe('TPSA rule (≤140).'),
      violations: z.number().describe('Number of Veber violations (0-2).'),
    })
    .describe('Veber rules evaluation.'),
});

const classificationSchema = z.object({
  atcCodes: z
    .array(
      z.object({
        code: z.string().describe('ATC code.'),
        description: z.string().describe('ATC code description.'),
      }),
    )
    .describe('ATC codes with hierarchical descriptions.'),
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
  if (value == null || typeof value !== 'number') return { limit, pass: null, value: null };
  return { limit, pass: value <= limit, value };
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

  return {
    lipinski: { hba, hbd, mw, violations: lipinskiViolations, xLogP },
    pass: lipinskiViolations <= 1 && veberViolations === 0,
    veber: { rotatableBonds, tpsa, violations: veberViolations },
  };
}

// ── Tool definition ────────────────────────────────────────────────────

export const getCompoundDetails = tool('pubchem_get_compound_details', {
  title: 'Get Compound Details',
  description:
    'Get detailed compound information by CID. Returns physicochemical properties ' +
    '(molecular weight, SMILES, InChIKey, XLogP, TPSA, etc.), optionally with a textual ' +
    'description (pharmacology, mechanism, therapeutic use), all known synonyms, ' +
    'drug-likeness assessment (Lipinski/Veber rules), and/or pharmacological classification ' +
    '(FDA classes, MeSH classes, ATC codes). Efficiently batches up to 100 CIDs.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cids: z
      .array(z.number().int().positive())
      .min(1)
      .max(100)
      .describe('PubChem Compound IDs to fetch (1-100). Batched efficiently.'),
    properties: z
      .array(propertyEnum)
      .optional()
      .describe(
        'Properties to retrieve. Defaults to a core set: MolecularFormula, MolecularWeight, ' +
          'IUPACName, CanonicalSMILES, IsomericSMILES, InChIKey, XLogP, TPSA, HBondDonorCount, ' +
          'HBondAcceptorCount, RotatableBondCount, HeavyAtomCount, Charge, Complexity.',
      ),
    includeDescription: z
      .boolean()
      .default(false)
      .describe(
        'Fetch textual description from PUG View (pharmacology, mechanism, therapeutic use). ' +
          'Adds one API call per CID — consider limiting CID count when enabled.',
      ),
    includeSynonyms: z
      .boolean()
      .default(false)
      .describe(
        'Fetch all known names and synonyms (trade names, systematic names, registry numbers).',
      ),
    includeDrugLikeness: z
      .boolean()
      .default(false)
      .describe(
        'Compute drug-likeness assessment: Lipinski Rule of Five (MW, XLogP, HBD, HBA) and ' +
          'Veber rules (TPSA, rotatable bonds). No extra API calls — computed from properties.',
      ),
    includeClassification: z
      .boolean()
      .default(false)
      .describe(
        'Fetch pharmacological classification from PUG View: FDA Established Pharmacologic ' +
          'Classes, mechanisms of action, MeSH classes, and ATC codes. ' +
          'Adds one API call per CID — consider limiting CID count when enabled.',
      ),
  }),
  output: z.object({
    compounds: z
      .array(
        z.object({
          cid: z.number().describe('PubChem Compound ID.'),
          properties: z
            .record(z.string(), z.unknown())
            .describe('Requested physicochemical properties.'),
          description: z.string().optional().describe('Textual description from PUG View.'),
          synonyms: z.array(z.string()).optional().describe('Known names and synonyms.'),
          drugLikeness: drugLikenessSchema
            .optional()
            .describe(
              'Drug-likeness assessment. lipinski.violations ≤ 1 and veber.violations = 0 → pass.',
            ),
          classification: classificationSchema
            .optional()
            .describe('Pharmacological classification (FDA, MeSH, ATC).'),
        }),
      )
      .describe('Compound detail records.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const requestedProps = input.properties ?? [...DEFAULT_PROPERTIES];

    // Ensure drug-likeness properties are fetched when needed
    let props = requestedProps;
    if (input.includeDrugLikeness) {
      const propsSet = new Set(requestedProps);
      const missing = DRUG_LIKENESS_PROPS.filter((p) => !propsSet.has(p));
      if (missing.length > 0) props = [...requestedProps, ...missing];
    }

    // Batch property fetch
    const propertyRows = await client.getProperties(input.cids, props);
    const propsMap = new Map(propertyRows.map((r) => [r.CID, r]));

    // PUG View calls (per-CID, capped at 10)
    const viewCids = input.cids.slice(0, 10);
    if (
      (input.includeDescription || input.includeClassification) &&
      viewCids.length < input.cids.length
    ) {
      ctx.log.info('PUG View fetch capped at 10 CIDs', {
        requested: input.cids.length,
        fetching: viewCids.length,
      });
    }

    // Optional: descriptions
    let descMap: Map<number, string> | undefined;
    if (input.includeDescription) {
      const entries = await Promise.all(
        viewCids.map(async (cid) => [cid, await client.getDescription(cid)] as const),
      );
      descMap = new Map(entries.filter((e): e is [number, string] => e[1] !== null));
    }

    // Optional: synonyms (per-CID)
    let synMap: Map<number, string[]> | undefined;
    if (input.includeSynonyms) {
      const entries = await Promise.all(
        input.cids.map(async (cid) => [cid, await client.getSynonyms(cid)] as const),
      );
      synMap = new Map(entries.filter((e): e is [number, string[]] => e[1].length > 0));
    }

    // Optional: classification
    let classMap: Map<number, CompoundClassification> | undefined;
    if (input.includeClassification) {
      const entries = await Promise.all(
        viewCids.map(async (cid) => [cid, await client.getClassification(cid)] as const),
      );
      classMap = new Map(
        entries.filter((e): e is [number, CompoundClassification] => e[1] !== null),
      );
    }

    ctx.log.info('Details fetched', {
      cids: input.cids.length,
      withDescription: input.includeDescription,
      withSynonyms: input.includeSynonyms,
      withDrugLikeness: input.includeDrugLikeness,
      withClassification: input.includeClassification,
    });

    const compounds = input.cids.map((cid) => {
      const rawProps = propsMap.get(cid) ?? {};
      const properties = { ...rawProps };
      delete (properties as Record<string, unknown>).CID;

      const compound: {
        cid: number;
        classification?: CompoundClassification;
        description?: string;
        drugLikeness?: DrugLikenessAssessment;
        properties: Record<string, unknown>;
        synonyms?: string[];
      } = { cid, properties };

      const desc = descMap?.get(cid);
      if (desc) compound.description = desc;
      const syns = synMap?.get(cid);
      if (syns) compound.synonyms = syns;
      if (input.includeDrugLikeness) compound.drugLikeness = computeDrugLikeness(properties);
      const cls = classMap?.get(cid);
      if (cls) compound.classification = cls;

      return compound;
    });

    return { compounds };
  },

  format(result) {
    const blocks: string[] = [];

    for (const c of result.compounds) {
      const p = c.properties as Record<string, unknown>;
      const name = (p.IUPACName as string) ?? (p.Title as string) ?? '';
      const header = name ? `## CID ${c.cid} — ${name}` : `## CID ${c.cid}`;
      blocks.push(header);

      const lines: string[] = [];

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
      if (drugProps.length > 0) lines.push(`**Properties:** ${drugProps.join(' | ')}`);

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
        const status = dl.pass ? 'PASS' : 'FAIL';
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
        if (cls.meshClasses.length > 0) {
          const meshDisplay =
            cls.meshClasses.length > 3
              ? `${cls.meshClasses.slice(0, 3).join('; ')} (+${cls.meshClasses.length - 3} more)`
              : cls.meshClasses.join('; ');
          lines.push(`  MeSH: ${meshDisplay}`);
        }
        if (cls.atcCodes.length > 0) {
          const atcDisplay = cls.atcCodes
            .map((a) => (a.description ? `${a.code} (${a.description})` : a.code))
            .join(', ');
          lines.push(`  ATC: ${atcDisplay}`);
        }
        blocks.push(lines.join('\n'));
      }

      // Description
      if (c.description) {
        blocks.push(`\n> ${c.description.replace(/\n/g, '\n> ')}`);
      }

      // Synonyms
      if (c.synonyms && c.synonyms.length > 0) {
        const synShown = c.synonyms.slice(0, 20);
        const more = c.synonyms.length > 20 ? ` (+${c.synonyms.length - 20} more)` : '';
        blocks.push(`\n**Synonyms:** ${synShown.join(', ')}${more}`);
      }

      blocks.push('');
    }

    return [{ type: 'text', text: blocks.join('\n') }];
  },
});

function formatRules(rules: Array<[string, DrugLikenessRule]>): string {
  return rules
    .map(([label, r]) => {
      if (r.pass === null) return `${label}: N/A`;
      const icon = r.pass ? 'ok' : 'FAIL';
      return `${label}: ${r.value}/${r.limit} ${icon}`;
    })
    .join(' | ');
}
