/**
 * @fileoverview Handles the registration of the `pubchem_get_summary` tool with the MCP server.
 * @module src/mcp-server/tools/getSummary/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../utils/index.js";
import {
  PubchemGetSummaryInput,
  PubchemGetSummaryInputSchema,
  pubchemGetSummaryLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_get_summary' tool with the provided MCP server instance.
 * This tool retrieves a summary for various PubChem data types.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemGetSummaryTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_get_summary";
  const toolDescription =
    "Fetches a summary for a given PubChem entity type (assay, gene, protein, pathway, taxonomy, cell) and a list of identifiers.";

  server.tool(
    toolName,
    toolDescription,
    PubchemGetSummaryInputSchema.shape,
    async (
      params: PubchemGetSummaryInput,
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
          `Initiating tool request for ${toolName} with type: ${params.summaryType}`,
          handlerContext,
        );
        const result = await pubchemGetSummaryLogic(
          params,
          handlerContext,
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemGetSummaryToolHandler",
          context: handlerContext,
          input: params,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: ErrorHandler.formatError(handledError),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
};
