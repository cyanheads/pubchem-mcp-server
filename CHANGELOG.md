# Changelog

## [0.1.19] — 2026-05-16

### Changed

- **Dependencies** — bumped `@cyanheads/mcp-ts-core` `^0.8.15 → ^0.9.1` (spans the 0.9.0 cross-vendor portability/Workers release and the 0.9.1 follow-up):
  - 0.9.0 — Workers boot under `nodejs_compat` (HTTP transport split, runtime detection switched to `navigator.userAgent`), spec `instructions` field on `createApp` / `createWorkerHandler`, new portability lint family (`schema-format-portability` default-on error, `schema-anyof-needs-type`, `schema-no-discriminator-keyword`, `schema-no-defs`, `schema-dialect-tag`), definition linting moved to build-time only (`createApp()` no longer runs `validateDefinitions` at startup), SSRF DNS validation now enforced in Workers, IPv6 SSRF blocklist broadened, `mcp.rate_limit.rejections_total` cardinality bounded
  - 0.9.1 — `tasks` capability advertisement gated on actual task-tool registration (fixes strict-parsing clients pinned to MCP `2025-06-18`), new `Context.notifyPromptListChanged` / `notifyToolListChanged` notifiers, OTel `deployment.environment.name` uses the stable `ATTR_DEPLOYMENT_ENVIRONMENT_NAME` constant (semconv `^1.40 → ^1.41`), `fast-xml-parser` pinned to `5.7.3`, OTel exporter/SDK refresh, `bun outdated` parser fix in `devcheck.ts`
- **Engine bumps** — `node >=22.0.0 → >=24.0.0`, `bun >=1.2.0 → >=1.3.0` (matches framework requirement)
- **Dev dependencies** — `@biomejs/biome` `^2.4.14 → ^2.4.15`, `@types/node` `^25.6.0 → ^25.8.0`, `vitest` `^4.1.5 → ^4.1.6`
- **`Dockerfile` base images** — `oven/bun:1 → oven/bun:1.3` (build + production stages) to align with the new engine floor

### Added

- **`createApp()` `instructions`** — wired the new spec field with a short orientation block that points the model at `pubchem_search_compounds` for identifier resolution, the per-CID detail/safety/image/xrefs/bioactivity tools, the `search_assays → get_bioactivity` chain for target-driven flows, and `pubchem_get_summary` for assay/gene/protein/taxonomy lookups. Spec-compliant clients forward it to the model on every `initialize` instead of duplicating it across tool descriptions
- **`api-telemetry` skill** — added from `@cyanheads/mcp-ts-core@0.9.0` (OTel catalog: span names, metric names + attributes, completion log fields, env config, runtime support, cardinality rules)

### Refactored

- **`pubchem-client.ts` HTTP error classification** — replaced the custom `PubChemNotFoundError` class with `McpError` thrown from `httpStatusToErrorCode(response.status)`. `fetchJson` and `fetchBinary` now build `new McpError(code, message, { url, status })` directly; per-call sites switched from `instanceof PubChemNotFoundError` to a shared `isNotFound(error)` predicate that checks `error.code === JsonRpcErrorCode.NotFound`. Carries the upstream status/URL into `data` for observability and inherits the framework's classification table instead of maintaining a parallel one
- **`PubChemNotFoundError` class removed** from `services/pubchem/types.ts` — superseded by the `McpError`-based predicate above

### Fixed

- **`pubchem_get_summary` HTTP 400 → null fallback** — the legacy `/PubChem HTTP 400/.test(error.message)` regex was dead after the `McpError` migration (error messages no longer carry the `PubChem HTTP N` prefix). Replaced with `error instanceof McpError && error.data?.status === 400` so PubChem's 400-on-nonexistent-entity-ID behavior continues to map to `null` instead of bubbling as an error to the caller

### Skills

- **Skills synced** from `@cyanheads/mcp-ts-core@0.9.1` — added `api-telemetry`; refreshed `api-auth`, `api-config`, `api-context`, `api-errors`, `api-linter`, `api-utils`, `api-workers`, `add-tool`, `design-mcp-server`, `field-test`, `maintenance`, `polish-docs-meta`, `report-issue-framework`, `report-issue-local`, `security-pass`, `setup`, `tool-defs-analysis`
- **Framework scripts synced** — `scripts/build-changelog.ts` (`SUMMARY_MAX_LENGTH` 250 → 350 cap), `scripts/devcheck.ts` (`bun outdated` parser fix)
- **`CLAUDE.md`** — `tool-defs-analysis` row expanded to call out the two new audit categories (mutator observability, unit-bearing numeric names; 12 categories total); added `api-telemetry` row; `api-utils` row notes the telemetry helpers

