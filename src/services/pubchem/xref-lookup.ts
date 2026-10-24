/**
 * @fileoverview Per-type cross-reference lookup shared by the pubchem_get_compound_xrefs tool
 * and the pubchem://compound/{cid}/xrefs resource.
 * @module services/pubchem/xref-lookup
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { PubChemClient } from './pubchem-client.js';
import { HEADING_XREF_TYPES, type HeadingXrefType, type XrefType } from './types.js';

/** Every ID of one xref type, in serving order. `sourceCounts` is present for the heading types
 * (CAS, EC) and aligned with `ids`: `sourceCounts[i]` source records deposited `ids[i]`. */
export interface XrefGroup {
  ids: (string | number)[];
  sourceCounts?: number[];
  type: XrefType;
}

export interface XrefLookup {
  /** Types whose request failed, in request order, with the error it failed with. */
  failed: Array<{ type: XrefType; error: unknown }>;
  /** Types that answered, in request order. */
  groups: XrefGroup[];
}

const isHeadingType = (type: XrefType): type is HeadingXrefType =>
  (HEADING_XREF_TYPES as readonly string[]).includes(type);

/** PubChem's throttling answers, which every later request in the sequence would meet too. */
const isThrottled = (error: unknown): boolean =>
  error instanceof McpError && (error.data?.status === 503 || error.data?.status === 429);

/** PubChem serves ProteinGI for no compound (#72), so an empty ProteinGI group says nothing. */
const isAnswer = (group: XrefGroup): boolean => group.type !== 'ProteinGI' || group.ids.length > 0;

/** Fetch each requested xref type in turn: CAS and EC from their PUG View heading, every other
 * type from PUG REST's xrefs endpoint, all under the call's shared request budget.
 *
 * A failed type fails only itself — it is reported in `failed` and the types that answered are
 * returned. A 503 or 429 means PubChem is throttling, so the lookup stops there: that type and
 * every one after it are reported failed with the same error, and no further request is sent.
 * A cancellation ends the lookup at once. When no type answered — an empty ProteinGI is no
 * answer — and one failed, there is nothing to return, so the first failure is thrown. Requests
 * run one at a time, so a withdrawn call stops before its next request. */
export async function lookupXrefs(
  client: Pick<PubChemClient, 'getXrefs' | 'getHeadingXrefs'>,
  cid: number,
  types: readonly XrefType[],
  signal: AbortSignal,
): Promise<XrefLookup> {
  const groups: XrefGroup[] = [];
  const failed: XrefLookup['failed'] = [];
  for (const [index, type] of types.entries()) {
    try {
      if (isHeadingType(type)) {
        const attested = await client.getHeadingXrefs(cid, type, signal);
        groups.push({
          type,
          ids: attested.map((x) => x.id),
          sourceCounts: attested.map((x) => x.sourceCount),
        });
      } else {
        groups.push({ type, ids: await client.getXrefs(cid, type, signal) });
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (isThrottled(error)) {
        for (const unsent of types.slice(index)) failed.push({ type: unsent, error });
        break;
      }
      failed.push({ type, error });
    }
  }
  const [firstFailure] = failed;
  if (firstFailure && !groups.some(isAnswer)) throw firstFailure.error;
  return { groups, failed };
}
