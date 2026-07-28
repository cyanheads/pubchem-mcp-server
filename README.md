<div align="center">
  <h1>@cyanheads/pubchem-mcp-server</h1>
  <p><b>Search the PubChem chemical database for compounds, properties, safety data, bioactivity, cross-references, and entity summaries via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 6 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pubchem-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pubchem-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubchem-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.3.0-f472b6.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pubchem-mcp-server/releases/latest/download/pubchem-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pubchem-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcHViY2hlbS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pubchem-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/pubchem-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://pubchem.caseyjhand.com/mcp](https://pubchem.caseyjhand.com/mcp)

</div>

---

## Tools

Ten tools for querying PubChem's chemical information database:

| Tool Name | Description |
|:----------|:------------|
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

### `pubchem_search_compounds`

Search PubChem for chemical compounds across five search modes.

- **Identifier lookup** — resolve compound names, SMILES, or InChIKeys to CIDs (batch up to 25)
- **Formula search** — find compounds by molecular formula in Hill notation
- **Substructure/superstructure** — find compounds containing or contained within a query structure
- **2D similarity** — find structurally similar compounds by Tanimoto similarity (configurable threshold)
- Caps at 200 CIDs per page; `offset` pages further, to a ceiling of 10,000. Identifier lookups page over the set already resolved; formula and structure searches widen their bounded upstream request to reach a page, so deep pages cost more upstream
- Optionally hydrate results with properties to avoid a follow-up details call

---

### `pubchem_get_compound_details`

Get detailed compound information by CID.

- Batches up to 100 CIDs in a single request
- 27 available properties: molecular weight, SMILES, InChIKey, XLogP, TPSA, complexity, stereo counts, and more
- Optionally includes textual descriptions (pharmacology, mechanism, therapeutic use) from PUG View — fetched for the first 10 CIDs of a batch, with the skipped CIDs named in the response
- Optionally includes known synonyms (trade names, systematic names, registry numbers)
- Synonyms and descriptions are paged: `synonymOffset` and `descriptionOffset` window every compound in the batch at the same position, reaching the entries past a page
- Optionally computes drug-likeness assessment (Lipinski Rule of Five + Veber rules) from fetched properties
- Optionally fetches pharmacological classification (FDA classes, mechanisms of action, MeSH classes, ATC codes)

---

### `pubchem_get_bioactivity`

Get a compound's bioactivity profile from PubChem BioAssay.

- Returns assay outcomes (Active/Inactive/Inconclusive), target info (protein accessions, NCBI Gene IDs), and quantitative values (IC50, EC50, Ki)
- Filter by outcome and/or a specific molecular target (NCBI Gene ID or protein accession)
- Caps at 100 results per page; `offset` reaches the rest (well-studied compounds may have thousands)

---

### `pubchem_get_summary`

Get descriptive summaries for four PubChem entity types.

- Assays (AID), genes (Gene ID), proteins (UniProt accession), taxonomy (Tax ID)
- Up to 10 entities per call
- Type-specific field extraction for clean, structured output

---

### `pubchem_get_compound_interactions`

Get a compound's interaction data by CID.

- Drug-drug interactions (DrugBank), drug-food interactions, and chemical-target binding/activity (BindingDB, ChEMBL, and others)
- Select which interaction kinds to fetch and cap entries per kind
- Paged per kind: each reports its source-record total and its own `nextOffset`, and `offset` reaches the records past a page
- Each entry carries its originating source — coverage is richest for approved drugs

---

### `pubchem_get_compound_3d_structure`

Get a compound's default 3D conformer by CID.

- `format="json"` returns parsed atoms (element + x/y/z) and bonds for direct reasoning; `format="sdf"` returns raw V2000 SDF for passthrough to docking or rendering
- `maxAtoms`/`maxBonds` bound the atom/bond preview and `includeRawSdf` opts into a large raw SDF past the safe line cap; `atomCount`/`bondCount` always report the totals and any capping is disclosed
- Optionally lists alternate conformer IDs
- Returns a typed not-found when PubChem has no computed 3D coordinates (large molecules, mixtures, some salts)

## Resources

Compound and assay records are also exposed as URI-templated MCP resources, backed by the same client methods as the tools:

| URI Template | Returns |
|:-------------|:--------|
| `pubchem://compound/{cid}` | Core physicochemical properties (JSON). |
| `pubchem://compound/{cid}/safety` | GHS hazard classification (JSON). |
| `pubchem://compound/{cid}/image` | 2D structure diagram (PNG). |
| `pubchem://compound/{cid}/xrefs` | External cross-references (JSON). |
| `pubchem://compound/{cid}/bioactivity` | Bioassay activity profile (JSON). |
| `pubchem://assay/{aid}` | BioAssay summary (JSON). |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or containerized via Docker

PubChem-specific:

- Rate-limited client for PUG REST and PUG View APIs (5 req/s with automatic queuing)
- Retry with exponential backoff on 5xx errors and network failures
- All tools are read-only and idempotent — no API keys required

## Getting Started

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

Add to your MCP client config (e.g., `claude_desktop_config.json`):

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

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+)

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/pubchem-mcp-server.git
```

1. **Navigate into the directory:**

```sh
cd pubchem-mcp-server
```

1. **Install dependencies:**

```sh
bun install
```

## Configuration

No API keys are required — PubChem's API is freely accessible.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Host for HTTP server. | `localhost` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

## Running the Server

### Local Development

- **Build and run:**

  ```sh
  bun run rebuild
  bun run start:stdio   # or start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t pubchem-mcp-server .
docker run -p 3010:3010 pubchem-mcp-server
```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/pubchem/` | PubChem API client with rate limiting and response parsing. |
| `scripts/` | Build, clean, devcheck, and tree generation scripts. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging
- Register new tools in the `index.ts` barrel file

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
