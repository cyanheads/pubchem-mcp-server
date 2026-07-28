/**
 * @fileoverview Resource — a compound's core physicochemical properties by CID.
 * @module mcp-server/resources/definitions/compound.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { DEFAULT_PROPERTIES } from '@/services/pubchem/types.js';

export const compoundResource = resource('pubchem://compound/{cid}', {
  name: 'pubchem-compound',
  description:
    'Core physicochemical properties for a PubChem compound by CID. Use pubchem_get_compound_details to select properties or add descriptions, synonyms, drug-likeness, and classification.',
  mimeType: 'application/json',
  params: z.object({
    cid: z.coerce.number().int().positive().describe('PubChem Compound ID.'),
  }),

  async handler(params) {
    const client = getPubChemClient();
    const rows = await client.getProperties([params.cid], [...DEFAULT_PROPERTIES]);
    const row = rows[0];
    // PubChem returns HTTP 200 with a {CID}-only row for a nonexistent CID — treat as not-found.
    if (!row || !Object.keys(row).some((k) => k !== 'CID')) {
      throw notFound(`No PubChem compound found for CID ${params.cid}.`, { cid: params.cid });
    }
    const { CID: _CID, ...properties } = row;
    return { cid: params.cid, properties };
  },
});
