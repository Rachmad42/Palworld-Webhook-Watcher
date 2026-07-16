#!/bin/sh
set -eu

mkdir -p /app/data /app/config
chown -R node:node /app/data /app/config 2>/dev/null || true

exec su-exec node "$@"
