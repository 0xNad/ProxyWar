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

  const legalActions = message.request.legalActions ?? [];
  const spawnPreferences = spawnPreferenceRanking(message, legalActions);
  const action = spawnPreferences?.[0] ?? chooseAction(legalActions);
  const dealAction =
    spawnPreferences === null ? chooseDealAction(legalActions) : null;
  socket.send(
    JSON.stringify({
      type: "decision_response",
      requestID: message.requestID,
      selectedLegalActionId: action.id,
      ...(spawnPreferences !== null
        ? {
            spawnPreferenceLegalActionIds: spawnPreferences.map(
              (preference) => preference.id,
            ),
          }
        : {}),
      ...(dealAction !== null ? { selectedDealActionId: dealAction.id } : {}),
      reason:
        spawnPreferences !== null
          ? `Starter ranked ${spawnPreferences.length} offered spawn actions from metadata.`
          : `Starter selected ${action.kind}: ${action.label}`,
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
  return (
    actions.find((candidate) => candidate.kind === "hold") ??
    actions.find((candidate) => !isDealActionKind(candidate.kind)) ??
    actions[0]
  );
}

function spawnPreferenceRanking(message, actions) {
  const advertised = message?.protocol?.maxSpawnPreferences;
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    !actions.every((action) => action?.kind === "spawn") ||
    typeof advertised !== "number" ||
    !Number.isFinite(advertised) ||
    advertised < 1
  ) {
    return null;
  }
  const limit = Math.min(16, Math.floor(advertised));
  return actions
    .map((action, index) => ({
      action,
      index,
      score: spawnPreferenceScore(action),
      tile:
        typeof action?.metadata?.tile === "number" &&
        Number.isFinite(action.metadata.tile)
          ? action.metadata.tile
          : Number.POSITIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.tile - right.tile ||
        String(left.action.id).localeCompare(String(right.action.id)) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ action }) => action);
}

function spawnPreferenceScore(action) {
  const score = (key) => {
    const value = action?.metadata?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const opportunity = score("opportunityScore");
  const pressure = score("pressureScore");
  const safety = score("safetyScore");
  const diplomacy = score("diplomacyScore");
  const localLand = score("localLandScore");
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safety - 0.32) / 0.24);
  const lowSafetyPenalty =
    safety < 0.18
      ? (0.18 - safety) * 2.4 + 0.16
      : safety < 0.23
        ? (0.23 - safety) * 1.1
        : 0;
  return (
    opportunity * 0.32 +
    pressure * 0.18 +
    middleSafetyBand * 0.03 +
    localLand * 0.5 +
    safety * 0.25 +
    diplomacy * 0.28 -
    lowSafetyPenalty
  );
}

// Structured-deal meta-actions (deal_propose/deal_accept/deal_reject/
// deal_withdraw) are never a valid PRIMARY move — chooseAction() above never
// returns one. This selects the OPTIONAL second action for the diplomacy
// slot (`selectedDealActionId`, see coworld-adapter/docs/player-protocol.md):
// inert unless the match actually offers deal_* actions (server flag
// PROXYWAR_TUNE_STRUCTURED_DEALS is off by default), so a starter that never
// customizes this still behaves exactly as before. Deterministic, bounded
// priority: answer an open offer before making one, and prefer a definite
// answer over silence — accept, then reject, then propose one of our own.
//
// deal_withdraw is deliberately NOT selectable below. There is no staleness
// signal in `actions`, so a trailing withdraw fires on fresh offers: an offer
// stays answerable for 4 decision steps, but a proposer may only open one
// every 3, and while a pair already holds an open deal the manager offers no
// deal_propose for it — so the step right after proposing often has nothing
// left to match except withdraw. Measured across 96 hosted league matches:
// 2,870 of 5,256 proposals (54.6%) were withdrawn, 96.4% at exactly +1 step,
// cutting the recipient's four chances to answer down to one. Withdrawing is
// de-escalation and needs a reason, not an idle slot; `selectedDealActionId`
// is optional, so selecting nothing is correct.
const DEAL_ACTION_KINDS = [
  "deal_accept",
  "deal_reject",
  "deal_propose",
  "deal_withdraw",
];

// Kinds this policy will actually pick, in priority order. Keep
// DEAL_ACTION_KINDS complete above — isDealActionKind() uses it to keep every
// deal meta-action out of the PRIMARY action slot.
const DEAL_SELECTION_KINDS = DEAL_ACTION_KINDS.filter(
  (kind) => kind !== "deal_withdraw",
);

function isDealActionKind(kind) {
  return DEAL_ACTION_KINDS.includes(kind);
}

function chooseDealAction(actions) {
  for (const kind of DEAL_SELECTION_KINDS) {
    const action = actions.find((candidate) => candidate.kind === kind);
    if (action) {
      return action;
    }
  }
  return null;
}
