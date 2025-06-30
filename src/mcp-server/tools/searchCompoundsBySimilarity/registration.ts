/**
 * @fileoverview Handles the registration of the `pubchem_search_compounds_by_similarity` tool.
 * @module src/mcp-server/tools/searchCompoundsBySimilarity/registration
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
  PubchemSearchCompoundsBySimilarityInput,
  PubchemSearchCompoundsBySimilarityInputSchema,
  pubchemSearchCompoundsBySimilarityLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_search_compounds_by_similarity' tool with the MCP server.
 * This tool finds compounds with a 2D structure similar to a query compound.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemSearchCompoundsBySimilarityTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_search_compounds_by_similarity";
  const toolDescription =
    "Finds compounds with a similar 2D structure to a query compound (provided as SMILES or CID), based on a Tanimoto similarity score.";

  server.tool(
    toolName,
    toolDescription,
    PubchemSearchCompoundsBySimilarityInputSchema.shape,
    async (
      params: PubchemSearchCompoundsBySimilarityInput,
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
          `Initiating tool request for ${toolName} for query: '${params.query}'`,
          handlerContext,
        );
        const result = await pubchemSearchCompoundsBySimilarityLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemSearchCompoundsBySimilarityToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while searching for similar compounds.",
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
