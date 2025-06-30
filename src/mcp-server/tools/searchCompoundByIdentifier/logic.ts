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
  identifiers: z
    .array(z.string().min(1, "Identifier cannot be empty."))
    .min(1, "At least one identifier must be provided.")
    .describe(
      "An array of identifier strings. Examples: ['aspirin', 'ibuprofen'] for name.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemSearchCompoundByIdentifierInput = z.infer<
  typeof PubchemSearchCompoundByIdentifierInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemSearchCompoundByIdentifierOutputSchema = z.object({
  results: z
    .record(z.array(z.number().int()))
    .describe(
      "An object mapping each input identifier to an array of matching PubChem Compound IDs (CIDs).",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemSearchCompoundByIdentifierOutput = z.infer<
  typeof PubchemSearchCompoundByIdentifierOutputSchema
>;

/**
 * Defines the expected structure of the JSON response from the PubChem API for an identifier search.
 * @private
 */
type PubChemIdentifierSearchResponse = {
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

  const { identifierType, identifiers } = params;
  const results: Record<string, number[]> = {};

  const promises = identifiers.map(async (identifier) => {
    const path = `/compound/${identifierType}/${encodeURIComponent(
      identifier,
    )}/cids/JSON`;
    try {
      const response =
        await pubChemApiClient.get<PubChemIdentifierSearchResponse>(
          path,
          context,
        );

      if (response?.IdentifierList?.CID) {
        results[identifier] = response.IdentifierList.CID;
      } else {
        results[identifier] = [];
      }
    } catch (error) {
      logger.warning(
        `API call failed for identifier '${identifier}'. It will be omitted from the results.`,
        { ...context, error },
      );
      results[identifier] = [];
    }
  });

  await Promise.all(promises);

  logger.info(
    `Completed search for ${identifiers.length} identifiers.`,
    context,
  );

  return { results };
}
