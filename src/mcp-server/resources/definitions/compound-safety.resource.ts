/**
 * @fileoverview Resource — GHS hazard classification for a compound by CID.
 * @module mcp-server/resources/definitions/compound-safety.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const compoundSafetyResource = resource('pubchem://compound/{cid}/safety', {
  name: 'pubchem-compound-safety',
  description:
    'GHS hazard classification for a PubChem compound by CID (mirrors pubchem_get_compound_safety).',
  mimeType: 'application/json',
  params: z.object({
    cid: z.coerce.number().int().positive().describe('PubChem Compound ID.'),
  }),

  async handler(params) {
    const client = getPubChemClient();
    const data = await client.getSafetyData(params.cid);
    if (!data) return { cid: params.cid, hasData: false };
    return {
      cid: params.cid,
      hasData: true,
      ghs: {
        signalWord: data.signalWord,
        pictograms: data.pictograms,
        hazardStatements: data.hazardStatements,
        precautionaryStatements: data.precautionaryStatements,
      },
      source: data.source,
    };
  },
});
