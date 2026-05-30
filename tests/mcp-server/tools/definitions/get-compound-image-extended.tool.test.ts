/**
 * @fileoverview Extended tests for get-compound-image tool — validation and error handling.
 * @module mcp-server/tools/definitions/get-compound-image-extended.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundImage } from '@/mcp-server/tools/definitions/get-compound-image.tool.js';

const mockClient = {
  getImage: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getCompoundImage handler — input validation', () => {
  it('rejects CID of 0', () => {
    expect(() => getCompoundImage.input.parse({ cid: 0 })).toThrow();
  });

  it('rejects negative CID', () => {
    expect(() => getCompoundImage.input.parse({ cid: -1 })).toThrow();
  });

  it('rejects non-integer CID', () => {
    expect(() => getCompoundImage.input.parse({ cid: 2.5 })).toThrow();
  });

  it('rejects invalid size values', () => {
    expect(() =>
      getCompoundImage.input.parse({ cid: 2244, size: 'medium' as unknown as 'small' }),
    ).toThrow();
  });

  it('defaults to large size', () => {
    const input = getCompoundImage.input.parse({ cid: 2244 });
    expect(input.size).toBe('large');
  });
});

describe('getCompoundImage handler — output', () => {
  it('converts ArrayBuffer to base64 correctly', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buffer = bytes.buffer;
    mockClient.getImage.mockResolvedValueOnce(buffer);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 2244 });
    const result = await getCompoundImage.handler(input, ctx);

    const expected = Buffer.from(buffer).toString('base64');
    expect(result.imageBase64).toBe(expected);
    expect(result.mimeType).toBe('image/png');
  });

  it('returns correct dimensions for small size', async () => {
    mockClient.getImage.mockResolvedValueOnce(new Uint8Array([0x89]).buffer);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 2244, size: 'small' });
    const result = await getCompoundImage.handler(input, ctx);

    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('returns correct dimensions for large size', async () => {
    mockClient.getImage.mockResolvedValueOnce(new Uint8Array([0x89]).buffer);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 2244, size: 'large' });
    const result = await getCompoundImage.handler(input, ctx);

    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });

  it('propagates client errors for non-existent CIDs', async () => {
    const notFoundError = new Error('Not found');
    mockClient.getImage.mockRejectedValueOnce(notFoundError);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 999999999 });

    await expect(getCompoundImage.handler(input, ctx)).rejects.toThrow();
  });

  it('passes correct size parameter to client', async () => {
    mockClient.getImage.mockResolvedValueOnce(new Uint8Array([0]).buffer);
    const ctx = createMockContext();
    const input = getCompoundImage.input.parse({ cid: 702, size: 'small' });
    await getCompoundImage.handler(input, ctx);

    expect(mockClient.getImage).toHaveBeenCalledWith(702, 'small');
  });
});

describe('getCompoundImage format — additional cases', () => {
  it('includes cid in both image and text blocks', () => {
    const blocks = getCompoundImage.format!({
      cid: 5988,
      imageBase64: 'dGVzdA==',
      mimeType: 'image/png',
      width: 300,
      height: 300,
    });
    expect(blocks).toHaveLength(2);
    const text = (blocks[1]! as { type: 'text'; text: string }).text;
    expect(text).toContain('5988');
  });

  it('image block contains correct base64 data and mimeType', () => {
    const blocks = getCompoundImage.format!({
      cid: 1,
      imageBase64: 'abc123',
      mimeType: 'image/png',
      width: 100,
      height: 100,
    });
    const imgBlock = blocks[0]! as { type: 'image'; data: string; mimeType: string };
    expect(imgBlock.type).toBe('image');
    expect(imgBlock.data).toBe('abc123');
    expect(imgBlock.mimeType).toBe('image/png');
  });
});
