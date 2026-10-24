/**
 * @fileoverview Get descriptive summaries for PubChem entities: assays, genes, proteins, or taxonomy.
 * @module mcp-server/tools/definitions/get-summary
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
import { MAX_INT32 } from '@/services/pubchem/types.js';
import { normalizeProteinAccession } from './identifier-case.js';
import {
  type CappedInput,
  cappedInputsField,
  INPUT_CEILING,
  renderCappedInputs,
  renderUnprocessed,
  splitBatch,
} from './input-caps.js';
import { inlineData, inlineEcho, quoteData } from './untrusted-text.js';

const entityTypeEnum = z.enum(['assay', 'gene', 'protein', 'taxonomy']);

type EntityType = z.infer<typeof entityTypeEnum>;

/** Summaries looked up per call. Pieces a comma split yields past this are returned unprocessed. */
const MAX_IDENTIFIERS_PER_CALL = 10;

/** Malformed pieces an `invalid_identifier` message names; the rest are counted. */
const NAMED_INVALID_PIECES = 10;

/** Assay targets kept per summary. Kinase panels list hundreds (AID 1982: 314), which would
 * swamp a 10-assay batch; `targetCount` carries the full number. */
const MAX_ASSAY_TARGETS = 25;

/** What each entityType's identifier is, as notices and errors name it. */
const ID_FORMS: Record<EntityType, string> = {
  assay: `positive integer AID up to ${MAX_INT32}`,
  gene: `positive integer NCBI Gene ID up to ${MAX_INT32}`,
  protein: 'UniProt accession',
  taxonomy: `positive integer NCBI Taxonomy ID up to ${MAX_INT32}`,
};

/** One identifier piece after splitting: the canonical ID to look up, or the piece as sent
 * when it is not in the form entityType expects. */
type Piece = { valid: true; id: string | number } | { valid: false; id: string };

/**
 * Split every identifier string on commas — PubChem's own list separator on all four summary
 * paths — trim each piece, and drop the empty ones. Numeric types accept a digits-only piece
 * naming an integer from 1 to `MAX_INT32` and echo it as that number (`"01000"` → 1000);
 * anything else is invalid and never reaches PubChem, which reads `+`, `;`, spaces, and signs
 * as a 400, `/`, `?`, `#` as path syntax, and an ID past the signed 32-bit range as invalid
 * (400) or absent (404).
 */
function splitIdentifiers(entityType: EntityType, identifiers: string[]): Piece[] {
  const pieces: Piece[] = [];
  for (const raw of identifiers) {
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      if (entityType === 'protein') {
        pieces.push({ valid: true, id: normalizeProteinAccession(trimmed) });
        continue;
      }
      const n = Number(trimmed);
      pieces.push(
        /^\d+$/.test(trimmed) && n > 0 && n <= MAX_INT32
          ? { valid: true, id: n }
          : { valid: false, id: trimmed },
      );
    }
  }
  return pieces;
}

/**
 * Union-of-shapes schema for entity summaries. All fields are optional because the
 * set of populated fields depends on entityType (assay/gene/protein/taxonomy).
 * Fields absent from the upstream response are omitted entirely rather than filled
 * with empty strings or zeros.
 */
