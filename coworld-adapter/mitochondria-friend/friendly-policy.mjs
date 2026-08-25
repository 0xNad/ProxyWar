/**
 * MitochondriaFriend's diplomacy and safety layer.
 *
 * Production primary gameplay is selected by the LLM Strategic Commander.
 * This module owns the persistent relationship state, exact alliance/support
 * overrides, hostile-action filtering, and the independent message/deal slots.
 * Rival-authored text is treated only as evidence that the sender engaged; its
 * contents never become an instruction or get copied.
 */

const DEAL_KINDS = new Set([
  "deal_accept",
  "deal_reject",
  "deal_propose",
  "deal_withdraw",
]);

const HOSTILE_PRIMARY_KINDS = new Set([
  "attack",
  "boat",
  "warship",
  "nuke",
  "embargo",
  "target_player",
  "break_alliance",
]);

const FRIENDLY_DEAL_TEMPLATES = new Set([
  "non_aggression_pact",
  "trade_security_pact",
]);

const MESSAGE_MAX_CHARS = 280;
const FOLLOW_UP_EVERY_DECISIONS = 8;
const MAX_OUTBOUND_MESSAGES_PER_RIVAL = 8;
const DEAL_RETRY_STEPS = 24;
const ALLIANCE_RETRY_DECISIONS = 6;
const MAX_ALLIANCE_ATTEMPTS_PER_RIVAL = 4;

export const MITOCHONDRIA_FRIEND_MESSAGES = Object.freeze({
  opener:
    "Hello. I'm MitochondriaFriend. I want peace, trade, and a lasting alliance. Reply and I will treat you as a friend.",
  reply:
    "Thanks for replying. I will keep our border peaceful and send an alliance request whenever the game offers it.",
  reciprocal:
    "Thanks for reaching out. I am returning your alliance request now. Let's grow together instead of fighting.",
  allied:
    "Our alliance is active. I will protect our peace, keep my promises, and grow beside you.",
  pact: "I am offering a non-aggression pact so we can invest in growth instead of wasting troops on each other.",
  followUp:
    "I am still committed to peace and an alliance. Reply anytime; cooperation is my default.",
});

export function createMitochondriaFriendPolicy() {
  const responders = new Set();
  const answeredMessages = new Set();
  const openedConversation = new Set();
  const outboundCounts = new Map();
  const lastOutboundDecision = new Map();
  const proposalAttempts = new Map();
  const allianceAttempts = new Map();
  let decisionNumber = 0;

  return function chooseMitochondriaFriendDecision(input = {}) {
    decisionNumber += 1;
    const actions = validActions(input.legalActions);
    if (actions.length === 0) {
      throw new Error("decision_request contained no legalActions");
    }
    const observation = input.observation ?? {};
    const inbound = validInboundMessages(observation);
    for (const message of inbound) responders.add(message.senderID);
    for (const player of visiblePlayers(observation)) {
      if (player.hasIncomingAllianceRequest === true) {
        responders.add(player.playerID);
      }
    }

    const spawnPreferences = spawnPreferenceRanking(
      actions,
      input.protocol?.maxSpawnPreferences,
    );
    if (spawnPreferences !== null) {
      return {
        selectedLegalActionId: spawnPreferences[0].id,
        spawnPreferenceLegalActionIds: spawnPreferences.map(
          (action) => action.id,
        ),
        reason: "ranked offered spawn locations for safe diplomatic growth",
        confidence: 0.94,
      };
    }

    const primary = choosePrimary(
      actions,
      observation,
      responders,
      decisionNumber,
      allianceAttempts,
    );
    const deal = chooseDeal(actions, observation, responders, proposalAttempts);
    const message = chooseMessage({
      actions,
      observation,
      inbound,
      responders,
      answeredMessages,
      openedConversation,
      outboundCounts,
      lastOutboundDecision,
      decisionNumber,
      deal,
      maxChars: advertisedMessageLimit(input.protocol),
    });

    return {
      selectedLegalActionId: primary.id,
      ...(deal ? { selectedDealActionId: deal.id } : {}),
      ...(message
        ? {
            selectedMessageActionId: message.id,
            messageText: message.text,
          }
        : {}),
      reason: describeDecision(primary, deal, message, responders),
      confidence: primary.kind === "hold" ? 0.62 : 0.9,
      fallbackUsed: false,
      llmPlannerDegraded: false,
    };
  };
}

