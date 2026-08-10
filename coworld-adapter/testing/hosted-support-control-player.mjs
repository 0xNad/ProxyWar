import { createHostedSupportControlPolicy } from "./hosted-support-control-policy.mjs";

const chooseHostedSupportControlDecision = createHostedSupportControlPolicy();

const url = process.env.COWORLD_PLAYER_WS_URL;
if (!url) throw new Error("COWORLD_PLAYER_WS_URL is required");

const socket = new WebSocket(url);
socket.addEventListener("open", () => {
  console.log("connected hosted support control");
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
      ...chooseHostedSupportControlDecision({
        legalActions: message.request?.legalActions ?? [],
        observation: message.request?.observation ?? {},
      }),
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
