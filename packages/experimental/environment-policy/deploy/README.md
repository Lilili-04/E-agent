# DGX environment-policy database deployment

English | [中文](README.zh.md)

This deployment runs the read-only SQLite index and retrieval API in a Docker container on DGX. Local Harness retains the UI, Agent, and model calls; `policy_search` requests source evidence over the LAN. The API container does not require a GPU; semantic retrieval calls a separate DGX GPU embedding container and exposes no database writes.

## Service and data

```text
Harness → policy_search → remote-service → DGX API
                                            ├─ SQLite: metadata / BM25 / source text
                                            └─ Qwen3 embedding → Chroma → SQLite source text
```

| Item | Configuration |
| --- | --- |
| DGX SSH | `health@172.27.153.44:22` |
| Search API | `http://172.27.153.44:18080` |
| Docker deployment directory | `/srv/e-agent/policy-api/deploy` |
| Data directory | `/srv/e-agent/policy-data` |
| Database | `policy-national-v1.sqlite`, mounted read-only |
| Container name | `e-agent-policy-api` |
| Token file | `/srv/e-agent/policy-api/.secrets/policy-token` |

The database stores source text, content units, metadata, descriptions, and search terms. Exact and lexical queries require only SQLite; hybrid queries also require persistent Chroma indexes and the Qwen3 embedding service, without MinerU output directories. Index rebuilding still requires source Markdown and the corresponding build inputs.

## Docker configuration

Deploy the package files `src/database.ts`, `src/query.ts`, `src/query-store.ts`, `src/hybrid-store.ts`, `.dockerignore`, and `deploy/` to `/srv/e-agent/policy-api`, and place the database in the data directory above. Create `deploy/.env` from `deploy/.env.example`, and write a random token of at least 32 characters to the token file. Keep the token outside Git.

```dotenv
POLICY_DATA_DIR=/srv/e-agent/policy-data
POLICY_API_BIND=172.27.153.44:18080
POLICY_API_TOKEN_FILE=/srv/e-agent/policy-api/.secrets/policy-token
```

DGX has an offline import of the official ARM64 Node image; this environment also sets `POLICY_NODE_IMAGE=e-agent-node:24-bookworm-slim-arm64`. Downloads use the official Docker Registry, with SHA-256 checks for the manifest, configuration, and each layer. A working online environment can use the Dockerfile default `node:24-bookworm-slim`.

Start or update the container on DGX:

```bash
cd /srv/e-agent/policy-api/deploy
sudo docker network create policy-retrieval  # only when the network does not exist
sudo docker compose build
sudo docker compose up -d --wait
sudo docker compose ps
```

The SQLite directory uses a read-only bind mount; the application runs as a non-root user with a read-only container root filesystem. The token is read from a Docker secret file. Application logs rotate; the API does not rebuild databases.

## Hybrid retrieval

Known document names, numbers and article labels read SQLite directly, bypassing the GPU. Ordinary questions run body BM25 and semantic recall concurrently; one query embedding serves both document and passage vector queries, with up to 256 cached questions. Document vectors locate candidate files and passage vectors locate spans; all evidence is hydrated from SQLite source text. Rank fusion combines channels, and multiple passages from one document share a citation number.

`policy-retrieval` is the shared Docker network for all three containers. Add the Chroma and embedding services to this external network in their Compose files; the API uses container names at `http://chroma:8000` and `http://vllm-qwen3-embedding-4b:8000`. The existing Chroma host port remains bound to `127.0.0.1:8002`.

`deploy/.env.example` lists semantic settings. `POLICY_DOCUMENT_COLLECTION` selects the existing combined document collection and `POLICY_PASSAGE_COLLECTION` selects the new passage collection. Candidate limits default to 12 documents and 32 passages. The document collection actually uses squared L2 distance with a default maximum of 0.9; passages use cosine distance with a default maximum of 0.45. Thresholds are configurable and do not express confidence in a legal conclusion. Clear both collection names for SQLite retrieval.

