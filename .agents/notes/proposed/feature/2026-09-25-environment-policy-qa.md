# Agent Note: Environment policy question answering

Status: proposed

English | [中文](2026-09-25-environment-policy-qa.zh.md)

## Problem

The project needs a first environment-domain Agent that answers questions from national environmental laws, regulations, standards, plans, and policy documents. The current corpus contains 494 national `full.md` documents beside the Harness checkout. These documents mix formal rules, plans, notices, historical versions, drafts, attachments, and OCR outputs. A plain prompt or vector-only RAG cannot reliably select a legally applicable version, preserve exact numbers and negation, or provide reproducible evidence.

## Proposal

Build the capability as an optional Harness plugin composition. Keep source documents outside the Harness repository and make their root an explicit plugin configuration value. The plugin owns an offline import/index pipeline, a query service, model-facing tools, and an environment-policy Agent preset. The Agent Loop remains unchanged.

### Scope of the first release

The first release covers the national corpus only. It supports document discovery, clause or section retrieval, evidence display, and date-aware filtering when the source metadata is verified. It does not claim that every document is currently effective, and it does not automatically confirm legal validity from a filename or model knowledge. Provincial documents, full legal ontology extraction, automatic clause lineage, graph database deployment, and autonomous legal advice remain outside the first release.

### Source and generated-data boundary

`policy_md/national` remains the source corpus. The importer reads `full.md`, related extraction metadata, and optional PDFs without copying them into Git. SQLite databases, FTS indexes, embeddings, import reports, and caches are rebuildable outputs and remain outside commits. The plugin fails clearly when the configured corpus root is missing or unreadable.

### Import and document model

The importer creates stable records for `source_document`, `regulation`, `regulation_version`, `content_unit`, `version_relation`, and `review_record`. A source file is not automatically a regulation version: several sources may duplicate one version, and one regulation may have many historical versions. A content unit can be an article, paragraph, list item, section, table, or attachment, because not every policy document uses article numbering.

Each source stores its path, content hash, extraction timestamp, candidate title, document type, and extraction-quality status. Each version stores separate publication, effective-start, effective-end, ingestion, extraction, and review times. Missing dates remain unknown. A null end date means “no end date is recorded”, not “the version is confirmed effective today”. The status vocabulary distinguishes verified effective, verified inactive, draft, repealed, superseded, and unresolved.

The parser preserves source line spans, section paths, article/paragraph labels, and the original text. It must handle a publishing order or notice before the document title, attachment-only files, tables, and OCR anomalies without inventing missing text. A deterministic report lists title conflicts, short files, duplicate hashes, missing metadata, and low-confidence structural parses.

### Description generation

Generate one description per document version, not one permanent description for a regulation entity. The description is an 80–200 Chinese character discovery aid for document lists and document-level retrieval. It records the source hash, prompt revision, model identifier, generation time, and review status. It must not assert current validity, nationwide applicability, or facts absent from the source. A changed source invalidates the description.

Descriptions are never legal evidence. Clause text, section text, and verified metadata remain the only answer evidence. The existing `policy_prompt.md` supplies the initial extraction principles; the importer preserves the complete Markdown even when the description model is truncated or uncertain.

### Index and retrieval order

The first implementation uses SQLite for metadata and a rebuildable full-text index. It adds exact indexes for title, aliases, document number, standard number, article number, and dates. Chinese full-text behavior must be measured with a representative evaluation set; character or phrase matching may supplement FTS for names, numbers, dates, and legal modal words.

Each query is normalized into optional intent, date or date range, jurisdiction, document type, regulation name, subject, activity, article number, and comparison request. Retrieval applies constraints before semantic ranking whenever possible:

1. Resolve explicit regulation names, document numbers, article numbers, and dates.
2. Filter candidate versions by jurisdiction, document type, status, and verified temporal facts.
3. Retrieve content units with exact and full-text matching.
4. Add description-level matches for conversational or vague queries.
5. Optionally add vector candidates as a recall supplement.
6. Rerank with field matches, section structure, source quality, and temporal compatibility.
7. Return a bounded evidence package containing the original text, source span, version dates, status, and match reasons.

