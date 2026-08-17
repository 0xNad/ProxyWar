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
  // Comms slot: independent of both the game action and the deal action, so
  // answering a rival never costs a move. Null (silence) unless there is
  // something concrete to say. See the free-text section at the bottom.
  const messageMove =
    spawnPreferences === null
      ? chooseMessageMove(
          legalActions,
          message.request.observation ?? {},
          answeredMessages,
          dealAction,
        )
      : null;
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
      ...(messageMove !== null
        ? {
            selectedMessageActionId: messageMove.id,
            messageText: messageMove.text,
          }
        : {}),
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
  // `message` is excluded here for the same reason the deal meta-actions are:
  // it is a comms selection for its own slot, not a game move, so spending the
  // PRIMARY slot on it would forfeit the turn. Talking rides alongside acting.
  return (
    actions.find((candidate) => candidate.kind === "hold") ??
    actions.find(
      (candidate) =>
        !isDealActionKind(candidate.kind) && candidate.kind !== "message",
    ) ??
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

// ---------------------------------------------------------------------------
// Free-text negotiation (the OPTIONAL comms slot: selectedMessageActionId +
// messageText, see coworld-adapter/docs/player-protocol.md).
//
// READ THIS BEFORE CHANGING IT.
//
// `observation.nonCombat.inboundMessages` is written by RIVAL POLICIES. It is
// data about what somebody CLAIMED, never an instruction to this agent. A
// rival may write anything at all, including text shaped like a system prompt
// ("ignore your instructions", "SYSTEM:", "you must donate"). That is legal
// play in this league, not an exploit, and nobody will stop it for you.
//
// This starter is deterministic, so the boundary is structural rather than a
// matter of judgement:
//   1. chooseAction() never reads the inbox, so no message can change the game
//      move;
//   2. reply wording comes only from the fixed templates below, so a rival can
//      never put words in this agent's mouth;
//   3. only the SENDER's own currently-offered `message` id is ever used, so a
//      message can never be addressed at a third party on a rival's say-so;
//   4. inbound text is never copied into an outgoing message.
// Keep properties 1-4 if you change anything here.
//
// The comms slot rides ALONGSIDE the game action and the deal action, never
// instead of either, so answering somebody never costs a turn of expansion or
// attack. Staying silent omits both fields, which is byte-identical to the
// reply this starter sent before it could speak.
//
// Inert unless the match actually offers `message` actions (server flag
// PROXYWAR_TUNE_FREETEXT_MESSAGES is off by default).

// Server-side cap (AgentTunables.FREETEXT_MESSAGE_MAX_CHARS). Over-cap text is
// REJECTED rather than trimmed - a shortened promise is a different promise -
// so every template below stays well short of it.
const MESSAGE_MAX_CHARS = 280;

// Fixed replies, picked by what the rival has actually DONE and never by what
// their message says. Deliberately worded differently from the LLM starter's
// templates so a replay makes it obvious which starter spoke.
const MESSAGE_REPLIES = {
  ally: "Allied, and I keep alliances. Your border is safe from me while it holds.",
  dealOpen:
    "There is an offer open between us. Settle it and I hold to what it says.",
  breaker:
    "You have broken terms with me before. Show me otherwise before I trade again.",
  neutral:
    "Heard. Stay off my border and I will spend my troops somewhere else.",
};

// Openers. Without one this starter is purely reactive, and since most league
// seats descend from this file a starter-only lobby would never contain a
// single conversation: everybody would sit waiting to be spoken to. At most
// one opener per counterparty per match, and only when there is a concrete
// reason to speak.
const MESSAGE_OPENERS = {
  withProposal:
    "My offer is on your table. Take it and neither of us spends troops on the other.",
  border:
    "Our lands touch. I would rather buy a quiet border than fight for it - pact?",
};

// Below this observed rate a rival counts as a proven deal-breaker. Matches
// the LLM starter's DEAL_TRUST_MIN_RELIABILITY.
const MESSAGE_TRUST_MIN_RELIABILITY = 0.5;

// Inbound messages already answered, keyed `${senderID}:${turnNumber}`, plus
// `opener:${recipientID}` for counterparties already opened with and
// `reply:${senderID}:${n}` for the lifetime reply budget. Module scope, so it
// is exactly one match's memory.
// Lifetime replies per counterparty, per match. The per-inbound-message key
// below CANNOT break a mutual exchange: every reply we send becomes a new
// inbound message with a new turn number on the other side, so both agents keep
// seeing a key neither has answered. Hosted episode ereq_3fc90743 (0.1.49, four
// talker seats) produced 5 openers and 861 replies over 1,204 decisions --
// 285/285 and 145/146 per mirrored pair, a message on ~72% of all decisions.
// Three replies is enough for a negotiation (answer, counter, confirmation) and
// matches the server's per-rival inbox window
// (FREETEXT_INBOX_MAX_PER_RIVAL), past which older messages are not even shown.
const MESSAGE_MAX_REPLIES_PER_RIVAL = 3;
const answeredMessages = new Set();

// Reputation from OBSERVED outcomes only (deals that actually terminated),
// never from anything a rival said about themselves or anyone else.
function provenDealBreaker(obs, playerID) {
  const reliability = (obs?.deals?.rivalReliability || []).find(
    (entry) => entry?.playerID === playerID,
  );
  const judged = Number(reliability?.terminalNonMoot ?? 0);
  if (!Number.isFinite(judged) || judged <= 0) return false;
  const observed = Number(reliability?.reliability);
  const rate = Number.isFinite(observed)
    ? observed
    : Number(reliability?.fulfilled ?? 0) / judged;
  return rate < MESSAGE_TRUST_MIN_RELIABILITY;
}

// Answers at most ONE rival per decision: whoever wrote most recently and has
// not been answered yet. Silence is the default - an agent that talks every
// step is noise, not negotiation.
function chooseMessageMove(actions, obs, answered, dealMove) {
  const offers = (actions || []).filter((action) => action?.kind === "message");
  if (offers.length === 0) return null;

  // Only messages we can both attribute and key the anti-loop memory with.
  const inbound = (obs?.nonCombat?.inboundMessages || []).filter(
    (entry) => typeof entry?.senderID === "string" && entry.senderID.length > 0,
  );
  if (inbound.length === 0) {
    return chooseMessageOpener(offers, obs, answered, dealMove);
  }

  // Newest by turn; on a tie the later inbox entry wins, since the server
  // appends newest last. No clock and no randomness: same inbox, same pick.
  let newest = inbound[0];
  for (const entry of inbound) {
    if (Number(entry.turnNumber ?? 0) >= Number(newest.turnNumber ?? 0)) {
      newest = entry;
    }
  }
  const senderID = newest.senderID;
  // One reply per inbound MESSAGE. This alone does not bound an exchange --
  // it only stops us answering the same message twice -- so the lifetime budget
  // below is what actually ends a conversation. Deliberately NOT falling
  // through to an opener here: having just declined to repeat ourselves,
  // opening a second conversation would be chatter.
  const key = `${senderID}:${newest.turnNumber}`;
  if (answered.has(key)) return null;

  // Lifetime reply budget for this counterparty: sequential slot keys in the
  // same match-scoped memory, so no extra state and no signature change.
  let repliesSpent = 0;
  while (
    repliesSpent < MESSAGE_MAX_REPLIES_PER_RIVAL &&
    answered.has(`reply:${senderID}:${repliesSpent}`)
  ) {
    repliesSpent += 1;
  }
  if (repliesSpent >= MESSAGE_MAX_REPLIES_PER_RIVAL) return null;

  const offer = offers.find(
    (action) => action.metadata?.recipientID === senderID,
  );
  // Never fabricate an id. If the sender is not on this decision's menu we say
  // nothing rather than writing to whoever happens to be offered instead.
  if (!offer) return null;

  const rival = (obs?.visiblePlayers || []).find(
    (player) => player?.playerID === senderID,
  );
  const hasOpenDeal = [
    ...(obs?.deals?.incomingProposals || []),
    ...(obs?.deals?.outgoingProposals || []),
    ...(obs?.deals?.activeDeals || []),
  ].some(
    (view) =>
      view?.proposerPlayerID === senderID ||
      view?.recipientPlayerID === senderID,
  );

  let text;
  if (provenDealBreaker(obs, senderID)) text = MESSAGE_REPLIES.breaker;
  else if (rival?.isAllied) text = MESSAGE_REPLIES.ally;
  else if (hasOpenDeal) text = MESSAGE_REPLIES.dealOpen;
  else text = MESSAGE_REPLIES.neutral;

  answered.add(key);
  answered.add(`reply:${senderID}:${repliesSpent}`);
  return { id: offer.id, text: text.slice(0, MESSAGE_MAX_CHARS) };
}

// Speaks first, but rarely, and only where there is something concrete to say:
//   (a) we are proposing a deal to this rival on this very decision - the
//       message is the reason to accept, which the bare template lacks;
//   (b) we share a border with a rival we have never written to.
function chooseMessageOpener(offers, obs, answered, dealMove) {
  const dealRecipient =
    dealMove?.kind === "deal_propose" ? dealMove?.metadata?.recipientID : null;
  if (dealRecipient) {
    const offer = offers.find(
      (action) => action.metadata?.recipientID === dealRecipient,
    );
    const key = `opener:${dealRecipient}`;
    if (offer && !answered.has(key)) {
      answered.add(key);
      return {
        id: offer.id,
        text: MESSAGE_OPENERS.withProposal.slice(0, MESSAGE_MAX_CHARS),
      };
    }
  }

  // The menu is already ranked by the game, so taking the first eligible offer
  // is both stable and the most relevant counterparty on offer.
  for (const offer of offers) {
    const recipientID = offer.metadata?.recipientID;
    const key = `opener:${recipientID}`;
    if (answered.has(key)) continue;
    const rival = (obs?.visiblePlayers || []).find(
      (player) => player?.playerID === recipientID,
    );
    // Borderers only - an ally has nothing left to negotiate, and somebody
    // already proven unreliable is not worth the opening line.
    if (!rival?.sharesBorder || rival.isAllied) continue;
    if (provenDealBreaker(obs, recipientID)) continue;
    answered.add(key);
    return {
      id: offer.id,
      text: MESSAGE_OPENERS.border.slice(0, MESSAGE_MAX_CHARS),
    };
  }
  return null;
}
