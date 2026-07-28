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
import type { GHSClassification } from '@/services/pubchem/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** PUG View's fault envelope. Both "no such CID" and "no data under this heading" arrive as
 * HTTP 404 PUGVIEW.NotFound — only Message separates them. */
function pugViewFault(message: string, status = 404): Response {
  return new Response(JSON.stringify({ Fault: { Code: 'PUGVIEW.NotFound', Message: message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
          RecordNumber: 2244,
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
                      // Verbatim from CID 2244 (aspirin). PubChem interposes the
                      // depositor-agreement percentage between the code and the colon, and
                      // appends the GHS hazard class in brackets.
                      Name: 'GHS Hazard Statements',
                      Value: {
                        StringWithMarkup: [
                          {
                            String:
                              'H302 (95.6%): Harmful if swallowed [Warning Acute toxicity, oral]',
                          },
                          {
                            String:
                              'H315 (20.6%): Causes skin irritation [Warning Skin corrosion/irritation]',
                          },
                        ],
                      },
                    },
                    {
                      // Verbatim from CID 2244 (aspirin) — both strings, including the
                      // trailing "(click each P-code to see the statement)" prose PubChem
                      // appends to every list. Splitting on the delimiter and anchoring each
                      // token drops whichever code that prose is glued to.
                      Name: 'Precautionary Statement Codes',
                      Value: {
                        StringWithMarkup: [
                          {
                            String:
                              'P261, P264, P264+P265, P270, P271, P280, P301+P317, P302+P352, P304+P340, P305+P351+P338, P319, P321, P330, P332+P317, P337+P317, P362+P364, P403+P233, P405, and P501 (click each P-code to see the statement)',
                          },
                          {
                            String:
                              'P203, P233, P260, P264, P264+P265, P270, P271, P280, P284, P301+P317, P304+P340, P305+P351+P338, P308+P316, P318, P319, P321, P330, P337+P317, P342+P316, P403, P405, and P501 (click each P-code to see the statement)',
                          },
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
    const result = await client.getSafetyData(2244);

    expect(result.status).toBe('ok');
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;
    expect(ghs.signalWord).toBe('Danger');
    expect(ghs.pictograms).toContain('Flammable');
    // The depositor-agreement percentage is skipped rather than failing the parse — requiring
    // the colon to follow the code immediately dropped every annotated statement.
    expect(ghs.hazardStatements).toContainEqual({
      code: 'H302',
      statement: 'Harmful if swallowed [Warning Acute toxicity, oral]',
    });
    expect(ghs.hazardStatements).toContainEqual({
      code: 'H315',
      statement: 'Causes skin irritation [Warning Skin corrosion/irritation]',
    });
    // Precautionary codes decode to their exact UN GHS Rev. 10 Annex 3 text via the table.
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P261',
      statement: 'Avoid breathing dust/fume/gas/mist/vapours/spray.',
      decoded: true,
    });
    // P280 carries the current Rev. 10 form — adds hearing protection and the trailing "/…".
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P280',
      statement:
        'Wear protective gloves/protective clothing/eye protection/face protection/hearing protection/…',
      decoded: true,
    });
    // A P316-family code (Rev. 8+, actively deposited by PubChem) decodes to its Rev. 10 text.
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P318',
      statement: 'IF exposed or concerned, get medical advice.',
      decoded: true,
    });
    // Combined `+` codes (pairs and triples) are preserved as single entries and decoded
    // from their own combined-key text, not a runtime join of individual codes.
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P264+P265',
      statement: 'Wash hands thoroughly after handling. Do not touch eyes.',
      decoded: true,
    });
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P305+P351+P338',
      statement:
        'IF IN EYES: Rinse cautiously with water for several minutes. Remove contact lenses, if present and easy to do. Continue rinsing.',
      decoded: true,
    });
    // Codes with no Rev. 10 text report decoded:false alongside the "" fallback (#34), so a
    // consumer can tell an undecoded code from a statement the depositor left empty:
    // P321 (free-fill first-aid reference) and P501 (free-fill disposal method).
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P321',
      statement: '',
      decoded: false,
    });
    // P501 is the final code in both lists, so the appended prose is glued to it — it must
    // still be reported rather than dropped along with the prose.
    expect(ghs.precautionaryStatements).toContainEqual({
      code: 'P501',
      statement: '',
      decoded: false,
    });
    // The terminal Oxford "and" and the trailing prose contribute no codes of their own.
    const codes = ghs.precautionaryStatements.map((p) => p.code);
    expect(codes).not.toContain('and P501');
    expect(codes.every((c) => /^P\d{3}(\+P\d{3})*$/.test(c))).toBe(true);
    expect(ghs.source).toBe('European Chemicals Agency');
  });

  /** Builds a minimal GHS record around one hazard-statement list and one precautionary list. */
  function ghsRecord(cid: number, hazards: string[], precautionary: string[]) {
    return {
      Record: {
        RecordType: 'CID',
        RecordNumber: cid,
        Section: [
          {
            TOCHeading: 'GHS Classification',
            Information: [
              { Name: 'Signal', Value: { StringWithMarkup: [{ String: 'Danger' }] } },
              {
                Name: 'GHS Hazard Statements',
                Value: { StringWithMarkup: hazards.map((String_) => ({ String: String_ })) },
              },
              {
                Name: 'Precautionary Statement Codes',
                Value: { StringWithMarkup: precautionary.map((String_) => ({ String: String_ })) },
              },
            ],
          },
        ],
      },
    };
  }

  it('keeps the final P-code when PubChem appends prose to the list', async () => {
    // Verbatim from CID 702 (ethanol). The list ends "…, and P501 (click each P-code to see
    // the statement)" — the prose is attached to the last code, not to a token of its own.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ghsRecord(
          702,
          ['H225: Highly Flammable liquid and vapor [Danger Flammable liquids]'],
          [
            'P210, P233, P240, P241, P242, P243, P280, P303+P361+P353, P370+P378, P403+P235, and P501 (click each P-code to see the statement)',
          ],
        ),
      ),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(702);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;
    const codes = ghs.precautionaryStatements.map((p) => p.code);

    expect(codes).toContain('P501');
    expect(codes).toEqual([
      'P210',
      'P233',
      'P240',
      'P241',
      'P242',
      'P243',
      'P280',
      'P303+P361+P353',
      'P370+P378',
      'P403+P235',
      'P501',
    ]);
  });

  it('extracts P-codes independently of the delimiter and the appended wording', async () => {
    // The parse must not depend on commas or on the exact prose PubChem appends, so a change
    // to either costs no data.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ghsRecord(
          1,
          ['H302: Harmful if swallowed'],
          ['P210; P264+P265; P405; P501 (see each P-code for the full statement text)'],
        ),
      ),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(1);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;

    expect(ghs.precautionaryStatements.map((p) => p.code)).toEqual([
      'P210',
      'P264+P265',
      'P405',
      'P501',
    ]);
  });

  it('parses hazard statements carrying a depositor-agreement percentage', async () => {
    // Verbatim from CID 962 (water), whose depositors report only the annotated form — the
    // record surfaced zero hazard statements because every one failed the parse.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ghsRecord(
          962,
          [
            'H315 (100%): Causes skin irritation [Warning Skin corrosion/irritation]',
            'H319 (100%): Causes serious eye irritation [Warning Serious eye damage/eye irritation]',
            'H335 (100%): May cause respiratory irritation [Warning Specific target organ toxicity, single exposure; Respiratory tract irritation]',
          ],
          ['P261, P264, P271, P280, and P501 (click each P-code to see the statement)'],
        ),
      ),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(962);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;

    expect(ghs.hazardStatements.map((h) => h.code)).toEqual(['H315', 'H319', 'H335']);
    expect(ghs.hazardStatements[0]!.statement).toBe(
      'Causes skin irritation [Warning Skin corrosion/irritation]',
    );
  });

  it('still parses a hazard statement with no percentage annotation', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(ghsRecord(1, ['H302: Harmful if swallowed [Warning Acute toxicity, oral]'], [])),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(1);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;

    expect(ghs.hazardStatements).toEqual([
      { code: 'H302', statement: 'Harmful if swallowed [Warning Acute toxicity, oral]' },
    ]);
  });

  it('parses subcategory-suffixed codes and asterisk-annotated statements', async () => {
    // Verbatim shapes from CID 23954 (H361f), CID 24261 (H350i), CID 887 (H360FD) and the
    // asterisk marker CID 241/887 carry. A suffixed code names a narrower classification than
    // its base, and on CID 23954 H361f is deposited with no bare H361 to fall back on.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ghsRecord(
          23954,
          [
            'H361f: Suspected of damaging fertility [Warning Reproductive toxicity]',
            'H350i: May cause cancer by inhalation [Danger Carcinogenicity]',
            'H360FD (100%): May damage fertility; May damage the unborn child [Danger Reproductive toxicity]',
            'H370 **: Causes damage to organs [Danger Specific target organ toxicity, single exposure]',
            'H361d ***: Suspected of damaging the unborn child [Warning Reproductive toxicity]',
          ],
          [],
        ),
      ),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(23954);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;

    expect(ghs.hazardStatements).toEqual([
      {
        code: 'H361f',
        statement: 'Suspected of damaging fertility [Warning Reproductive toxicity]',
      },
      { code: 'H350i', statement: 'May cause cancer by inhalation [Danger Carcinogenicity]' },
      {
        code: 'H360FD',
        statement:
          'May damage fertility; May damage the unborn child [Danger Reproductive toxicity]',
      },
      {
        code: 'H370',
        statement:
          'Causes damage to organs [Danger Specific target organ toxicity, single exposure]',
      },
      {
        code: 'H361d',
        statement: 'Suspected of damaging the unborn child [Warning Reproductive toxicity]',
      },
    ]);
  });

  it('keeps a suffixed code distinct from its base code', async () => {
    // H360 and H360D are different classifications, so dedup-by-code must not collapse them.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ghsRecord(
          6228,
          [
            'H360: May damage fertility or the unborn child [Danger Reproductive toxicity]',
            'H360D: May damage the unborn child [Danger Reproductive toxicity]',
          ],
          [],
        ),
      ),
    );

    const client = new PubChemClient();
    const result = await client.getSafetyData(6228);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;

    expect(ghs.hazardStatements.map((h) => h.code)).toEqual(['H360', 'H360D']);
  });

  it('reports no_ghs_data when no GHS Classification section exists', async () => {
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

    expect(result).toEqual({ status: 'no_ghs_data' });
  });

  it('reports no_ghs_data when GHS section has no parseable data', async () => {
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

    expect(result).toEqual({ status: 'no_ghs_data' });
  });

  // #42 — PUG View answers both outcomes with HTTP 404 PUGVIEW.NotFound. Collapsing them made
  // a mistyped CID indistinguishable from a real compound carrying no safety classification.
  it('reports cid_not_found when PUG View has no record for the CID', async () => {
    fetchMock.mockResolvedValueOnce(pugViewFault('No record found'));

    const client = new PubChemClient();
    const result = await client.getSafetyData(999999999);

    expect(result).toEqual({ status: 'cid_not_found' });
  });

  it('reports no_ghs_data when the CID exists but the heading carries no data', async () => {
    fetchMock.mockResolvedValueOnce(pugViewFault('No data found'));

    const client = new PubChemClient();
    const result = await client.getSafetyData(11979316);

    expect(result).toEqual({ status: 'no_ghs_data' });
  });

  it('falls back to no_ghs_data when a 404 carries no recognizable fault message', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const result = await client.getSafetyData(999999999);

    // Understating what is known beats sending the caller after a "wrong" CID that is fine.
    expect(result).toEqual({ status: 'no_ghs_data' });
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

    expect(result.status).toBe('ok');
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;
    // H302 must appear only once
    expect(ghs.hazardStatements.filter((h) => h.code === 'H302')).toHaveLength(1);
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
                  // PubChem's real shapes — individual ("<Type> [TAG] - <Name>") and
                  // combined ("<Name> [TAG]; …"); either alone covers all classes.
                  TOCHeading: 'FDA Pharmacological Classification',
                  Information: [
                    {
                      Value: {
                        StringWithMarkup: [
                          { String: 'Mechanisms of Action [MoA] - Cyclooxygenase Inhibitors' },
                          {
                            String:
                              'Established Pharmacologic Class [EPC] - Nonsteroidal Anti-inflammatory Drug',
                          },
                          {
                            String: 'Physiologic Effects [PE] - Decreased Prostaglandin Production',
                          },
                          {
                            String:
                              'Chemical Structure [CS] - Anti-Inflammatory Agents, Non-Steroidal',
                          },
                          {
                            String:
                              'Anti-Inflammatory Agents, Non-Steroidal [CS]; Nonsteroidal Anti-inflammatory Drug [EPC]; Cyclooxygenase Inhibitors [MoA]; Platelet Aggregation Inhibitor [EPC]; Decreased Prostaglandin Production [PE]',
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
    // EPC → fdaClasses (the "Platelet Aggregation Inhibitor" class only appears in the
    // combined shape, proving both parses land); MoA → fdaMechanisms.
    expect(result!.fdaClasses).toContain('Nonsteroidal Anti-inflammatory Drug');
    expect(result!.fdaClasses).toContain('Platelet Aggregation Inhibitor');
    expect(result!.fdaMechanisms).toContain('Cyclooxygenase Inhibitors');
    // CS and PE have no output field — they must not leak into fdaClasses or fdaMechanisms.
    expect(result!.fdaClasses).not.toContain('Anti-Inflammatory Agents, Non-Steroidal');
    expect(result!.fdaClasses).not.toContain('Decreased Prostaglandin Production');
    expect(result!.fdaMechanisms).not.toContain('Decreased Prostaglandin Production');
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
                        String: 'NSAID [EPC]; NSAID [EPC]; COX Inhibitor [MoA]',
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
    // fetchBinary retries 5xx once (#16), so a persistent failure needs two responses.
    fetchMock
      .mockResolvedValueOnce(textResponse('Service Unavailable', 503))
      .mockResolvedValueOnce(textResponse('Service Unavailable', 503));

    const client = new PubChemClient();
    const err = (await client.getImage(2244).catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err.data as { reason?: string }).reason).toBeUndefined();
  }, 10_000);

  it('retries once on 5xx then returns the PNG bytes (#16)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    fetchMock
      .mockResolvedValueOnce(textResponse('Service Unavailable', 503))
      .mockResolvedValueOnce(
        new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
      );

    const client = new PubChemClient();
    const buffer = await client.getImage(2244);

    expect(new Uint8Array(buffer)).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('maps an AbortError timeout to a clean message instead of the raw error (#16)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const client = new PubChemClient();

    await expect(client.getImage(2244)).rejects.toThrow('PubChem request timed out (30s)');
  }, 10_000);
});
