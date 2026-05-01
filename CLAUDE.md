# Agent Protocol

**Server:** pubchem-mcp-server
**Version:** 0.1.16
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

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format(result) {
    const truncated =
      result.totalFound > result.aids.length
        ? ` (showing ${result.aids.length} of ${result.totalFound})`
        : '';
    const lines = [
      `Found ${result.totalFound} assay${result.totalFound !== 1 ? 's' : ''} for "${result.targetQuery}" (${result.targetType})${truncated}`,
      '',
    ];
    if (result.aids.length > 0) {
      lines.push(`AIDs: ${result.aids.join(', ')}`);
    } else {
      lines.push('No assays found.');
    }
    return [{ type: 'text', text: lines.join('\\n') }];
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

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated). Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text). Override with explicit `{ recovery: { hint: '...' } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely without declaration.

```ts
errors: [
  { reason: 'cid_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'PubChem returned 404 for the requested CID',
    recovery: 'Verify the CID via pubchem_search_compounds before retrying.' },
],
async handler(input, ctx) {
  // Static recovery — pulled from the contract via ctx.recoveryFor.
  if (!exists) throw ctx.fail('cid_not_found', `CID ${input.cid} not found`,
    { ...ctx.recoveryFor('cid_not_found') });
}
```

**Fallback for ad-hoc throws** (no contract entry fits, service-layer code):

```ts
// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// Error factories — explicit code, concise
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Compound not found', { cid });
throw serviceUnavailable('PubChem API unavailable', { url }, { cause: err });

// McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InternalError, 'Unexpected response', { url });
```

See framework CLAUDE.md for the full auto-classification table and all available factories.

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

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `release-and-publish` | Post-wrapup ship workflow: verification gate, push, publish to npm/MCP Registry/GHCR |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition lint rules — look here when devcheck reports a `format-parity`, `describe-on-fields`, `schema-*`, `name-*`, etc. diagnostic |
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
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

For smoke-testing during development, use `bun run rebuild && bun run start:stdio` (or `start:http`) — same execution surface as production.

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

## Publishing

Run the `release-and-publish` skill — it runs the verification gate (`devcheck`, `rebuild`, `test`), pushes commits and tags, and publishes to every applicable destination. Full reference:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/pubchem-mcp-server:<version> \
  -t ghcr.io/cyanheads/pubchem-mcp-server:latest \
  --push .

mcp-publisher publish
```

---

## Checklist

- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data. Enforced by the `format-parity` linter
- [ ] Zod schemas: all fields have `.describe()`
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
