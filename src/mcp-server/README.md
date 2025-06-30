# 🧩 Extending the MCP Server

This document provides guidance on adding custom Tools and Resources to the MCP Server. For a broader overview of the entire `src` directory and its architectural principles, please see the [Source Code Overview](../README.md).

The server is designed for extensibility, leveraging the high-level abstractions provided by the Model Context Protocol (MCP) SDK.

---

## 🔐 Authentication

The HTTP transport supports two authentication modes, configurable via the `MCP_AUTH_MODE` environment variable:

- **`jwt` (default):** A simple, self-contained JWT mode for development or internal use. It uses the `MCP_AUTH_SECRET_KEY` to sign and verify tokens.
- **`oauth`:** A production-ready OAuth 2.1 mode where the server acts as a Resource Server. It validates Bearer tokens issued by an external Authorization Server. This mode requires the following environment variables to be set:
  - `OAUTH_ISSUER_URL`: The issuer URL of your authorization server (e.g., `https://your-auth-server.com/`).
  - `OAUTH_AUDIENCE`: The audience identifier for this MCP server.
  - `OAUTH_JWKS_URI` (optional): The JWKS endpoint URL. If not provided, it will be discovered from the issuer URL.

When using `oauth` mode, you can protect tools and resources by checking for specific scopes in the access token. Use the `withRequiredScopes` utility within your tool/resource handlers:

```typescript
import { withRequiredScopes } from "../../transports/auth/index.js";

// Inside a tool handler...
async (params: ToolInput): Promise<CallToolResult> => {
  // This will throw a FORBIDDEN error if the token lacks the 'pubchem:read' scope.
  withRequiredScopes(["pubchem:read"]);

  // ... rest of the tool logic
};
```

---

## Adding Your Own Tools

The core of extending this MCP server involves defining your custom logic and then registering it with the main server instance. This process is streamlined by the MCP SDK's helper functions.

### 🛠️ General Workflow

1.  **Create Directories**:
    Organize your new features by creating dedicated directories for each tool:
    - `src/mcp-server/tools/yourToolName/`

2.  **Implement Logic (`logic.ts`)**:
    Within your new directory, create a `logic.ts` file. This is where you'll define:
    - **Input/Output Schemas**: Use Zod to define clear and validated schemas for the inputs your tool will accept and the outputs it will produce. This is crucial for type safety and for the MCP host to understand how to interact with your tool.
    - **Core Processing Function**: Write the main function that performs the action of your tool. This function will receive validated arguments and should interact with external services (like the PubChem API) via the dedicated API client.

3.  **Register with the Server (`registration.ts`)**:
    Create a `registration.ts` file in your new directory. This file will:
    - Import your logic and schemas.
    - Import the `McpServer` type from the SDK and the `ErrorHandler` utility.
    - Use `server.tool(name, description, zodSchemaShape, async handler => { ... })` to register your tool.
        - `name`: A unique identifier for your tool (e.g., `pubchem_search_compound_by_identifier`).
        - `description`: A clear, concise explanation of what the tool does. This is shown to the MCP host/LLM.
        - `zodSchemaShape`: The Zod schema object defining the expected input arguments.
        - `handler`: An asynchronous function that contains your tool's core logic. It **MUST** return a `CallToolResult` object: `{ content: [...], isError: boolean }`.
    - **Error Handling**: Wrap your handler logic in `ErrorHandler.tryCatch(...)` to ensure robust error management and consistent logging.

4.  **Export & Integrate (`index.ts` and `server.ts`)**:
    - Create an `index.ts` file in your new directory that exports your registration function.
    - Import and call your registration function within the `createMcpServerInstance` function in `src/mcp-server/server.ts`. This makes your new tool part of the server when it initializes.

### ✨ Example Reference

- **PubChem Tools**: See any of the directories under `src/mcp-server/tools/` for a complete example of the required structure and patterns. The `pubchem_search_compound_by_identifier` tool is a good starting point.

### 🚀 Server Initialization and Transports

The main server logic in `src/mcp-server/server.ts` orchestrates the creation of the `McpServer` instance. This instance is then connected to a transport layer, which is determined by the application's configuration.

- **Stdio Transport (`src/mcp-server/transports/stdioTransport.ts`)**: This module provides a straightforward wrapper for the SDK's `StdioServerTransport`. It's used for direct communication when the server is launched as a child process by a host application.

- **Streamable HTTP Transport (`src/mcp-server/transports/httpTransport.ts`)**: This module integrates the SDK's `StreamableHTTPServerTransport` with a **Hono** web server. It is responsible for setting up the HTTP interface, including routing and middleware for CORS, rate limiting, and authentication.

When you register your tools in `createMcpServerInstance`, they become available regardless of the chosen transport, as the core `McpServer` instance is transport-agnostic.

### 💡 Best Practices

- **Clear Schemas**: Define precise Zod schemas for your tool inputs. This is key for reliable interaction with the MCP host and LLM.
- **Descriptive Naming**: Use clear names and descriptions for your tools.
- **Idempotency**: Design tools to be idempotent where possible.
- **Comprehensive Error Handling**: Utilize the `ErrorHandler` to catch and log errors effectively, providing useful feedback to the client.
- **Security**: Sanitize any inputs, especially if they are used in file paths, database queries, or external API calls. Refer to `src/utils/security/sanitization.ts`.
- **Contextual Logging**: Use the `logger` utility with appropriate `RequestContext` to provide traceable logs.

### 🔌 Integrating External Services

This server uses a dedicated singleton client to interact with the PubChem API.

**Key Principles:**

1.  **Encapsulation**: The `PubChemApiClient` (`src/services/pubchem/pubchemApiClient.ts`) encapsulates all logic for interacting with the PubChem PUG REST API.
2.  **Singleton Pattern**: The client is a singleton, ensuring a single, rate-limited connection is shared across the application.
3.  **Clear Error Handling**: The client implements the "Logic Throws, Handlers Catch" pattern internally.

When building a new Tool that needs to interact with the PubChem API, you should import the `pubChemApiClient` singleton instance and call its methods from within your tool's `logic.ts` file.

---

By following these patterns, you can effectively extend the MCP server with new capabilities while maintaining a robust and well-structured codebase. For more detailed patterns and advanced examples, refer to the [.clinerules](../../../.clinerules) developer guide.
