/**
 * @fileoverview Tests for get-compound-xrefs tool.
 * @module mcp-server/tools/definitions/get-compound-xrefs.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompoundXrefs } from '@/mcp-server/tools/definitions/get-compound-xrefs.tool.js';
import { readCommonMark } from '../../../helpers/commonmark.js';
import { formatBlock, ONE_LINE_FUZZ } from '../../../helpers/read-back.js';

const mockClient = {
  getXrefs: vi.fn(),
  getHeadingXrefs: vi.fn(),
};

vi.mock('@/services/pubchem/pubchem-client.js', () => ({
  getPubChemClient: () => mockClient,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getCompoundXrefs handler', () => {
  it('fetches cross-references for a single type', async () => {
    mockClient.getXrefs.mockResolvedValueOnce([12345, 67890, 11111]);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID'],
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.cid).toBe(2244);
    expect(result.xrefs).toHaveLength(1);
    expect(result.xrefs[0]!.type).toBe('PubMedID');
    expect(result.xrefs[0]!.ids).toEqual([12345, 67890, 11111]);
    expect(result.xrefs[0]!.totalAvailable).toBe(3);
    expect(result.xrefs[0]!.truncated).toBe(false);
  });

  it('fetches multiple xref types', async () => {
    mockClient.getXrefs.mockResolvedValueOnce([12345]).mockResolvedValueOnce(['US-1234567']);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID', 'PatentID'],
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs).toHaveLength(2);
    expect(result.xrefs[0]!.type).toBe('PubMedID');
    expect(result.xrefs[1]!.type).toBe('PatentID');
  });

  it('truncates when exceeding maxPerType', async () => {
    const manyIds = Array.from({ length: 100 }, (_, i) => i + 1);
    mockClient.getXrefs.mockResolvedValueOnce(manyIds);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 2244,
      xrefTypes: ['PubMedID'],
      maxPerType: 10,
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs[0]!.ids).toHaveLength(10);
    expect(result.xrefs[0]!.totalAvailable).toBe(100);
    expect(result.xrefs[0]!.truncated).toBe(true);
  });

  it('handles empty xrefs', async () => {
    mockClient.getXrefs.mockResolvedValueOnce([]);
    const ctx = createMockContext();
    const input = getCompoundXrefs.input.parse({
      cid: 999,
      xrefTypes: ['GeneID'],
    });
    const result = await getCompoundXrefs.handler(input, ctx);

    expect(result.xrefs[0]!.ids).toEqual([]);
    expect(result.xrefs[0]!.truncated).toBe(false);
  });
});

describe('getCompoundXrefs format', () => {
  it('formats xref results', () => {
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [
        { type: 'PubMedID', ids: [12345, 67890], totalAvailable: 2, truncated: false },
        { type: 'PatentID', ids: ['US-123'], totalAvailable: 1, truncated: false },
      ],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('CID 2244');
    expect(text).toContain('PubMedID');
    expect(text).toContain('12345');
    expect(text).toContain('PatentID');
  });

  it('shows truncation info', () => {
    const blocks = getCompoundXrefs.format!({
      cid: 2244,
      xrefs: [{ type: 'PubMedID', ids: [1, 2, 3], totalAvailable: 500, truncated: true }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('3 of 500 total');
  });

  it('shows "None found" for empty xrefs', () => {
    const blocks = getCompoundXrefs.format!({
      cid: 999,
      xrefs: [{ type: 'GeneID', ids: [], totalAvailable: 0, truncated: false }],
    });
    const text = (blocks[0]! as { type: 'text'; text: string }).text;
    expect(text).toContain('None found');
  });
});

// ── String IDs read back as structuredContent carries them (#88) ──────

describe('getCompoundXrefs renders string IDs as code literals (#88)', () => {
  const SENTINEL = 'SENTINEL';

  /** Renders an RN list and a counted CAS list holding `id`, through the tool. */
  async function render(id: string) {
    mockClient.getXrefs.mockResolvedValueOnce([id, 1234]);
    mockClient.getHeadingXrefs.mockResolvedValueOnce([{ id, sourceCount: 2 }]);
    const result = await runToolContract(getCompoundXrefs, { cid: 2244, xrefTypes: ['RN', 'CAS'] });
    expect(result.structuredContent).toMatchObject({
      xrefs: [
        { type: 'RN', ids: [id, 1234] },
        { type: 'CAS', ids: [id], sourceCounts: [2] },
      ],
    });
    return formatBlock(result);
  }

  it.each(ONE_LINE_FUZZ)(
    'renders an ID holding %s verbatim in a code span, counted or not',
    async (_label, value) => {
      const baselineRead = readCommonMark(await render(SENTINEL));
      const text = await render(value);

      expect(baselineRead).toContain(`⟨code_inline:${SENTINEL}⟩, 1234`);
      expect(baselineRead).toContain(`⟨code_inline:${SENTINEL}⟩ (2 source records)`);
      expect(readCommonMark(text)).toBe(baselineRead.replaceAll(SENTINEL, () => value));
      expect(text).toContain(value);
    },
  );

  it('fences an ID holding a line break on lines of its own', async () => {
    const read = readCommonMark(await render('x\r\n# INJECTED'));

    expect(read.split('⟨fence:x\n# INJECTED⟩')).toHaveLength(3);
    expect(read).not.toContain('⟨heading_open⟩');
  });
});
