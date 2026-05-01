# Privacy, Security & Advanced Hardening

This stack is privacy-respecting in design but is **not anonymous out of the box**. This document covers exactly what is and isn't protected by default, and how to harden it further if you need to.

## Table of Contents
- [Protections built in](#protections-built-in)
- [Residual exposure (what still leaks by default)](#residual-exposure-what-still-leaks-by-default)
- [Hardening beyond the defaults](#hardening-beyond-the-defaults)
  - [Tier 1 — Easy wins](#tier-1--easy-wins-start-here-takes-10-minutes)
  - [Tier 2 — Network hardening](#tier-2--network-hardening)
  - [Tier 3 — Full anonymity](#tier-3--full-anonymity)
- [Modifying the default settings](#modifying-the-default-settings)
- [Building from scratch (without cloning)](#building-from-scratch-without-cloning)

---

## Protections built in

| Protection | How it's enforced |
|---|---|
| **Zero telemetry** — no phone-home, ever | No Sentry / PostHog / Datadog / Google Analytics in the MCP patches; SearXNG sends no usage stats |
| **No user state** — nothing tied to you | No accounts, no search history, no per-user logging to disk |
| **No autocomplete keystroke streaming** | `autocomplete: ""` — your typing never reaches a third-party suggestion service |
| **Queries stay out of browser history** | `query_in_title: false` — your search terms don't appear in the page title |
| **Tracking params stripped from results** | `tracker_url_remover` plugin removes `utm_*`, `fbclid`, `gclid`, etc. before showing you the link |
| **No cookies, no auth headers, no API keys** | The stack works fully without any third-party credentials |
| **All data is local** | Lives in Docker volumes on your machine — nothing syncs to a cloud |

## Residual exposure (what still leaks by default)

| Leak | Why it happens | Fix |
|---|---|---|
| **Your IP reaches upstream engines** | SearXNG queries Bing / Yahoo / Mojeek / etc. from your machine's IP. They can't see *who* you are, but they see *where* the query came from | Route SearXNG through Tor or a VPN — see Tier 3 |
| **`web_url_read` reveals your IP to the target site** | Same as opening the page in a normal browser | Same proxy treatment for the MCP container — Tier 3 |
| **Services are reachable from your LAN** | `docker-compose.yml` binds ports `8888` and `3001` to `0.0.0.0` — anyone on your network can hit them | Bind to `127.0.0.1` — Tier 1 |
| **No authentication on the MCP endpoint** | Anything that can reach `:3001/mcp` can use it; the server itself has no auth | Put a reverse proxy with auth in front — Tier 2 |
| **Prometheus metrics endpoint is on** | `enable_metrics: true` exposes performance counters at `/stats`. Not user data, but extra attack surface | Disable in `settings.yml` — Tier 2 |

---

## Hardening beyond the defaults

> **You do not need any of this to get the stack running.** The defaults work fine for a single user on their own trusted machine. This section is for going further — locking things down for a shared network, a public-facing deployment, or full anonymity.
>
> Hardening is organized into three tiers from easiest to most advanced. **Pick the tier that matches your situation and stop there** — you don't need to do all three unless you want full anonymity. Each tier builds on the previous one.

### Tier 1 — Easy wins (start here, takes ~10 minutes)

These three changes cost almost nothing and close the most common holes. If you change nothing else, do these.

1. **Set a strong `server.secret_key`** in `settings.yml` (random 64-character string). Do not commit this. Generate one with whichever tool you already have installed:
   ```powershell
   # PowerShell (Windows — built in, no install needed)
   [System.BitConverter]::ToString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('-','').ToLower()
   ```
   ```bash
   # Node.js (you already have it for the MCP server)
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   # Docker (works on any OS that runs this stack)
   docker run --rm alpine sh -c "apk add --no-cache openssl > /dev/null && openssl rand -hex 32"

   # Git Bash / Linux / macOS
   openssl rand -hex 32

   # Python (any platform with Python installed)
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
   Better still: leave `secret_key` as a placeholder in the file and set the `SEARXNG_SECRET` env var (it overrides the file value), so the secret never lives on disk in a tracked file.

2. **Service binding (already localhost-only by default).** The shipped `docker-compose.yml` binds the services to `127.0.0.1`, which means only software running on your own machine can reach them. Nothing extra to do here.

   **If you *want* LAN access** (so other devices on your home network can hit the SearXNG UI or your LLM client can connect from a separate machine), change the bindings to `0.0.0.0`:
   ```yaml
   ports:
     - "0.0.0.0:8888:8080"   # SearXNG — exposes UI to your LAN
     - "0.0.0.0:3001:3001"   # MCP — exposes endpoint to your LAN
   ```
   ⚠️ **The MCP server has no authentication** — anyone on your network who can reach `:3001/mcp` can use it. If you bind to `0.0.0.0`, you should also do **Tier 2** (reverse proxy with auth + host firewall rules) before leaving it running.

3. **Turn on the SearXNG limiter.** In `settings.yml`:
   ```yaml
   server:
     limiter: true
   ```
   Throttles anyone who tries to abuse the instance.

---

### Tier 2 — Network hardening

Do these if others share your network or you expose anything beyond localhost.

4. **Add authentication on the MCP endpoint.** The MCP server itself has *no* auth — anyone who can reach `:3001/mcp` can use it. Put a reverse proxy in front of port 3001 with HTTP basic auth, an API token, or mTLS. Easiest options:
   - [Caddy](https://caddyserver.com/) — single binary, basic auth in ~3 lines of Caddyfile
   - [nginx](https://nginx.org/) — most common, plenty of tutorials
   - [Traefik](https://traefik.io/) — Docker-native, integrates with `docker-compose.yml`

5. **Disable the metrics endpoint.** In `settings.yml`:
   ```yaml
   general:
     enable_metrics: false
   ```
   Removes the `/stats` page (performance counters — not user data, but extra attack surface).

6. **Block the ports at your host firewall.** Defense-in-depth — even with localhost binding from Tier 1, also block ports 8888 and 3001 at the OS firewall (Windows Defender Firewall, `ufw` on Linux, macOS Firewall).

---

### Tier 3 — Full anonymity

Your IP also hidden from upstream search engines. Only do this tier if you need search engines to not know *where* the queries came from. Real tradeoff: many engines block Tor exit nodes, so result quality and engine availability will drop.

7. **Route SearXNG outbound traffic through Tor or a trusted VPN.** In `settings.yml`:
   ```yaml
   outgoing:
     proxies:
       all://: socks5h://tor:9050
     using_tor_proxy: true
   ```
   Then add a Tor service to `docker-compose.yml` (e.g., the [`dperson/torproxy`](https://hub.docker.com/r/dperson/torproxy) image).

8. **Route `web_url_read` through Tor too.** Set `HTTPS_PROXY` and `HTTP_PROXY` env vars on the `mcp-searxng` service in `docker-compose.yml`, pointing at the same Tor/VPN proxy. Otherwise *reading* a URL still leaks your IP to that site, even if *searching* doesn't.

9. **Use a privacy-respecting DNS resolver.** Configure Docker to resolve through `1.1.1.1` (Cloudflare), `9.9.9.9` (Quad9), or a local Unbound resolver. Otherwise your ISP still sees every domain name you look up, even when the connection itself is over Tor.

> **The tiers are cumulative — gaps reopen if you skip lower ones.** Tier 3 alone (Tor without the localhost binding from Tier 1) still exposes your instance to anyone on your LAN. Tier 1 alone leaves your IP visible to upstream search engines. For genuine end-to-end privacy, you need all three tiers.

---

## Modifying the default settings

The shipped `settings.yml` is **already tuned for this stack** — JSON output enabled, rate limiter off, fast retries on suspended engines, curated set of working engines. You only need to touch this file if you want different defaults. Below is what's already set and how to change each piece.

### JSON output (required by the MCP server)

Already enabled:
```yaml
search:
  formats:
    - html
    - json
```
Don't disable JSON unless you also stop using the MCP server — it's the format the MCP patches parse.

### Rate limiter

Off by default for local use:
```yaml
server:
  limiter: false
```
Set to `true` if you expose the instance beyond your own machine (this is also Tier 1 of the [hardening section](#tier-1--easy-wins-start-here-takes-10-minutes)).

### Engine suspension times

Tuned for fast recovery — when an engine throws an error, it's only sidelined briefly before being retried:
```yaml
search:
  suspended_times:
    SearxEngineAccessDenied: 30   # seconds
    SearxEngineCaptcha: 60
    SearxEngineTooManyRequests: 30
```

### Request timeout

```yaml
outgoing:
  request_timeout: 5.0
```
Bump higher if your network is slow or you keep seeing engine timeouts.

### Search engines

The shipped config enables a curated set that work reliably from a self-hosted Docker instance and disables ones that consistently fail.

**Enabled by default**: Bing, Mojeek, Yahoo, Startpage, Presearch, Wiby, Crowdview, Yep, WolframAlpha (general web); plus images/videos/news variants. DuckDuckGo and Brave are also enabled in the shipped config — disable them with `disabled: true` if you start seeing CAPTCHAs or rate-limit errors from your IP.

**Disabled by default** (`disabled: true`):
- **Google** web/news/videos/images — persistent 403 from self-hosted IPs
- **Startpage News** — upstream date-parsing crash
- **Qwant** — access denied to non-EU/non-residential IPs
- **Yandex** — CAPTCHA
- **Wikidata, Mwmbl** — timeouts

### Re-enabling Google (mobile UI)

Google is disabled because it returns 403 from self-hosted instances. The mobile UI works better than the desktop one if you want to try re-enabling it:
```yaml
  - name: google
    engine: google
    shortcut: go
    use_mobile_ui: true
    disabled: false   # change from true
```
Expect intermittent failures even with mobile UI — Bing / Mojeek / Yahoo are more reliable fallbacks.

---

## Building from scratch (without cloning)

If you'd rather not clone this repository — for example, you want to understand exactly what each file does, or build it into an existing setup — here are the manual file-creation steps. The default install flow in [Project.md](Project.md) just clones everything; this section reproduces what `git clone` gives you.

### 1. Create the project directory

```bash
mkdir -p ~/searxng-stack
cd ~/searxng-stack
```

### 2. Create `docker-compose.yml`

```yaml
services:
  searxng:
    image: docker.io/searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    ports:
      - "0.0.0.0:8888:8080"
    volumes:
      - ./searxng/config:/etc/searxng
      - ./searxng/data:/var/cache/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/

  mcp-searxng:
    build:
      context: ./mcp-searxng-patches
      dockerfile: Dockerfile
    image: mcp-searxng-enhanced:latest
    container_name: mcp-searxng
    restart: unless-stopped
    ports:
      - "0.0.0.0:3001:3001"
    volumes:
      - ./mcp-searxng-patches/index.js:/app/dist/index.js:ro
      - ./mcp-searxng-patches/types.js:/app/dist/types.js:ro
      - ./mcp-searxng-patches/search.js:/app/dist/search.js:ro
      - ./mcp-searxng-patches/url-reader.js:/app/dist/url-reader.js:ro
    environment:
      - SEARXNG_URL=http://searxng:8080
      - MCP_HTTP_PORT=3001
    depends_on:
      - searxng
```

### 3. Create the custom `Dockerfile` for the MCP server

`mcp-searxng-patches/Dockerfile`:
```dockerfile
FROM isokoliuk/mcp-searxng:latest
RUN npm install sharp@0.33.5
```

This extends the base MCP server image with `sharp` so `web_url_read` can resize images before base64-encoding them.

### 4. Create the SearXNG config directories

```bash
mkdir -p ~/searxng-stack/searxng/config
mkdir -p ~/searxng-stack/searxng/data
mkdir -p ~/searxng-stack/mcp-searxng-patches
```

### 5. Get the MCP patch files

You still need the four custom JS patch files (`index.js`, `types.js`, `search.js`, `url-reader.js`) in `mcp-searxng-patches/`. The simplest way is to copy them from this repo. They're MIT-licensed and audited (no filesystem/shell access, no telemetry).

### 6. Start SearXNG once to generate the default `settings.yml`

```bash
cd ~/searxng-stack
docker compose up -d searxng
sleep 10
```

This creates `searxng/config/settings.yml` with the upstream defaults. Now jump back to **Step 2: Configure SearXNG Settings** in [Project.md](Project.md) and proceed normally from there.
