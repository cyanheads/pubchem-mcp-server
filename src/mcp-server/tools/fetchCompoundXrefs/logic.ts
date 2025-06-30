/**
 * @fileoverview Defines the core logic, schemas, and types for the `pubchem_fetch_compound_xrefs` tool.
 * This version includes pagination for large responses.
 * @module src/mcp-server/tools/fetchCompoundXrefs/logic
 */

import { z } from "zod";
import { pubChemApiClient } from "../../../services/pubchem/pubchemApiClient.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// 1. Define and export the Zod enum for available cross-reference types
export const PubchemXrefTypesEnum = z.enum([
  "RegistryID",
  "RN",
  "PubMedID",
  "PatentID",
  "GeneID",
  "ProteinGI",
  "TaxonomyID",
]);

// 2. Define and export the Zod schema for input validation
export const PubchemFetchCompoundXrefsInputSchema = z.object({
  cid: z
    .number()
    .int()
    .positive()
    .describe(
      "The PubChem Compound ID (CID) to find cross-references for. Must be a positive integer.",
    ),
  xrefTypes: z
    .array(PubchemXrefTypesEnum)
    .min(1, "At least one cross-reference type is required.")
    .describe("A list of cross-reference types to retrieve."),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1)
    .describe(
      "The page number for pagination, used when the result set is large. Defaults to 1.",
    ),
  pageSize: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1000)
    .describe("The number of records to return per page. Defaults to 1000."),
});

// 3. Define and export the TypeScript type for the input
export type PubchemFetchCompoundXrefsInput = z.infer<
  typeof PubchemFetchCompoundXrefsInputSchema
>;

// 4. Define and export the Zod schemas for the tool's output
const XrefItemSchema = z.object({
  type: z
    .string()
    .describe("The type of the cross-reference (e.g., 'PubMedID')."),
  id: z
    .union([z.string(), z.number()])
    .describe("The identifier for the cross-reference."),
});

const PaginationSchema = z.object({
  currentPage: z.number().int().describe("The current page number."),
  pageSize: z.number().int().describe("The number of records per page."),
  totalRecords: z
    .number()
    .int()
    .describe("The total number of records available."),
  totalPages: z.number().int().describe("The total number of pages available."),
});

export const PubchemFetchCompoundXrefsOutputSchema = z.object({
  cid: z.number().int().describe("The CID for which xrefs were fetched."),
  xrefs: z
    .array(XrefItemSchema)
    .describe("A paginated list of cross-references."),
  pagination: PaginationSchema.describe(
    "Pagination details for the result set.",
  ),
});

// 5. Define and export the TypeScript type for the output
export type PubchemFetchCompoundXrefsOutput = z.infer<
  typeof PubchemFetchCompoundXrefsOutputSchema
>;

/**
 * Core logic for the `pubchem_fetch_compound_xrefs` tool. It retrieves a paginated
 * list of external cross-references (XRefs) for a given PubChem Compound ID (CID).
 *
 * @param {PubchemFetchCompoundXrefsInput} params - The validated input parameters.
 * @param {RequestContext} context - The request context for logging, tracing, and error handling.
 * @returns {Promise<PubchemFetchCompoundXrefsOutput>} A promise that resolves with the paginated cross-reference results.
 * @throws {McpError} Throws a structured error if the API request fails, the CID is not found, or the response is malformed.
 */
export async function pubchemFetchCompoundXrefsLogic(
  params: PubchemFetchCompoundXrefsInput,
  context: RequestContext,
): Promise<PubchemFetchCompoundXrefsOutput> {
  logger.debug("Processing pubchem_fetch_compound_xrefs logic...", {
    ...context,
    params,
  });

  const { cid, xrefTypes, page, pageSize } = params;
  const xrefsString = xrefTypes.join(",");
  const path = `/compound/cid/${cid}/xrefs/${xrefsString}/JSON`;

  const response = await pubChemApiClient.get(path, context);
  logger.debug("Raw PubChem response for xrefs", { ...context, cid, response });

  if (!response?.InformationList?.Information) {
    throw new McpError(
      BaseErrorCode.EXTERNAL_SERVICE_ERROR,
      `No cross-references found for CID ${cid}, or the response from PubChem was malformed.`,
      { ...context, cid, response },
    );
  }

  // Flatten the hierarchical response into a single list for pagination
  const allXrefs: z.infer<typeof XrefItemSchema>[] = [];
  for (const info of response.InformationList.Information) {
    for (const xrefType of xrefTypes) {
      if (info[xrefType] && Array.isArray(info[xrefType])) {
        for (const id of info[xrefType]) {
          allXrefs.push({ type: xrefType, id });
        }
      }
    }
  }

  // Paginate the flattened list
  const totalRecords = allXrefs.length;
  const totalPages = Math.ceil(totalRecords / pageSize);
  const startIndex = (page - 1) * pageSize;
  const paginatedXrefs = allXrefs.slice(startIndex, startIndex + pageSize);

  const result: PubchemFetchCompoundXrefsOutput = {
    cid,
    xrefs: paginatedXrefs,
    pagination: {
      currentPage: page,
      pageSize,
      totalRecords,
      totalPages,
    },
  };

  logger.info(
    `Successfully fetched page ${page}/${totalPages} of xrefs for CID ${cid}.`,
    context,
  );

  return result;
}
