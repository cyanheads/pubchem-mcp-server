<div align="center">
  <h1>@cyanheads/pubchem-mcp-server</h1>
  <p><b>MCP server for the PubChem chemical database. Search compounds, fetch properties, safety data, bioactivity, cross-references, and entity summaries. STDIO & Streamable HTTP</b></p>
  <p><b>8 Tools</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-^1.2.0-f472b6.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Eight tools for querying PubChem's chemical information database:

| Tool Name | Description |
|:----------|:------------|
| `pubchem_search_compounds` | Search for compounds by name, SMILES, InChIKey, formula, substructure, superstructure, or 2D similarity. |
| `pubchem_get_compound_details` | Get physicochemical properties, descriptions, synonyms, drug-likeness, and classification for compounds by CID. |
| `pubchem_get_compound_image` | Fetch a 2D structure diagram (PNG) for a compound by CID. |
| `pubchem_get_compound_safety` | Get GHS hazard classification and safety data for a compound. |
| `pubchem_get_compound_xrefs` | Get external database cross-references (PubMed, patents, genes, proteins, etc.). |
| `pubchem_get_bioactivity` | Get a compound's bioactivity profile: assay results, targets, and activity values. |
| `pubchem_search_assays` | Find bioassays by biological target (gene symbol, protein, Gene ID, UniProt accession). |
| `pubchem_get_summary` | Get summaries for PubChem entities: assays, genes, proteins, taxonomy. |

### `pubchem_search_compounds`

Search PubChem for chemical compounds across five search modes.

- **Identifier lookup** — resolve compound names, SMILES, or InChIKeys to CIDs (batch up to 25)
- **Formula search** — find compounds by molecular formula in Hill notation
- **Substructure/superstructure** — find compounds containing or contained within a query structure
- **2D similarity** — find structurally similar compounds by Tanimoto similarity (configurable threshold)
- Optionally hydrate results with properties to avoid a follow-up details call

---

### `pubchem_get_compound_details`

Get detailed compound information by CID.

- Batches up to 100 CIDs in a single request
- 27 available properties: molecular weight, SMILES, InChIKey, XLogP, TPSA, complexity, stereo counts, and more
- Optionally includes textual descriptions (pharmacology, mechanism, therapeutic use) from PUG View
- Optionally includes all known synonyms (trade names, systematic names, registry numbers)
- Optionally computes drug-likeness assessment (Lipinski Rule of Five + Veber rules) from fetched properties
- Optionally fetches pharmacological classification (FDA classes, mechanisms of action, MeSH classes, ATC codes)

---

### `pubchem_get_bioactivity`

Get a compound's bioactivity profile from PubChem BioAssay.

- Returns assay outcomes (Active/Inactive/Inconclusive), target info (protein accessions, NCBI Gene IDs), and quantitative values (IC50, EC50, Ki)
- Filter by outcome to focus on active results
- Caps at 100 results per request (well-studied compounds may have thousands)

---

### `pubchem_get_summary`

Get descriptive summaries for four PubChem entity types.

- Assays (AID), genes (Gene ID), proteins (UniProt accession), taxonomy (Tax ID)
- Up to 10 entities per call
- Type-specific field extraction for clean, structured output

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

### MCP Client Configuration

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pubchem": {
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

- [Bun v1.2.0](https://bun.sh/) or higher (or Node.js v22+)

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

- **Build and run the production version:**

  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run in dev mode (auto-reload):**

  ```sh
  bun run dev:stdio    # or dev:http
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
