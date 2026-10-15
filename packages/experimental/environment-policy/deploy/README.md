# DGX policy source data, indexes and retrieval service

English | [中文](README.zh.md)

This deployment runs a retrieval service on DGX. Harness runs locally or in its own container and requests source evidence over HTTP. SQLite owns policy content and metadata; keyword indexes and Chroma vectors locate candidates. The retrieval API coordinates these operations and is not a relational database. Its container requires no GPU and exposes no data writes.

## Service and data

```text
Harness → policy_search → retrieval API → query planning
  Exact query: title / number / article index → candidate addresses
  Topic query: body BM25 + embedding / Chroma → candidate addresses
  Merged addresses → SQLite batch read → validation / rank fusion → bounded evidence
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

SQLite stores source text, content units, metadata, descriptions, and keyword search terms. Chroma stores derived vectors, source addresses, and optional text copies; those copies never supply citations. The API reads SQLite through a read-only mount in its own container; SQLite is embedded and needs no separate SQL server container. Chroma and Harness have independent containers and persistence. Rebuilding vectors requires the same source snapshot, pinned embedding weights, input preprocessing, and split rules. Neither serving nor restarting performs a rebuild.

## Docker configuration

Deploy the package files `src/database.ts`, `src/query.ts`, `src/query-store.ts`, `src/hybrid-store.ts`, `src/release.ts`, `.dockerignore`, and `deploy/` to `/srv/e-agent/policy-api`, and place the database in the data directory above. Create `deploy/.env` from `deploy/.env.example`, and write a random token of at least 32 characters to the token file. Keep the token outside Git.

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

Known document names, numbers and article labels bypass the GPU. Topic queries overlap embedding/vector requests with lexical recall; synchronous SQLite work still runs on the Node event loop. BM25 aggregates indexed terms before reading bounded candidate bodies. Both channels return addresses without citation text. The service deduplicates addresses, reads up to 100 distinct units per SQL batch, rejects missing units, changed hashes or invalid Unicode spans, then filters and fuses ranks using SQLite metadata. Multiple spans from one unit contribute only once per channel; multiple articles from one document share a citation number.

`policy-retrieval` is the shared Docker network for all three containers. Add the Chroma and embedding services to this external network in their Compose files; the API uses container names at `http://chroma:8000` and `http://vllm-qwen3-embedding-4b:8000`. The existing Chroma host port remains bound to `127.0.0.1:8002`.

`deploy/.env.example` lists semantic settings. `POLICY_DOCUMENT_COLLECTION` selects the existing combined document collection and `POLICY_PASSAGE_COLLECTION` selects the new passage collection. Candidate limits default to 12 documents and 32 passages. The document collection actually uses squared L2 distance with a default maximum of 0.9; passages use cosine distance with a default maximum of 0.45. Thresholds are configurable and do not express confidence in a legal conclusion. Clear both collection names for SQLite retrieval.

The semantic budget defaults to 2000 milliseconds. One failed vector collection retains the other collection's candidates; failures and timeouts preserve lexical evidence with a `semantic-unavailable` warning. API failure remains an explicit Harness error. `diagnostics` reports planning, lexical, semantic, source-read and total times, candidate/distinct-unit counts, and rejected missing-unit, hash and span associations. `candidate-source-association-rejected` identifies discarded source links. Timings exclude answer generation.

The offline [build-passages.py](build-passages.py) builder accepts `--database`, `--embedding-url`, `--chroma-url`, `--model`, required `--model-revision`, and `--kind document|passage`. Document input combines title, description and a bounded body overview; passage input combines title, section and body, with 1200 Unicode characters and 120-character overlap. New collection names include the source build and a model/input fingerprint; resume requires identical metadata. The builder never selects a serving release. Existing collections remain usable in legacy mode, which checks build, source hashes and dimensions but cannot establish a missing model revision.

## Local Harness

This computer stores the access token in `.dsh-build/dgx-policy.token`. The remote launch configuration `.dsh-build/environment-policy-remote-web.patch.yml` reads that file; the command does not need a plaintext token.

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-remote-web.patch.yml --no-open
```

The reusable plugin group for other developers is [environment-policy-remote.cordis.yml](../presets/environment-policy-remote.cordis.yml). Set `DGX_POLICY_API_URL` and `DGX_POLICY_API_TOKEN_FILE` to change the endpoint and local token file. Requests default to an 8-second timeout, configurable through `timeoutMs`.

The original local-index group is retained as `.dsh-build/environment-policy-local-web.patch.yml` for explicit rollback. Remote failures do not automatically use a local database.

## HTTP API

`GET /health` requires no token and reports SQLite readiness, build identity, last semantic state, and legacy/manifest verification. It does not probe the model. Authenticated `GET /v1/policy/status` checks collection compatibility without inference and explicitly marks embedding as not probed. A ready collection status does not prove model availability. `GET /v1/policy/manifest` returns the complete build manifest and requires `Authorization: Bearer <token>`. `POST /v1/policy/search` uses the same authentication and accepts this request:

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

Store a replacement SQLite snapshot under a new filename in `POLICY_DATA_DIR`; never overwrite the open file. Build both matching collections offline, then validate the complete release. Substitute collection names printed by the builder and the actual snapshot filename. `release.py` checks every source/span association and expected coverage; incomplete indexes, changed hashes, model revisions or split rules prevent publication.

```bash
python3 release.py prepare --database /srv/e-agent/policy-data/policy-build-a.sqlite --documents DOCUMENT_COLLECTION --passages PASSAGE_COLLECTION --chroma-url http://127.0.0.1:8002 --output /srv/e-agent/policy-data/release-a.json
python3 release.py activate --manifest /srv/e-agent/policy-data/release-a.json --chroma-url http://127.0.0.1:8002 --env-output /srv/e-agent/policy-data/selected.env
```

Preparation writes a new manifest beside its snapshot. Activation revalidates the complete pairing before atomically replacing only `selected.env`; it does not invoke Docker. The manifest records SQLite build/hash, both collections and counts, embedding revision/dimension, distance metrics, input versions, and chunk version. Pin model container weights to that revision separately; the embeddings protocol cannot prove which weights a model alias serves.

After validation and representative query checks, an operator recreates only the API with `docker compose --env-file .env --env-file /srv/e-agent/policy-data/selected.env up -d --wait --no-deps --force-recreate policy-api`. The second env file selects the snapshot and `/app/data/release-a.json`; the API derives both collections from the manifest. Rollback uses `release.py activate` with a retained manifest and the same API command, selecting the previous SQLite and both indexes together. Keep referenced snapshots, collections, credentials and compatible code for rollback. Production deployment is separate from local fixture tests and requires post-merge validation.

The DGX service binds only to its LAN address. HTTP is intended for a trusted LAN; use HTTPS or an SSH tunnel before crossing an untrusted network. The token grants query access and should be distributed privately to collaborators.
