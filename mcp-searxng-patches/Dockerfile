# Pinned deliberately. Upstream `latest` moved to mcp-searxng 2.x, which is
# built on the split @modelcontextprotocol/{core,node,server} v2 packages and
# ships a restructured dist/. The patch files in this directory are written
# against the 1.x API (@modelcontextprotocol/sdk), so mounting them over a 2.x
# image makes the server fail to start with ERR_MODULE_NOT_FOUND.
# Re-pin only together with a port of the patches to the 2.x SDK.
FROM isokoliuk/mcp-searxng:1.16.0

# The upstream image uninstalls npm to keep itself slim, so we have to
# put it back temporarily, install sharp into /app/node_modules, and
# then remove npm again to keep the resulting image lean.
USER root
RUN apk add --no-cache npm \
    && cd /app && npm install --omit=dev sharp@0.33.5 \
    && apk del npm \
    && rm -rf /root/.npm /tmp/*
