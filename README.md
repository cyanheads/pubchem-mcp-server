<div align="center">
  <h1>@cyanheads/pubchem-mcp-server</h1>
  <p><b>Search the PubChem chemical database for compounds, properties, safety data, bioactivity, cross-references, and entity summaries via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 6 Resources • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pubchem-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pubchem-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubchem-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.4.0-f472b6.svg?style=flat-square)](https://bun.sh/)

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

Chemical compounds and bioassays from PubChem. Search compounds by name, formula, or structure; fetch properties, safety data, bioactivity, drug-food interactions, molecular targets, and 3D structures; and find bioassays by biological target.

### Tools

| Tool | Description |
|:---|:---|
| `pubchem_search_compounds` | Search for compounds by name, SMILES, InChI, InChIKey, formula, substructure, superstructure, or 2D similarity, or list the compounds a bioassay found active. |
| `pubchem_get_compound_details` | Get physicochemical properties, descriptions, synonyms, drug-likeness, and classification for compounds by CID. |
| `pubchem_get_compound_image` | Fetch a 2D structure diagram (PNG) for a compound by CID. |
| `pubchem_get_compound_3d_structure` | Fetch a 3D conformer (atomic coordinates and bonds) for a compound by CID, as parsed JSON or raw SDF. |
| `pubchem_get_compound_xrefs` | Get external database cross-references (PubMed, patents, genes, CAS and EC numbers, etc.). |
| `pubchem_get_compound_safety` | Get GHS hazard classification and safety data for one or more compounds by CID (batch). |
| `pubchem_get_bioactivity` | Get a compound's bioactivity profile: assay results, targets, activity values, assay types, and cited PubMed IDs; filter by outcome, molecular target, or assay type. |
| `pubchem_get_compound_interactions` | Get a compound's drug-food interactions and the molecular targets its assays name, each with assay counts and the most potent active value. |
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

### Skills

The server publishes an agent skill, [`pubchem-guide`](skills/pubchem-guide/SKILL.md), covering gates and identifier chains the tool descriptions don't carry: salt vs parent CIDs, where Gene IDs and accessions come from, why gene-symbol, Gene ID, and accession searches disagree, and how to read activity labels, potency values, and GHS data. Plugin installs (Claude Code, Codex) and the `.mcpb` bundle pick it up from `skills/`, and the server also serves it over MCP as `skill://pubchem-guide/SKILL.md`.

## Capability reference

### `pubchem_search_compounds` <sub>tool</sub>

- Six search strategies: identifier (`identifierType` + `identifiers`; name/SMILES/InChI/InChIKey, 25 per call, the rest returned in `unprocessed`), formula (`formula`, Hill notation, optional `allowOtherElements`), substructure/superstructure and 2D similarity (`query` + `queryType`; similarity threshold 70-100, default 90), or assay (`aid`; compounds the bioassay marked active, or every compound tested with `activeOnly: false`)
- Up to 200 CIDs per page (default 20; a larger `maxResults` is served at 200 and reported in `cappedInputs`); `offset` pages identifier and assay searches to the end of their matches, and formula, substructure, superstructure, and similarity searches to 10,000 (deeper fails with `offset_ceiling_exceeded`). Optional `properties` saves a follow-up `pubchem_get_compound_details` call
- Reports `totalFound`, or a `totalFoundAtLeast` floor when an upstream search saturated, and `unresolvedIdentifiers` for inputs with no CID. Fails with `aid_not_found` for an unknown AID and `search_query_rejected` (with a hint) for a query PubChem cannot search

---

### `pubchem_get_compound_details` <sub>tool</sub>

- Up to 100 CIDs per call (the rest returned in `unprocessed`); 27 available properties, defaulting to a core set of 14
- Optional descriptions (`descriptionOffset`/`maxDescriptions`, default 3, max 20) and classification (FDA, MeSH, ATC) cover the first 10 CIDs only, the rest listed in `skippedCids`. Optional synonyms (`synonymOffset`/`maxSynonyms`, default 20, max 100) and a Lipinski/Veber drug-likeness check cover every found CID
- Per-CID `found: false` separates a nonexistent CID from a compound with no data

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

- Single CID; one or more `xrefTypes`: `CAS`, `EC`, `RN`, `RegistryID`, `PatentID`, `PubMedID`, `GeneID`, `ProteinGI`, `TaxonomyID`
- `CAS` and `EC` are the numbers deposited for the compound, every distinct value ordered by how many source records deposited it, with those counts in `sourceCounts`. `RN` is PubChem's unranked registry-number list: the CAS number sits beside deprecated and related CAS RNs and EC numbers
- `ProteinGI` currently returns no data from PubChem; use `GeneID` for gene/protein associations
- `maxPerType` up to 500 (default 50), with one `offset` applied to every type; each type reports `totalAvailable` and `truncated`. `PubMedID` comes newest first
- A type that fails to load is named in `failedTypes` and the others still return; the call fails only when a type fails and no type other than ProteinGI (which PubChem no longer serves) loads. An empty result says whether the compound has none of the requested types or the CID may be mistyped

---

### `pubchem_get_compound_safety` <sub>tool</sub>

- Up to 25 CIDs per call (the rest returned in `unprocessed`)
- Returns the GHS signal word, pictograms, H-codes, and P-codes merged across sources, plus `classifications[]` with each source's own label; precautionary statements carry a `decoded` flag
- Per-CID `status`: `ok`, `not_classified` (notifiers found no GHS hazard), `no_ghs_data` (no deposited classification), or `cid_not_found`, so a bad CID never reads as "no hazards on file"

---

### `pubchem_get_bioactivity` <sub>tool</sub>

- Single CID; filter by `outcomeFilter` (`active`/`inactive`/`all`, default `all`), `targetGeneId`/`targetAccession`, and `assayType` (any of `confirmatory`/`screening`/`summary`/`other`); an assay must pass every filter set
- A target filter matches any identifier tied to the same target, so Gene ID 5742, UniProt P23219, and RefSeq NP_542158 all reach the same COX-1 assays
- Each result carries the assay's `assayType` and the PubMed IDs it cites (`pmids`, newest first)
- Up to 100 results per page (default 20); `offset` reaches the rest. A multi-target assay reports the matched target and lists the others under `otherTargets`
- Reports `totalAssays`/`activeCount`/`inactiveCount` for the whole compound and `filteredCount`/`returnedCount` for the page; notices say whether there is no data, the filter excluded everything, or `offset` is past the end

---

### `pubchem_get_compound_interactions` <sub>tool</sub>

- Single CID; one or more `kinds` — `drug-food` (PUG View), `target`, `drug-drug` (DrugBank); default `["drug-food"]`, and an empty drug-food page points at `target`
- `target` gives one entry per target the compound's assay summary names: a Gene ID with the accessions the table pairs with it, or an identifier it never pairs. A Gene ID and an accession that no row pairs are separate entries even when they name the same protein (erlotinib's ERBB2 appears as `accession:P04626` and as `GeneID:2064`). Each entry names the target from a batched gene or protein summary lookup, plus the `GeneID:` or `accession:` value `pubchem_get_bioactivity` filters on, and states the assay counts by outcome and the most potent Active value with its AID. Active targets come first, most potent first. If a name lookup fails or does not answer within a few seconds, the entries keep their identifier and the notice says so
- `maxEntries` per kind per page (max 50, default 10); `offset` counts records (targets, for `target`), up to 2,147,483,646. Each kind pages independently, reported in `paging[]` (`totalRecords`/`nextOffset`/`truncated`)
- A kind that fails is named in `failedKinds` and the others still return. The notice offers a retry only for a failure a retry can clear (timeout, rate limit, network error, unreadable response, 5xx other than 501); an HTTP 400, 403, or 501, or a response in a shape the server does not expect, fails the same way on every call. `drug-drug` comes from PubChem's SDQ service, which refuses automated requests, so it lands in `failedKinds` and a retry will not help

