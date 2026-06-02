/**
 * @fileoverview Tests for the compound image resource (binary blob content).
 * @module mcp-server/resources/definitions/compound-image.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compoundImageResource } from '@/mcp-server/resources/definitions/compound-image.resource.js';

const mockClient = {
  getImage: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('compoundImageResource', () => {
  it('returns a base64 PNG and formats it as a blob content item', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    mockClient.getImage.mockResolvedValueOnce(bytes);

    const result = await compoundImageResource.handler({ cid: 2244 }, createMockContext());
    expect(result.base64).toBe(Buffer.from(bytes).toString('base64'));

    const contents = compoundImageResource.format!(result, {
      uri: new URL('pubchem://compound/2244/image'),
      mimeType: 'image/png',
    });
    expect(contents[0]).toMatchObject({ mimeType: 'image/png' });
    expect((contents[0] as { blob: string }).blob).toBe(result.base64);
  });
});
