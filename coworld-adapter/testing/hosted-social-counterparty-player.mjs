import fs from "node:fs";
import {
  createHostedSocialCounterpartyPolicy,
  resolveHostedSocialCounterpartyConfig,
} from "./hosted-social-counterparty-policy.mjs";

const builtConfigPath = "/app/hosted-social-counterparty-build.json";
const builtConfig = fs.existsSync(builtConfigPath)
  ? JSON.parse(fs.readFileSync(builtConfigPath, "utf8"))
  : null;
const config = resolveHostedSocialCounterpartyConfig({
  builtConfig,
  argv: process.argv.slice(2),
  env: process.env,
});
const choose = createHostedSocialCounterpartyPolicy(config.profile);

const url = process.env.COWORLD_PLAYER_WS_URL;
if (!url) throw new Error("COWORLD_PLAYER_WS_URL is required");

const socket = new WebSocket(url);
socket.addEventListener("open", () => {
  console.log(`connected hosted social counterparty (${config.profile})`);
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === "final") {
    socket.close();
    return;
  }
  if (message.type !== "decision_request") return;
  socket.send(
    JSON.stringify({
      type: "decision_response",
      requestID: message.requestID,
      ...choose({
        legalActions: message.request?.legalActions ?? [],
        observation: message.request?.observation ?? {},
      }),
    }),
  );
});

const lingerMs = Number(
  process.env.PROXYWAR_PLAYER_POST_FINAL_LINGER_MS ?? "0",
);
const lingerArmed =
  process.env.KUBERNETES_SERVICE_HOST !== undefined ||
  process.env.PROXYWAR_PLAYER_FORCE_LINGER === "1";
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
socket.addEventListener("close", () => {
  if (lingerArmed && Number.isFinite(lingerMs) && lingerMs > 0) {
    setTimeout(() => process.exit(0), lingerMs);
    return;
  }
  process.exit(0);
});
socket.addEventListener("error", () => process.exit(1));
