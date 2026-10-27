#!/bin/sh
set -eu
: "${VIEWERS_BIND_ADDRESS:?}"
: "${SQLITE_VIEWER_PORT:?}"
: "${CHROMA_VIEWER_PORT:?}"
export CHROMA_UPSTREAM=127.0.0.1:18104
envsubst '${CHROMA_UPSTREAM} ${VIEWERS_BIND_ADDRESS} ${SQLITE_VIEWER_PORT} ${CHROMA_VIEWER_PORT}' \
  < /deployment/viewers.conf.template > /tmp/combined-nginx.conf
exec nginx -c /tmp/combined-nginx.conf -g 'daemon off;'
