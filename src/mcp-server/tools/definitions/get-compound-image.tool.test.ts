/**
 * @fileoverview Tests for get-compound-image tool.
 * @module mcp-server/tools/definitions/get-compound-image.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundImage } from './get-compound-image.tool.js';

const mockClient = {
  getImage: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getCompoundImage handler', () => {
  it('fetches large image by default', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    mockClient.getImage.mockResolvedValueOnce(pngBytes);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 2244 });
    const result = await getCompoundImage.handler(input, ctx);

    expect(result.cid).toBe(2244);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
    expect(result.imageBase64).toBe(Buffer.from(pngBytes).toString('base64'));
    expect(mockClient.getImage).toHaveBeenCalledWith(2244, 'large');
  });

  it('fetches small image when specified', async () => {
    const pngBytes = new Uint8Array([0x89]).buffer;
    mockClient.getImage.mockResolvedValueOnce(pngBytes);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 2244, size: 'small' });
    const result = await getCompoundImage.handler(input, ctx);

    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(mockClient.getImage).toHaveBeenCalledWith(2244, 'small');
  });
});

describe('getCompoundImage format', () => {
  it('returns image block and text caption', () => {
    const blocks = getCompoundImage.format!({
      cid: 2244,
      imageBase64: 'aWJhc2U2NA==',
      mimeType: 'image/png',
      width: 300,
      height: 300,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('image');
    expect(blocks[1]!.type).toBe('text');
    const text = (blocks[1]! as { type: 'text'; text: string }).text;
    expect(text).toContain('CID 2244');
    expect(text).toContain('300x300');
  });
});
