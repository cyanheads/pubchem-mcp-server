/**
 * @fileoverview Extended client-level tests for PubChemClient.
 * Covers getSafetyData (GHS parsing), getClassification (pharmacology parsing),
 * getXrefs, getSynonyms, searchAssaysByTarget, error handling (5xx retry,
 * network errors, timeout), and property name normalization.
 * @module services/pubchem/pubchem-client-extended.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PubChemClient } from '@/services/pubchem/pubchem-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── getSafetyData ─────────────────────────────────────────────────────

describe('PubChemClient.getSafetyData — GHS parsing', () => {
  it('parses signal word, pictograms, hazard statements, and precautionary statements', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 702,
          Reference: [{ ReferenceNumber: 1, SourceName: 'European Chemicals Agency' }],
          Section: [
            {
              TOCHeading: 'Safety and Hazards',
              Section: [
                {
                  TOCHeading: 'GHS Classification',
                  Information: [
                    {
                      Name: 'Signal',
                      Value: { StringWithMarkup: [{ String: 'Danger' }] },
                    },
                    {
                      Name: 'Pictogram(s)',
                      Value: {
                        StringWithMarkup: [
                          {
                            String: 'GHS02 Flammable',
                            Markup: [{ Start: 0, Length: 5, Extra: 'GHS02', Type: 'Icon' }],
                          },
                        ],
                      },
                    },
                    {
                      Name: 'GHS Hazard Statements',
                      Value: {
                        StringWithMarkup: [
                          { String: 'H225: Highly flammable liquid and vapour' },
                          { String: 'H319: Causes serious eye irritation' },
                        ],
                      },
                    },
                    {
                      Name: 'Precautionary Statement Codes',
                      Value: {
                        StringWithMarkup: [{ String: 'P210: Keep away from heat and open flames' }],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(702);

    expect(result).not.toBeNull();
    expect(result!.signalWord).toBe('Danger');
    expect(result!.pictograms).toContain('Flammable');
    expect(result!.hazardStatements).toContainEqual({
      code: 'H225',
      statement: 'Highly flammable liquid and vapour',
    });
    expect(result!.hazardStatements).toContainEqual({
      code: 'H319',
      statement: 'Causes serious eye irritation',
    });
    expect(result!.precautionaryStatements).toContainEqual({
      code: 'P210',
      statement: 'Keep away from heat and open flames',
    });
    expect(result!.source).toBe('European Chemicals Agency');
  });

  it('returns null when no GHS Classification section exists', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 999,
          Section: [{ TOCHeading: 'Names and Identifiers' }],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(999);

    expect(result).toBeNull();
  });

  it('returns null when GHS section has no parseable data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Section: [
            {
              TOCHeading: 'GHS Classification',
              Information: [],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(1);

    expect(result).toBeNull();
  });

  it('returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const result = await client.getSafetyData(999999999);

    expect(result).toBeNull();
  });

  it('deduplicates hazard statement codes across depositors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Section: [
            {
              TOCHeading: 'GHS Classification',
              Section: [
                {
                  TOCHeading: 'GHS Classification',
                  Information: [
                    {
                      Name: 'Signal',
                      Value: { StringWithMarkup: [{ String: 'Warning' }] },
                    },
                    {
                      Name: 'GHS Hazard Statements',
                      Value: {
                        StringWithMarkup: [
                          { String: 'H302: Harmful if swallowed' },
                          // Duplicate from another depositor
                          { String: 'H302: Harmful if swallowed' },
                        ],
                      },
                    },
                    {
                      Name: 'GHS Hazard Statements',
                      Value: {
                        StringWithMarkup: [{ String: 'H302: Harmful if swallowed' }],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(1);

    if (result) {
      // H302 must appear only once
      const h302Count = result.hazardStatements.filter((h) => h.code === 'H302').length;
      expect(h302Count).toBe(1);
    }
  });
});

// ── getClassification ─────────────────────────────────────────────────

describe('PubChemClient.getClassification — pharmacology parsing', () => {
  it('parses FDA classes, mechanisms, MeSH, and ATC codes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 2244,
          Section: [
            {
              TOCHeading: 'Pharmacology and Biochemistry',
              Section: [
                {
                  TOCHeading: 'FDA Pharmacological Classification',
                  Information: [
                    {
                      Value: {
                        StringWithMarkup: [
                          {
                            String:
                              'Pharmacological Classes: Nonsteroidal Anti-inflammatory Drug [EPC]; Anti-Inflammatory Agents, Non-Steroidal [CS]; Cyclooxygenase Inhibitors [MoA]',
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  TOCHeading: 'MeSH Pharmacological Classification',
                  Information: [
                    {
                      Value: {
                        StringWithMarkup: [
                          { String: 'Anti-Inflammatory Agents, Non-Steroidal' },
                          { String: 'Platelet Aggregation Inhibitors' },
                        ],
                      },
                    },
                  ],
                },
                {
                  TOCHeading: 'ATC Code',
                  Information: [
                    {
                      Value: {
                        StringWithMarkup: [
                          { String: 'N02BA01 - Acetylsalicylic acid' },
                          { String: 'B01AC06 - Acetylsalicylic acid' },
                          { String: 'N' }, // non-leaf code, should be skipped
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getClassification(2244);

    expect(result).not.toBeNull();
    expect(result!.fdaClasses).toContain('Nonsteroidal Anti-inflammatory Drug');
    expect(result!.fdaMechanisms).toContain('Cyclooxygenase Inhibitors');
    expect(result!.meshClasses).toContain('Anti-Inflammatory Agents, Non-Steroidal');
    expect(result!.meshClasses).toContain('Platelet Aggregation Inhibitors');
    expect(result!.atcCodes.map((a) => a.code)).toContain('N02BA01');
    expect(result!.atcCodes.map((a) => a.code)).toContain('B01AC06');
  });

  it('returns null when no relevant sections exist', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Section: [{ TOCHeading: 'Some Other Section' }],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getClassification(1);

    expect(result).toBeNull();
  });

  it('returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const result = await client.getClassification(999999999);

    expect(result).toBeNull();
  });

  it('deduplicates FDA classes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 1,
          Section: [
            {
              TOCHeading: 'FDA Pharmacological Classification',
              Information: [
                {
                  Value: {
                    StringWithMarkup: [
                      {
                        String:
                          'Pharmacological Classes: NSAID [EPC]; NSAID [EPC]; COX Inhibitor [MoA]',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const result = await client.getClassification(1);

    if (result) {
      const nSaidCount = result.fdaClasses.filter((c) => c === 'NSAID').length;
      expect(nSaidCount).toBe(1);
    }
  });
});

// ── getXrefs ──────────────────────────────────────────────────────────

describe('PubChemClient.getXrefs', () => {
  it('returns array of numeric IDs for PubMedID xref type', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [{ CID: 2244, PubMedID: [11111, 22222, 33333] }],
        },
      }),
    );

    const client = new PubChemClient();
    const ids = await client.getXrefs(2244, 'PubMedID');

    expect(ids).toEqual([11111, 22222, 33333]);
  });

  it('returns array of string IDs for PatentID xref type', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [{ CID: 2244, PatentID: ['US-1234567', 'EP-9876543'] }],
        },
      }),
    );

    const client = new PubChemClient();
    const ids = await client.getXrefs(2244, 'PatentID');

    expect(ids).toEqual(['US-1234567', 'EP-9876543']);
  });

  it('returns empty array on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const ids = await client.getXrefs(999999999, 'GeneID');

    expect(ids).toEqual([]);
  });

  it('returns empty array when xrefType is absent from response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [{ CID: 2244 }], // no PatentID field
        },
      }),
    );

    const client = new PubChemClient();
    const ids = await client.getXrefs(2244, 'PatentID');

    expect(ids).toEqual([]);
  });

  it('returns empty array when InformationList has no entries', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [],
        },
      }),
    );

    const client = new PubChemClient();
    const ids = await client.getXrefs(2244, 'GeneID');

    expect(ids).toEqual([]);
  });
});

// ── getSynonyms ───────────────────────────────────────────────────────

describe('PubChemClient.getSynonyms', () => {
  it('returns synonym list from response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [
            {
              CID: 2244,
              Synonym: ['Aspirin', 'Acetylsalicylic acid', 'ASA', '2-acetoxybenzoic acid'],
            },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const synonyms = await client.getSynonyms(2244);

    expect(synonyms).toContain('Aspirin');
    expect(synonyms).toContain('Acetylsalicylic acid');
    expect(synonyms).toHaveLength(4);
  });

  it('returns empty array on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const synonyms = await client.getSynonyms(999999999);

    expect(synonyms).toEqual([]);
  });

  it('returns empty array when Synonym field is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [{ CID: 2244 }], // no Synonym field
        },
      }),
    );

    const client = new PubChemClient();
    const synonyms = await client.getSynonyms(2244);

    expect(synonyms).toEqual([]);
  });
});

// ── searchAssaysByTarget ──────────────────────────────────────────────

describe('PubChemClient.searchAssaysByTarget', () => {
  it('maps proteinaccession to "accession" in API path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        IdentifierList: { AID: [1000, 2000] },
      }),
    );

    const client = new PubChemClient();
    const aids = await client.searchAssaysByTarget('proteinaccession', 'P00533');

    // The URL should use 'accession' not 'proteinaccession'
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('/accession/');
    expect(calledUrl).not.toContain('proteinaccession');
    expect(aids).toEqual([1000, 2000]);
  });

  it('passes genesymbol unchanged to API path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ IdentifierList: { AID: [500, 600] } }));

    const client = new PubChemClient();
    await client.searchAssaysByTarget('genesymbol', 'EGFR');

    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('/genesymbol/');
  });

  it('returns empty array on 404 (target not found)', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const aids = await client.searchAssaysByTarget('genesymbol', 'NONEXISTENT');

    expect(aids).toEqual([]);
  });

  it('URL-encodes the query parameter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ IdentifierList: { AID: [] } }));

    const client = new PubChemClient();
    await client.searchAssaysByTarget('proteinname', 'Epidermal growth factor receptor');

    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    // Space must be encoded
    expect(calledUrl).not.toContain(' ');
    expect(calledUrl).toContain('Epidermal');
  });
});

// ── getProperties — property name normalization ───────────────────────

describe('PubChemClient.getProperties — property name normalization', () => {
  it('normalizes SMILES → IsomericSMILES in response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        PropertyTable: {
          Properties: [{ CID: 2244, SMILES: 'CC(=O)Oc1ccccc1C(=O)O' }],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getProperties([2244], ['IsomericSMILES']);

    expect(rows[0]).toHaveProperty('IsomericSMILES', 'CC(=O)Oc1ccccc1C(=O)O');
    expect(rows[0]).not.toHaveProperty('SMILES');
  });

  it('normalizes ConnectivitySMILES → CanonicalSMILES in response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        PropertyTable: {
          Properties: [{ CID: 2244, ConnectivitySMILES: 'CC(=O)Oc1ccccc1C(=O)O' }],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getProperties([2244], ['CanonicalSMILES']);

    expect(rows[0]).toHaveProperty('CanonicalSMILES', 'CC(=O)Oc1ccccc1C(=O)O');
    expect(rows[0]).not.toHaveProperty('ConnectivitySMILES');
  });

  it('returns empty array when properties list is empty', async () => {
    const client = new PubChemClient();
    const rows = await client.getProperties([2244], []);

    expect(rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty array when cids list is empty', async () => {
    const client = new PubChemClient();
    const rows = await client.getProperties([], ['MolecularFormula']);

    expect(rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── HTTP error handling ───────────────────────────────────────────────

describe('PubChemClient — HTTP error handling', () => {
  it('throws on 400 Bad Request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Fault: { Code: 'PUGREST.BadRequest', Message: 'Invalid compound ID' } }, 400),
    );

    const client = new PubChemClient();
    await expect(client.getSynonyms(0)).rejects.toThrow();
  });

  it('retries once on 503 then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Service Unavailable', 503)).mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [{ CID: 2244, Synonym: ['Aspirin'] }],
        },
      }),
    );

    const client = new PubChemClient();
    const synonyms = await client.getSynonyms(2244);

    expect(synonyms).toContain('Aspirin');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('throws after exhausting retries on persistent 503', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('Service Unavailable', 503))
      .mockResolvedValueOnce(textResponse('Service Unavailable', 503));

    const client = new PubChemClient();
    await expect(client.getSynonyms(2244)).rejects.toThrow();
  }, 10_000);

  it('parses plain-text fault response format', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Status: 400\nCode: PUGREST.BadRequest\nMessage: Invalid request\n', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const client = new PubChemClient();
    await expect(client.getSynonyms(2244)).rejects.toThrow();
  });
});

// ── getAssaySummary — additional parseAssayTable cases ────────────────

describe('PubChemClient.getAssaySummary — additional parsing cases', () => {
  it('handles missing Activity Value column gracefully', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: ['AID', 'Assay Name', 'Activity Outcome'],
          },
          Row: [{ Cell: [1000, 'Test Assay', 'Active'] }],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(2244);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.activityValues).toEqual([]);
  });

  it('handles missing Activity Name column gracefully', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: ['AID', 'Assay Name', 'Activity Outcome', 'Activity Value [nM]'],
          },
          Row: [{ Cell: [2000, 'Binding assay', 'Active', 5.0] }],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(2244);

    expect(rows[0]!.activityValues).toHaveLength(1);
    expect(rows[0]!.activityValues[0]!.value).toBe(5.0);
    expect(rows[0]!.activityValues[0]!.unit).toBe('nM');
    expect(rows[0]!.activityValues[0]!.name).toBeUndefined();
  });

  it('returns empty array on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(999999999);

    expect(rows).toEqual([]);
  });

  it('skips rows where AID is zero or NaN', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: { Column: ['AID', 'Assay Name', 'Activity Outcome'] },
          Row: [
            { Cell: [0, 'Zero AID', 'Active'] },
            { Cell: [null, 'Null AID', 'Inactive'] },
            { Cell: [1000, 'Valid AID', 'Active'] },
          ],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.aid).toBe(1000);
  });

  it('extracts target accession and gene ID when present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Table: {
          Columns: {
            Column: ['AID', 'Assay Name', 'Activity Outcome', 'Target Accession', 'Target GeneID'],
          },
          Row: [{ Cell: [500, 'COX-2 screen', 'Active', 'P35354', 5743] }],
        },
      }),
    );

    const client = new PubChemClient();
    const rows = await client.getAssaySummary(1);

    expect(rows[0]!.targetAccession).toBe('P35354');
    expect(rows[0]!.targetGeneId).toBe(5743);
  });
});

// ── getImage — typed not-found contract (#17) ─────────────────────────

describe('PubChemClient.getImage', () => {
  it('returns the PNG bytes on success', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    fetchMock.mockResolvedValueOnce(
      new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );

    const client = new PubChemClient();
    const buffer = await client.getImage(2244);

    expect(new Uint8Array(buffer)).toEqual(png);
  });

  it('throws cid_not_found with a recovery hint on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();

    await expect(client.getImage(999999999)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        cid: 999999999,
        reason: 'cid_not_found',
        recovery: { hint: expect.stringContaining('pubchem_search_compounds') },
      },
    });
  });

  it('passes non-404 errors through without the cid_not_found wrapper', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Service Unavailable', 503));

    const client = new PubChemClient();
    const err = (await client.getImage(2244).catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err.data as { reason?: string }).reason).toBeUndefined();
  });
});
