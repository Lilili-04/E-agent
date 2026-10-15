#!/bin/sh
# Keyless image smoke; owns a temporary network, Compose project and bind mounts.
set -eu
umask 077
image="${HARNESS_IMAGE:-e-agent-harness:local}"
root="$(mktemp -d "${TMPDIR:-/tmp}/e-agent-harness-smoke.XXXXXX")"
project="e-agent-smoke-$(basename "$root" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
compose_file="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/docker-compose.yml"
export HARNESS_IMAGE="$image" HARNESS_BIND_ADDRESS=127.0.0.1 HARNESS_PORT=0
export HARNESS_TRUSTED_HOSTS=127.0.0.1 POLICY_RETRIEVAL_NETWORK="$project"
export HARNESS_STATE_DIR="$root/state" HARNESS_WORKSPACE_DIR="$root/workspace"
export POLICY_API_TOKEN_FILE="$root/policy-token" QWEN_API_KEY_FILE="$root/qwen-key"

compose() { docker compose --project-name "$project" --env-file /dev/null -f "$compose_file" "$@"; }
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$status" -ne 0 ]; then
        compose logs --no-color harness 2>&1 | sed -E 's/token=[^ )]+/token=[redacted]/g' >&2 || true
    fi
    compose down --timeout 20 >/dev/null 2>&1 || true
    docker network rm "$project" >/dev/null 2>&1 || true
    rm -rf -- "$root"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir "$root/state" "$root/workspace"
# The outer mktemp directory stays private; these mounts hold only disposable test data.
chmod 777 "$root/state" "$root/workspace"
printf '%s' 'keyless-smoke-policy-token-00000000' > "$POLICY_API_TOKEN_FILE"
printf '%s' 'keyless-smoke-model-key' > "$QWEN_API_KEY_FILE"
chmod 444 "$POLICY_API_TOKEN_FILE" "$QWEN_API_KEY_FILE"
docker network create "$project" >/dev/null
compose config --quiet
compose up --no-build --detach --wait --wait-timeout 180 harness
docker run --rm --entrypoint sh "$image" -c 'test ! -e /app/.env && test ! -e /app/.dsh-build && test ! -e /app/data && test ! -e /app/.git'
compose exec -T harness node -e "fetch('http://127.0.0.1:3080/').then(async r=>{if(!r.ok||!(await r.text()).includes('__DSH_BOOT__'))process.exit(1)}).catch(()=>process.exit(1))"
echo 'Harness image smoke passed; database and model services were not started.'
