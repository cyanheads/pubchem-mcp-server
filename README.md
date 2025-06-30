# PubChem MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.13.2-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-green.svg)](https://github.com/cyanheads/pubchem-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/pubchem-mcp-server?style=social)](https://github.com/cyanheads/pubchem-mcp-server)

**Empower your AI agents and scientific tools with seamless PubChem integration!**

An MCP (Model Context Protocol) server providing comprehensive access to PubChem's vast chemical information database. Enables LLMs and AI agents to search, retrieve, and analyze chemical compounds, substances, and bioassays through the PubChem PUG REST API.

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Core Capabilities: PubChem Tools 🛠️

This server equips your AI with specialized tools to interact with PubChem:

| Tool Name                                                                                   | Description                                                                                                                                                             | Key Features                                                                                             |
| :------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| [`pubchem_search_compound_by_identifier`](./src/mcp-server/tools/searchCompoundByIdentifier/) | Searches for PubChem Compound IDs (CIDs) using a common chemical identifier.                               | - Search by `name`, `smiles`, or `inchikey`.<br/>- The primary entry point for most compound-based workflows. |
| [`pubchem_fetch_compound_properties`](./src/mcp-server/tools/fetchCompoundProperties/)     | Fetches a list of specified physicochemical properties for one or more CIDs.                                | - Retrieve properties like `MolecularWeight`, `XLogP`, `IUPACName`, etc.<br/>- Essential for gathering detailed chemical data in bulk. |
| [`pubchem_get_compound_image`](./src/mcp-server/tools/getCompoundImageUrl/)               | Fetches a 2D image of a compound's structure for a given CID.                                               | - Returns the raw image data as a binary blob.<br/>- Supports `small` (100x100) and `large` (300x300) image sizes. |
| [`pubchem_search_compounds_by_structure`](./src/mcp-server/tools/searchCompoundsByStructure/) | Performs a structural search using a SMILES string or a CID as the query.                                 | - Supports `substructure`, `superstructure`, and `identity` search types.<br/>- Essential for finding structurally related compounds. |
| [`pubchem_search_compounds_by_similarity`](./src/mcp-server/tools/searchCompoundsBySimilarity/) | Finds compounds with a similar 2D structure to a query compound.                                            | - Based on a Tanimoto similarity score.<br/>- Search by `smiles` or `cid`.<br/>- Configurable `threshold` and `maxRecords`. |
| [`pubchem_search_compounds_by_formula`](./src/mcp-server/tools/searchCompoundsByFormula/)     | Finds PubChem Compound IDs (CIDs) that match a given molecular formula.                                     | - Supports exact matches and formulas with additional elements.<br/>- Configurable `maxRecords`. |
| [`pubchem_fetch_substance_details`](./src/mcp-server/tools/fetchSubstanceDetails/)         | Retrieves details for a given PubChem Substance ID (SID).                                                 | - Fetches synonyms, source, dates, and related CIDs.                                                     |
| [`pubchem_fetch_assay_summary`](./src/mcp-server/tools/fetchAssaySummary/)                 | Fetches a detailed summary for a specific PubChem BioAssay ID (AID).                                        | - Includes name, description, source, and statistics.                                                    |
| [`pubchem_search_assays_by_target`](./src/mcp-server/tools/searchAssaysByTarget/)           | Finds PubChem BioAssay IDs (AIDs) associated with a specific biological target.                             | - Search by `genesymbol` or `proteinname`.                                                               |
| [`pubchem_fetch_compound_xrefs`](./src/mcp-server/tools/fetchCompoundXrefs/)               | Fetches external cross-references (XRefs) for a given CID.                                                | - Retrieve `RegistryID`, `PubMedID`, `PatentID`, etc.<br/>- Supports pagination for large result sets.      |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation) |
| [Configuration](#configuration) | [Project Structure](#project-structure) |
| [Tools](#tools) | [Development](#development) | [License](#license) |

## Overview

The PubChem MCP Server acts as a bridge, allowing applications (MCP Clients) that understand the Model Context Protocol (MCP) – like advanced AI assistants (LLMs), IDE extensions, or custom research tools – to interact directly and efficiently with PubChem's vast chemical database.

Instead of complex API integration or manual searches, your tools can leverage this server to:

- **Automate chemical research**: Search for compounds, fetch detailed properties, find similar structures, and analyze bioassay results programmatically.
- **Gain chemical insights**: Access detailed compound data, substance information, and bioassay metadata without leaving the host application.
- **Integrate PubChem into AI-driven science**: Enable LLMs to conduct chemical research, analyze structure-activity relationships, and support evidence-based discovery.

Built on the robust `mcp-ts-template`, this server provides a standardized, secure, and efficient way to expose PubChem functionality via the MCP standard. It achieves this by integrating with the PubChem PUG REST API, ensuring compliance with rate limits and providing comprehensive error handling.

> **Developer Note**: This repository includes a [.clinerules](.clinerules) file that serves as a developer cheat sheet for your LLM coding agent with quick reference for the codebase patterns, file locations, and code snippets.

## Features

### Core Utilities

Leverages the robust utilities provided by the `mcp-ts-template`:

- **Logging**: Structured, configurable logging (file rotation, stdout JSON, MCP notifications) with sensitive data redaction.
- **Error Handling**: Centralized error processing, standardized error types (`McpError`), and automatic logging.
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation.
- **Input Validation/Sanitization**: Uses `zod` for schema validation and custom sanitization logic.
- **Request Context**: Tracking and correlation of operations via unique request IDs using `AsyncLocalStorage`.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport**: High-performance HTTP server using **Hono**, featuring session management with garbage collection and CORS support.
- **Authentication**: Robust authentication layer supporting JWT and OAuth 2.1, with fine-grained scope enforcement.
- **Deployment**: Multi-stage `Dockerfile` for creating small, secure production images with native dependency support.

### PubChem Integration

- **PubChem PUG REST Integration**: Comprehensive access to the PubChem API via a dedicated, rate-limited client.
- **Advanced Search Capabilities**: Search by identifier, structure, similarity, and molecular formula.
- **Full Compound Data**: Retrieve complete compound properties, including physicochemical data, names, and identifiers.
- **Substance and Assay Information**: Fetch detailed records for substances (SIDs) and bioassays (AIDs).
- **Cross-Referencing**: Find links to other databases like PubMed, patent registries, and gene databases.
- **Image Generation**: Directly fetch 2D structural images of compounds.

## Installation

### Prerequisites

- [Node.js (>=20.0.0)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- [Docker](https://www.docker.com/) (optional, for containerized deployment)

### Install via npm (recommended)

```bash
npm install @cyanheads/pubchem-mcp-server
```

### Alternatively Install from Source

1. Clone the repository:

   ```bash
   git clone https://github.com/cyanheads/pubchem-mcp-server.git
   cd pubchem-mcp-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   *or npm run rebuild*
   ```

## Configuration

### Environment Variables

Configure the server using environment variables. These environmental variables are set within your MCP client config/settings (e.g. `cline_mcp_settings.json` for Cline).

| Variable               | Description                                                                              | Default                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `MCP_TRANSPORT_TYPE`   | Transport mechanism: `stdio` or `http`.                                                  | `stdio`                        |
| `MCP_HTTP_PORT`        | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                                 | `3010`                         |
| `MCP_HTTP_HOST`        | Host address for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                         | `127.0.0.1`                    |
| `MCP_ALLOWED_ORIGINS`  | Comma-separated list of allowed origins for CORS (if `MCP_TRANSPORT_TYPE=http`).         | (none)                         |
| `MCP_LOG_LEVEL`        | Logging level (`debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg`). | `info`                        |
| `LOG_OUTPUT_MODE`      | Logging output mode: `file` or `stdout`.                                                 | `file`                         |
| `MCP_AUTH_MODE`        | Authentication mode for HTTP: `jwt` or `oauth`.                                          | `jwt`                          |
| `MCP_AUTH_SECRET_KEY`  | **Required for `jwt` auth.** Minimum 32-character secret key for JWT authentication.     | (none)                         |
| `LOGS_DIR`             | Directory for log file storage (if `LOG_OUTPUT_MODE=file`).                              | `logs/`                        |

**Note**: The PubChem API does not require an API key for basic use, so no key is needed in the environment configuration.

### MCP Client Settings

Add the following to your MCP client's configuration file (e.g., `cline_mcp_settings.json`). This configuration uses `npx` to run the server, which will automatically install the package if not already present:

```json
{
  "mcpServers": {
    "pubchem-mcp-server": {
      "command": "npx",
      "args": ["@cyanheads/pubchem-mcp-server"],
      "env": {},
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Project Structure

The codebase follows a modular structure within the `src/` directory:

```
src/
├── index.ts              # Entry point: Initializes and starts the server
├── config/               # Configuration loading (env vars, package info)
│   └── index.ts
├── mcp-server/           # Core MCP server logic and capability registration
│   ├── server.ts         # Server setup, capability registration
│   ├── transports/       # Transport handling (stdio, http)
│   └── tools/            # MCP Tool implementations (subdirs per tool)
├── services/             # External service integrations
│   └── pubchem/          # PubChem API client
├── types-global/         # Shared TypeScript type definitions
└── utils/                # Common utility functions (logger, error handler, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

## Tools

The PubChem MCP Server provides a comprehensive suite of tools for chemical information retrieval, callable via the Model Context Protocol.

| Tool Name                                  | Description                                                              | Key Arguments                                                              |
| :----------------------------------------- | :----------------------------------------------------------------------- | :------------------------------------------------------------------------- |
| `pubchem_search_compound_by_identifier`    | Searches for CIDs using an identifier (name, SMILES, InChIKey).          | `identifierType`, `identifier`                                             |
| `pubchem_fetch_compound_properties`        | Fetches physicochemical properties for one or more CIDs.                 | `cids`, `properties`                                                       |
| `pubchem_get_compound_image`               | Fetches a 2D structural image for a given CID.                           | `cid`, `size?`                                                             |
| `pubchem_search_compounds_by_structure`    | Performs a structural search (substructure, superstructure, identity).   | `searchType`, `query`, `queryType`, `maxRecords?`                          |
| `pubchem_search_compounds_by_similarity`   | Finds compounds with a similar 2D structure to a query.                  | `query`, `queryType`, `threshold?`, `maxRecords?`                          |
| `pubchem_search_compounds_by_formula`      | Finds CIDs that match a given molecular formula.                         | `formula`, `allowOtherElements?`, `maxRecords?`                            |
| `pubchem_fetch_substance_details`          | Retrieves details for a given Substance ID (SID).                        | `sid`                                                                      |
| `pubchem_fetch_assay_summary`              | Fetches a summary for a specific BioAssay ID (AID).                      | `aid`                                                                      |
| `pubchem_search_assays_by_target`          | Finds BioAssay IDs (AIDs) associated with a biological target.           | `targetType`, `targetQuery`                                                |
| `pubchem_fetch_compound_xrefs`             | Fetches external cross-references for a given CID.                       | `cid`, `xrefTypes`, `page?`, `pageSize?`                                   |

_Note: All tools support comprehensive error handling and return structured JSON responses._

## Development

### Build and Test

```bash
# Build the project (compile TS to JS in dist/ and make executable)
npm run build

# Test the server locally using the MCP inspector tool (stdio transport)
npm run inspector

# Test the server locally using the MCP inspector tool (http transport)
npm run inspector:http

# Clean build artifacts
npm run clean

# Generate a file tree representation for documentation
npm run tree

# Clean build artifacts and then rebuild the project
npm run rebuild

# Format code with Prettier
npm run format

# Start the server using stdio (default)
npm start
# Or explicitly:
npm run start:stdio

# Start the server using HTTP transport
npm run start:http
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>
