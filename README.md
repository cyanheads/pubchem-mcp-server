# 🧪 PubChem MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol SDK](https://img.shields.io/badge/MCP%20SDK-^1.13.0-green.svg)](https://github.com/modelcontextprotocol/typescript-sdk)
[![MCP Spec Version](https://img.shields.io/badge/MCP%20Spec-2025--03--26-lightgrey.svg)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/changelog.mdx)
[![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-green.svg)](https://github.com/cyanheads/pubchem-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/pubchem-mcp-server?style=social)](https://github.com/cyanheads/pubchem-mcp-server)

**A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server providing a comprehensive, robust, and AI-agent-friendly interface to the PubChem PUG REST API.**

This server enables autonomous agents to systematically search, fetch, and analyze chemical, substance, and bioassay data from PubChem. It is built using the `mcp-ts-template` and adheres to the architectural patterns and best practices for creating powerful, composable tools for complex scientific workflows.

## ✨ Key Features

- **Comprehensive Tool Suite**: A rich set of tools for interacting with PubChem's `Compound`, `Substance`, and `Assay` domains.
- **Agent-Centric Design**: Tools named with a `verb_domain_noun` convention for intuitive discovery and use by LLM agents.
- **Robust & Compliant**: Built-in rate limiting to respect PubChem's API usage policies (5 requests/second).
- **Type-Safe**: Strictly typed inputs and outputs using Zod for predictable and reliable agent interactions.
- **Extensible**: Modular architecture that makes it easy to add new tools and capabilities.
- **Production Ready**: Leverages the `mcp-ts-template` for production-grade logging, error handling, and security.

## 🚀 Quick Start

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/cyanheads/pubchem-mcp-server.git
cd pubchem-mcp-server
npm install
```

### 2. Build the Project

```bash
npm run build
# Or use 'npm run rebuild' for a clean install
```

### 3. Running the Server

You can run the MCP server to make its tools available to any connected MCP agent or client.

- **Via Stdio (for local development):**
  ```bash
  npm run start:stdio
  ```
- **Via HTTP:**
  ```bash
  npm run start:http
  ```

## ⚙️ Configuration

The server is configured via environment variables. See `.env.example` for a full list of available options. No API key is required for the PubChem API.

| Variable             | Description                                                     | Default |
| :------------------- | :-------------------------------------------------------------- | :------ |
| `MCP_TRANSPORT_TYPE` | Server transport: `stdio` or `http`.                            | `stdio` |
| `MCP_HTTP_PORT`      | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).        | `3010`  |
| `MCP_LOG_LEVEL`      | Minimum logging level (e.g., `debug`, `info`, `warn`, `error`). | `info`  |

## 🛠️ Tool Suite

This server provides a comprehensive suite of tools for interacting with PubChem. For a detailed specification of all tools and their schemas, see the [Project Specification](docs/project-spec.md).

### Example: Inter-Server Workflow

A key feature of the MCP ecosystem is the ability for agents to chain commands across different servers. An agent could use this server to find a `PubMedID` related to a compound and then use that ID with the `pubmed-mcp-server` to fetch the associated publication.

1.  **Agent to `pubchem-mcp-server`**:
    ```json
    {
      "tool": "fetch_compound_xrefs",
      "params": {
        "cid": 2244,
        "xrefTypes": ["PubMedID"]
      }
    }
    ```
2.  **Agent to `pubmed-mcp-server`**:
    ```json
    {
      "tool": "fetch_pubmed_content",
      "params": {
        "pmids": ["15289509", "17251299"]
      }
    }
    ```

## 📜 License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