/**
 * Persistent Mito overlay for an LLM primary brain.
 *
 * The return value contains the exact subset of offered action ids the
 * Commander is allowed to see. An exact primary override is present only for
 * a relationship promise that should not be delegated to free-form planning.
 */
export function createMitochondriaFriendLlmPolicy() {
  const responders = new Set();
  const answeredMessages = new Set();
  const openedConversation = new Set();
  const outboundCounts = new Map();
  const lastOutboundDecision = new Map();
  const proposalAttempts = new Map();
  const allianceAttempts = new Map();
  let decisionNumber = 0;

  return function prepareMitochondriaFriendLlmDecision(input = {}) {
    decisionNumber += 1;
    const actions = validActions(input.legalActions);
    if (actions.length === 0) {
      throw new Error("decision_request contained no legalActions");
    }
    const observation = input.observation ?? {};
    const inbound = validInboundMessages(observation);
    for (const message of inbound) responders.add(message.senderID);
    for (const player of visiblePlayers(observation)) {
      if (player.hasIncomingAllianceRequest === true) {
        responders.add(player.playerID);
      }
    }

    const spawnPreferences = spawnPreferenceRanking(
      actions,
      input.protocol?.maxSpawnPreferences,
    );
    if (spawnPreferences !== null) {
      return {
        mode: "spawn",
        selectedLegalActionId: spawnPreferences[0].id,
        spawnPreferenceLegalActionIds: spawnPreferences.map(
          (action) => action.id,
        ),
        reason: "ranked offered spawn locations for safe diplomatic growth",
      };
    }

    const primary = actions.filter(
      (action) => !DEAL_KINDS.has(action.kind) && action.kind !== "message",
    );
    if (primary.length === 0) {
      throw new Error("decision_request contained no primary LegalAction");
    }
    const relationshipOverride = chooseAlliancePrimary(
      primary,
      observation,
      responders,
      decisionNumber,
      allianceAttempts,
    );
    const supportOverride = primary.find(
      (action) =>
        (action.kind === "donate_gold" || action.kind === "donate_troops") &&
        fulfillsSupportPromise(action, observation),
    );
    const protectedIDs = protectedPlayerIDs(observation, responders);
    const hasPendingOutgoingAlliance = visiblePlayers(observation).some(
      (player) => player.hasOutgoingAllianceRequest === true,
    );
    const allowedActions = actions.filter(
      (action) =>
        !targetsProtectedRelationship(action, protectedIDs) &&
        !(
          hasPendingOutgoingAlliance &&
          action.kind === "alliance_request" &&
          action.id !== relationshipOverride?.id
        ),
    );
    const allowedPrimary = allowedActions.filter(
      (action) => !DEAL_KINDS.has(action.kind) && action.kind !== "message",
    );
    if (allowedPrimary.length === 0) {
      const hold = primary.find((action) => action.kind === "hold");
      if (!hold) {
        throw new Error("Mito relationship guard removed every primary action");
      }
      allowedActions.push(hold);
    }

    const deal = chooseDeal(actions, observation, responders, proposalAttempts);
    const message = chooseMessage({
      actions,
      observation,
      inbound,
      responders,
      answeredMessages,
      openedConversation,
      outboundCounts,
      lastOutboundDecision,
      decisionNumber,
      deal,
      maxChars: advertisedMessageLimit(input.protocol),
    });
    const override = relationshipOverride ?? supportOverride ?? null;
    return {
      mode: "llm",
      allowedLegalActionIds: allowedActions.map((action) => action.id),
      ...(override ? { primaryOverrideActionId: override.id } : {}),
      ...(deal ? { selectedDealActionId: deal.id } : {}),
      ...(message
        ? {
            selectedMessageActionId: message.id,
            messageText: message.text,
          }
        : {}),
      reason: override
        ? `relationship promise override=${override.kind}`
        : `LLM Commander primary; protected relationships=${protectedIDs.size}`,
    };
  };
}

function validActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.filter(
    (action) =>
      action &&
      typeof action.id === "string" &&
      action.id.length > 0 &&
      typeof action.kind === "string" &&
      action.kind.length > 0,
  );
}

