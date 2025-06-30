/**
 * @fileoverview Handles the registration of the `pubchem_search_assays_by_target` tool.
 * @module src/mcp-server/tools/searchAssaysByTarget/registration
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
  PubchemSearchAssaysByTargetInput,
  PubchemSearchAssaysByTargetInputSchema,
  pubchemSearchAssaysByTargetLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_search_assays_by_target' tool with the MCP server.
 * This tool finds PubChem BioAssay IDs (AIDs) associated with a specific biological target.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemSearchAssaysByTargetTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_search_assays_by_target";
  const toolDescription =
    "Finds PubChem BioAssay IDs (AIDs) associated with a specific biological target, such as a gene symbol (e.g., 'EGFR') or a full protein name.";

  server.tool(
    toolName,
    toolDescription,
    PubchemSearchAssaysByTargetInputSchema.shape,
    async (
      params: PubchemSearchAssaysByTargetInput,
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
          `Initiating tool request for ${toolName} for target: '${params.targetQuery}'`,
          handlerContext,
        );
        const result = await pubchemSearchAssaysByTargetLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemSearchAssaysByTargetToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while searching for assays by target.",
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
