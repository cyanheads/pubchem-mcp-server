/**
 * @fileoverview Resource definition barrel — all PubChem MCP resources.
 * @module mcp-server/resources/definitions
 */

import { assayResource } from './assay.resource.js';
import { compoundResource } from './compound.resource.js';
import { compoundBioactivityResource } from './compound-bioactivity.resource.js';
import { compoundImageResource } from './compound-image.resource.js';
import { compoundSafetyResource } from './compound-safety.resource.js';
import { compoundXrefsResource } from './compound-xrefs.resource.js';

export const allResourceDefinitions = [
  compoundResource,
  compoundSafetyResource,
  compoundImageResource,
  compoundXrefsResource,
  compoundBioactivityResource,
  assayResource,
];
