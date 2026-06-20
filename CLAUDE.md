# Agent Protocol

**Server:** pubchem-mcp-server
**Version:** 0.2.4
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) ^0.10.9

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **No API keys required** — PubChem's API is freely accessible. No server config schema exists.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

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
    aids: z.array(z.number()).describe('PubChem Assay IDs.'),
  }),
  // Agent-facing context — echoed target, total before cap, and empty-result notice.
  // Reaches structuredContent and content[] automatically; keys disjoint from output.
  enrichment: {
    targetType: z.string().describe('Target identifier type used.'),
    targetQuery: z.string().describe('Target identifier searched.'),
    totalFound: z.number().describe('Total AIDs found before the maxResults cap.'),
    notice: z.string().optional().describe('Recovery guidance when no assays matched.'),
  },

  async handler(input, ctx) {
    const client = getPubChemClient();
    const allAids = await client.searchAssaysByTarget(input.targetType, input.targetQuery);
    const aids = allAids.slice(0, input.maxResults);

    ctx.log.info('Assay search completed', {
      targetType: input.targetType,
      totalFound: allAids.length,
      returned: aids.length,
    });

    ctx.enrich({ targetType: input.targetType, targetQuery: input.targetQuery, totalFound: allAids.length });
    if (aids.length === 0) {
      ctx.enrich.notice(`No assays found for "${input.targetQuery}" (${input.targetType}). Try a different targetType or verify the identifier.`);
    }

    return { aids };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format(result) {
    if (result.aids.length > 0) {
      return [{ type: 'text', text: `AIDs: ${result.aids.join(', ')}` }];
    }
    return [{ type: 'text', text: 'No assays found.' }];
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
| `ctx.enrich` | Accumulates success-path agent-facing context (notices, query echo, totals) onto `structuredContent` and `content[]`. Always present. Kind-tagged helpers: `.notice()`, `.total()`, `.echo()`, `.delta()`. |

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

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

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
| `tool-defs-analysis` | Audit LLM-facing language across every tool/resource/prompt: voice, internal leaks, defaults, recovery hints, output descriptions, sparsity, examples, structure, mutator observability, unit-bearing numeric names (12 categories) |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Post-wrapup ship workflow: verification gate, push, publish to npm/MCP Registry/GHCR |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `techniques` | Catalog of reusable response/data-shaping patterns — overflow handling (`outlineOnOverflow`), payload shaping, retrieval. Reach for a proven pattern instead of inventing one |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition lint rules — look here when devcheck reports a `format-parity`, `describe-on-fields`, `schema-*`, `name-*`, etc. diagnostic |
| `api-services` | LLM, Speech, Graph services |
| `api-mirror` | MirrorService: persistent SQLite-backed local mirror of a bulk upstream dataset — Tier 3 opt-in |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run list-skills` | Print skill index from project `skills/` |
| `bun run format` | Auto-fix formatting (safe autofixes only) |
| `bun run format:unsafe` | Auto-fix formatting including unsafe rules (biome `--unsafe`) |
| `bun run lint:packaging` | Validate `manifest.json` / `server.json` env-var alignment |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run release:github` | Create GitHub Release from annotated tag (enforces `v<VERSION>: <subject>` title) |
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

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. `manifest.json` and `.mcpbignore` are required; `lint:packaging` (run by `devcheck`) validates env-var alignment between `manifest.json` `mcp_config.env`/`user_config` and `server.json` `environmentVariables[]`.

**Adding an env var requires both files:** `server.json` (registry discovery) and `manifest.json` (bundle install UX). `lint:packaging` enforces that the names match.

---

## Changelog

Directory-based, grouped by minor series. Source of truth: `changelog/<major.minor>.x/<version>.md` — one file per release. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `CHANGELOG.md` is a navigation index regenerated by `changelog:build` — devcheck hard-fails on drift; never hand-edit it.

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
- [ ] Agent-facing context (empty-result notices, query/filter echo, pagination totals) declared in an `enrichment` block and populated via `ctx.enrich(...)` — reaches both surfaces automatically. Enrichment keys must be disjoint from `output` keys (`enrichment-output-collision` lint rule)
- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
