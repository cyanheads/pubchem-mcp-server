/**
 * @fileoverview Resource — a 2D structure diagram (PNG) for a compound by CID.
 * @module mcp-server/resources/definitions/compound-image.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const compoundImageResource = resource('pubchem://compound/{cid}/image', {
  name: 'pubchem-compound-image',
  description:
    'A 2D structure diagram (PNG) for a PubChem compound by CID (mirrors pubchem_get_compound_image).',
  mimeType: 'image/png',
  params: z.object({
    cid: z.coerce.number().int().positive().describe('PubChem Compound ID.'),
  }),
  output: z.object({
    base64: z.string().describe('Base64-encoded PNG image data.'),
  }),

  async handler(params) {
    const client = getPubChemClient();
    const buffer = await client.getImage(params.cid, 'large');
    return { base64: Buffer.from(buffer).toString('base64') };
  },

  // Binary content: emit the PNG as a base64 blob rather than the default JSON text.
  format(result, meta) {
    const { base64 } = result as { base64: string };
    return [{ uri: meta.uri.href, mimeType: meta.mimeType, blob: base64 }];
  },
});
