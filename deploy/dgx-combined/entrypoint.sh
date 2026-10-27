#!/bin/sh
set -eu
umask 077
: "${POLICY_RELEASE_DIR:?}"
: "${DGX_QWEN_API_KEY_FILE:?}"
: "${HARNESS_BIND_ADDRESS:?}"
: "${HARNESS_PORT:?}"
: "${HARNESS_TRUSTED_HOSTS:?}"
DGX_QWEN36_API_KEY="$(cat "$DGX_QWEN_API_KEY_FILE")"
test -n "$DGX_QWEN36_API_KEY"
export DGX_QWEN36_API_KEY
node /app/deploy/dgx-combined/prepare.mjs
exec node /app/apps/cli/lib/bin.js "$@"
