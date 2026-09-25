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
| **No user state** — nothing tied to you | No accounts, no search history, no per-user logging. Note that SearXNG's engine error warnings include the full request URL, search terms included, and Docker keeps container logs on disk (`docker compose logs searxng`) |
| **No autocomplete keystroke streaming** | `autocomplete: ""` — your typing never reaches a third-party suggestion service |
| **Queries stay out of the page title** | `query_in_title: false` (upstream default) — your search terms don't appear in the tab title. They are still in the URL (`/search?q=...`, because `server.method` defaults to `GET`) and so in browser history; set `server: method: "POST"` in `settings.yml` to keep them out |
| **No cookies, no auth headers, no API keys** | The stack works fully without any third-party credentials |
| **`web_url_read` cannot reach your private network** | Upstream's URL guard refuses localhost, LAN, Tailscale, link-local and Docker addresses on every request and every redirect, for pages and images alike |
| **Image reads cannot exhaust memory** | 100-megapixel decode cap, at most 2 raster resizes and 2 SVG renders at a time, SVGs rendered in a child process with a 10 s and 2 GB limit, and a 4 GB cap on the MCP container |
| **MCP server runs unprivileged** | The container runs as uid 1000, not root |
| **All data is local** | Lives in folders next to `docker-compose.yml` (`searxng/config`, `searxng/data`) and in the MCP server's in-memory caches — nothing syncs to a cloud |

> The `tracker_url_remover` plugin (strips `utm_*`, `fbclid`, `gclid` from result links) is **off**: it scans a SQLite table per URL and, under concurrent engine responses, made image searches take 4-5 s and time engines out. Turn it back on under `plugins:` in `settings.yml` if you use the web UI and care more about clean links than speed.

## Residual exposure (what still leaks by default)

