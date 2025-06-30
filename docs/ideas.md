# PubChem MCP Server: New Tool and Improvement Ideas

This document outlines potential new tools and enhancements for the `pubchem-mcp-server` based on a review of the official PUG REST API documentation.

## 1. Existing PubChem Tools

Based on the project structure, the currently implemented PubChem tools are:

- `pubchem_search_compound_by_identifier`: Searches for Compound IDs (CIDs) using identifiers like names or SMILES.
- `pubchem_fetch_compound_properties`: Fetches specific physicochemical properties for given CIDs.
- `pubchem_get_compound_image`: Retrieves a 2D image of a compound.
- `pubchem_search_compounds_by_structure`: Performs substructure, superstructure, or identity searches.
- `pubchem_search_compounds_by_similarity`: Finds compounds with structural similarity.
- `pubchem_search_compounds_by_formula`: Searches for CIDs based on a molecular formula.
- `pubchem_fetch_substance_details`: Retrieves details for a given Substance ID (SID).
- `pubchem_fetch_assay_summary`: Fetches summaries for BioAssay IDs (AIDs).
- `pubchem_search_assays_by_target`: Finds assays related to a specific biological target.
- `pubchem_fetch_compound_xrefs`: Fetches external cross-references for a CID.

## 2. Analysis of Missing Tools and Potential Improvements

After comparing the existing tools with the PUG REST API documentation, I've identified several opportunities to expand the server's capabilities and improve existing tools.

### High-Impact New Tools

These are significant capabilities described in the API that are not currently available.

1.  **Bio-entity Information Tools**: The API provides access to several biological data domains beyond compounds and assays. We could create a suite of tools to access them:
    - `pubchem_get_gene_summary`: To retrieve details for a given GeneID or symbol.
    - `pubchem_get_protein_summary`: To get information on a protein via its accession number.
    - `pubchem_get_pathway_summary`: To fetch details about biological pathways.
    - `pubchem_get_taxonomy_summary`: To retrieve details on a given NCBI Taxonomy ID.
    - `pubchem_get_cell_summary`: To get information on cell lines.

2.  **Get Synonyms Tool**: The API has a dedicated `.../synonyms` endpoint.
    - **Suggestion**: Create a `pubchem_get_synonyms` tool to retrieve all known synonyms for a given compound or substance identifier. This is a common and fundamental task in cheminformatics.

3.  **Full Record Retrieval**: The current tools fetch specific properties or images. The API allows for downloading the full data record for a compound or substance in various chemical formats.
    - **Suggestion**: Create a `pubchem_get_record` tool that accepts a CID or SID and an output format (e.g., `SDF`, `JSON`, `XML`). This would be invaluable for users needing complete data for modeling or analysis.

4.  **Standardization Utility**: The API offers a `/standardize` endpoint to normalize chemical structures.
    - **Suggestion**: Create a `pubchem_standardize_structure` tool. It would take a SMILES or InChI string as input and return the PubChem-standardized version, which is a crucial step for ensuring consistency in chemical data processing.

### Enhancements to Existing Tools

These are improvements that would make the current tools more powerful and aligned with the full API capabilities.

1.  **Expand `pubchem_fetch_compound_properties`**: The list of properties available in the API is much larger than what the tool currently supports.
    - **Suggestion**: Add more properties to the `enum` in the tool's input schema, such as `Fingerprint2D`, `PatentCount`, `Volume3D`, and `HeavyAtomCount`.

2.  **Add Advanced Search Options**: The structure and identity search endpoints support numerous options that are not exposed in the current tools.
    - **Suggestion**: Enhance `pubchem_search_compounds_by_structure` and `pubchem_search_compounds_by_similarity` to include optional parameters like `MatchIsotopes`, `MatchCharges`, and `RingsNotEmbedded` for more precise queries.

3.  **Flexible Identifier Conversion**: The API provides powerful options for converting between identifier types (e.g., finding parent CIDs, component CIDs).
    - **Suggestion**: Create a dedicated `pubchem_convert_identifier` tool that exposes the `cids_type` and `sids_type` parameters, allowing for sophisticated relationship queries (e.g., converting a CID to its parent compound or its components).

### Other Potential New Tools

These are additional utilities that would round out the server's feature set.

- `pubchem_get_dates`: A tool to retrieve creation, modification, or hold dates for any PubChem record.
- `pubchem_list_sources`: A utility to list all data depositors, which could be useful for filtering or programmatic discovery.
- `pubchem_fetch_assay_dose_response`: A specialized tool to retrieve dose-response data for an assay, which is a more specific request than the current `fetchAssaySummary`.
