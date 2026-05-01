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
  landing: {
    tagline:
      'Search PubChem for chemical compounds, properties, safety, bioactivity, and cross-references.',
    repoRoot: 'https://github.com/cyanheads/pubchem-mcp-server',
    links: [
      { label: 'PubChem', href: 'https://pubchem.ncbi.nlm.nih.gov/', external: true },
      {
        label: 'PUG REST docs',
        href: 'https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest',
        external: true,
      },
      {
        label: 'PUG View docs',
        href: 'https://pubchem.ncbi.nlm.nih.gov/docs/pug-view',
        external: true,
      },
    ],
  },
  setup() {
    initPubChemClient();
  },
});
