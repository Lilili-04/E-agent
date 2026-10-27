# DGX combined deployment

English | [中文](README.zh.md)

This deployment runs the admitted national/provincial SQLite snapshot, existing Chroma vectors, and Neo4j on one DGX. The backend retrieves and assembles original evidence; model planning remains disabled. Qwen3.6 and the embedding service are existing independent services.

## Release layout

Keep `source/`, `release/`, `state/`, `workspace/`, and `graph-data/` in a separate versioned deployment directory. `release/` contains `policy.sqlite`, `latest.json`, `vectors/` (including its build manifest), and `graph/graph.json` with `graph/source-config.json`. Restore the complete Neo4j store into `graph-data/` using the same database version. Preserve the original release and all vector caches.

The deployment uses Linux host networking so the graph endpoint and read-only vector adapter remain loopback-only. Harness mounts the release read-only. The vector adapter needs a writable copy of its Chroma store for library initialization but exposes only read operations. Do not expose ports 17475 or 18104 externally.

## Start and verify

Set the Compose variables in a private environment file: `HARNESS_IMAGE`, `SOURCE_REVISION`, `RELEASE_DIR`, `STATE_DIR`, `WORKSPACE_DIR`, `GRAPH_DATA_DIR`, `QWEN_API_KEY_FILE`, `HARNESS_BIND_ADDRESS`, `HARNESS_TRUSTED_HOSTS`, `DGX_QWEN_API_BASE_URL`, and `VIEWERS_HTPASSWD_FILE`. Start on `HARNESS_PORT=3081`; the trusted host includes that port. The model key stays in its mounted private file. `prepare.mjs` validates the SQLite and graph checksums and renders Linux paths and loopback endpoints under the private state directory.

```sh
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml config --quiet
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml build
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml up -d
node --test deploy/dgx-combined/prepare.test.mjs
```

Before switching, verify SQLite integrity and checksums, all vector counts/dimensions and representative queries, Neo4j counts/indexes and the graph snapshot projection, authenticated Web access, and the full knowledge-question regression. Retain raw answers, original evidence, and per-question review; deployment acceptance does not imply every answer is correct.

## Backup, switch, and restore

Before migration, record old container inspections and restart policies privately, export their images, preserve the actual source and local overrides, and snapshot every mounted database and state directory while its writers are stopped. Verify the archives and SQLite integrity, then resume the old deployment until acceptance.

After acceptance, stop the old application and database/viewer containers, set their restart policies to `no`, and recreate the new Harness on port 3080. Keep the old containers, images, data, credentials, and verified backup. Switch database viewers to the new snapshot and vector read adapter. Preserve the independent model services. To restore, stop the new services, restore the recorded old restart policies, and start the old data services followed by the old Harness and viewers. Recheck login and a real query. Never delete volumes during either switch.

Commit source, tests, deployment files, and documentation only. Database payloads, credentials, login URLs, private environment files, sessions, and backup archives remain outside Git.
