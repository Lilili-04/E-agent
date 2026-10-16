# E-agent: Environmental Policy Q&A System

English | [中文](README.zh.md)

E-agent uses DeepSeek Harness (DSH) to provide retrieval-augmented generation (RAG) for national-level Chinese environmental laws, regulations, standards, plans, and policy documents. The system retrieves original passages before the model composes an answer with sources.

Users can access the DGX Web UI directly; developers can also run Harness locally and connect to DGX retrieval and model services. The application, retrieval service, vector database, and models are maintained separately. The Harness image contains no corpus, database, or model weights.

## Reading guide

- [Capabilities and scope](#scope)
- [Architecture and question-answering flow](#architecture)
- [Multiple recall channels: three categories, four branches](#retrieval)
- [Choose how to use or deploy](#deployment)
- [Start, restart, and update](#startup)
- [DGX database viewers](#db-viewers)
- [Collaboration and data preparation](#collaboration)
- [Verification and common issues](#verification)
- [Code and documentation](#documentation)
- [License](#license)

<a id="scope"></a>

## Capabilities and scope

The system locates source text by policy title, document number, or article, discovers policies by topic, and uses indexed material to answer questions about provisions, summaries, publication dates, legal status, and versions.

The current SQLite index contains **494 national documents and 61,455 content units**; the database is approximately **835 MiB**. A content unit can be an article, paragraph, list, or heading, rather than an entire document. Provincial documents are not included.

Answers depend on corpus coverage, parsing quality, metadata, and model interpretation. Legal status comes from catalog records; the system does not independently determine legal validity. Some document-number and date metadata remains malformed. Returned evidence, title matches, or passing functional tests do not establish answer accuracy.

<a id="architecture"></a>

## Architecture and question-answering flow

The architecture separates original data, retrieval indexes, and the coordinating service. SQLite owns policy content, while Chroma provides a rebuildable semantic index. The retrieval API is a service above the databases. Logical responsibilities and container counts are separate concerns.

Here, “retrieval API” usually means the policy retrieval backend running on DGX; strictly, the API is that program's public HTTP interface. `policy_search` sends a question to `POST /v1/policy/search`. The backend applies parsing rules and database retrieval, returning source evidence and retrieval information rather than generating the final answer.

| Component | Responsibility | Deployment and data |
| --- | --- | --- |
| Harness | Provides the Web UI, sessions, agent, and tool execution | Runs locally or in a DGX container, with separate state and workspace storage |
| `policy_search` | Policy query tool called by the model | Runs in Harness and requests the retrieval API over HTTP |
| Retrieval API | Parses questions, coordinates recall, reads sources, and merges evidence | Separate CPU container with a read-only SQLite mount |
| SQLite | Stores source text, titles, dates, metadata, descriptions, and keyword indexes | Independently persisted file opened by the retrieval API; no SQL server container is required |
| Chroma | Stores vectors, source identifiers, and optional text copies | Separate container and persistent directory; text copies are not citation evidence |
| Qwen3-Embedding-4B | Converts questions and index text into vectors | Separate GPU service for semantic retrieval |
| Qwen3.8-27B | Selects tool calls and generates answers from evidence | Separate GPU service accessed through an OpenAI-compatible API |

**Offline indexing**: MinerU parses policy files into Markdown. The indexer combines source inventories, metadata, and descriptions into SQLite, then document and passage embeddings are written to Chroma. Ordinary queries and service restarts do not parse the corpus or rebuild vectors.

**Online questions**: Harness sends the question to the answer model, which requests `policy_search`. The tool calls the retrieval API. After the API returns bounded source evidence, the model continues with an answer and sources. The query planner uses code rules without an additional planning model.

```text
Question -> Harness -> Answer model requests policy_search
                              |
                         policy_search
                              | HTTP
                         Retrieval API
                              |
                    Plan and recall candidates
                              |
                    Merge and deduplicate IDs
                              |
                    SQLite batch source reads
                              |
                 Validate, filter, fuse ranks, limit
                              |
                        Tool evidence
                              |
                  Answer model -> Harness -> User
```

The diagram describes the current repository code. **Updating Harness does not update the separate retrieval API**; verify each image and code version before assuming the server uses this implementation. See the [retrieval deployment guide](packages/experimental/environment-policy/deploy/README.md) for batch source reads, index validation, and releases.

The tool defaults to at most 8 evidence records and 12,000 source characters, rather than an entire law. Multiple passages from one document can share a citation number such as `[1]`. Among returned candidates, the tool prefers the most recently published version of a normalized title unless history or version comparison is requested. This does not guarantee that the corpus contains the latest legal version.

<a id="retrieval"></a>

## Multiple recall channels: three categories, four branches

The three categories are exact, keyword, and semantic recall. Splitting semantic recall gives the following four retrieval branches in hybrid mode. The API selects channels for the question rather than running every branch every time.

| Branch | Example question | Candidate source |
| --- | --- | --- |
| Exact recall | “What is Article 1 of the Nuclear Safety Law?” | SQLite title, document-number, and article lookup |
| Keyword recall | “Which policies concern livestock pollution?” | SQLite title search and body BM25 search |
| Document semantic recall | Find relevant policy documents using natural language | Question vectors match Chroma document vectors, followed by body search within candidate documents |
| Passage semantic recall | Find relevant articles or paragraphs using natural language | Question vectors match Chroma passage vectors and return source locations |

Both semantic branches reuse one question embedding. Channels return source identifiers; the service reads and validates SQLite text to form evidence. Current rank fusion does not require a separate reranker model.

Descriptions help discover documents and contribute to document embedding input; they cannot replace original policy text. They are not a fifth hybrid branch. SQLite-only mode also supports description keyword recall. Vector input varies by build version; see the [retrieval deployment guide](packages/experimental/environment-policy/deploy/README.md) for the rules.

### Who selects tools and recall channels

The model selects the tool, while code rules in the retrieval API select the recall channels. These are separate decisions.

| Decision | Responsible component |
| --- | --- |
| Whether to query policies and what question to submit | Answer model, constrained by the policy Q&A prompt |
| Which recall channels and retrieval conditions to use | Retrieval API query planner, using code rules |
| How to read, filter, rank, and merge candidates | Retrieval API retrieval and evidence code |
| How to explain evidence and list sources | Answer model |

The model-facing `policy_search` parameters are `question`, optional `topic`, and `current_date`; there is no recall-channel selector. The prompt requires tool use before answering policy questions. The model still proposes the actual call, which Harness executes.

### How rules classify questions

The planner parses questions using string matching, regular expressions, and conditionals. It matches catalog titles and names without the “中华人民共和国” prefix, recognizes book-title marks, document numbers, and article labels such as “第二十六条”, and uses overview, date, and legal-status expressions to determine intent and filters. It does not use an additional language model to reason freely about retrieval routes.

- “水土保持法第二十六条是什么？”: after the model calls the tool, the planner identifies the law and article, retrieves the specified provision, and skips semantic recall.
- “养殖场的废水能直接排到河里吗？”: with no explicit target law, hybrid mode with configured vector services runs keyword and semantic recall concurrently; semantic retrieval queries both document and passage collections.

The Embedding model and Chroma calculate similarity within semantic retrieval; planner rules decide whether to enable that channel. Rules support testing and reproduction, but title or intent misclassification can select the wrong channels or miss evidence. Similarity also does not establish that evidence supports a question's premise. See the [query planning code](packages/experimental/environment-policy/src/query.ts) for parsing and channel conditions.

<a id="deployment"></a>

<a id="run"></a>

## Choose how to use or deploy

The project provides the following two deployment arrangements. Both keep policy databases, vector indexes, and database viewers on DGX. Browser-only users do not need to deploy code.

| Arrangement | Use case | Prerequisites |
| --- | --- | --- |
| A. DGX Web application | Daily questions, demonstrations, centralized operation | Browser, LAN access, and an authenticated URL supplied privately by the maintainer |
| B. Local Harness with DGX retrieval | Frontend, tool, or agent configuration development | Source, Node/pnpm, launch configuration, and retrieval/model credentials |

Neither A nor B requires users to download the corpus or model weights. Both use DGX retrieval and model services. Local Harness does not connect to a local policy database; unavailable remote APIs return errors.

The DGX application is at `http://172.27.153.44:3080/`; first access requires the current process's authenticated URL. This instance shares sessions, settings, and workspaces without multi-tenant isolation. The retrieval API at `http://172.27.153.44:18080` serves tool queries rather than chat pages. See the [DGX application deployment guide](docs/user/guide/dgx-deployment.md) for Docker-internal addresses and host ports.

<a id="startup"></a>

## Start, restart, and update

### A. DGX Web application

For initial deployment, follow the [DGX application deployment guide](docs/user/guide/dgx-deployment.md) to prepare state directories, credentials, networking, and the build. The Compose project in `deploy/dgx` manages Harness only and requires retrieval, Chroma, and model services to be running already.

To restart only Harness in an existing deployment, run from the repository directory on DGX:

```bash
cd deploy/dgx
docker compose restart harness
```

Obtain the current authenticated URL from the logs after restart. Source changes require rebuilding the image; `restart` alone does not load new code. Update the retrieval API, SQLite, vector indexes, and models separately using their deployment guides. Stopping or rebuilding Harness does not rebuild their data.

<a id="run-from-source"></a>

### B. Local Harness connected to DGX

New collaborators need the repository's declared runtime: Node.js `^22.19.0 || >=24.0.0`, with pnpm pinned by `packageManager` in `package.json`. Install and build once from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

Then follow the local instructions at the end of the [deployment guide](docs/user/guide/dgx-deployment.md) to prepare a private `DSH_HOME`, retrieval endpoint, token file, and model credentials, and generate launch configuration from the reusable preset. A fresh clone has no `.dsh-build/`; do not use the machine-specific configuration below.

**The existing Windows workspace** already has remote launch configuration. Stop the previous process, then start or restart from the repository root:

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-web.patch.yml --no-open
```

Open the authenticated URL printed in the terminal, normally at `http://127.0.0.1:3080`. This private configuration uses the DGX retrieval API and keeps its token in `.dsh-build/dgx-policy.token`. It may contain absolute local paths and cannot be copied unchanged to another computer.

When dependencies and build artifacts are ready, restarting requires only the launch command. Use the same interactive terminal for installation, build, and launch where possible. Codex execution and the user's terminal can differ in Node, pnpm, proxies, and dependency links. If `node_modules/.modules.yaml` is missing, pnpm may inspect and relink the entire workspace, increasing startup time. Install or build again only when dependencies or build artifacts need updating.

<a id="db-viewers"></a>

## DGX database viewers

A and B share one optional viewer deployment on DGX, regardless of where Harness runs. It is a separate Compose project; stopping or updating it does not stop question answering or rebuild databases.

| Page | Default LAN address | Purpose |
| --- | --- | --- |
| Datasette | `http://172.27.153.44:18101` | Browse SQLite tables, policy text, metadata, and read-only SQL queries |
| ChromaDB UI | `http://172.27.153.44:18102` | Browse collections, records, and metadata; query using existing vectors |

Both pages share a separate login configuration. SQLite is mounted read-only. The Chroma gateway allows reads and queries while rejecting creation, modification, deletion, and resets. Chroma loads at most 500 records per batch; table filters apply to the loaded batch. Viewers do not replace the retrieval API or start additional GPU models.

The repository provides configuration and tests; a maintainer must explicitly deploy these pages on DGX before they become accessible. See the [database viewer deployment guide](deploy/db-viewers/README.md) for credentials, paths, startup, verification, and updates.

<a id="collaboration"></a>

## Collaboration and data preparation

Git stores source, lockfiles, deployment templates, and documentation. SQLite files, policy corpora, vector indexes, model weights, session state, credentials, and private local configuration are prepared separately and excluded from the repository.

| Work | Required beyond source code |
| --- | --- |
| Use the DGX Web UI | LAN access and an authenticated URL |
| Develop locally against DGX | Retrieval endpoint/token, available model/credentials, and local launch configuration |
| Browse DGX databases | LAN access, deployed viewer pages, and a separate viewer login |
| Rebuild SQLite | Source Markdown, inventory, metadata, descriptions, and other build inputs |
| Rebuild vector indexes | Matching SQLite snapshot, pinned Embedding model, input/splitting rules, and Chroma |

See the [data guide](data/README.md) for inputs and the [retrieval deployment guide](packages/experimental/environment-policy/deploy/README.md) for coordinated SQLite/vector validation, releases, and rollback. Distribute authentication links, API tokens, and model credentials privately; never put them in README files or Git.

<a id="verification"></a>

## Verification and common issues

Run the retrieval package's focused checks from the repository root:

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/environment-policy/tests
node_modules/.bin/tsc.cmd -p packages/experimental/environment-policy/tsconfig.json --noEmit
```

These are Windows commands. See the [retrieval evaluation](docs/user/guide/policy-retrieval-evaluation.md) for measurement criteria and reproduction, and the [DGX application deployment guide](docs/user/guide/dgx-deployment.md) for deployment verification.

| Symptom | Check or action |
| --- | --- |
| Web UI unavailable or returning 401 | Distinguish Web and retrieval ports; check LAN access, address, and the current process's authenticated URL |
| Retrieval or model returns 401 | Check retrieval and model credentials separately; they are different credentials |
| Missing launch patch | Fresh clones exclude `.dsh-build/`; generate local configuration first |
| Slow startup | Check repeated installs/builds and differences in Node/pnpm or dependency links |
| Slow answers with fast retrieval | Full questions also include model inference before/after tools and answer generation |
| Returned content does not support the question | Inspect source evidence, document titles, and coverage rather than similarity alone |
| Vector failure or timeout | Hybrid retrieval retains lexical evidence; total API unavailability returns an error |
| Merged code has not changed retrieval | Check Harness and retrieval API images and versions separately |

<a id="documentation"></a>

## Code and documentation

| Entry | Content |
| --- | --- |
| [Retrieval package](packages/experimental/environment-policy/README.md) | Query planning, knowledge services, tools, and retrieval semantics |
| [Retrieval deployment](packages/experimental/environment-policy/deploy/README.md) | API, Docker, hybrid retrieval, index releases, and rollback |
| [DGX application deployment](docs/user/guide/dgx-deployment.md) | Harness container, authentication, persistence, updates, and troubleshooting |
| [Agent preset](apps/cli/config/examples/environment-policy-dgx.patch.yml) | Q&A name, description, prompts, tools, and model configuration |
| [Database viewers](deploy/db-viewers/README.md) | Shared read-only DGX pages for A and B |
| [Data preparation](data/README.md) | SQLite indexing inputs and snapshot releases |
| [Retrieval evaluation](docs/user/guide/policy-retrieval-evaluation.md) | Results, limitations, and reproduction |
| [Development guide](docs/development.md) | DSH repository development and checks |

Policy retrieval code lives in `packages/experimental/environment-policy/src/`; the SQLite builder is `scripts/environment-policy-build-index.ts`. This project builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and retains the upstream framework and contribution history.

<a id="license"></a>

## License

[MIT](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