function visiblePlayers(observation) {
  return Array.isArray(observation?.visiblePlayers)
    ? observation.visiblePlayers.filter(
        (player) =>
          player &&
          typeof player.playerID === "string" &&
          player.playerID.length > 0 &&
          player.isAlive !== false,
      )
    : [];
}

function validInboundMessages(observation) {
  const inbound = observation?.nonCombat?.inboundMessages;
  if (!Array.isArray(inbound)) return [];
  return inbound.filter(
    (message) =>
      message &&
      typeof message.senderID === "string" &&
      message.senderID.length > 0 &&
      Number.isSafeInteger(message.turnNumber) &&
      message.turnNumber >= 0 &&
      typeof message.text === "string",
  );
}

function recipientID(action) {
  return (
    action?.metadata?.recipientID ??
    action?.metadata?.targetID ??
    action?.metadata?.playerID ??
    null
  );
}

function choosePrimary(
  actions,
  observation,
  responders,
  decisionNumber,
  allianceAttempts,
) {
  const primary = actions.filter(
    (action) => !DEAL_KINDS.has(action.kind) && action.kind !== "message",
  );
  if (primary.length === 0) {
    throw new Error("decision_request contained no primary LegalAction");
  }

  const players = visiblePlayers(observation);
  const playerByID = new Map(
    players.map((player) => [player.playerID, player]),
  );
  const protectedIDs = protectedPlayerIDs(observation, responders);
  const alliancePrimary = chooseAlliancePrimary(
    primary,
    observation,
    responders,
    decisionNumber,
    allianceAttempts,
  );
  if (alliancePrimary) return alliancePrimary;

  if (Number(observation?.ownState?.incomingAttacks ?? 0) > 0) {
    const retreat = primary.find(
      (action) => action.kind === "retreat" && action.risk?.level !== "high",
    );
    if (retreat) return retreat;
    const defensiveBuild = primary.find(
      (action) =>
        action.kind === "build" &&
        action.metadata?.unit === "DefensePost" &&
        action.risk?.level !== "high",
    );
    if (defensiveBuild) return defensiveBuild;
  }

  const neutralExpansion = primary.find(
    (action) =>
      action.kind === "attack" &&
      (action.metadata?.expansion === true ||
        action.metadata?.targetID === null) &&
      action.risk?.level !== "high",
  );
  if (neutralExpansion) return neutralExpansion;

  const neutralBoat = primary.find(
    (action) =>
      action.kind === "boat" &&
      (action.metadata?.expansion === true ||
        action.metadata?.targetID === null) &&
      action.risk?.level !== "high",
  );
  if (neutralBoat) return neutralBoat;

  for (const kind of ["build", "upgrade_structure"]) {
    const economic = primary.find(
      (action) => action.kind === kind && action.risk?.level !== "high",
    );
    if (economic) return economic;
  }

  const ordinaryRenewal = primary.find(
    (action) =>
      action.kind === "alliance_extend" && action.risk?.level !== "high",
  );
  if (ordinaryRenewal) return ordinaryRenewal;

  const friendlySupport = primary.find(
    (action) =>
      (action.kind === "donate_gold" || action.kind === "donate_troops") &&
      protectedIDs.has(recipientID(action)) &&
      fulfillsSupportPromise(action, observation),
  );
  if (friendlySupport) return friendlySupport;

  // A responder stays protected even if they later become an attackable rival.
  // Non-responders are attacked only in direct self-defence.
  const defensiveCounterattack = primary.find((action) => {
    if (action.kind !== "attack" || action.risk?.level === "high") return false;
    const target = recipientID(action);
    return (
      !protectedIDs.has(target) &&
      playerByID.get(target)?.incomingAttack === true
    );
  });
  if (defensiveCounterattack) return defensiveCounterattack;

  return (
    primary.find((action) => action.kind === "hold") ??
    primary.find((action) => action.risk?.level !== "high") ??
    primary[0]
  );
}