---

### `pubchem_search_assays` <sub>tool</sub>

- Search by `targetType`: `genesymbol`/`proteinname` (text), `geneid` (NCBI Gene ID), `proteinaccession` (UniProt)
- A `genesymbol` matches across species. `geneid` and `proteinaccession` each pin one protein but return overlapping, different assay sets for it; union both for a complete list
- Up to 200 AIDs per page (default 50); `offset` pages through the results
- Rejects a blank `targetQuery` and a non-numeric `geneid`; a `targetQuery` PubChem refuses with HTTP 400 (one carrying a line break, another C0 control character other than tab and NUL, or DEL) fails as `target_query_rejected`
- Reports `totalFound` and distinguishes "no match" from "offset past the end"

---

### `pubchem_get_summary` <sub>tool</sub>

- `entityType`: `assay` (AID), `gene` (NCBI Gene ID), `protein` (UniProt accession), or `taxonomy` (Tax ID); up to 10 identifiers per call
- A comma-joined string is split into identifiers; any past the first 10 are returned in `unprocessed`, and more than 1000 fails as `too_many_identifiers`
- AIDs, Gene IDs, and Tax IDs must be positive integers up to 2147483647; other pieces get an `invalid: true` row, and the call fails as `invalid_identifier` only when none is usable
- Per-identifier `found` flag; fields depend on `entityType` (taxonomy: ordered `lineage`; gene: `symbol`/`taxonomy`; assay: `method`, the first 25 `targets` with `targetCount`, tested/active compound counts, `lastDataChange`)

