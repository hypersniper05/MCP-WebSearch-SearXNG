@echo off
REM mcp.cmd — wrapper for `docker compose` that respects MCP_HTTPS in .env
REM Usage: same as `docker compose`, e.g. `mcp up -d`, `mcp down`, `mcp logs -f`

REM Load MCP_HTTPS from .env if present
if exist ".env" (
    for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
        if /i "%%A"=="MCP_HTTPS" set "MCP_HTTPS=%%B"
    )
)

REM Strip any quotes/whitespace
set "MCP_HTTPS=%MCP_HTTPS:"=%"

if /i "%MCP_HTTPS%"=="true" (
    set "COMPOSE_FILE=docker-compose.yml;docker-compose.https.yml"
    echo [mcp] HTTPS mode enabled (Caddy will terminate TLS on ports 8888 and 3001^)
)

docker compose %*