The semantic budget defaults to 2000 milliseconds. Failures and timeouts return lexical results from the same remote SQLite with a `semantic-unavailable` warning. Failure of the remote API itself still produces an explicit local Harness error. `diagnostics` reports planning, lexical, semantic and total times, plus whether semantic recall ran; timings exclude Agent answer generation.

The DGX [build-passages.py](build-passages.py) script reads SQLite without writes and uses the existing embedding API to index articles and paragraphs into a new cosine collection with 1200 Unicode characters per span and 120-character overlap. It resumes by span ID and writes `passage-manifest.json` only after completion. DB, endpoint, model, chunk and batch settings currently live at the top of the script; adjust them before building another environment. After replacing SQLite, rebuild the matching passage collection and update configuration; indexes from different build IDs cannot be mixed.

## Local Harness

This computer stores the access token in `.dsh-build/dgx-policy.token`. The remote launch configuration `.dsh-build/environment-policy-remote-web.patch.yml` reads that file; the command does not need a plaintext token.

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-remote-web.patch.yml --no-open
```

The reusable plugin group for other developers is [environment-policy-remote.cordis.yml](../presets/environment-policy-remote.cordis.yml). Set `DGX_POLICY_API_URL` and `DGX_POLICY_API_TOKEN_FILE` to change the endpoint and local token file. Requests default to an 8-second timeout, configurable through `timeoutMs`.

The original local-index group is retained as `.dsh-build/environment-policy-local-web.patch.yml` for explicit rollback. Remote failures do not automatically use a local database.

## HTTP API

`GET /health` requires no token and returns health and database build identity. `GET /v1/policy/manifest` returns the complete build manifest and requires `Authorization: Bearer <token>`. `POST /v1/policy/search` uses the same authentication and accepts this request:

```json
{
  "question": "中华人民共和国核安全法第一条是什么",
  "options": {
    "maxResults": 8,
    "maxEvidenceCharacters": 12000
  }
}
```

`options` also accepts `currentDate` and `titleTopic`. The HTTP API does not accept arbitrary SQL or structured database filters. Evidence is capped at 50 items and 100000 characters; request bodies at 512000 bytes and questions at 4000 characters. Responses include `index`, `evidence` and `diagnostics`; the local tool still removes internal paths and retrieval fields before model output.

Missing or incorrect tokens return HTTP 401; invalid arguments return HTTP 400. Timeouts, connection failures, and incompatible database versions cause explicit errors in the local remote provider.

## Verification record

DGX measurements on 2026-10-13 are listed below. Values measure internal retrieval API processing, exclude network and Agent answer generation, and are not latency guarantees. Repeated questions reuse embeddings; different questions still need separate embeddings.

| Question | First | Repeated |
| --- | --- | --- |
| Nuclear Safety Law document | 7 ms | 1 ms |
| Nuclear Safety Law article one | 1 ms | Below 1 ms |
| Marine policy document list | 407 ms | 182 ms |
| Pig farm manure treatment requirements | 220 ms | 200 ms |
| Liability for excessive wastewater discharge | 336 ms | 268 ms |

The passage collection contains 38427 spans. A real remote `policy_search` composition returns eight Nuclear Safety Law body spans covering articles one and ninety-four, sharing one source number.

Of the 90 older baseline questions, 72 meet expected-title or presence-of-results conditions; this is not answer accuracy. Remaining cases include plans and standards without an “article one”, standard-title aliases, and no-answer or negative questions. Retrieval can still return documents matching some words in an unsupported question. Returned evidence does not establish that the question premise is supported; answers must stay within source text, and these evaluation cases require further calibration.

## Updates and rollback

Upload a replacement database under a temporary filename and verify SHA-256, then stop this project's container, retain the old database, replace the file, and restart. Never overwrite the SQLite file in use. Check health, manifest, and representative queries; restore the old file and corresponding code version if validation fails.

The DGX service binds only to its LAN address. HTTP is intended for a trusted LAN; use HTTPS or an SSH tunnel before crossing an untrusted network. The token grants query access and should be distributed privately to collaborators.