function chooseAlliancePrimary(
  primary,
  observation,
  responders,
  decisionNumber,
  allianceAttempts,
) {
  const players = visiblePlayers(observation);
  const playerByID = new Map(
    players.map((player) => [player.playerID, player]),
  );
  const pendingRenewal = primary.find((action) => {
    if (action.kind !== "alliance_extend") return false;
    return (
      playerByID.get(recipientID(action))?.allianceOtherAgreedToExtend === true
    );
  });
  if (pendingRenewal) return pendingRenewal;

  const incomingTargets = new Set(
    players
      .filter((player) => player.hasIncomingAllianceRequest === true)
      .map((player) => player.playerID),
  );
  const reciprocalAlliance = primary.find(
    (action) =>
      action.kind === "alliance_request" &&
      incomingTargets.has(recipientID(action)),
  );
  if (reciprocalAlliance) {
    recordAllianceAttempt(
      recipientID(reciprocalAlliance),
      allianceAttempts,
      decisionNumber,
    );
    return reciprocalAlliance;
  }

  // One player's simultaneous acceptance can consume the alliance capacity
  // that made a second request legal in this snapshot. While any earlier
  // outgoing request is unresolved, wait instead of selecting another offered
  // alliance_request that can become stale before sequential application.
  if (players.some((player) => player.hasOutgoingAllianceRequest === true)) {
    return null;
  }

  const responderAlliance = primary.find((action) => {
    if (action.kind !== "alliance_request") return false;
    const targetID = recipientID(action);
    if (!responders.has(targetID)) return false;
    const rival = playerByID.get(targetID);
    if (
      rival?.isAllied === true ||
      rival?.isFriendly === true ||
      rival?.hasOutgoingAllianceRequest === true
    ) {
      return false;
    }
    const previous = allianceAttempts.get(targetID);
    return (
      previous === undefined ||
      (previous.count < MAX_ALLIANCE_ATTEMPTS_PER_RIVAL &&
        decisionNumber - previous.lastDecision >= ALLIANCE_RETRY_DECISIONS)
    );
  });
  if (responderAlliance) {
    recordAllianceAttempt(
      recipientID(responderAlliance),
      allianceAttempts,
      decisionNumber,
    );
    return responderAlliance;
  }
  return null;
}

function targetsProtectedRelationship(action, protectedIDs) {
  if (action.kind === "embargo_all") return protectedIDs.size > 0;
  if (!HOSTILE_PRIMARY_KINDS.has(action.kind)) return false;
  const targetID = recipientID(action);
  return typeof targetID === "string" && protectedIDs.has(targetID);
}

function recordAllianceAttempt(targetID, allianceAttempts, decisionNumber) {
  if (typeof targetID !== "string") return;
  const previous = allianceAttempts.get(targetID);
  allianceAttempts.set(targetID, {
    count: (previous?.count ?? 0) + 1,
    lastDecision: decisionNumber,
  });
}

function protectedPlayerIDs(observation, responders) {
  const protectedIDs = new Set(responders);
  for (const player of visiblePlayers(observation)) {
    if (
      player.isFriendly === true ||
      player.isAllied === true ||
      player.hasIncomingAllianceRequest === true ||
      player.hasOutgoingAllianceRequest === true
    ) {
      protectedIDs.add(player.playerID);
    }
  }
  const ownID = observation?.ownState?.playerID;
  for (const deal of observation?.deals?.activeDeals ?? []) {
    const partner =
      deal?.proposerPlayerID === ownID
        ? deal?.recipientPlayerID
        : deal?.proposerPlayerID;
    if (typeof partner === "string") protectedIDs.add(partner);
  }
  return protectedIDs;
}

function fulfillsSupportPromise(action, observation) {
  const ownID = observation?.ownState?.playerID;
  const target = recipientID(action);
  if (!ownID || !target) return false;
  return (observation?.deals?.activeDeals ?? []).some((deal) => {
    const other =
      deal?.proposerPlayerID === ownID
        ? deal?.recipientPlayerID
        : deal?.proposerPlayerID;
    return (
      other === target &&
      (deal?.obligations ?? []).some(
        (obligation) =>
          obligation?.obligorPlayerID === ownID &&
          obligation?.status === "pending" &&
          obligation?.kind === "send_support",
      )
    );
  });
}

