---
description: "Build and query a local national environment-policy evidence index."
kind: "package-plugin"
---

# @deepseek-ai/dsh-experimental-environment-policy

English | [中文](README.zh.md)

## Summary

This package provides the experimental national environment-policy knowledge capability. It inventories and parses Markdown sources, extracts reviewable metadata, validates model-assisted descriptions, builds a versioned SQLite index, plans policy queries, and exposes bounded source evidence through a Cordis service and `policy_search` tool. It does not index provincial documents or independently decide legal validity.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Offline generation and review](#offline-generation-and-review)
- [Build and query the index](#build-and-query-the-index)
- [Evaluation baseline](#evaluation-baseline)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

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

The output database and build manifest are generated corpus artifacts outside the Git repository. A rebuild is transactional. Each committed manifest records the schema version, build ID, corpus hash, source count, content-unit count, and description count.

Mount `SqliteEnvironmentPolicyKnowledge` with the database path, then mount the `./tools` export after the repository tool and system-prompt services. The query service retains the exact index identity and source locations for internal verification. `policy_search` accepts a natural-language question and an optional ISO `current_date`; its model-facing output contains bounded source passages and citation metadata without internal paths or identifiers. Description text can discover a document, but the returned evidence always comes from a parsed source unit.

[`presets/environment-policy.cordis.yml`](presets/environment-policy.cordis.yml) is an optional group to insert into an Agent preset. Set its database path to the generated index. The group isolates the knowledge service and leaves the standard presets unchanged.

<a id="evaluation-baseline"></a>
## Evaluation baseline

[`eval/cases.ts`](eval/cases.ts) contains 90 deterministic retrieval questions across article lookup, topic discovery, publication date, reported legal status, version history, no-answer, negative, and OCR-sensitive categories. Each case records human-readable expected document titles and whether authoritative evidence should be returned. The package test fixes the case count, unique identifiers, and category coverage. A fixed-index runner and human verification of expected content-unit IDs remain Step 9 work before the baseline can justify adding semantic vector recall.

<a id="offline-generation-and-review"></a>
## Offline generation and review

The package itself remains deterministic and model-agnostic. A caller may use a local rule, a human-written sample, or a child agent as the adapter. In every case, the authoritative Markdown stays local, and the returned description is only a retrieval aid. It must not replace the source text, catalog metadata, or legal-status review.

<a id="understand-the-implementation"></a>
## Understand the implementation

The library discovers files named `full.md` recursively, hashes their bytes, extracts candidate headings, checks for a sibling PDF, and records quality flags. Deterministic line rules retain headings, legal sections, articles, paragraphs, lists, tables, attachments, images, and fenced blocks with source spans. SQLite stores sources, metadata, content units, descriptions, citations, search terms, and one committed build manifest. Query planning applies exact metadata filters first, then portable lexical and description-assisted recall, deterministic ranking, evidence limits, and conservative temporal assessment.

No runtime invariant companion is published because the immutable SQLite manifest is the sole runtime index identity and the package maintains no independent projection that can diverge from it.

<a id="further-exploration"></a>
## Further Exploration

- [Environment policy question answering proposal](../../../.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.md) — the staged capability design.
- [Packages](../../README.md) — package boundaries and workspace conventions.

<a id="model-experience"></a>
## Model Experience

### Policy search tool

#### What the model sees

The optional `./tools` plugin registers `policy_search` and a prompt section. For a document-list question, the model may supply a `topic` copied from the original question; the tool uses it to recall titles and retains the original question for filters and BM25 content and description search. Topics absent from the question are ignored, and ordinary retrieval remains available when no topic is supplied. Unless the question asks for history or comparison, the tool keeps the newest publication date for each normalized document title. Model-facing results renumber citations from one, omit paths and workflow fields, and instruct the model to end with a plain-text numbered source list. The prompt uses plain Chinese for clause explanations, applies catalog legal-status labels directly when asked, distinguishes publication and effective dates, and does not generate source hyperlinks.

#### Token effect

The fixed prompt section and tool schema are present on every request in the optional composition. The optional `topic` is generated in the existing tool-selection model request and adds no model round trip. Each tool call adds bounded evidence text up to `maxEvidenceCharacters` and at most `maxResults` records.

#### KV Cache effect

The prompt section and tool schema are stable for one plugin configuration, so they remain in the reusable request prefix. Search results and the resulting answer append after that prefix; changing either output bound changes configuration, not the fixed model-facing text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Metadata extraction is a first-pass candidate generator; it does not establish legal validity, current effectiveness, repeal, or version identity. Catalog status is preserved as supplied and is not silently replaced by a Markdown guess.
- Description generation is only a reviewable discovery aid. It cannot replace the authoritative Markdown, metadata fields, or evidence returned by later retrieval tools. A changed source hash marks a saved description `stale`.
- PDF matching currently checks the `extracted` directory containing each `full.md`; a source without a sibling PDF receives a quality flag.
- The query service retains conservative temporal assessment fields for internal callers, while the model tool omits those workflow fields and reports catalog legal-status labels when asked.
- It does not choose a model provider or require an external API. An injected adapter can generate descriptions, including through a child agent, but all outputs remain subject to local citation, hash, schema, and status validation.
- Retrieval currently uses exact metadata predicates, Chinese bigrams, Latin terms, and description-assisted recall. It does not require a vector database, and semantic embeddings can be added later behind the query-store interface if evaluation shows a recall gap.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
