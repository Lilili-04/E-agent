---
description: "Build and verify local policy Chroma collections using admitted SQLite records, reusable national vectors, and the existing DGX embedding model."
---

# Local policy vectors

English | [中文](README.zh.md)

## Summary

The local builder creates separate document and passage collections from the admitted combined SQLite snapshot. It reads existing national vectors through an SSH tunnel and sends new embedding requests to DGX; it does not write remote collections or change DGX services. The local query command filters regions before vector search and validates returned evidence against SQLite. The optional local Harness configuration connects the completed corpus without changing DGX services.

## Table of Contents

- [Prerequisites and build](#build)
- [Verification and queries](#query)
- [Local Harness chain](#harness)
- [Reuse and recovery](#recovery)

<a id="build"></a>

## Prerequisites and build

Use Python 3.10 or newer and install `requirements.txt` in `.dsh-build/local-vector-venv`. Prepare `data/policy-combined-local-20261022-r2.sqlite` and `.dsh-build/policy-v2-documents.compat.json`. Run commands from the repository root. Keep this SSH tunnel open; it forwards only loopback ports and prompts for the existing SSH password:

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:59329:127.0.0.1:8000 -L 127.0.0.1:59330:127.0.0.1:8002 health@172.27.153.44
```

Build or resume in another terminal:

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 -u scripts/build-policy-local-vectors.py --database data/policy-combined-local-20261022-r2.sqlite --compatibility .dsh-build/policy-v2-documents.compat.json --output data/policy-combined-local-vectors-r2
```

`--batch-size` defaults to 64 and accepts 1–128 for model requests. `--index-batch-size` defaults to 512 and accepts 1–2,048 for local writes. Only one builder may write an output directory at a time. Output includes `chroma/`, resumable `staging.sqlite`, per-collection reuse audits, and `manifest.json`. The manifest identifies the SQLite SHA-256, collection names, vector dimensions, source counts, and build completion. Treat this directory as data: preserve it before running repository cleanup commands that remove build artifacts.

<a id="query"></a>

## Verification and queries

Validate every indexed ID, document hash, region, input checksum, original-text position, and persisted vector against staging without calling the model:

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 scripts/query-policy-local-vectors.py --root data/policy-combined-local-vectors-r2 --verify
```

Query with the same DGX model through the tunnel:

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 scripts/query-policy-local-vectors.py --root data/policy-combined-local-vectors-r2 --question "江苏省危险废物管理有哪些要求" --region 江苏省 --only
```

The default region is `全国`. A province includes national and provincial results unless `--only` is set; region names must exactly match SQLite. Each region receives its own candidate budget, and results alternate by region. `--document-id` narrows search further; `--kind document` selects file discovery instead of passage evidence. Results show title, region, distance, and a bounded original snippet. The command rejects incomplete builds or a changed SQLite snapshot. Retrieval still requires evaluation for answer relevance; source validation does not establish legal applicability.

For collection, metadata, and stored-vector browsing, use the [local read-only viewer](../db-viewers/README.md#local-vector). Stop it before running commands that open the embedded vector store.

<a id="harness"></a>

## Local Harness chain

Keep the completed SQLite snapshot and vector directory together. From the repository root, launch the local web Harness with the existing model key in `.dsh-build/qwen-api.key`:

```powershell
./deploy/local/start-policy-local-web.ps1
```

For the first login, use the token-bearing URL printed at startup; then open <http://127.0.0.1:3080/> and select the environment-policy preset. The script checks SQLite identity and model availability, starts or reuses the independent loopback vector API at port 18102, and loads the local source provider through a generated patch. The optional viewer frontend shares that API; closing its browser tab does not stop retrieval. An unavailable frontend does not prevent API startup. No DGX retrieval API or remote vector collection participates; only the existing DGX embedding and chat models are called. `-EmbeddingUrl` and `-VectorPort` override the embedding endpoint and local API port. The script restores its environment variables on exit and rejects an occupied web port rather than stopping another process.

The local patch loads `deploy/local/policy-latest.json` for national-by-default, latest-stored-version retrieval. Rebuild it with `python scripts/build-policy-latest.py --graph-config deploy/local/policy-graph.json --database data/policy-combined-local-20261022-r2.sqlite --output deploy/local/policy-latest.json` after changing reviewed source data. Ordinary search and reads need no Neo4j connection. Historical version, lineage and validity requests lazily use the existing local Neo4j at port 17475 and pinned `policy-combined-v4` partition through `deploy/local/policy-graph.json`; start that instance for these requests. Graph mismatches fail historical requests. Restart the Harness after changing either metadata snapshot. All old partitions and vector collections remain unchanged; missing or unordered latest bodies are excluded rather than replaced with older text.

The two tools remain `policy_search` and `policy_read`. File discovery combines title/description BM25 and file vectors. Topic questions combine body BM25, passage vectors, and lower-weight BM25 evidence from vector-discovered files. Each region receives 30 lexical, 10 file-vector, 30 passage-vector, and 20 guided candidates. A province includes national evidence unless `region_mode=only`; query-time filters enforce both region and optional document ID. RRF merges rankings rather than raw distances, then limits each document to three units, combines adjacent evidence, and returns at most eight blocks and 12,000 characters. File summaries never substitute for original evidence.

The local semantic settings use the mathematical distance bounds for normalized vectors (L2: 4; cosine: 2), without an empirically calibrated relevance cutoff. Top-ranked candidates can still be irrelevant; evaluate answer relevance separately. The shared 60-second semantic deadline accommodates cold index loads; warm-query latency depends on the local machine. A transport retry reuses the unchanged question. Model or vector failures produce warnings and preserve lexical retrieval; cancellation still stops the request. Startup refuses incompatible manifests, and runtime rejects source, unit, or text-offset mismatches.

Stop the foreground Harness with Ctrl+C. The vector service remains available for browsing; stop it separately with `./deploy/db-viewers/local-chroma.ps1 -Stop` before using another embedded client or rebuilding. To return to the previous DGX-backed local configuration, stop this Harness and run `./deploy/local/start-policy-web.ps1`. Both configurations preserve the existing databases. Neither command deploys to DGX.

<a id="recovery"></a>

## Reuse and recovery

Document vectors encode `标题` and `内容概述`. Passage vectors encode title, section, and original body; new chunks use 1,200 Unicode code points with 120 overlap, skipping headings and units with fewer than 30 non-edge-whitespace characters. Old passages retain their segmentation when source hashes, title, saved input, offsets, and SQLite text all match. Uncovered eligible units receive new vectors. Every vector has `document_id`, `region`, `source_hash`, `build_id`, and an embedding-input hash; passages additionally record ordered unit IDs and offsets into their concatenated CRLF-normalized text.

The legacy release does not record a pinned weights revision. Each collection is checked against six current-model samples, requiring cosine similarity of at least 0.999, and the audit records this empirical limitation. Matching inputs then reuse normalized 2,560-dimensional vectors. Document collections retain L2 distance and passage collections retain cosine distance. This check is evidence of compatibility, not a cryptographic guarantee of identical weights.

New requests use the model's OpenAI-compatible base64 float32 output, decoded as little-endian values and normalized locally. This reduces transport size without quantizing vectors. Staging uses SQLite WAL so progress reads do not block batch commits; the local HNSW bulk-build synchronization interval is 10,000 records with eight index threads.

Network failures retry with bounded backoff. Computed vectors are committed to staging before indexing; rerunning the same command resumes checkpoints, checks the model against cached samples, and repeats uncommitted upserts safely. Create an empty `STOP` file in the output directory to stop after the current batch; wait for process exit, then remove that file before resuming. A different SQLite hash, compatibility-map hash, or builder version requires a new output directory. Do not edit or replace SQLite during a build, or mutate the remote source collections during export. Keep old collections intact until the replacement is fully verified and separately authorized for deployment.

On Windows, run from the repository root so the native HNSW library receives an ASCII relative storage path. In this pinned version, a Chinese absolute path can leave SQLite and metadata files without the HNSW binary files, causing reopening to fail. The builder and query command share the relative-path conversion and reject non-ASCII relative paths. Verification must run in a fresh process after construction; successful in-process queries alone do not establish that the index persisted.

## Dev Note

None.
