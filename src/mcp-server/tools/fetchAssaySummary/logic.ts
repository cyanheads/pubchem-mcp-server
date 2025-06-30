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
  aids: z
    .array(z.number().int().positive())
    .min(1, "At least one Assay ID (AID) must be provided.")
    .max(5, "A maximum of 5 Assay IDs (AIDs) can be provided.")
    .describe(
      "An array of PubChem BioAssay IDs (AIDs). Must contain 1 to 5 positive integers.",
    ),
});

// 2. Define and export the TypeScript type for the input
export type PubchemFetchAssaySummaryInput = z.infer<
  typeof PubchemFetchAssaySummaryInputSchema
>;

// 3. Define and export the Zod schema for a single assay summary object
export const AssaySummarySchema = z.object({
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

// 4. Define and export the TypeScript type for a single assay summary and the final tool output
export type AssaySummary = z.infer<typeof AssaySummarySchema>;
export type PubchemFetchAssaySummaryOutput = AssaySummary[];

/**
 * Defines a flexible structure for the JSON response from the PubChem API for an assay summary.
 * This accommodates variations in the returned data.
 * @private
 */
type PubChemAssaySummaryResponse = {
  AssaySummaries?: {
    AssaySummary?: {
      AID?: number;
      Name?: string;
      Description?: string[] | string;
      SourceName?: string;
      SIDCountAll?: number;
      CIDCountActive?: number;
    }[];
  };
};

/**
 * Core logic for the `pubchem_fetch_assay_summary` tool. It retrieves a summary
 * for a specified list of PubChem BioAssay IDs (AIDs).
 *
 * @param {PubchemFetchAssaySummaryInput} params - The validated input parameters, containing the AIDs.
 * @param {RequestContext} context - The request context for logging, tracing, and error handling.
 * @returns {Promise<PubchemFetchAssaySummaryOutput>} A promise that resolves with an array of structured assay summaries.
 * @throws {McpError} Throws a structured error if the API request fails, any AID is not found, or the response is malformed.
 */
export async function pubchemFetchAssaySummaryLogic(
  params: PubchemFetchAssaySummaryInput,
  context: RequestContext,
): Promise<PubchemFetchAssaySummaryOutput> {
  logger.debug("Processing pubchem_fetch_assay_summary logic...", {
    ...context,
    params,
  });

  const { aids } = params;
  const path = `/assay/aid/${aids.join(",")}/summary/JSON`;

  const response = await pubChemApiClient.get<PubChemAssaySummaryResponse>(
    path,
    context,
  );

  logger.debug("Raw PubChem response for pubchem_fetch_assay_summary", {
    ...context,
    aids,
    response,
  });

  const summaries = response?.AssaySummaries?.AssaySummary;

  if (!summaries || summaries.length === 0) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `No assay summaries found for AIDs [${aids.join(
        ", ",
      )}], or the response from PubChem was malformed.`,
      { ...context, aids, response },
    );
  }

  const results: PubchemFetchAssaySummaryOutput = summaries.map((summary) => {
    // Safely extract description, handling both string and array formats.
    let description = "No description provided.";
    if (summary.Description) {
      description = Array.isArray(summary.Description)
        ? summary.Description.join("\n")
        : summary.Description;
    }

    return {
      aid: summary.AID ?? 0,
      name: summary.Name ?? "N/A",
      description,
      sourceName: summary.SourceName ?? "N/A",
      numSids: summary.SIDCountAll ?? 0,
      numActive: summary.CIDCountActive ?? 0,
      targets: [], // The summary endpoint does not provide target details. This is expected.
    };
  });

  logger.info(
    `Successfully fetched ${results.length} summaries for AIDs [${aids.join(
      ", ",
    )}].`,
    context,
  );

  return results;
}
