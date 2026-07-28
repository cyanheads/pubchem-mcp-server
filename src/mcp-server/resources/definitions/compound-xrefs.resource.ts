/**
 * @fileoverview Resource — external cross-references for a compound by CID.
 * @module mcp-server/resources/definitions/compound-xrefs.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

/** A focused default set for the resource read — the full tool exposes all xref types. */
const RESOURCE_XREF_TYPES = ['RN', 'RegistryID', 'PubMedID'] as const;
const MAX_PER_TYPE = 25;

export const compoundXrefsResource = resource('pubchem://compound/{cid}/xrefs', {
  name: 'pubchem-compound-xrefs',
  description:
    'External cross-references (CAS RN, registry IDs, PubMed) for a PubChem compound by CID, up to 25 per type. Use pubchem_get_compound_xrefs for the full set of xref types, a higher per-type cap, and to page through the rest with offset.',
  mimeType: 'application/json',
  params: z.object({
    cid: z.coerce.number().int().positive().describe('PubChem Compound ID.'),
  }),

  async handler(params) {
    const client = getPubChemClient();
    const xrefs: Array<{ type: string; ids: (string | number)[]; totalAvailable: number }> = [];
    for (const type of RESOURCE_XREF_TYPES) {
      const ids = await client.getXrefs(params.cid, type);
      if (ids.length > 0) {
        xrefs.push({ type, ids: ids.slice(0, MAX_PER_TYPE), totalAvailable: ids.length });
      }
    }
    return { cid: params.cid, xrefs };
  },
});
