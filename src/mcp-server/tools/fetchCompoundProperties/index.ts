/**
 * @fileoverview Barrel file for the `pubchem_fetch_compound_properties` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemFetchCompoundPropertiesTool` function.
 * @module src/mcp-server/tools/fetchCompoundProperties/index
 */

export { registerPubchemFetchCompoundPropertiesTool } from "./registration.js";
