FROM node:24-bookworm-slim
WORKDIR /app
COPY tester-spatial-probe/package.json ./
RUN npm install --omit=dev
COPY tester-starter-llm/owner-capabilities.mjs ./owner-capabilities.mjs
COPY tester-spatial-probe/spatial-probe-player.mjs ./spatial-probe-player.mjs
COPY tester-spatial-probe/spatial-probe-player.test.mjs ./spatial-probe-player.test.mjs
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision=${SOURCE_SHA}
CMD ["node", "/app/spatial-probe-player.mjs", "--mode=both"]
