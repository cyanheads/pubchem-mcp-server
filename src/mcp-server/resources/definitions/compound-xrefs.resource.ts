/**
 * @fileoverview Resource — external cross-references for a compound by CID.
 * @module mcp-server/resources/definitions/compound-xrefs.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { MAX_CID, type XrefType } from '@/services/pubchem/types.js';
import { lookupXrefs } from '@/services/pubchem/xref-lookup.js';

/** A focused default set for the resource read — the full tool exposes all xref types. Types are
 * fetched in turn under one request budget; CAS, the PUG View read, goes last so a slow heading
 * read cannot spend the budget before the three PUG REST types are fetched. */
const RESOURCE_XREF_TYPES: readonly XrefType[] = ['RN', 'RegistryID', 'PubMedID', 'CAS'];
const MAX_PER_TYPE = 25;

export const compoundXrefsResource = resource('pubchem://compound/{cid}/xrefs', {
  name: 'pubchem-compound-xrefs',
  description:
    "External cross-references for a PubChem compound by CID, up to 25 per type: RN (every registry number PubChem associates with the record, unranked — deprecated and related CAS RNs and EC numbers sit beside the compound's own), registry IDs, PubMed IDs (the 25 highest, most recently assigned, highest first), and CAS (the deposited CAS numbers, most-attested first, with sourceCounts aligned to ids — the number of source records that deposited each). Types with no IDs are left out; a type that failed to load is named in failedTypes. Use pubchem_get_compound_xrefs for the full set of xref types, a higher per-type cap, and to page through the rest with offset.",
  mimeType: 'application/json',
  params: z.object({
    cid: z.coerce.number().int().min(1).max(MAX_CID).describe('PubChem Compound ID.'),
  }),

  async handler(params, ctx) {
    const { groups, failed } = await lookupXrefs(
      getPubChemClient(),
      params.cid,
      RESOURCE_XREF_TYPES,
      ctx.signal,
    );
    for (const f of failed) {
      ctx.log.warning('Xref type failed', {
        cid: params.cid,
        type: f.type,
        error: f.error instanceof Error ? f.error.message : String(f.error),
      });
    }
    const xrefs = groups
      .filter((group) => group.ids.length > 0)
      .map((group) => ({
        type: group.type,
        ids: group.ids.slice(0, MAX_PER_TYPE),
        ...(group.sourceCounts && { sourceCounts: group.sourceCounts.slice(0, MAX_PER_TYPE) }),
        totalAvailable: group.ids.length,
      }));
    return {
      cid: params.cid,
      xrefs,
      ...(failed.length > 0 && { failedTypes: failed.map((f) => f.type) }),
    };
  },
});
