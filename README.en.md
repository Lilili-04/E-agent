# E-agent: Environmental Policy Q&A System

English | [中文](README.zh.md)

E-agent uses DeepSeek Harness to retrieve environmental policy sources before generating cited answers. This revision handles national material only.

## Reading guide

- [Capabilities and scope](#scope)
- [Architecture and question-answering flow](#architecture)
- [Multiple recall channels](#retrieval)
- [Deployment arrangements](#deployment)
- [Startup and updates](#startup)
- [Database viewers](#db-viewers)
- [Collaboration and data](#collaboration)
- [Verification and limitations](#verification)
- [Documentation](#documentation)
- [License](#license)

<a id="scope"></a>

## Capabilities and scope

The tools support titles, identifiers, articles, topics and whole-document summaries. The new sample snapshot has 495 deduplicated national documents and 63,175 source units, approximately 84.4 MiB; neither data nor corpus enters Git. Provincial material is excluded. Status labels come from the catalog, not an independent determination of legal validity.

<a id="architecture"></a>

## Architecture and question-answering flow

The new deployment runs retrieval inside the Harness container. SQLite sources remain on the host and are mounted read-only; Chroma, embedding and answer models remain separate services. No SQLite server or old retrieval API is required in this flow. The repository retains the old API for existing installations; updating code does not itself update DGX.

```text
User → Harness → Answer model calls policy_search
                    ├─ Exact lookup / Jieba＋BM25 → Mounted SQLite
                    └─ Embedding → Chroma → Validate and read SQLite sources
          Model calls policy_read as needed → Article / section / full pages
          Model answers from source evidence → User
```

`documents` stores version-specific titles, identifiers, dates, status, descriptions, full text and paths. `content_units` stores original articles, headings and paragraphs with order, section and line addresses. Two FTS5 indexes search title/description and body; their shadow tables are not business tables. Descriptions aid discovery, while answers cite original text.

`policy_search` returns document candidates or passages; `policy_read` reads an immutable document version without relevance recall. Whole-document summaries must read consecutive pages until `has_more=false`; oversized units can span pages. Versions remain distinct, and publication date alone never establishes current validity.

<a id="retrieval"></a>

## Multiple recall channels

Code rules select channels: explicit laws and articles use exact lookup; whole-document summaries identify a file then read it; a topic within a named law scopes body retrieval; general topics fuse body BM25, document vectors and passage vectors. The answer model chooses tool calls and interprets the returned evidence.

Jieba segments both source and query, and native SQLite FTS5 BM25 ranks lexical matches. Fusion retrieves original text. Existing DGX vectors require matching build ID, source hash and source span. Semantic failures are reported while BM25 remains available. Queries never rebuild vectors automatically.

<a id="deployment"></a>

## Deployment arrangements

| Arrangement | Harness / SQLite | Vectors and models |
| --- | --- | --- |
| A. DGX Web application | Harness container with a read-only host SQLite mount | Separate DGX containers |
| B. Local Web application | Local Harness; DGX SQLite through the v2 API | DGX containers |

See the [DGX guide](docs/user/guide/dgx-deployment.md) for A. B uses the v2 API and local launch configuration in the same guide, supports remote `policy_read` pagination and requires no local SQLite. The old port 18080 API remains for compatibility. Offline development can still use a matching SQLite snapshot.

<a id="run"></a>

<a id="run-from-source"></a>

<a id="startup"></a>

## Startup and updates

Configure the read-only data directory, vector collections, model endpoint and secret file through `deploy/dgx/.env.example`. Prepare SQLite and its matching `policy-v2-documents.compat.json` before startup. After merging, a maintainer deploys data and application; see the [DGX guide](docs/user/guide/dgx-deployment.md).

```bash
cd deploy/dgx
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose config --quiet
docker compose build
docker compose up -d --wait
```

When dependencies, configuration and data are unchanged, use `docker compose restart harness`. Rebuild the image after code changes; publish changed SQLite and mapping together in a new directory, retaining the old directory for rollback. Do not copy Windows node_modules or private launch patches to Linux.

When local dependencies and artifacts exist, launch without reinstalling or rebuilding data. User terminals and Codex execution can differ in Node, pnpm, proxies and dependency links; a missing `node_modules/.modules.yaml` can cause a full workspace relink and slow startup. See the [package guide](packages/experimental/environment-policy/README.md) for tools, settings and offline builders.

<a id="db-viewers"></a>

## Database viewers

One optional DGX deployment provides Datasette and ChromaDB UI. After switching SQLite, point its read-only viewer mount at the same snapshot. Viewers run independently of Harness; see the [viewer guide](deploy/db-viewers/README.md).

<a id="collaboration"></a>

## Collaboration and data

Git contains code, lockfiles, templates and documentation, excluding SQLite, corpus, summaries, vectors, models, credentials and private runtime records. Collaborators need a SQLite snapshot, matching vector mapping, DGX endpoints and model credentials; rebuilding additionally needs original Markdown, summaries and catalog. Dependabot and Renovate remain disabled.

<a id="verification"></a>

## Verification and limitations

Local evidence includes seven tool/tokenization/paging/vector-link tests, ten real retrieval queries and DGX-model summaries of the Water and Soil Conservation Law and Nuclear Safety Law. Reassembling 1,068 pages across all 495 documents reproduces imported text; this is neither a PDF audit nor an answer-accuracy measurement.

Topic candidates can be broad and versions can contain similar provisions. Thirty-eight sources lack an unambiguous catalog match; one stale summary is excluded by hash. Existing vector mappings cover 493 unchanged old source records; BM25 also searches new or changed text. Whole-document synthesis beyond model context depends on retained compaction detail.

<a id="documentation"></a>

## Documentation

- [DGX application](docs/user/guide/dgx-deployment.md): mounts, configuration, startup and rollback.
- [Retrieval plugin](packages/experimental/environment-policy/README.md): tool settings and offline indexing.
- [Old retrieval service](packages/experimental/environment-policy/deploy/README.md): maintenance for installations still using that API.
- [Database viewers](deploy/db-viewers/README.md): read-only DGX browsing.
- [Development guide](docs/development.md): repository builds and checks.

<a id="license"></a>

## License

The project retains upstream [LICENSE](LICENSE); dependency licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
