/**
 * @fileoverview PubChem API client with rate limiting, retry, and response parsing.
 * Wraps both PUG REST and PUG View APIs behind a shared rate limiter.
 * @module services/pubchem/pubchem-client
 */

import type {
  AidListResponse,
  AssaySummaryTableResponse,
  BioactivityRow,
  CidListResponse,
  GHSClassification,
  PropertyTableResponse,
  PugViewInformation,
  PugViewResponse,
  PugViewSection,
  SynonymResponse,
  XrefResponse,
} from './types.js';
import { PubChemNotFoundError } from './types.js';

// ── Rate Limiter ─────────────────────────────────────────────────────

/** Sliding-window rate limiter. Queues requests exceeding maxPerSecond. */
class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly max: number;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(maxPerSecond: number) {
    this.max = maxPerSecond;
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.draining) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      const cutoff = now - 1000;
      while (this.timestamps[0] != null && this.timestamps[0] <= cutoff) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.max) {
        this.timestamps.push(Date.now());
        this.queue.shift()?.();
      } else {
        const oldest = this.timestamps[0] ?? Date.now();
        const wait = oldest + 1000 - Date.now();
        await new Promise<void>((r) => setTimeout(r, Math.max(10, wait)));
      }
    }
    this.draining = false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseFaultMessage(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { Fault?: { Code?: string; Message?: string } };
    if (data.Fault?.Message) {
      return `${data.Fault.Code ?? 'Error'}: ${data.Fault.Message}`;
    }
  } catch {
    /* not JSON */
  }
  return;
}

// ── PUG View Parsing ─────────────────────────────────────────────────

/** Recursively search PUG View sections for a heading */
function findSection(sections: PugViewSection[], heading: string): PugViewSection | undefined {
  for (const section of sections) {
    if (section.TOCHeading === heading) return section;
    if (section.Section) {
      const found = findSection(section.Section, heading);
      if (found) return found;
    }
  }
  return;
}

/** Extract all text strings from a PUG View section and its children */
function extractStrings(section: PugViewSection): string[] {
  const strings: string[] = [];
  if (section.Information) {
    for (const info of section.Information) {
      if (info.Value.StringWithMarkup) {
        for (const swm of info.Value.StringWithMarkup) {
          if (swm.String) strings.push(swm.String);
        }
      }
    }
  }
  if (section.Section) {
    for (const sub of section.Section) {
      strings.push(...extractStrings(sub));
    }
  }
  return strings;
}

/** Extract GHS info items from a PUG View section */
function extractGHSInfo(section: PugViewSection): PugViewInformation[] {
  const infos: PugViewInformation[] = [];
  if (section.Information) infos.push(...section.Information);
  if (section.Section) {
    for (const sub of section.Section) {
      infos.push(...extractGHSInfo(sub));
    }
  }
  return infos;
}

/** Parse "H225: Highly flammable..." into { code, statement } */
function parseCodedStatement(text: string): { code: string; statement: string } | undefined {
  const match = text.match(/^([HP]\d{3}(?:\+[HP]\d{3})*)\s*[:\-–]\s*(.+)/);
  if (match?.[1] && match[2]) return { code: match[1], statement: match[2].trim() };
  const codeOnly = text.match(/^([HP]\d{3}(?:\+[HP]\d{3})*)$/);
  if (codeOnly?.[1]) return { code: codeOnly[1], statement: '' };
  return;
}

/** Map PubChem pictogram markup strings to human labels */
const PICTOGRAM_LABELS: Record<string, string> = {
  GHS01: 'Explosive',
  GHS02: 'Flammable',
  GHS03: 'Oxidizer',
  GHS04: 'Compressed Gas',
  GHS05: 'Corrosive',
  GHS06: 'Toxic',
  GHS07: 'Irritant',
  GHS08: 'Health Hazard',
  GHS09: 'Environmental Hazard',
};

