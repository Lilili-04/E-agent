# DGX combined deployment

English | [中文](README.zh.md)

This deployment runs the admitted national/provincial SQLite snapshot, existing Chroma vectors, and Neo4j on one DGX. The backend retrieves and assembles original evidence; model planning remains disabled. Qwen3.6 and the embedding service are existing independent services.

## Release layout

Keep `source/`, `release/`, `state/`, `workspace/`, and `graph-data/` in a separate versioned deployment directory. `release/` contains `policy.sqlite`, `latest.json`, `vectors/` (including its build manifest), and `graph/graph.json` with `graph/source-config.json`. Restore the complete Neo4j store into `graph-data/` using the same database version. Preserve the original release and all vector caches.

Harness queries a loopback graph proxy on port 17475; the read-only vector adapter remains on private port 18104. Authenticated Neo4j Browser and Bolt bind only to `NEO4J_BIND_ADDRESS` on ports 17475 and 17687. Native HTTP also binds to private loopback port 17476. The internal proxy supplies a mounted credential without changing Harness graph configuration. Harness mounts the release read-only; the vector adapter needs a writable Chroma copy for initialization but exposes only reads.

## Start and verify

Set the Compose variables in a private environment file: `HARNESS_IMAGE`, `SOURCE_REVISION`, `RELEASE_DIR`, `STATE_DIR`, `WORKSPACE_DIR`, `GRAPH_DATA_DIR`, `QWEN_API_KEY_FILE`, `HARNESS_BIND_ADDRESS`, `HARNESS_TRUSTED_HOSTS`, `DGX_QWEN_API_BASE_URL`, `VIEWERS_HTPASSWD_FILE`, `NEO4J_BIND_ADDRESS` (the DGX interface address), and `GRAPH_BACKEND_AUTH_FILE`. Start on `HARNESS_PORT=3081`; the trusted host includes that port. The model key stays in its mounted private file. `prepare.mjs` validates the SQLite and graph checksums and renders Linux paths and loopback endpoints under the private state directory.

```sh
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml config --quiet
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml build
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml up -d
node --test deploy/dgx-combined/prepare.test.mjs
```

Before switching, verify SQLite integrity and checksums, all vector counts/dimensions and representative queries, Neo4j counts/indexes and the graph snapshot projection, authenticated Web access, and the full knowledge-question regression. Retain raw answers, original evidence, and per-question review; deployment acceptance does not imply every answer is correct.

## Neo4j login

Set the existing `neo4j` user's password before enabling network access; `NEO4J_AUTH` does not replace an existing store's password. Keep login details outside Git. `GRAPH_BACKEND_AUTH_FILE` contains one `Basic <base64(username:password)>` header readable by container UID 1000. Treat it as a password. After a password change, update this file and restart `graph-backend`, or Harness graph queries fail.

Open `http://<DGX-address>:17475/browser/`, connect to `bolt://<DGX-address>:17687`, and sign in. These connectors use unencrypted transport within the deployment network. Verify unauthenticated queries return 401, authenticated HTTP and Bolt return expected graph counts, Browser renders sample paths, and Harness loopback queries succeed. The loopback proxy has no independent login and is reserved for trusted local processes; it does not restrict Cypher to reads. Neo4j Community's default account can modify data, so use read queries when browsing.

## Regulation history viewer

The read-only history page runs at `http://<DGX-address>:18103/` with the same Basic login as the SQLite and Chroma viewers. Its internal Python service listens only on loopback port 18106. It reads fixed Neo4j projections through the existing graph proxy, and reads original text from SQLite mounted read-only. Names, document numbers and regions filter the catalog; versions, associated regulations, timelines and source-line highlights use the original G6 viewer assets. The separate legacy reference instance is not included in the source selector.

Set `HISTORY_VIEWER_DATA_DIR` to the portable viewer evidence directory and `POLICY_SQLITE_SHA256` to the admitted database digest. Preserve the original viewer metadata for all nine SDK graph partitions, review decisions, ledger and eight supplemental originals. The supplemental manifest uses paths relative to the evidence directory; verify every file against `viewer-files-manifest.json` before starting. These runtime evidence files stay outside Git. `history-viewer` and `history-gateway` can be recreated independently; stopping them leaves Harness and its databases running. The gateway requires login for HTML, scripts and API routes, and rejects writes; no arbitrary Cypher endpoint is exposed.

## Backup, switch, and restore

Before migration, record old container inspections and restart policies privately, export their images, preserve the actual source and local overrides, and snapshot every mounted database and state directory while its writers are stopped. Verify the archives and SQLite integrity, then resume the old deployment until acceptance.

After acceptance, stop the old application and database/viewer containers, set their restart policies to `no`, and recreate the new Harness on port 3080. Keep the old containers, images, data, credentials, and verified backup. Switch database viewers to the new snapshot and vector read adapter. Preserve the independent model services. To restore, stop the new services, restore the recorded old restart policies, and start the old data services followed by the old Harness and viewers. Recheck login and a real query. Never delete volumes during either switch.

Commit source, tests, deployment files, and documentation only. Database payloads, credentials, login URLs, private environment files, sessions, and backup archives remain outside Git.
