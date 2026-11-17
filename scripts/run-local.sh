#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PORT:?}" "${WEFT_DB_PATH:?}" "${WEFT_KEY_FILE:?}"
WEFT_SECRET="$(cat "$WEFT_KEY_FILE")"
export WEFT_SECRET WEFT_DB_PATH
export WEFT_OPENAI_CALLBACK_PORT="$PORT"
unset WEFT_KEY_FILE
exec uv run --project backend --frozen uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port "$PORT" --no-proxy-headers --no-access-log
