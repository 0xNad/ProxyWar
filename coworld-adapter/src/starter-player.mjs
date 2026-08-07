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

// Post-final linger (hosted only, via pod env): the platform's terminal
// reconciliation fails whole episodes with "pod ... not found" when player
// job pods self-exit on `final` and get cleaned up before the reconciler
// looks (league rounds 1127/1128/1130, 2026-08-02; round-1038 precedent
// where a player log reached final yet the platform reported the pod
// absent). Holding the finished process briefly keeps the pod discoverable.
// SIGTERM always wins immediately, so platform teardown is never delayed.
// Armed only inside a Kubernetes pod (KUBERNETES_SERVICE_HOST is injected
// into every pod) or under PROXYWAR_PLAYER_FORCE_LINGER=1: `coworld certify`
// runs the same player in plain local Docker and waits for the container to
// exit, so an unconditional linger times out local certification.
const postFinalLingerMs = Number(
  process.env.PROXYWAR_PLAYER_POST_FINAL_LINGER_MS ?? "0",
);
const lingerArmed =
  process.env.KUBERNETES_SERVICE_HOST !== undefined ||
  process.env.PROXYWAR_PLAYER_FORCE_LINGER === "1";
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
function exitAfterClose(code) {
  if (
    lingerArmed &&
    Number.isFinite(postFinalLingerMs) &&
    postFinalLingerMs > 0
  ) {
    console.log(
      `lingering ${postFinalLingerMs}ms after close for platform reconciliation`,
    );
    setTimeout(() => process.exit(code), postFinalLingerMs);
    return;
  }
  process.exit(code);
}

socket.on("close", () => {
  exitAfterClose(0);
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
    "upgrade_structure",
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
