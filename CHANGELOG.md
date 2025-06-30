# Changelog

All notable changes to this project will be documented in this file.

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
