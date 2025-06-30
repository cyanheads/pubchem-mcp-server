/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_fetch_substance_details` tool.
 * @module src/mcp-server/tools/fetchSubstanceDetails/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemFetchSubstanceDetailsInputSchema = z.object({
  sid: z
    .number()
    .int()
    .positive()
    .describe(
      "The PubChem Substance ID (SID) to retrieve details for. Must be a positive integer.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemFetchSubstanceDetailsInput = z.infer<
  typeof PubchemFetchSubstanceDetailsInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemFetchSubstanceDetailsOutputSchema = z.object({
  sid: z.number().int().describe("The unique PubChem Substance ID (SID)."),
  sourceName: z
    .string()
    .describe("The name of the depositor or original data source."),
  depositionDate: z
    .string()
    .describe(
      "The date the substance was originally deposited, in YYYY/MM/DD format.",
    ),
  modificationDate: z
    .string()
    .describe(
      "The date the substance record was last modified, in YYYY/MM/DD format.",
    ),
  synonyms: z
    .array(z.string())
    .describe("A list of alternative names or identifiers for the substance."),
  relatedCids: z
    .array(z.number().int())
    .describe(
      "A list of standardized PubChem Compound IDs (CIDs) that are structurally related to this substance.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemFetchSubstanceDetailsOutput = z.infer<
  typeof PubchemFetchSubstanceDetailsOutputSchema
>;

/**
 * Core logic for the `pubchem_fetch_substance_details` tool. It retrieves detailed
 * information for a given PubChem Substance ID (SID), including its source,
 * synonyms, and any associated Compound IDs (CIDs).
 *
 * @param {PubchemFetchSubstanceDetailsInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging, tracing, and error handling.
 * @returns {Promise<PubchemFetchSubstanceDetailsOutput>} A promise that resolves with the substance details.
 * @throws {McpError} Throws a structured error if the API requests fail, the SID is not found, or the response is malformed.
 */
export async function pubchemFetchSubstanceDetailsLogic(
  params: PubchemFetchSubstanceDetailsInput,
  context: RequestContext,
): Promise<PubchemFetchSubstanceDetailsOutput> {
  logger.debug("Processing pubchem_fetch_substance_details logic...", {
    ...context,
    params,
  });

  const { sid } = params;

  // Two API calls are needed: one for substance details, one for related CIDs.
  const detailsPath = `/substance/sid/${sid}/JSON`;
  const cidsPath = `/substance/sid/${sid}/cids/JSON`;

  const [detailsResponse, cidsResponse] = await Promise.all([
    pubChemApiClient.get(detailsPath, context),
    pubChemApiClient.get(cidsPath, context),
  ]);

  logger.debug("Raw PubChem responses for pubchem_fetch_substance_details", {
    ...context,
    sid,
    detailsResponse,
    cidsResponse,
  });

  if (!detailsResponse?.PC_Substances?.[0]) {
    throw new McpError(
      BaseErrorCode.EXTERNAL_SERVICE_ERROR,
      `No substance details found for SID ${sid}, or the response from PubChem was malformed.`,
      { ...context, sid, response: detailsResponse },
    );
  }

  const substance = detailsResponse.PC_Substances[0];

  const relatedCids = cidsResponse?.IdentifierList?.CID || [];

  const result: PubchemFetchSubstanceDetailsOutput = {
    sid: substance.sid.id,
    sourceName: substance.source.db.name,
    depositionDate: substance.dates?.deposition.date.join("/") || "N/A",
    modificationDate: substance.dates?.modification.date.join("/") || "N/A",
    synonyms: substance.synonyms || [],
    relatedCids,
  };

  logger.info(`Successfully fetched details for SID ${sid}.`, context);

  return result;
}
