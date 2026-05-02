#!/usr/bin/env bash
# mcp.sh — wrapper for `docker compose` that respects MCP_HTTPS in .env
# Usage: same as `docker compose`, e.g. `./mcp.sh up -d`, `./mcp.sh down`, `./mcp.sh logs -f`

set -euo pipefail

# Load MCP_HTTPS from .env if present (one variable, no full sourcing for safety)
if [ -f .env ]; then
    MCP_HTTPS="$(grep -E '^[[:space:]]*MCP_HTTPS[[:space:]]*=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r"' | xargs || true)"
fi

if [ "${MCP_HTTPS:-}" = "true" ]; then
    export COMPOSE_FILE="docker-compose.yml:docker-compose.https.yml"
    echo "[mcp] HTTPS mode enabled (Caddy will terminate TLS on ports 8888 and 3001)"
fi

exec docker compose "$@"
