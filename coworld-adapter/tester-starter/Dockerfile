# Builds your ProxyWar agent into an image the platform can run.
# Must be linux/amd64 (the platform runs amd64) — launch.sh sets that for you.
FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY starter-player.mjs ./

# The platform overrides this when it runs your policy; it's just a sane default.
CMD ["node", "/app/starter-player.mjs"]
