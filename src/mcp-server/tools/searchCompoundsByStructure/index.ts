/**
 * @fileoverview Barrel file for the `pubchem_search_compounds_by_structure` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemSearchCompoundsByStructureTool` function.
 * @module src/mcp-server/tools/searchCompoundsByStructure/index
 */

export { registerPubchemSearchCompoundsByStructureTool } from "./registration.js";