const entitySummaryDataSchema = z.object({
  aid: z.number().optional().describe('Assay ID — present on assay summaries.'),
  name: z.string().optional().describe('Primary display name.'),
  description: z.string().optional().describe('Descriptive text when available.'),
  sourceName: z.string().optional().describe('Data source attribution (assay summaries).'),
  numSubstances: z.number().optional().describe('Substances tested (assay summaries).'),
  numActive: z.number().optional().describe('Substances marked active (assay summaries).'),
  method: z
    .string()
    .optional()
    .describe(
      'Assay method as PubChem labels it (assay summaries): "confirmatory" (dose-response), "screening" (primary screen), "summary", or "other". Omitted when PubChem records none.',
    ),
  targets: z
    .array(
      z
        .object({
          accession: z.string().optional().describe('Target protein or gene accession.'),
          name: z.string().optional().describe('Target name.'),
        })
        .describe('Assay target.'),
    )
    .optional()
    .describe(
      `Assay targets, the first ${MAX_ASSAY_TARGETS} PubChem lists (assay summaries); targetCount gives the full number.`,
    ),
  targetCount: z
    .number()
    .optional()
    .describe('Number of targets PubChem lists for the assay (assay summaries).'),
  numCompounds: z
    .number()
    .optional()
    .describe(
      'Compounds (CIDs) tested (assay summaries). List them with pubchem_search_compounds searchType "assay" and activeOnly: false — its default lists only the actives.',
    ),
  numActiveCompounds: z
    .number()
    .optional()
    .describe('Compounds (CIDs) the assay marked active (assay summaries).'),
  lastDataChange: z
    .string()
    .optional()
    .describe("Date the assay's data last changed, YYYY-MM-DD (assay summaries)."),
  geneId: z.number().optional().describe('NCBI Gene ID (gene summaries).'),
  symbol: z.string().optional().describe('Gene symbol (gene summaries).'),
  taxonomyId: z.number().optional().describe('NCBI Taxonomy ID (gene/protein/taxonomy summaries).'),
  taxonomy: z.string().optional().describe('Taxonomy scientific name (gene/protein summaries).'),
  synonyms: z.array(z.string()).optional().describe('Known synonyms / other names.'),
  proteinAccession: z.string().optional().describe('Protein accession (protein summaries).'),
  scientificName: z.string().optional().describe('Scientific name (taxonomy summaries).'),
  commonName: z.string().optional().describe('Common name (taxonomy summaries).'),
  rank: z.string().optional().describe('Taxonomic rank (taxonomy summaries).'),
  lineage: z
    .array(z.string())
    .optional()
    .describe(
      'Taxonomic lineage ordered from the most inclusive rank to the most specific, e.g. ["Eukaryota", "Metazoa", "Chordata"] (taxonomy summaries). Ranks that do not apply to the entity are omitted.',
    ),
});

type EntitySummaryData = z.infer<typeof entitySummaryDataSchema>;

