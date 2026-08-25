FROM public.ecr.aws/q5f4m8t9/cogames@sha256:6cb946c338fa3d58685f280a4e6853e2194b2a6a0cbb60001a99342094d9a244

ARG MITO_SOURCE_SHA
RUN printf '%s\n' "${MITO_SOURCE_SHA}" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'
LABEL org.opencontainers.image.source="https://github.com/0xNad/ProxyWar" \
      org.opencontainers.image.revision="${MITO_SOURCE_SHA}" \
      org.opencontainers.image.description="ProxyWar LLM-powered MitochondriaFriend"

COPY coworld-adapter/commander-starter/commander-production-runtime.ts /app/proxywar/coworld-adapter/commander-starter/commander-production-runtime.ts
COPY coworld-adapter/commander-starter/open-ended-message.ts /app/proxywar/coworld-adapter/commander-starter/open-ended-message.ts
COPY coworld-adapter/mitochondria-friend/friendly-policy.mjs /app/proxywar/coworld-adapter/mitochondria-friend/friendly-policy.mjs
COPY coworld-adapter/mitochondria-friend/friendly-policy.d.mts /app/proxywar/coworld-adapter/mitochondria-friend/friendly-policy.d.mts
COPY coworld-adapter/mitochondria-friend/friendly-player-llm.ts /app/proxywar/coworld-adapter/mitochondria-friend/friendly-player-llm.ts
COPY coworld-adapter/tester-starter-llm/owner-capabilities.mjs /app/proxywar/coworld-adapter/tester-starter-llm/owner-capabilities.mjs
COPY coworld-adapter/tester-starter-llm/owner-capabilities.d.mts /app/proxywar/coworld-adapter/tester-starter-llm/owner-capabilities.d.mts

CMD ["node", "--import", "tsx", "/app/proxywar/coworld-adapter/mitochondria-friend/friendly-player-llm.ts"]
