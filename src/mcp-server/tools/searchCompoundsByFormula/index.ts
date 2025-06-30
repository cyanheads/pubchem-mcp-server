/**
 * @fileoverview Barrel file for the `pubchem_search_compounds_by_formula` tool.
 * This file serves as the public interface for the tool module,
 * primarily exporting the `registerPubchemSearchCompoundsByFormulaTool` function.
 * @module src/mcp-server/tools/searchCompoundsByFormula/index
 */

export { registerPubchemSearchCompoundsByFormulaTool } from "./registration.js";
