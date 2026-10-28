#!/bin/sh
# Keyless image smoke; owns a temporary network, Compose project and bind mounts.
set -eu
umask 077
image="${HARNESS_IMAGE:-e-agent-harness:local}"
root="$(mktemp -d "${TMPDIR:-/tmp}/e-agent-harness-smoke.XXXXXX")"
project="e-agent-smoke-$(basename "$root" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
compose_file="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/docker-compose.yml"
export HARNESS_IMAGE="$image" HARNESS_BIND_ADDRESS=127.0.0.1 HARNESS_PORT=0
export HARNESS_TRUSTED_HOSTS=127.0.0.1:3080 POLICY_RETRIEVAL_NETWORK="$project"
export HARNESS_SOURCE_REVISION=0000000 # Fixture only; this smoke never builds an image.
export HARNESS_STATE_DIR="$root/state" HARNESS_WORKSPACE_DIR="$root/workspace"
export QWEN_API_KEY_FILE="$root/qwen-key" POLICY_V2_DATA_DIR="$root/policy-data"
export POLICY_DOCUMENT_COLLECTION=fixture-documents POLICY_PASSAGE_COLLECTION=fixture-passages

compose() { docker compose --project-name "$project" --env-file /dev/null -f "$compose_file" "$@"; }
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$status" -ne 0 ]; then
        compose logs --no-color harness 2>&1 | sed -E 's/token=[^ )]+/token=[redacted]/g' >&2 || true
    fi
    compose down --timeout 20 >/dev/null 2>&1 || true
    docker network rm "$project" >/dev/null 2>&1 || true
    # Reclaim only this private fixture tree when the runtime UID differs from the host runner.
    docker run --rm --network none --user 0:0 --entrypoint chown \
        --mount "type=bind,src=$root,dst=/smoke-fixture" "$image" \
        -R "$(id -u):$(id -g)" /smoke-fixture
    rm -rf -- "$root"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir "$root/state" "$root/workspace" "$root/policy-data"
# The outer mktemp directory stays private; these mounts hold only disposable test data.
chmod 777 "$root/state" "$root/workspace" "$root/policy-data"
printf '%s' 'keyless-smoke-model-key' > "$QWEN_API_KEY_FILE"
chmod 444 "$QWEN_API_KEY_FILE"
docker run --rm --entrypoint node --mount "type=bind,src=$POLICY_V2_DATA_DIR,dst=/policy-data" "$image" /app/deploy/dgx/create-smoke-policy.mjs /policy-data
docker network create "$project" >/dev/null
compose config --quiet
compose up --no-build --detach --wait --wait-timeout 180 harness
docker run --rm --entrypoint sh "$image" -c '
    test ! -e /app/.env && test ! -e /app/data && test ! -e /app/.git &&
    test -f /app/.dsh-build/client-build-environment.json &&
    test -z "$(find /app/.dsh-build -mindepth 1 ! -path /app/.dsh-build/client-build-environment.json -print -quit)" &&
    test -f /app/vitest.expected.config.ts && test -f /app/vitest.shared.ts &&
    test -f /app/snapshots/session/session-query-spill/resolve-spill-command.mjs &&
    test -f /app/snapshots/session/session-query-spill/resolve-spill-command.d.mts &&
    test -z "$(find /app/snapshots -name "*.jsonl" -print -quit)"
'
compose logs --no-color harness | compose exec -T harness node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const base = "http://127.0.0.1:3080/";
    assert.equal((await fetch(base)).status, 401);
    const launch = readFileSync(0, "utf8").match(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/);
    assert.ok(launch, "Missing authenticated startup URL");
    const login = await fetch(launch[0], { redirect: "manual" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie, "Missing authenticated browser cookie");
    const page = await fetch(base, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("__DSH_BOOT__"));
'
echo 'Harness image smoke passed; database and model services were not started.'
