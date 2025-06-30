/**
 * @fileoverview Barrel file for the `pubchem_get_compound_image` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemGetCompoundImageTool` function.
 * @module src/mcp-server/tools/getCompoundImage/index
 */

export { registerPubchemGetCompoundImageTool } from "./registration.js";
