/**
 * @fileoverview Resource — a 2D structure diagram (PNG) for a compound by CID.
 * @module mcp-server/resources/definitions/compound-image.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const compoundImageResource = resource('pubchem://compound/{cid}/image', {
  name: 'pubchem-compound-image',
  description:
    'A 2D structure diagram (PNG, 300x300) for a PubChem compound by CID. Use pubchem_get_compound_image to choose the image size.',
  mimeType: 'image/png',
  params: z.object({
    cid: z.coerce.number().int().min(1).describe('PubChem Compound ID.'),
  }),
  output: z.object({
    base64: z.string().describe('Base64-encoded PNG image data.'),
  }),
  errors: [
    {
      reason: 'cid_not_found',
      code: JsonRpcErrorCode.NotFound,
      // Raised by PubChemClient.getImage, which owns the 404 → typed not-found mapping
      // because the image endpoint returns binary and cannot report absence in the body.
      thrownBy: 'service',
      when: 'PubChem returned 404 for the requested CID',
      recovery: 'Verify the CID with pubchem_search_compounds before retrying.',
    },
  ],

  async handler(params, ctx) {
    const client = getPubChemClient();
    const buffer = await client.getImage(params.cid, 'large', ctx.signal);
    return { base64: Buffer.from(buffer).toString('base64') };
  },

  // Binary content: emit the PNG as a base64 blob rather than the default JSON text.
  format(result, meta) {
    const { base64 } = result as { base64: string };
    return [{ uri: meta.uri.href, mimeType: meta.mimeType, blob: base64 }];
  },
});