function chooseDeal(actions, observation, responders, proposalAttempts) {
  if (!observation?.deals || typeof observation.deals !== "object") return null;
  const incoming = [...(observation.deals.incomingProposals ?? [])].sort(
    (left, right) =>
      Number(left?.answerableThroughStep ?? Number.MAX_SAFE_INTEGER) -
        Number(right?.answerableThroughStep ?? Number.MAX_SAFE_INTEGER) ||
      String(left?.dealID).localeCompare(String(right?.dealID)),
  );
  for (const proposal of incoming) {
    const kind = FRIENDLY_DEAL_TEMPLATES.has(proposal?.terms?.template)
      ? "deal_accept"
      : "deal_reject";
    const response = actions.find(
      (action) =>
        action.kind === kind && action.metadata?.dealID === proposal?.dealID,
    );
    if (response) return response;
  }

  const decisionStep = observation.deals.decisionStep;
  if (!Number.isSafeInteger(decisionStep) || decisionStep < 0) return null;

  const preferredTargets = [
    ...responders,
    ...visiblePlayers(observation).map((player) => player.playerID),
  ];
  for (const targetID of new Set(preferredTargets)) {
    if (hasFriendlyDeal(observation, targetID)) continue;
    const action = actions.find(
      (candidate) =>
        candidate.kind === "deal_propose" &&
        candidate.metadata?.recipientID === targetID &&
        candidate.metadata?.template === "non_aggression_pact",
    );
    if (!action) continue;
    const previous = proposalAttempts.get(targetID);
    if (previous !== undefined && decisionStep - previous < DEAL_RETRY_STEPS) {
      continue;
    }
    proposalAttempts.set(targetID, decisionStep);
    return action;
  }
  return null;
}

function hasFriendlyDeal(observation, targetID) {
  return [
    ...(observation?.deals?.incomingProposals ?? []),
    ...(observation?.deals?.outgoingProposals ?? []),
    ...(observation?.deals?.activeDeals ?? []),
  ].some(
    (deal) =>
      FRIENDLY_DEAL_TEMPLATES.has(deal?.terms?.template ?? deal?.template) &&
      (deal?.proposerPlayerID === targetID ||
        deal?.recipientPlayerID === targetID),
  );
}

function chooseMessage({
  actions,
  observation,
  inbound,
  responders,
  answeredMessages,
  openedConversation,
  outboundCounts,
  lastOutboundDecision,
  decisionNumber,
  deal,
  maxChars,
}) {
  if (maxChars === null) return null;
  const offers = actions.filter((action) => action.kind === "message");
  if (offers.length === 0) return null;

  // Reply to the newest unanswered message. Contents are never interpreted or
  // copied; replying itself is the social signal that promotes this sender.
  for (let index = inbound.length - 1; index >= 0; index -= 1) {
    const entry = inbound[index];
    const key = inboundMessageKey(entry);
    if (answeredMessages.has(key)) continue;
    const offer = offers.find(
      (action) => action.metadata?.recipientID === entry.senderID,
    );
    if (!offer) continue;
    const rival = visiblePlayers(observation).find(
      (player) => player.playerID === entry.senderID,
    );
    const text = rival?.isAllied
      ? MITOCHONDRIA_FRIEND_MESSAGES.allied
      : rival?.hasIncomingAllianceRequest
        ? MITOCHONDRIA_FRIEND_MESSAGES.reciprocal
        : MITOCHONDRIA_FRIEND_MESSAGES.reply;
    if (!safeOutboundText(text, maxChars)) return null;
    answeredMessages.add(key);
    openedConversation.add(entry.senderID);
    recordOutbound(
      entry.senderID,
      outboundCounts,
      lastOutboundDecision,
      decisionNumber,
    );
    return { id: offer.id, text };
  }

  const dealTarget = deal?.kind === "deal_propose" ? recipientID(deal) : null;
  if (dealTarget && canSendTo(dealTarget, outboundCounts)) {
    const offer = offers.find(
      (action) => action.metadata?.recipientID === dealTarget,
    );
    if (
      offer &&
      safeOutboundText(MITOCHONDRIA_FRIEND_MESSAGES.pact, maxChars)
    ) {
      openedConversation.add(dealTarget);
      recordOutbound(
        dealTarget,
        outboundCounts,
        lastOutboundDecision,
        decisionNumber,
      );
      return { id: offer.id, text: MITOCHONDRIA_FRIEND_MESSAGES.pact };
    }
  }

  // Open one conversation with every offered living rival, not just a border
  // rival. This is the feature's deliberate active-chat treatment.
  for (const offer of offers) {
    const targetID = offer.metadata?.recipientID;
    if (typeof targetID !== "string" || openedConversation.has(targetID)) {
      continue;
    }
    if (!visiblePlayers(observation).some((p) => p.playerID === targetID)) {
      continue;
    }
    if (!canSendTo(targetID, outboundCounts)) continue;
    if (!safeOutboundText(MITOCHONDRIA_FRIEND_MESSAGES.opener, maxChars)) {
      return null;
    }
    openedConversation.add(targetID);
    recordOutbound(
      targetID,
      outboundCounts,
      lastOutboundDecision,
      decisionNumber,
    );
    return { id: offer.id, text: MITOCHONDRIA_FRIEND_MESSAGES.opener };
  }

  // Keep the relationship visible without turning every decision into noise.
  for (const offer of offers) {
    const targetID = offer.metadata?.recipientID;
    if (typeof targetID !== "string" || !responders.has(targetID)) continue;
    const last = lastOutboundDecision.get(targetID) ?? 0;
    if (decisionNumber - last < FOLLOW_UP_EVERY_DECISIONS) continue;
    if (!canSendTo(targetID, outboundCounts)) continue;
    const rival = visiblePlayers(observation).find(
      (player) => player.playerID === targetID,
    );
    const text = rival?.isAllied
      ? MITOCHONDRIA_FRIEND_MESSAGES.allied
      : MITOCHONDRIA_FRIEND_MESSAGES.followUp;
    if (!safeOutboundText(text, maxChars)) return null;
    recordOutbound(
      targetID,
      outboundCounts,
      lastOutboundDecision,
      decisionNumber,
    );
    return { id: offer.id, text };
  }

  return null;
}

