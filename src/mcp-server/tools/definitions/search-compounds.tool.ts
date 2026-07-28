/**
 * @fileoverview Search PubChem for chemical compounds by name, SMILES, InChIKey,
 * formula, substructure, superstructure, or 2D similarity.
 * @module mcp-server/tools/definitions/search-compounds
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { COMPOUND_PROPERTIES } from '@/services/pubchem/types.js';

const searchTypeEnum = z.enum([
  'identifier',
  'formula',
  'substructure',
  'superstructure',
  'similarity',
]);

const identifierTypeEnum = z.enum(['name', 'smiles', 'inchikey']);
const queryTypeEnum = z.enum(['smiles', 'cid']);
const propertyEnum = z.enum(COMPOUND_PROPERTIES as unknown as [string, ...string[]]);

export const searchCompounds = tool('pubchem_search_compounds', {
  title: 'Search Compounds',
  description:
    'Search PubChem for chemical compounds by identifier (name, SMILES, or InChIKey, batched up to 25), molecular formula in Hill notation, substructure or superstructure containment, or 2D Tanimoto similarity. Returns a page of CIDs — reach matches past maxResults with offset. Optionally hydrate results with properties to avoid a follow-up pubchem_get_compound_details call.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    searchType: searchTypeEnum.describe(
      'Search strategy. "identifier": name/SMILES/InChIKey lookup. "formula": molecular formula. "substructure": find compounds containing the query as a substructure. "superstructure": find compounds that are themselves substructures of the query. "similarity": 2D Tanimoto similarity to the query.',
    ),
    identifierType: identifierTypeEnum
      .optional()
      .describe(
        'Required for identifier search. Type of chemical identifier: "name", "smiles", or "inchikey".',
      ),
    identifiers: z
      .array(z.string())
      .min(1)
      .max(25)
      .refine((arr) => arr.every((s) => s.trim().length > 0), {
        message: 'identifiers must all be non-empty strings',
      })
      .optional()
      .describe(
        'Required for identifier search. Array of identifiers to resolve (1-25). Examples: ["aspirin", "ibuprofen"] for name, ["CC(=O)OC1=CC=CC=C1C(=O)O"] for SMILES, ["BSYNRYMUTXBXSQ-UHFFFAOYSA-N"] for inchikey (27-char block format).',
      ),
    formula: z
      .string()
      .optional()
      .describe(
        'Required for formula search. Molecular formula in Hill notation (e.g. "C6H12O6", "CaH2O2").',
      ),
    allowOtherElements: z
      .boolean()
      .default(false)
      .describe(
        'Formula search only. When true, includes compounds with additional elements beyond the formula.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Required for substructure/superstructure/similarity searches. A SMILES string (e.g. "CC(=O)O") or PubChem CID as a string (e.g. "2244").',
      ),
    queryType: queryTypeEnum
      .optional()
      .describe(
        'Required for structure/similarity searches. Format of the query: "smiles" or "cid".',
      ),
    threshold: z
      .number()
      .min(70)
      .max(100)
      .default(90)
      .describe(
        'Similarity search only. Minimum Tanimoto similarity (70-100). 90+ for close analogs, 70-80 for scaffold hops. Default: 90.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(0)
      .describe(
        'Zero-based index of the first CID to return. Pass the nextOffset from a previous call to read the following page. Identifier lookups resolve every match up front, so paging them is free; formula, substructure, superstructure, and similarity searches have to ask PubChem for offset + maxResults records to reach a page, so deep pages cost progressively more upstream — hence the 10000 ceiling. Default: 0.',
      ),
    maxResults: z
      .number()
      .min(1)
      .max(200)
      .default(20)
      .describe(
        'Maximum CIDs to return per page (1-200). Use offset to reach matches past this page. Default: 20.',
      ),
    properties: z
      .array(propertyEnum)
      .optional()
      .describe(
        'Optional: fetch these properties for each result, avoiding a follow-up details call. E.g. ["MolecularFormula", "MolecularWeight", "CanonicalSMILES"].',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            cid: z.number().describe('PubChem Compound ID.'),
            identifier: z
              .string()
              .optional()
              .describe('Echoed input identifier (identifier mode only).'),
            properties: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Compound properties keyed by name (echoes input.properties; only present when requested).',
              ),
          })
          .describe('Matching compound entry.'),
      )
      .describe('Matching compounds.'),
    unresolvedIdentifiers: z
      .array(z.string())
      .optional()
      .describe(
        'Identifier-mode only: input identifiers that resolved to no CID. Omitted when every identifier resolved and for non-identifier searches.',
      ),
  }),
  // Agent-facing context — search strategy echo, total, the page boundary, and a notice
  // covering unresolved identifiers, an empty page, and further pages. Reaches
  // structuredContent and content[] automatically; not in the domain return.
  //
  // Bounded-total convention: a reported total states only what the server actually
  // observed. `totalFound` carries a true count and appears only when the whole match set
  // was seen. When the upstream request was itself bounded and came back saturated, the
  // exact total is unknowable, so `totalFoundAtLeast` carries a floor in its place rather
  // than a number that reads as a count. Exactly one of the two is populated per call; any
  // other capped output pairs its count field with an `…AtLeast` twin the same way.
  enrichment: {
    searchType: z
      .string()
      .describe(
        'Search strategy used: identifier, formula, substructure, superstructure, or similarity.',
      ),
    totalFound: z
      .number()
      .optional()
      .describe(
        'Exact number of matching CIDs across all pages. Omitted when a formula, substructure, superstructure, or similarity search saturated the records it requested — PubChem returns no match count for those, so totalFoundAtLeast reports a floor instead.',
      ),
    totalFoundAtLeast: z
      .number()
      .optional()
      .describe(
        'Lower bound on matching CIDs, reported in place of totalFound when the exact count is unavailable. At least this many match, and the true total may be higher; page further with offset to observe more.',
      ),
    offset: z.number().describe('Zero-based index of the first CID returned.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue past this page. Omitted when no further matches remain.',
      ),
    truncated: z.boolean().optional().describe('True when matching CIDs remain past this page.'),
    shown: z.number().optional().describe('CIDs returned on this page.'),
    cap: z.number().optional().describe('The maxResults cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no compounds matched, when the offset runs past the matches observed, when identifiers failed to resolve, or when further pages remain. Absent when this page is complete and every identifier resolved.',
      ),
  },
  errors: [
    {
      reason: 'missing_identifier_args',
      code: JsonRpcErrorCode.ValidationError,
      when: 'searchType is "identifier" but identifierType or identifiers were omitted',
      recovery:
        'Set identifierType (name/smiles/inchikey) and pass a non-empty identifiers array (1-25 entries).',
    },
    {
      reason: 'missing_formula',
      code: JsonRpcErrorCode.ValidationError,
      when: 'searchType is "formula" but the formula field was omitted',
      recovery: 'Pass formula in Hill notation, for example "C6H12O6" or "CaH2O2".',
    },
    {
      reason: 'missing_structure_args',
      code: JsonRpcErrorCode.ValidationError,
      when: 'substructure/superstructure/similarity search missing query or queryType',
      recovery:
        'Provide both query (SMILES string or CID as string) and queryType ("smiles" or "cid").',
    },
    {
      reason: 'invalid_cid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'structure/similarity search with queryType "cid" but query is not a positive integer CID',
      recovery:
        'Pass a positive integer CID string (e.g. "2244"), or set queryType "smiles" with a SMILES query.',
    },
  ],

  async handler(input, ctx) {
    const client = getPubChemClient();
    let allCids: number[] = [];
    // Formula and structure searches are bounded server-side. One record past the requested
    // page is enough to prove more matches exist without moving the rest of PubChem's match
    // set, which for a common substructure runs to 16.3 MB of CIDs. The window has to cover
    // the offset too — these endpoints take a record count, not a start position, and their
    // ordering is a stable prefix, so reaching page N means asking for everything up to it.
    const recordCap = input.offset + input.maxResults + 1;
    let boundedSearch = false;
    const identifierMap = new Map<number, string>();
    // Identifier-mode resolution tracking (#29): inputs that resolved to no CID, and
    // CIDs claimed by more than one distinct input (the output row can echo only one).
    const unresolvedIdentifiers: string[] = [];
    const collisions: Array<{ cid: number; identifiers: string[] }> = [];

    switch (input.searchType) {
      case 'identifier': {
        const { identifierType, identifiers } = input;
        if (!identifierType || !identifiers) {
          throw ctx.fail('missing_identifier_args', undefined, {
            ...ctx.recoveryFor('missing_identifier_args'),
          });
        }
        const lookups = identifiers.map(async (id) => {
          let cids: number[];
          switch (identifierType) {
            case 'name':
              cids = await client.searchByName(id);
              break;
            case 'smiles':
              cids = await client.searchBySmiles(id);
              break;
            case 'inchikey':
              cids = await client.searchByInchiKey(id);
              break;
          }
          return { id, cids };
        });
        const resolutions = await Promise.all(lookups);

        // Track resolution per input in request order: a CID's echo goes to its first
        // requester (deterministic, unlike the prior last-write-wins), unresolved inputs
        // are collected, and any CID with multiple distinct requesters is a collision.
        const cidToIdentifiers = new Map<number, string[]>();
        for (const { id, cids } of resolutions) {
          if (cids.length === 0) {
            unresolvedIdentifiers.push(id);
            continue;
          }
          for (const cid of cids) {
            const owners = cidToIdentifiers.get(cid);
            if (owners) {
              if (!owners.includes(id)) owners.push(id);
            } else {
              cidToIdentifiers.set(cid, [id]);
              identifierMap.set(cid, id);
            }
          }
        }
        for (const [cid, owners] of cidToIdentifiers) {
          if (owners.length > 1) collisions.push({ cid, identifiers: owners });
        }
        allCids = resolutions.flatMap((r) => r.cids);
        break;
      }
      case 'formula': {
        if (!input.formula) {
          throw ctx.fail('missing_formula', undefined, {
            ...ctx.recoveryFor('missing_formula'),
          });
        }
        boundedSearch = true;
        allCids = await client.searchByFormula(input.formula, input.allowOtherElements, recordCap);
        break;
      }
      case 'substructure':
      case 'superstructure':
      case 'similarity': {
        if (!input.query || !input.queryType) {
          throw ctx.fail('missing_structure_args', undefined, {
            ...ctx.recoveryFor('missing_structure_args'),
          });
        }
        // A "cid" query must be a positive integer string — catch it here instead of
        // forwarding a malformed value into a raw PubChem 400 (#26).
        if (input.queryType === 'cid' && !(/^\d+$/.test(input.query) && Number(input.query) > 0)) {
          throw ctx.fail(
            'invalid_cid_query',
            `queryType is "cid" but query "${input.query}" is not a positive integer CID.`,
            { ...ctx.recoveryFor('invalid_cid_query') },
          );
        }
        boundedSearch = true;
        allCids = await client.searchByStructure(
          input.searchType,
          input.query,
          input.queryType,
          input.threshold,
          recordCap,
        );
        break;
      }
    }

    // Deduplicate, then take the requested page.
    const uniqueCids = [...new Set(allCids)];
    const observedTotal = uniqueCids.length;
    const pagedCids = uniqueCids.slice(input.offset, input.offset + input.maxResults);

    // A bounded search that came back short of its cap returned everything PubChem had, so
    // the count is exact. A saturated one only proves a floor.
    const totalIsExact = !boundedSearch || allCids.length < recordCap;
    // The stride comes from the page that was returned, never from maxResults — that input
    // accepts a fractional value, which would emit a nextOffset this tool's own integer
    // offset validator then rejects.
    const nextOffset = input.offset + pagedCids.length;
    // A saturated bounded search proved a record beyond the window it asked for, so more
    // remain even though observedTotal cannot say how many.
    const hasMore = !totalIsExact || nextOffset < observedTotal;

    ctx.log.info('Search completed', {
      searchType: input.searchType,
      observedTotal,
      totalIsExact,
      offset: input.offset,
      returned: pagedCids.length,
    });

    // Agent-facing context: search strategy echo, total, page boundary, and notices.
    ctx.enrich(
      totalIsExact
        ? { searchType: input.searchType, totalFound: observedTotal, offset: input.offset }
        : { searchType: input.searchType, totalFoundAtLeast: observedTotal, offset: input.offset },
    );
    if (hasMore) ctx.enrich({ nextOffset });

    // Identifier-mode signals (#29): name inputs that did not resolve and flag CID
    // collisions, so a partial miss is never silent. Empty for other search types.
    const noticeParts: string[] = [];
    if (unresolvedIdentifiers.length > 0) {
      const requested = input.identifiers?.length ?? unresolvedIdentifiers.length;
      noticeParts.push(
        `${unresolvedIdentifiers.length} of ${requested} identifier(s) did not resolve to a CID: ${unresolvedIdentifiers.join(', ')}. Verify spelling and that identifierType="${input.identifierType}" matches the identifier form (name/smiles/inchikey).`,
      );
    }
    for (const c of collisions) {
      noticeParts.push(
        `Identifiers ${c.identifiers.join(', ')} all resolved to CID ${c.cid}; the result row echoes only "${identifierMap.get(c.cid)}" for it.`,
      );
    }

    if (pagedCids.length === 0) {
      // An empty page is either "nothing matched" or "the offset ran past the matches" —
      // say which, and name the bound the caller can page back inside.
      if (observedTotal === 0) {
        if (noticeParts.length === 0) {
          noticeParts.push(
            `No compounds matched the ${input.searchType} search. Try a different identifier, broaden the formula, lower the similarity threshold, or verify the SMILES/CID.`,
          );
        }
      } else {
        // Reachable only with an exact total: a saturated bounded search observed
        // offset + maxResults + 1 records, so its page is never empty.
        noticeParts.push(
          `offset ${input.offset} is past the ${observedTotal} match(es) found. Pass an offset below ${observedTotal}.`,
        );
      }
      ctx.enrich.notice(noticeParts.join(' '));
    } else if (hasMore) {
      // Truncated: fold any identifier notice into the truncation guidance (notice is
      // last-wins, so compose rather than emit two). Without an exact total there is no
      // "of N" to quote — say more exist, and still hand over the next offset.
      const truncationGuidance = totalIsExact
        ? `Showing matches ${input.offset + 1}-${nextOffset} of ${observedTotal}. Pass offset=${nextOffset} for the next page.`
        : `Showing matches ${input.offset + 1}-${nextOffset}; more exist, but PubChem reports no match count for a ${input.searchType} search. Pass offset=${nextOffset} for the next page.`;
      ctx.enrich.truncated({
        shown: pagedCids.length,
        cap: input.maxResults,
        guidance:
          noticeParts.length > 0
            ? `${noticeParts.join(' ')} ${truncationGuidance}`
            : truncationGuidance,
      });
    } else if (noticeParts.length > 0) {
      ctx.enrich.notice(noticeParts.join(' '));
    }

    // Optionally hydrate with properties
    let propsMap: Map<number, Record<string, unknown>> | undefined;
    if (input.properties && input.properties.length > 0 && pagedCids.length > 0) {
      const rows = await client.getProperties(pagedCids, input.properties);
      propsMap = new Map(rows.map((r) => [r.CID, r]));
    }

    const results = pagedCids.map((cid) => {
      const result: {
        cid: number;
        identifier?: string;
        properties?: Record<string, unknown>;
      } = { cid };

      const identifier = identifierMap.get(cid);
      if (identifier) result.identifier = identifier;
      const rawProps = propsMap?.get(cid);
      if (rawProps) {
        const { CID: _CID, ...props } = rawProps;
        result.properties = props;
      }
      return result;
    });

    return unresolvedIdentifiers.length > 0 ? { results, unresolvedIdentifiers } : { results };
  },

  format(result) {
    const lines: string[] = [];

    if (result.results.length === 0) {
      lines.push('No results.');
    } else {
      const hasProps = result.results.some((r) => r.properties);

      if (hasProps) {
        for (const r of result.results) {
          const label = r.identifier ? `CID ${r.cid} — ${r.identifier}` : `CID ${r.cid}`;
          lines.push(`**${label}**`);
          if (r.properties) {
            const entries = Object.entries(r.properties);
            lines.push('  **Properties:**');
            lines.push(entries.map(([k, v]) => `    ${k}: ${v}`).join('\n'));
          }
          lines.push('');
        }
      } else {
        const items = result.results.map((r) =>
          r.identifier ? `${r.cid} (${r.identifier})` : String(r.cid),
        );
        lines.push(`CIDs: ${items.join(', ')}`);
      }
    }

    if (result.unresolvedIdentifiers && result.unresolvedIdentifiers.length > 0) {
      lines.push(
        `Unresolved identifiers (${result.unresolvedIdentifiers.length}): ${result.unresolvedIdentifiers.join(', ')}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
