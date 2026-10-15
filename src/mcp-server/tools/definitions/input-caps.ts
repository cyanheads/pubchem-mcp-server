/**
 * @fileoverview Per-call caps on read-side workload inputs (ID batches and page sizes). A value
 * between the cap and the schema ceiling is served up to the cap instead of rejected; each clamp
 * is recorded so the tool can disclose it in its `cappedInputs` enrichment field, worded the same
 * way on every tool.
 * @module mcp-server/tools/definitions/input-caps
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Hard schema ceiling for every capped workload input; a larger value fails validation. */
export const INPUT_CEILING = 1000;

/** One input that asked for more than its per-call cap. */
export interface CappedInput {
  /** Input name as the caller sent it. */
  input: string;
  /** Value the caller asked for — a page size, or the number of IDs in a batch. */
  requested: number;
  /** Value the call served: the per-call cap. */
  served: number;
  /** ID batches only: how many IDs were returned in `unprocessed`. */
  unprocessed?: number;
}

/** The `cappedInputs` enrichment field every capped tool declares. */
export const cappedInputsField = z
  .array(
    z
      .object({
        input: z.string().describe('Input name, e.g. "maxResults" or "cids".'),
        requested: z
          .number()
          .describe('Value requested: the page size, or the number of IDs in the batch.'),
        served: z.number().describe('Value served: the per-call cap.'),
        unprocessed: z
          .number()
          .optional()
          .describe('ID batches only: IDs past the cap, listed in unprocessed in input order.'),
      })
      .describe('One input served at its per-call cap.'),
  )
  .optional()
  .describe(
    'Inputs that asked for more than their per-call cap, with the value requested and the value served. An ID batch lists the IDs past the cap in unprocessed. Omitted when every input was within its cap.',
  );

/** The one sentence every tool uses to disclose a clamp. */
export function describeCap({ input, requested, served, unprocessed }: CappedInput): string {
  const [verb, pronoun] = unprocessed === 1 ? ['is', 'it'] : ['are', 'them'];
  const rest =
    unprocessed === undefined
      ? ''
      : `; the remaining ${unprocessed} ${verb} listed in unprocessed, in input order — pass ${pronoun} in a follow-up call`;
  return `${input}: requested ${requested}, served ${served} (the per-call cap)${rest}.`;
}

/** `content[]` trailer line for `cappedInputs`; the framework calls it only when populated. */
export function renderCappedInputs(capped: CappedInput[] | undefined): string {
  return `**Per-call cap applied:** ${(capped ?? []).map(describeCap).join(' ')}`;
}

/** `content[]` line listing the `unprocessed` tail of a split ID batch. */
export function renderUnprocessed(items: readonly (string | number)[]): string {
  return `**Unprocessed (${items.length}, past the per-call cap):** ${items.join(', ')}`;
}

/** Serves a page size up to `cap`, recording the clamp in `capped` when it applies. */
export function capPageSize(
  input: string,
  requested: number,
  cap: number,
  capped: CappedInput[],
): number {
  if (requested <= cap) return requested;
  capped.push({ input, requested, served: cap });
  return cap;
}

/** Splits an ID batch at `cap`: the first `cap` items are served, the rest are returned
 * unprocessed in input order, and the split is recorded in `capped` when it applies. */
export function splitBatch<T>(
  input: string,
  items: T[],
  cap: number,
  capped: CappedInput[],
): { served: T[]; unprocessed: T[] } {
  if (items.length <= cap) return { served: items, unprocessed: [] };
  const unprocessed = items.slice(cap);
  capped.push({ input, requested: items.length, served: cap, unprocessed: unprocessed.length });
  return { served: items.slice(0, cap), unprocessed };
}
