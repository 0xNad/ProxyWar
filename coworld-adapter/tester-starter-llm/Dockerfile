FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY llm-player.mjs starter-player.mjs ./
ARG PROXYWAR_PROMPT_HARDENING=0
ARG PROXYWAR_PROMPT_CACHE=0
ARG PLAN_EVERY=3
ENV PROXYWAR_PROMPT_HARDENING=${PROXYWAR_PROMPT_HARDENING}
ENV PROXYWAR_PROMPT_CACHE=${PROXYWAR_PROMPT_CACHE}
ENV PLAN_EVERY=${PLAN_EVERY}
# Default is the LLM agent. launch.sh (or your upload --run) can point at
# /app/starter-player.mjs instead for the no-LLM rule agent.
CMD ["node", "/app/llm-player.mjs"]
