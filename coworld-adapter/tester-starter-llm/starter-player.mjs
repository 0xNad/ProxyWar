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
  throw new Error(
    "COWORLD_PLAYER_WS_URL is required (the match provides it at runtime)",
  );
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

  const legalActions = message.request.legalActions ?? [];
  const action = chooseAction(legalActions, message.request.observation ?? {});
  const dealAction = chooseDealAction(legalActions);

  socket.send(
    JSON.stringify({
      type: "decision_response",
      requestID: message.requestID,
      selectedLegalActionId: action.id,
      ...(dealAction !== null ? { selectedDealActionId: dealAction.id } : {}),
      reason: `starter ${action.kind}: ${action.label}`,
      confidence: action.kind === "hold" ? 0.45 : 0.72,
    }),
  );
});

// Post-final linger (hosted only, via pod env) — see llm-player.mjs; keeps
// finished pods discoverable through platform terminal reconciliation.
const postFinalLingerMs = Number(
  process.env.PROXYWAR_PLAYER_POST_FINAL_LINGER_MS ?? "0",
);
// Armed only inside a Kubernetes pod (KUBERNETES_SERVICE_HOST is injected
// into every pod) or under PROXYWAR_PLAYER_FORCE_LINGER=1: local Docker runs
// (coworld certify) wait for the container to exit, so an unconditional
// linger times out certification.
const lingerArmed =
  process.env.KUBERNETES_SERVICE_HOST !== undefined ||
  process.env.PROXYWAR_PLAYER_FORCE_LINGER === "1";
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
socket.on("close", () => {
  if (
    lingerArmed &&
    Number.isFinite(postFinalLingerMs) &&
    postFinalLingerMs > 0
  ) {
    console.log(
      `lingering ${postFinalLingerMs}ms after close for platform reconciliation`,
    );
    setTimeout(() => process.exit(0), postFinalLingerMs);
    return;
  }
  process.exit(0);
});
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
 *  Return ONE PRIMARY game action from `actions`. Its `.id` is what gets
 *  played. `chooseDealAction()` below independently supplies the OPTIONAL
 *  separate diplomacy action, if any — this function never returns one.
 *
 *  The default is a simple priority list: grab land, attack, build, …, skipping
 *  high-risk moves, and holding if nothing better is offered. Replace it with
 *  whatever logic (or LLM call) you like — just always return a valid action.
 * ──────────────────────────────────────────────────────────────────────────── */
function chooseAction(actions, obs) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("decision_request had no legalActions");
  }

  const promiseConstraints = activePromiseConstraints(obs);
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
        !String(candidate.id).includes("avoid") &&
        !wouldBreakPromise(candidate, promiseConstraints),
    );
    if (action) return action;
  }

  return (
    actions.find(
      (candidate) =>
        candidate.kind === "hold" &&
        !wouldBreakPromise(candidate, promiseConstraints),
    ) ??
    actions.find(
      (candidate) =>
        !isDealActionKind(candidate.kind) &&
        !wouldBreakPromise(candidate, promiseConstraints),
    ) ??
    actions.find((candidate) => !isDealActionKind(candidate.kind)) ??
    actions[0]
  );
}

// The no-LLM starter keeps accepted non-aggression/trade-security promises by
// default. Deals never make a hostile action illegal; this is policy posture,
// not a second validator. Builders who want deliberate defection can replace
// this filter with explicit strategy and keep the resulting verdict visible.
function activePromiseConstraints(obs) {
  const ownID = obs?.ownState?.playerID;
  const noAttack = new Set();
  const noEmbargo = new Set();
  if (!ownID) return { noAttack, noEmbargo };

  for (const deal of obs?.deals?.activeDeals || []) {
    if (
      deal.template !== "non_aggression_pact" &&
      deal.template !== "trade_security_pact"
    )
      continue;
    const mine = (deal.obligations || []).find(
      (obligation) =>
        obligation.obligorPlayerID === ownID && obligation.status === "pending",
    );
    if (!mine) continue;
    const partnerID =
      deal.proposerPlayerID === ownID
        ? deal.recipientPlayerID
        : deal.proposerPlayerID;
    noAttack.add(partnerID);
    if (deal.template === "trade_security_pact") noEmbargo.add(partnerID);
  }
  return { noAttack, noEmbargo };
}

function wouldBreakPromise(action, constraints) {
  const targetID = action.metadata?.targetID;
  if (
    (action.kind === "attack" ||
      action.kind === "nuke" ||
      (action.kind === "boat" && targetID)) &&
    constraints.noAttack.has(targetID)
  )
    return true;
  if (
    action.kind === "embargo" &&
    action.metadata?.action === "start" &&
    constraints.noEmbargo.has(targetID)
  )
    return true;
  return action.kind === "embargo_all" && constraints.noEmbargo.size > 0;
}

// Structured-deal meta-actions (deal_propose/deal_accept/deal_reject/
// deal_withdraw) are never a valid PRIMARY move — chooseAction() above never
// returns one. This selects the OPTIONAL second action for the diplomacy
// slot (`selectedDealActionId`, see coworld-adapter/docs/player-protocol.md):
// active only when the current request offers deal_* actions. A starter that
// omits this field remains compatible but ignores the opportunity.
// Deterministic, bounded posture: accept only promises this minimal policy can
// keep automatically (non-aggression / trade security), reject unsupported
// commitments, propose only a non-aggression pact, and withdraw last.
const DEAL_ACTION_KINDS = [
  "deal_accept",
  "deal_reject",
  "deal_propose",
  "deal_withdraw",
];

function isDealActionKind(kind) {
  return DEAL_ACTION_KINDS.includes(kind);
}

function chooseDealAction(actions) {
  const supported = (action) =>
    action.metadata?.template === "non_aggression_pact" ||
    action.metadata?.template === "trade_security_pact";
  return (
    actions.find(
      (candidate) => candidate.kind === "deal_accept" && supported(candidate),
    ) ??
    actions.find(
      (candidate) => candidate.kind === "deal_reject" && !supported(candidate),
    ) ??
    actions.find(
      (candidate) =>
        candidate.kind === "deal_propose" &&
        candidate.metadata?.template === "non_aggression_pact",
    ) ??
    actions.find((candidate) => candidate.kind === "deal_withdraw") ??
    null
  );
}
