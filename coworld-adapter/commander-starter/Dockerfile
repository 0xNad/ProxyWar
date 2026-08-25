FROM public.ecr.aws/q5f4m8t9/cogames@sha256:6cb946c338fa3d58685f280a4e6853e2194b2a6a0cbb60001a99342094d9a244

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