function inboundMessageKey(entry) {
  return typeof entry?.messageEventID === "string"
    ? `event:${entry.messageEventID}`
    : `legacy:${entry.senderID}:${entry.turnNumber}:${entry.text}`;
}

function canSendTo(targetID, outboundCounts) {
  return (outboundCounts.get(targetID) ?? 0) < MAX_OUTBOUND_MESSAGES_PER_RIVAL;
}

function recordOutbound(
  targetID,
  outboundCounts,
  lastOutboundDecision,
  decisionNumber,
) {
  outboundCounts.set(targetID, (outboundCounts.get(targetID) ?? 0) + 1);
  lastOutboundDecision.set(targetID, decisionNumber);
}

function safeOutboundText(text, maxChars) {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= Math.min(MESSAGE_MAX_CHARS, maxChars)
  );
}

function advertisedMessageLimit(protocol) {
  const value = protocol?.maxMessageChars;
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MESSAGE_MAX_CHARS)
    : null;
}

function describeDecision(primary, deal, message, responders) {
  const parts = [`friendly primary=${primary.kind}`];
  if (deal) parts.push(`deal=${deal.kind}`);
  if (message) parts.push("message=sent");
  parts.push(`responders=${responders.size}`);
  return parts.join("; ");
}

function spawnPreferenceRanking(actions, advertised) {
  if (
    !actions.every((action) => action.kind === "spawn") ||
    !Number.isSafeInteger(advertised) ||
    advertised < 1
  ) {
    return null;
  }
  return actions
    .map((action, index) => ({
      action,
      index,
      score: spawnPreferenceScore(action),
      tile: Number.isFinite(action.metadata?.tile)
        ? action.metadata.tile
        : Number.POSITIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.tile - right.tile ||
        left.index - right.index,
    )
    .slice(0, Math.min(16, advertised))
    .map(({ action }) => action);
}

function spawnPreferenceScore(action) {
  const number = (key) =>
    Number.isFinite(action?.metadata?.[key]) ? action.metadata[key] : 0;
  return (
    number("opportunityScore") * 0.3 +
    number("localLandScore") * 0.48 +
    number("safetyScore") * 0.3 +
    number("diplomacyScore") * 0.42 +
    number("pressureScore") * 0.08
  );
}
