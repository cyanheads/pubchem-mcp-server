/**
 * @fileoverview Defines the core logic, schemas, and types for the unified `pubchem_get_summary` tool.
 * @module src/mcp-server/tools/getSummary/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// Define individual summary schemas
const AssaySummarySchema = z.object({
  aid: z.number().int(),
  name: z.string(),
  description: z.string(),
  sourceName: z.string(),
  numSids: z.number().int(),
  numActive: z.number().int(),
});

const GeneSummarySchema = z.object({
  geneId: z.number().int(),
  symbol: z.string(),
  name: z.string(),
  taxonomyId: z.number().int(),
  taxonomy: z.string(),
  description: z.string().optional(),
  synonyms: z.array(z.string()),
});

const ProteinSummarySchema = z.object({
    proteinAccession: z.string(),
    name: z.string(),
    taxonomyId: z.number().int(),
    taxonomy: z.string(),
    synonyms: z.array(z.string()),
});

const PathwaySummarySchema = z.object({
    pathwayAccession: z.string(),
    sourceName: z.string(),
    sourceId: z.string(),
    name: z.string(),
    type: z.string(),
    category: z.string(),
    description: z.string().optional(),
    taxonomyId: z.number().int(),
    taxonomy: z.string(),
});

const TaxonomySummarySchema = z.object({
    taxonomyId: z.number().int(),
    scientificName: z.string(),
    commonName: z.string().optional(),
    rank: z.string(),
    rankedLineage: z.array(z.object({
        rank: z.string(),
        name: z.string(),
        taxId: z.number().int(),
    })),
});

const CellSummarySchema = z.object({
    cellAccession: z.string(),
    name: z.string(),
    sex: z.string().optional(),
    category: z.string(),
    sourceTissue: z.string(),
    sourceOrganism: z.string(),
    sourceTaxonomyId: z.number().int(),
    synonyms: z.array(z.string()),
});


// Input Schema
export const PubchemGetSummaryInputSchema = z.object({
  summaryType: z.enum(["assay", "gene", "protein", "pathway", "taxonomy", "cell"])
    .describe("The type of PubChem entity for which to fetch a summary."),
  identifiers: z.array(z.union([z.string(), z.number().int().positive()]))
    .min(1)
    .describe(
      "An array of identifiers for the specified entity type. Examples: " +
      "Assay (AID): [1000], " +
      "Gene (GeneID): [1956], " +
      "Protein (Accession): [\"P00533\"], " +
      "Pathway (Accession with prefix): [\"Reactome:R-HSA-70171\"], " +
      "Taxonomy (TaxID): [9606], " +
      "Cell (Accession): [\"CVCL_0030\"]"
    ),
});

export type PubchemGetSummaryInput = z.infer<typeof PubchemGetSummaryInputSchema>;

// Output Type
export type PubchemGetSummaryOutput =
    | z.infer<typeof AssaySummarySchema>[]
    | z.infer<typeof GeneSummarySchema>[]
    | z.infer<typeof ProteinSummarySchema>[]
    | z.infer<typeof PathwaySummarySchema>[]
    | z.infer<typeof TaxonomySummarySchema>[]
    | z.infer<typeof CellSummarySchema>[];

// Response Types
type PubChemAssaySummaryResponse = { AssaySummaries?: { AssaySummary?: any[] } };
type PubChemGeneSummaryResponse = { GeneSummaries?: { GeneSummary?: any[] } };
type PubChemProteinSummaryResponse = { ProteinSummaries?: { ProteinSummary?: any[] } };
type PubChemPathwaySummaryResponse = { PathwaySummaries?: { PathwaySummary?: any[] } };
type PubChemTaxonomySummaryResponse = { TaxonomySummaries?: { TaxonomySummary?: any[] } };
type PubChemCellSummaryResponse = { CellSummaries?: { CellSummary?: any[] } };
type PubChemInfoListResponse = { InformationList?: { Information?: any[] } };

// Logic
async function fetchAssaySummary(identifiers: (string | number)[], context: RequestContext): Promise<any> {
    const promises = identifiers.map(async (id) => {
        const path = `/assay/aid/${id}/summary/JSON`;
        const response = await pubChemApiClient.get<PubChemAssaySummaryResponse>(path, context);
        logger.debug(`Response for assay ID ${id}`, { ...context, response });
        return response?.AssaySummaries?.AssaySummary || [];
    });

    const results = await Promise.all(promises);
    const summaries = results.flat();

    if (summaries.length === 0) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "No assay summaries found for the provided identifiers.", context);
    }

    return summaries.map((s: any) => ({
        aid: s.AID,
        name: s.Name,
        description: Array.isArray(s.Description) ? s.Description.join("\\n") : s.Description,
        sourceName: s.SourceName,
        numSids: s.SIDCountAll,
        numActive: s.CIDCountActive,
    }));
}

async function fetchGeneSummary(identifiers: (string | number)[], context: RequestContext): Promise<any> {
    const promises = identifiers.map(async (id) => {
        const path = `/gene/geneid/${id}/summary/JSON`;
        const response = await pubChemApiClient.get<PubChemGeneSummaryResponse>(path, context);
        logger.debug(`Response for gene ID ${id}`, { ...context, response });
        return response?.GeneSummaries?.GeneSummary || [];
    });

    const results = await Promise.all(promises);
    const summaries = results.flat();

    if (summaries.length === 0) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "No gene summaries found for the provided identifiers.", context);
    }

    return summaries.map((s: any) => ({
        geneId: s.GeneID,
        symbol: s.Symbol,
        name: s.Name,
        taxonomyId: s.TaxonomyID,
        taxonomy: s.Taxonomy,
        description: s.Description,
        synonyms: s.Synonym || [],
    }));
}

async function fetchProteinSummary(identifiers: (string | number)[], context: RequestContext): Promise<any> {
    const promises = identifiers.map(async (id) => {
        const path = `/protein/accession/${id}/summary/JSON`;
        const response = await pubChemApiClient.get<PubChemProteinSummaryResponse>(path, context);
        logger.debug(`Response for protein accession ${id}`, { ...context, response });
        return response?.ProteinSummaries?.ProteinSummary || [];
    });

    const results = await Promise.all(promises);
    const summaries = results.flat();

    if (summaries.length === 0) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "No protein summaries found for the provided identifiers.", context);
    }

    return summaries.map((s: any) => ({
        proteinAccession: s.ProteinAccession,
        name: s.Name,
        taxonomyId: s.TaxonomyID,
        taxonomy: s.Taxonomy,
        synonyms: s.Synonym || [],
    }));
}

async function fetchPathwaySummary(identifiers: (string | number)[], context: RequestContext): Promise<any> {
    const promises = identifiers.map(async (id) => {
        const path = `/pathway/pwacc/${id}/summary/JSON`;
        const response = await pubChemApiClient.get<PubChemPathwaySummaryResponse>(path, context);
        logger.debug(`Response for pathway accession ${id}`, { ...context, response });
        return response?.PathwaySummaries?.PathwaySummary || [];
    });

    const results = await Promise.all(promises);
    const summaries = results.flat();

    if (summaries.length === 0) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "No pathway summaries found for the provided identifiers.", context);
    }

    return summaries.map((s: any) => ({
        pathwayAccession: s.PathwayAccession,
        sourceName: s.SourceName,
        sourceId: s.SourceID,
        name: s.Name,
        type: s.Type,
        category: s.Category,
        description: s.Description,
        taxonomyId: s.TaxonomyID,
        taxonomy: s.Taxonomy,
    }));
}

async function fetchTaxonomySummary(identifiers: (string | number)[], context: RequestContext): Promise<any> {
    const promises = identifiers.map(async (id) => {
        const path = `/taxonomy/taxid/${id}/summary/JSON`;
        const response = await pubChemApiClient.get<PubChemTaxonomySummaryResponse>(path, context);
        logger.debug(`Response for taxonomy ID ${id}`, { ...context, response });
        return response?.TaxonomySummaries?.TaxonomySummary || [];
    });

    const results = await Promise.all(promises);
    const summaries = results.flat();

    if (summaries.length === 0) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "No taxonomy summaries found for the provided identifiers.", context);
    }

    return summaries.map((s: any) => ({
        taxonomyId: s.TaxonomyID,
        scientificName: s.ScientificName,
        commonName: s.CommonName,
        rank: s.Rank,
        rankedLineage: s.RankedLineage || [],
    }));
}

async function fetchCellSummary(identifiers: (string | number)[], context: RequestContext): Promise<any> {
    const promises = identifiers.map(async (id) => {
        const path = `/cell/cellacc/${id}/summary/JSON`;
        const response = await pubChemApiClient.get<PubChemCellSummaryResponse>(path, context);
        logger.debug(`Response for cell accession ${id}`, { ...context, response });
        return response?.CellSummaries?.CellSummary || [];
    });

    const results = await Promise.all(promises);
    const summaries = results.flat();

    if (summaries.length === 0) {
        throw new McpError(BaseErrorCode.NOT_FOUND, "No cell summaries found for the provided identifiers.", context);
    }

    return summaries.map((s: any) => ({
        cellAccession: s.CellAccession,
        name: s.Name,
        sex: s.Sex,
        category: s.Category,
        sourceTissue: s.SourceTissue,
        sourceOrganism: s.SourceOrganism,
        sourceTaxonomyId: s.SourceTaxonomyID,
        synonyms: s.Synonym || [],
    }));
}

export async function pubchemGetSummaryLogic(
  params: PubchemGetSummaryInput,
  context: RequestContext,
): Promise<PubchemGetSummaryOutput> {
  logger.debug("Processing pubchem_get_summary logic...", { ...context, params });

  const { summaryType, identifiers } = params;

  switch (summaryType) {
    case "assay":
      return fetchAssaySummary(identifiers, context);
    case "gene":
      return fetchGeneSummary(identifiers, context);
    case "protein":
        return fetchProteinSummary(identifiers, context);
    case "pathway":
        return fetchPathwaySummary(identifiers, context);
    case "taxonomy":
        return fetchTaxonomySummary(identifiers, context);
    case "cell":
        return fetchCellSummary(identifiers, context);
    default:
      throw new McpError(
        BaseErrorCode.INVALID_INPUT,
        `Invalid summary type: ${summaryType}`,
        context,
      );
  }
}
