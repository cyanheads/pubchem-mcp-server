/**
 * @fileoverview Resource — summary for a PubChem BioAssay by AID.
 * @module mcp-server/resources/definitions/assay.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const assayResource = resource('pubchem://assay/{aid}', {
  name: 'pubchem-assay',
  description: 'Summary for a PubChem BioAssay by AID (mirrors pubchem_get_summary for assays).',
  mimeType: 'application/json',
  params: z.object({
    aid: z.coerce.number().int().positive().describe('PubChem Assay ID.'),
  }),

  async handler(params) {
    const client = getPubChemClient();
    const summary = await client.getEntitySummary('assay', params.aid);
    if (!summary) {
      throw notFound(`No PubChem assay found for AID ${params.aid}.`, { aid: params.aid });
    }
    return { aid: params.aid, summary };
  },
});
