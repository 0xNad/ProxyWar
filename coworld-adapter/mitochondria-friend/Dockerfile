FROM node:24-bookworm-slim

WORKDIR /app
COPY coworld-adapter/mitochondria-friend/package.json ./
RUN npm install --omit=dev
COPY coworld-adapter/mitochondria-friend/friendly-policy.mjs ./
COPY coworld-adapter/mitochondria-friend/friendly-player.mjs ./
COPY coworld-adapter/tester-starter-llm/owner-capabilities.mjs ./

CMD ["node", "/app/friendly-player.mjs"]
