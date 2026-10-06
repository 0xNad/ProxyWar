FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY player.mjs ./
# Season 2 fairness settings: every seat plans at the same steps with the same
# request. Plan at step 1 and every PLAN_EVERY steps, at most MAX_PLANS times
# (1 + 240 / 15 = 17 for a 240-step battle); wait up to PLAN_TIMEOUT_MS for a
# plan (below the game's 60 s decision deadline).
ARG PLAN_EVERY=15
ARG MAX_PLANS=17
ARG PLAN_TIMEOUT_MS=50000
ARG PLAN_MAX_OUTPUT_TOKENS=3000
ARG PLAN_REASONING_EFFORT=low
ENV PLAN_EVERY=${PLAN_EVERY} \
    MAX_PLANS=${MAX_PLANS} \
    PLAN_TIMEOUT_MS=${PLAN_TIMEOUT_MS} \
    PLAN_MAX_OUTPUT_TOKENS=${PLAN_MAX_OUTPUT_TOKENS} \
    PLAN_REASONING_EFFORT=${PLAN_REASONING_EFFORT}
# The model is NOT baked in: each upload pins it with --llm-model, which the
# platform hands the pod as COWORLD_LLM_MODEL next to COWORLD_LLM_ENDPOINT.
CMD ["node", "/app/player.mjs"]
