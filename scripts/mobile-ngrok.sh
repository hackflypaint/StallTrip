#!/usr/bin/env bash
# Tunnel local planner (port 8080) with ngrok so phones can open /mobile.
# Zero repo secrets — uses your local ngrok config or NGROK_AUTHTOKEN env.
#
# Usage (on a machine where ngrok is already set up):
#   python3 server.py 8080          # or: docker compose up -d
#   ./scripts/mobile-ngrok.sh
# Then open: https://<ngrok-host>/mobile
#
set -euo pipefail

PORT="${PORT:-8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok not found on PATH. Install from https://ngrok.com/download" >&2
  echo "Auth locally (do not commit the token):" >&2
  echo "  ngrok config add-authtoken \"\$NGROK_AUTHTOKEN\"" >&2
  exit 1
fi

if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Nothing healthy on :${PORT}. Start the app first, e.g.:" >&2
  echo "  cd \"${ROOT}\" && COST_PROFILE=lean python3 server.py ${PORT}" >&2
  echo "  # or: docker compose up -d" >&2
  exit 1
fi

MOBILE="http://127.0.0.1:${PORT}/mobile"
echo "Local mobile shell: ${MOBILE}"
echo "Starting ngrok http ${PORT} …"
echo "When ngrok prints a Forwarding https://… URL, open:"
echo "  https://<that-host>/mobile"
echo "(API health: https://<that-host>/api/health)"
echo "Ctrl+C stops the tunnel only — leave the app running."
echo

# Prefer config file / prior 'ngrok config add-authtoken'. Env token also works.
exec ngrok http "${PORT}"
