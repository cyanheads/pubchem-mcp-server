/**
 * @fileoverview Handles the registration of the `pubchem_search_compound_by_identifier` tool.
 * @module src/mcp-server/tools/searchCompoundByIdentifier/registration
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
  PubchemSearchCompoundByIdentifierInput,
  PubchemSearchCompoundByIdentifierInputSchema,
  pubchemSearchCompoundByIdentifierLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_search_compound_by_identifier' tool with the MCP server.
 * This tool searches for a PubChem Compound ID (CID) using a common chemical identifier.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemSearchCompoundByIdentifierTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_search_compound_by_identifier";
  const toolDescription =
    "Searches for PubChem Compound IDs (CIDs) using a common chemical identifier like a name (e.g., 'aspirin'), SMILES string, or InChIKey. This is the first step for most compound-related workflows.";

  server.tool(
    toolName,
    toolDescription,
    PubchemSearchCompoundByIdentifierInputSchema.shape,
    async (
      params: PubchemSearchCompoundByIdentifierInput,
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
          `Initiating tool request for ${toolName} for identifier: '${params.identifier}'`,
          handlerContext,
        );
        const result = await pubchemSearchCompoundByIdentifierLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemSearchCompoundByIdentifierToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while searching for the compound identifier.",
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
