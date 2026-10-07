/**
 * @fileoverview Tests for the compound resource.
 * @module mcp-server/resources/definitions/compound.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compoundResource } from '@/mcp-server/resources/definitions/compound.resource.js';

const mockClient = {
  getProperties: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const ctx = () => createMockContext({ errors: compoundResource.errors });

describe('compoundResource', () => {
  it('returns properties for an existing compound', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 2244, MolecularFormula: 'C9H8O4' }]);
    const result = await compoundResource.handler({ cid: 2244 }, ctx());

    expect(result).toEqual({ cid: 2244, properties: { MolecularFormula: 'C9H8O4' } });
  });

  it('throws cid_not_found for a CID-only row (nonexistent compound)', async () => {
    mockClient.getProperties.mockResolvedValueOnce([{ CID: 999999 }]);
    await expect(compoundResource.handler({ cid: 999999 }, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringMatching(/No PubChem compound/),
      data: { reason: 'cid_not_found', cid: 999999 },
    });
  });

  it('throws cid_not_found for an empty result', async () => {
    mockClient.getProperties.mockResolvedValueOnce([]);
    await expect(compoundResource.handler({ cid: 1 }, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'cid_not_found' },
    });
  });
});
