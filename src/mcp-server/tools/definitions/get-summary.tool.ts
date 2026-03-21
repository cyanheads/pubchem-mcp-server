/**
 * @fileoverview Get descriptive summaries for PubChem entities: assays, genes,
 * proteins, pathways, taxonomy, cell lines, or substances.
 * @module mcp-server/tools/definitions/get-summary
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

const entityTypeEnum = z.enum([
  'assay',
  'gene',
  'protein',
  'pathway',
  'taxonomy',
  'cell',
  'substance',
]);

type EntityType = z.infer<typeof entityTypeEnum>;

export const getSummary = tool('pubchem_get_summary', {
  title: 'Get Entity Summary',
  description:
    'Get descriptive summaries for PubChem entities by ID. Supports assays (AID), genes (Gene ID), ' +
    'proteins (UniProt accession), pathways (e.g. "Reactome:R-HSA-70171"), taxonomy (Tax ID), ' +
    'cell lines (e.g. "CVCL_0030"), and substances (SID). Up to 10 per call.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
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
          '- pathway: Prefixed accession (string), e.g. ["Reactome:R-HSA-70171"]\n' +
          '- taxonomy: Tax ID (number), e.g. [9606]\n' +
          '- cell: Cellosaurus accession (string), e.g. ["CVCL_0030"]\n' +
          '- substance: SID (number), e.g. [12345]',
      ),
  }),
  output: z.object({
    entityType: z.string().describe('Entity type queried.'),
    summaries: z
      .array(
        z.object({
          identifier: z.union([z.string(), z.number()]).describe('Queried identifier.'),
          found: z.boolean().describe('Whether the entity was found.'),
          data: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Entity summary data (shape varies by type).'),
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

function extractSummary(
  entityType: EntityType,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  switch (entityType) {
    case 'assay':
      return {
        aid: raw.AID,
        name: raw.Name ?? raw.AssayName,
        description: Array.isArray(raw.Description)
          ? (raw.Description as string[]).join('\n')
          : raw.Description,
        sourceName: raw.SourceName,
        numSubstances: raw.NumberOfSubstances ?? raw.TotalSIDCount,
        numActive: raw.ActiveSidCount ?? raw.ActiveCount,
      };
    case 'gene':
      return {
        geneId: raw.GeneID,
        symbol: raw.Symbol,
        name: raw.Name,
        taxonomyId: raw.TaxID ?? raw.TaxonomyID,
        taxonomy: raw.Taxonomy ?? raw.ScientificName,
        description: raw.Description ?? raw.Summary,
        synonyms: raw.Synonym ?? raw.OtherNames,
      };
    case 'protein':
      return {
        proteinAccession: raw.ProteinAccession ?? raw.Accession,
        name: raw.Name ?? raw.Title,
        taxonomyId: raw.TaxID ?? raw.TaxonomyID,
        taxonomy: raw.Taxonomy ?? raw.ScientificName,
        synonyms: raw.Synonym ?? raw.OtherNames,
      };
    case 'pathway':
      return {
        pathwayAccession: raw.PathwayAccession ?? raw.Accession,
        sourceName: raw.SourceName,
        name: raw.Name,
        type: raw.Type,
        category: raw.Category,
        description: raw.Description,
        taxonomyId: raw.TaxID ?? raw.TaxonomyID,
        taxonomy: raw.Taxonomy,
      };
    case 'taxonomy':
      return {
        taxonomyId: raw.TaxonomyID ?? raw.TaxID,
        scientificName: raw.ScientificName,
        commonName: raw.CommonName,
        rank: raw.Rank,
        lineage: raw.Lineage ?? raw.ParentTaxList,
      };
    case 'cell':
      return {
        cellAccession: raw.CellAccession ?? raw.Accession,
        name: raw.Name,
        sex: raw.Sex,
        category: raw.Category,
        sourceTissue: raw.SourceTissue ?? raw.Tissue,
        sourceOrganism: raw.SourceOrganism ?? raw.Organism,
        synonyms: raw.Synonym ?? raw.OtherNames,
      };
    case 'substance':
      return {
        sid: raw.SID,
        source: raw.SourceName,
        depositionDate: raw.DepositDate ?? raw.CreateDate,
        modificationDate: raw.ModifyDate,
        synonyms: raw.Synonym,
        relatedCids: raw.CompoundIDList ?? raw.StandardizedCID,
      };
    default:
      return raw;
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
