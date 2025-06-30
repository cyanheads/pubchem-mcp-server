/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_search_compound_by_identifier` tool.
 * @module src/mcp-server/tools/searchCompoundByIdentifier/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemSearchCompoundByIdentifierInputSchema = z.object({
  identifierType: z
    .enum(["name", "smiles", "inchikey"])
    .describe("The type of chemical identifier being provided."),
  identifier: z
    .string()
    .min(1, "Identifier cannot be empty.")
    .describe(
      "The identifier string. Examples: 'aspirin' for name, 'CC(=O)Oc1ccccc1C(=O)O' for SMILES, or a valid InChIKey.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemSearchCompoundByIdentifierInput = z.infer<
  typeof PubchemSearchCompoundByIdentifierInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemSearchCompoundByIdentifierOutputSchema = z.object({
  cids: z
    .array(z.number().int())
    .describe(
      "A list of matching PubChem Compound IDs (CIDs). This is often a single result but can be multiple for ambiguous names.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemSearchCompoundByIdentifierOutput = z.infer<
  typeof PubchemSearchCompoundByIdentifierOutputSchema
>;

/**
 * Core logic for the `pubchem_search_compound_by_identifier` tool.
 * It searches for PubChem Compound IDs (CIDs) using a common chemical identifier.
 *
 * @param {PubchemSearchCompoundByIdentifierInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and tracing.
 * @returns {Promise<PubchemSearchCompoundByIdentifierOutput>} A promise that resolves with the search results.
 * @throws {McpError} Throws a structured error if the API request fails, the identifier is not found, or the response is malformed.
 */
export async function pubchemSearchCompoundByIdentifierLogic(
  params: PubchemSearchCompoundByIdentifierInput,
  context: RequestContext,
): Promise<PubchemSearchCompoundByIdentifierOutput> {
  logger.debug("Processing pubchem_search_compound_by_identifier logic...", {
    ...context,
    params,
  });

  const { identifierType, identifier } = params;

  const path = `/compound/${identifierType}/${encodeURIComponent(
    identifier,
  )}/cids/JSON`;

  const response = await pubChemApiClient.get(path, context);

  logger.debug(
    "Raw PubChem response for pubchem_search_compound_by_identifier",
    {
      ...context,
      response,
    },
  );

  if (response?.Fault) {
    logger.error("PubChem API returned a fault for identifier search.", {
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
      "No CIDs found for the identifier search, or the response format was unexpected. Returning empty list.",
      { ...context, identifier, response },
    );
    return { cids: [] };
  }

  const result: PubchemSearchCompoundByIdentifierOutput = {
    cids: response.IdentifierList.CID,
  };

  logger.info(
    `Found ${result.cids.length} CIDs for identifier '${identifier}'.`,
    context,
  );

  return result;
}
