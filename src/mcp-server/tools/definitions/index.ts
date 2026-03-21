/**
 * @fileoverview Tool definition barrel — all PubChem MCP tools.
 * @module mcp-server/tools/definitions
 */

import { getBioactivity } from './get-bioactivity.tool.js';
import { getCompoundDetails } from './get-compound-details.tool.js';
import { getCompoundImage } from './get-compound-image.tool.js';
import { getCompoundSafety } from './get-compound-safety.tool.js';
import { getCompoundXrefs } from './get-compound-xrefs.tool.js';
import { getSummary } from './get-summary.tool.js';
import { searchAssays } from './search-assays.tool.js';
import { searchCompounds } from './search-compounds.tool.js';

export const allToolDefinitions = [
  searchCompounds,
  getCompoundDetails,
  getCompoundImage,
  getCompoundXrefs,
  getCompoundSafety,
  getBioactivity,
  searchAssays,
  getSummary,
];
