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
    'Search PubChem for chemical compounds by identifier (name, SMILES, or InChIKey, batched up to 25), molecular formula in Hill notation, substructure or superstructure containment, or 2D Tanimoto similarity. Optionally hydrate results with properties to avoid a follow-up pubchem_get_compound_details call.',
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
    maxResults: z
      .number()
      .min(1)
      .max(200)
      .default(20)
      .describe('Maximum CIDs to return (1-200). Default: 20.'),
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
  // Agent-facing context — search strategy echo, total before cap, and an empty-result
  // notice. Reaches structuredContent and content[] automatically; not in the domain return.
  enrichment: {
    searchType: z
      .string()
      .describe(
        'Search strategy used: identifier, formula, substructure, superstructure, or similarity.',
      ),
    totalFound: z.number().describe('Total CIDs found before the maxResults cap.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when CIDs were capped at maxResults — more matches exist than returned.'),
    shown: z.number().optional().describe('CIDs returned after the maxResults cap.'),
    cap: z.number().optional().describe('The maxResults cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no compounds matched — echoes search strategy and suggests how to broaden. Absent when results were returned.',
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
        allCids = await client.searchByFormula(input.formula, input.allowOtherElements);
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
        allCids = await client.searchByStructure(
          input.searchType,
          input.query,
          input.queryType,
          input.threshold,
        );
        break;
      }
    }

    // Deduplicate and cap
    const uniqueCids = [...new Set(allCids)];
    const totalFound = uniqueCids.length;
    const cappedCids = uniqueCids.slice(0, input.maxResults);

    ctx.log.info('Search completed', {
      searchType: input.searchType,
      totalFound,
      returned: cappedCids.length,
    });

    // Agent-facing context: search strategy echo, total, and empty-result notice.
    ctx.enrich({ searchType: input.searchType, totalFound });

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

    if (cappedCids.length === 0) {
      ctx.enrich.notice(
        noticeParts.length > 0
          ? noticeParts.join(' ')
          : `No compounds matched the ${input.searchType} search. Try a different identifier, broaden the formula, lower the similarity threshold, or verify the SMILES/CID.`,
      );
    } else if (totalFound > cappedCids.length) {
      // Truncated: fold any identifier notice into the truncation guidance (notice is
      // last-wins, so compose rather than emit two; restate the cap when overriding).
      if (noticeParts.length > 0) {
        ctx.enrich.truncated({
          shown: cappedCids.length,
          cap: input.maxResults,
          guidance: `${noticeParts.join(' ')} Showing ${cappedCids.length} of ${totalFound} matches — raise maxResults (max 200) for more.`,
        });
      } else {
        ctx.enrich.truncated({ shown: cappedCids.length, cap: input.maxResults });
      }
    } else if (noticeParts.length > 0) {
      ctx.enrich.notice(noticeParts.join(' '));
    }

    // Optionally hydrate with properties
    let propsMap: Map<number, Record<string, unknown>> | undefined;
    if (input.properties && input.properties.length > 0 && cappedCids.length > 0) {
      const rows = await client.getProperties(cappedCids, input.properties);
      propsMap = new Map(rows.map((r) => [r.CID, r]));
    }

    const results = cappedCids.map((cid) => {
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
