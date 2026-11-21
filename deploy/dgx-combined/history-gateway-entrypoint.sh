#!/bin/sh
set -eu
: "${HISTORY_BIND_ADDRESS:?}"
umask 077
envsubst '${HISTORY_BIND_ADDRESS}' < /deployment/history-gateway.conf.template > /tmp/history-nginx.conf
exec nginx -c /tmp/history-nginx.conf -g 'daemon off;'
