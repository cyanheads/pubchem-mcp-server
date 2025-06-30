/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_fetch_assay_summary` tool.
 * @module src/mcp-server/tools/fetchAssaySummary/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod schema for input validation
export const PubchemFetchAssaySummaryInputSchema = z.object({
  aid: z
    .number()
    .int()
    .positive()
    .describe("The PubChem BioAssay ID (AID). Must be a positive integer."),
});

// 2. Define and export the TypeScript type for the input
export type PubchemFetchAssaySummaryInput = z.infer<
  typeof PubchemFetchAssaySummaryInputSchema
>;

// 3. Define and export the Zod schema for the tool's output
export const PubchemFetchAssaySummaryOutputSchema = z.object({
  aid: z.number().int().describe("The unique PubChem BioAssay ID (AID)."),
  name: z.string().describe("The official name of the bioassay."),
  description: z
    .string()
    .describe("A detailed description of the assay's purpose and methods."),
  sourceName: z
    .string()
    .describe("The name of the institution or entity that provided the assay."),
  numSids: z
    .number()
    .int()
    .describe("The total number of substances (SIDs) tested in the assay."),
  numActive: z
    .number()
    .int()
    .describe("The number of substances found to be active in the assay."),
  targets: z
    .array(
      z.object({
        name: z.string().describe("Name of the biological target."),
        geneId: z
          .number()
          .int()
          .optional()
          .describe("NCBI Gene ID, if available."),
        geneSymbol: z
          .string()
          .optional()
          .describe("Official gene symbol, if available."),
      }),
    )
    .describe(
      "Biological targets of the assay. Note: This is often empty as the summary endpoint may not provide target details.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemFetchAssaySummaryOutput = z.infer<
  typeof PubchemFetchAssaySummaryOutputSchema
>;

/**
 * Core logic for the `pubchem_fetch_assay_summary` tool. It retrieves a summary
 * for a specified PubChem BioAssay ID (AID).
 *
 * @param {PubchemFetchAssaySummaryInput} params - The validated input parameters, containing the AID.
 * @param {RequestContext} context - The request context for logging, tracing, and error handling.
 * @returns {Promise<PubchemFetchAssaySummaryOutput>} A promise that resolves with the structured assay summary.
 * @throws {McpError} Throws a structured error if the API request fails, the AID is not found, or the response is malformed.
 */
export async function pubchemFetchAssaySummaryLogic(
  params: PubchemFetchAssaySummaryInput,
  context: RequestContext,
): Promise<PubchemFetchAssaySummaryOutput> {
  logger.debug("Processing pubchem_fetch_assay_summary logic...", {
    ...context,
    params,
  });

  const { aid } = params;
  const path = `/assay/aid/${aid}/summary/JSON`;

  const response = await pubChemApiClient.get(path, context);

  logger.debug("Raw PubChem response for pubchem_fetch_assay_summary", {
    ...context,
    aid,
    response,
  });

  if (!response?.AssaySummaries?.AssaySummary?.[0]) {
    throw new McpError(
      BaseErrorCode.EXTERNAL_SERVICE_ERROR,
      `No assay summary found for AID ${aid}, or the response from PubChem was malformed.`,
      { ...context, aid, response },
    );
  }

  const summary = response.AssaySummaries.AssaySummary[0];

  const result: PubchemFetchAssaySummaryOutput = {
    aid: summary.AID,
    name: summary.Name,
    description: summary.Description.join("\n"),
    sourceName: summary.SourceName,
    numSids: summary.SIDCountAll,
    numActive: summary.CIDCountActive,
    targets: [], // The summary endpoint does not provide target details. This is expected.
  };

  logger.info(`Successfully fetched summary for AID ${aid}.`, context);

  return result;
}
