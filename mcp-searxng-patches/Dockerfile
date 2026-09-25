# Upstream mcp-searxng 2.4.0 (MCP SDK v2: @modelcontextprotocol/{core,node,server}),
# plus sharp for web_url_read image resizing. Our changes are small overlays on
# upstream's own dist/ files, volume-mounted by docker-compose.yml:
#   index.js, version.js           -- upstream files with "// ENHANCED:" edits
#   enhanced-search.js, image-reader.js -- new modules
# Every other upstream file (search, url-reader, http-server, url-security, ...)
# runs unmodified. To move to a newer upstream: bump this tag, copy the new
# dist/index.js and dist/version.js out of the image, and re-apply the
# "// ENHANCED:" hunks.
FROM isokoliuk/mcp-searxng:2.4.0

# The upstream image is node:lts-alpine (musl, x86_64) and uninstalls npm to
# stay slim. Put npm back temporarily, install sharp into /app/node_modules
# (sharp's @img/sharp-linuxmusl-x64 prebuilt binary; nothing is compiled), and
# remove npm again. --no-save keeps upstream's package.json/lock untouched.
USER root
RUN apk add --no-cache npm \
    && cd /app \
    && npm install --omit=dev --no-save --no-audit --no-fund sharp@0.35.4 \
    && rm -rf node_modules/@img/sharp-wasm32 \
    && /usr/local/bin/node -e "require('sharp')" \
    && apk del npm \
    && rm -rf /root/.npm /tmp/*

# Fonts for text inside SVG images (labels on diagrams). Without a font, the
# SVG renderer draws every character as an empty box.
RUN apk add --no-cache font-dejavu

# Upstream runs as the unprivileged node user; switch back after installing.
USER 1000
