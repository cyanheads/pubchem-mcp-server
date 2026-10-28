---
name: pubchem-guide
description: Gates and identifier chains for the pubchem_* tools — salt vs parent CIDs, where Gene IDs and accessions come from, why gene-symbol, Gene ID, and accession searches disagree, and how to read PubChem activity labels, potency values, and GHS data without over-concluding. Use when answering a compound identity, hazard, mechanism, potency, or target-assay question through pubchem_*.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

PubChem aggregates what depositors submit: compound records with computed properties, GHS classifications from regulators and companies, bioassay results from screening centers and from papers extracted by curated databases, and cross-references. Keyless. It reports what was deposited and computes nothing for a structure it has no record of.

Hand off to a sibling source when the question needs:

- article text or abstracts behind the PubMed IDs these tools return → a literature server
- curated potency comparisons, standardized per measurement type and target → a medicinal-chemistry bioactivity database
- approved-drug labels, adverse events, or drug–drug interactions → a drug regulatory or drug-label source
- protein function, sequence, or 3D protein structure behind a target accession → a protein knowledgebase or structure database

## Identifiers

- **CID** — from `pubchem_search_compounds` in identifier mode. Besides names, SMILES, InChI, and InChIKey, a CAS Registry Number resolves as a name (`67-64-1` → acetone, CID 180).
- **Salt and parent are separate CIDs.** "metformin" resolves to CID 4091 and "metformin hydrochloride" to CID 14219. Each carries its own assay data; nothing merges them.
- **AID** — from `pubchem_search_assays` (by target), or the AID on any bioactivity row or target entry.
- **NCBI Gene ID** — from a compound's target entries (`GeneID:5743` in the target kind of `pubchem_get_compound_interactions`) or the target Gene ID on a `pubchem_get_bioactivity` row from a targeted assay (rows from untargeted screens carry none). `pubchem_search_assays` returns AIDs only, never Gene IDs.
- **Protein accession (UniProt)** — from the targets of an assay summary (`pubchem_get_summary`), or the target accession on a bioactivity row.
- **Gene symbol** — `pubchem_search_assays` wants the official symbol (`PTGS2`); an alias such as `COX-2` matches nothing. Gene and protein summaries list aliases and the species once you hold the Gene ID or accession.
- **Taxonomy ID** — from a gene or protein summary.

## Gates

**Resolve before calling per-CID tools.** Every compound tool takes a CID. When a name could mean a salt, a hydrate, or a mixture, have the search return the formula or SMILES beside each CID and check it before using the CID.

**Pick parent or salt on purpose.** Use the parent CID for bioactivity, targets, and 3D: a salt or mixture may have no computed conformer (CID 14219 has none; its parent 4091 does). Use the salt CID when the question is about the marketed form's identity or hazards. When a bioactivity profile looks thin, check the other form.

**An unrecorded structure is not an error to retry.** A SMILES that resolves to no CID is not in PubChem, so there are no properties, hazards, or conformers to fetch. To find recorded neighbors, run a similarity search with the SMILES itself as the query, which works for structures PubChem has never seen, or a substructure search on a fragment of it.

**Gene symbols cross species.** An assay search by gene symbol matches it case-insensitively across organisms: `PTGS2` also returns mouse and bovine COX-2 assays. For one species, search by Gene ID or UniProt accession.

**Gene ID and accession are different nets.** For one protein, assay searches by Gene ID and by UniProt accession return overlapping but different AID sets, each missing assays recorded only under the other. The bioactivity target filter widens across the two only where the compound's own assay table pairs them, so sapitinib returned one EGFR assay by Gene ID and several different ones by UniProt accession. For coverage, query both identifiers and merge by AID. The compound's target entries can list one protein twice for the same reason.

**Protein-name search matches deposited text.** It is not an alias lookup: `cyclooxygenase-2` finds a handful of assays where the symbol finds well over a thousand. Prefer symbol, Gene ID, or accession.

**Check an AID before listing its compounds.** A target's AID list includes RNAi screens that tested no compounds, assays on orthologs, and multi-target assays. Read the assay summary's method, targets, and compound count first.

**Absence is not a finding.** No bioactivity rows, no target entries, `no_ghs_data`, or no drug–food records mean nothing was deposited, not that the compound is inactive, safe, or interaction-free. `cid_not_found` from the safety tool means the identifier is wrong; the bioactivity tool, by contrast, answers a CID with no record exactly as it answers a compound with no assays, so confirm the CID resolved before reading an empty profile. Drug–drug interactions are not available from this server; route that question to a drug-label source.

## Reading bioactivity

- **"Active" is the depositor's call.** Thresholds differ by depositor: AID 46697, extracted from a paper, marks every compound it tested Active, celecoxib among them at an IC50 of 1 µM. Judge potency by the activity value, not the label. Unspecified is not Inactive.
- **Values are in µM, and one pair spans formats.** Celecoxib against human COX-2 gives an IC50 of 0.002 µM in transfected CHO cells and 1 µM in human whole blood. Report a range with the assay context, not one number.
- **Rows are not ranked by potency.** To find the strongest result, page the filtered set and compare values; restrict to confirmatory assays for dose-response data.
- **Target-entry order is not target importance.** Entries sort by their single lowest Active value across every measurement type, so one high-throughput AC50 can outrank a target with hundreds of Active assays: celecoxib's first entry is androgen receptor, ahead of COX-2. Weigh the assay counts and the measurement type before naming a compound's targets. Orthologs are separate entries, each with its own Gene ID.
- **Gene ID cross-references are associations, not targets.** The GeneID list from `pubchem_get_compound_xrefs` runs to hundreds of genes for a common drug, in numeric order. Use the target entries for "what does it hit".

## Workflows

**"Is drug X a Y inhibitor, and how potent?"** Two halves, two tools. Mechanism class: `pubchem_get_compound_details` with classification — FDA mechanisms, MeSH pharmacological classes, and ATC codes answer "is it a COX-2 inhibitor" for drugs those vocabularies cover. Potency: get the Gene ID from the compound's target entries, then filter its bioactivity by that target, the Active outcome, and the confirmatory type; if that comes back thin, repeat with the UniProt accession.

**"Analogs of X with activity on target T."** A similarity search from X's CID returns CIDs with no similarity score, includes X itself, and lists salts as separate CIDs. Low thresholds can return compounds that share little scaffold with the query, so compare SMILES before calling hits analogs. Then check each analog's bioactivity against T, by Gene ID and by accession.

**"Hazards of X."** `pubchem_get_compound_safety`'s merged H-codes are the union of every source, superseded revisions included: acetone's merged list carries NITE-CMC's H305 and H373 beside the EU harmonised H225, H319, and H336. Report the EU harmonised or ECHA aggregate classification when present, and attribute any other code to its source.
