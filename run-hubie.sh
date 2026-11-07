#!/usr/bin/env bash
# Hubie Live — Linux supervisor loop.
# Node restarts dead children; this loop restarts Node if the process dies.
set -u
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[hubie] installing dependencies"
  npm install
fi

if ! node scripts/bootstrap.mjs --check; then
  echo "[hubie] vendored binaries missing, downloading"
  node scripts/bootstrap.mjs
fi

while true; do
  echo "[hubie] starting $(date -u +%FT%TZ)"
  node src/index.js || true
  echo "[hubie] process exited, restarting in 5s"
  sleep 5
done
