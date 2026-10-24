/**
 * @fileoverview Extended client-level tests for PubChemClient.
 * Covers getSafetyData (GHS parsing), getClassification (pharmacology parsing),
 * getXrefs, getSynonyms, searchAssaysByTarget, error handling (5xx retry,
 * network errors, timeout), and property name normalization.
 * @module services/pubchem/pubchem-client-extended.test
 */

import { readFileSync } from 'node:fs';
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
  fetchMock.mockRejectedValue(new Error('unmocked fetch'));
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
                  // Every entry names the reference that deposited it, as on the wire — the
                  // source is attributed through ReferenceNumber, not Reference[0].
                  Information: [
                    {
                      ReferenceNumber: 1,
                      Name: 'Signal',
                      Value: { StringWithMarkup: [{ String: 'Danger' }] },
                    },
                    {
                      ReferenceNumber: 1,
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
                      ReferenceNumber: 1,
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
                      ReferenceNumber: 1,
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
    const ghs = await ghsFrom(
      ghsRecord(
        702,
        ['H225: Highly Flammable liquid and vapor [Danger Flammable liquids]'],
        [
          'P210, P233, P240, P241, P242, P243, P280, P303+P361+P353, P370+P378, P403+P235, and P501 (click each P-code to see the statement)',
        ],
      ),
      702,
    );

    expect(ghs.precautionaryStatements.map((p) => p.code)).toEqual([
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
    const ghs = await ghsFrom(
      ghsRecord(
        1,
        ['H302: Harmful if swallowed'],
        ['P210; P264+P265; P405; P501 (see each P-code for the full statement text)'],
      ),
      1,
    );

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
    const ghs = await ghsFrom(
      ghsRecord(
        962,
        [
          'H315 (100%): Causes skin irritation [Warning Skin corrosion/irritation]',
          'H319 (100%): Causes serious eye irritation [Warning Serious eye damage/eye irritation]',
          'H335 (100%): May cause respiratory irritation [Warning Specific target organ toxicity, single exposure; Respiratory tract irritation]',
        ],
        ['P261, P264, P271, P280, and P501 (click each P-code to see the statement)'],
      ),
      962,
    );

    expect(ghs.hazardStatements.map((h) => h.code)).toEqual(['H315', 'H319', 'H335']);
    expect(ghs.hazardStatements[0]!.statement).toBe(
      'Causes skin irritation [Warning Skin corrosion/irritation]',
    );
  });

  it('still parses a hazard statement with no percentage annotation', async () => {
    const ghs = await ghsFrom(
      ghsRecord(1, ['H302: Harmful if swallowed [Warning Acute toxicity, oral]'], []),
      1,
    );

    expect(ghs.hazardStatements).toEqual([
      { code: 'H302', statement: 'Harmful if swallowed [Warning Acute toxicity, oral]' },
    ]);
  });

  it('parses subcategory-suffixed codes and asterisk-annotated statements', async () => {
    // Verbatim shapes from CID 23954 (H361f), CID 24261 (H350i), CID 887 (H360FD) and the
    // asterisk marker CID 241/887 carry. A suffixed code names a narrower classification than
    // its base, and on CID 23954 H361f is deposited with no bare H361 to fall back on.
    const ghs = await ghsFrom(
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
      23954,
    );

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

  it('parses an unterminated asterisk run in linear time', async () => {
    // The annotation group used to nest `\*+` inside a `*` loop, so a code followed by a
    // run of asterisks and no `:` separator forced the engine to try every partition of
    // that run — 26ms at 24 asterisks, doubling with each one added. A depositor field of
    // this shape would pin the event loop for the life of the process.
    const statement = `H370 ${'*'.repeat(5000)}`;
    fetchMock.mockResolvedValueOnce(jsonResponse(ghsRecord(241, [statement], [])));

    const client = new PubChemClient();
    const started = performance.now();
    const result = await client.getSafetyData(241);
    const elapsedMs = performance.now() - started;

    // No separator, so nothing parses out of it — the point is that it returns at all.
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;
    expect(ghs.hazardStatements).toEqual([]);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('keeps a suffixed code distinct from its base code', async () => {
    // H360 and H360D are different classifications, so dedup-by-code must not collapse them.
    const ghs = await ghsFrom(
      ghsRecord(
        6228,
        [
          'H360: May damage fertility or the unborn child [Danger Reproductive toxicity]',
          'H360D: May damage the unborn child [Danger Reproductive toxicity]',
        ],
        [],
      ),
      6228,
    );

    expect(ghs.hazardStatements.map((h) => h.code)).toEqual(['H360', 'H360D']);
  });

  // #42 — PUG View answers both 404 outcomes as PUGVIEW.NotFound. Collapsing them made a
  // mistyped CID indistinguishable from a real compound carrying no safety classification.
  // An unrecognizable 404 falls back to no_ghs_data: understating what is known beats sending
  // the caller after a "wrong" CID that is fine.
  it.each([
    [
      'no GHS Classification section exists',
      () =>
        jsonResponse({
          Record: {
            RecordType: 'CID',
            RecordNumber: 999,
            Section: [{ TOCHeading: 'Names and Identifiers' }],
          },
        }),
      'no_ghs_data',
    ],
    [
      'the GHS section has no parseable data',
      () =>
        jsonResponse({
          Record: {
            RecordType: 'CID',
            RecordNumber: 1,
            Section: [{ TOCHeading: 'GHS Classification', Information: [] }],
          },
        }),
      'no_ghs_data',
    ],
    ['PUG View has no record for the CID', () => pugViewFault('No record found'), 'cid_not_found'],
    [
      'the CID exists but the heading carries no data',
      () => pugViewFault('No data found'),
      'no_ghs_data',
    ],
    [
      'a 404 carries no recognizable fault message',
      () => textResponse('Not Found', 404),
      'no_ghs_data',
    ],
  ])('reports the right status when %s', async (_label, respond, status) => {
    fetchMock.mockResolvedValueOnce(respond());

    const result = await new PubChemClient().getSafetyData(999999999);

    expect(result).toEqual({ status });
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

// ── getSafetyData — per-source classifications ───────────────────────

/** Captured PUG View `heading=GHS+Classification` responses (2026-10-14), `Record.Reference`
 * trimmed to the fields the parser reads; `Section` is verbatim. */
const FIXTURES = new URL('../../fixtures/', import.meta.url);

type PugViewFixture = {
  Record: {
    Reference: Array<{ ReferenceNumber: number; SourceName: string; Name?: string }>;
    Section: Array<Record<string, unknown>>;
  };
};

function ghsFixture(cid: number): PugViewFixture {
  return JSON.parse(readFileSync(new URL(`ghs-${cid}.json`, FIXTURES), 'utf8')) as PugViewFixture;
}

/** The fixture's GHS Classification `Information` array (Safety and Hazards > Hazards
 * Identification > GHS Classification on every captured record). */
function ghsInformation(record: PugViewFixture): Array<{ ReferenceNumber?: number }> {
  const find = (sections: Array<Record<string, unknown>>): Array<{ ReferenceNumber?: number }> => {
    for (const s of sections) {
      if (s.TOCHeading === 'GHS Classification') {
        return s.Information as Array<{ ReferenceNumber?: number }>;
      }
      if (s.Section) {
        const found = find(s.Section as Array<Record<string, unknown>>);
        if (found.length > 0) return found;
      }
    }
    return [];
  };
  return find(record.Record.Section);
}

/** Replace the fixture's GHS `Information` array in place. */
function setGhsInformation(record: PugViewFixture, infos: Array<{ ReferenceNumber?: number }>) {
  const current = ghsInformation(record);
  current.splice(0, current.length, ...infos);
}

const baseline = JSON.parse(
  readFileSync(new URL('ghs-toplevel-baseline.json', FIXTURES), 'utf8'),
) as Record<
  string,
  Pick<GHSClassification, 'pictograms' | 'hazardStatements' | 'precautionaryStatements'>
>;

async function safetyFrom(record: unknown, cid: number) {
  fetchMock.mockResolvedValueOnce(jsonResponse(record));
  return await new PubChemClient().getSafetyData(cid);
}

async function ghsFrom(record: unknown, cid: number): Promise<GHSClassification> {
  const result = await safetyFrom(record, cid);
  expect(result.status).toBe('ok');
  return (result as { status: 'ok'; ghs: GHSClassification }).ghs;
}

describe('PubChemClient.getSafetyData — per-source classifications (#63)', () => {
  // Characterization: the merged top-level unions are part of the contract and must not move.
  // The baseline file is the pre-change parser's own output over these fixtures.
  it.each([702, 2244, 5743])(
    'keeps the top-level pictogram, hazard, and precautionary unions for CID %i',
    async (cid) => {
      const ghs = await ghsFrom(ghsFixture(cid), cid);

      expect({
        pictograms: ghs.pictograms,
        hazardStatements: ghs.hazardStatements,
        precautionaryStatements: ghs.precautionaryStatements,
      }).toStrictEqual(baseline[String(cid)]);
    },
  );

  it('fetches only the GHS Classification heading', async () => {
    await ghsFrom(ghsFixture(5743), 5743);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.hostname).toBe('pubchem.ncbi.nlm.nih.gov');
    expect(url.pathname).toBe('/rest/pug_view/data/compound/5743/JSON');
    expect(url.searchParams.get('heading')).toBe('GHS Classification');
  });

  it("returns each source's classification intact for ethanol (CID 702)", async () => {
    const ghs = await ghsFrom(ghsFixture(702), 702);
    const classifications = ghs.classifications;

    expect(classifications).toHaveLength(11);
    // EU harmonised classification: H225 only, no notifier percentage on a regulation.
    expect(classifications[0]).toStrictEqual({
      source: 'Regulation (EC) No 1272/2008 of the European Parliament and of the Council',
      sourceRecord: 'ethanol; ethyl alcohol',
      signalWord: 'Danger',
      pictograms: ['Flammable'],
      hazardCodes: [{ code: 'H225' }],
    });
    // ECHA aggregate keeps the agreement percentages verbatim and the notification count.
    expect(classifications[1]).toMatchObject({
      source: 'European Chemicals Agency (ECHA)',
      sourceRecord: 'Ethanol (EC: 200-578-6)',
      signalWord: 'Danger',
      pictograms: ['Flammable', 'Irritant'],
    });
    expect(classifications[1]!.hazardCodes).toStrictEqual([
      { code: 'H225', agreement: '> 99.9%' },
      { code: 'H319', agreement: '37.7%' },
    ]);
    expect(classifications[1]!.notifications).toBe(
      'Aggregated GHS information provided per 13886 reports by companies from 79 notifications to the ECHA C&L Inventory. Each notification may be associated with multiple companies.',
    );
    // A single-company ECHA notification is a separate classification with its own 100%.
    expect(classifications[2]).toMatchObject({
      sourceRecord: 'Alcohol',
      signalWord: 'Warning',
      hazardCodes: [
        { code: 'H319', agreement: '100%' },
        { code: 'H412', agreement: '100%' },
      ],
      notifications:
        'The GHS information provided by 1 company from 1 notification to the ECHA C&L Inventory.',
    });
    // Classifications follow PubChem's order.
    expect(classifications.map((c) => c.source)).toEqual([
      'Regulation (EC) No 1272/2008 of the European Parliament and of the Council',
      'European Chemicals Agency (ECHA)',
      'European Chemicals Agency (ECHA)',
      'European Chemicals Agency (ECHA)',
      'European Chemicals Agency (ECHA)',
      'European Chemicals Agency (ECHA)',
      'NITE-CMC',
      'NITE-CMC',
      'NITE-CMC',
      'Hazardous Chemical Information System (HCIS), Safe Work Australia',
      'Hazardous Substances Data Bank (HSDB)',
    ]);
    expect(classifications.some((c) => c.notClassified)).toBe(false);
  });

  it('attributes a minority hazard code to the one classification that made it (CID 702 H350)', async () => {
    const ghs = await ghsFrom(ghsFixture(702), 702);
    const withH350 = ghs.classifications.filter((c) =>
      c.hazardCodes.some((h) => h.code === 'H350'),
    );

    expect(withH350).toHaveLength(1);
    expect(withH350[0]).toMatchObject({
      source: 'NITE-CMC',
      sourceRecord: 'Ethanol - FY2013 (Revised classification)',
    });
    // Still in the top-level union.
    expect(ghs.hazardStatements.map((h) => h.code)).toContain('H350');
  });

  it('credits source to the GHS contributors only, never Reference[0]', async () => {
    const dexamethasone = await ghsFrom(ghsFixture(5743), 5743);
    expect(dexamethasone.source).toBe('European Chemicals Agency (ECHA)');

    // CID 8929's Reference[0] is the Emergency Response Guidebook, which deposits no GHS entry.
    const record = ghsFixture(8929);
    expect(record.Record.Reference[0]!.SourceName).toBe('Emergency Response Guidebook (ERG)');
    const cyanide = await ghsFrom(record, 8929);
    expect(cyanide.source).toBe(
      'European Chemicals Agency (ECHA); NITE-CMC; Hazardous Chemical Information System (HCIS), Safe Work Australia',
    );

    // Distinct sources, PubChem order, five ECHA classifications named once.
    const ethanol = await ghsFrom(ghsFixture(702), 702);
    expect(ethanol.source).toBe(
      'Regulation (EC) No 1272/2008 of the European Parliament and of the Council; European Chemicals Agency (ECHA); NITE-CMC; Hazardous Chemical Information System (HCIS), Safe Work Australia; Hazardous Substances Data Bank (HSDB)',
    );
  });

  it('reports the most severe signal word regardless of block order (CID 2244)', async () => {
    const ghs = await ghsFrom(ghsFixture(2244), 2244);
    expect(ghs.signalWord).toBe('Danger');
    // The ECHA aggregate's own label says Warning — kept on its classification.
    expect(ghs.classifications[0]).toMatchObject({
      source: 'European Chemicals Agency (ECHA)',
      signalWord: 'Warning',
    });

    // Reverse the classification blocks so the ECHA Warning block is read last.
    const reversed = ghsFixture(2244);
    const infos = ghsInformation(reversed);
    const order = [...new Set(infos.map((i) => i.ReferenceNumber))].reverse();
    setGhsInformation(
      reversed,
      order.flatMap((ref) => infos.filter((i) => i.ReferenceNumber === ref)),
    );
    expect(ghsInformation(reversed).at(-1)?.ReferenceNumber).toBe(51);

    const reversedGhs = await ghsFrom(reversed, 2244);
    expect(reversedGhs.signalWord).toBe('Danger');
    expect(reversedGhs.classifications.at(-1)).toMatchObject({ signalWord: 'Warning' });
  });

  it('keeps a classification that carries no signal word (CID 241, NITE-CMC FY2014)', async () => {
    const ghs = await ghsFrom(ghsFixture(241), 241);
    const fy2014 = ghs.classifications.find(
      (c) => c.sourceRecord === 'Benzene - FY2014 (Revised classification)',
    );

    expect(fy2014).toBeDefined();
    expect(fy2014).not.toHaveProperty('signalWord');
    expect(fy2014!.hazardCodes.map((h) => h.code)).toEqual(['H401', 'H411']);
    expect(ghs.classifications).toHaveLength(7);
  });

  it('reads the agreement annotation and ignores asterisk markers', async () => {
    // Sparse shape: no ReferenceNumber, no Reference list — one classification, no source.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Record: {
          RecordType: 'CID',
          RecordNumber: 23954,
          Section: [
            {
              TOCHeading: 'GHS Classification',
              Information: [
                {
                  Name: 'GHS Hazard Statements',
                  Value: {
                    StringWithMarkup: [
                      { String: 'H361f: Suspected of damaging fertility' },
                      {
                        String: 'H360FD (100%): May damage fertility; May damage the unborn child',
                      },
                      { String: 'H370 **: Causes damage to organs' },
                      { String: 'H370 (12.5%) *: Causes damage to organs' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const result = await new PubChemClient().getSafetyData(23954);
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;

    expect(ghs.classifications).toHaveLength(1);
    expect(ghs.classifications[0]).not.toHaveProperty('source');
    expect(ghs.source).toBeUndefined();
    // First occurrence of a code wins within one classification, as in the top-level union.
    expect(ghs.classifications[0]!.hazardCodes).toStrictEqual([
      { code: 'H361f' },
      { code: 'H360FD', agreement: '100%' },
      { code: 'H370' },
    ]);
    // The top-level statements never carry the annotation.
    expect(ghs.hazardStatements).toStrictEqual([
      { code: 'H361f', statement: 'Suspected of damaging fertility' },
      { code: 'H360FD', statement: 'May damage fertility; May damage the unborn child' },
      { code: 'H370', statement: 'Causes damage to organs' },
    ]);
  });
});

describe('PubChemClient.getSafetyData — ECHA "Not Classified" verdicts (#71)', () => {
  it('reports not_classified for D-glucose (CID 5793), every block a verdict', async () => {
    const result = await safetyFrom(ghsFixture(5793), 5793);

    expect(result.status).toBe('not_classified');
    const ghs = (result as { status: 'not_classified'; ghs: GHSClassification }).ghs;
    expect(ghs.classifications).toStrictEqual([
      {
        source: 'European Chemicals Agency (ECHA)',
        sourceRecord: 'Glucose (EC: 200-075-1)',
        pictograms: [],
        hazardCodes: [],
        notClassified: true,
        notifications:
          'Reported as not meeting GHS hazard criteria by 946 of 969 companies (only 2.4% companies provided GHS information).',
      },
      {
        source: 'European Chemicals Agency (ECHA)',
        sourceRecord: 'D-Glucose (EC: 807-615-0)',
        pictograms: [],
        hazardCodes: [],
        notClassified: true,
        notifications: 'Reported as not meeting GHS hazard criteria by 3 of 3 companies.',
      },
      {
        // This block deposits no notifications summary; the verdict line still carries counts.
        source: 'European Chemicals Agency (ECHA)',
        sourceRecord: 'D-glucose (EC: 218-914-5)',
        pictograms: [],
        hazardCodes: [],
        notClassified: true,
        notifications: 'Reported as not meeting GHS hazard criteria by 1 of 1 companies.',
      },
    ]);
    expect(ghs.signalWord).toBeUndefined();
    expect(ghs.pictograms).toEqual([]);
    expect(ghs.hazardStatements).toEqual([]);
    expect(ghs.precautionaryStatements).toEqual([]);
    expect(ghs.source).toBe('European Chemicals Agency (ECHA)');
  });

  it('reports not_classified for folic acid (CID 135398658) with the notifier counts', async () => {
    const result = await safetyFrom(ghsFixture(135398658), 135398658);

    expect(result.status).toBe('not_classified');
    const ghs = (result as { status: 'not_classified'; ghs: GHSClassification }).ghs;
    expect(ghs.classifications).toHaveLength(1);
    expect(ghs.classifications[0]).toMatchObject({
      notClassified: true,
      hazardCodes: [],
      notifications:
        'Reported as not meeting GHS hazard criteria by 188 of 203 companies (only 7.4% companies provided GHS information).',
    });
  });

  it('keeps ok and flags the verdict block when hazard classifications sit beside it', async () => {
    // Ethanol's 11 classifications plus folic acid's not-classified ECHA block, renumbered.
    const mixed = ghsFixture(702);
    const verdict = ghsFixture(135398658);
    const verdictBlock = ghsInformation(verdict).map((info) => ({ ...info, ReferenceNumber: 900 }));
    setGhsInformation(mixed, [...ghsInformation(mixed), ...verdictBlock]);
    mixed.Record.Reference.push({
      ReferenceNumber: 900,
      SourceName: 'European Chemicals Agency (ECHA)',
      Name: 'Folic acid (EC: 200-419-0)',
    });

    const result = await safetyFrom(mixed, 702);

    expect(result.status).toBe('ok');
    const ghs = (result as { status: 'ok'; ghs: GHSClassification }).ghs;
    expect(ghs.classifications).toHaveLength(12);
    expect(ghs.classifications.at(-1)).toMatchObject({
      sourceRecord: 'Folic acid (EC: 200-419-0)',
      notClassified: true,
      hazardCodes: [],
    });
    expect(ghs.classifications.filter((c) => c.notClassified)).toHaveLength(1);
    // The verdict changes none of the merged top-level fields.
    expect(ghs.signalWord).toBe('Danger');
    expect({
      pictograms: ghs.pictograms,
      hazardStatements: ghs.hazardStatements,
      precautionaryStatements: ghs.precautionaryStatements,
    }).toStrictEqual(baseline['702']);
  });

  it('keeps no_ghs_data and cid_not_found for the two 404 faults', async () => {
    fetchMock.mockResolvedValueOnce(pugViewFault('No data found'));
    expect(await new PubChemClient().getSafetyData(11979316)).toEqual({ status: 'no_ghs_data' });

    fetchMock.mockResolvedValueOnce(pugViewFault('No record found'));
    expect(await new PubChemClient().getSafetyData(999999999)).toEqual({
      status: 'cid_not_found',
    });
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

// ── getClassification: ATC (#64) ──────────────────────────────────────

/**
 * Real PUG View `ATC Code` sections for aspirin (2244), ibuprofen (3672), dexamethasone (5743)
 * and atorvastatin (60823), trimmed to the fields the parser reads: every `Information` entry
 * in deposit order with its ReferenceNumber, Name and strings, plus the `Record.Reference`
 * entries those numbers point at. Each section opens with a bare code from NORMAN Suspect List
 * Exchange, then one five-string WHO ATC block per code, ATCvet blocks (`Q…`), and a WHO Model
 * List of Essential Medicines code list (`"C05AA09; H02AB02; L01AA01"` on 5743).
 */
type PugViewRecordFixture = {
  Record: {
    Section: Array<{ Section: Array<{ Information: Array<Record<string, unknown>> }> }>;
    Reference: Array<{ ReferenceNumber: number; SourceName: string }>;
  };
};
const atcFixtures = JSON.parse(
  readFileSync(new URL('../../fixtures/pug-view-atc.json', import.meta.url), 'utf8'),
) as Record<string, PugViewRecordFixture>;

/** A deep copy of one fixture, so a test can reshape its ATC entries without leaking. */
function atcFixture(cid: number): PugViewRecordFixture {
  return structuredClone(atcFixtures[String(cid)]!);
}

function atcInformation(record: PugViewRecordFixture): Array<Record<string, unknown>> {
  return record.Record.Section[0]!.Section[0]!.Information;
}

async function classify(record: PugViewRecordFixture, cid: number) {
  fetchMock.mockResolvedValueOnce(jsonResponse(record));
  return new PubChemClient().getClassification(cid);
}

describe('PubChemClient.getClassification — ATC codes on real PUG View sections (#64)', () => {
  const expectedCodes: Record<number, string[]> = {
    2244: ['N02BA01', 'A01AD05', 'B01AC06'],
    3672: ['M01AE01', 'M02AA13', 'C01EB16', 'R02AX02', 'G02CC01'],
    5743: [
      'H02AB02',
      'R01AD03',
      'A01AC02',
      'S01BA01',
      'S03BA01',
      'D07AB19',
      'D10AA03',
      'C05AA09',
      'S02BA06',
      'S01CB01',
      'D07XB05',
    ],
    60823: ['C10AA05'],
  };

  it.each([2244, 3672, 5743, 60823])(
    'returns the human ATC codes of CID %i in first-appearance order, without ATCvet or Essential Medicines extras',
    async (cid) => {
      const result = await classify(atcFixture(cid), cid);
      const codes = result!.atcCodes.map((a) => a.code);

      expect(codes).toEqual(expectedCodes[cid]);
      expect(codes.some((code) => code.startsWith('Q'))).toBe(false);
      expect(codes).not.toContain('L01AA01');
    },
  );

  it.each([2244, 3672, 5743, 60823])(
    'gives every code of CID %i its WHO description and four levels forming a prefix chain',
    async (cid) => {
      const result = await classify(atcFixture(cid), cid);

      for (const atc of result!.atcCodes) {
        expect(atc.description).not.toBe('');
        expect(atc.levels.map((l) => l.code)).toEqual([
          atc.code.slice(0, 1),
          atc.code.slice(0, 3),
          atc.code.slice(0, 4),
          atc.code.slice(0, 5),
        ]);
        for (const level of atc.levels) expect(level.description).not.toBe('');
      }
    },
  );

  it('returns atorvastatin C10AA05 with its name and full hierarchy, not an empty bare code', async () => {
    const result = await classify(atcFixture(60823), 60823);

    expect(result!.atcCodes).toEqual([
      {
        code: 'C10AA05',
        description: 'Atorvastatin',
        levels: [
          { code: 'C', description: 'Cardiovascular system' },
          { code: 'C10', description: 'Lipid modifying agents' },
          { code: 'C10A', description: 'Lipid modifying agents, plain' },
          { code: 'C10AA', description: 'Hmg coa reductase inhibitors' },
        ],
      },
    ]);
  });

  it("keeps aspirin's NORMAN-first N02BA01 in first place with the WHO entry's content", async () => {
    const result = await classify(atcFixture(2244), 2244);

    expect(result!.atcCodes[0]).toEqual({
      code: 'N02BA01',
      description: 'Acetylsalicylic acid',
      levels: [
        { code: 'N', description: 'Nervous system' },
        { code: 'N02', description: 'Analgesics' },
        { code: 'N02B', description: 'Other analgesics and antipyretics' },
        { code: 'N02BA', description: 'Salicylic acid and derivatives' },
      ],
    });
  });

  it('takes levels from the code’s own block when two blocks share an anatomical group', async () => {
    // Ibuprofen carries two M blocks (M02AA13, then M01AE01); each code's levels come from
    // its own Information entry, never from the neighbouring block.
    const result = await classify(atcFixture(3672), 3672);
    const byCode = new Map(result!.atcCodes.map((a) => [a.code, a]));

    expect(byCode.get('M01AE01')!.levels.map((l) => l.code)).toEqual(['M', 'M01', 'M01A', 'M01AE']);
    expect(byCode.get('M02AA13')!.levels.map((l) => l.code)).toEqual(['M', 'M02', 'M02A', 'M02AA']);
  });

  it('returns a code deposited only bare with an empty description and no levels', async () => {
    const record = atcFixture(60823);
    const infos = atcInformation(record);
    // Drop atorvastatin's WHO ATC block; the NORMAN bare "C10AA05" and the ATCvet block remain.
    infos.splice(
      infos.findIndex((i) => i.ReferenceNumber === 143),
      1,
    );

    const result = await classify(record, 60823);

    expect(result!.atcCodes).toEqual([{ code: 'C10AA05', description: '', levels: [] }]);
  });

  it('never returns a code that only a WHO Essential Medicines code list carries', async () => {
    const record = atcFixture(5743);
    const essentialMedicines = atcInformation(record).find((i) => i.ReferenceNumber === 186)!;
    // A list of one code is a bare-looking string; its source still rules it out.
    essentialMedicines.Value = { StringWithMarkup: [{ String: 'L01AA01' }] };

    const result = await classify(record, 5743);

    expect(result!.atcCodes.map((a) => a.code)).toEqual(expectedCodes[5743]);
  });

  it('skips a markup-only ATC string entry and still returns the codes beside it', async () => {
    const record = atcFixture(60823);
    const who = atcInformation(record).find((i) => i.ReferenceNumber === 143)!;
    const value = who.Value as { StringWithMarkup: Array<Record<string, unknown>> };
    value.StringWithMarkup.unshift({ Markup: [] });

    const result = await classify(record, 60823);

    expect(result!.atcCodes).toEqual([
      {
        code: 'C10AA05',
        description: 'Atorvastatin',
        levels: [
          { code: 'C', description: 'Cardiovascular system' },
          { code: 'C10', description: 'Lipid modifying agents' },
          { code: 'C10A', description: 'Lipid modifying agents, plain' },
          { code: 'C10AA', description: 'Hmg coa reductase inhibitors' },
        ],
      },
    ]);
  });

  it('returns null for a compound with no ATC section (CID 241)', async () => {
    fetchMock.mockResolvedValueOnce(pugViewFault('No data found'));

    const result = await new PubChemClient().getClassification(241);

    expect(result).toBeNull();
  });
});

// ── getXrefs ──────────────────────────────────────────────────────────

describe('PubChemClient.getXrefs', () => {
  it('returns numeric PubMedID xrefs highest (newest) first', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        InformationList: {
          Information: [{ CID: 2244, PubMedID: [11111, 22222, 33333] }],
        },
      }),
    );

    const client = new PubChemClient();
    const ids = await client.getXrefs(2244, 'PubMedID');

    expect(ids).toEqual([33333, 22222, 11111]);
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

  it.each([
    ['PubChem answers 404', () => textResponse('Not Found', 404)],
    [
      'the xrefType is absent from the response',
      () => jsonResponse({ InformationList: { Information: [{ CID: 2244 }] } }),
    ],
    [
      'InformationList has no entries',
      () => jsonResponse({ InformationList: { Information: [] } }),
    ],
  ])('returns an empty array when %s', async (_label, respond) => {
    fetchMock.mockResolvedValueOnce(respond());

    expect(await new PubChemClient().getXrefs(2244, 'PatentID')).toEqual([]);
  });
});

/**
 * Aspirin (CID 2244) xref responses captured from PUG REST, in PubChem's wire order (lexical
 * for the numeric types). Long lists are sampled — every 100th PubMedID and every 10th GeneID,
 * plus each list's highest and lowest ID — so the order PubChem sends is preserved.
 */
const aspirinXrefs = JSON.parse(
  readFileSync(new URL('../../fixtures/pug-rest-xrefs-2244.json', import.meta.url), 'utf8'),
) as Record<string, { InformationList: { Information: Array<Record<string, unknown>> } }>;

/** The IDs one fixture response carries, in wire order. */
const wireIds = (type: string) =>
  aspirinXrefs[type]!.InformationList.Information[0]![type] as (string | number)[];

/** Serve the aspirin fixture for whichever xref type the request path names. */
function routeAspirinXrefs(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    const type = url.pathname.match(/^\/rest\/pug\/compound\/cid\/2244\/xrefs\/(\w+)\/JSON$/)?.[1];
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov' || !type || !aspirinXrefs[type]) {
      throw new Error(`unrouted fetch: ${url}`);
    }
    return jsonResponse(aspirinXrefs[type]);
  });
}

describe('PubChemClient.getXrefs — numeric ordering on real aspirin xrefs (#69)', () => {
  it('arrives from PubChem in lexical, not numeric, order', () => {
    // The premise: PubChem sends numeric IDs sorted as strings ("10027656" before "1003266").
    const wire = wireIds('PubMedID').map(String);
    expect(wire).toEqual([...wire].sort());
    expect(wire[0]).not.toBe('38840409');
  });

  it('orders PubMedIDs strictly descending, opening with the highest', async () => {
    routeAspirinXrefs();

    const ids = (await new PubChemClient().getXrefs(2244, 'PubMedID')) as number[];

    expect(ids[0]).toBe(38840409);
    expect(ids.at(-1)).toBe(22385);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeLessThan(ids[i - 1]!);
    expect([...ids].sort()).toEqual([...wireIds('PubMedID')].sort());
  });

  it.each(['GeneID', 'TaxonomyID'])('orders %s strictly ascending', async (type) => {
    routeAspirinXrefs();

    const ids = (await new PubChemClient().getXrefs(2244, type)) as number[];

    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    expect([...ids].sort()).toEqual([...wireIds(type)].sort());
  });

  it('opens the TaxonomyID list with 6239', async () => {
    routeAspirinXrefs();

    const ids = await new PubChemClient().getXrefs(2244, 'TaxonomyID');

    expect(ids[0]).toBe(6239);
  });

  it('sorts ProteinGI numerically too when PubChem returns it', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ InformationList: { Information: [{ CID: 2244, ProteinGI: [10, 100, 9] }] } }),
    );

    const ids = await new PubChemClient().getXrefs(2244, 'ProteinGI');

    // PubChem's lexical order is "10" < "100" < "9"; numerically ascending puts 9 first.
    expect(ids).toEqual([9, 10, 100]);
  });

  it.each(['RN', 'RegistryID', 'PatentID'])(
    'keeps PubChem’s order for string %s IDs',
    async (type) => {
      routeAspirinXrefs();

      const ids = await new PubChemClient().getXrefs(2244, type);

      expect(ids).toEqual(wireIds(type));
    },
  );
});

// ── getHeadingXrefs ───────────────────────────────────────────────────

/**
 * PUG View `heading=CAS` and `heading=European+Community+(EC)+Number` responses captured
 * 2026-10-24, keyed `<type>/<cid>`. `Record.Reference` is trimmed to ReferenceNumber and
 * SourceName; `Record.Section` is as served.
 */
const headingCaptures = JSON.parse(
  readFileSync(new URL('../../fixtures/pug-view-cas-ec.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

/** Serve the capture for the CID and heading the request names; anything else is unrouted. */
function routeHeadingCaptures(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    const cid = url.pathname.match(/^\/rest\/pug_view\/data\/compound\/(\d+)\/JSON$/)?.[1];
    const heading = url.searchParams.get('heading');
    const type = heading === 'European Community (EC) Number' ? 'EC' : heading;
    const capture = headingCaptures[`${type}/${cid}`];
    if (url.hostname !== 'pubchem.ncbi.nlm.nih.gov' || !capture) {
      throw new Error(`unrouted fetch: ${url}`);
    }
    return jsonResponse(capture);
  });
}

/** A PUG View record whose sections are `sections`. */
const pugViewRecord = (sections: unknown[]) =>
  jsonResponse({ Record: { RecordType: 'CID', RecordNumber: 1, Section: sections } });

/** One deposit: `values` under ReferenceNumber `ref`. */
const deposit = (ref: number | undefined, ...values: string[]) => ({
  ...(ref !== undefined && { ReferenceNumber: ref }),
  Value: { StringWithMarkup: values.map((value) => ({ String: value })) },
});

describe('PubChemClient.getHeadingXrefs — CAS and EC from PUG View (#77)', () => {
  it.each([
    ['ethanol’s CAS number', 702, 'CAS', [{ id: '64-17-5', sourceCount: 24 }]],
    ['ethanol’s EC number', 702, 'EC', [{ id: '200-578-6', sourceCount: 1 }]],
    ['aspirin’s CAS number', 2244, 'CAS', [{ id: '50-78-2', sourceCount: 19 }]],
    [
      'every distinct D-glucose CAS value, most-attested first,',
      5793,
      'CAS',
      [
        { id: '50-99-7', sourceCount: 11 },
        { id: '2280-44-6', sourceCount: 4 },
        { id: '54-17-1', sourceCount: 2 },
        { id: '1227096-09-4', sourceCount: 1 },
      ],
    ],
  ] as const)(
    'returns %s with its depositing source-record counts',
    async (_label, cid, type, expected) => {
      routeHeadingCaptures();

      expect(await new PubChemClient().getHeadingXrefs(cid, type)).toEqual(expected);
    },
  );

  it('keeps first-appearance order between values with the same count', async () => {
    routeHeadingCaptures();
    const client = new PubChemClient();

    // Sodium chloride: 32343-72-9 is deposited before 8028-77-1, one source each.
    expect(await client.getHeadingXrefs(5234, 'CAS')).toEqual([
      { id: '7647-14-5', sourceCount: 14 },
      { id: '14762-51-7', sourceCount: 4 },
      { id: '32343-72-9', sourceCount: 1 },
      { id: '8028-77-1', sourceCount: 1 },
    ]);
    expect(await client.getHeadingXrefs(5234, 'EC')).toEqual([
      { id: '231-598-3', sourceCount: 1 },
      { id: '617-042-6', sourceCount: 1 },
    ]);
  });

  it.each([
    ['CAS', 'CAS'],
    ['EC', 'European Community (EC) Number'],
  ] as const)('requests the %s heading by its exact name', async (type, heading) => {
    fetchMock.mockResolvedValueOnce(pugViewRecord([]));

    await new PubChemClient().getHeadingXrefs(2244, type);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.hostname).toBe('pubchem.ncbi.nlm.nih.gov');
    expect(url.pathname).toBe('/rest/pug_view/data/compound/2244/JSON');
    expect(url.searchParams.get('heading')).toBe(heading);
  });

  it('reads only the section whose TOCHeading matches exactly', async () => {
    fetchMock.mockResolvedValueOnce(
      pugViewRecord([
        {
          TOCHeading: 'Names and Identifiers',
          Section: [
            {
              TOCHeading: 'Other Identifiers',
              /* Each decoy sits before the real heading, so a looser match — a substring or a
               * case-insensitive comparison — reaches the decoy first and fails the test. */
              Section: [
                { TOCHeading: 'Deprecated CAS', Information: [deposit(1, '11126-35-5')] },
                { TOCHeading: 'cas', Information: [deposit(4, '999-99-9')] },
                {
                  TOCHeading: 'CAS',
                  Information: [deposit(2, '50-78-2')],
                  // A heading nested under CAS is a different heading, not more CAS values.
                  Section: [
                    { TOCHeading: 'Related CAS', Information: [deposit(3, '156865-15-5')] },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );

    expect(await new PubChemClient().getHeadingXrefs(2244, 'CAS')).toEqual([
      { id: '50-78-2', sourceCount: 1 },
    ]);
  });

  it('skips a StringWithMarkup entry that carries no String', async () => {
    fetchMock.mockResolvedValueOnce(
      pugViewRecord([
        {
          TOCHeading: 'CAS',
          Information: [
            { ReferenceNumber: 1, Value: { StringWithMarkup: [{ Markup: [] }] } },
            { ReferenceNumber: 2, Value: { StringWithMarkup: [{}, { String: '50-78-2' }] } },
          ],
        },
      ]),
    );

    expect(await new PubChemClient().getHeadingXrefs(2244, 'CAS')).toEqual([
      { id: '50-78-2', sourceCount: 1 },
    ]);
  });

  it('counts a source record once per value, and an unattributed entry as a record of its own', async () => {
    fetchMock.mockResolvedValueOnce(
      pugViewRecord([
        {
          TOCHeading: 'CAS',
          Information: [
            deposit(1, '2280-44-6'),
            deposit(2, '50-99-7'),
            deposit(1, '2280-44-6', ' 2280-44-6 '),
            deposit(3, '50-99-7'),
            deposit(undefined, '50-99-7'),
            deposit(4, '', '  '),
          ],
        },
      ]),
    );

    expect(await new PubChemClient().getHeadingXrefs(5793, 'CAS')).toEqual([
      { id: '50-99-7', sourceCount: 3 },
      { id: '2280-44-6', sourceCount: 1 },
    ]);
  });

  it.each([
    ['a real CID without the heading', 'No data found'],
    ['a nonexistent CID', 'No record found'],
  ])('returns an empty list for %s (404 %s)', async (_label, message) => {
    fetchMock.mockResolvedValueOnce(pugViewFault(message));

    expect(await new PubChemClient().getHeadingXrefs(170000000, 'CAS')).toEqual([]);
  });

  it('returns an empty list when the record carries no matching section', async () => {
    fetchMock.mockResolvedValueOnce(
      pugViewRecord([{ TOCHeading: 'Names and Identifiers', Section: [] }]),
    );

    expect(await new PubChemClient().getHeadingXrefs(2244, 'EC')).toEqual([]);
  });

  it('surfaces a failure other than 404 with its status and fault, without a retry', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Fault: {
            Code: 'PUGVIEW.BadRequest',
            Message: 'Heading is either not found or ambiguous',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const error = await new PubChemClient().getHeadingXrefs(2244, 'CAS').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        status: 400,
        fault: 'PUGVIEW.BadRequest: Heading is either not found or ambiguous',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it.each([
    ['PubChem answers 404', () => textResponse('Not Found', 404)],
    [
      'the Synonym field is absent',
      () => jsonResponse({ InformationList: { Information: [{ CID: 2244 }] } }),
    ],
  ])('returns an empty array when %s', async (_label, respond) => {
    fetchMock.mockResolvedValueOnce(respond());

    expect(await new PubChemClient().getSynonyms(2244)).toEqual([]);
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

// ── getAssayCidPage ───────────────────────────────────────────────────

describe('PubChemClient.getAssayCidPage (#68)', () => {
  /** The listkey envelope as PubChem returned it live for AID 1000's actives. */
  const listKey = (size: number) =>
    jsonResponse({
      IdentifierList: {
        ListKey: '2084619401385678753',
        Size: size,
        EntrezDB: 'pccompound',
        EntrezWebEnv: 'MCID_6ad01b42e62f0ac05509fef1',
        EntrezQueryKey: 1,
      },
    });
  const fault = (status: number, message: string) =>
    jsonResponse({ Fault: { Code: 'PUGREST.NotFound', Message: message } }, status);

  it('asks for the listkey, then exactly the requested page of it', async () => {
    fetchMock
      .mockResolvedValueOnce(listKey(36))
      .mockResolvedValueOnce(jsonResponse({ IdentifierList: { CID: [101, 102, 103] } }));

    const page = await new PubChemClient().getAssayCidPage(1000, true, 30, 3);

    expect(page).toEqual({ total: 36, cids: [101, 102, 103] });
    const [listUrl, pageUrl] = fetchMock.mock.calls.map(([u]) => new URL(String(u)));
    expect(listUrl!.pathname).toBe('/rest/pug/assay/aid/1000/cids/JSON');
    expect(Object.fromEntries(listUrl!.searchParams)).toEqual({
      cids_type: 'active',
      list_return: 'listkey',
    });
    expect(pageUrl!.pathname).toBe('/rest/pug/compound/listkey/2084619401385678753/cids/JSON');
    expect(Object.fromEntries(pageUrl!.searchParams)).toEqual({
      listkey_start: '30',
      listkey_count: '3',
    });
  });

  it('asks for every tested CID when activeOnly is false', async () => {
    fetchMock
      .mockResolvedValueOnce(listKey(57))
      .mockResolvedValueOnce(jsonResponse({ IdentifierList: { CID: [1] } }));

    await new PubChemClient().getAssayCidPage(1000, false, 0, 1);

    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('cids_type')).toBe('all');
  });

  it('sends no page request at or past the end of the list', async () => {
    fetchMock.mockResolvedValueOnce(listKey(36));

    const page = await new PubChemClient().getAssayCidPage(1000, true, 36, 20);

    expect(page).toEqual({ total: 36, cids: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for "No live AIDs" and an empty page for "No CIDs found"', async () => {
    fetchMock
      .mockResolvedValueOnce(fault(404, 'No live AIDs in the supplied AID list'))
      .mockResolvedValueOnce(fault(404, 'No CIDs found for the given AID(s)'));
    const client = new PubChemClient();

    await expect(client.getAssayCidPage(99999999, true, 0, 20)).resolves.toBeNull();
    await expect(client.getAssayCidPage(3365, true, 0, 20)).resolves.toEqual({
      total: 0,
      cids: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a non-404 listkey failure as the call’s failure', async () => {
    fetchMock.mockResolvedValue(textResponse('Bad Request', 400));

    await expect(new PubChemClient().getAssayCidPage(1000, true, 0, 20)).rejects.toBeInstanceOf(
      McpError,
    );
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
    const { rows } = await client.getAssaySummary(2244);

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
    const { rows } = await client.getAssaySummary(2244);

    expect(rows[0]!.activityValues).toHaveLength(1);
    expect(rows[0]!.activityValues[0]!.value).toBe(5.0);
    expect(rows[0]!.activityValues[0]!.unit).toBe('nM');
    expect(rows[0]!.activityValues[0]!.name).toBeUndefined();
  });

  it('returns empty array on 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const { rows } = await client.getAssaySummary(999999999);

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
    const { rows } = await client.getAssaySummary(1);

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
    const { rows } = await client.getAssaySummary(1);

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

  it('throws cid_not_found on 404, leaving the recovery hint to the caller contract', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));

    const client = new PubChemClient();
    const err = (await client.getImage(999999999).catch((e) => e)) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toEqual({ cid: 999999999, reason: 'cid_not_found' });
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

  it('maps a timeout to a classified Timeout instead of the raw abort (#16, #57)', async () => {
    vi.useFakeTimers();
    try {
      // PubChem never answers: the fetch settles only when the request's signal aborts.
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );

      const captured = new PubChemClient().getImage(2244).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = (await captured) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).not.toMatch(/abort/i);
      expect(err.message).not.toContain('/rest/pug');
    } finally {
      vi.useRealTimers();
    }
  });
});
