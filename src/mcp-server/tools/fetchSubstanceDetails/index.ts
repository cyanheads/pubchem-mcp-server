/**
 * @fileoverview Barrel file for the `pubchem_fetch_substance_details` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemFetchSubstanceDetailsTool` function.
 * @module src/mcp-server/tools/fetchSubstanceDetails/index
 */

export { registerPubchemFetchSubstanceDetailsTool } from "./registration.js";
