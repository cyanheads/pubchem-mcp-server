/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_search_compounds_by_structure` tool.
 * @module src/mcp-server/tools/searchCompoundsByStructure/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemSearchCompoundsByStructureInputSchema = z.object({
  searchType: z
    .enum(["substructure", "superstructure", "identity"])
    .describe(
      "The type of structural search to perform: 'substructure' (finds molecules containing the query), 'superstructure' (finds molecules contained within the query), or 'identity' (finds exact matches).",
    ),
  query: z
    .string()
    .min(1, "Query cannot be empty.")
    .describe(
      "The query structure, provided as a SMILES string (e.g., 'c1ccccc1') or a PubChem CID (e.g., '2244').",
    ),
  queryType: z
    .enum(["smiles", "cid"])
    .describe(
      "The format of the provided query structure ('smiles' or 'cid').",
    ),
  maxRecords: z
    .number()
    .int()
    .positive()
    .max(100, "Cannot request more than 100 records.")
    .optional()
    .default(20)
    .describe(
      "The maximum number of matching CIDs to return. Defaults to 20, with a maximum of 100.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemSearchCompoundsByStructureInput = z.infer<
  typeof PubchemSearchCompoundsByStructureInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemSearchCompoundsByStructureOutputSchema = z.object({
  cids: z
    .array(z.number().int())
    .describe(
      "A list of PubChem Compound IDs (CIDs) that match the structural search criteria.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemSearchCompoundsByStructureOutput = z.infer<
  typeof PubchemSearchCompoundsByStructureOutputSchema
>;

/**
 * Core logic for the `pubchem_search_compounds_by_structure` tool. It performs a structural
 * search (substructure, superstructure, or identity) based on a query structure.
 *
 * @param {PubchemSearchCompoundsByStructureInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and tracing.
 * @returns {Promise<PubchemSearchCompoundsByStructureOutput>} A promise that resolves with a list of matching CIDs.
 * @throws {McpError} Throws a structured error if the input is invalid or the API request fails.
 */
export async function pubchemSearchCompoundsByStructureLogic(
  params: PubchemSearchCompoundsByStructureInput,
  context: RequestContext,
): Promise<PubchemSearchCompoundsByStructureOutput> {
  logger.debug("Processing pubchem_search_compounds_by_structure logic...", {
    ...context,
    params,
  });

  const { searchType, query, queryType, maxRecords } = params;

  if (queryType === "cid" && isNaN(parseInt(query, 10))) {
    throw new McpError(
      BaseErrorCode.INVALID_INPUT,
      `Query type is 'cid' but the provided query '${query}' is not a valid number.`,
      { ...context, query },
    );
  }

  const path = `/compound/fast${searchType}/${queryType}/${encodeURIComponent(
    query,
  )}/cids/JSON?MaxRecords=${maxRecords}`;

  const response = await pubChemApiClient.get(path, context);

  logger.debug(
    "Raw PubChem response for pubchem_search_compounds_by_structure",
    {
      ...context,
      response,
    },
  );

  if (response?.Fault) {
    logger.error("PubChem API returned a fault for structure search.", {
      ...context,
      fault: response.Fault,
    });
    throw new McpError(
      BaseErrorCode.EXTERNAL_SERVICE_ERROR,
      `PubChem API Fault: ${response.Fault.Message}`,
      { ...context, details: response.Fault.Details },
    );
  }

  if (
    !response?.IdentifierList?.CID ||
    !Array.isArray(response.IdentifierList.CID)
  ) {
    logger.warning(
      "No CIDs found for the structural search, or the response format was unexpected. Returning empty list.",
      { ...context, query, response },
    );
    return { cids: [] };
  }

  const result: PubchemSearchCompoundsByStructureOutput = {
    cids: response.IdentifierList.CID,
  };

  logger.info(
    `Found ${result.cids.length} CIDs for ${searchType} search with query '${query}'.`,
    context,
  );

  return result;
}
