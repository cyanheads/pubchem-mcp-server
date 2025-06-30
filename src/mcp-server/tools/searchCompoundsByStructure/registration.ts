/**
 * @fileoverview Handles the registration of the `pubchem_search_compounds_by_structure` tool.
 * @module src/mcp-server/tools/searchCompoundsByStructure/registration
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
  PubchemSearchCompoundsByStructureInput,
  PubchemSearchCompoundsByStructureInputSchema,
  pubchemSearchCompoundsByStructureLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_search_compounds_by_structure' tool with the MCP server.
 * This tool performs a structural search (substructure, superstructure, or identity)
 * based on a query structure.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemSearchCompoundsByStructureTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_search_compounds_by_structure";
  const toolDescription =
    "Performs a structural search (substructure, superstructure, or identity) using a SMILES string or a PubChem CID as the query. Essential for finding structurally related compounds.";

  server.tool(
    toolName,
    toolDescription,
    PubchemSearchCompoundsByStructureInputSchema.shape,
    async (
      params: PubchemSearchCompoundsByStructureInput,
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
        const result = await pubchemSearchCompoundsByStructureLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemSearchCompoundsByStructureToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while performing the structure search.",
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
