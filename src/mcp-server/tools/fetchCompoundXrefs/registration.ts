/**
 * @fileoverview Handles the registration of the `pubchem_fetch_compound_xrefs` tool.
 * @module src/mcp-server/tools/fetchCompoundXrefs/registration
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
  PubchemFetchCompoundXrefsInput,
  PubchemFetchCompoundXrefsInputSchema,
  pubchemFetchCompoundXrefsLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_fetch_compound_xrefs' tool with the MCP server.
 * This tool fetches a paginated list of external cross-references (XRefs) for a given
 * PubChem Compound ID (CID).
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemFetchCompoundXrefsTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_fetch_compound_xrefs";
  const toolDescription =
    "Fetches external cross-references (XRefs) for a given PubChem Compound ID (CID), such as Registry IDs, Patent IDs, or PubMed IDs. Supports pagination for handling large result sets.";

  server.tool(
    toolName,
    toolDescription,
    PubchemFetchCompoundXrefsInputSchema.shape,
    async (
      params: PubchemFetchCompoundXrefsInput,
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
          `Initiating tool request for ${toolName} for CID: ${params.cid}`,
          handlerContext,
        );
        const result = await pubchemFetchCompoundXrefsLogic(
          params,
          handlerContext,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemFetchCompoundXrefsToolHandler",
          context: handlerContext,
          input: params,
        });

        const mcpError =
          handledError instanceof McpError
            ? handledError
            : new McpError(
                BaseErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred while fetching compound cross-references.",
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
