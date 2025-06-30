/**
 * @fileoverview Handles the registration of the `pubchem_fetch_substance_details` tool.
 * @module src/mcp-server/tools/fetchSubstanceDetails/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../utils/index.js";
import {
  PubchemFetchSubstanceDetailsInput,
  PubchemFetchSubstanceDetailsInputSchema,
  pubchemFetchSubstanceDetailsLogic,
} from "./logic.js";

/**
 * Registers the 'pubchem_fetch_substance_details' tool with the MCP server.
 * This tool retrieves detailed information for a given PubChem Substance ID (SID),
 * including its source, synonyms, and any associated Compound IDs (CIDs).
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 */
export const registerPubchemFetchSubstanceDetailsTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "pubchem_fetch_substance_details";
  const toolDescription =
    "Retrieves a comprehensive record for a PubChem Substance ID (SID), including its source, deposition/modification dates, synonyms, associated Compound IDs (CIDs), and full cross-reference (xref) and compound data structures if available.";

  server.tool(
    toolName,
    toolDescription,
    PubchemFetchSubstanceDetailsInputSchema.shape,
    async (
      params: PubchemFetchSubstanceDetailsInput,
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
          `Initiating tool request for ${toolName} for SID: ${params.sid}`,
          handlerContext,
        );
        const result = await pubchemFetchSubstanceDetailsLogic(
          params,
          handlerContext,
        );

        // Custom stringify to make large arrays of numbers more compact
        const placeholderPrefix = "##JSON_STRINGIFY_PLACEHOLDER##";
        let placeholderIndex = 0;
        const placeholders: string[] = [];

        const replacer = (key: string, value: any) => {
          const compactArrayKeys = new Set([
            "aid",
            "element",
            "aid1",
            "aid2",
            "order",
            "x",
            "y",
          ]);
          if (
            compactArrayKeys.has(key) &&
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
          operation: "pubchemFetchSubstanceDetailsToolHandler",
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