Vector retrieval is deferred until the evaluation set shows that lexical retrieval misses paraphrased questions. A vector index may improve recall, but it cannot decide validity, override exact numbers, or replace article and date checks. A graph database is also deferred; version and relation tables are sufficient until lineage queries require graph traversal.

### Harness integration

The plugin exposes a knowledge service with operations equivalent to `search`, `getEvidence`, `findVersions`, and `resolveTemporalStatus`. A separate model-facing tool registers through `ctx.tools` and returns canonical JSON with document, version, content-unit, evidence, and uncertainty fields. A second evidence tool can retrieve the full text for a selected result. Tool output is bounded and cancellation-aware, and durable tool calls remain reconstructable from the Session log.

The composition adds a system-prompt section through `ctx.systemPrompt`. The section requires evidence-first answers, separate publication and effective dates, explicit uncertainty, and citations to the returned source. An Agent preset composes the policy tools and prompt while leaving the standard Agent unchanged. Existing web-search tools may be used for external official-source checks, but external results are labeled as unindexed or unreviewed and cannot silently replace local verified records.

### Answer contract

An answer contains a direct conclusion, the selected document version, effective-time interpretation, article or section reference, short source quotation, source path or official URL, and an uncertainty statement when metadata is incomplete. The model receives only the evidence package for substantive claims. When no verified evidence supports a conclusion, the tool result states that the system cannot confirm the answer and may list the closest candidates.

### Delivery stages

1. Inventory and quality report for all 494 national documents.
2. Sample import for 50–100 documents covering laws, regulations, plans, standards, notices, drafts, attachments, and historical versions.
3. SQLite schema, deterministic Markdown parser, description generator, and exact/full-text retrieval.
4. Query service and evidence package tests.
5. Harness tool, system-prompt contribution, and selectable Agent preset.
6. Evaluation set of 80–150 questions covering article lookup, conversational topics, dates, versions, drafts, numbers, negation, no-answer cases, and malformed OCR.
7. Full national import after the sample passes; then decide whether vector retrieval is justified.
8. Later work may add version relations, clause alignment, deterministic text diffs, and provincial data.

## Concrete implementation steps

The implementation proceeds in small, reviewable changes. Each step has a durable input, an output that can be inspected without the model, and a focused verification command or fixture. The first usable path stops after Step 8; later steps add recall and temporal reasoning only after the evidence path is stable.

### Step 1: Create the feature branch and package boundary

Create a feature branch from the clean Harness checkout. Before adding source files, inspect the package-generation and package-constraint instructions and choose one new package for the policy capability. Keep the package independent from `core/agent-loop`, `web-search-*`, and Session persistence. Record the corpus root, generated-index root, and runtime profile in the design note before implementation.

**Output:** a package skeleton, a README scope statement, a configuration type for the corpus root, and a first commit containing no corpus data.

**Verification:** package metadata and workspace constraints pass; the package loads with a missing corpus root and reports a clear configuration error rather than silently doing nothing.

### Step 2: Build the source inventory

Write an offline inventory command that scans the configured national directory for `full.md`. For every file, record the source path, matching PDF and extraction directory when present, byte length, SHA-256 hash, first detected headings, and a stable source identifier. Do not infer legal status from the directory name. Mark files with missing companions, very short content, duplicate hashes, or likely OCR failures.

**Output:** a versioned inventory schema and a JSON or CSV quality report that identifies the 494 input documents and all exceptions.

**Verification:** running the inventory twice produces the same identifiers and counts; moving the corpus root through configuration does not change source identity for unchanged content.

### Step 3: Implement deterministic Markdown structure parsing

