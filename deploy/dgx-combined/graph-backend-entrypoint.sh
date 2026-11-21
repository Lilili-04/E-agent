#!/bin/sh
set -eu
GRAPH_AUTHORIZATION=$(cat /run/secrets/graph_backend_auth)
export GRAPH_AUTHORIZATION
umask 077
envsubst '${GRAPH_AUTHORIZATION}' < /deployment/graph-backend.conf.template > /tmp/graph-backend.conf
exec nginx -c /tmp/graph-backend.conf -g 'daemon off;'
