/**
 * @fileoverview Handles the registration of the `pubchem_fetch_assay_summary` tool with the MCP server.
 * @module src/mcp-server/tools/fetchAssaySummary/registration
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
  PubchemFetchAssaySummaryInput,
  PubchemFetchAssaySummaryInputSchema,
  pubchemFetchAssaySummaryLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_fetch_assay_summary' tool with the provided MCP server instance.
 * This tool retrieves a detailed summary for a given PubChem BioAssay ID (AID).
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemFetchAssaySummaryTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_fetch_assay_summary";
  const toolDescription =
    "Fetches a detailed summary for a specific PubChem BioAssay ID (AID), including its name, description, source, and statistics. This is useful for obtaining metadata about a particular biological assay.";

  server.tool(
    toolName,
    toolDescription,
    PubchemFetchAssaySummaryInputSchema.shape,
    async (
      params: PubchemFetchAssaySummaryInput,
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
          `Initiating tool request for ${toolName} with AID: ${params.aid}`,
          handlerContext,
        );
        const result = await pubchemFetchAssaySummaryLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemFetchAssaySummaryToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while fetching the assay summary.",
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
