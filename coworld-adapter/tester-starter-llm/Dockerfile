FROM node:24-bookworm-slim@sha256:ccd0612136f105d59d7266585b0bff88016e3da94c8ebfc8ad1154b529f59e7b
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY llm-player.mjs open-ended-message.mjs starter-player.mjs owner-capabilities.mjs ./
ARG PROXYWAR_PROMPT_HARDENING=1
ARG PROXYWAR_PROMPT_CACHE=0
ARG PLAN_EVERY=6
ENV PROXYWAR_PROMPT_HARDENING=${PROXYWAR_PROMPT_HARDENING}
ENV PROXYWAR_PROMPT_CACHE=${PROXYWAR_PROMPT_CACHE}
ENV PLAN_EVERY=${PLAN_EVERY}
# Default is the LLM agent. launch.sh (or your upload --run) can point at
# /app/starter-player.mjs instead for the no-LLM rule agent.
CMD ["node", "/app/llm-player.mjs"]
