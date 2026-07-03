# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-07-03

Decode GHS precautionary (P-code) statements to standard text via a new lookup table in pubchem_get_compound_safety; append the asserted uM unit to target-kind activity values in pubchem_get_compound_interactions

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-07-03

Add maxAtoms/maxBonds/includeRawSdf output controls with truncation disclosure to pubchem_get_compound_3d_structure; frame upstream free text (descriptions, synonyms, interaction statements, GHS text, raw SDF) as delimited data in content[] to neutralize markdown-structure injection across six tools

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-03

Validate CID-shaped structure queries and blank/non-numeric target queries in pubchem_search_compounds and pubchem_search_assays before the upstream call; surface identifier-mode partial-batch misses and CID collisions via a new unresolvedIdentifiers field; add an empty-result notice to pubchem_get_compound_xrefs

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-06-30 · 🛡️ Security

Fix silent data loss in pubchem_get_compound_safety (precautionary statements) and pubchem_get_compound_details (FDA pharmacological classification), both parsing PubChem's real shapes; add a maxSynonyms cap; correct the server assay-routing instructions; adopt mcp-ts-core ^0.10.10; clear 8 transitive security advisories

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-06-20

adopt @cyanheads/mcp-ts-core ^0.10.9 — check-dependency-specifiers devcheck step, plugin-manifest packaging lint, fresh-scaffold devcheck guards, vendored skill re-sync

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-06-12

adopt @cyanheads/mcp-ts-core ^0.10.6 — truncation disclosure on capped searches, explicit createApp identity, MCPB bundle-content hardening

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-02

adopt @cyanheads/mcp-ts-core 0.9.21 — per-request log context fix, secret scrubbing in fetch errors, fail-fast retries

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-02

interactions target source, per-kind isolation, fetch resilience for image and 3D structure

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-01 · ⚠️ Breaking

interactions and 3D structure tools, URI-templated resources, target filter for bioactivity, batch safety

## [0.1.23](changelog/0.1.x/0.1.23.md) — 2026-06-01

Typed cid_not_found error on get_compound_image; enrichment for get_bioactivity, get_compound_safety, and get_summary

## [0.1.22](changelog/0.1.x/0.1.22.md) — 2026-05-30

Enrichment adoption: search_compounds and search_assays surface search-type/target echoes, true upstream totals, and empty-result guidance via a typed enrichment block

## [0.1.21](changelog/0.1.x/0.1.21.md) — 2026-05-28

mcp-ts-core ^0.9.6 → ^0.9.13: HTTP body cap, session-init gate, quieter 4xx logs, GET /mcp keywords; httpErrorFromResponse adoption; keyword additions
