/**
 * @fileoverview Handles the registration of the `pubchem_get_compound_image` tool.
 * @module src/mcp-server/tools/getCompoundImage/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../utils/index.js";
import {
  PubchemGetCompoundImageInput,
  PubchemGetCompoundImageInputSchema,
  pubchemGetCompoundImageLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_get_compound_image' tool with the MCP server.
 * This tool fetches a 2D image of a compound's structure and returns it as a binary blob.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemGetCompoundImageTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_get_compound_image";
  const toolDescription =
    "Fetches a 2D image of a compound's structure for a given PubChem CID and returns the raw image data as a binary blob. Ideal for displaying chemical structures directly.";

  server.tool(
    toolName,
    toolDescription,
    PubchemGetCompoundImageInputSchema.shape,
    async (
      params: PubchemGetCompoundImageInput,
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
        const result = await pubchemGetCompoundImageLogic(
          params,
          handlerContext,
        );
        return {
          content: [
            {
              type: "image",
              data: result.blob.toString("base64"),
              mimeType: result.mimeType,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemGetCompoundImageToolHandler",
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
