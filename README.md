<div align="center">
  <h1>@cyanheads/pubchem-mcp-server</h1>
  <p><b>Search the PubChem chemical database for compounds, properties, safety data, bioactivity, cross-references, and entity summaries via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 6 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pubchem-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pubchem-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubchem-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.4.0-f472b6.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pubchem-mcp-server/releases/latest/download/pubchem-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pubchem-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcHViY2hlbS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pubchem-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpubchem-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://pubchem.caseyjhand.com/mcp](https://pubchem.caseyjhand.com/mcp)

</div>

---

## Overview

Chemical compound and bioassay data from PubChem's PUG REST and PUG View APIs. Search compounds by identifier, formula, or structure; fetch physicochemical properties, safety data, bioactivity, interactions, cross-references, and 3D structures; find bioassays by biological target. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `pubchem_search_compounds` | Search for compounds by name, SMILES, InChIKey, formula, substructure, superstructure, or 2D similarity. |
| `pubchem_get_compound_details` | Get physicochemical properties, descriptions, synonyms, drug-likeness, and classification for compounds by CID. |
| `pubchem_get_compound_image` | Fetch a 2D structure diagram (PNG) for a compound by CID. |
| `pubchem_get_compound_3d_structure` | Fetch a 3D conformer (atomic coordinates and bonds) for a compound by CID, as parsed JSON or raw SDF. |
| `pubchem_get_compound_xrefs` | Get external database cross-references (PubMed, patents, genes, proteins, etc.). |
| `pubchem_get_compound_safety` | Get GHS hazard classification and safety data for one or more compounds by CID (batch). |
| `pubchem_get_bioactivity` | Get a compound's bioactivity profile: assay results, targets, and activity values; filter by outcome or molecular target. |
| `pubchem_get_compound_interactions` | Get drug-drug, drug-food, and chemical-target interactions for a compound by CID. |
| `pubchem_search_assays` | Find bioassays by biological target (gene symbol, protein, Gene ID, UniProt accession). |
| `pubchem_get_summary` | Get summaries for PubChem entities: assays, genes, proteins, taxonomy. |

### Resources

Compound and assay records are also exposed as URI-templated resources, backed by the same client methods as the tools; many MCP clients are tool-only and never surface resources.

| Resource | Description |
|:---|:---|
| `pubchem://compound/{cid}` | Core physicochemical properties (JSON). |
| `pubchem://compound/{cid}/safety` | GHS hazard classification (JSON). |
| `pubchem://compound/{cid}/image` | 2D structure diagram (PNG). |
| `pubchem://compound/{cid}/xrefs` | External cross-references (JSON). |
| `pubchem://compound/{cid}/bioactivity` | Bioassay activity profile (JSON). |
| `pubchem://assay/{aid}` | BioAssay summary (JSON). |

## Capability reference

### `pubchem_search_compounds` <sub>tool</sub>

- Five search strategies: identifier (name/SMILES/InChIKey, batched 1-25), formula (Hill notation, optional `allowOtherElements`), substructure/superstructure containment, or 2D Tanimoto similarity (threshold 70-100, default 90)
- Each strategy needs its own fields — identifier: `identifierType` + `identifiers`; formula: `formula`; substructure/superstructure/similarity: `query` + `queryType` — and a missing or blank one is rejected before the upstream call
- Caps at 200 CIDs per page (default 20); `offset` pages to a ceiling of 10,000 — identifier lookups resolve every match up front so paging is free, while formula/structure/similarity searches cost more upstream per deep page
- Optional `properties` hydration avoids a follow-up `pubchem_get_compound_details` call
- Identifier mode reports `unresolvedIdentifiers` for inputs that resolved to no CID, plus notices when multiple inputs collide on one CID
- Reports an exact `totalFound` when the full match set was observed, or a `totalFoundAtLeast` floor when a bounded upstream search saturated

---

### `pubchem_get_compound_details` <sub>tool</sub>

