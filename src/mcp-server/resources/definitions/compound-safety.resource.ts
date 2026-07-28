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
    const lookup = await client.getSafetyData(params.cid);
    // A resource returns raw JSON with no notice surface, so `status` is the only way a reader
    // can tell a mistyped CID from a compound that genuinely carries no GHS classification.
    if (lookup.status !== 'ok') {
      return { cid: params.cid, hasData: false, status: lookup.status };
    }
    return {
      cid: params.cid,
      hasData: true,
      status: lookup.status,
      ghs: {
        signalWord: lookup.ghs.signalWord,
        pictograms: lookup.ghs.pictograms,
        hazardStatements: lookup.ghs.hazardStatements,
        precautionaryStatements: lookup.ghs.precautionaryStatements,
      },
      source: lookup.ghs.source,
    };
  },
});