export const getSummary = tool('pubchem_get_summary', {
  title: 'Get Entity Summary',
  description:
    'Get descriptive summaries for PubChem entities by ID. Supports assays (AID), genes (Gene ID), proteins (UniProt accession), and taxonomy (Tax ID). Up to 10 per call; identifiers past that are returned in unprocessed for a follow-up call.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    entityType: entityTypeEnum.describe('Entity type. Determines ID format and returned fields.'),
    identifiers: z
      .array(z.string().describe('Entity identifier, or several joined with commas.'))
      .min(1)
      .max(INPUT_CEILING)
      .describe(
        `Entity identifiers. A comma-joined string is split into one identifier per piece, with whitespace trimmed. The per-call cap is ${MAX_IDENTIFIERS_PER_CALL} pieces: the first ${MAX_IDENTIFIERS_PER_CALL} are looked up, and any past that are returned in unprocessed, in input order, and reported in cappedInputs. More than ${INPUT_CEILING} pieces in all fails the call. ID form depends on entityType:\n- assay: AID, a positive integer, e.g. ["1000"]\n- gene: NCBI Gene ID, a positive integer, e.g. ["1956"]\n- protein: UniProt accession, e.g. ["P00533"]\n- taxonomy: NCBI Taxonomy ID, a positive integer, e.g. ["9606"]\nFor assay, gene, and taxonomy, a piece that is not a positive integer up to ${MAX_INT32} written in digits is marked invalid and not looked up.`,
      ),
  }),
  output: z.object({
    entityType: z.string().describe('Entity type queried.'),
    summaries: z
      .array(
        z
          .object({
            identifier: z
              .union([
                z.string().describe('String identifier (e.g. UniProt accession).'),
                z.number().describe('Numeric identifier (e.g. AID, Gene ID, Tax ID).'),
              ])
              .describe(
                'Queried identifier: a number for assay, gene, and taxonomy; the accession for protein; the piece as sent when invalid.',
              ),
            found: z.boolean().describe('Whether the entity was found.'),
            invalid: z
              .boolean()
              .optional()
              .describe(
                'True when the identifier is not in the form entityType expects; it was not looked up. Omitted otherwise.',
              ),
            data: entitySummaryDataSchema
              .optional()
              .describe('Entity summary data. Populated fields depend on entityType.'),
          })
          .describe('Per-identifier summary result.'),
      )
      .describe('Summary results, one per identifier piece looked up, in input order.'),
    unprocessed: z
      .array(z.string())
      .optional()
      .describe(
        `Identifier pieces past the per-call cap of ${MAX_IDENTIFIERS_PER_CALL}, in input order, not looked up. Pass them in a follow-up call. Omitted when every piece was served.`,
      ),
  }),
  // Agent-facing context — requested/found counts, a notice when any identifier missed or was
  // invalid, and the per-call cap disclosure when pieces were left unprocessed. Reaches
  // structuredContent and content[]; keys disjoint from output.
  enrichment: {
    requestedCount: z
      .number()
      .describe('Identifier pieces requested, counted after comma splitting.'),
    foundCount: z.number().describe('Identifiers resolved to a summary.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery guidance when identifiers were invalid or not found.'),
    cappedInputs: cappedInputsField,
  },
  enrichmentTrailer: { cappedInputs: { render: renderCappedInputs } },
  errors: [
    {
      reason: 'too_many_identifiers',
      code: JsonRpcErrorCode.ValidationError,
      when: `Comma splitting yields more than ${INPUT_CEILING} identifier pieces`,
      recovery: `Pass at most ${MAX_IDENTIFIERS_PER_CALL} identifier pieces per call — up to ${INPUT_CEILING} are accepted, with those past the first ${MAX_IDENTIFIERS_PER_CALL} returned in unprocessed — and send the rest in follow-up calls.`,
    },
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: `No identifier piece is usable: every piece is blank, or, for assay, gene, or taxonomy, not a positive integer up to ${MAX_INT32}`,
      recovery: `Pass AIDs, Gene IDs, or Taxonomy IDs as positive integers up to ${MAX_INT32} (e.g. "1000") or protein UniProt accessions (e.g. "P00533"); find AIDs for a target with pubchem_search_assays.`,
    },
  ],

  async handler(input, ctx) {
    const client = getPubChemClient();
    const { entityType } = input;

    const pieces = splitIdentifiers(entityType, input.identifiers);
    // The schema bounds array entries, not the pieces one entry splits into.
    if (pieces.length > INPUT_CEILING) {
      throw ctx.fail(
        'too_many_identifiers',
        `${pieces.length} identifier pieces after comma splitting exceed the ceiling of ${INPUT_CEILING} per call.`,
      );
    }
    if (!pieces.some((p) => p.valid)) {
      const shown = pieces
        .slice(0, NAMED_INVALID_PIECES)
        .map((p) => `"${inlineEcho(String(p.id))}"`);
      const more = pieces.length - shown.length;
      const named = `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
      throw ctx.fail(
        'invalid_identifier',
        pieces.length === 0
          ? 'Every identifier is blank.'
          : `No ${entityType} identifier is a ${ID_FORMS[entityType]}: ${named}.`,
      );
    }
    const capped: CappedInput[] = [];
    const split = splitBatch('identifiers', pieces, MAX_IDENTIFIERS_PER_CALL, capped);
    const served = split.served;
    const unprocessed = split.unprocessed.map((p) => String(p.id));

    const summaries = await Promise.all(
      served.map(async (piece) => {
        if (!piece.valid) return { identifier: piece.id, found: false as const, invalid: true };
        const raw = await client.getEntitySummary(entityType, piece.id, ctx.signal);
        if (!raw) return { identifier: piece.id, found: false as const };

        const data = extractSummary(entityType, raw);
        return { identifier: piece.id, found: true as const, data };
      }),
    );

    const foundCount = summaries.filter((s) => s.found).length;
    const invalidIds = served.filter((p) => !p.valid).map((p) => `"${inlineEcho(String(p.id))}"`);
    const lookedUp = served.length - invalidIds.length;
    const notFound = lookedUp - foundCount;

    ctx.log.info('Summaries fetched', {
      entityType,
      requested: pieces.length,
      invalid: invalidIds.length,
      unprocessed: unprocessed.length,
      found: foundCount,
    });

    ctx.enrich({ requestedCount: pieces.length, foundCount });
    if (capped.length > 0) ctx.enrich({ cappedInputs: capped });
    const noticeParts: string[] = [];
    if (invalidIds.length > 0) {
      noticeParts.push(
        `Not looked up (${invalidIds.length} invalid): ${invalidIds.join(', ')} — each ${entityType} identifier must be a ${ID_FORMS[entityType]}.`,
      );
    }
    if (notFound > 0) {
      noticeParts.push(
        `${notFound} of ${lookedUp} ${entityType} identifier(s) not found. Verify the ID type matches entityType="${entityType}" (assay: AID, gene: Gene ID, protein: UniProt accession, taxonomy: Tax ID).`,
      );
    }
    if (noticeParts.length > 0) ctx.enrich.notice(noticeParts.join(' '));

    return unprocessed.length > 0
      ? { entityType, summaries, unprocessed }
      : { entityType, summaries };
  },

  format(result) {
    const lines: string[] = [`## ${capitalize(result.entityType)} Summaries`, ''];

    for (const s of result.summaries) {
      if (s.invalid) {
        lines.push(
          `**Identifier ${inlineData(String(s.identifier))}** — invalid for this entityType, not looked up`,
          '',
        );
      }
      if (!s.found || !s.data) {
        if (!s.invalid) {
          lines.push(`**Identifier ${inlineData(String(s.identifier))}** — not found`, '');
        }
        continue;
      }

      const d = s.data;
      const displayName = d.name ?? d.symbol ?? String(s.identifier);
      lines.push(
        `**${inlineData(displayName)}** (identifier: ${inlineData(String(s.identifier))}, found)`,
      );

      for (const [key, value] of Object.entries(d)) {
        if (value == null || key === 'name') continue;
        // description is upstream prose — frame it as a blockquote data block.
        if (key === 'description' && typeof value === 'string') {
          lines.push(`  ${formatKey(key)}:`);
          for (const q of quoteData(value).split('\n')) lines.push(`  ${q}`);
          continue;
        }
        if (key === 'targets' && d.targets) {
          // Objects, not strings — each renders as accession and name, pipe-separated like synonyms.
          const items = d.targets.map(
            (t) =>
              `${inlineData(t.accession ?? 'accession not available')} — ${inlineData(t.name ?? 'name not available')}`,
          );
          lines.push(`  ${formatKey(key)}: ${items.join(' | ')}`);
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) continue;
          /**
           * synonyms / lineage — upstream free text; escape each element inline.
           * Rendered in full: structuredContent carries the whole array, so capping
           * here would hide values the structured surface already returned.
           * Pipe-separated because synonyms carry their own commas ("Homo sapiens
           * Linnaeus, 1758"), which would split one entry into two.
           */
          const items = value.map((v) => inlineData(String(v)));
          lines.push(`  ${formatKey(key)}: ${items.join(' | ')}`);
        } else if (typeof value === 'string') {
          lines.push(`  ${formatKey(key)}: ${inlineData(value)}`);
        } else {
          lines.push(`  ${formatKey(key)}: ${value}`);
        }
      }
      lines.push('');
    }

    if (result.unprocessed && result.unprocessed.length > 0) {
      lines.push(renderUnprocessed(result.unprocessed.map(inlineData)));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ── Summary extraction per entity type ──────────────────────────────

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return;
}

function toStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const joined = v.filter((x) => typeof x === 'string').join('\n');
    return joined.length > 0 ? joined : undefined;
  }
  return;
}

