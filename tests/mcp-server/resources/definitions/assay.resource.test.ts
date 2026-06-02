/**
 * @fileoverview Tests for the assay resource.
 * @module mcp-server/resources/definitions/assay.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assayResource } from '@/mcp-server/resources/definitions/assay.resource.js';

const mockClient = {
  getEntitySummary: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('assayResource', () => {
  it('returns the assay summary', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce({ AID: 1000, Name: 'Test assay' });
    const result = await assayResource.handler({ aid: 1000 }, createMockContext());

    expect(result).toEqual({ aid: 1000, summary: { AID: 1000, Name: 'Test assay' } });
    expect(mockClient.getEntitySummary).toHaveBeenCalledWith('assay', 1000);
  });

  it('throws not-found when the assay does not exist', async () => {
    mockClient.getEntitySummary.mockResolvedValueOnce(null);
    await expect(assayResource.handler({ aid: 999999999 }, createMockContext())).rejects.toThrow(
      /No PubChem assay/,
    );
  });
});