Parse headings, article labels, paragraphs, list items, tables, attachments, and source line spans without rewriting the original text. Detect common legal patterns such as `第一章`, `第一节`, `第一条`, Chinese numbered paragraphs, and numbered list items. Also support documents that contain plans or notices without article numbers. Preserve a generic `content_unit` for text that does not match a legal pattern.

**Output:** parser records with parent-child relationships, section paths, labels, source line ranges, text hashes, and a parse-quality code.

**Verification:** fixtures cover a law with a publishing order, a multi-version law, a plan, a notice with an attachment, a table, and an OCR anomaly. Every fixture round-trips to the original text and line span.

### Step 4: Extract document and version metadata

Extract candidate title, document type, issuing authority, jurisdiction, document number, publication date, effective start, effective end, revision wording, draft status, and referenced instruments. Keep each value with its extraction method and confidence. Prefer explicit text in the document over path hints, and retain both when they disagree. A human-review record resolves conflicts; automatic extraction never overwrites a reviewed value.

**Output:** normalized `regulation` and `regulation_version` records plus a review queue for missing or conflicting metadata.

**Verification:** tests distinguish publication date, effective date, planning period, and revision date. A source with no effective date remains unresolved instead of being labelled current.

### Step 5: Generate and review descriptions

Run description generation only after the source inventory and document metadata exist. Give the model the complete Markdown or bounded evidence chunks and require a JSON object containing the description and cited source spans. Keep the local importer responsible for storing the original Markdown; the model must never return the authoritative body text. Store prompt revision, model identifier, source hash, generation time, and review state.

**Output:** one description per document version, with `generated`, `reviewed`, `stale`, or `rejected` status.

**Verification:** descriptions for laws, plans, standards, notices, and repeal announcements preserve scope and modality; a changed source hash invalidates the old description; a description cannot change temporal status fields.

### Step 6: Create the SQLite schema and rebuildable indexes

Create tables for sources, regulations, versions, content units, relations, descriptions, and review records. Add exact indexes for normalized title, aliases, document number, standard number, article label, and date fields. Add a full-text index over title, description, section path, labels, and content text. Keep database creation in an offline command so the runtime plugin only opens a prepared index.

**Output:** a schema version, an importer that can drop and rebuild the database, and a deterministic index manifest containing corpus hash, schema version, and build time.

**Verification:** rebuilding from the same corpus produces the same logical rows and search results; the database is outside Git; an incompatible schema version fails loudly and requests a rebuild.

### Step 7: Implement the query planner and evidence package

Parse a user query into explicit filters and a free-text expression. Resolve exact names, document numbers, article labels, dates, and comparison intent first. Apply jurisdiction, document type, review status, and verified temporal filters before ranking. Search exact fields and full text, then optionally description fields. Return a bounded evidence package with stable result IDs, original text, source spans, version dates, status, review state, and match reasons.

**Output:** a pure query service API and fixtures for exact, topical, date-aware, historical, draft, and no-answer questions.

**Verification:** each fixture asserts the selected source, content-unit ID, temporal status, and evidence text. A result with unresolved temporal metadata cannot appear as a verified-current result.

### Step 8: Register the Harness service and tools

Add the knowledge service provider and a model-facing `policy_search` tool. Add `policy_get_evidence` only when the search result needs full text or additional source spans. Use `defineTool` with bounded parameters, canonical JSON output, cancellation through the execution signal, and structured errors for missing indexes or unavailable corpus roots. Register a prompt section that describes when to search, how to cite evidence, and how to state uncertainty.

**Output:** a Cordis composition that mounts the service, tools, and prompt section; a preset that enables the environment-policy Agent without changing the standard preset.

**Verification:** a tool call is visible in the Session log and can be replayed; disposing the plugin unregisters the tool; the standard Agent has no policy tool unless its composition enables it.

### Step 9: Build the evaluation set before adding vectors

Create 80–150 manually checked questions and expected evidence IDs. Include exact article lookups, conversational descriptions, document numbers, dates before and after an amendment, repealed instruments, drafts, numbers, negation, attachment-only sources, OCR defects, and questions with no supported answer. Score evidence recall separately from answer faithfulness.

