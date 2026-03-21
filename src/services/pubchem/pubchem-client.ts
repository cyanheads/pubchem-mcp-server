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
  CompoundClassification,
  GHSClassification,
  ListKeyResponse,
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

/** PubChem returns different field names than the request parameter names for some properties.
 * Request IsomericSMILES → response key "SMILES" (includes stereochemistry).
 * Request CanonicalSMILES → response key "ConnectivitySMILES" (connectivity only). */
const PROPERTY_NAME_MAP: Record<string, string> = {
  SMILES: 'IsomericSMILES',
  ConnectivitySMILES: 'CanonicalSMILES',
};

function normalizePropertyNames<T extends Record<string, unknown>>(row: T): T {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) {
    result[PROPERTY_NAME_MAP[key] ?? key] = value;
  }
  return result as T;
}

function parseFaultMessage(text: string): string | undefined {
  // JSON fault response (most endpoints)
  try {
    const data = JSON.parse(text) as { Fault?: { Code?: string; Message?: string } };
    if (data.Fault?.Message) {
      return `${data.Fault.Code ?? 'Error'}: ${data.Fault.Message}`;
    }
  } catch {
    /* not JSON — try plain-text format below */
  }

  // Plain-text fault response (image endpoint): "Status: 400\nCode: X\nMessage: Y"
  const code = text.match(/^Code:\s*(.+)$/m)?.[1];
  const message = text.match(/^Message:\s*(.+)$/m)?.[1];
  if (code && message) return `${code}: ${message}`;

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

  /** Fetch CID list, with automatic ListKey polling for async searches */
  private async fetchCids(url: string, init?: RequestInit): Promise<number[]> {
    try {
      const data = await this.fetchJson<CidListResponse | ListKeyResponse>(url, init);
      if ('Waiting' in data) return this.pollListKey(data.Waiting.ListKey);
      return data.IdentifierList.CID;
    } catch (error) {
      if (error instanceof PubChemNotFoundError) return [];
      throw error;
    }
  }

  /** Poll a PubChem ListKey until results are ready */
  private async pollListKey(listKey: string, maxAttempts = 20): Promise<number[]> {
    const pollUrl = `${this.pugBase}/compound/listkey/${listKey}/cids/JSON`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(1500);
      try {
        const data = await this.fetchJson<CidListResponse | ListKeyResponse>(pollUrl);
        if ('Waiting' in data) continue;
        return data.IdentifierList.CID;
      } catch (error) {
        if (error instanceof PubChemNotFoundError) return [];
        throw error;
      }
    }
    throw new Error('PubChem async search timed out after polling');
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

    let rows: Array<Record<string, unknown> & { CID: number }>;

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
      rows = data.PropertyTable.Properties;
    } else {
      const data = await this.fetchJson<PropertyTableResponse>(
        `${this.pugBase}/compound/cid/${cidStr}/property/${propsPath}/JSON`,
      );
      rows = data.PropertyTable.Properties;
    }

    // PubChem returns different field names than the request names for some properties.
    // Normalize so consumers see the names they requested.
    return rows.map((row) => normalizePropertyNames(row));
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

      // Deduplicate across depositors
      result.pictograms = [...new Set(result.pictograms)];
      const seenH = new Set<string>();
      result.hazardStatements = result.hazardStatements.filter((h) => {
        if (seenH.has(h.code)) return false;
        seenH.add(h.code);
        return true;
      });
      const seenP = new Set<string>();
      result.precautionaryStatements = result.precautionaryStatements.filter((p) => {
        if (seenP.has(p.code)) return false;
        seenP.add(p.code);
        return true;
      });

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

  async getClassification(cid: number): Promise<CompoundClassification | null> {
    try {
      const data = await this.fetchJson<PugViewResponse>(
        `${this.viewBase}/data/compound/${cid}/JSON?heading=Pharmacology+and+Biochemistry`,
      );

      const sections = data.Record.Section;
      if (!sections) return null;

      const result: CompoundClassification = {
        atcCodes: [],
        fdaClasses: [],
        fdaMechanisms: [],
        meshClasses: [],
      };

      // FDA Pharmacological Classification
      const fdaSection = findSection(sections, 'FDA Pharmacological Classification');
      if (fdaSection) {
        const strings = extractStrings(fdaSection);
        for (const s of strings) {
          if (!s.startsWith('Pharmacological Classes:')) continue;
          const classes = s.slice('Pharmacological Classes:'.length).trim();
          for (const entry of classes.split(';')) {
            const trimmed = entry.trim();
            const tagMatch = trimmed.match(/^(.+?)\s*\[(\w+)\]$/);
            if (!tagMatch) continue;
            const [, name, tag] = tagMatch;
            if (!name) continue;
            if (tag === 'EPC' || tag === 'CS') result.fdaClasses.push(name.trim());
            else if (tag === 'MoA') result.fdaMechanisms.push(name.trim());
          }
        }
        result.fdaClasses = [...new Set(result.fdaClasses)];
        result.fdaMechanisms = [...new Set(result.fdaMechanisms)];
      }

      // MeSH Pharmacological Classification
      const meshSection = findSection(sections, 'MeSH Pharmacological Classification');
      if (meshSection) {
        result.meshClasses = extractStrings(meshSection);
      }

      // ATC Code
      const atcSection = findSection(sections, 'ATC Code');
      if (atcSection) {
        const strings = extractStrings(atcSection);
        for (const s of strings) {
          // Match leaf codes like "N02BA01 - Acetylsalicylic acid" or bare "N02BA01"
          const match = s.match(/^([A-Z]\d{2}[A-Z]{2}\d{2})\b/);
          if (match) {
            const desc = s.includes(' - ') ? s.split(' - ').slice(1).join(' - ').trim() : '';
            result.atcCodes.push({ code: match[1] ?? '', description: desc });
          }
        }
        // Deduplicate by code
        const seen = new Set<string>();
        result.atcCodes = result.atcCodes.filter((a) => {
          if (seen.has(a.code)) return false;
          seen.add(a.code);
          return true;
        });
      }

      const hasData =
        result.fdaClasses.length > 0 ||
        result.fdaMechanisms.length > 0 ||
        result.meshClasses.length > 0 ||
        result.atcCodes.length > 0;
      return hasData ? result : null;
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

    // Build column index lookup — exact match
    const col = (name: string) => columns.indexOf(name);
    // Prefix match for columns with embedded units like "Activity Value [uM]"
    const colPrefix = (prefix: string) => columns.findIndex((c) => c.startsWith(prefix));

    const aidIdx = col('AID');
    const nameIdx = col('Assay Name');
    const outcomeIdx = col('Activity Outcome');
    const targetAccIdx = col('Target Accession');
    const geneIdIdx = col('Target GeneID');
    const actValueIdx = colPrefix('Activity Value');
    const actNameIdx = col('Activity Name');

    // Extract unit from column name if present, e.g. "Activity Value [uM]" → "uM"
    const actValueUnit =
      actValueIdx >= 0 ? (columns[actValueIdx]?.match(/\[(.+)\]/)?.[1] ?? '') : '';

    // Group by AID to collect multiple activity values
    const byAid = new Map<number, BioactivityRow>();

    for (const row of rows) {
      const cell = row.Cell;
      const aid = Number(cell[aidIdx]);
      if (!aid || Number.isNaN(aid)) continue;

      if (!byAid.has(aid)) {
        const entry: BioactivityRow = {
          aid,
          assayName: String(cell[nameIdx] ?? ''),
          outcome: String(cell[outcomeIdx] ?? ''),
          activityValues: [],
        };
        if (targetAccIdx >= 0 && cell[targetAccIdx])
          entry.targetAccession = String(cell[targetAccIdx]);
        if (geneIdIdx >= 0 && cell[geneIdIdx] != null) {
          const gid = Number(cell[geneIdIdx]);
          if (!Number.isNaN(gid) && gid > 0) entry.targetGeneId = gid;
        }
        byAid.set(aid, entry);
      }

      // Collect activity value if present
      if (actValueIdx >= 0 && cell[actValueIdx] != null) {
        const value = Number(cell[actValueIdx]);
        if (!Number.isNaN(value)) {
          byAid.get(aid)?.activityValues.push({
            name: actNameIdx >= 0 ? String(cell[actNameIdx] ?? '') : '',
            value,
            unit: actValueUnit,
          });
        }
      }
    }

    return [...byAid.values()];
  }

  // ── Assay Search ────────────────────────────────────────────────

  async searchAssaysByTarget(targetType: string, query: string): Promise<number[]> {
    // PubChem API expects "accession" not "proteinaccession"
    const apiTargetType = targetType === 'proteinaccession' ? 'accession' : targetType;
    try {
      const data = await this.fetchJson<AidListResponse>(
        `${this.pugBase}/assay/target/${apiTargetType}/${encodeURIComponent(query)}/aids/JSON`,
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
      taxonomy: `/taxonomy/taxid/${identifier}/summary/JSON`,
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
      // PubChem returns HTTP 400 (not 404) for nonexistent entity IDs in some endpoints
      if (error instanceof Error && /PubChem HTTP 400/.test(error.message)) return null;
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
