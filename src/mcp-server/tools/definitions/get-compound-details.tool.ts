/**
 * @fileoverview Get detailed compound information: physicochemical properties,
 * textual descriptions, and/or synonyms for one or more CIDs.
 * @module mcp-server/tools/definitions/get-compound-details
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { COMPOUND_PROPERTIES, DEFAULT_PROPERTIES } from '@/services/pubchem/types.js';

const propertyEnum = z.enum(COMPOUND_PROPERTIES as unknown as [string, ...string[]]);

export const getCompoundDetails = tool('pubchem_get_compound_details', {
  title: 'Get Compound Details',
  description:
    'Get detailed compound information by CID. Returns physicochemical properties ' +
    '(molecular weight, SMILES, InChIKey, XLogP, TPSA, etc.), optionally with a textual ' +
    'description (pharmacology, mechanism, therapeutic use) and/or all known synonyms. ' +
    'Efficiently batches up to 100 CIDs in a single request.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    cids: z
      .array(z.number().int().positive())
      .min(1)
      .max(100)
      .describe('PubChem Compound IDs to fetch (1-100). Batched efficiently.'),
    properties: z
      .array(propertyEnum)
      .optional()
      .describe(
        'Properties to retrieve. Defaults to a core set: MolecularFormula, MolecularWeight, ' +
          'IUPACName, CanonicalSMILES, IsomericSMILES, InChIKey, XLogP, TPSA, HBondDonorCount, ' +
          'HBondAcceptorCount, RotatableBondCount, HeavyAtomCount, Charge, Complexity.',
      ),
    includeDescription: z
      .boolean()
      .default(false)
      .describe(
        'Fetch textual description from PUG View (pharmacology, mechanism, therapeutic use). ' +
          'Adds one API call per CID — consider limiting CID count when enabled.',
      ),
    includeSynonyms: z
      .boolean()
      .default(false)
      .describe(
        'Fetch all known names and synonyms (trade names, systematic names, registry numbers).',
      ),
  }),
  output: z.object({
    compounds: z
      .array(
        z.object({
          cid: z.number().describe('PubChem Compound ID.'),
          properties: z
            .record(z.string(), z.unknown())
            .describe('Requested physicochemical properties.'),
          description: z.string().optional().describe('Textual description from PUG View.'),
          synonyms: z.array(z.string()).optional().describe('Known names and synonyms.'),
        }),
      )
      .describe('Compound detail records.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const props = input.properties ?? [...DEFAULT_PROPERTIES];

    // Batch property fetch
    const propertyRows = await client.getProperties(input.cids, props);
    const propsMap = new Map(propertyRows.map((r) => [r.CID, r]));

    // Optional: descriptions (per-CID, parallelized with concurrency limit)
    let descMap: Map<number, string> | undefined;
    if (input.includeDescription) {
      const descCids = input.cids.slice(0, 10); // Cap at 10 to limit API calls
      if (descCids.length < input.cids.length) {
        ctx.log.info('Description fetch capped at 10 CIDs', {
          requested: input.cids.length,
          fetching: descCids.length,
        });
      }
      const entries = await Promise.all(
        descCids.map(async (cid) => {
          const desc = await client.getDescription(cid);
          return [cid, desc] as const;
        }),
      );
      descMap = new Map(entries.filter((e): e is [number, string] => e[1] !== null));
    }

    // Optional: synonyms (per-CID)
    let synMap: Map<number, string[]> | undefined;
    if (input.includeSynonyms) {
      const entries = await Promise.all(
        input.cids.map(async (cid) => {
          const syns = await client.getSynonyms(cid);
          return [cid, syns] as const;
        }),
      );
      synMap = new Map(entries.filter((e): e is [number, string[]] => e[1].length > 0));
    }

    ctx.log.info('Details fetched', {
      cids: input.cids.length,
      withDescription: input.includeDescription,
      withSynonyms: input.includeSynonyms,
    });

    const compounds = input.cids.map((cid) => {
      const rawProps = propsMap.get(cid) ?? {};
      const properties = { ...rawProps };
      delete (properties as Record<string, unknown>).CID;

      const compound: {
        cid: number;
        properties: Record<string, unknown>;
        description?: string;
        synonyms?: string[];
      } = { cid, properties };

      const desc = descMap?.get(cid);
      if (desc) compound.description = desc;
      const syns = synMap?.get(cid);
      if (syns) compound.synonyms = syns;

      return compound;
    });

    return { compounds };
  },

  format(result) {
    const blocks: string[] = [];

    for (const c of result.compounds) {
      const p = c.properties as Record<string, unknown>;
      const name = (p.IUPACName as string) ?? (p.Title as string) ?? '';
      const header = name ? `## CID ${c.cid} — ${name}` : `## CID ${c.cid}`;
      blocks.push(header);

      const lines: string[] = [];

      // Key identifiers
      if (p.MolecularFormula) lines.push(`**Formula:** ${p.MolecularFormula}`);
      const mw = p.MolecularWeight;
      if (mw != null) lines.push(`**MW:** ${mw} g/mol`);
      if (p.CanonicalSMILES) lines.push(`**SMILES:** ${p.CanonicalSMILES}`);
      if (p.IsomericSMILES && p.IsomericSMILES !== p.CanonicalSMILES) {
        lines.push(`**Isomeric SMILES:** ${p.IsomericSMILES}`);
      }
      if (p.InChIKey) lines.push(`**InChIKey:** ${p.InChIKey}`);

      // Drug-likeness properties
      const drugProps: string[] = [];
      if (p.XLogP != null) drugProps.push(`XLogP: ${p.XLogP}`);
      if (p.TPSA != null) drugProps.push(`TPSA: ${p.TPSA}`);
      if (p.Complexity != null) drugProps.push(`Complexity: ${p.Complexity}`);
      if (drugProps.length > 0) lines.push(`**Properties:** ${drugProps.join(' | ')}`);

      // Atom/bond counts
      const counts: string[] = [];
      if (p.HBondDonorCount != null) counts.push(`HBD: ${p.HBondDonorCount}`);
      if (p.HBondAcceptorCount != null) counts.push(`HBA: ${p.HBondAcceptorCount}`);
      if (p.RotatableBondCount != null) counts.push(`Rotatable: ${p.RotatableBondCount}`);
      if (p.HeavyAtomCount != null) counts.push(`Heavy: ${p.HeavyAtomCount}`);
      if (p.Charge != null && p.Charge !== 0) counts.push(`Charge: ${p.Charge}`);
      if (counts.length > 0) lines.push(`**Counts:** ${counts.join(' | ')}`);

      // Remaining properties not already shown
      const shown = new Set([
        'MolecularFormula',
        'MolecularWeight',
        'CanonicalSMILES',
        'IsomericSMILES',
        'InChIKey',
        'IUPACName',
        'Title',
        'XLogP',
        'TPSA',
        'Complexity',
        'HBondDonorCount',
        'HBondAcceptorCount',
        'RotatableBondCount',
        'HeavyAtomCount',
        'Charge',
      ]);
      const extra = Object.entries(p).filter(([k]) => !shown.has(k));
      if (extra.length > 0) {
        lines.push(extra.map(([k, v]) => `**${k}:** ${v}`).join(' | '));
      }

      blocks.push(lines.join('\n'));

      // Description
      if (c.description) {
        blocks.push(`\n> ${c.description.replace(/\n/g, '\n> ')}`);
      }

      // Synonyms
      if (c.synonyms && c.synonyms.length > 0) {
        const shown = c.synonyms.slice(0, 20);
        const more = c.synonyms.length > 20 ? ` (+${c.synonyms.length - 20} more)` : '';
        blocks.push(`\n**Synonyms:** ${shown.join(', ')}${more}`);
      }

      blocks.push('');
    }

    return [{ type: 'text', text: blocks.join('\n') }];
  },
});
