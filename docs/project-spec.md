## **Project Specification: `pubchem-mcp-server` (Production Build v2)**

### 1. Overview

This document outlines the project specification for the `pubchem-mcp-server`, a production-grade Model Context Protocol (MCP) server. Built using the `mcp-ts-template`, this server will provide a comprehensive, robust, and AI-agent-friendly interface to the PubChem PUG REST API.

The server's design will strictly adhere to the architectural patterns and best practices demonstrated in the `pubmed-mcp-server`, including the `verb_domain_noun` tool naming convention, modular design, and a focus on creating powerful, composable tools for complex scientific workflows. The server will enable autonomous agents to systematically search, fetch, and analyze chemical, substance, and bioassay data from PubChem.

### 2. Project Goals

- **Production-Ready Implementation:** Deliver a stable, reliable, and secure server suitable for production use, leveraging all relevant features of the `mcp-ts-template` (logging, error handling, security, configuration).
- **Agent-Centric Design:** Create a suite of MCP Tools with clear, predictable, and strictly-typed schemas and descriptive names that are intuitive for an LLM agent to discover and use effectively.
- **Comprehensive API Coverage:** Implement tools that cover the core functionalities of the PubChem API, including the `Compound`, `Substance`, and `Assay` domains, as well as advanced search and cross-referencing capabilities.
- **Robustness and Compliance:** Strictly enforce PubChem's API usage policy (5 requests/second) through a built-in rate limiter. Implement comprehensive error handling and input validation to gracefully manage API-specific issues.
- **Extensibility:** Build a modular foundation that allows for easy addition of new tools and capabilities as the server evolves.

### 3. Tool Naming Convention

All tools will follow the `verb_domain_noun` naming convention established by the `pubmed-mcp-server` to ensure consistency and predictability for agents interacting with multiple servers from this ecosystem.

- **`search_*`**: For discovering identifiers based on a query.
- **`fetch_*`**: For retrieving detailed data for a known identifier.
- **`get_*`**: For retrieving specific attributes or related information.

### 4. MCP Tool Suite Specification

The server will be organized into logical tool groups.

#### Group 1: Core Compound Tools

These tools provide the fundamental capabilities for working with chemical compounds.

- **`search_compound_by_identifier`**
  - **Description:** Searches for a PubChem Compound ID (CID) using a common chemical identifier like a name, SMILES string, or InChIKey. This is the primary entry point for most compound-related workflows.
  - **PubChem API:** `.../compound/<namespace>/<identifier>/cids/JSON`
  - **Input (Zod):**
    ```
    z.object({
      identifierType: z.enum(['name', 'smiles', 'inchikey']).describe("The type of identifier provided."),
      identifier: z.string().describe("The identifier string (e.g., 'aspirin', 'CC(=O)Oc1ccccc1C(=O)O').")
    })
    ```
  - **Output (Zod):**
    ```
    z.object({
      cids: z.array(z.number().int()).describe("A list of matching PubChem Compound IDs (CIDs). Often a single result.")
    })
    ```
- **`fetch_compound_properties`**
  - **Description:** Fetches a list of specified physicochemical properties for one or more compound CIDs. Supports batch requests.
  - **PubChem API:** `.../compound/cid/<cids>/property/<properties>/JSON`
  - **Input (Zod):**
    ```
    z.object({
      cids: z.array(z.number().int().positive()).min(1).describe("An array of one or more CIDs to fetch properties for."),
      properties: z.array(z.enum([
        'MolecularFormula', 'MolecularWeight', 'InChI', 'InChIKey', 'IUPACName', 'Title',
        'XLogP', 'ExactMass', 'MonoisotopicMass', 'TPSA', 'Complexity', 'Charge',
        'HBondDonorCount', 'HBondAcceptorCount', 'RotatableBondCount', 'HeavyAtomCount', 'CovalentUnitCount'
      ])).min(1).describe("A list of properties to retrieve.")
    })
    ```
  - **Output (Zod):**

    ```
    // A highly specific schema for predictable agent consumption.
    const CompoundPropertiesSchema = z.object({
      CID: z.number().int(),
      MolecularFormula: z.string().optional(),
      MolecularWeight: z.number().optional(),
      InChI: z.string().optional(),
      InChIKey: z.string().optional(),
      IUPACName: z.string().optional(),
      Title: z.string().optional(),
      XLogP: z.number().optional(),
      ExactMass: z.number().optional(),
      MonoisotopicMass: z.number().optional(),
      TPSA: z.number().optional(),
      Complexity: z.number().optional(),
      Charge: z.number().optional(),
      HBondDonorCount: z.number().int().optional(),
      HBondAcceptorCount: z.number().int().optional(),
      RotatableBondCount: z.number().int().optional(),
      HeavyAtomCount: z.number().int().optional(),
      CovalentUnitCount: z.number().int().optional(),
    }).describe("An object containing the requested properties for a single compound.");

    z.object({
      results: z.array(CompoundPropertiesSchema)
        .describe("A list of property results, one for each requested CID.")
    })
    ```

