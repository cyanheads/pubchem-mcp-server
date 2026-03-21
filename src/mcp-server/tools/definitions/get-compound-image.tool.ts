/**
 * @fileoverview Fetch a 2D structure diagram (PNG) for a PubChem compound.
 * @module mcp-server/tools/definitions/get-compound-image
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

export const getCompoundImage = tool('pubchem_get_compound_image', {
  title: 'Get Compound Image',
  description: 'Fetch a 2D structure diagram (PNG image) for a compound by CID.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cid: z.number().int().positive().describe('PubChem Compound ID.'),
    size: z
      .enum(['small', 'large'])
      .default('large')
      .describe('Image size: "small" (100x100) or "large" (300x300). Default: "large".'),
  }),
  output: z.object({
    cid: z.number().describe('PubChem Compound ID.'),
    imageBase64: z.string().describe('Base64-encoded PNG image data.'),
    mimeType: z.string().describe('Image MIME type.'),
    width: z.number().describe('Image width in pixels.'),
    height: z.number().describe('Image height in pixels.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const buffer = await client.getImage(input.cid, input.size);
    const dim = input.size === 'small' ? 100 : 300;

    ctx.log.info('Image fetched', { cid: input.cid, size: input.size, bytes: buffer.byteLength });

    return {
      cid: input.cid,
      imageBase64: arrayBufferToBase64(buffer),
      mimeType: 'image/png',
      width: dim,
      height: dim,
    };
  },

  format(result) {
    return [
      { type: 'image', data: result.imageBase64, mimeType: result.mimeType },
      {
        type: 'text',
        text: `2D structure for CID ${result.cid} (${result.width}x${result.height})`,
      },
    ];
  },
});