| Leak | Why it happens | Fix |
|---|---|---|
| **Your IP reaches upstream engines** | SearXNG queries Bing / Yahoo / Yandex / etc. from your machine's IP. They can't see *who* you are, but they see *where* the query came from | Route SearXNG through Tor or a VPN — see Tier 3 |
| **Some engines are third-party proxies** | `findborg` relays general queries to Brave's index through findborg.com, and `lingva` (used only for translation queries such as `en-de word`) relays them to Google Translate through lingva.ml, so those services see your queries too | Set `inactive: true` on `findborg` (and `lingva`) in `settings.yml` |
| **`web_url_read` reveals your IP to the target site** | Same as opening the page in a normal browser | Same proxy treatment for the MCP container — Tier 3 |
| **The MCP endpoint is reachable from your LAN** | `docker-compose.yml` binds `3001` to `0.0.0.0` by default (SearXNG's `8888` defaults to `127.0.0.1`) — anyone on your network can use it | `MCP_BIND=127.0.0.1` in `.env` — Tier 1 |
| **No authentication on the MCP endpoint** | Anything that can reach `:3001/mcp` can use it | Upstream's hardened mode with a bearer token, or a reverse proxy with auth — Tier 2 |
| **Engine statistics pages are on** | `enable_metrics: true` collects per-engine counters and shows them at `/stats` and `/stats/errors`. Not user data, but extra attack surface. (The Prometheus endpoint `/metrics` is off: `open_metrics` is empty, so it answers 404.) | Disable in `settings.yml` — Tier 2 |

---

## Hardening beyond the defaults

> **You do not need any of this to get the stack running.** The defaults work fine for a single user on their own trusted machine. This section is for going further — locking things down for a shared network, a public-facing deployment, or full anonymity.
>
> Hardening is organized into three tiers from easiest to most advanced. **Pick the tier that matches your situation and stop there** — you don't need to do all three unless you want full anonymity. Each tier builds on the previous one.

### Tier 1 — Easy wins (start here, takes ~10 minutes)

These three changes cost almost nothing and close the most common holes. If you change nothing else, do these.

1. **Set a strong secret key** (random 64-character string) as `SEARXNG_SECRET` in `.env`. Do not commit it. Generate one with whichever tool you already have installed:
   ```powershell
   # PowerShell (Windows PowerShell 5.1 and PowerShell 7 — built in, no install needed)
   $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
   ```
   ```bash
   # Node.js (if installed)
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   # Docker (works on any OS that runs this stack)
   docker run --rm alpine sh -c "apk add --no-cache openssl > /dev/null && openssl rand -hex 32"

   # Git Bash / Linux / macOS
   openssl rand -hex 32

   # Python (any platform with Python installed)
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
   Use `.env`, not `settings.yml`: `docker-compose.yml` always passes `SEARXNG_SECRET` into the container, and SearXNG lets it override the file **even when it is empty**, so a key written into `settings.yml` is never used.

2. **Service binding.** SearXNG binds to `127.0.0.1` by default (only software on your own machine can reach it). The MCP server binds to `0.0.0.0` by default so remote MCP clients can connect. Both are set from `.env`, so `git pull` never conflicts with your choice:
   ```
   SEARXNG_BIND=127.0.0.1   # 0.0.0.0 exposes the SearXNG UI to your LAN
   MCP_BIND=127.0.0.1       # restrict the MCP endpoint to this machine
   ```
   ⚠️ **The MCP server has no authentication by default** — anyone on your network who can reach `:3001/mcp` can use it. If it binds to `0.0.0.0`, also do **Tier 2** (authentication + host firewall rules) before leaving it running.

3. **Only if others can reach SearXNG: the limiter, which needs extra setup.** `server: limiter: true` on its own does nothing here: the limiter needs a Valkey database, and this stack has none (SearXNG logs "The limiter requires Valkey" and runs unprotected). To use it, add a Valkey service to `docker-compose.yml`, set `valkey: url: valkey://valkey:6379/0` in `settings.yml`, and add the Docker network to `pass_ip` in `searxng/config/limiter.toml` (for example `pass_ip = ['172.16.0.0/12']`). Without the pass list, the limiter allows only 4 JSON requests per IP per hour, and every MCP search comes from the Docker network.

---

### Tier 2 — Network hardening

Do these if others share your network or you expose anything beyond localhost.

4. **Add authentication on the MCP endpoint.** By default anyone who can reach `:3001/mcp` can use it. Two ways to close that:

   **Upstream's hardened mode** (no extra software). Add to the `mcp-searxng` `environment:` in `docker-compose.yml`:
   ```yaml
      - MCP_HTTP_HARDEN=true
      - MCP_HTTP_AUTH_TOKEN=${MCP_AUTH_TOKEN}          # put a long random value in .env
      - MCP_HTTP_ALLOWED_HOSTS=localhost:3001,100.x.y.z:3001,mybox.tailnet.ts.net:3001
   ```
   and set `MCP_ALLOWED_ORIGINS` in `.env` (hardened mode refuses to start without it). Clients must then send `Authorization: Bearer <token>`. `MCP_HTTP_AUTH_TOKEN` on its own does nothing — the token is only checked when `MCP_HTTP_HARDEN=true`. Hardened mode also turns on DNS-rebinding protection, so every `host:port` clients use to reach the server (LAN IP, Tailscale IP or name) must be in `MCP_HTTP_ALLOWED_HOSTS`, or they get refused.

   **Or a reverse proxy** in front of port 3001 with HTTP basic auth, an API token, or mTLS:
   - [Caddy](https://caddyserver.com/) — single binary, basic auth in ~3 lines of Caddyfile
   - [nginx](https://nginx.org/) — most common, plenty of tutorials
   - [Traefik](https://traefik.io/) — Docker-native, integrates with `docker-compose.yml`

5. **Disable the metrics endpoint.** In `settings.yml`:
   ```yaml
   general:
     enable_metrics: false
   ```
   Stops collecting engine statistics: `/stats` still loads but shows nothing, its footer link is hidden, and `/stats/errors` returns empty data, so you lose the engine diagnosis described under [Search engines](#search-engines).

6. **Block the ports at your host firewall.** Defense-in-depth — even with localhost binding from Tier 1, also block ports 8888 and 3001 at the OS firewall (Windows Defender Firewall, macOS Firewall). On Linux, `ufw` rules do **not** apply to ports published by Docker (Docker's iptables rules run first); put the rules in the `DOCKER-USER` iptables chain instead.

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

8. **Route `web_url_read` through Tor too.** Set `URL_READER_HTTPS_PROXY` and `URL_READER_HTTP_PROXY` on the `mcp-searxng` service in `docker-compose.yml` to an **HTTP** proxy that forwards to Tor or your VPN, for example `http://tor:8118` (the Privoxy port of `dperson/torproxy`). The MCP server accepts only `http://` and `https://` proxy URLs; `socks5h://tor:9050` makes every `web_url_read` fail with "Unsupported proxy protocol". Otherwise *reading* a URL still leaks your IP to that site, even if *searching* doesn't. Prefer these over the generic `HTTPS_PROXY`/`HTTP_PROXY`, which also apply to the server's own requests to `http://searxng:8080` unless you add `NO_PROXY=searxng`. With a proxy set, the proxy resolves host names, so the private-address guard refuses only literal private IPs and `localhost` names.

9. **Keep DNS away from your ISP.** With `socks5h://` (step 7), SearXNG already resolves engine host names through Tor, and the HTTP proxy from step 8 resolves the names `web_url_read` fetches. Anything else the containers look up still goes to your normal resolver, and plain DNS to `1.1.1.1` or `9.9.9.9` can still be read by your ISP. Use DNS-over-TLS/HTTPS (for example a local Unbound resolver that forwards over TLS) and point Docker at it.

> **The tiers are cumulative — gaps reopen if you skip lower ones.** Tier 3 alone (Tor without the localhost binding from Tier 1) still exposes your instance to anyone on your LAN. Tier 1 alone leaves your IP visible to upstream search engines. For genuine end-to-end privacy, you need all three tiers.

---

## Modifying the default settings

`searxng/config/settings.yml` does **not** contain SearXNG's whole configuration. It starts with `use_default_settings: true`, so SearXNG first loads the default `settings.yml` that ships inside the image and then merges ours on top: top-level sections key by key, and each engine entry into the default engine with the same `name`. Only the things this stack changes are in the file, and each one has a comment saying why.

Two consequences:
- To see a default, or the full list of engines and their options, read the image's file: `docker exec searxng cat /usr/local/searxng/searx/settings.yml`. The effective engine list (enabled state, categories, shortcuts, timeouts) and plugin states are at `http://localhost:8888/config`; other merged values (such as `suspended_times`, `request_timeout` or `outgoing`) are not shown there.
- The **`plugins:` section replaces** the image's list instead of merging, so it names every plugin. After a SearXNG upgrade, compare it with the image's list.

Below is what the shipped file sets and how to change each piece.

### JSON output (required by the MCP server)

```yaml
search:
  formats:
    - html
    - json
```
Don't remove `json` — the MCP server reads results as JSON and gets HTTP 403 without it.

### Rate limiter

Off for local use:
```yaml
server:
  limiter: false
```
Setting it to `true` alone does nothing: the limiter needs a Valkey service and `valkey.url`, and with Valkey on it allows only 4 JSON requests per IP per hour unless the Docker network is in `pass_ip` in `limiter.toml` (see Tier 1 of the [hardening section](#tier-1--easy-wins-start-here-takes-10-minutes)). `searxng/config/limiter.toml` only contains comments; it exists so SearXNG does not log a warning about a missing file.

### Engine suspension times

When an engine fails, SearXNG sidelines it for a while. The shipped values are deliberately long:
```yaml
search:
  suspended_times:
    SearxEngineAccessDenied: 900     # seconds; "Access denied", HTTP 402/403
    SearxEngineCaptcha: 1800         # CAPTCHA
    SearxEngineTooManyRequests: 900  # HTTP 429
```
Short holds (30-60 s) meant blocked engines were retried on almost every query, so each search waited the full timeout on engines that were certain to fail, and the repeated hits kept the instance flagged. Some engines (DuckDuckGo's html endpoint, Qwant) raise their CAPTCHA with a hard-coded zero suspension that overrides these values, which is one reason they are disabled.

### Request timeout

```yaml
outgoing:
  request_timeout: 5.0
```
Keep every per-engine `timeout:` at or below this value. A search waits for the **largest** timeout among the engines it selects, so one engine with `timeout: 10` makes every query in its category wait up to 10 s when that engine is slow. (That is why `crossref` (upstream 30 s) and `gentoo` (upstream 10 s) are overridden to 5.0; `mwmbl` has no upstream timeout and is pinned to 5.0 so it is not raised by accident. Two upstream exceptions remain: `lingva` 6.0, which only fires on `xx-yy word` translation queries, and `wttr.in` 9.0 in the weather category.)

### HTTP/2

```yaml
outgoing:
  enable_http2: true
```
Since 2026.9.23 SearXNG sends requests through curl_cffi with a Chrome TLS fingerprint. Setting this to `false` forces HTTP/1.1 for every engine, which is a fingerprint no real Chrome sends, and Wikimedia answers it with HTTP 429. (On older images, which used httpx, it had to be `false` for Yahoo and DuckDuckGo.)

### Search engines

The shipped overrides enable engines that answer self-hosted instances and disable ones that fail from typical residential, VPN or CGNAT addresses. Tested on 2026-09-24:

**General web, enabled**: Bing, Yahoo, DuckDuckGo web (`duckduckgo web`, not the html `duckduckgo` engine), Google CSE (keyless; from a busy or flagged IP it answers "unusual traffic from your network" and is suspended for 900 s), Yandex, Keenable, Swisscows, mwmbl, findborg (a third-party keyless proxy of Brave's index), and Wikipedia (infoboxes for exact article titles).

**Disabled because the engine blocks self-hosted IPs** (they fail on the first query from a cold container): Brave (HTTP 429), DuckDuckGo html, Google web, Qwant web and GMX (CAPTCHA), Yep (HTTP 403). Startpage is also off (`inactive: true`): its Anubis proof-of-work difficulty rises for this IP after one query.

**Disabled because broken or unhelpful**: Seznam (times out), Mojeek (works, but lowers relevance; still usable as `!mjk`), Wiby, Crowdview, WolframAlpha (no-API endpoint times out), and in other categories arch linux wiki, bandcamp, kickass, solidtorrents, wikinews, sepiasearch, DuckDuckGo images/news/videos and Qwant images, plus Wikidata, Europe PMC and Google videos (untested or off-topic) and radio browser (not loaded: its server list is empty inside Docker).

**Other categories**: images (Bing, Google CSE, Openverse, Flickr, DeviantArt, Pinterest, Wikimedia Commons, Pexels, Unsplash), videos (Bing, YouTube, Qwant, Dailymotion, Vimeo, Wikimedia Commons), news (Bing, Google, Yahoo, Qwant, Reuters), science (Google Scholar, Semantic Scholar, OpenAIRE, arXiv, PubMed, Crossref, PDBe).

Your exit IP decides a lot of this. To try a disabled engine, override it by name:
```yaml
engines:
  - name: brave
    disabled: false
```
then `docker compose restart searxng`, run a few searches, and check `curl -s http://localhost:8888/stats/errors`. An engine that fails on the first query from a freshly started container is blocking your IP; turning more of those on does not help. To try one without changing the file, use its bang in the web UI or `engines=<name>` on the API. An engine set to `inactive: true` (Startpage, radio browser, ahmia, torch) is not loaded at all: set `inactive: false` as well, since its bang and `engines=<name>` do nothing until then.

---

## Building from scratch (without cloning)

Cloning is the supported path: the stack is the combination of `docker-compose.yml`, `searxng/config/settings.yml` and `limiter.toml`, and the files in `mcp-searxng-patches/`, and they are written for each other (pinned image tags, mounted file names, environment variables). If you would rather assemble it by hand, copy these files from the repository into the same layout:

```
your-dir/
  docker-compose.yml
  .env                              # SEARXNG_SECRET=..., optional SEARXNG_BIND / MCP_BIND / MCP_ALLOWED_ORIGINS
  searxng/config/settings.yml
  searxng/config/limiter.toml
  searxng/data/                     # empty; SearXNG's cache
  mcp-searxng-patches/Dockerfile
  mcp-searxng-patches/index.js
  mcp-searxng-patches/version.js
  mcp-searxng-patches/enhanced-search.js
  mcp-searxng-patches/image-reader.js
```

Then follow [README.md](README.md) from **Step 3: Build and Start Everything**.

The patch files are MIT-licensed and add no telemetry. Their only process/file access: `image-reader.js` starts its SVG renderer through `/bin/sh` and writes that child's `/proc/<pid>/oom_score_adj`. Do not mount any other files over the MCP image's `dist/` folder: the upstream files that are not listed above (URL security, HTTP security, PDF reading) must run unmodified.
