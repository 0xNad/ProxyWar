FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY player.mjs ./
ARG PROXYWAR_PROMPT_HARDENING=1
ARG PLAN_EVERY=6
ENV PROXYWAR_PROMPT_HARDENING=${PROXYWAR_PROMPT_HARDENING}
ENV PLAN_EVERY=${PLAN_EVERY}
# The model is NOT baked in: each upload pins it with --llm-model, which the
# platform hands the pod as COWORLD_LLM_MODEL next to COWORLD_LLM_ENDPOINT.
CMD ["node", "/app/player.mjs"]
