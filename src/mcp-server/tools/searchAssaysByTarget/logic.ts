/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_search_assays_by_target` tool.
 * @module src/mcp-server/tools/searchAssaysByTarget/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemSearchAssaysByTargetInputSchema = z.object({
  targetType: z
    .enum(["genesymbol", "proteinname"])
    .describe("The type of biological target to search by."),
  targetQuery: z
    .string()
    .min(1, "Target query cannot be empty.")
    .describe(
      "The identifier for the target, such as 'EGFR' for a gene symbol or 'Epidermal growth factor receptor' for a protein name.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemSearchAssaysByTargetInput = z.infer<
  typeof PubchemSearchAssaysByTargetInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemSearchAssaysByTargetOutputSchema = z.object({
  aids: z
    .array(z.number().int())
    .describe(
      "A list of PubChem BioAssay IDs (AIDs) associated with the specified target.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemSearchAssaysByTargetOutput = z.infer<
  typeof PubchemSearchAssaysByTargetOutputSchema
>;

/**
 * Defines the expected structure of the JSON response from the PubChem API for an assay target search.
 * @private
 */
type PubChemAssayTargetSearchResponse = {
  IdentifierList?: {
    AID: number[];
  };
  Fault?: {
    Code: string;
    Message: string;
    Details: string[];
  };
};

/**
 * Core logic for the `pubchem_search_assays_by_target` tool. It finds BioAssay IDs (AIDs)
 * associated with a specific biological target.
 *
 * @param {PubchemSearchAssaysByTargetInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and tracing.
 * @returns {Promise<PubchemSearchAssaysByTargetOutput>} A promise that resolves with a list of AIDs.
 * @throws {McpError} Throws a structured error if the API request fails or returns a fault.
 */
export async function pubchemSearchAssaysByTargetLogic(
  params: PubchemSearchAssaysByTargetInput,
  context: RequestContext,
): Promise<PubchemSearchAssaysByTargetOutput> {
  logger.debug("Processing pubchem_search_assays_by_target logic...", {
    ...context,
    params,
  });

  const { targetType, targetQuery } = params;

  const path = `/assay/target/${targetType}/${encodeURIComponent(
    targetQuery,
  )}/aids/JSON`;

  const response = await pubChemApiClient.get<PubChemAssayTargetSearchResponse>(
    path,
    context,
  );

  logger.debug("Raw PubChem response for pubchem_search_assays_by_target", {
    ...context,
    response,
  });

  if (response?.Fault) {
    logger.error("PubChem API returned a fault for target search.", {
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
    !response.IdentifierList?.AID ||
    !Array.isArray(response.IdentifierList.AID)
  ) {
    logger.warning(
      "No AIDs found for the target search, or the response format was unexpected. Returning empty list.",
      { ...context, targetQuery, response },
    );
    return { aids: [] };
  }

  const result: PubchemSearchAssaysByTargetOutput = {
    aids: response.IdentifierList.AID,
  };

  logger.info(
    `Found ${result.aids.length} AIDs for target query '${targetQuery}'.`,
    context,
  );

  return result;
}
