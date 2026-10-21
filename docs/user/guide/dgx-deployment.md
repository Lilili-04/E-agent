# Run the environment-policy Harness on DGX

English | [中文](dgx-deployment.zh.md)

The new Harness container executes retrieval directly, mounting host SQLite read-only. Chroma, embedding and answer models remain separate. Configuration lives in [deploy/dgx](../../../deploy/dgx), with the preset in [environment-policy-dgx.patch.yml](../../../apps/cli/config/examples/environment-policy-dgx.patch.yml).

## Deployment layout

```text
Browser → Harness container (Agent, policy_search, policy_read, BM25, fusion)
                  ├─ /policy-data → Host SQLite and legacy-vector mapping (read-only)
                  ├─ Chroma container
                  ├─ Embedding model container
                  └─ Answer model container
```

The image excludes business data, model weights and credentials. The old policy API may continue serving older clients; the new preset does not call it. SQLite exposes no SQL server port. Updating Harness alone does not update Chroma or models.

## Database viewers

Viewers remain in the [separate DGX deployment](../../../deploy/db-viewers/README.md). After switching SQLite, the maintainer points the read-only viewer mount at the same snapshot.

## Prepare the server

The server needs Docker Engine, Compose, ARM64 Node build inputs and the external `policy-retrieval` network. Harness uses CPU. Chroma, embedding and answer models must already run on that network. Never copy Windows node_modules or private launch patches to Linux.

Copy `deploy/dgx/.env.example` to private `.env`. Set the published IP, `HARNESS_TRUSTED_HOSTS`, state/workspace directories writable by UID 1000, and a model secret readable by UID 1000 through `QWEN_API_KEY_FILE`. The old policy API secret is no longer required.

`POLICY_V2_DATA_DIR` selects an independently published directory containing `POLICY_V2_DB_FILE` (default `policy-v2-national.sqlite`) and `POLICY_V2_COMPATIBILITY_FILE` (default `policy-v2-documents.compat.json`). Generate both in the same offline import and publish together; renaming a v1 database is not migration. Mount only the host directory; data never enters the image or Git. See the [package guide](../../../packages/experimental/environment-policy/README.md) for builders. Stored source paths are traceability metadata; online reading uses SQLite full text without requiring Windows paths.

Configure `POLICY_EMBEDDING_URL`, `POLICY_CHROMA_URL`, `POLICY_EMBEDDING_MODEL`, `POLICY_DOCUMENT_COLLECTION` and `POLICY_PASSAGE_COLLECTION`. Default URLs use Docker names and internal ports. Collections must be existing national indexes; hits require matching build and source mappings. `POLICY_SEMANTIC_TIMEOUT_MS` defaults to 5000. Startup writes configuration to private state rather than the business-data directory.

## Build and start

```bash
cd deploy/dgx
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps
docker compose logs --tail 30 harness
```

Application and data mounts stay read-only; `/tmp:exec,mode=1777` supports native helpers. Startup checks readable data/secret files, generates configuration, then launches through the `dsh web` profile. Listener health is not a substitute for a real policy question.

Open the authenticated URL from startup logs using the configured published address and port; share authentication privately. Start a new chat with “环境政策法规问答”. The default DGX model is `qwen3.6-35b-a3b-vllm`, context 196608, maximum output 2048, thinking disabled. Existing chats may retain an old preset; one instance shares sessions/workspaces and has no multi-tenant isolation.

## Local Harness with DGX data

The local [remote preset](../../../apps/cli/config/examples/environment-policy-remote-dgx.patch.yml) uses Qwen3.6 and v2 HTTP search/read. SQLite, vectors and retrieval execute on DGX; local sessions and the Web application stay on the PC. The client requires no SQLite snapshot. The old port 18080 API is incompatible with v2 pagination.

After building the updated image, enable the optional [API overlay](../../../deploy/dgx/docker-compose.policy-api.yml). Set `POLICY_V2_API_TOKEN_FILE` to a private token file readable by UID 1000, containing at least 32 random characters; transfer its contents securely to the local `.dsh-build/dgx-policy-v2.token`. Publish port 18081 only on the private DGX address. Include existing Compose model overrides when applying the overlay; inspect the merged configuration before recreating Harness. Existing Qwen3.6 model overrides must remain in effect.

```bash
docker compose -f docker-compose.yml -f docker-compose.policy-api.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.policy-api.yml up -d --wait --no-deps harness
```

These commands show a fresh installation; an existing `docker-compose.override.yml` must also be supplied with `-f` before the API overlay. Do not remove a model patch from an existing overridden command; keep the API patch after the model patch. The API uses the same mounted database and semantic configuration as Web retrieval.

On Windows, save the model key privately in `.dsh-build/qwen-api.key`. From the repository root, run the following with dependencies and package builds prepared. Startup checks the authenticated v2 status and served Qwen3.6 model before starting the local Web profile on `127.0.0.1:3080`; use its current authenticated startup URL. It does not terminate an existing listener. New chats use the remote v2 preset; existing chats can retain prior model selections.

```powershell
./deploy/local/start-policy-web.ps1
```

## Restart, update, and rollback

For unchanged configuration/data run `docker compose restart harness`. Rebuild after code changes, then `docker compose up -d --wait --no-deps harness`. Retain old images and data directories; switch SQLite and mapping together. Rollback requires compatible image, data directory and state backup. Never replace version switching with automatic vector rebuilds or database resets.

## Verify and troubleshoot

Check an exact article, a topical question and a full read of at least two pages. `policy_read` must continue to `has_more=false`. A healthy page or BM25 match does not establish working vectors or generation.

| Symptom | Check |
| --- | --- |
| Container exits on startup | Both data files exist and UID 1000 can read them; nonempty model key; configured browser Host |
| New tools missing | New chat, preset and image revision; do not reuse old remote-service settings |
| Semantic degradation | Chroma/embedding network, model/collection names, build ID and source-hash mapping |
| Model fails | Qwen health, model name, key and `/v1` endpoint |
| Page unavailable | Published IP/port, Host/Origin and current authenticated URL |

Source evidence includes plugin tests, configuration tests and a built Web profile check; GitHub CI owns the ARM64 image build and isolated-data startup smoke. A maintainer deploys DGX after merging; merging does not deploy automatically. The [old deployment guide](../../../packages/experimental/environment-policy/deploy/README.md) remains for API maintenance.
