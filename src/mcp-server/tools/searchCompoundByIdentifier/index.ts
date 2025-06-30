/**
 * @fileoverview Barrel file for the `pubchem_search_compound_by_identifier` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemSearchCompoundByIdentifierTool` function.
 * @module src/mcp-server/tools/searchCompoundByIdentifier/index
 */

export { registerPubchemSearchCompoundByIdentifierTool } from "./registration.js";
