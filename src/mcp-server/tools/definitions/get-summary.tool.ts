/**
 * @fileoverview Get descriptive summaries for PubChem entities: assays, genes,
 * proteins, pathways, taxonomy, cell lines, or substances.
 * @module mcp-server/tools/definitions/get-summary
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

const entityTypeEnum = z.enum(['assay', 'gene', 'protein', 'taxonomy']);

type EntityType = z.infer<typeof entityTypeEnum>;

/**
 * Union-of-shapes schema for entity summaries. All fields are optional because the
 * set of populated fields depends on entityType (assay/gene/protein/taxonomy).
 * Fields absent from the upstream response are omitted entirely rather than filled
 * with empty strings or zeros.
 */
const entitySummaryDataSchema = z.object({
  aid: z.number().optional().describe('Assay ID — present on assay summaries.'),
  name: z.string().optional().describe('Primary display name.'),
  description: z.string().optional().describe('Descriptive text when available.'),
  sourceName: z.string().optional().describe('Data source attribution (assay summaries).'),
  numSubstances: z.number().optional().describe('Substances tested (assay summaries).'),
  numActive: z.number().optional().describe('Substances marked active (assay summaries).'),
  geneId: z.number().optional().describe('NCBI Gene ID (gene summaries).'),
  symbol: z.string().optional().describe('Gene symbol (gene summaries).'),
  taxonomyId: z.number().optional().describe('NCBI Taxonomy ID (gene/protein/taxonomy summaries).'),
  taxonomy: z.string().optional().describe('Taxonomy scientific name (gene/protein summaries).'),
  synonyms: z.array(z.string()).optional().describe('Known synonyms / other names.'),
  proteinAccession: z.string().optional().describe('Protein accession (protein summaries).'),
  scientificName: z.string().optional().describe('Scientific name (taxonomy summaries).'),
  commonName: z.string().optional().describe('Common name (taxonomy summaries).'),
  rank: z.string().optional().describe('Taxonomic rank (taxonomy summaries).'),
  lineage: z.array(z.string()).optional().describe('Parent taxonomy lineage (taxonomy summaries).'),
});

type EntitySummaryData = z.infer<typeof entitySummaryDataSchema>;

export const getSummary = tool('pubchem_get_summary', {
  title: 'Get Entity Summary',
  description:
    'Get descriptive summaries for PubChem entities by ID. Supports assays (AID), genes (Gene ID), ' +
    'proteins (UniProt accession), and taxonomy (Tax ID). Up to 10 per call.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    entityType: entityTypeEnum.describe('Entity type. Determines ID format and returned fields.'),
    identifiers: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .max(10)
      .describe(
        'Entity identifiers (1-10). Type depends on entityType:\n' +
          '- assay: AID (number), e.g. [1000]\n' +
          '- gene: Gene ID (number), e.g. [1956]\n' +
          '- protein: UniProt accession (string), e.g. ["P00533"]\n' +
          '- taxonomy: Tax ID (number), e.g. [9606]',
      ),
  }),
  output: z.object({
    entityType: z.string().describe('Entity type queried.'),
    summaries: z
      .array(
        z.object({
          identifier: z.union([z.string(), z.number()]).describe('Queried identifier.'),
          found: z.boolean().describe('Whether the entity was found.'),
          data: entitySummaryDataSchema
            .optional()
            .describe('Entity summary data. Populated fields depend on entityType.'),
        }),
      )
      .describe('Summary results.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();

    const summaries = await Promise.all(
      input.identifiers.map(async (id) => {
        const raw = await client.getEntitySummary(input.entityType, id);
        if (!raw) return { identifier: id, found: false as const };

        const data = extractSummary(input.entityType, raw);
        return { identifier: id, found: true as const, data };
      }),
    );

    ctx.log.info('Summaries fetched', {
      entityType: input.entityType,
      requested: input.identifiers.length,
      found: summaries.filter((s) => s.found).length,
    });

    return { entityType: input.entityType, summaries };
  },

  format(result) {
    const lines: string[] = [`## ${capitalize(result.entityType)} Summaries`, ''];

    for (const s of result.summaries) {
      if (!s.found || !s.data) {
        lines.push(`**${s.identifier}** — not found`);
        lines.push('');
        continue;
      }

      const d = s.data;
      lines.push(`**${d.name ?? d.symbol ?? s.identifier}**`);

      for (const [key, value] of Object.entries(d)) {
        if (value == null || key === 'name' || key === 'symbol') continue;
        if (Array.isArray(value)) {
          if (value.length === 0) continue;
          const display =
            value.length > 10
              ? `${value.slice(0, 10).join(', ')} (+${value.length - 10} more)`
              : value.join(', ');
          lines.push(`  ${formatKey(key)}: ${display}`);
        } else {
          lines.push(`  ${formatKey(key)}: ${value}`);
        }
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ── Summary extraction per entity type ──────────────────────────────

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return;
}

function toStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const joined = v.filter((x) => typeof x === 'string').join('\n');
    return joined.length > 0 ? joined : undefined;
  }
  return;
}

function toStrArr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.map((x) => (typeof x === 'string' ? x : String(x))).filter((s) => s.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof v === 'string' && v.length > 0) return [v];
  return;
}

/** Assign `value` to `target[key]` only when defined — keeps unknowns off the output. */
function put<K extends keyof EntitySummaryData>(
  target: EntitySummaryData,
  key: K,
  value: EntitySummaryData[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function extractSummary(entityType: EntityType, raw: Record<string, unknown>): EntitySummaryData {
  const data: EntitySummaryData = {};
  switch (entityType) {
    case 'assay':
      put(data, 'aid', toNum(raw.AID));
      put(data, 'name', toStr(raw.Name ?? raw.AssayName));
      put(data, 'description', toStr(raw.Description));
      put(data, 'sourceName', toStr(raw.SourceName));
      put(data, 'numSubstances', toNum(raw.NumberOfSubstances ?? raw.TotalSIDCount));
      put(data, 'numActive', toNum(raw.ActiveSidCount ?? raw.ActiveCount));
      return data;
    case 'gene':
      put(data, 'geneId', toNum(raw.GeneID));
      put(data, 'symbol', toStr(raw.Symbol));
      put(data, 'name', toStr(raw.Name));
      put(data, 'taxonomyId', toNum(raw.TaxID ?? raw.TaxonomyID));
      put(data, 'taxonomy', toStr(raw.Taxonomy ?? raw.ScientificName));
      put(data, 'description', toStr(raw.Description ?? raw.Summary));
      put(data, 'synonyms', toStrArr(raw.Synonym ?? raw.OtherNames));
      return data;
    case 'protein':
      put(data, 'proteinAccession', toStr(raw.ProteinAccession ?? raw.Accession));
      put(data, 'name', toStr(raw.Name ?? raw.Title));
      put(data, 'taxonomyId', toNum(raw.TaxID ?? raw.TaxonomyID));
      put(data, 'taxonomy', toStr(raw.Taxonomy ?? raw.ScientificName));
      put(data, 'synonyms', toStrArr(raw.Synonym ?? raw.OtherNames));
      return data;
    case 'taxonomy':
      put(data, 'taxonomyId', toNum(raw.TaxonomyID ?? raw.TaxID));
      put(data, 'scientificName', toStr(raw.ScientificName));
      put(data, 'commonName', toStr(raw.CommonName));
      put(data, 'rank', toStr(raw.Rank));
      put(data, 'lineage', toStrArr(raw.Lineage ?? raw.ParentTaxList));
      return data;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
