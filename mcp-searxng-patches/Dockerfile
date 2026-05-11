FROM isokoliuk/mcp-searxng:latest

# The upstream image uninstalls npm to keep itself slim, so we have to
# put it back temporarily, install sharp into /app/node_modules, and
# then remove npm again to keep the resulting image lean.
USER root
RUN apk add --no-cache npm \
    && cd /app && npm install --omit=dev sharp@0.33.5 @tavily/core \
    && apk del npm \
    && rm -rf /root/.npm /tmp/*