function toStrArr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.map((x) => (typeof x === 'string' ? x : String(x))).filter((s) => s.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof v === 'string' && v.length > 0) return [v];
  return;
}

/**
 * Ranks of PubChem's `RankedLineage`, ordered most-inclusive-first. The upstream
 * object keys run the other way (Species first) and carry empty strings for ranks
 * that do not apply, so the flat lineage is rebuilt in this order with blanks dropped.
 */
const LINEAGE_RANKS = [
  'Superkingdom',
  'Kingdom',
  'Phylum',
  'Class',
  'Order',
  'Family',
  'Genus',
  'Species',
] as const;

/** Flatten a `RankedLineage` object into an ordered list of taxon names. */
function toLineage(v: unknown): string[] | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
  const ranked = v as Record<string, unknown>;
  const names = LINEAGE_RANKS.map((rank) => ranked[rank]).filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  return names.length > 0 ? names : undefined;
}

type AssayTarget = NonNullable<EntitySummaryData['targets']>[number];

/** One `Target[]` entry (`{ Accession, Name }`) as an assay target; undefined when it has neither. */
function toTarget(v: unknown): AssayTarget | undefined {
  if (typeof v !== 'object' || v === null) return;
  const raw = v as Record<string, unknown>;
  const target: AssayTarget = {};
  const accession = toStr(raw.Accession);
  const name = toStr(raw.Name);
  if (accession !== undefined) target.accession = accession;
  if (name !== undefined) target.name = name;
  return accession === undefined && name === undefined ? undefined : target;
}

