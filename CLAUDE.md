# Agent Protocol

**Server:** pubchem-mcp-server
**Version:** 0.1.3
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Secrets in env vars only** — never hardcoded.
- **No API keys required** — PubChem's API is freely accessible. No server config schema exists.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';

export const searchAssays = tool('pubchem_search_assays', {
  title: 'Search Assays',
  description:
    'Find PubChem bioassays associated with a biological target. Search by gene symbol ' +
    '(e.g. "EGFR"), protein name, NCBI Gene ID, or UniProt accession.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    targetType: z.enum(['genesymbol', 'proteinname', 'geneid', 'proteinaccession'])
      .describe('Target identifier type.'),
    targetQuery: z.string().describe('Target identifier.'),
    maxResults: z.number().min(1).max(200).default(50)
      .describe('Max AIDs to return (1-200). Default: 50.'),
  }),
  output: z.object({
    targetType: z.string().describe('Target identifier type used.'),
    targetQuery: z.string().describe('Target identifier searched.'),
    totalFound: z.number().describe('Total AIDs found.'),
    aids: z.array(z.number()).describe('PubChem Assay IDs.'),
  }),

  async handler(input, ctx) {
    const client = getPubChemClient();
    const allAids = await client.searchAssaysByTarget(input.targetType, input.targetQuery);
    const aids = allAids.slice(0, input.maxResults);

    ctx.log.info('Assay search completed', {
      targetType: input.targetType,
      totalFound: allAids.length,
      returned: aids.length,
    });

    return { targetType: input.targetType, targetQuery: input.targetQuery, totalFound: allAids.length, aids };
  },

  format(result) {
    return [{ type: 'text', text: `Found ${result.totalFound} assays for "${result.targetQuery}"` }];
  },
});
```

### Service (init/accessor pattern)

```ts
import { PubChemClient } from './pubchem-client.js';

let _client: PubChemClient | undefined;

export function initPubChemClient(): void {
  _client = new PubChemClient();
}

export function getPubChemClient(): PubChemClient {
  if (!_client) throw new Error('PubChemClient not initialized — call initPubChemClient() in setup()');
  return _client;
}
```

---

## Context

Handlers receive a unified `ctx` object. Properties used by this server:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Compound not found', { cid });
throw serviceUnavailable('PubChem API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InternalError, 'Unexpected response', { url });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  services/
    pubchem/
      pubchem-client.ts                 # PubChem API client (rate limiting, retry, parsing)
      types.ts                          # API response types and constants
  mcp-server/
    tools/definitions/
      search-compounds.tool.ts          # Search by name/SMILES/InChIKey/formula/structure/similarity
      get-compound-details.tool.ts      # Properties, descriptions, synonyms
      get-compound-image.tool.ts        # 2D structure diagram (PNG)
      get-compound-safety.tool.ts       # GHS hazard classification
      get-compound-xrefs.tool.ts        # External database cross-references
      get-bioactivity.tool.ts           # Assay results and activity values
      search-assays.tool.ts             # Find assays by biological target
      get-summary.tool.ts               # Entity summaries (assays, genes, proteins, etc.)
      index.ts                          # Barrel export
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-compounds.tool.ts` |
| Tool names | snake_case with `pubchem_` prefix | `pubchem_search_compounds` |
| Directories | kebab-case | `src/services/pubchem/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search compounds by name.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getPubChemClient } from '@/services/pubchem/pubchem-client.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