function parsePictogram(text: string): string {
  for (const [code, label] of Object.entries(PICTOGRAM_LABELS)) {
    if (text.includes(code)) return label;
  }
  return text.replace(/.*\//, '').replace(/\..*/, '');
}

// ── Client ───────────────────────────────────────────────────────────

export class PubChemClient {
  private readonly pugBase = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
  private readonly viewBase = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view';
  private readonly rateLimiter = new RateLimiter(5);

  // ── Core HTTP ────────────────────────────────────────────────────

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.rateLimiter.acquire();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });

        if (response.ok) {
          return (await response.json()) as T;
        }

        const text = await response.text();
        const message = parseFaultMessage(text) ?? text.slice(0, 300);

        if (response.status === 404) {
          throw new PubChemNotFoundError(message);
        }

        // Retry once on 5xx
        if (response.status >= 500 && attempt < 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }

        throw new Error(`PubChem HTTP ${response.status}: ${message}`);
      } catch (error) {
        if (error instanceof PubChemNotFoundError) throw error;
        if (error instanceof Error && error.message.startsWith('PubChem HTTP 4')) throw error;

        // Retry once on network errors
        if (attempt < 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('PubChem request timed out (30s)');
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  private async fetchBinary(url: string): Promise<ArrayBuffer> {
    await this.rateLimiter.acquire();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        const text = await response.text();
        const message = parseFaultMessage(text) ?? text.slice(0, 300);
        if (response.status === 404) throw new PubChemNotFoundError(message);
        throw new Error(`PubChem HTTP ${response.status}: ${message}`);
      }

      return await response.arrayBuffer();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── CID Resolution ──────────────────────────────────────────────

  /** Fetch CID list, returning [] on 404 (no results) */
  private async fetchCids(url: string, init?: RequestInit): Promise<number[]> {
    try {
      const data = await this.fetchJson<CidListResponse>(url, init);
      return data.IdentifierList.CID;
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return [];
      throw error;
    }
  }

  searchByName(name: string): Promise<number[]> {
    return this.fetchCids(`${this.pugBase}/compound/name/${encodeURIComponent(name)}/cids/JSON`);
  }

  searchBySmiles(smiles: string): Promise<number[]> {
    return this.fetchCids(`${this.pugBase}/compound/smiles/cids/JSON`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ smiles }).toString(),
    });
  }

  searchByInchiKey(inchikey: string): Promise<number[]> {
    return this.fetchCids(
      `${this.pugBase}/compound/inchikey/${encodeURIComponent(inchikey)}/cids/JSON`,
    );
  }

  searchByFormula(formula: string, allowOther = false): Promise<number[]> {
    const params = allowOther ? '?AllowOtherElements=true' : '';
    return this.fetchCids(
      `${this.pugBase}/compound/fastformula/${encodeURIComponent(formula)}/cids/JSON${params}`,
    );
  }

  searchByStructure(
    mode: 'substructure' | 'superstructure' | 'similarity',
    query: string,
    queryType: 'smiles' | 'cid',
    threshold?: number,
  ): Promise<number[]> {
    const endpoint =
      mode === 'similarity'
        ? 'fastsimilarity_2d'
        : mode === 'substructure'
          ? 'fastsubstructure'
          : 'fastsuperstructure';

    const thresholdParam = mode === 'similarity' ? `?Threshold=${threshold ?? 90}` : '';

    if (queryType === 'cid') {
      return this.fetchCids(
        `${this.pugBase}/compound/${endpoint}/cid/${query}/cids/JSON${thresholdParam}`,
      );
    }

    // POST for SMILES to avoid encoding issues
    const url = `${this.pugBase}/compound/${endpoint}/smiles/cids/JSON${thresholdParam}`;
    return this.fetchCids(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ smiles: query }).toString(),
    });
  }

  // ── Compound Data ───────────────────────────────────────────────

  async getProperties(
    cids: number[],
    properties: string[],
  ): Promise<Array<Record<string, unknown> & { CID: number }>> {
    if (cids.length === 0 || properties.length === 0) return [];

    const propsPath = properties.join(',');
    const cidStr = cids.join(',');

    // POST for large CID lists, GET for small ones
    if (cids.length > 50) {
      const data = await this.fetchJson<PropertyTableResponse>(
        `${this.pugBase}/compound/cid/property/${propsPath}/JSON`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ cid: cidStr }).toString(),
        },
      );
      return data.PropertyTable.Properties;
    }

    const data = await this.fetchJson<PropertyTableResponse>(
      `${this.pugBase}/compound/cid/${cidStr}/property/${propsPath}/JSON`,
    );
    return data.PropertyTable.Properties;
  }

  async getSynonyms(cid: number): Promise<string[]> {
    try {
      const data = await this.fetchJson<SynonymResponse>(
        `${this.pugBase}/compound/cid/${cid}/synonyms/JSON`,
      );
      return data.InformationList.Information[0]?.Synonym ?? [];
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return [];
      throw error;
    }
  }

  getImage(cid: number, size: 'small' | 'large' = 'large'): Promise<ArrayBuffer> {
    const sizeParam = size === 'small' ? '?image_size=small' : '?image_size=large';
    return this.fetchBinary(`${this.pugBase}/compound/cid/${cid}/PNG${sizeParam}`);
  }

  async getXrefs(cid: number, xrefType: string): Promise<(string | number)[]> {
    try {
      const data = await this.fetchJson<XrefResponse>(
        `${this.pugBase}/compound/cid/${cid}/xrefs/${xrefType}/JSON`,
      );
      const info = data.InformationList.Information[0];
      if (!info) return [];
      const values = info[xrefType];
      return Array.isArray(values) ? (values as (string | number)[]) : [];
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return [];
      throw error;
    }
  }

  // ── PUG View ────────────────────────────────────────────────────

  async getDescription(cid: number): Promise<string | null> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Record+Description`,
      );

      const sections = data.Record.Section;
      if (!sections) return null;

      const descSection = findSection(sections, 'Record Description');
      if (!descSection) return null;

      const strings = extractStrings(descSection);
      return strings.length > 0 ? strings.join('\n\n') : null;
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return null;
      throw error;
    }
  }

  async getSafetyData(cid: number): Promise<GHSClassification | null> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Safety+and+Hazards`,
      );

      const sections = data.Record.Section;
      if (!sections) return null;

      const ghsSection = findSection(sections, 'GHS Classification');
      if (!ghsSection) return null;

      const infos = extractGHSInfo(ghsSection);
      const result: GHSClassification = {
        pictograms: [],
        hazardStatements: [],
        precautionaryStatements: [],
      };

      for (const info of infos) {
        const name = info.Name?.toLowerCase() ?? '';
        const strings = info.Value.StringWithMarkup?.map((s) => s.String).filter(Boolean) ?? [];

        if (name.includes('signal') && strings[0]) {
          result.signalWord = strings[0];
        } else if (name.includes('pictogram')) {
          const extras =
            info.Value.StringWithMarkup?.flatMap(
              (s) => s.Markup?.map((m) => m.Extra).filter((e): e is string => e != null) ?? [],
            ) ?? [];
          result.pictograms.push(...(extras.length > 0 ? extras : strings).map(parsePictogram));
        } else if (name.includes('hazard') && name.includes('statement')) {
          for (const s of strings) {
            const parsed = parseCodedStatement(s);
            if (parsed) result.hazardStatements.push(parsed);
          }
        } else if (name.includes('precautionary') && name.includes('statement')) {
          for (const s of strings) {
            const parsed = parseCodedStatement(s);
            if (parsed) result.precautionaryStatements.push(parsed);
          }
        }
      }

      // Extract source from references
      const refs = data.Record.Reference;
      if (refs?.[0]?.SourceName) {
        result.source = refs[0].SourceName;
      }

      return result.signalWord || result.pictograms.length > 0 || result.hazardStatements.length > 0
        ? result
        : null;
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return null;
      throw error;
    }
  }

  // ── Bioactivity ─────────────────────────────────────────────────

  async getAssaySummary(cid: number): Promise<BioactivityRow[]> {
    try {
      const data = await this.fetchJson<AssaySummaryTableResponse>(
        `${this.pugBase}/compound/cid/${cid}/assaysummary/JSON`,
      );
      return this.parseAssayTable(data);
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return [];
      throw error;
    }
  }

  private parseAssayTable(data: AssaySummaryTableResponse): BioactivityRow[] {
    const columns = data.Table.Columns.Column;
    const rows = data.Table.Row;

    // Build column index lookup
    const col = (name: string) => columns.indexOf(name);
    const aidIdx = col('AID');
    const nameIdx = col('Assay Name');
    const outcomeIdx = col('Activity Outcome');
    const targetNameIdx = col('Target Name');
    const geneSymbolIdx = col('Target GeneSymbol');
    const actValueIdx = col('Activity Value');
    const actNameIdx = col('Activity Name');
    const actUnitIdx = col('Activity Unit');

    // Group by AID to collect multiple activity values
    const byAid = new Map<number, BioactivityRow>();

    for (const row of rows) {
      const cell = row.Cell;
      const aid = Number(cell[aidIdx]);
      if (!aid || Number.isNaN(aid)) continue;

      if (!byAid.has(aid)) {
        const row: BioactivityRow = {
          aid,
          assayName: String(cell[nameIdx] ?? ''),
          outcome: String(cell[outcomeIdx] ?? ''),
          activityValues: [],
        };
        if (targetNameIdx >= 0 && cell[targetNameIdx]) row.targetName = String(cell[targetNameIdx]);
        if (geneSymbolIdx >= 0 && cell[geneSymbolIdx])
          row.targetGeneSymbol = String(cell[geneSymbolIdx]);
        byAid.set(aid, row);
      }

      // Collect activity value if present
      if (actValueIdx >= 0 && cell[actValueIdx] != null) {
        const value = Number(cell[actValueIdx]);
        if (!Number.isNaN(value)) {
          byAid.get(aid)?.activityValues.push({
            name: actNameIdx >= 0 ? String(cell[actNameIdx] ?? '') : '',
            value,
            unit: actUnitIdx >= 0 ? String(cell[actUnitIdx] ?? '') : '',
          });
        }
      }
    }

    return [...byAid.values()];
  }

  // ── Assay Search ────────────────────────────────────────────────

  async searchAssaysByTarget(targetType: string, query: string): Promise<number[]> {
    try {
      const data = await this.fetchJson<AidListResponse>(
        `${this.pugBase}/assay/target/${targetType}/${encodeURIComponent(query)}/aids/JSON`,
      );
      return data.IdentifierList.AID;
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return [];
      throw error;
    }
  }

  // ── Entity Summaries ────────────────────────────────────────────

  async getEntitySummary(
    entityType: string,
    identifier: string | number,
  ): Promise<Record<string, unknown> | null> {
    const pathMap: Record<string, string> = {
      assay: `/assay/aid/${identifier}/summary/JSON`,
      gene: `/gene/geneid/${identifier}/summary/JSON`,
      protein: `/protein/accession/${encodeURIComponent(String(identifier))}/summary/JSON`,
      pathway: `/pathway/accession/${encodeURIComponent(String(identifier))}/summary/JSON`,
      taxonomy: `/taxonomy/taxid/${identifier}/summary/JSON`,
      cell: `/cell/accession/${encodeURIComponent(String(identifier))}/summary/JSON`,
      substance: `/substance/sid/${identifier}/summary/JSON`,
    };

    const path = pathMap[entityType];
    if (!path) throw new Error(`Unknown entity type: ${entityType}`);

    try {
      const data = await this.fetchJson<Record<string, unknown>>(`${this.pugBase}${path}`);

      // Response shape: { XxxSummaries: { XxxSummary: [{...}] } }
      const summariesKey = Object.keys(data).find((k) => k.endsWith('Summaries'));
      if (!summariesKey) return null;

      const summaries = data[summariesKey] as Record<string, unknown>;
      const summaryKey = Object.keys(summaries).find((k) => k.endsWith('Summary'));
      if (!summaryKey) return null;

      const arr = summaries[summaryKey] as Record<string, unknown>[];
      return arr[0] ?? null;
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return null;
      throw error;
    }
  }
}

// ── Init/Accessor ────────────────────────────────────────────────────

let _client: PubChemClient | undefined;

export function initPubChemClient(): void {
  _client = new PubChemClient();
}

export function getPubChemClient(): PubChemClient {
  if (!_client)
    throw new Error('PubChemClient not initialized — call initPubChemClient() in setup()');
  return _client;
}
