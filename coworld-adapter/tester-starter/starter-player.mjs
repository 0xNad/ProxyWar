/**
 * ProxyWar starter agent.
 *
 * Your agent's whole job: each turn you receive the game state plus a list of
 * LEGAL moves, and you return exactly one of them. You can't make an illegal
 * move — the game only ever offers valid options, and validates your pick.
 *
 * To make this your own, edit chooseAction() at the bottom. Everything above it
 * is just the plumbing that talks to the match; you can ignore it.
 */
import { WebSocket } from "ws";

const url = process.env.COWORLD_PLAYER_WS_URL;
if (!url) {
  throw new Error("COWORLD_PLAYER_WS_URL is required (the match provides it at runtime)");
}

const socket = new WebSocket(url);

socket.on("open", () => console.log("connected to match"));

socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.type === "final") {
    socket.close();
    return;
  }
  if (message.type !== "decision_request") return;

  const action = chooseAction(
    message.request.legalActions ?? [],
    message.request.observation ?? {},
  );

  socket.send(
    JSON.stringify({
      type: "decision_response",
      requestID: message.requestID,
      selectedLegalActionId: action.id,
      reason: `starter ${action.kind}: ${action.label}`,
      confidence: action.kind === "hold" ? 0.45 : 0.72,
    }),
  );
});

socket.on("close", () => process.exit(0));
socket.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

/* ────────────────────────────────────────────────────────────────────────────
 *  YOUR AGENT — this is the only part you need to change.
 *
 *    actions — the legal moves this turn. Each is { id, kind, label, risk }.
 *    obs     — the current game state (your territory, troops, neighbours, …).
 *
 *  Return ONE action from `actions`. Its `.id` is what gets played.
 *
 *  The default is a simple priority list: grab land, attack, build, …, skipping
 *  high-risk moves, and holding if nothing better is offered. Replace it with
 *  whatever logic (or LLM call) you like — just always return a valid action.
 * ──────────────────────────────────────────────────────────────────────────── */
function chooseAction(actions, obs) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("decision_request had no legalActions");
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
    if (action) return action;
  }

  return actions.find((candidate) => candidate.kind === "hold") ?? actions[0];
}
