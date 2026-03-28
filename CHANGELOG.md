# Changelog

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
