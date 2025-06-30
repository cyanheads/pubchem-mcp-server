/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_search_compounds_by_formula` tool.
 * @module src/mcp-server/tools/searchCompoundsByFormula/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
const MOLECULAR_FORMULA_REGEX = /^[A-Z][a-z]?\d*([A-Z][a-z]?\d*)*$/;

export const PubchemSearchCompoundsByFormulaInputSchema = z.object({
  formula: z
    .string()
    .regex(
      MOLECULAR_FORMULA_REGEX,
      "Invalid molecular formula format. It must follow standard chemical notation (e.g., 'C6H12O6').",
    )
    .describe("A valid molecular formula to search for."),
  allowOtherElements: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, the search will include compounds that contain the specified formula's elements plus others. Defaults to false.",
    ),
  maxRecords: z
    .number()
    .int()
    .positive()
    .max(100, "Cannot request more than 100 records.")
    .optional()
    .default(50)
    .describe(
      "The maximum number of matching CIDs to return. Defaults to 50, with a maximum of 100.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemSearchCompoundsByFormulaInput = z.infer<
  typeof PubchemSearchCompoundsByFormulaInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemSearchCompoundsByFormulaOutputSchema = z.object({
  cids: z
    .array(z.number().int())
    .describe(
      "A list of PubChem Compound IDs (CIDs) that match the specified molecular formula.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemSearchCompoundsByFormulaOutput = z.infer<
  typeof PubchemSearchCompoundsByFormulaOutputSchema
>;

/**
 * Core logic for the `pubchem_search_compounds_by_formula` tool. It finds compounds
 * that match a given molecular formula.
 *
 * @param {PubchemSearchCompoundsByFormulaInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging and tracing.
 * @returns {Promise<PubchemSearchCompoundsByFormulaOutput>} A promise that resolves with a list of matching CIDs.
 * @throws {McpError} Throws a structured error if the API request fails or returns a fault.
 */
export async function pubchemSearchCompoundsByFormulaLogic(
  params: PubchemSearchCompoundsByFormulaInput,
  context: RequestContext,
): Promise<PubchemSearchCompoundsByFormulaOutput> {
  logger.debug("Processing pubchem_search_compounds_by_formula logic...", {
    ...context,
    params,
  });

  const { formula, allowOtherElements, maxRecords } = params;

  const path = `/compound/fastformula/${encodeURIComponent(
    formula,
  )}/cids/JSON?AllowOtherElements=${allowOtherElements}&MaxRecords=${maxRecords}`;

  const response = await pubChemApiClient.get(path, context);

  logger.debug("Raw PubChem response for pubchem_search_compounds_by_formula", {
    ...context,
    response,
  });

  if (response?.Fault) {
    logger.error("PubChem API returned a fault for formula search.", {
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
      "No CIDs found for the formula search, or the response format was unexpected. Returning empty list.",
      { ...context, formula, response },
    );
    return { cids: [] };
  }

  const result: PubchemSearchCompoundsByFormulaOutput = {
    cids: response.IdentifierList.CID,
  };

  logger.info(
    `Found ${result.cids.length} CIDs for formula '${formula}'.`,
    context,
  );

  return result;
}
