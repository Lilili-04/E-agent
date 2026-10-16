# Run the environment-policy Harness on DGX

English | [中文](dgx-deployment.zh.md)

This guide runs the Web UI and Agent in a dedicated Docker container on DGX. Browsers connect to that container; the retrieval API coordinates keyword and semantic channels over SQLite source data and Chroma indexes. SQLite is an embedded source database, not a network service; logical responsibilities and container placement are separate concerns. The configuration is in [deploy/dgx](../../../deploy/dgx), and the reusable Agent preset is [environment-policy-dgx.patch.yml](../../../apps/cli/config/examples/environment-policy-dgx.patch.yml).

## Deployment layout

The Harness image contains application code and dependencies. It contains no corpus, SQLite file, vector index, model weights, or credentials.

| Component | Container | Persistent data / interface |
| --- | --- | --- |
| Web UI and Agent | New Harness Compose project | Separate Harness state and workspace directories; browser port 3080 |
| Retrieval service | Existing `e-agent-policy-api` | Coordinates recall and reads a separate persistent SQLite source snapshot read-only; HTTP 8080 inside Docker |
| Semantic retrieval index | Existing `chroma` | Rebuildable vectors and source addresses in its own persistent directory; HTTP 8000 inside Docker |
| Embedding model | Existing `vllm-qwen3-embedding-4b` | Its own model directory; HTTP 8000 inside Docker |
| Answer model | Existing `vllm-qwen38-27b` | Its own model directory; OpenAI-compatible HTTP 8000 inside Docker |

SQLite is an embedded database: the separate retrieval API container opens it read-only, rather than exposing a SQL database port. Harness never mounts that database. Updating or stopping the Harness Compose project does not update, restart, or remove any of the four existing services or their data. Their setup remains in the [retrieval deployment guide](../../../packages/experimental/environment-policy/deploy/README.md).

```text
Browser → Harness container → policy API container → candidate recall / fusion → SQLite source evidence
                  │                    └→ lexical indexes + embedding / Chroma semantic indexes
                  └→ Qwen generation container → cited answer
```

## Database viewers

Whether Harness runs on DGX or locally, database viewer pages are deployed only once on DGX. An optional separate Compose project provides Datasette and ChromaDB UI with a shared, separate login. SQLite is mounted read-only; the gateway blocks Chroma writes. See the [viewer deployment guide](../../../deploy/db-viewers/README.md) for configuration, ports, and verification.

## Prepare the server

Use an ARM64 Linux DGX with Docker Engine and the Compose plugin, enough disk for the source build, and working access to the Node image, Debian package repositories, and npm registry. The Harness container uses CPU and does not request a GPU. The existing containers must already be running on the external `policy-retrieval` network.

From the repository root, create private state and credential directories. UID/GID 1000 must match the container's `node` user; the commands copy the two existing credentials without changing their originals.

```bash
cp deploy/dgx/.env.example deploy/dgx/.env
sudo install -d -o 1000 -g 1000 -m 700 /srv/e-agent/harness-state /srv/e-agent/harness-workspace /srv/e-agent/harness-secrets
sudo install -o 1000 -g 1000 -m 400 /srv/e-agent/policy-api/.secrets/policy-token /srv/e-agent/harness-secrets/policy-token
sudo install -o 1000 -g 1000 -m 400 /home/health/vllm/qwen38/.secrets/qwen38-api-key /srv/e-agent/harness-secrets/qwen-api-key
docker network inspect policy-retrieval
```

Edit `deploy/dgx/.env` for the target machine. `HARNESS_BIND_ADDRESS` is the host's intranet IP; `HARNESS_TRUSTED_HOSTS` is a comma-separated list of browser authorities, including the published port, such as `172.27.153.44:3080`. Add the reverse proxy's authority if one is used. The default internal service URLs use Docker names and ports, not the host's published ports. Credential variables name host files; do not paste keys into this file or YAML. The `.env`, state, workspace, and secret directories are ignored by Git and excluded from the build context. Startup generates `/state/dsh/deployment/dgx.patch.yml` with a literal model endpoint and credential reference; change deployment values in `.env` or the source template, since this generated patch is replaced on restart.

