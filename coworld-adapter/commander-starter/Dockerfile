FROM ghcr.io/0xnad/proxywar-commander-public-base@sha256:75d5738231a79d10d224e7468b02f4531028b28486c39c13148e310be38fd360

ARG STARTER_SOURCE_SHA
RUN test -n "${STARTER_SOURCE_SHA}"
LABEL org.opencontainers.image.source="https://github.com/0xNad/proxywar-commander-starter" \
      org.opencontainers.image.revision="${STARTER_SOURCE_SHA}" \
      org.opencontainers.image.description="ProxyWar LLM Strategic Commander starter"

# The immutable base supplies the exact hosted-tested Commander modules. This
# production entrypoint deliberately removes eval-only run-key/artifact gates.
COPY commander-player.ts /app/proxywar/coworld-adapter/src/commander-player.ts
COPY commander-production-runtime.ts /app/proxywar/coworld-adapter/src/commander-production-runtime.ts
COPY open-ended-message.ts /app/proxywar/coworld-adapter/src/open-ended-message.ts
CMD ["node", "--import", "tsx", "/app/proxywar/coworld-adapter/src/commander-player.ts"]
