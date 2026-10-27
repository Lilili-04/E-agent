---
description: "Configure shared DGX database browsing for deployment arrangements A and B, including read-only access, login, container maintenance, and isolated verification."
---

# DGX database viewers

English | [中文](README.zh.md)

## Summary

The project has two deployment arrangements: A (Harness on DGX) and B (local Harness connected to DGX). Both keep their databases on DGX, so deploy the viewers in this directory once. The DGX Compose project does not alter startup configuration for Harness, the retrieval API, databases, or models. The local viewers below inspect separate development snapshots.

## Table of Contents

- [Components and access](#components)
- [Local SQLite snapshot on Windows](#local)
- [Local vector database on Windows](#local-vector)
- [Prepare configuration on DGX](#prepare)
- [Build, start, and verify](#start)
- [Update, stop, and troubleshoot](#maintain)
- [Isolated tests and upstream versions](#tests)

<a id="components"></a>

## Components and access

| Component | Page and default port | Data source |
| --- | --- | --- |
| Datasette | SQLite tables, pagination, and read-only SQL; 18101 | Read-only bind of the existing SQLite snapshot |
| Nginx + ChromaDB UI | Collections, records, metadata, and vector queries; 18102 | Existing Chroma V2 API through a same-origin gateway |

Both pages share a separate HTTP Basic login file. The gateway forwards only SQLite GET/HEAD and Chroma reads, `get`, and `query` requests; creation, updates, deletion, resets, and other APIs are rejected. Login credentials are not forwarded to Chroma. Services run as non-root users with read-only root filesystems and rotating logs.

These viewers use no GPU, import or copy no corpus, create no Chroma collections, and rebuild no vectors. They inspect data; RAG topic retrieval continues through `policy_search` and the retrieval API.

<a id="local"></a>

## Local SQLite snapshot on Windows

The local offline viewer uses the same Datasette 0.65.5 UI and binds only to `127.0.0.1:18101`, without a login. It opens `data/policy-combined-local-20261022-r2.sqlite` in immutable read-only mode: 2,045 documents and 187,087 content units. The database page includes region counts and parameterized title search. It does not connect to DGX or Chroma, or change the Harness database configuration.

From the repository root in PowerShell, install once with Python 3.10 or newer, then start or stop the hidden background process:

```powershell
python -m venv .dsh-build/local-db-viewer-venv
.dsh-build/local-db-viewer-venv/Scripts/python.exe -m pip install datasette==0.65.5
./deploy/db-viewers/local-sqlite.ps1
./deploy/db-viewers/local-sqlite.ps1 -Stop
```

Open <http://127.0.0.1:18101/policy-combined-local-20261022-r2>. `documents` contains metadata and full text; `content_units` contains ordered text units. Table filters accept fields such as `region`; custom SQL accepts reads only. `-Port 18103` selects another port for both start and stop. An occupied port is rejected. PID and logs are stored under `.dsh-build/local-db-viewer-<port>.*`; stopping validates the recorded process identity. Restart after rebuilding the snapshot; immutable connections do not track file changes.

<a id="local-vector"></a>

## Local vector database on Windows

The local viewer uses the same pinned ChromaDB UI as DGX, with write controls hidden. It binds only to `127.0.0.1:18102`, without a login, and opens the completed `data/policy-combined-local-vectors-r2` build: 2,045 document vectors and 126,804 passage vectors. Its read adapter exposes only the two manifest collections and rejects API writes. Browsing stored vectors needs neither DGX nor a GPU.

Use the Python environment from [local vector construction](../local-vectors/README.md) and Node.js with npm. From the repository root, build the frontend once, then start the hidden background process:

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 deploy/db-viewers/build-local-chroma-ui.py
./deploy/db-viewers/local-chroma.ps1
```

Open <http://127.0.0.1:18102/>, click **Connect to Chroma**, and select a collection. Browse text and metadata, expand records, or click **Vector** to inspect 2,560 values and their norm. The viewer loads at most 500 records per batch; use the top Previous/Next buttons to change batches. Table search and metadata filters apply only to the loaded batch. Query Viewer accepts numeric vectors; it does not generate embeddings from text. For natural-language retrieval, use the linked query command after stopping the viewer.

```powershell
./deploy/db-viewers/local-chroma.ps1 -Stop
```

Stop the viewer before constructing, verifying, querying from another embedded client, or replacing its vector store. Do not open multiple processes against this local Chroma directory. `-Port 18104` selects another port for both start and stop; occupied ports are rejected. PID, stop signal, and logs use `.dsh-build/local-chroma-viewer-<port>.*`. The frontend build verifies the archive checksum recorded in the DGX gateway Dockerfile and requires no Docker installation.

<a id="prepare"></a>

## Prepare configuration on DGX

Prerequisites are Docker Engine, Docker Compose V2, Python 3, OpenSSL, and a running Chroma V2 service. The operator needs Docker permissions; use sudo according to server policy if needed. Run these commands from the repository root on DGX.

```bash
cp deploy/db-viewers/.env.example deploy/db-viewers/.env
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 700 /srv/e-agent/db-viewers-secrets
python3 deploy/db-viewers/prepare.py --username viewer --output /srv/e-agent/db-viewers-secrets/viewers.htpasswd
```

The script interactively requests and confirms a password of at least 12 characters. It saves only a randomly salted SHA-512 crypt hash, keeps the password out of command arguments and Git, and refuses to overwrite existing files. The private parent has mode 700; the non-root container user can read the hash file. Manage this account separately from SSH, retrieval API, and model credentials.

Edit `deploy/db-viewers/.env` and check at least the following values; see [.env.example](.env.example) for the full template. `.env` and login files are excluded from Git.

| Setting | Current DGX example | Meaning |
| --- | --- | --- |
| `VIEWERS_BIND_ADDRESS` | `172.27.153.44` | Bind the DGX LAN IP, not another computer's IP |
| `POLICY_SQLITE_FILE` | `/srv/e-agent/policy-data/policy-national-v1.sqlite` | Existing file matching the snapshot used by the retrieval API |
| `VIEWERS_HTPASSWD_FILE` | `/srv/e-agent/db-viewers-secrets/viewers.htpasswd` | Login file generated above |
| `POLICY_RETRIEVAL_NETWORK` | `policy-retrieval` | Existing external Docker network containing Chroma |
| `CHROMA_UPSTREAM` | `chroma:8000` | Chroma container name and internal port on that network |
| `SQLITE_VIEWER_PORT` / `CHROMA_VIEWER_PORT` | `18101` / `18102` | Browser-facing ports on DGX |

Confirm that `docker network inspect policy-retrieval` includes Chroma. The gateway connects over the container network; there is no need to expose the current loopback-only host port 8002 to the LAN or alter Chroma CORS. SQLite parent directories and the file must be readable by UID 1000. Use the selected complete snapshot rather than an artifact still being built.

<a id="start"></a>

## Build, start, and verify

```bash
cd deploy/db-viewers
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps
curl -I http://172.27.153.44:18101/
curl -I http://172.27.153.44:18102/
```

Both pages should return HTTP 401 without login; enter the configured username and password in the browser to load them. Viewer authentication does not provide TLS: these URLs are for a trusted LAN. Use an HTTPS reverse proxy or SSH tunnel across untrusted networks.

In the SQLite page, select the `policy` database to browse tables, inspect fields, filter rows, and run SELECT queries. Defaults are 50 records per page, at most 1000 returned rows, and a 1500 ms SQL time limit; database-file downloads are disabled. Use filters for large tables.

In the Chroma page, the connection URL defaults to the current origin. Select tenant `default_tenant` and database `default_database`, then an existing collection. Each batch loads at most 500 records; use the top previous/next buttons to switch batches. Table filters apply only to the loaded batch. Some upstream write buttons remain visible; submissions receive HTTP 403 from the gateway without changing collections.

Vector queries default to JSON containing existing Embedding vectors; their dimensions and model must match the selected collection. Automatic text embedding and external model credentials are not configured here. Use the Harness policy query tool for ordinary Chinese topic questions.

<a id="maintain"></a>

## Update, stop, and troubleshoot

Rebuild and recreate containers after viewer code changes. Also recreate them when the SQLite snapshot path changes or a file is replaced at the same path, since an existing bind may still point to the old file. Restarting Harness alone does not update viewers.

```bash
cd deploy/db-viewers
docker compose build
docker compose up -d --force-recreate --wait
docker compose logs --tail 60
docker compose down
```

The final command stops only this project's viewer containers and internal network. It does not stop Chroma, the retrieval API, or Harness, or delete their data. To rotate a password, generate a new login file, select it in `.env`, and recreate containers; do not overwrite the active file.

For unavailable pages, first inspect container health, bind IP, ports, and LAN routing. A previous DGX proxy TUN sent cross-subnet replies through the wrong interface; diagnose actual routes rather than changing proxies automatically in this component. HTTP 401 requires correct viewer credentials; HTTP 403 for writes is intentional. For build failures, check Docker registries and GitHub/npm/PyPI connectivity; template image arguments can select sources already verified by the server operator.

<a id="tests"></a>

## Isolated tests and upstream versions

Run the following from the repository root. It uses temporary SQLite, a fake Chroma server, random Compose names, and Docker-allocated loopback ports without reading production data. Cleanup awaits container and network removal even after failures.

```bash
python3 deploy/db-viewers/smoke-test.py --build
```

Tests verify authentication, SQLite browsing and write rejection, Chroma V2 reads and queries, blocked write endpoints, credential stripping, and an unchanged source database. GitHub Actions runs the same test on an ARM64 runner; fake-service tests do not establish compatibility with every Chroma version.

Datasette is pinned to 0.65.5. [ChromaDB UI](https://github.com/BlackyDrum/chromadb-ui) is pinned to the upstream commit and SHA-256 archive checksum in the Dockerfile; its MIT license is retained in the image. Build patches adjust only the same-origin URL, connection probes, default vector input, and batch browsing. Changed upstream markers fail the build. Upgrade pins, checksums, patches, and isolated tests together rather than following latest automatically.

## Dev Note

None.
