/**
 * @fileoverview Handles the registration of the `pubchem_search_compounds_by_formula` tool.
 * @module src/mcp-server/tools/searchCompoundsByFormula/registration
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
  PubchemSearchCompoundsByFormulaInput,
  PubchemSearchCompoundsByFormulaInputSchema,
  pubchemSearchCompoundsByFormulaLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_search_compounds_by_formula' tool with the MCP server.
 * This tool finds compounds that match a given molecular formula.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemSearchCompoundsByFormulaTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_search_compounds_by_formula";
  const toolDescription =
    "Finds PubChem Compound IDs (CIDs) that match a given molecular formula (e.g., 'C6H12O6').";

  server.tool(
    toolName,
    toolDescription,
    PubchemSearchCompoundsByFormulaInputSchema.shape,
    async (
      params: PubchemSearchCompoundsByFormulaInput,
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
          `Initiating tool request for ${toolName} for formula: '${params.formula}'`,
          handlerContext,
        );
        const result = await pubchemSearchCompoundsByFormulaLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemSearchCompoundsByFormulaToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while searching for compounds by formula.",
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
