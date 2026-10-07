/**
 * @fileoverview Resource — summary for a PubChem BioAssay by AID.
 * @module mcp-server/resources/definitions/assay.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const assayResource = resource('pubchem://assay/{aid}', {
  name: 'pubchem-assay',
  description:
    'Summary for a PubChem BioAssay by AID — name, description, source, protocol, and substance counts.',
  mimeType: 'application/json',
  params: z.object({
    aid: z.coerce.number().int().min(1).describe('PubChem Assay ID.'),
  }),
  errors: [
    {
      reason: 'aid_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'PubChem has no assay record for the requested AID',
      recovery: 'Find a valid AID for the target with pubchem_search_assays before retrying.',
    },
  ],

  async handler(params, ctx) {
    const client = getPubChemClient();
    const summary = await client.getEntitySummary('assay', params.aid, ctx.signal);
    if (!summary) {
      throw ctx.fail('aid_not_found', `No PubChem assay found for AID ${params.aid}.`, {
        aid: params.aid,
      });
    }
    return { aid: params.aid, summary };
  },
});
