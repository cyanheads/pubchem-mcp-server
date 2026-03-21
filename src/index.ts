#!/usr/bin/env node
/**
 * @fileoverview PubChem MCP server entry point. Provides read-only access to
 * PubChem's chemical information database via PUG REST and PUG View APIs.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initPubChemClient } from './services/pubchem/pubchem-client.js';

await createApp({
  tools: allToolDefinitions,
  setup() {
    initPubChemClient();
  },
});
