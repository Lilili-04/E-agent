---
description: "Build and query national and catalog-matched provincial environment-policy evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-environment-policy

English | [中文](README.zh.md)

## Summary

This package retrieves national and catalog-matched provincial environmental policy evidence. It inventories and parses Markdown, validates source-backed descriptions, builds SQLite indexes and returns original evidence through `policy_search` and `policy_read`. It does not independently decide legal validity or infer whole-province applicability from a catalog province.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Offline generation and review](#offline-generation-and-review)
- [Build and query the index](#build-and-query-the-index)
- [Startup environment](#startup-environment)
- [Evaluation baseline](#evaluation-baseline)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Local v2 trial

Mount `./v2-service` and `./v2-tools` together. The separate SQLite snapshot has two business tables, `documents` and `content_units`, and two FTS5 indexes. Jieba segments source and query text; native BM25 ranks title/description or body matches. `policy_search` discovers versions or passages; `policy_read` reads a selected version consecutively. The existing DGX provider is independent of this local trial.

From the repository root, prepare national sources with `python scripts/prepare-policy-v2.py --workspace .. --legacy data/policy-national-v1.sqlite --output .dsh-build/policy-v2-documents.jsonl --corpus national`, then build with `node --import tsx/esm scripts/build-policy-v2.ts .dsh-build/policy-v2-documents.jsonl data/policy-v2-trial.sqlite`. Choose a fresh output filename; the builder refuses overwrites. Python needs `openpyxl`. Input Markdown, descriptions and workbook remain outside Git. Import audit and legacy-vector mapping JSON files accompany the prepared source file; mismatched descriptions and placeholder metadata are excluded.

Provider settings are `path`, optional `semanticConfigPath` plus exactly one of `compatibilityPath` (legacy vectors) or `vectorManifestPath` (combined vectors), and bounds `candidateLimit`, `guidedCandidates`, `maxEvidencePerDocument`, `resultLimit`, `pageCharacters`, `evidenceCharacters`. The semantic JSON supplies DGX embedding/Chroma URLs, model, collections and timeout. Existing vectors require matching build, source hash and original span; failures are reported and BM25 remains available. Search never writes a collection. Coverage follows the existing national vector snapshot.

For the combined runtime, follow the [local Harness guide](../../../deploy/local-vectors/README.md#harness). Startup validates the manifest against the SQLite file hash, model, dimensions, metrics, and collection names. Search embeds the unchanged question once, with a bounded transport retry, and filters each region and optional document scope before vector retrieval. BM25 and vector candidates use independent per-region budgets; RRF fuses source-validated results, balances regions, limits evidence per document, and combines adjacent units in the same section. `unit_ids` preserves the original members of merged evidence. Exact articles and full reads remain SQLite operations. Partial vector failures are visible warnings and retain available BM25 evidence.

Optional `latestManifestPath` selects a SQLite-hash-bound offline allowlist built by `scripts/build-policy-latest.py`. The local launcher requires `deploy/local/policy-latest.json`. Ordinary requests filter exact, BM25, combined vector and document-guided candidates to each regulation’s latest stored body before ranking; this does not establish current legal validity. Version identities come from the reviewed graph export, with dates and same-identity whole-version revision links determining order. Ties, unknown order and contradictory ordering remain excluded for review; a missing latest body never falls back to an older body. Named unavailable identities return `latest_version_unavailable` with a reason. Explicit years, document numbers, historical or validity intent use the graph path; quoted title words alone do not imply history. Ordinary reads retain offline source-completeness flags.

Optional `graphConfigPath` enables historical version, lineage and validity requests inside `./v2-service`, without adding a tool or listener. The graph is loaded lazily: the first historical operation checks frozen graph/SQLite hashes and verifies identities, locators and events against the existing local Neo4j partition; subsequent historical operations reuse that verified snapshot until provider reload. Unavailable or mismatched graphs fail historical operations explicitly. Ordinary search and reads without `version_id` never load or call the graph. The local launcher retains all partitions.

Historical requests resolve graph identities before missing-title and article routes. Search returns bounded `graph` version cards and one-hop history; ordinary body retrieval retains BM25/Chroma. `selected_version_ids` distinguishes matched versions from related endpoints; `truncated` reports incomplete lists. Events separate the issuing version from the surviving evidence source, and unresolved targets retain `target_version_id=null`. Missing repeal events never establish current validity; unknown dates and review flags are retained. Read `events.sources` before drawing history conclusions. Supplemental sources absent from SQLite have no readable locator.

For graph `read_sources`, pass both physical `document_id` and `version_id` to `policy_read` and preserve them during pagination. `text_role=body` reads that version's available source; `attachment` restricts reading to the verified bundled range; `history_evidence` returns only surviving history references and refuses article/section requests for the missing historical body. The latter two report `source_complete=false`. Cursors bind source hash, graph version and range; no newer body substitutes for a missing old version. Graph output has a separate character budget and adds context tokens without model or embedding round trips.

For a combined offline snapshot, run `python scripts/prepare-policy-combined.py --workspace .. --national-db data/policy-v2-national-presentation-r2.sqlite --output .dsh-build/policy-combined.jsonl`, then pass that JSONL and a fresh SQLite filename to `scripts/build-policy-v2.ts` using the build command above. Python 3.10+ and `openpyxl` are required. Supply the repaired national snapshot at the selected path; its records are copied field-for-field, including IDs and corrected metadata. Only provincial extraction results matching one distinct catalog row are admitted; unmatched, ambiguous and known mismatched records are excluded. The import audit records exclusions, source-quality notes, province counts and the base file hash. No vectors are built. Omit both semantic configuration paths for offline BM25-only use; `semantic_not_configured` is reported explicitly. Existing national vectors do not provide provincial semantic coverage.

`region` is the workbook's province attribution, not a legal applicability assessment. Queries without a specified region search national evidence only; an explicit or question-named province includes national evidence and that province. `region_mode=only` restricts to the selected province; aliases such as 江苏 are normalized to available catalog names. Exact file matches never infer a province; a document outside the selected region is rejected. Compare provinces with separate searches, and verify city, county, watershed and pilot restrictions in the original text. Reading and full-text pagination remain tied to a fixed document ID.

`policy_read` takes `document_id`, `scope` (`full`, `section`, `article`), exact `selector` for sections/articles and optional `cursor`. Continue with `next_cursor` until `has_more=false`. Oversized units span pages with `unit_fragments=true`; missing clauses return `found=false`. `source_complete` concerns the imported source, not legal validity. Search passages marked `excerpted` require further reading. A per-agent, per-turn completion check tracks every document requested for full reading, including multiple named laws and candidate versions, and stops with an error after the configured reminder limit. It cannot verify model interpretation; documents exceeding the context window still depend on compaction.

The tool plugin requires `policy_search` before answering and `policy_read` while only metadata or unfinished full reads are available. Constrained model responses are buffered until the required tool call completes; their text and reasoning blocks are withheld. A response that ignores the tool requirement fails before its answer is displayed. An empty search without a readable source produces an explicit evidence-gap response. Ordinary reads accept only document IDs returned by search in the current turn; graph reads additionally require the returned document/version pair. Independently named laws are retained even when their title lengths differ. These checks establish evidence availability, not the correctness of the model’s interpretation.

For a local Harness with all policy data on DGX, mount `./v2-remote-service` with `endpoint`, `tokenFile` and optional `timeoutMs`/`maxResponseBytes`, followed by the same `./v2-tools`. The client opens no SQLite and has no local fallback. On DGX, `./v2-http` injects the local v2 provider and serves authenticated `GET /v2/policy/status`, `POST /v2/policy/search` and `POST /v2/policy/read`; search/read bodies use the tool request fields. Both sides require a private token file containing at least 32 characters. The listener defaults to loopback port 18081, a 32 KiB request limit and a 15 second deadline. Invalid requests return 400, missing credentials 401 and oversized bodies 413. Client requests support cancellation and a bounded response body. The [DGX guide](../../../docs/user/guide/dgx-deployment.md) owns deployment and local launch configuration.

-----

<a id="use-this-package"></a>
## Use this package

The package is an internal library during the first implementation stage. The source directory is supplied by the caller; the package does not embed the project’s policy corpus or assume a repository-relative path.

```ts
import { buildSourceInventory } from '@deepseek-ai/dsh-experimental-environment-policy'

const inventory = await buildSourceInventory({ sourceRoot: process.env.POLICY_SOURCE_ROOT! })
```

The returned inventory is deterministic for unchanged input files. Each record contains a stable content-based identifier, a normalized path, a SHA-256 hash, candidate Markdown headings, and quality flags. Duplicate content is reported separately so later version and source review can distinguish repeated sources.

Parse one source after inventory:

```ts
import { parsePolicyMarkdown } from '@deepseek-ai/dsh-experimental-environment-policy'

const parsed = parsePolicyMarkdown(sourceId, markdown)
```

Each content unit retains its original text, one-based line span, section path, content hash, and deterministic unit identifier. Parser quality flags describe missing headings, missing article markers, attachment-only sources, empty content, and unstructured documents.

Extract first-pass metadata with evidence:

```ts
import { extractPolicyMetadata } from '@deepseek-ai/dsh-experimental-environment-policy'

const metadata = extractPolicyMetadata(sourceId, markdown, parsed)
```

The returned values are candidates for review. Every extracted date and identifier carries a source line, and `metadataStatus: "pending-review"` is used when deterministic rules find ambiguity or missing information. The workbook `环保政策法规清单.xlsx` is treated as the catalog source for `publishDate`, `legalStatus`, subject area, source path, official URL, and version relation; Markdown remains the evidence source for explicit effective or repeal wording.

Prepare and validate a description request without selecting a model provider:

```ts
import { generatePolicyDescription, prepareDescriptionRequest } from '@deepseek-ai/dsh-experimental-environment-policy'

const request = prepareDescriptionRequest(sourceId, markdown, metadata)
const saved = await generatePolicyDescription(model, request, markdown, new Date().toISOString())
```

The model adapter receives bounded, line-numbered evidence and must return only a description plus source citations. Citation spans, quoted text, description length, source hash, prompt revision, model ID, and review status are checked before persistence. The package does not call a model or read credentials by itself.

The adapter is optional. Step5 can be run entirely offline to prepare requests and validate manually supplied descriptions. If sample descriptions are needed, a child agent may act as the injected adapter and return the same JSON shape; no external model API, key, or provider integration is required. Child-agent output is still untrusted until local validation succeeds.

The reviewable sample shape is:

```json
{
  "description": "本文件规定污染防治工作的适用范围和主要管理要求。",
  "citations": [
    { "lineStart": 12, "lineEnd": 14, "quote": "本办法适用于……" }
  ]
}
```

`generatePolicyDescription` verifies that every citation is present in the original line span and was included in the bounded request. It also records the source SHA-256, prompt revision, adapter model ID, and generation time. Reviewers can move a result from `generated` to `reviewed` or `rejected`; when the source hash changes, the result becomes `stale` and cannot be reviewed until regenerated.

<a id="build-and-query-the-index"></a>
## Build and query the index

The Step6 build script joins inventory, metadata, descriptions, and parsed source units into one derived SQLite index:

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

The optional `--source-root` value defaults to the repository-relative `data/policy_md/national`; use it to record a different portable source-root label when rebuilding from another corpus location.

By default the output database and build manifest are written to `data/policy-national-v1.sqlite` and `data/policy-national-v1-manifest.json`, relative to the repository root. SQLite files in `data/` are local generated corpus artifacts and are ignored by Git; keep the accompanying `data/README.md` so a clone documents how to provide the index. A rebuild is transactional. Each committed manifest records the schema version, build ID, corpus hash, source count, content-unit count, and description count.

Mount `SqliteEnvironmentPolicyKnowledge` with the database path, then mount the `./tools` export after the repository tool and system-prompt services. The query service retains the exact index identity and source locations for internal verification. `policy_search` accepts a natural-language question and an optional ISO `current_date`; its model-facing output contains bounded source passages and citation metadata without internal paths or identifiers. Description text can discover a document, but the returned evidence always comes from a parsed source unit.

[`presets/environment-policy.cordis.yml`](presets/environment-policy.cordis.yml) is an optional group to insert into an Agent preset. It uses the repository-relative `./data/policy-national-v1.sqlite` path. Run DSH from the repository root, or pass an explicit path when launching from another directory. The group isolates the knowledge service and leaves the standard presets unchanged.

The remote provider mounts `./remote-service` instead of the SQLite provider and calls the same retrieval implementation over HTTP. It loads the real build manifest at startup, supports cancellation and timeouts, and reports remote failures without using a local fallback. See the [DGX Docker deployment guide](deploy/README.md).

<a id="startup-environment"></a>
### Startup environment

Start DSH from the same interactive terminal used to install dependencies and build the workspace. Codex command execution uses a separate non-interactive shell, a managed Node runtime, and fallback pnpm. When `node_modules/.modules.yaml` is missing, pnpm rechecks the whole workspace and tries to install dependencies, which can make startup much slower. On a fresh or incomplete dependency tree, run `pnpm install --frozen-lockfile` once, confirm that dependency links are complete, and then use `pnpm run dev:web --skip-build --poll` or `pnpm run start:desktop -- --skip-build` when the build artifacts already exist.

<a id="evaluation-baseline"></a>
## Evaluation baseline

[`eval/cases.ts`](eval/cases.ts) contains 90 deterministic retrieval questions across article lookup, topic discovery, publication date, reported legal status, version history, no-answer, negative, and OCR-sensitive categories. Each case records human-readable expected document titles and whether authoritative evidence should be returned. The package test fixes the case count, unique identifiers, and category coverage. DGX supports optional vector recall; human verification of expected content-unit IDs remains necessary because title matches do not establish article accuracy.

<a id="offline-generation-and-review"></a>
## Offline generation and review

Description schema, citation, hash and review-state validation is deterministic; generation uses a caller-supplied adapter. A caller may use a local rule, a human-written sample, or a child agent as the adapter. In every case, the authoritative Markdown stays in the build environment, and the returned description is only a retrieval aid. It must not replace the source text, catalog metadata, or legal-status review.

<a id="understand-the-implementation"></a>
## Understand the implementation

The library discovers files named `full.md` recursively, hashes their bytes, extracts candidate headings, checks for a sibling PDF, and records quality flags. Deterministic line rules retain headings, legal sections, articles, paragraphs, lists, tables, attachments, images, and fenced blocks with source spans. SQLite stores sources, metadata, content units, descriptions, citations, search terms, and one committed build manifest. Query planning confirms document names against indexed titles. Names, document numbers and article labels use exact retrieval; overviews sample body units across complete documents. Ordinary questions use body BM25; the DGX hybrid adapter adds parallel document and passage vector recall, rank fusion, evidence limits, deduplication and conservative temporal assessment. Vector candidates are hydrated from SQLite and checked against the build identity and source hash.

No runtime invariant companion is published; the SQLite manifest identifies the committed build, and hybrid retrieval checks vector collection build identities and source hashes against SQLite before returning evidence.

<a id="further-exploration"></a>
## Further Exploration

- [Environment policy question answering proposal](../../../.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.md) — the staged capability design.
- [Packages](../../README.md) — package boundaries and workspace conventions.

<a id="model-experience"></a>
## Model Experience

### Policy search tool

#### What the model sees

The optional `./tools` plugin registers `policy_search` and a prompt section. For a document-list question, the model may supply a `topic` copied from the original question; the tool uses it to recall titles and retains the original question for filters and body BM25. Hybrid mode also uses document and passage vector recall; the standalone SQLite provider uses lexical description-assisted recall. Topics absent from the question are ignored, and ordinary retrieval remains available when no topic is supplied. Unless the question asks for history or comparison, the tool keeps the newest publication date for each normalized document title. Multiple passages from the same document share one citation number. Model-facing results renumber citations from one, omit paths and workflow fields, and instruct the model to end with a plain-text numbered source list. The prompt uses plain Chinese for clause explanations, applies catalog legal-status labels directly when asked, distinguishes publication and effective dates, and does not generate source hyperlinks.

#### Token effect

The fixed prompt section and tool schema are present on every request in the optional composition. The optional `topic` is generated in the existing tool-selection model request and adds no model round trip. Each tool call adds bounded evidence text up to `maxEvidenceCharacters` and at most `maxResults` records.

#### KV Cache effect

The prompt section and tool schema are stable for one plugin configuration, so they remain in the reusable request prefix. Search results and the resulting answer append after that prefix; changing either output bound changes configuration, not the fixed model-facing text.

### Policy V2 automatic evidence

#### What the model sees

The local combined composition enables model planning with `planningProvider` and `planningModel`. Before answering, an auxiliary call decomposes the accepted question and selects facts, document discovery, whole-document overview, history or validity retrieval. The backend validates the JSON, retains the original question for geographic restrictions, confirms candidate titles against the existing store and discovers actual sources when an unconfirmed model hint has no applicable text; explicit user titles remain hard constraints. A separate model reviews each task against actual original-source IDs, while the backend rejects invented references, filters ineffective or draft current-law evidence, validates task coverage and executes bounded follow-up queries. Shared original pages are reused across subquestions. Unverified historical repeal dates remain partial coverage, and historical evidence is identified as retained history rather than an original complete version. Both auxiliary inputs and settled outputs are logged as `policy/retrieval-model` before and after dispatch; final verified evidence remains a normal durable `policy-evidence` message. The final model answers directly, preserves gaps and conflicts, hides internal workflow terms, and lists actual sources. Compositions without the planning route retain the legacy automatic search/read path.

#### Token effect

Planning adds one auxiliary model call, followed by a coverage call and bounded review or repair calls. The local composition permits six tasks, ten searches and two coverage rounds; auxiliary calls have a 2048-token output cap and 45-second deadline, and the source-page budget is 24 with eight documents. The backend preserves incomplete coverage when budgets stop execution. `evidenceCharacters` bounds the complete serialized packet, including metadata and graph context; `evidencePages`, `evidenceDocuments` and `retrievalTimeoutMs` bound preparation. Truncation never establishes full-source completeness. Existing SQLite, lexical indexes, Chroma collections and Neo4j data remain read-only.

#### KV Cache effect

The short fixed guidance remains in the stable prompt prefix. Each newly accepted user input appends its prepared evidence, so evidence is reconstructable from the session log rather than hidden in a request callback.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Metadata extraction is a first-pass candidate generator; it does not establish legal validity, current effectiveness, repeal, or version identity. Catalog status is preserved as supplied and is not silently replaced by a Markdown guess.
- Description generation is only a reviewable discovery aid. It cannot replace the authoritative Markdown, metadata fields, or evidence returned by later retrieval tools. A changed source hash marks a saved description `stale`.
- PDF matching currently checks the `extracted` directory containing each `full.md`; a source without a sibling PDF receives a quality flag.
- The query service retains conservative temporal assessment fields for internal callers, while the model tool omits those workflow fields and reports catalog legal-status labels when asked.
- SQLite retrieval and description validation do not require an external API. Description generation uses a caller-supplied adapter, including a child agent; all outputs remain subject to citation, hash, schema and status validation.
- SQLite owns original policy text and metadata; lexical indexes and Chroma vectors are recall aids. Channels return addresses, and the service reads and validates source units in batches before producing citations. Optional DGX hybrid retrieval degrades to lexical evidence when vectors fail; source/index release validation, diagnostics and rollback are documented in the [deployment guide](deploy/README.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
