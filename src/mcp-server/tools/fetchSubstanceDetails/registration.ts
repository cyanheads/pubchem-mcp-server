/**
 * @fileoverview Handles the registration of the `pubchem_fetch_substance_details` tool.
 * @module src/mcp-server/tools/fetchSubstanceDetails/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../utils/index.js";
import {
  PubchemFetchSubstanceDetailsInput,
  PubchemFetchSubstanceDetailsInputSchema,
  pubchemFetchSubstanceDetailsLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_fetch_substance_details' tool with the MCP server.
 * This tool retrieves detailed information for a given PubChem Substance ID (SID),
 * including its source, synonyms, and any associated Compound IDs (CIDs).
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemFetchSubstanceDetailsTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_fetch_substance_details";
  const toolDescription =
    "Retrieves details for a given PubChem Substance ID (SID), including its synonyms, source, deposition/modification dates, and any associated standardized Compound IDs (CIDs).";

  server.tool(
    toolName,
    toolDescription,
    PubchemFetchSubstanceDetailsInputSchema.shape,
    async (
      params: PubchemFetchSubstanceDetailsInput,
      mcpContext: any,
    ): Promise<CallToolResult> => {
      const handlerContext = requestContextService.createRequestContext({
        operation: "HandleToolRequest",
        toolName,
        mcpToolContext: mcpContext,
        input: params,
      });

      try {
        logger.info(
          `Initiating tool request for ${toolName} for SID: ${params.sid}`,
          handlerContext,
        );
        const result = await pubchemFetchSubstanceDetailsLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemFetchSubstanceDetailsToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while fetching substance details.",
                { originalErrorName: handledError.name },
              );

        logger.error(`Error in ${toolName} handler`, {
          ...handlerContext,
          error: mcpError,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: mcpError.code,
                  message: mcpError.message,
                  details: mcpError.details,
                },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
};