- **`get_compound_image_url`**
  - **Description:** Generates and returns a direct URL to a 2D image of a compound's structure. Ideal for multimodal agents.
  - **PubChem API:** (Constructs URL) `.../compound/cid/<cid>/PNG`
  - **Input (Zod):**
    ```
    z.object({
      cid: z.number().int().positive().describe("The CID of the compound."),
      size: z.enum(['small', 'large']).optional().default('large').describe("Image size: 'small' (100x100) or 'large' (300x300).")
    })
    ```
  - **Output (Zod):**
    ```
    z.object({
      cid: z.number().int(),
      imageUrl: z.string().url().describe("A direct URL to the PNG image of the compound's structure.")
    })
    ```

#### Group 2: Advanced Compound Search Tools

These tools enable more complex, structure-based discovery.

- **`search_compounds_by_structure`**
  - **Description:** Performs a structural search (substructure, superstructure, or identity) based on a query structure provided as a SMILES string or an existing CID.
  - **PubChem API:** `.../compound/{substructure|superstructure|identity}/{smiles|cid}/<query>/cids/JSON`
  - **Input (Zod):**
    ```
    z.object({
      searchType: z.enum(['substructure', 'superstructure', 'identity']).describe("The type of structural search to perform."),
      query: z.string().describe("The query structure, provided as a SMILES string or a CID (e.g., 'c1ccccc1' or '2244')."),
      queryType: z.enum(['smiles', 'cid']).describe("The format of the provided query."),
      maxRecords: z.number().int().positive().max(100).optional().default(20).describe("Maximum number of matching CIDs to return.")
    })
    ```
  - **Output (Zod):** `z.object({ cids: z.array(z.number().int()) })`
- **`search_compounds_by_similarity`**
  - **Description:** Finds compounds with a similar 2D structure to a query compound (SMILES or CID).
  - **PubChem API:** `.../compound/fastsimilarity_2d/{smiles|cid}/<query>/cids/JSON`
  - **Input (Zod):**
    ```
    z.object({
      query: z.string().describe("The query structure as a SMILES string or a CID."),
      queryType: z.enum(['smiles', 'cid']).describe("The format of the provided query."),
      threshold: z.number().min(70).max(100).optional().default(90).describe("Minimum Tanimoto similarity score (70-100)."),
      maxRecords: z.number().int().positive().max(100).optional().default(20).describe("Maximum number of similar CIDs to return.")
    })
    ```
  - **Output (Zod):** `z.object({ cids: z.array(z.number().int()) })`
- **`search_compounds_by_formula`**
  - **Description:** Finds compounds matching a given molecular formula.
  - **PubChem API:** `.../compound/fastformula/<formula>/cids/JSON`
  - **Implementation Note:** The regex should be defined as a named constant for maintainability (e.g., `MOLECULAR_FORMULA_REGEX`).
  - **Input (Zod):**
    ```
    const MOLECULAR_FORMULA_REGEX = /^[A-Z][a-z]?\d*([A-Z][a-z]?\d*)*$/;
    z.object({
      formula: z.string().regex(MOLECULAR_FORMULA_REGEX).describe("A valid molecular formula (e.g., 'C6H12O6')."),
      allowOtherElements: z.boolean().optional().default(false).describe("If true, allows compounds containing additional elements."),
      maxRecords: z.number().int().positive().max(100).optional().default(50).describe("Maximum number of matching CIDs to return.")
    })
    ```
  - **Output (Zod):** `z.object({ cids: z.array(z.number().int()) })`

#### Group 3: Substance & Assay Tools

These tools provide access to deposited substance data and biological assay results.

- **`fetch_substance_details`**
  - **Description:** Retrieves details for a given PubChem Substance ID (SID), including its synonyms, source, and any associated CIDs.
  - **PubChem API:** `.../substance/sid/<sid>/JSON` and `.../substance/sid/<sid>/cids/JSON`
  - **Input (Zod):** `z.object({ sid: z.number().int().positive().describe("The PubChem Substance ID (SID).") })`
  - **Output (Zod):**
    ```
    z.object({
      sid: z.number().int(),
      sourceName: z.string().describe("The name of the depositor/source."),
      depositionDate: z.string().describe("The date the substance was deposited."),
      modificationDate: z.string().describe("The date the substance was last modified."),
      synonyms: z.array(z.string()).describe("A list of synonyms for the substance."),
      relatedCids: z.array(z.number().int()).describe("A list of standardized Compound IDs (CIDs) related to this substance.")
    })
    ```
- **`fetch_assay_summary`**
  - **Description:** Retrieves the summary for a given PubChem BioAssay ID (AID), including its name, description, source, and targets.
  - **PubChem API:** `.../assay/aid/<aid>/summary/JSON`
  - **Input (Zod):** `z.object({ aid: z.number().int().positive().describe("The PubChem BioAssay ID (AID).") })`
  - **Output (Zod):**
    ```
    z.object({
      aid: z.number().int(),
      name: z.string(),
      description: z.string(),
      sourceName: z.string(),
      numSids: z.number().int(),
      numActive: z.number().int(),
      targets: z.array(z.object({
        name: z.string(),
        geneId: z.number().int().optional(),
        geneSymbol: z.string().optional()
      })).describe("Biological targets of the assay.")
    })
    ```
