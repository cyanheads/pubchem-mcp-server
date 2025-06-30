/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_fetch_compound_properties` tool.
 * @module src/mcp-server/tools/fetchCompoundProperties/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod enum for available compound properties
export const PubchemCompoundPropertiesEnum = z.enum([
  "MolecularFormula",
  "MolecularWeight",
  "InChI",
  "InChIKey",
  "IUPACName",
  "Title",
  "XLogP",
  "ExactMass",
  "MonoisotopicMass",
  "TPSA",
  "Complexity",
  "Charge",
  "HBondDonorCount",
  "HBondAcceptorCount",
  "RotatableBondCount",
  "HeavyAtomCount",
  "CovalentUnitCount",
]);

// 2. Define and export the Zod schema for input validation
export const PubchemFetchCompoundPropertiesInputSchema = z.object({
  cids: z
    .array(z.number().int().positive())
    .min(1, "At least one CID is required.")
    .describe(
      "An array of one or more PubChem Compound IDs (CIDs) to fetch properties for. Must be positive integers.",
    ),
  properties: z
    .array(PubchemCompoundPropertiesEnum)
    .min(1, "At least one property must be specified.")
    .describe("A list of physicochemical properties to retrieve for each CID."),
});

// 3. Define and export the TypeScript type for the input
export type PubchemFetchCompoundPropertiesInput = z.infer<
  typeof PubchemFetchCompoundPropertiesInputSchema
>;

// 4. Define and export the Zod schema for a single compound's properties in the output
const CompoundPropertiesSchema = z
  .object({
    CID: z.number().int().describe("The PubChem Compound ID."),
    MolecularFormula: z.string().optional(),
    MolecularWeight: z.number().optional(),
    InChI: z.string().optional(),
    InChIKey: z.string().optional(),
    IUPACName: z.string().optional(),
    Title: z.string().optional(),
    XLogP: z.number().optional(),
    ExactMass: z.number().optional(),
    MonoisotopicMass: z.number().optional(),
    TPSA: z.number().optional(),
    Complexity: z.number().optional(),
    Charge: z.number().optional(),
    HBondDonorCount: z.number().int().optional(),
    HBondAcceptorCount: z.number().int().optional(),
    RotatableBondCount: z.number().int().optional(),
    HeavyAtomCount: z.number().int().optional(),
    CovalentUnitCount: z.number().int().optional(),
  })
  .describe(
    "An object containing the requested properties for a single compound.",
  );

// 5. Define and export the Zod schema for the tool's complete output
export const PubchemFetchCompoundPropertiesOutputSchema = z.object({
  results: z
    .array(CompoundPropertiesSchema)
    .describe(
      "A list of property results, with one object for each successfully retrieved CID.",
    ),
});

// 6. Define and export the TypeScript type for the output
export type PubchemFetchCompoundPropertiesOutput = z.infer<
  typeof PubchemFetchCompoundPropertiesOutputSchema
>;

/**
 * Defines the expected structure of the JSON response from the PubChem API for compound properties.
 * @private
 */
type PubChemPropertiesResponse = {
  PropertyTable: {
    Properties: z.infer<typeof CompoundPropertiesSchema>[];
  };
};

/**
 * Core logic for the `pubchem_fetch_compound_properties` tool. It retrieves a list of
 * specified physicochemical properties for one or more PubChem Compound IDs (CIDs).
 *
 * @param {PubchemFetchCompoundPropertiesInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging, tracing, and error handling.
 * @returns {Promise<PubchemFetchCompoundPropertiesOutput>} A promise that resolves with the fetched properties.
 * @throws {McpError} Throws a structured error if the API request fails, CIDs are not found, or the response is malformed.
 */
export async function pubchemFetchCompoundPropertiesLogic(
  params: PubchemFetchCompoundPropertiesInput,
  context: RequestContext,
): Promise<PubchemFetchCompoundPropertiesOutput> {
  logger.debug("Processing pubchem_fetch_compound_properties logic...", {
    ...context,
    params,
  });

  const { cids, properties } = params;
  const propertiesString = properties.join(",");

  const promises = cids.map(async (cid) => {
    const path = `/compound/cid/${cid}/property/${propertiesString}/JSON`;
    try {
      const response = await pubChemApiClient.get<PubChemPropertiesResponse>(
        path,
        context,
      );
      return response?.PropertyTable?.Properties || [];
    } catch (error) {
      logger.warning(`Failed to fetch properties for CID ${cid}`, {
        ...context,
        cid,
        error,
      });
      return []; // Return empty array for this CID on failure
    }
  });

  const results = await Promise.all(promises);
  const allProperties = results.flat();

  if (allProperties.length === 0) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      "Could not fetch properties for any of the provided CIDs.",
      { ...context, cids },
    );
  }

  const result: PubchemFetchCompoundPropertiesOutput = {
    results: allProperties,
  };

  logger.info(
    `Successfully fetched properties for ${result.results.length} CIDs.`,
    context,
  );

  return result;
}