- Up to 100 CIDs per call; 27 available properties, defaulting to a core set of 14 (formula, weight, IUPAC name, SMILES forms, InChIKey, XLogP, TPSA, H-bond/rotatable-bond counts, heavy atom count, charge, complexity)
- Optional textual descriptions, paged via `descriptionOffset`/`maxDescriptions` (default 3, up to 20) — fetched only for the first 10 CIDs in the batch, remaining CIDs listed in `skippedCids`
- Optional synonyms for every found CID, paged via `synonymOffset`/`maxSynonyms` (default 20, up to 100)
- Optional drug-likeness assessment (Lipinski Rule of Five + Veber rules), computed from the returned properties at no extra latency
- Optional pharmacological classification (FDA classes/mechanisms, MeSH classes, ATC codes) — same 10-CID fan-out cap as descriptions
- Per-CID `found: false` distinguishes a nonexistent CID from a real compound PubChem simply has no data for

---

### `pubchem_get_compound_image` <sub>tool</sub>

- Single CID; `size` is `"small"` (100x100) or `"large"` (300x300, default)
- Returns base64-encoded PNG plus width/height
- Typed `cid_not_found` error when PubChem has no record for the CID

---

### `pubchem_get_compound_3d_structure` <sub>tool</sub>

- Single CID; `format="json"` (default) returns parsed atoms (element + x/y/z) and bonds, `format="sdf"` returns the raw V2000 SDF text
- `maxAtoms`/`maxBonds` cap the JSON preview (default 200 each); `atomCount`/`bondCount` always report the full totals, with any capping disclosed via enrichment
- `includeRawSdf` bypasses the default 500-line cap on the raw SDF text
- Optional `includeAlternateConformerIds` lists conformer IDs beyond the default
- Typed `no_3d_structure` error when PubChem has no computed 3D coordinates (large molecules, mixtures, some salts)

---

### `pubchem_get_compound_xrefs` <sub>tool</sub>

- Single CID; one or more `xrefTypes` — string IDs (`RegistryID`, `RN` for CAS numbers, `PatentID`) and numeric IDs (`PubMedID`, `GeneID`, `ProteinGI`, `TaxonomyID`)
- Paged per type: `maxPerType` up to 500 (default 50), with the same `offset` applied across every requested type
- Each type reports its own `totalAvailable` and `truncated` flag
- Empty-result notice distinguishes "this compound has none of the requested types" from a possibly-mistyped CID

---

### `pubchem_get_compound_safety` <sub>tool</sub>

- Batch of 1-25 CIDs
- Returns GHS signal word, pictograms, hazard statements (H-codes), and precautionary statements (P-codes), with source attribution
- Per-CID `status`: `ok`, `no_ghs_data` (compound exists, no deposited classification), or `cid_not_found` (no PubChem record at all) — kept distinct so a bad CID never reads as "no hazards on file"
- Precautionary statements carry a `decoded` flag — false for codes needing label-specific fill text or outside the decoder table; the code itself is still authoritative

---

### `pubchem_get_bioactivity` <sub>tool</sub>

- Single CID; filter by `outcomeFilter` (`active`/`inactive`/`all`, default `all`) and/or `targetGeneId`/`targetAccession`
- Caps at 100 results per page (default 20); `offset` reaches the rest
- Reports `totalAssays`/`activeCount`/`inactiveCount` for the whole compound, plus `filteredCount`/`returnedCount` for the current page
- Notices distinguish "no bioactivity data at all" from "the filter excluded everything" from "offset past the end"

---

### `pubchem_get_compound_interactions` <sub>tool</sub>

- Single CID; one or more `kinds` — `drug-drug` (DrugBank), `drug-food`, `target` (binding/activity from BindingDB, ChEMBL, and others); default `["drug-drug"]`
- `maxEntries` per kind per page (1-50, default 10); `offset` counts source records rather than returned entries, capped at 2,147,483,646
- Each kind pages independently — `paging[]` reports per-kind `totalRecords`/`nextOffset`/`truncated`; the top-level `nextOffset` is populated only when exactly one requested kind still has records left
- A kind that fails to retrieve is named in `failedKinds` without failing the kinds that succeeded

---

### `pubchem_search_assays` <sub>tool</sub>

- Search by `targetType`: `genesymbol`/`proteinname` (text), `geneid` (NCBI Gene ID), `proteinaccession` (UniProt)
- Caps at 200 AIDs per page (default 50); `offset` pages to the total found
- Rejects a blank `targetQuery` and a non-numeric `geneid` query before the upstream call
- Reports `totalFound` across all pages and distinguishes "no match" from "offset past the end"

---

### `pubchem_get_summary` <sub>tool</sub>