- **`search_assays_by_target`**
  - **Description:** Finds BioAssay IDs (AIDs) associated with a specific biological target, such as a gene symbol or protein name.
  - **PubChem API:** `.../assay/target/{genesymbol|proteinname}/<query>/aids/JSON`
  - **Input (Zod):**
    ```
    z.object({
      targetType: z.enum(['genesymbol', 'proteinname']).describe("The type of biological target."),
      targetQuery: z.string().describe("The target identifier (e.g., 'EGFR', 'Epidermal growth factor receptor').")
    })
    ```
  - **Output (Zod):** `z.object({ aids: z.array(z.number().int()) })`

#### Group 4: Cross-Reference (XRef) Tool

This tool bridges PubChem data with other databases.

- **`fetch_compound_xrefs`**
  - **Description:** Fetches external cross-references (XRefs) for a given CID. Returns identifiers that can be used with other services (e.g., a PubMed ID for use with `pubmed-mcp-server`).
  - **PubChem API:** `.../compound/cid/<cid>/xrefs/<xref_types>/JSON`
  - **Input (Zod):**
    ```
    z.object({
      cid: z.number().int().positive().describe("The CID to find cross-references for."),
      xrefTypes: z.array(z.enum([
        'RegistryID', 'RN', 'PubMedID', 'PatentID', 'GeneID', 'ProteinGI', 'TaxonomyID'
      ])).min(1).describe("A list of cross-reference types to retrieve.")
    })
    ```
  - **Output (Zod):**
    ```
    z.object({
      cid: z.number().int(),
      xrefs: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).describe("An object where keys are the requested xrefTypes and values are arrays of found identifiers.")
    })
    ```

### 5. Technical Implementation & Architecture

- **Project Initialization:**
  1. Clone `mcp-ts-template` to a new `pubchem-mcp-server` directory.
  2. Update `package.json` with the new project details.
  3. Remove all example tools and resources from `src/mcp-server/`.
- **API Client Service (`src/services/pubchem/pubchemApiClient.ts`):**
  - A dedicated, singleton service will encapsulate all interactions with the PubChem API.
  - **Responsibilities:**
    1. **URL Construction:** Centralize all logic for building valid PUG REST API URLs.
    2. **Rate Limiting:** Instantiate and manage a `RateLimiter` configured to **5 requests per 1 second**. Every outgoing API call must acquire a permit.
    3. **Request Execution:** Use `fetchWithTimeout` for all API calls.
    4. **Error Handling & Translation:** Intercept API responses and map PubChem HTTP status codes to `BaseErrorCode` enums, throwing structured `McpError` instances (e.g., 404 -> `NOT_FOUND`, 400 -> `INVALID_INPUT`).
    5. **Response Validation:** Use Zod schemas to parse and validate the JSON response from PubChem before returning data to the tool logic.
- **Tool Logic & Validation:**
  - Each tool's `logic.ts` file will contain its execution logic.
  - **Input Coherence Validation:** For tools with dynamic query types (e.g., `search_compounds_by_structure`), the logic must perform an internal consistency check. For example, if `queryType` is `'cid'`, the `query` must be a numeric string. If not, an `McpError` with code `INVALID_INPUT` should be thrown _before_ making an API call.
    ```
    // Example check in logic.ts for search_compounds_by_structure
    if (input.queryType === 'cid' && isNaN(parseInt(input.query, 10))) {
      throw new McpError({
        code: 'INVALID_INPUT',
        message: `Query type is 'cid' but the provided query '${input.query}' is not a valid number.`
      });
    }
    ```
- **Configuration:**
  - The server will leverage existing environment variables from the template for transport, logging, and auth. No API key is required for PubChem.

### 6. Development Workflow

1. **Setup:** Clone the template, clean the project, and update `package.json`.
2. **API Client:** Implement the `pubchemApiClient.ts` service as the foundational layer.
3. **Implement Tools:** Implement tools one by one, following a "define, implement, register, test" cycle.
   - Define schemas and registration in `registration.ts`.
   - Write the `execute` logic (including input validation) in `logic.ts`.
   - Register the tool in `src/mcp-server/server.ts`.

4. **Test Iteratively:** Use the MCP inspector (`npm run inspector`) or an HTTP client to test each tool with valid, invalid, and edge-case inputs.
5. **Documentation:** Update the project `README.md`. **Crucially, this documentation must prominently feature an example of the inter-server workflow.** Showcasing how an agent can use `fetch_compound_xrefs` to get a `PubMedID` and then immediately use that ID with a `pubmed-mcp-server` is essential for demonstrating the power of the ecosystem.

### 7. Future Enhancements

- **MCP Resources:** Introduce an MCP `Compound` resource to maintain context across tool calls, simplifying agent workflows.
- **Asynchronous Search Support:** Implement support for PubChem's asynchronous `listkey` mechanism for long-running searches to prevent timeouts.
- **Data Visualization:** Add a `generate_compound_chart` tool to create charts comparing properties for a list of CIDs.
