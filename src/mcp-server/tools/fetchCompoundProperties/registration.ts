/**
 * @fileoverview Handles the registration of the `pubchem_fetch_compound_properties` tool.
 * @module src/mcp-server/tools/fetchCompoundProperties/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../utils/index.js";
import {
  PubchemFetchCompoundPropertiesInput,
  PubchemFetchCompoundPropertiesInputSchema,
  pubchemFetchCompoundPropertiesLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_fetch_compound_properties' tool with the MCP server.
 * This tool fetches a list of specified physicochemical properties for one or more
 * PubChem Compound IDs (CIDs).
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemFetchCompoundPropertiesTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_fetch_compound_properties";
  const toolDescription =
    "Fetches a list of specified physicochemical properties (e.g., MolecularWeight, XLogP) for one or more PubChem Compound IDs (CIDs). Essential for retrieving detailed chemical data in bulk.";

  server.tool(
    toolName,
    toolDescription,
    PubchemFetchCompoundPropertiesInputSchema.shape,
    async (
      params: PubchemFetchCompoundPropertiesInput,
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
          `Initiating tool request for ${toolName} for ${params.cids.length} CIDs.`,
          handlerContext,
        );
        const result = await pubchemFetchCompoundPropertiesLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemFetchCompoundPropertiesToolHandler",
          context: handlerContext,
          input: params,
        });

        // No need to log here, handleError already does it.

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