- `entityType`: `assay` (AID), `gene` (NCBI Gene ID), `protein` (UniProt accession), or `taxonomy` (Tax ID); up to 10 identifiers per call
- Per-identifier `found` flag; populated fields depend on `entityType` (taxonomy includes an ordered `lineage`, gene includes `symbol`/`taxonomy`)
- Notice reports how many identifiers were not found and which ID type `entityType` expects

---

### `pubchem://compound/{cid}` <sub>resource</sub>

- Core physicochemical properties (the same default 14-property set as `pubchem_get_compound_details`), as `application/json`
- Throws a typed not-found when the CID doesn't exist in PubChem
- Use `pubchem_get_compound_details` to select specific properties or add descriptions, synonyms, drug-likeness, and classification

---

### `pubchem://compound/{cid}/safety` <sub>resource</sub>

- GHS hazard classification as `application/json`
- `status` (`ok`/`no_ghs_data`/`cid_not_found`) is the only signal distinguishing a bad CID from a compound with no deposited classification — a resource read has no notice surface

---

### `pubchem://compound/{cid}/image` <sub>resource</sub>

- 2D structure diagram, 300x300 PNG, returned as a base64 blob
- Use `pubchem_get_compound_image` for the 100x100 size option

---

### `pubchem://compound/{cid}/xrefs` <sub>resource</sub>

- Focused default set — `RN` (CAS), `RegistryID`, `PubMedID` — up to 25 IDs per type, as `application/json`
- Use `pubchem_get_compound_xrefs` for the full set of xref types, a higher per-type cap, and offset paging

---

### `pubchem://compound/{cid}/bioactivity` <sub>resource</sub>

- Up to 25 assays as `application/json`, plus `totalAssays`/`activeCount` for the whole compound
- Use `pubchem_get_bioactivity` to filter by outcome or target, raise the cap, or page with offset

---

### `pubchem://assay/{aid}` <sub>resource</sub>

- BioAssay summary as `application/json` — name, description, source, protocol, substance counts
- Throws a typed not-found when the AID doesn't exist

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PubChem-specific:

- Covers both PUG REST (search, properties, cross-references, safety, bioactivity, interactions) and PUG View (textual descriptions, pharmacological classification) endpoints
- Rate-limited client (5 req/s) with automatic request queuing, and retry with exponential backoff on 5xx errors and network failures
- Hand-rolled V2000 SDF parser for 3D conformer atoms and bonds; drug-likeness (Lipinski/Veber) computed from already-fetched properties, adding no extra latency
- All tools are read-only and idempotent — no API keys required, PubChem's API is freely accessible

Agent-friendly output:

- Discriminated output contracts — per-CID `status` (`ok` / `no_ghs_data` / `cid_not_found`) and `found` flags let callers branch on data instead of matching an error string
- Graceful partial failure — batch tools return per-item results alongside `unresolvedIdentifiers`, `skippedCids`, and `failedKinds` rather than failing the whole call
- Response shaping — truncation disclosure (`truncated`, `shown`/`cap`, `nextOffset`) on every capped list, plus a `totalFoundAtLeast` floor in place of a count when an upstream search saturates
- Typed error reasons — validation and not-found failures declare a `reason` (e.g. `cid_not_found`, `missing_identifier_args`, `invalid_cid_query`) with actionable recovery text, not generic messages

## Getting started

### Public Hosted Instance

A public instance is available at `https://pubchem.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "pubchem-mcp-server": {
      "type": "streamable-http",
      "url": "https://pubchem.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "pubchem-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/pubchem-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "pubchem-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/pubchem-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "pubchem-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/pubchem-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API keys required — PubChem's API is freely accessible.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/pubchem-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd pubchem-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to override transport, session mode, storage, or logging defaults
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Host for HTTP server. | `127.0.0.1` |
| `MCP_SESSION_MODE` | `stateless`, `stateful`, or `auto`. PubChem needs no multi-round-trip input, so the server declares `stateless`; the example and Docker set it to match. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t pubchem-mcp-server .
docker run --rm -p 3010:3010 pubchem-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/pubchem-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits the PubChem client. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/pubchem/` | PubChem API client — rate limiting, retry, and response/SDF parsing. |
| `scripts/` | Build, clean, devcheck, and tree generation scripts. |
| `tests/` | Unit and integration tests. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Wrap external API calls: validate the raw PubChem response → normalize to a domain type → return the output schema; never fabricate missing fields
- Register new tools and resources in the `index.ts` barrel files

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
