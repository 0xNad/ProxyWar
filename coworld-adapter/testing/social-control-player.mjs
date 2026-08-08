import fs from "node:fs/promises";

import {
  chooseSocialControlDecision,
  resolveSocialControlConfig,
} from "./social-control-policy.mjs";

let builtConfig = null;
try {
  builtConfig = JSON.parse(
    await fs.readFile(
      new URL("./social-control-build.json", import.meta.url),
      "utf8",
    ),
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const { profile, arm, source } = resolveSocialControlConfig({
  builtConfig,
  argv: process.argv.slice(2),
  env: process.env,
});
const url = process.env.COWORLD_PLAYER_WS_URL;
if (!url) throw new Error("COWORLD_PLAYER_WS_URL is required");

const socket = new WebSocket(url);
socket.addEventListener("open", () => {
  console.log(
    `connected social-control profile=${profile} arm=${arm} source=${source}`,
  );
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === "final") {
    socket.close();
    return;
  }
  if (message.type !== "decision_request") return;

  const response = chooseSocialControlDecision({
    profile,
    arm,
    legalActions: message.request?.legalActions ?? [],
    observation: message.request?.observation ?? {},
  });
  socket.send(
    JSON.stringify({
      type: "decision_response",
      requestID: message.requestID,
      ...response,
    }),
  );
});

const postFinalLingerMs = Number(
  process.env.PROXYWAR_PLAYER_POST_FINAL_LINGER_MS ?? "0",
);
const lingerArmed =
  process.env.KUBERNETES_SERVICE_HOST !== undefined ||
  process.env.PROXYWAR_PLAYER_FORCE_LINGER === "1";
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
socket.addEventListener("close", () => {
  if (
    lingerArmed &&
    Number.isFinite(postFinalLingerMs) &&
    postFinalLingerMs > 0
  ) {
    setTimeout(() => process.exit(0), postFinalLingerMs);
    return;
  }
  process.exit(0);
});
socket.addEventListener("error", () => process.exit(1));
