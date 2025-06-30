/**
 * @fileoverview Handles the registration of the `pubchem_fetch_assay_summary` tool with the MCP server.
 * @module src/mcp-server/tools/fetchAssaySummary/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
    "Fetches detailed summaries for a list of up to 5 PubChem BioAssay IDs (AIDs), including their names, descriptions, sources, and statistics. This is useful for obtaining metadata about multiple biological assays in a single request.";

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
          `Initiating tool request for ${toolName} with AIDs: ${params.aids.join(
            ", ",
          )}`,
          handlerContext,
        );
        const result = await pubchemFetchAssaySummaryLogic(
          params,
          handlerContext,
        );

        // Custom stringify to make large arrays of numbers more compact
        const placeholderPrefix = "##JSON_STRINGIFY_PLACEHOLDER##";
        let placeholderIndex = 0;
        const placeholders: string[] = [];

        const replacer = (key: string, value: any) => {
          if (
            Array.isArray(value) &&
            value.every((item) => typeof item === "number")
          ) {
            const placeholder = `${placeholderPrefix}${placeholderIndex++}`;
            placeholders.push(JSON.stringify(value));
            return placeholder;
          }
          return value;
        };

        let text = JSON.stringify(result, replacer, 2);

        for (let i = 0; i < placeholders.length; i++) {
          text = text.replace(`"${placeholderPrefix}${i}"`, placeholders[i]);
        }

        return {
          content: [{ type: "text", text }],
          isError: false,
        };
      } catch (error) {
        const handledError = ErrorHandler.handleError(error, {
          operation: "pubchemFetchAssaySummaryToolHandler",
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
