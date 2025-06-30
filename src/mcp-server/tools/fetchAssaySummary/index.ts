/**
 * @fileoverview Barrel file for the `pubchem_fetch_assay_summary` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemFetchAssaySummaryTool` function.
 * @module src/mcp-server/tools/fetchAssaySummary/index
 */

export { registerPubchemFetchAssaySummaryTool } from "./registration.js";
