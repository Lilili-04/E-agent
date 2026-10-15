# National Environmental Policy Q&A System Built on DSH

English | [中文](README.zh.md)

This project uses DeepSeek Harness (DSH) to answer questions about national-level Chinese environmental laws, regulations, standards, plans, and policy documents. Users ask questions through Harness, which runs locally or on DGX; the system retrieves source passages and the model produces an answer with citations.

**The default deployment runs Harness locally and the retrieval API, read-only SQLite, Chroma vector database and Qwen3 embedding service in Docker on DGX.** Collaborators using the remote service do not need a local database or MinerU outputs.

Harness can also run separately on DGX, with browsers connecting to the server UI. Harness, the retrieval database, vector database, and models retain separate containers and data directories; the Harness image contains no database, corpus, or model weights.

## System flow

```text
User → Harness (local / DGX) → policy_search → DGX retrieval API → Source evidence → Agent
     ← Cited answer  ← Source evidence ← Query planning / retrieval

DGX retrieval API
  ├─ SQLite: exact lookup / body BM25 / source text
  └─ Qwen3 embedding → Chroma: document vectors / passage vectors → SQLite source text
```

Harness owns the UI, Agent, model calls, and source presentation. The independent retrieval service owns query planning, retrieval, ranking, and evidence limits. The database stores source text, metadata, content units, descriptions, and search terms. The model receives bounded source evidence; descriptions only assist document discovery and do not replace the source.

## Capabilities and corpus

- Prioritizes the corresponding document and source units for explicit titles, document numbers, or articles.
- Discovers documents by topic using title search, body BM25, document vectors and passage vectors.
- Returns publication dates and the legal-status fields recorded in the catalog.
- Prefers the latest version in tool output unless the user explicitly requests history.
- Includes source titles, publication dates, and article or section references in answers.

The current index contains **494 national documents and 61,455 content units**; the database is approximately **835 MiB**. SQLite files, source corpora, tokens, and machine-specific launch configuration are excluded from Git.

## Run the complete application on DGX

Prepare the intranet address, separate state directories, and two credential files using the [DGX application deployment guide](docs/user/guide/dgx-deployment.md), then run in `deploy/dgx`:

```bash
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose build
docker compose up -d --wait
```

This Compose project manages only Harness and calls the existing retrieval API and Qwen3.8-27B model through the external `policy-retrieval` network. The separate retrieval API container still mounts SQLite read-only, and Chroma persists its own index. Rebuilding, updating, or stopping Harness does not operate on those database or model containers; a restart needs only `docker compose restart harness`.

## Existing local workspace: start or restart

Run from the repository root:

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-web.patch.yml --no-open
```

On this computer, `environment-policy-web.patch.yml` selects the remote service at `http://172.27.153.44:18080` and reads its token from `.dsh-build/dgx-policy.token`. Do not put the token in README files, launch commands, or Git.

Open the authenticated URL printed by DSH, normally at `http://127.0.0.1:3080`. DGX port `18080` serves retrieval requests; local port `3080` serves the Harness UI.

When dependencies and build artifacts exist, restarting requires only the command above. Install or build again only when dependencies change, artifacts are missing, or artifacts need regeneration.

## New collaborators: required inputs

Users of an already deployed DGX Web UI need a browser, LAN access, and an authenticated URL supplied privately by the maintainer. They need no local Node installation, database, or model. The following inputs are for local developers.

| Item | How to prepare it |
| --- | --- |
| Source code | Clone the Git repository |
| Runtime | Windows, macOS, or Linux; Node.js 22.x starting at 22.19, or 24 and newer; pnpm 11 or newer |
| Model configuration | Configure an available model and its credentials in Harness model settings |
| DGX endpoint | Join the server's LAN and obtain the endpoint from the deployment maintainer |
| Query token | Obtain it privately and save it in a local token file |
| Launch configuration | Prepare an Agent preset and launch patch for the local checkout |

