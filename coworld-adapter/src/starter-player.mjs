import { createRequire } from "node:module";

import { redactCoworldPlayerUrl } from "./coworld-url.mjs";

const proxyWarRepo = process.env.PROXYWAR_REPO ?? "/app/proxywar";
const require = createRequire(import.meta.url);
const { WebSocket } = require(`${proxyWarRepo}/node_modules/ws`);

const url = process.env.COWORLD_PLAYER_WS_URL;
if (!url) {
  throw new Error("COWORLD_PLAYER_WS_URL is required");
}

const socket = new WebSocket(url);

socket.on("open", () => {
  console.log(`connected ${redactCoworldPlayerUrl(url)}`);
});

socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.type === "final") {
    console.log("episode final; exiting");
    socket.close();
    return;
  }
  if (message.type !== "decision_request") {
    return;
  }

  const action = chooseAction(message.request.legalActions ?? []);
  socket.send(
    JSON.stringify({
      type: "decision_response",
      requestID: message.requestID,
      selectedLegalActionId: action.id,
      reason: `Starter selected ${action.kind}: ${action.label}`,
      confidence: action.kind === "hold" ? 0.45 : 0.72,
    }),
  );
});

socket.on("close", () => {
  process.exit(0);
});

socket.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

function chooseAction(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("decision_request contained no legalActions");
  }

  const preferredKinds = [
    "spawn",
    "attack",
    "build",
    "upgrade",
    "move_warship",
    "boat",
    "alliance_request",
    "quick_chat",
    "emoji",
  ];
  for (const kind of preferredKinds) {
    const action = actions.find(
      (candidate) =>
        candidate.kind === kind &&
        candidate.risk?.level !== "high" &&
        !String(candidate.id).includes("avoid"),
    );
    if (action) {
      return action;
    }
  }
  return actions.find((candidate) => candidate.kind === "hold") ?? actions[0];
}
