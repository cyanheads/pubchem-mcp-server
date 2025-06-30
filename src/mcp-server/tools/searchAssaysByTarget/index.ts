/**
 * @fileoverview Barrel file for the `pubchem_search_assays_by_target` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemSearchAssaysByTargetTool` function.
 * @module src/mcp-server/tools/searchAssaysByTarget/index
 */

export { registerPubchemSearchAssaysByTargetTool } from "./registration.js";
