/**
 * @fileoverview Resource — bioassay activity profile for a compound by CID.
 * @module mcp-server/resources/definitions/compound-bioactivity.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

/** Well-studied compounds have thousands of assays — the resource read returns a head slice. */
const MAX_RESULTS = 25;

export const compoundBioactivityResource = resource('pubchem://compound/{cid}/bioactivity', {
  name: 'pubchem-compound-bioactivity',
  description:
    'Bioassay activity profile for a PubChem compound by CID (mirrors pubchem_get_bioactivity). Returns up to 25 assays; use the tool to filter and page.',
  mimeType: 'application/json',
  params: z.object({
    cid: z.coerce.number().int().positive().describe('PubChem Compound ID.'),
  }),

  async handler(params) {
    const client = getPubChemClient();
    const rows = await client.getAssaySummary(params.cid);
    const activeCount = rows.filter((r) => r.outcome === 'Active').length;
    return {
      cid: params.cid,
      totalAssays: rows.length,
      activeCount,
      results: rows.slice(0, MAX_RESULTS),
    };
  },
});
