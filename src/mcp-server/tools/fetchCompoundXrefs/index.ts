/**
 * @fileoverview Barrel file for the `pubchem_fetch_compound_xrefs` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemFetchCompoundXrefsTool` function.
 * @module src/mcp-server/tools/fetchCompoundXrefs/index
 */

export { registerPubchemFetchCompoundXrefsTool } from "./registration.js";
