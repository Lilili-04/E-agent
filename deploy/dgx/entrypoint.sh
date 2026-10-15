#!/bin/sh
set -eu
umask 077

: "${HARNESS_TRUSTED_HOSTS:?set HARNESS_TRUSTED_HOSTS to the browser host:port}"
: "${DGX_POLICY_API_TOKEN_FILE:?set DGX_POLICY_API_TOKEN_FILE to the mounted policy token}"
: "${DGX_QWEN_API_KEY_FILE:?set DGX_QWEN_API_KEY_FILE to the mounted model API key}"

if [ ! -r "$DGX_POLICY_API_TOKEN_FILE" ] || [ ! -s "$DGX_POLICY_API_TOKEN_FILE" ]; then
    echo 'Harness: policy token file is missing, empty, or unreadable.' >&2
    exit 1
fi
if [ ! -r "$DGX_QWEN_API_KEY_FILE" ] || [ ! -s "$DGX_QWEN_API_KEY_FILE" ]; then
    echo 'Harness: model API key file is missing, empty, or unreadable.' >&2
    exit 1
fi
DGX_QWEN38_API_KEY="$(cat "$DGX_QWEN_API_KEY_FILE")"
if [ -z "$DGX_QWEN38_API_KEY" ]; then
    echo 'Harness: model API key is empty.' >&2
    exit 1
fi
export DGX_QWEN38_API_KEY

node /app/deploy/dgx/prepare-config.mjs

# The public profile launcher remains PID 1 beneath Docker's init process.
exec node /app/apps/cli/lib/bin.js "$@"