---

### `pubchem://compound/{cid}` <sub>resource</sub>

- Core physicochemical properties (the same default 14-property set as `pubchem_get_compound_details`), as `application/json`
- Throws a typed not-found when the CID doesn't exist in PubChem
- Use `pubchem_get_compound_details` to select specific properties or add descriptions, synonyms, drug-likeness, and classification

---

### `pubchem://compound/{cid}/safety` <sub>resource</sub>

- GHS hazard classification as `application/json`, including the per-source `ghs.classifications` and the contributor `source` list
- `status` (`ok`/`not_classified`/`no_ghs_data`/`cid_not_found`) is the only signal distinguishing a bad CID from a compound with no deposited classification — a resource read has no notice surface

---

### `pubchem://compound/{cid}/image` <sub>resource</sub>

- 2D structure diagram, 300x300 PNG, returned as a base64 blob
- Use `pubchem_get_compound_image` for the 100x100 size option

---

### `pubchem://compound/{cid}/xrefs` <sub>resource</sub>

- Focused default set — `RN`, `RegistryID`, `PubMedID`, `CAS` (with `sourceCounts`) — up to 25 IDs per type, as `application/json`; the PubMed IDs are the 25 highest (most recently assigned), highest first. A type that fails to load is named in `failedTypes`
- Use `pubchem_get_compound_xrefs` for the full set of xref types, a higher per-type cap, and offset paging

---

### `pubchem://compound/{cid}/bioactivity` <sub>resource</sub>

- Up to 25 assays as `application/json`, each with its `assayType` and `pmids`, plus `totalAssays`/`activeCount` for the whole compound; a multi-target assay lists its further targets under `otherTargets`
- Use `pubchem_get_bioactivity` to filter by outcome, target, or assay type, raise the cap, or page with offset

---

### `pubchem://assay/{aid}` <sub>resource</sub>

- BioAssay summary as `application/json` — name, description, source, protocol, substance counts
- Throws a typed not-found when the AID doesn't exist

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PubChem-specific:

- Covers PUG REST and PUG View endpoints, plus SDQ for drug-drug interactions
- Rate-limited client (5 req/s) with request queuing and one retry on transient failures
- A 50 s budget per call fails a slow upstream as `Timeout`, and a cancelled call fails with `RequestCancelled`
- Built-in V2000 SDF parser for 3D conformers; drug-likeness computed from already-fetched properties
- All tools are read-only and idempotent, with no API keys required

Agent-friendly output:

- Per-CID `status` and `found` flags let callers branch on data instead of matching error strings
- Batch tools return per-item results alongside `unresolvedIdentifiers`, `skippedCids`, `failedKinds`, and `failedTypes` rather than failing the whole call
- Capped lists disclose `truncated`, `shown`/`cap`, and `nextOffset`; oversized batches are served up to the cap, with `cappedInputs` and `unprocessed` reporting the rest
- Failures carry a typed `reason` (e.g. `cid_not_found`, `missing_identifier_args`, `invalid_cid_query`) with recovery text

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
| `MCP_SESSION_MODE` | `stateless`, `stateful`, or `auto`. | `stateless` |
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
