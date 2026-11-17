#!/usr/bin/env bash
# Source checks plus a runtime smoke test on disposable data. Used by CI and the release workflow.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd backend && uv run --frozen python -m compileall -q app)
(cd backend && uv run --frozen python -m unittest discover -s tests)
(cd frontend && npm ci --no-audit --no-fund && npm run lint && npm run build -- --outDir ../backend/app/static --emptyOutDir)

DATA="$(mktemp -d)"
trap 'kill "${SERVER:-}" 2>/dev/null || true; rm -rf "$DATA"' EXIT
python3 -c 'import secrets; print(secrets.token_hex(32))' > "$DATA/installation.key"
PORT=9399 WEFT_DB_PATH="$DATA/weft.db" WEFT_KEY_FILE="$DATA/installation.key" scripts/run-local.sh > "$DATA/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 60); do
  curl -sf http://127.0.0.1:9399/health > /dev/null && break
  sleep 1
done
BASE=http://localhost:9399
curl -sf -c "$DATA/cookies" -H "Origin: $BASE" -H 'Content-Type: application/json' -d '{"password":""}' "$BASE/login" > /dev/null || { cat "$DATA/server.log"; exit 1; }
curl -sf -b "$DATA/cookies" -H "Origin: $BASE" "$BASE/api/categories" | python3 -c 'import json, sys; assert len(json.load(sys.stdin)) > 0'
curl -sf "$BASE/" | grep -q '<div id="root">'
echo "Checks passed."
