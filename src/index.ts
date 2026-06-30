#!/usr/bin/env node
/**
 * @fileoverview PubChem MCP server entry point. Provides read-only access to
 * PubChem's chemical information database via PUG REST and PUG View APIs.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initPubChemClient } from './services/pubchem/pubchem-client.js';

await createApp({
  name: 'pubchem-mcp-server',
  title: 'pubchem-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions:
    "Use the pubchem_* tools to query PubChem's chemical database. Compounds are addressed by CID, assays by AID. Most flows start at `pubchem_search_compounds` (name, SMILES, InChIKey, formula, substructure, superstructure, or 2D similarity → CIDs), then call per-CID tools for details, safety, image, cross-references, bioactivity, interactions (drug-drug/drug-food/target), or 3D structure. To find assays for a biological target, chain `pubchem_search_assays` (gene/protein → AIDs) into `pubchem_get_summary` (`entityType: assay`) per AID; to check whether a compound is active against a target, call `pubchem_get_bioactivity` with a `cid` plus `targetGeneId`/`targetAccession`. `pubchem_get_summary` covers assay/gene/protein/taxonomy entity lookups. Compound and assay records are also exposed as URI-addressable resources (e.g. `pubchem://compound/{cid}`, `pubchem://assay/{aid}`).",
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