**A fresh clone does not contain `.dsh-build/`.** The current private workspace patch contains absolute source paths and cannot be copied unchanged to another computer. The repository provides a [DGX Agent preset](apps/cli/config/examples/environment-policy-dgx.patch.yml) without machine-specific paths; see the [DGX application deployment guide](docs/user/guide/dgx-deployment.md) for local and container use, or the [remote plugin group](packages/experimental/environment-policy/presets/environment-policy-remote.cordis.yml) when composing only retrieval plugins.

Remote-query collaborators need source code, model configuration, an endpoint, a token, and a launch configuration. **They do not need SQLite, policy_md, or MinerU outputs.** Corpus processing and index-building work require the corresponding data separately.

Prepare dependencies and build artifacts once:

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

After preparing the local launch configuration, use the earlier launch command. Complete installation, build, and launch in the same interactive terminal when possible. Codex execution and the user's terminal can differ in Node, pnpm, and dependency-link state. If `node_modules/.modules.yaml` is missing, pnpm may inspect and relink the whole workspace, increasing startup time.

## Layout and deployment documentation

```text
packages/experimental/environment-policy/src/       Query planner, SQLite and remote providers, tool
packages/experimental/environment-policy/deploy/    Docker API, Compose and deployment guide
packages/experimental/environment-policy/presets/   Local and remote plugin groups
deploy/dgx/                                        Separate Harness container and persistent state
apps/cli/config/examples/environment-policy-dgx.patch.yml  Portable QA preset and Qwen route
scripts/environment-policy-build-index.ts           Index builder
data/README.md                                     Index inputs and local database preparation
.dsh-build/                                         Machine-specific patches and token; ignored by Git
```

See the [environment-policy package guide](packages/experimental/environment-policy/README.md) for retrieval behavior. The [DGX deployment guide](packages/experimental/environment-policy/deploy/README.md) owns Docker configuration, authentication endpoints, database updates, and server maintenance commands.

## Local index building and rollback

Local SQLite mode supports independent development, index construction, and explicit rollback. It requires `data/policy-national-v1.sqlite`. See [data preparation](data/README.md) for source Markdown, inventory, metadata, and description inputs.

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

The builder writes the database and manifest to `data/` by default. Use `--inventory`, `--metadata`, `--descriptions`, `--output`, `--manifest`, and `--source-root` for other input and output locations.

This computer retains a local-database rollback patch. Stop the current Harness service before selecting it:

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-local-web.patch.yml --no-open
```

Remote failures return errors instead of automatically using an older local index. Switching the database deployment does not change the question-answering tool interface.

## Verification and troubleshooting

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/environment-policy/tests
node_modules/.bin/tsc.cmd -p packages/experimental/environment-policy/tsconfig.json --noEmit
```

| Symptom | Check |
| --- | --- |
| DGX connection failure | LAN access, endpoint, and server `/health` |
| HTTP 401 | Whether the token file exists and matches the server token |
| Missing launch patch | `.dsh-build/` is not in Git; prepare local configuration first |
| Slow startup | Repeated installation/build, incomplete dependency links, and different terminal runtimes |
| Missing evidence | Whether the corpus contains the document and which source units were returned |

Tests cover query planning, SQLite, the real HTTP API, authentication, and remote tool composition. Remote integration tests temporarily start a local HTTP service.

## Current scope

The corpus covers national documents; provincial documents are not included. Legal-status answers use catalog metadata, and the system does not independently determine legal validity. Exact queries use SQLite; ordinary questions run lexical and vector retrieval concurrently, returning lexical evidence after semantic timeouts. Harness and the retrieval API use no GPU; independent GPU services provide embeddings and answer generation. Some document-number and date metadata remains malformed; returned evidence or passing functional checks does not guarantee answer accuracy. See the [retrieval deployment guide](packages/experimental/environment-policy/deploy/README.md) for settings and limitations.

## Related documentation

- [Complete DGX application deployment, persistence, and updates](docs/user/guide/dgx-deployment.md)
- [DGX Docker deployment, API, and rollback](packages/experimental/environment-policy/deploy/README.md)
- [Environment-policy package guide](packages/experimental/environment-policy/README.md)
- [Data and index preparation](data/README.md)
- [Environment-policy Q&A implementation plan](.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.md)

## License

[MIT](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