## [0.1.18] — 2026-05-05

### Changed

- **Dependencies** — bumped `@cyanheads/mcp-ts-core` from `^0.8.8` to `^0.8.15` (7 upstream releases)
- **Tool descriptions consolidated to single strings** across all 8 tools — removed `+` concatenation in `description` and `.describe()` fields per upstream `name-format`/style guidance. No semantic change to the LLM-facing copy beyond the rewrites called out below
- **`pubchem_search_compounds` error codes corrected** — `missing_identifier_args`, `missing_formula`, `missing_structure_args` migrated from `JsonRpcErrorCode.InvalidParams` to `JsonRpcErrorCode.ValidationError`. `InvalidParams` is reserved for malformed JSON-RPC; semantic input failures belong to `ValidationError`. Tests updated to match
- **Tool descriptions sharpened** with cross-reference hints and tighter type guidance:
  - `pubchem_get_bioactivity`, `pubchem_get_compound_image`, `pubchem_get_compound_safety`, `pubchem_get_compound_xrefs`, `pubchem_get_compound_details` — `cid` field now points the LLM at `pubchem_search_compounds` for resolution from name/SMILES
  - `pubchem_search_compounds.identifiers` — added InChIKey example (`["BSYNRYMUTXBXSQ-UHFFFAOYSA-N"]`) with the 27-char block-format note
  - `pubchem_search_compounds.query` — concrete SMILES + CID-as-string examples
  - `pubchem_get_compound_details.includeDescription` and `includeClassification` — call out the 10-CID upstream limit ("Fetched only for the first 10 CIDs in the batch; remaining CIDs return without descriptions/classification")
  - `pubchem_get_compound_details.includeSynonyms` — note that synonyms are one-API-call-per-CID (slower than the property batch)
  - `pubchem_get_compound_details` drug-likeness rules — added units (`MW ≤ 500 g/mol`, `TPSA ≤ 140 Å²`)
  - `pubchem_get_compound_xrefs.xrefTypes` — split string-ID types (RegistryID, RN, PatentID) from numeric-ID types (PubMedID, GeneID, ProteinGI, TaxonomyID); spelled out RegistryID provenance
  - `searchType` / `targetType` output fields on `pubchem_search_compounds` and `pubchem_search_assays` now enumerate allowed values in their descriptions (closes a `describe-on-fields` blind spot)
  - `pubchem_get_compound_image.mimeType` — narrowed to `'MIME type — always "image/png".'`
  - `pubchem_get_summary` `@fileoverview` — corrected to assays/genes/proteins/taxonomy (the actually-supported entity types)

### Refactored

- **`pubchem-client.ts` — generic `dedupByKey()` helper** replaces four hand-rolled dedup loops (description text, hazard statement codes, precautionary statement codes, ATC codes). Identical behavior, ~20 fewer lines
- **`pubchem-client.ts.getProperties()` — collapsed to a ternary** on `cids.length > 50` for the GET-vs-POST branch; removes the intermediate `let rows` and the duplicate `data.PropertyTable.Properties` assignment
- **Property destructuring via spread** in `search-compounds` and `get-compound-details` — `const { CID: _CID, ...props } = rawProps` replaces `const props = { ...rawProps }; delete (props as Record<string, unknown>).CID`

### Skills

- **Skills synced** from `@cyanheads/mcp-ts-core@0.8.15` — added `tool-defs-analysis` (1.0, audit) and `api-canvas` (1.2, DataCanvas Tier 3 reference). Version bumps: `add-tool` (2.4 → 2.8), `api-config` (1.2 → 1.3), `api-errors` (1.4 → 1.5), `api-workers` (1.1 → 1.3), `design-mcp-server` (2.8 → 2.10), `report-issue-framework` (1.4 → 1.5), `report-issue-local` (1.3 → 1.4), `security-pass` (1.2 → 1.3)
- **`CLAUDE.md` skills table** — added rows for `tool-defs-analysis` and `api-canvas`

## [0.1.17] — 2026-05-01

### Changed

