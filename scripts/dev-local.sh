#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

BACKEND_PORT="${WEFT_BACKEND_PORT:-8000}"
FRONTEND_PORT="${PORT:-9099}"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

ROOT="$(pwd)"
if [[ -z "${WEFT_DEV_SECRET:-}" ]]; then
  echo "Set WEFT_DEV_SECRET explicitly in .env. Follow README local-development setup; preserve existing installation keys and data." >&2
  exit 1
fi
export WEFT_BACKEND_PORT="$BACKEND_PORT"
export PORT="$FRONTEND_PORT"
export WEFT_OPENAI_CALLBACK_PORT="$BACKEND_PORT"
WEFT_SECRET="$WEFT_DEV_SECRET" \
WEFT_DB_PATH="$ROOT/data/dev.db" \
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port "$BACKEND_PORT" --no-proxy-headers --no-access-log --reload --reload-dir backend &
BACKEND_PID=$!

cd frontend
npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort &
FRONTEND_PID=$!

stop_servers() {
  trap '' INT TERM
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

trap stop_servers EXIT
trap 'exit 0' INT TERM

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
echo "A development server exited. Stopping Weft." >&2
exit 1
