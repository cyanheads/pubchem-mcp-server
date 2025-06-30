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
  source: z
    .object({
      name: z.string().describe("The name of the depositor or data source."),
      sourceId: z
        .string()
        .optional()
        .describe("The unique identifier for the substance within the source."),
    })
    .describe("The original source of the substance information."),
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
  xrefs: z
    .array(z.record(z.string()))
    .optional()
    .describe(
      "A list of external cross-references, such as registry IDs or database URLs.",
    ),
  compounds: z
    .array(z.any())
    .optional()
    .describe(
      "A list of associated compound structures, including atoms, bonds, and coordinates.",
    ),
});

// 4. Define and export the TypeScript type for the output
export type PubchemFetchSubstanceDetailsOutput = z.infer<
  typeof PubchemFetchSubstanceDetailsOutputSchema
>;

/**
 * Defines a flexible structure for the JSON response from the PubChem API for substance details.
 * This accommodates variations in the returned data, such as the presence of compound information.
 * @private
 */
type PubChemSubstanceDetailsResponse = {
  PC_Substances: {
    sid: { id: number };
    source: {
      db: {
        name: string;
        source_id?: { str?: string };
      };
    };
    dates?: {
      deposition?: { date: number[] };
      modification?: { date: number[] };
    };
    synonyms?: string[];
    compound?: any[];
    xref?: Record<string, string>[];
  }[];
};

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

  // A single API call to get all available substance details.
  const detailsPath = `/substance/sid/${sid}/JSON`;
  const detailsResponse =
    await pubChemApiClient.get<PubChemSubstanceDetailsResponse>(
      detailsPath,
      context,
    );

  logger.debug("Raw PubChem response for pubchem_fetch_substance_details", {
    ...context,
    sid,
    detailsResponse,
  });

  if (!detailsResponse || !detailsResponse.PC_Substances?.[0]) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `No substance details found for SID ${sid}, or the response from PubChem was malformed.`,
      { ...context, sid, response: detailsResponse },
    );
  }

  const substance = detailsResponse.PC_Substances[0];

  // Extract related CIDs directly from the substance details if available.
  const relatedCids =
    substance.compound
      ?.map((c) => c.id?.id?.cid)
      .filter((cid): cid is number => typeof cid === "number") || [];

  const result: PubchemFetchSubstanceDetailsOutput = {
    sid: substance.sid.id,
    source: {
      name: substance.source.db.name,
      sourceId: substance.source.db.source_id?.str,
    },
    depositionDate: substance.dates?.deposition?.date.join("/") || "N/A",
    modificationDate: substance.dates?.modification?.date.join("/") || "N/A",
    synonyms: substance.synonyms || [],
    relatedCids,
    xrefs: substance.xref,
    compounds: substance.compound,
  };

  logger.info(`Successfully fetched details for SID ${sid}.`, context);

  return result;
}