- **Dependencies** — bumped `@cyanheads/mcp-ts-core` from `^0.7.0` to `^0.8.8` (spans 15 upstream releases; notable: typed error contracts via `errors: [{ reason, code, when, recovery, retryable? }]` declarations on `tool()`/`resource()` with typed `ctx.fail(reason, ...)` keyed by the declared reason union, `ctx.recoveryFor(reason)` opt-in resolver, lint-validated `recovery` field (≥5 words), tool errors now surfaced on `structuredContent.error` instead of `_meta.error`, HTTP Origin guard fail-closed when `MCP_HTTP_ALLOWED_ORIGINS` is unset, `httpErrorFromResponse` helper, `dev:*` watch scripts removed in favor of `rebuild && start:*`); `@biomejs/biome` `^2.4.13` → `^2.4.14`; `tsc-alias` `^1.8.16` → `^1.8.17`
- **`pubchem_search_compounds` adopted typed error contract** — declared three `errors` entries (`missing_identifier_args`, `missing_formula`, `missing_structure_args`, all `JsonRpcErrorCode.InvalidParams`) with `when` and `recovery` metadata. Replaced three ad-hoc `throw new Error(...)` sites with `ctx.fail(reason, undefined, { ...ctx.recoveryFor(reason) })`; reason is auto-populated on `data.reason` for observability and the recovery hint is mirrored into `content[]` text. Tests updated to use `createMockContext({ errors: searchCompounds.errors })` and assert on `code` + `data.reason` instead of regex-matching error messages
- **`src/index.ts` landing config** — added `landing` block to `createApp()` (tagline, `repoRoot`, three documentation links: PubChem, PUG REST docs, PUG View docs) so the hosted instance at <https://pubchem.caseyjhand.com/mcp> renders the same landing card as sibling servers in the cyanheads MCP suite. `envExample` deliberately omitted — PubChem requires no API keys
- **`package.json` scripts** — removed `dev:stdio` and `dev:http` (per upstream 0.8.6/0.8.7 cleanup of `bun --watch` scripts that masked rebuild-time bugs). Smoke-testing now uses `bun run rebuild && bun run start:stdio` — same execution surface as production
- **`CLAUDE.md`** — Errors section rewritten to lead with typed error contracts (declarative `errors: [...]`, `ctx.fail`, `ctx.recoveryFor`) and demote plain `Error` / factories / `McpError` to a "fallback for ad-hoc throws" section; Commands table trimmed of removed `dev:*` rows with a smoke-test note added; Version bumped
- **Skills synced** from `@cyanheads/mcp-ts-core@0.8.8` — version bumps: `add-tool` (1.8 → 2.4), `maintenance` (1.5 → 2.0), `field-test` (2.0 → 2.3), `api-errors` (1.0 → 1.4), `add-service` (1.3 → 1.5), `setup` (1.5 → 1.6), `report-issue-framework` (1.3 → 1.4), `release-and-publish` (2.1 → 2.2), `security-pass` (1.1 → 1.2), `api-context` (1.1 → 1.2), `api-linter` (1.1 → 1.2), `design-mcp-server` (2.7 → 2.8). Content-drift refresh (no version metadata bump): `add-app-tool`, `add-resource`, `add-test`, `api-auth`, `api-testing`, `api-utils`, `polish-docs-meta`, `report-issue-local`. `.claude/skills/` agent mirror refreshed
- **Framework scripts synced** (Phase C from `maintenance` v2.0) — added `check-framework-antipatterns.ts` (guards SDK-coupling antipatterns) and `split-changelog.ts`; updated `devcheck.ts`

## [0.1.16] — 2026-04-24

### Changed

- **Dependencies** — bumped `@cyanheads/mcp-ts-core` from `^0.5.3` to `^0.7.0` (spans 19 upstream releases; notable: landing page + SEP-1649 Server Card auto-served in HTTP mode, directory-based changelog system, `MCP_PUBLIC_URL` override for TLS-terminating proxies, `HtmlExtractor` utility, `describe-on-fields` linter now recurses into nested object shapes / array element types / union variants, resource output schemas also validated, flat ZodError messages with structured `issues` on `error.data`, retry-with-backoff in `release-and-publish`, per-server notifier race fix in HTTP transport); `@biomejs/biome` `^2.4.12` → `^2.4.13`; `vitest` `^4.1.4` → `^4.1.5`
- **`CLAUDE.md`** — skills table expanded with `security-pass`, `release-and-publish`, `api-linter`, `add-app-tool`, `field-test`, `report-issue-framework`, and `report-issue-local`; Publishing section now delegates to the `release-and-publish` skill; Phase B (agent mirror sync) referenced in the skills directory note
- **Skills synced** from `@cyanheads/mcp-ts-core@0.7.0` — added `api-linter` (1.1), `release-and-publish` (2.1), `security-pass` (1.1); updated 15 existing skills: `add-app-tool` (1.2 → 1.3), `add-prompt` (1.1 → 1.2), `add-resource` (1.2 → 1.3), `add-service` (1.2 → 1.3), `add-tool` (1.6 → 1.8), `api-context` (1.0 → 1.1), `api-services` (1.2 → 1.3), `api-utils` (2.0 → 2.1), `design-mcp-server` (2.4 → 2.7), `field-test` (1.2 → 2.0), `maintenance` (1.3 → 1.5), `polish-docs-meta` (1.4 → 1.7), `report-issue-framework` (1.1 → 1.3), `report-issue-local` (1.1 → 1.3), `setup` (1.3 → 1.5); `.claude/skills/` agent mirror refreshed
- **Framework scripts synced** (Phase C from `maintenance` v1.5) — added `build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts`; updated `devcheck.ts` (new `Docs Sync`, `Skills Sync`, `Changelog Sync` steps) and `tree.ts`
- **`.github/ISSUE_TEMPLATE/`** — committed bug report / feature request forms + config scaffolded by the init CLI

