/**
 * @fileoverview Resource — GHS hazard classification for a compound by CID.
 * @module mcp-server/resources/definitions/compound-safety.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { MAX_CID } from '@/services/pubchem/types.js';

export const compoundSafetyResource = resource('pubchem://compound/{cid}/safety', {
  name: 'pubchem-compound-safety',
  description:
    'GHS hazard classification for a PubChem compound by CID — signal word, pictograms, hazard (H) and precautionary (P) statements merged across sources, plus each source\'s own classification (signal word, pictograms, H-codes with ECHA notifier agreement, notification counts) in ghs.classifications. status is "not_classified" when every deposited classification is an ECHA "Not Classified" verdict. Not every compound carries a deposited classification.',
  mimeType: 'application/json',
  params: z.object({
    cid: z.coerce.number().int().min(1).max(MAX_CID).describe('PubChem Compound ID.'),
  }),

  async handler(params, ctx) {
    const client = getPubChemClient();
    const lookup = await client.getSafetyData(params.cid, ctx.signal);
    // A resource returns raw JSON with no notice surface, so `status` is the only way a reader
    // can tell a mistyped CID from a compound that genuinely carries no GHS classification.
    if (lookup.status === 'no_ghs_data' || lookup.status === 'cid_not_found') {
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
        classifications: lookup.ghs.classifications,
      },
      source: lookup.ghs.source,
    };
  },
});