**Output:** replayable retrieval fixtures and a report that identifies whether errors come from parsing, metadata, filtering, ranking, or answer generation.

**Verification:** the report is deterministic for a fixed index; every expected answer cites an evidence ID rather than only free-form text.

### Step 10: Add vector retrieval only when the evaluation requires it

If lexical and structured retrieval miss paraphrased questions, add an embedding provider behind the same query service. Embed content units and optionally descriptions, record embedding model and corpus hash, and use vectors only to add candidates. Apply exact and temporal checks again after vector recall. Keep vector generation offline and make the provider replaceable; do not make the runtime depend on a hosted vector service for the first deployment.

**Output:** a hybrid ranker with an evaluation comparison against the lexical baseline.

**Verification:** vector retrieval improves recall without introducing incorrect dates, article numbers, numeric limits, or draft/current substitutions in the accepted evidence set.

### Step 11: Add version relations and comparison after basic QA is stable

Represent amendment, replacement, repeal, reference, renumbering, split, and merge relations in relation tables. Use structure, labels, lexical similarity, and numeric comparison to produce candidates. Require review for low-confidence edges. Implement deterministic structural and text diffs first; let the model summarize only supplied diffs and source text.

**Output:** `policy_compare_versions` and an audited relation review queue.

**Verification:** every reported change points to an old and new content unit; the model cannot create a relation without stored evidence.

### Step 12: Full import, release checklist, and update cycle

After the sample corpus and evaluation gates pass, import all 494 documents. Publish the index manifest and quality report beside the local runtime configuration, not in Git. Define an update command that detects new hashes, reprocesses changed files, invalidates descriptions and embeddings, and leaves unresolved metadata in the review queue. Add a separate release checklist for replacing an index used by the Agent.

**Output:** a reproducible national-corpus index, a review backlog, and an update procedure ready for later provincial data.

**Verification:** a changed source updates only affected records; a failed import does not delete the last known-good index; the Agent reports the index build identifier with its evidence.

### Git and verification

Implementation uses a feature branch in `deepseek-harness`. Commits are separated into importer/model, index/retrieval, Harness tool, preset, and evaluation changes. The corpus, PDFs, generated databases, credentials, and runtime logs are never committed. Each stage runs the smallest relevant typecheck, lint, unit tests, documentation checks, and `git diff --check`; tool-visible behavior receives focused tests and replayable evidence fixtures.

## Alternatives considered

### Why not prompt-only retrieval?

Prompt-only context cannot enforce version filtering, repeatable source spans, or bounded evidence. It also consumes context on irrelevant documents.

### Why not vector-only retrieval?

Vector similarity is weak for article numbers, dates, numeric thresholds, negation, and legal status. It is an optional recall layer, not the authority for applicability.

### Why not modify the Agent Loop?

The capability is a tool, knowledge service, and preset composition. Changing the loop would enlarge the maintenance surface without improving the legal data model.

### Why not deploy a graph and vector database immediately?

The initial corpus is small enough for a local rebuildable index. External databases add deployment and migration cost before retrieval quality has been measured.

## Acceptance criteria

- The importer processes the national corpus deterministically and reports every unresolved or low-quality record.
- A query can return exact document, version, section, original text, source span, and temporal-status evidence.
- Missing dates and unverified status are not converted into claims of current validity.
- The environment-policy tool is available only through its composition and does not change the standard Agent Loop.
- Fixed questions measure both evidence recall and answer faithfulness.
- Generated corpora and indexes are reproducible and absent from Git commits.

## Risks

OCR errors, ambiguous titles, duplicate historical versions, incomplete effective dates, and attachment-only documents can produce plausible but wrong answers. Description generation can improve discovery while introducing unsupported summaries. Low-confidence metadata and relation matches therefore remain explicitly reviewable. A legal answer is limited by the local corpus and its verification state; external updates require a new import and review cycle.