/** PubChem's `{ Year, Month, Day }` date object as `YYYY-MM-DD`; undefined when any part is missing. */
function toIsoDate(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return;
  const { Year, Month, Day } = v as Record<string, unknown>;
  const [y, m, d] = [toNum(Year), toNum(Month), toNum(Day)];
  if (y === undefined || m === undefined || d === undefined) return;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Assign `value` to `target[key]` only when defined — keeps unknowns off the output. */
function put<K extends keyof EntitySummaryData>(
  target: EntitySummaryData,
  key: K,
  value: EntitySummaryData[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function extractSummary(entityType: EntityType, raw: Record<string, unknown>): EntitySummaryData {
  const data: EntitySummaryData = {};
  switch (entityType) {
    case 'assay':
      put(data, 'aid', toNum(raw.AID));
      put(data, 'name', toStr(raw.Name ?? raw.AssayName));
      put(data, 'description', toStr(raw.Description));
      put(data, 'sourceName', toStr(raw.SourceName));
      put(data, 'numSubstances', toNum(raw.SIDCountAll));
      put(data, 'numActive', toNum(raw.SIDCountActive));
      put(data, 'method', toStr(raw.Method));
      if (Array.isArray(raw.Target)) {
        const targets = raw.Target.map(toTarget).filter((t) => t !== undefined);
        put(data, 'targets', targets.length > 0 ? targets.slice(0, MAX_ASSAY_TARGETS) : undefined);
        put(data, 'targetCount', raw.Target.length);
      }
      put(data, 'numCompounds', toNum(raw.CIDCountAll));
      put(data, 'numActiveCompounds', toNum(raw.CIDCountActive));
      put(data, 'lastDataChange', toIsoDate(raw.LastDataChange));
      return data;
    case 'gene':
      put(data, 'geneId', toNum(raw.GeneID));
      put(data, 'symbol', toStr(raw.Symbol));
      put(data, 'name', toStr(raw.Name));
      put(data, 'taxonomyId', toNum(raw.TaxID ?? raw.TaxonomyID));
      put(data, 'taxonomy', toStr(raw.Taxonomy ?? raw.ScientificName));
      put(data, 'description', toStr(raw.Description ?? raw.Summary));
      put(data, 'synonyms', toStrArr(raw.Synonym ?? raw.OtherNames));
      return data;
    case 'protein':
      put(data, 'proteinAccession', toStr(raw.ProteinAccession ?? raw.Accession));
      put(data, 'name', toStr(raw.Name ?? raw.Title));
      put(data, 'taxonomyId', toNum(raw.TaxID ?? raw.TaxonomyID));
      put(data, 'taxonomy', toStr(raw.Taxonomy ?? raw.ScientificName));
      put(data, 'synonyms', toStrArr(raw.Synonym ?? raw.OtherNames));
      return data;
    case 'taxonomy':
      put(data, 'taxonomyId', toNum(raw.TaxonomyID ?? raw.TaxID));
      put(data, 'scientificName', toStr(raw.ScientificName));
      put(data, 'commonName', toStr(raw.CommonName));
      put(data, 'rank', toStr(raw.Rank));
      put(data, 'lineage', toLineage(raw.RankedLineage));
      put(data, 'synonyms', toStrArr(raw.Synonym));
      return data;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