For the current DGX, the example uses policy API `http://e-agent-policy-api:8080` and model API `http://vllm-qwen38-27b:8000/v1`. A different Docker network, service name, or deployment directory requires corresponding `.env` changes. Do not copy a Windows `.dsh-build` patch or Windows `node_modules` to the server.

## Build and start

Run these commands in `deploy/dgx`. The image installs locked Linux dependencies, builds the application and native helpers, and then starts the supported `dsh web` profile. It does not download or start databases or models.

The build context includes snapshot helper modules and their type declarations for Host typechecking, plus the Vitest configuration used by the image's startup test. Recorded session data remains excluded. Keep these build inputs when changing `.dockerignore`.

The application filesystem is read-only. Its `/tmp` tmpfs allows execution because the native module loader and subprocess helpers use executable temporary files; retaining Docker's default `noexec` for that mount prevents startup. Keep `/tmp:exec,mode=1777` in the Compose configuration.

```bash
cd deploy/dgx
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps
docker compose logs --tail 30 harness
```

The startup log prints a process-authenticated URL. For direct intranet access, use that URL's token with `http://<HARNESS_BIND_ADDRESS>:<HARNESS_PORT>/?token=...`; do not share logs or token-bearing URLs publicly. The Docker-only overlay listens on container interfaces, while Compose publishes only the selected host IP. Host/Origin checks and the process token remain enabled; this configuration does not change the CLI's default loopback binding. Use HTTPS or an SSH tunnel across untrusted networks.

On first opening the page, add `/workspace` as the workspace. The new-session preset is **环境政策法规问答**, and the default model is **Qwen3.8-27B（DGX NVFP4）**, model ID `qwen3.8-27b`, context 32768, maximum output 2048, thinking disabled. Date context is enabled for current-status searches. Saved settings and existing chats can retain their own model selections. All users of this instance share its sessions, settings, and workspace; it is not a multi-tenant isolation system.

## Restart, update, and rollback

Use the following commands from `deploy/dgx`. `restart` reuses the current image; source changes require a rebuild. Record the current image ID and retain the previous image before updating. Back up the Harness state and workspace separately from the retrieval database and Chroma index.

```bash
docker compose restart harness
docker compose images
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose build
docker compose up -d --wait --no-deps harness
```

To roll back application code, set `HARNESS_IMAGE` to the retained image tag in `.env`, then run `docker compose up -d --no-build --wait harness`. Restore a compatible state backup if the application version changes persisted formats. `docker compose stop harness` stops only this Harness; it does not stop the retrieval or model Compose projects. Do not use database resets or vector rebuilds as part of a Harness upgrade.

## Verify and troubleshoot

Check the page, a policy lookup, and the existing retrieval and model services separately. Container health expects the unauthenticated index to return HTTP 401; this verifies the Web listener while preserving browser authentication, but does not prove that downstream services or model credentials work. The image smoke exchanges the temporary startup token for a browser cookie and verifies the authenticated page returns HTTP 200.

| Symptom | Check |
| --- | --- |
| Image build fails | Node image, Debian/npm connectivity, locked package manager, and ARM64 native build output |
| Container exits before startup | Nonempty credential files, UID 1000 read permission, and `HARNESS_TRUSTED_HOSTS` |
| Browser rejects connection | Published IP/port, exact Host/Origin authority, and the current process token |
| HTTP 401 from retrieval or model | The two separate secret files and matching upstream credentials |
| Retrieval unavailable | Existing policy API health and membership of `policy-retrieval` |
| Model unavailable | Existing Qwen health, served model name, and `/v1` base URL |
| State cannot be saved | Host directories must exist and be writable by UID 1000 |

The optional preset can also be used with a local source checkout: set a private `DSH_HOME`, provide `DGX_POLICY_API_URL`, `DGX_POLICY_API_TOKEN_FILE`, `DGX_QWEN_API_BASE_URL`, and credential `DGX_QWEN38_API_KEY`, then run `node deploy/dgx/prepare-config.mjs`. Start `pnpm dsh web --patch <DSH_HOME>/deployment/dgx.patch.yml --no-open` with the actual home path. Omit the Docker-only `web.patch.yml`; local mode keeps the normal loopback listener. Corpus preparation and retrieval diagnostics remain in the [retrieval deployment guide](../../../packages/experimental/environment-policy/deploy/README.md).