### Fixed

- **`describe-on-fields` lint compliance across 6 tools** — the recursive `describe-on-fields` rule (`@cyanheads/mcp-ts-core@0.6.16`) now walks into nested object shapes, array element types, and union variants. Added `.describe()` on 18 newly-flagged paths so the rendered JSON Schema carries descriptions for every non-primitive position the LLM sees:
  - `pubchem_get_compound_safety` — `output.ghs.hazardStatements[]`, `output.ghs.precautionaryStatements[]` element objects
  - `pubchem_get_summary` — `input.identifiers[]` union + both variants (`|0`, `|1`), `output.summaries[]` element object + its `identifier` union
  - `pubchem_get_compound_details` — `output.compounds[]`, `output.compounds[].descriptions[]`, `output.compounds[].classification.atcCodes[]` element objects
  - `pubchem_get_compound_xrefs` — `output.xrefs[]` element, `output.xrefs[].ids[]` union + both variants
  - `pubchem_search_compounds` — `output.results[]` element object
  - `pubchem_get_bioactivity` — `output.results[]`, `output.results[].activityValues[]` element objects

### Refactored

- **`pubchem-client.ts` — hoisted `activityKey` helper to module scope** (`parseAssayTable`). Previously re-allocated per row inside the iteration loop; now constructed once. Measurable for well-studied compounds where `assaysummary` returns thousands of rows (e.g. aspirin: 3,367 assays)
- **`get-compound-image.tool.ts` — inlined one-use `arrayBufferToBase64` helper**. Collapses a 3-line named function into `Buffer.from(buffer).toString('base64')` at the sole call site

## [0.1.15] — 2026-04-20

### Changed

- **Dependencies** — updated `@cyanheads/mcp-ts-core` from `^0.3.7` to `^0.5.3` (spans nine upstream releases; notable: `parseEnvConfig` helper, framework-level `ZodError` banner at startup, new `format-parity` lint rule, dual-surface parity framing, `Docs Sync` devcheck step, pino-redact Node 25 crash fix)
- **`package.json` overrides removed** — dropped `brace-expansion`, `path-to-regexp`, `picomatch` pins. Upstream now publishes safe versions (`>= 2.1.0`, `>= 8.4.2`, `>= 4.0.4`) so the overrides are redundant; `bun audit` remains clean
- **`CLAUDE.md`** — rewrote the `format()` guidance (inline tool example and checklist item) to match the upstream dual-surface framing: `content[]` is the markdown twin of `structuredContent`, not a reduced summary; Claude Code forwards `structuredContent`, Claude Desktop forwards `content[]`, both must be content-complete, enforced at lint time
- **Skills synced** from `@cyanheads/mcp-ts-core@0.5.3`: `add-tool` (1.4 → 1.6), `api-config` (1.1 → 1.2), `design-mcp-server` (2.3 → 2.4), `field-test` (1.1 → 1.2), `maintenance` (1.2 → 1.3), `polish-docs-meta` (1.3 → 1.4), `setup` (1.2 → 1.3)

### Fixed

- **`format-parity` lint compliance across 5 tools** — the new `format-parity` linter (`@cyanheads/mcp-ts-core@0.5.2+`) flagged 9 output fields whose values were not rendered in `format()` text. Every affected tool now renders the missing field so `content[]`-only clients see the same data as `structuredContent`-only clients:
  - `pubchem_get_compound_safety` — header changed to `## GHS Safety Data — CID {cid}` (renders the `hasData` field)
  - `pubchem_get_summary` — always renders `identifier` and the found/not-found state explicitly; `symbol` is no longer skipped in the field loop
  - `pubchem_get_compound_details` — adds `(found)` tag to the compound header, a `**Properties:**` sub-header above the property block, a `(showing N of M total)` qualifier that renders `descriptionsTotal`; renamed the drug-likeness descriptor line from `**Properties:**` to `**Descriptors:**` to eliminate the resulting duplicate label
  - `pubchem_get_compound_xrefs` — truncated count string now ends with `— truncated`
  - `pubchem_search_compounds` — adds a `**Properties:**` sub-header above hydrated property entries

