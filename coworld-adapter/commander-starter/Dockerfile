FROM public.ecr.aws/q5f4m8t9/cogames@sha256:6cb946c338fa3d58685f280a4e6853e2194b2a6a0cbb60001a99342094d9a244

ARG STARTER_SOURCE_SHA
LABEL org.opencontainers.image.source="https://github.com/0xNad/proxywar-commander-starter" \
      org.opencontainers.image.revision="${STARTER_SOURCE_SHA}" \
      org.opencontainers.image.description="ProxyWar LLM Strategic Commander starter"

# The base is the immutable image used by the hosted Commander canary. The
# only runtime treatment selected here is Arm C: compact LLM option selection
# plus the exact offered-action binding executor.
CMD ["node", "--import", "tsx", "/app/proxywar/coworld-adapter/src/commander-xp-player.ts", "--arm=C"]
