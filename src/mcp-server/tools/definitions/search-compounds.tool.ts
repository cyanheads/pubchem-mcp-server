/**
 * @fileoverview Search PubChem for chemical compounds by name, SMILES, InChIKey,
 * formula, substructure, superstructure, or 2D similarity.
 * @module mcp-server/tools/definitions/search-compounds
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
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
    `Search PubChem for chemical compounds. Five search modes:\n` +
    `- identifier: Resolve compound names, SMILES, or InChIKeys to CIDs (batch up to 25)\n` +
    `- formula: Find compounds by molecular formula (Hill notation, e.g. "C6H12O6")\n` +
    `- substructure: Find compounds containing a substructure (SMILES or CID)\n` +
    `- superstructure: Find compounds that are substructures of the query\n` +
    `- similarity: Find structurally similar compounds by 2D Tanimoto similarity\n\n` +
    `Optionally hydrate results with properties to avoid a follow-up details call.`,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    searchType: searchTypeEnum.describe(
      'Search strategy: "identifier" (name/SMILES/InChIKey lookup), "formula", "substructure", "superstructure", or "similarity".',
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
      .optional()
      .describe(
        'Required for identifier search. Array of identifiers to resolve (1-25). ' +
          'Examples: ["aspirin", "ibuprofen"] for name, ["CC(=O)OC1=CC=CC=C1C(=O)O"] for SMILES.',
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
        'Required for substructure/superstructure/similarity searches. ' +
          'A SMILES string or PubChem CID (as string) for the query structure.',
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
        'Similarity search only. Minimum Tanimoto similarity (70-100). ' +
          '90+ for close analogs, 70-80 for scaffold hops. Default: 90.',
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
        'Optional: fetch these properties for each result, avoiding a follow-up details call. ' +
          'E.g. ["MolecularFormula", "MolecularWeight", "CanonicalSMILES"].',
      ),
  }),
  output: z.object({
    searchType: z.string().describe('The search strategy used.'),
    totalFound: z.number().describe('Total CIDs found (before maxResults cap).'),
    results: z
      .array(
        z.object({
          cid: z.number().describe('PubChem Compound ID.'),
          identifier: z
            .string()
            .optional()
            .describe('Echoed input identifier (identifier mode only).'),
          properties: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Compound properties when requested.'),
        }),
      )
      .describe('Matching compounds.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    let allCids: number[] = [];
    const identifierMap = new Map<number, string>();

    switch (input.searchType) {
      case 'identifier': {
        const { identifierType, identifiers } = input;
        if (!identifierType || !identifiers) {
          throw new Error('identifierType and identifiers are required for identifier search');
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
          for (const cid of cids) identifierMap.set(cid, id);
          return cids;
        });
        const results = await Promise.all(lookups);
        allCids = results.flat();
        break;
      }
      case 'formula': {
        if (!input.formula) throw new Error('formula is required for formula search');
        allCids = await client.searchByFormula(input.formula, input.allowOtherElements);
        break;
      }
      case 'substructure':
      case 'superstructure':
      case 'similarity': {
        if (!input.query || !input.queryType) {
          throw new Error('query and queryType are required for structure/similarity searches');
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
        const props = { ...rawProps };
        delete (props as Record<string, unknown>).CID;
        result.properties = props;
      }
      return result;
    });

    return { searchType: input.searchType, totalFound, results };
  },

  format(result) {
    const lines: string[] = [];
    const count = result.results.length;
    const truncated =
      result.totalFound > count ? ` (showing ${count} of ${result.totalFound})` : '';
    lines.push(
      `Found ${result.totalFound} compound${result.totalFound !== 1 ? 's' : ''}${truncated} — ${result.searchType} search`,
    );
    lines.push('');

    if (result.results.length === 0) {
      lines.push('No results.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const hasProps = result.results.some((r) => r.properties);

    if (hasProps) {
      for (const r of result.results) {
        const label = r.identifier ? `CID ${r.cid} — ${r.identifier}` : `CID ${r.cid}`;
        lines.push(`**${label}**`);
        if (r.properties) {
          const entries = Object.entries(r.properties);
          lines.push(entries.map(([k, v]) => `  ${k}: ${v}`).join('\n'));
        }
        lines.push('');
      }
    } else {
      const items = result.results.map((r) =>
        r.identifier ? `${r.cid} (${r.identifier})` : String(r.cid),
      );
      lines.push(`CIDs: ${items.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
