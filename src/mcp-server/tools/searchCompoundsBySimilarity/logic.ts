/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_search_compounds_by_similarity` tool.
 * @module src/mcp-server/tools/searchCompoundsBySimilarity/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemSearchCompoundsBySimilarityInputSchema = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty.")
    .describe(
      "The query structure, provided as a SMILES string or a PubChem CID.",
    ),
  queryType: z
    .enum(["smiles", "cid"])
    .describe(
      "The format of the provided query structure ('smiles' or 'cid').",
    ),
  threshold: z
    .number()
    .min(70, "Similarity threshold must be at least 70.")
    .max(100, "Similarity threshold cannot exceed 100.")
    .optional()
    .default(90)
    .describe(
      "The minimum Tanimoto similarity score required for a match, ranging from 70 to 100. Defaults to 90.",
    ),
  maxRecords: z
    .number()
    .int()
    .positive()
    .max(100, "Cannot request more than 100 records.")
    .optional()
    .default(20)
    .describe(
      "The maximum number of similar CIDs to return. Defaults to 20, with a maximum of 100.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemSearchCompoundsBySimilarityInput = z.infer<
  typeof PubchemSearchCompoundsBySimilarityInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemSearchCompoundsBySimilarityOutputSchema = z.object({
  cids: z
    .array(z.number().int())
    .describe(
      "A list of PubChem Compound IDs (CIDs) with structures similar to the query.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemSearchCompoundsBySimilarityOutput = z.infer<
  typeof PubchemSearchCompoundsBySimilarityOutputSchema
>;

/**
 * Defines the expected structure of the JSON response from the PubChem API for a similarity search.
 * @private
 */
type PubChemSimilaritySearchResponse = {
  IdentifierList?: {
    CID: number[];
  };
  Fault?: {
    Code: string;
    Message: string;
    Details: string[];
  };
};

/**
 * Core logic for the `pubchem_search_compounds_by_similarity` tool. It finds compounds
 * with a 2D structure similar to a given query compound.
 *
 * @param {PubchemSearchCompoundsBySimilarityInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and tracing.
 * @returns {Promise<PubchemSearchCompoundsBySimilarityOutput>} A promise that resolves with a list of similar CIDs.
 * @throws {McpError} Throws a structured error if the input is invalid or the API request fails.
 */
export async function pubchemSearchCompoundsBySimilarityLogic(
  params: PubchemSearchCompoundsBySimilarityInput,
  context: RequestContext,
): Promise<PubchemSearchCompoundsBySimilarityOutput> {
  logger.debug("Processing pubchem_search_compounds_by_similarity logic...", {
    ...context,
    params,
  });

  const { query, queryType, threshold, maxRecords } = params;

  if (queryType === "cid" && isNaN(parseInt(query, 10))) {
    throw new McpError(
      BaseErrorCode.INVALID_INPUT,
      `Query type is 'cid' but the provided query '${query}' is not a valid number.`,
      { ...context, query },
    );
  }

  const path = `/compound/fastsimilarity_2d/${queryType}/${encodeURIComponent(
    query,
  )}/cids/JSON?Threshold=${threshold}&MaxRecords=${maxRecords}`;

  const response = await pubChemApiClient.get<PubChemSimilaritySearchResponse>(
    path,
    context,
  );

  logger.debug(
    "Raw PubChem response for pubchem_search_compounds_by_similarity",
    {
      ...context,
      response,
    },
  );

  if (response?.Fault) {
    logger.error("PubChem API returned a fault for similarity search.", {
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
    !response ||
    !response.IdentifierList?.CID ||
    !Array.isArray(response.IdentifierList.CID)
  ) {
    logger.warning(
      "No similar CIDs found, or the response format was unexpected. Returning empty list.",
      { ...context, query, response },
    );
    return { cids: [] };
  }

  const result: PubchemSearchCompoundsBySimilarityOutput = {
    cids: response.IdentifierList.CID,
  };

  logger.info(
    `Found ${result.cids.length} similar CIDs for query '${query}'.`,
    context,
  );

  return result;
}
