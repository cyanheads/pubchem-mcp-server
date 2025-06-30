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
    .default(50)
    .describe("The number of records to return per page. Defaults to 50."),
});

// 3. Define and export the TypeScript type for the input
export type PubchemFetchCompoundXrefsInput = z.infer<
  typeof PubchemFetchCompoundXrefsInputSchema
>;

// 4. Define and export the Zod schemas for the tool's output
const XrefGroupSchema = z.object({
  type: z
    .string()
    .describe("The type of the cross-reference (e.g., 'PubMedID')."),
  ids: z
    .array(z.union([z.string(), z.number()]))
    .describe("A list of identifiers for this type."),
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
    .array(XrefGroupSchema)
    .describe("A paginated list of cross-references, grouped by type."),
  pagination: PaginationSchema.describe(
    "Pagination details for the result set.",
  ),
});

// 5. Define and export the TypeScript type for the output
export type PubchemFetchCompoundXrefsOutput = z.infer<
  typeof PubchemFetchCompoundXrefsOutputSchema
>;

/**
 * Defines the expected structure of the JSON response from the PubChem API for cross-references.
 * @private
 */
type PubChemXrefsResponse = {
  InformationList: {
    Information: {
      CID: number;
      [key: string]: any; // Allows for dynamic xref types
    }[];
  };
};

/**
 * Defines a temporary structure for holding all fetched cross-references before grouping and pagination.
 * @private
 */
type TempXrefItem = {
  type: string;
  id: string | number;
};

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
  const allXrefs: TempXrefItem[] = [];

  // Fetch each xref type individually to avoid timeouts on large requests
  for (const xrefType of xrefTypes) {
    const path = `/compound/cid/${cid}/xrefs/${xrefType}/JSON`;
    logger.debug(`Fetching xref type: ${xrefType}`, { ...context, cid, path });

    try {
      const response = await pubChemApiClient.get<PubChemXrefsResponse>(
        path,
        context,
      );

      if (response?.InformationList?.Information) {
        for (const info of response.InformationList.Information) {
          if (info[xrefType] && Array.isArray(info[xrefType])) {
            for (const id of info[xrefType]) {
              allXrefs.push({ type: xrefType, id });
            }
          }
        }
      }
    } catch (error) {
      // Log the error for the specific xref type but continue with others
      logger.warning(`Failed to fetch xref type '${xrefType}' for CID ${cid}`, {
        ...context,
        cid,
        error,
      });
    }
  }

  if (allXrefs.length === 0) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `No cross-references found for CID ${cid} with the specified types.`,
      { ...context, cid, xrefTypes },
    );
  }

  // Group the flattened list by type
  const groupedXrefs = allXrefs.reduce<Record<string, (string | number)[]>>(
    (acc, { type, id }) => {
      if (!acc[type]) {
        acc[type] = [];
      }
      acc[type].push(id);
      return acc;
    },
    {},
  );

  // Convert the grouped map to an array of objects for pagination
  const xrefGroups = Object.entries(groupedXrefs).map(([type, ids]) => ({
    type,
    ids,
  }));

  // Paginate the grouped list
  const totalRecords = xrefGroups.length;
  const totalPages = Math.ceil(totalRecords / pageSize);
  const startIndex = (page - 1) * pageSize;
  const paginatedXrefGroups = xrefGroups.slice(
    startIndex,
    startIndex + pageSize,
  );

  const result: PubchemFetchCompoundXrefsOutput = {
    cid,
    xrefs: paginatedXrefGroups,
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
