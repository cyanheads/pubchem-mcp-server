/**
 * @fileoverview Barrel file for the `pubchem_search_compounds_by_similarity` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemSearchCompoundsBySimilarityTool` function.
 * @module src/mcp-server/tools/searchCompoundsBySimilarity/index
 */

export { registerPubchemSearchCompoundsBySimilarityTool } from "./registration.js";