## [0.1.14] — 2026-04-19

### Changed

- **Dependencies** — updated `@cyanheads/mcp-ts-core` from `^0.3.5` to `^0.3.7`
- **Skills** — synced `add-tool` (1.3 → 1.4) and `design-mcp-server` (2.2 → 2.3) from `@cyanheads/mcp-ts-core@0.3.7`

## [0.1.13] — 2026-04-19

### Fixed

- **`pubchem_get_compound_details` silent empty record for nonexistent CIDs** ([#5](https://github.com/cyanheads/pubchem-mcp-server/issues/5)) — output now carries a required `found: boolean` flag; not-found CIDs render as `## CID X — not found in PubChem` instead of an empty block. PUG View calls (description, synonyms, classification) are skipped for not-found CIDs to avoid wasted requests
- **`pubchem_get_bioactivity` phantom `Value: 0 uM` entries** ([#6](https://github.com/cyanheads/pubchem-mcp-server/issues/6)) — `parseAssayTable` now skips empty/whitespace cells before `Number()` coercion (PubChem returns `""` for missing values, which silently coerced to `0`); affected AIDs (1195, 1811, 182665, 284327, 328210, etc.) now correctly report `activityValues: []`
- **`pubchem_get_bioactivity` duplicate activity entries within an AID** ([#6](https://github.com/cyanheads/pubchem-mcp-server/issues/6)) — replicate rows in PubChem's assaysummary table no longer produce duplicate `{name, value, unit}` triples; dedup is keyed on the triple

### Changed

- **`pubchem_get_compound_details` description shape** ([#7](https://github.com/cyanheads/pubchem-mcp-server/issues/7)) — replaced `description?: string` (unbounded join of all depositor blurbs) with `descriptions?: Array<{ source?: string; text: string }>` plus `descriptionsTotal?: number`. Descriptions are deduped by exact normalized text and capped at the new `maxDescriptions` input (default 3, max 20). Format renders each with source attribution and a `+K more descriptions from other sources` marker when truncated
- **`PubChemClient.getDescription` return type** — now `Promise<Array<{source?, text}>>` (was `Promise<string | null>`); empty results are `[]` rather than `null`. Source attribution is derived from PUG View `Reference` entries

### Added

- Client-level test suite at `tests/services/pubchem/pubchem-client.test.ts` — exercises `parseAssayTable` (empty-cell filtering, NaN rejection, dedup behavior, distinct-value preservation) and `getDescription` (dedup, source attribution, missing-section/404 paths) with realistic PubChem response shapes

## [0.1.12] — 2026-04-19

### Changed

- **Dependencies** — updated `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.3.5`, `@biomejs/biome` from `^2.4.10` to `^2.4.12`, `@types/node` from `^25.5.0` to `^25.6.0`, `typescript` from `^6.0.2` to `^6.0.3`, `vitest` from `^4.1.2` to `^4.1.4`
- **`pubchem_get_summary` output shape** — replaced opaque `z.record(z.string(), z.unknown())` with a typed entity-summary schema (16 optional fields spanning assay/gene/protein/taxonomy). Fields absent from upstream are now omitted entirely rather than filled with empty strings or zeros — MCP clients can now introspect the full output shape with per-field descriptions
- **`pubchem_get_bioactivity` activity values** — `name` and `unit` are now optional and omitted when upstream doesn't provide them, replacing previous fabricated empty strings
- **`pubchem_get_compound_details` descriptions** — rewrote `includeDescription` and `includeClassification` parameter descriptions to remove PUG-View implementation leakage and describe actual data returned; renamed output `description` describe to match
- **Skills** — synced 14 framework skills (`add-prompt`, `add-resource`, `add-service`, `add-test`, `add-tool`, `api-testing`, `api-workers`, `design-mcp-server`, `devcheck`, `field-test`, `maintenance`, `migrate-mcp-ts-template`, `polish-docs-meta`, `setup`) from `@cyanheads/mcp-ts-core@0.3.5`

### Added

- **`add-app-tool` skill** — scaffolding guide for MCP App Tools (interactive UI components) surfaced by the framework upgrade
- **Empty-string refinement on `pubchem_search_compounds`** — `identifiers` now rejects `[""]` and whitespace-only entries with a clear validation error, preventing bad form-client submissions from reaching PubChem

### Fixed

- **Drug-likeness honesty** — `pass` is now `boolean | null`; returns `null` when any Lipinski/Veber rule can't be evaluated (missing property) instead of silently treating missing data as a violation. Matching `null` propagation in per-rule `pass` and `value`
- **Drug-likeness MolecularWeight coercion** — `evaluateRule` now parses numeric-string values (PubChem returns `MolecularWeight` as `"180.16"`, not `180.16`), unblocking Lipinski MW evaluation that previously returned `pass: null` for all compounds

## [0.1.11] — 2026-03-30

### Changed

- **Dependencies** — updated `@cyanheads/mcp-ts-core` from `^0.2.8` to `^0.2.10`, `@biomejs/biome` from `^2.4.9` to `^2.4.10`
- **Package metadata** — updated author field in `package.json`

## [0.1.10] — 2026-03-28

### Changed

- Removed redundant `destructiveHint: false` annotations from all tool definitions
- Externalized devcheck configuration to `devcheck.config.json` (depcheck ignores, outdated allowlist)
- Dynamic `.tsbuildinfo` file discovery in clean script instead of hardcoded filenames
- Enhanced MCP linter with task handler detection and server.json/package.json validation
- Updated agent protocol (CLAUDE.md) with `format()` guidance and checklist item
- Updated skills: add-tool v1.1, add-resource v1.1, design-mcp-server v2.1, polish-docs-meta v1.2

### Added

- `devcheck.config.json` for project-local devcheck configuration
- `report-issue-framework` skill for filing bugs against `@cyanheads/mcp-ts-core`
- `report-issue-local` skill for filing bugs against this server
- Security overrides in package.json for `brace-expansion`, `path-to-regexp`, `picomatch`

## [0.1.9] — 2026-03-28

### Changed

- **Dependencies** — updated `@cyanheads/mcp-ts-core` from `^0.1.28` to `^0.2.8`, `@biomejs/biome` from `^2.4.8` to `^2.4.9`, `vitest` from `^4.1.1` to `^4.1.2`

## [0.1.8] — 2026-03-23

### Changed

- **Dependencies** — updated `@cyanheads/mcp-ts-core` from `^0.1.25` to `^0.1.28`, `typescript` from `^5.9.3` to `^6.0.2`, `vitest` from `^4.1.0` to `^4.1.1`
- **tsconfig** — removed `baseUrl`, adjusted `paths` alias syntax

## [0.1.7] — 2026-03-21

### Changed

- **Dependency** — updated `@cyanheads/mcp-ts-core` from `^0.1.24` to `^0.1.25`

## [0.1.6] — 2026-03-21

### Changed

- **Dependency** — updated `@cyanheads/mcp-ts-core` from `^0.1.23` to `^0.1.24`

## [0.1.5] — 2026-03-21

### Changed

- **Dependency** — updated `@cyanheads/mcp-ts-core` from `^0.1.21` to `^0.1.23`
- **Docker OpenTelemetry** — Dockerfile now conditionally installs OpenTelemetry peer dependencies via `OTEL_ENABLED` build arg (defaults to `true`)
- **Agent protocol** — added Publishing section to CLAUDE.md

## [0.1.4] — 2026-03-21

### Fixed

- **Output schema introspection** — replaced opaque `z.custom<>()` with explicit Zod schemas for `drugLikeness` and `classification` in `pubchem_get_compound_details` output; MCP clients can now see the full output shape with field descriptions

### Added

- **`.dockerignore`** — comprehensive ignore file for Docker builds

## [0.1.3] — 2026-03-21

### Changed

- **README polish** — added framework badge, tool count, fixed list numbering and markdown formatting
- **Dependency** — updated `@cyanheads/mcp-ts-core` from `^0.1.20` to `^0.1.21`

## [0.1.2] — 2026-03-21

### Added

- **Drug-likeness assessment** — `pubchem_get_compound_details` now optionally computes Lipinski Rule of Five and Veber rules from fetched properties (no extra API calls)
- **Pharmacological classification** — `pubchem_get_compound_details` can fetch FDA Established Pharmacologic Classes, mechanisms of action, MeSH classes, and ATC codes via PUG View

### Changed

- **Test location** — moved all tool tests from `src/` to a top-level `tests/` directory with path-alias imports
- **PUG View call consolidation** — description and classification fetches share a single CID cap (10) instead of separate limits
- **Dependency** — updated `@cyanheads/mcp-ts-core` from `^0.1.18` to `^0.1.20`

### Fixed

- **SMILES property name mapping** — corrected inverted mapping (`IsomericSMILES` ↔ `CanonicalSMILES` were swapped)
- **Plain-text fault parsing** — image endpoint returns non-JSON fault responses; parser now handles `Code:/Message:` format
- **Entity summary HTTP 400** — PubChem returns 400 (not 404) for nonexistent entity IDs on some endpoints; now treated as not-found
- **Bioactivity format** — activity values without a name are now filtered out of the display

## [0.1.1] — 2026-03-21

### Changed

- **Package rename** — published as `@cyanheads/pubchem-mcp-server` (scoped npm package)
- **Bioactivity target fields** — replaced `targetGeneSymbol`/`targetName` with `targetAccession` (UniProt/GenBank) and `targetGeneId` (NCBI Gene ID) to match actual PubChem API columns
- **Activity value parsing** — uses prefix-based column matching for headers with embedded units (e.g. "Activity Value [uM]") instead of relying on a separate unit column
- **Summary tool** — removed `pathway`, `cell`, and `substance` entity types; now supports `assay`, `gene`, `protein`, `taxonomy`
- **Formula search description** — simplified, removed unsupported parentheses/isotope notation claims
- **Dependency** — updated `@cyanheads/mcp-ts-core` from `^0.1.16` to `^0.1.18`

### Fixed

- **Async search polling** — added `ListKeyResponse` handling and `pollListKey()` for long-running PubChem searches (formula, similarity) that return a `Waiting` response instead of immediate results
- **Property name normalization** — maps PubChem's returned field names back to the names consumers requested (e.g. `SMILES` → `CanonicalSMILES`)
- **GHS safety deduplication** — pictograms, hazard statements, and precautionary statements are now deduplicated across depositors
- **Assay target type mapping** — `proteinaccession` is now correctly mapped to `accession` for the PubChem API path

## [0.1.0] — 2026-03-21

Initial release using `@cyanheads/mcp-ts-core`. Previously built on mcp-ts-template, the new @cyanheads/mcp-ts-core framework provides plumbing.

### Added

- **8 tools** for querying PubChem's chemical information database:
  - `pubchem_search_compounds` — search by name, SMILES, InChIKey, formula, substructure, superstructure, or 2D similarity
  - `pubchem_get_compound_details` — physicochemical properties, descriptions, and synonyms (batch up to 100 CIDs)
  - `pubchem_get_compound_image` — 2D structure diagram (PNG)
  - `pubchem_get_compound_safety` — GHS hazard classification and safety data
  - `pubchem_get_compound_xrefs` — external database cross-references (PubMed, patents, genes, proteins, taxonomy)
  - `pubchem_get_bioactivity` — assay results, targets, and activity values (IC50, EC50, Ki)
  - `pubchem_search_assays` — find bioassays by biological target
  - `pubchem_get_summary` — summaries for assays, genes, proteins, and taxonomy
- **PubChem API client** with sliding-window rate limiter (5 req/s), retry with exponential backoff, and structured response parsing for both PUG REST and PUG View APIs
- **Test suite** with Vitest — colocated `*.tool.test.ts` for every tool definition
- **Build tooling** — Biome for linting/formatting, custom build/devcheck/tree scripts
- **Skills directory** — framework-provided agent skills for tool scaffolding, testing, and maintenance
- **server.json** metadata for MCP registry discovery
- Dockerfile for containerized HTTP deployment
- Dual transport support: stdio and HTTP

## [1.0.2] - 2025-06-30

### Added

- **New `getSummary` Tool**: Introduced a new, versatile `pubchem_get_summary` tool that consolidates and replaces the former `fetchAssaySummary` tool. This new tool can fetch summaries for multiple PubChem entity types, including `assay`, `gene`, `protein`, `pathway`, `taxonomy`, and `cell`, providing a single, unified interface for retrieving summary data.
- **New Documentation**: Added `docs/pubchem-api.md`, a comprehensive document detailing the PUG REST API, and `docs/ideas.md`, which outlines potential future enhancements for the server based on the API specification.

### Changed

- **Tool Refactoring**: The `fetchAssaySummary` tool has been completely removed and its functionality is now part of the new `pubchem_get_summary` tool. The server registration in `src/mcp-server/server.ts` has been updated accordingly.
- **Enhanced `fetchSubstanceDetails`**: The tool's description has been updated to more accurately reflect its comprehensive output, which includes full cross-reference and compound data structures.

### Fixed

- **Corrected `fetchCompoundProperties` Logic**: The tool's logic has been fixed to correctly handle requests for multiple CIDs. It now iterates through each CID and makes individual API calls, ensuring that a failure for one CID does not prevent the retrieval of data for others.

## [1.0.1] - 2025-06-30

### Changed

- **Tool Refactoring**: Overhauled the entire PubChem tool suite to improve robustness, align with best practices, and enhance input/output schemas.
  - **Standardized Error Handling**: Refactored all tool registration files (`registration.ts`) to use a centralized `ErrorHandler.formatError` method, removing redundant `try...catch` blocks and ensuring consistent error responses.
  - **Bulk Operations**:
    - `pubchem_search_compound_by_identifier` now accepts an array of `identifiers` and returns a map of identifiers to their corresponding CIDs.
    - `pubchem_fetch_assay_summary` now accepts an array of up to 5 `aids` and returns an array of summaries.
  - **Enhanced `fetchSubstanceDetails`**: The tool now retrieves more comprehensive data in a single API call, including `xrefs` and full `compound` structures, and provides a richer output object.
  - **Robust `fetchCompoundXrefs`**: The logic was completely rewritten to fetch each cross-reference type individually, preventing API timeouts on large requests. The output is now cleanly grouped by type.
  - **Typed API Client**: The `pubChemApiClient`'s `get` method is now generic (`get<T>`), improving type safety for all API calls.
- **Tool Rename**: Renamed the `getCompoundImageUrl` tool to `getCompoundImage` and relocated its directory for better consistency (`src/mcp-server/tools/getCompoundImage/`).
- **Schema Improvements**: Updated Zod schemas across multiple tools for stricter validation and more descriptive outputs.

### Fixed

- **Corrected `fetchCompoundXrefs` Pagination**: Changed the default `pageSize` from 1000 to a more reasonable 50.

### Removed

- **Outdated Documentation**: Deleted obsolete documentation files (`docs/api-references/duckDB.md`, `docs/api-references/jsdoc-standard-tags.md`).

## [1.0.0] - 2025-06-30

### New Project

- **Project Refocus**: The project has been completely refactored from a generic MCP server template into a dedicated `pubchem-mcp-server`. This includes the removal of all previous example tools (`echoTool`, `catFactFetcher`, `imageTest`) and resources.

### Added

- **PubChem Tool Suite**: Introduced a comprehensive suite of 10 tools for interacting with the PubChem API. Each tool is organized into its own module under `src/mcp-server/tools/` and follows the mandated "Logic Throws, Handler Catches" pattern. The new tools are:
  - `pubchem_search_compound_by_identifier`: Find CIDs by name, SMILES, or InChIKey.
  - `pubchem_fetch_compound_properties`: Retrieve detailed physicochemical properties for CIDs.
  - `pubchem_get_compound_image`: Fetch a 2D compound image as a blob.
  - `pubchem_search_compounds_by_structure`: Perform substructure, superstructure, or identity searches.
  - `pubchem_search_compounds_by_similarity`: Find structurally similar compounds.
  - `pubchem_search_compounds_by_formula`: Search for CIDs by molecular formula.
  - `pubchem_fetch_substance_details`: Get details for a specific Substance ID (SID).
  - `pubchem_fetch_assay_summary`: Retrieve summaries for a BioAssay ID (AID).
  - `pubchem_search_assays_by_target`: Find assays related to a biological target.
  - `pubchem_fetch_compound_xrefs`: Fetch external cross-references for a CID.
- **PubChem API Client**: Implemented a new singleton `PubChemApiClient` (`src/services/pubchem/pubchemApiClient.ts`) to manage all interactions with the PubChem PUG REST API. It includes rate limiting (5 requests/sec) and centralized error handling.
- **Error Types**: Added new error codes to `src/types-global/errors.ts` (`INVALID_INPUT`, `METHOD_NOT_ALLOWED`, `GATEWAY_TIMEOUT`, `EXTERNAL_SERVICE_ERROR`) to better handle specific API error conditions.

### Changed

- **Server Registration**: Updated `src/mcp-server/server.ts` to remove old tool registrations and register the new suite of 10 PubChem tools.
- **Dependencies**: Updated all dependencies to their latest versions in `package.json` and `package-lock.json`.
- **Configuration**: Updated `.ncurc.json` to also reject the `dotenv` package from updates.
- **Documentation**:
  - Updated `README.md` to reflect the project's new focus as a PubChem server.
  - Regenerated `docs/tree.md` to show the new tool structure.

### Removed

- **Example Tools**: Deleted the `echoTool`, `catFactFetcher`, and `imageTest` directories and all associated logic, registration, and index files.
- **Example Resources**: Removed the `echoResource` and its related files.
