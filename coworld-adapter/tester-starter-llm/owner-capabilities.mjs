import { createHash } from "node:crypto";

/**
 * Additive capability helpers for the public ProxyWar starter.
 *
 * Every helper is fail-closed and returns fields/actions already present in the
 * current Coworld request. Nothing here creates an OpenFront intent, repairs an
 * action id, or rewrites authored message text.
 */

export const OWNER_MESSAGE_MAX_CHARS = 280;
export const OWNER_SPATIAL_SERIALIZED_MAX_BYTES = 16 * 1024;
export const OWNER_MINIMAP_SERIALIZED_MAX_BYTES = 4 * 1024;
const OWNER_MINIMAP_LARGE_TILE_THRESHOLD = 256 * 1024;
export const OWNER_EVIDENCE_MAX_EVENTS_PER_KIND = 64;
export const SPATIAL_VISIBILITY_MODEL = "global-lockstep-public-map-v1";

const DEAL_KINDS = new Set([
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
]);

const INVISIBLE_FORMAT_OR_SEPARATOR =
  /[\u2028\u2029\uFFF9-\uFFFB]|\p{Default_Ignorable_Code_Point}/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
const MINIMAP_ROW = /^[A-Za-z0-9.@#~]{24}$/u;
const MINIMAP_V2_OWNERSHIP_ROW = /^[A-Za-z0-9.@#~]+$/u;
const MINIMAP_V2_TERRAIN_ROW = /^[.:^~]+$/u;
const MINIMAP_GLYPH = /^[A-Za-z0-9@#]$/u;
const DEAL_TEMPLATES = new Set([
  "non_aggression_pact",
  "trade_security_pact",
  "joint_attack",
  "support_request",
]);
const DEAL_OBLIGATION_KINDS = new Set([
  "non_aggression",
  "trade_security",
  "confirmed_attack_on_target",
  "send_support",
]);
const DEAL_OBLIGATION_STATUSES = new Set([
  "pending",
  "fulfilled",
  "violated",
  "expired_unfulfilled",
  "unverified",
  "moot",
]);
const DEAL_OBLIGATION_SHAPE = new Map([
  ["non_aggression_pact", { kind: "non_aggression", count: 2 }],
  ["trade_security_pact", { kind: "trade_security", count: 2 }],
  ["joint_attack", { kind: "confirmed_attack_on_target", count: 1 }],
  ["support_request", { kind: "send_support", count: 1 }],
]);
const MAX_DEAL_OBSERVATION_ROWS = 64;
const DEAL_PROPOSAL_TTL_STEPS = 4;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedRecordArray(value, maxLength) {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((entry) => isRecord(entry))
  );
}

function hasExactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isStrictOpaqueID(value) {
  return (
    isBoundedVisibleString(value, 200) &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

function isStrictPlayerID(value) {
  return isStrictOpaqueID(value) && !value.includes(":");
}

function isBoundedName(value) {
  return isBoundedVisibleString(value, 120);
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveIntegerString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    /^(?:0|[1-9][0-9]*)$/u.test(value) &&
    BigInt(value) > 0n
  );
}

function boundedDealTerms(terms) {
  if (
    !hasExactKeys(
      terms,
      ["template", "durationSteps"],
      ["targetPlayerID", "targetName", "goldAmount", "troopAmount"],
    ) ||
    !DEAL_TEMPLATES.has(terms.template) ||
    !Number.isSafeInteger(terms.durationSteps) ||
    terms.durationSteps < 3 ||
    terms.durationSteps > 20
  ) {
    return null;
  }

  const targetPresent =
    Object.hasOwn(terms, "targetPlayerID") ||
    Object.hasOwn(terms, "targetName");
  const supportPresent =
    Object.hasOwn(terms, "goldAmount") || Object.hasOwn(terms, "troopAmount");
  const bounded = {
    template: terms.template,
    durationSteps: terms.durationSteps,
  };
  if (terms.template === "joint_attack") {
    if (
      supportPresent ||
      !isStrictPlayerID(terms.targetPlayerID) ||
      !isBoundedName(terms.targetName)
    ) {
      return null;
    }
    return {
      ...bounded,
      targetPlayerID: terms.targetPlayerID,
      targetName: terms.targetName,
    };
  }
  if (terms.template === "support_request") {
    if (
      targetPresent ||
      !isPositiveIntegerString(terms.goldAmount) ||
      !Number.isSafeInteger(terms.troopAmount) ||
      terms.troopAmount <= 0
    ) {
      return null;
    }
    return {
      ...bounded,
      goldAmount: terms.goldAmount,
      troopAmount: terms.troopAmount,
    };
  }
  return targetPresent || supportPresent ? null : bounded;
}

function boundedDealProposal(proposal, ownPlayerID, decisionStep, direction) {
  if (
    !hasExactKeys(proposal, [
      "dealID",
      "proposerPlayerID",
      "proposerName",
      "recipientPlayerID",
      "recipientName",
      "terms",
      "proposedAtStep",
      "answerableThroughStep",
    ]) ||
    !isStrictPlayerID(proposal.proposerPlayerID) ||
    !isBoundedName(proposal.proposerName) ||
    !isStrictPlayerID(proposal.recipientPlayerID) ||
    !isBoundedName(proposal.recipientName) ||
    proposal.proposerPlayerID === proposal.recipientPlayerID ||
    !isNonnegativeSafeInteger(proposal.proposedAtStep) ||
    !isNonnegativeSafeInteger(proposal.answerableThroughStep) ||
    proposal.answerableThroughStep !==
      proposal.proposedAtStep + DEAL_PROPOSAL_TTL_STEPS ||
    proposal.proposedAtStep >= decisionStep ||
    decisionStep > proposal.answerableThroughStep ||
    (direction === "incoming" && proposal.recipientPlayerID !== ownPlayerID) ||
    (direction === "outgoing" && proposal.proposerPlayerID !== ownPlayerID)
  ) {
    return null;
  }
  const terms = boundedDealTerms(proposal.terms);
  return terms === null ||
    !isStrictOpaqueID(proposal.dealID) ||
    (terms.template === "joint_attack" &&
      (terms.targetPlayerID === proposal.proposerPlayerID ||
        terms.targetPlayerID === proposal.recipientPlayerID))
    ? null
    : {
        dealID: proposal.dealID,
        proposerPlayerID: proposal.proposerPlayerID,
        proposerName: proposal.proposerName,
        recipientPlayerID: proposal.recipientPlayerID,
        recipientName: proposal.recipientName,
        terms,
        proposedAtStep: proposal.proposedAtStep,
        answerableThroughStep: proposal.answerableThroughStep,
      };
}

function boundedDealObligation(obligation) {
  if (
    !hasExactKeys(
      obligation,
      ["obligorPlayerID", "obligorName", "kind", "status"],
      [
        "targetPlayerID",
        "targetName",
        "goldAmount",
        "troopAmount",
        "donatedGold",
        "donatedTroops",
      ],
    ) ||
    !isStrictPlayerID(obligation.obligorPlayerID) ||
    !isBoundedName(obligation.obligorName) ||
    !DEAL_OBLIGATION_KINDS.has(obligation.kind) ||
    !DEAL_OBLIGATION_STATUSES.has(obligation.status)
  ) {
    return null;
  }
  const targetPresent =
    Object.hasOwn(obligation, "targetPlayerID") ||
    Object.hasOwn(obligation, "targetName");
  const supportPresent = [
    "goldAmount",
    "troopAmount",
    "donatedGold",
    "donatedTroops",
  ].some((key) => Object.hasOwn(obligation, key));
  const bounded = {
    obligorPlayerID: obligation.obligorPlayerID,
    obligorName: obligation.obligorName,
    kind: obligation.kind,
    status: obligation.status,
  };
  if (obligation.kind === "confirmed_attack_on_target") {
    if (
      supportPresent ||
      !isStrictPlayerID(obligation.targetPlayerID) ||
      !isBoundedName(obligation.targetName)
    ) {
      return null;
    }
    return {
      ...bounded,
      targetPlayerID: obligation.targetPlayerID,
      targetName: obligation.targetName,
    };
  }
  if (obligation.kind === "send_support") {
    if (
      targetPresent ||
      !isPositiveIntegerString(obligation.goldAmount) ||
      !Number.isSafeInteger(obligation.troopAmount) ||
      obligation.troopAmount <= 0 ||
      typeof obligation.donatedGold !== "string" ||
      obligation.donatedGold.length === 0 ||
      obligation.donatedGold.length > 40 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(obligation.donatedGold) ||
      !Number.isSafeInteger(obligation.donatedTroops) ||
      obligation.donatedTroops < 0
    ) {
      return null;
    }
    return {
      ...bounded,
      goldAmount: obligation.goldAmount,
      troopAmount: obligation.troopAmount,
      donatedGold: obligation.donatedGold,
      donatedTroops: obligation.donatedTroops,
    };
  }
  return targetPresent || supportPresent ? null : bounded;
}

function boundedActiveDeal(deal, ownPlayerID, decisionStep) {
  if (
    !hasExactKeys(deal, [
      "dealID",
      "template",
      "proposerPlayerID",
      "proposerName",
      "recipientPlayerID",
      "recipientName",
      "activeFromStep",
      "expiresAfterStep",
      "stepsRemaining",
      "obligations",
    ]) ||
    !DEAL_TEMPLATES.has(deal.template) ||
    !isStrictPlayerID(deal.proposerPlayerID) ||
    !isBoundedName(deal.proposerName) ||
    !isStrictPlayerID(deal.recipientPlayerID) ||
    !isBoundedName(deal.recipientName) ||
    deal.proposerPlayerID === deal.recipientPlayerID ||
    !isNonnegativeSafeInteger(deal.activeFromStep) ||
    !isNonnegativeSafeInteger(deal.expiresAfterStep) ||
    deal.expiresAfterStep < deal.activeFromStep ||
    deal.expiresAfterStep - deal.activeFromStep + 1 < 3 ||
    deal.expiresAfterStep - deal.activeFromStep + 1 > 20 ||
    decisionStep < deal.activeFromStep ||
    decisionStep > deal.expiresAfterStep ||
    !isNonnegativeSafeInteger(deal.stepsRemaining) ||
    deal.stepsRemaining !== deal.expiresAfterStep - decisionStep + 1 ||
    (deal.proposerPlayerID !== ownPlayerID &&
      deal.recipientPlayerID !== ownPlayerID) ||
    !isBoundedRecordArray(deal.obligations, MAX_DEAL_OBSERVATION_ROWS)
  ) {
    return null;
  }
  const expected = DEAL_OBLIGATION_SHAPE.get(deal.template);
  if (!isStrictOpaqueID(deal.dealID)) return null;
  if (deal.obligations.length !== expected.count) return null;
  const obligations = deal.obligations.map(boundedDealObligation);
  if (
    obligations.some((obligation) => obligation === null) ||
    obligations.some((obligation) => obligation.kind !== expected.kind)
  ) {
    return null;
  }
  if (
    (expected.kind === "non_aggression" ||
      expected.kind === "trade_security") &&
    obligations.some(
      (obligation) =>
        obligation.status !== "pending" && obligation.status !== "violated",
    )
  ) {
    return null;
  }
  if (!obligations.some((obligation) => obligation.status === "pending")) {
    return null;
  }
  const seenObligors = new Set();
  for (const obligation of obligations) {
    if (seenObligors.has(obligation.obligorPlayerID)) return null;
    seenObligors.add(obligation.obligorPlayerID);
  }
  const partyNames = new Map([
    [deal.proposerPlayerID, deal.proposerName],
    [deal.recipientPlayerID, deal.recipientName],
  ]);
  if (
    obligations.some(
      (obligation) =>
        partyNames.get(obligation.obligorPlayerID) !== obligation.obligorName,
    )
  ) {
    return null;
  }
  if (
    (deal.template === "non_aggression_pact" ||
      deal.template === "trade_security_pact") &&
    (seenObligors.size !== 2 ||
      !seenObligors.has(deal.proposerPlayerID) ||
      !seenObligors.has(deal.recipientPlayerID))
  ) {
    return null;
  }
  if (
    deal.template === "joint_attack" &&
    (obligations[0].obligorPlayerID !== deal.proposerPlayerID ||
      obligations[0].targetPlayerID === deal.proposerPlayerID ||
      obligations[0].targetPlayerID === deal.recipientPlayerID)
  ) {
    return null;
  }
  if (
    deal.template === "support_request" &&
    obligations[0].obligorPlayerID !== deal.recipientPlayerID
  ) {
    return null;
  }
  return {
    dealID: deal.dealID,
    template: deal.template,
    proposerPlayerID: deal.proposerPlayerID,
    proposerName: deal.proposerName,
    recipientPlayerID: deal.recipientPlayerID,
    recipientName: deal.recipientName,
    activeFromStep: deal.activeFromStep,
    expiresAfterStep: deal.expiresAfterStep,
    stepsRemaining: deal.stepsRemaining,
    obligations,
  };
}

function boundedProposalOption(option) {
  if (
    !hasExactKeys(option, ["recipientPlayerID", "recipientName", "terms"]) ||
    !isStrictPlayerID(option.recipientPlayerID) ||
    !isBoundedName(option.recipientName)
  ) {
    return null;
  }
  const terms = boundedDealTerms(option.terms);
  return terms === null
    ? null
    : {
        recipientPlayerID: option.recipientPlayerID,
        recipientName: option.recipientName,
        terms,
      };
}

function boundedRivalReliability(reliability) {
  if (
    !hasExactKeys(reliability, [
      "playerID",
      "name",
      "fulfilled",
      "terminalNonMoot",
      "reliability",
    ]) ||
    !isStrictPlayerID(reliability.playerID) ||
    !isBoundedName(reliability.name) ||
    !isNonnegativeSafeInteger(reliability.fulfilled) ||
    !isNonnegativeSafeInteger(reliability.terminalNonMoot) ||
    reliability.fulfilled > reliability.terminalNonMoot
  ) {
    return null;
  }
  const expected =
    reliability.terminalNonMoot === 0
      ? null
      : Math.round(
          (reliability.fulfilled / reliability.terminalNonMoot) * 100,
        ) / 100;
  if (reliability.reliability !== expected) return null;
  return {
    playerID: reliability.playerID,
    name: reliability.name,
    fulfilled: reliability.fulfilled,
    terminalNonMoot: reliability.terminalNonMoot,
    reliability: reliability.reliability,
  };
}

export function advertisedMessageLimit(protocol) {
  const value = protocol?.maxMessageChars;
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, OWNER_MESSAGE_MAX_CHARS)
    : null;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isSafeAgentMessageText(text, maxChars) {
  return (
    typeof text === "string" &&
    Number.isInteger(maxChars) &&
    maxChars > 0 &&
    text.trim().length > 0 &&
    text.length <= maxChars &&
    !CONTROL.test(text) &&
    !INVISIBLE_FORMAT_OR_SEPARATOR.test(text) &&
    !hasUnpairedSurrogate(text)
  );
}

export function boundedDealsObservation(deals, ownPlayerID) {
  if (
    !hasExactKeys(deals, [
      "decisionStep",
      "incomingProposals",
      "outgoingProposals",
      "activeDeals",
      "proposalOptions",
      "rivalReliability",
    ]) ||
    !isStrictPlayerID(ownPlayerID) ||
    !Number.isSafeInteger(deals.decisionStep) ||
    deals.decisionStep < 0
  ) {
    return null;
  }
  for (const field of [
    "incomingProposals",
    "outgoingProposals",
    "activeDeals",
    "proposalOptions",
    "rivalReliability",
  ]) {
    if (!isBoundedRecordArray(deals[field], MAX_DEAL_OBSERVATION_ROWS)) {
      return null;
    }
  }
  const bounded = {
    decisionStep: deals.decisionStep,
    incomingProposals: deals.incomingProposals.map((proposal) =>
      boundedDealProposal(
        proposal,
        ownPlayerID,
        deals.decisionStep,
        "incoming",
      ),
    ),
    outgoingProposals: deals.outgoingProposals.map((proposal) =>
      boundedDealProposal(
        proposal,
        ownPlayerID,
        deals.decisionStep,
        "outgoing",
      ),
    ),
    activeDeals: deals.activeDeals.map((deal) =>
      boundedActiveDeal(deal, ownPlayerID, deals.decisionStep),
    ),
    proposalOptions: deals.proposalOptions.map(boundedProposalOption),
    rivalReliability: deals.rivalReliability.map(boundedRivalReliability),
  };
  if (
    [
      ...bounded.incomingProposals,
      ...bounded.outgoingProposals,
      ...bounded.activeDeals,
      ...bounded.proposalOptions,
      ...bounded.rivalReliability,
    ].some((row) => row === null)
  ) {
    return null;
  }

  const seenDealIDs = new Set();
  for (const proposal of [
    ...bounded.incomingProposals,
    ...bounded.outgoingProposals,
  ]) {
    if (seenDealIDs.has(proposal.dealID)) return null;
    seenDealIDs.add(proposal.dealID);
  }
  for (const deal of bounded.activeDeals) {
    if (seenDealIDs.has(deal.dealID)) return null;
    seenDealIDs.add(deal.dealID);
  }
  const optionKeys = new Set();
  for (const option of bounded.proposalOptions) {
    if (
      option.recipientPlayerID === ownPlayerID ||
      (option.terms.template === "joint_attack" &&
        (option.terms.targetPlayerID === ownPlayerID ||
          option.terms.targetPlayerID === option.recipientPlayerID))
    ) {
      return null;
    }
    const key = `${option.recipientPlayerID}\u0000${option.terms.template}`;
    if (optionKeys.has(key)) return null;
    optionKeys.add(key);
  }
  const reliabilityPlayerIDs = new Set();
  for (const entry of bounded.rivalReliability) {
    if (
      entry.playerID === ownPlayerID ||
      reliabilityPlayerIDs.has(entry.playerID)
    )
      return null;
    reliabilityPlayerIDs.add(entry.playerID);
  }
  return bounded;
}

export function boundedInboundMessages(observation) {
  const inbound = observation?.nonCombat?.inboundMessages;
  if (!Array.isArray(inbound) || inbound.length > 8) return null;
  const bounded = [];
  const messagesPerSender = new Map();
  let previousTurn = -1;
  for (const entry of inbound) {
    if (
      !isRecord(entry) ||
      !isBoundedVisibleString(entry.senderID, 200) ||
      !isBoundedVisibleString(entry.senderName, 120, true) ||
      !Number.isSafeInteger(entry.turnNumber) ||
      entry.turnNumber < 0 ||
      entry.turnNumber < previousTurn ||
      !isSafeAgentMessageText(entry.text, OWNER_MESSAGE_MAX_CHARS)
    ) {
      return null;
    }
    const senderCount = (messagesPerSender.get(entry.senderID) ?? 0) + 1;
    if (senderCount > 3) return null;
    messagesPerSender.set(entry.senderID, senderCount);
    previousTurn = entry.turnNumber;
    bounded.push({
      senderID: entry.senderID,
      senderName: entry.senderName,
      text: entry.text,
      turnNumber: entry.turnNumber,
    });
  }
  return bounded;
}

/**
 * Preserve ordinary observation fields, but expose optional owner capabilities
 * to policy code only when their complete bounded container is well formed.
 * This prevents a malformed optional array from crashing the primary action
 * path before the exact-slot output gates run.
 */
export function ownerCapabilityObservation(input) {
  if (!isRecord(input)) return { visiblePlayers: [] };
  const {
    deals: rawDeals,
    nonCombat: rawNonCombat,
    visiblePlayers,
    ...rest
  } = input;
  const deals = boundedDealsObservation(rawDeals, input.ownState?.playerID);
  const inboundMessages = boundedInboundMessages(input);
  const safeVisiblePlayers = isBoundedRecordArray(visiblePlayers, 64)
    ? visiblePlayers
    : [];
  const nonCombatBase = isRecord(rawNonCombat)
    ? Object.fromEntries(
        Object.entries(rawNonCombat).filter(
          ([key]) => key !== "inboundMessages",
        ),
      )
    : null;
  return {
    ...rest,
    visiblePlayers: safeVisiblePlayers,
    ...(deals ? { deals } : {}),
    ...(nonCombatBase || inboundMessages
      ? {
          nonCombat: {
            ...(nonCombatBase ?? {}),
            ...(inboundMessages ? { inboundMessages } : {}),
          },
        }
      : {}),
  };
}

function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedEvidenceID(value) {
  return isBoundedVisibleString(value, 200) ? value : null;
}

/**
 * Privacy-safe, bounded policy evidence. It records offered/selected IDs and
 * message body digests, never raw message bodies, prompts, or provider output.
 * This is observation only and cannot alter the response or game simulation.
 */
export function createOwnerCapabilityEvidenceLogger({
  emit = (line) => console.log(line),
  maxEventsPerKind = OWNER_EVIDENCE_MAX_EVENTS_PER_KIND,
} = {}) {
  const counts = new Map();
  const seenInbound = new Set();
  let spatialRecorded = false;

  const record = (kind, value) => {
    const count = counts.get(kind) ?? 0;
    if (count >= maxEventsPerKind) return false;
    counts.set(kind, count + 1);
    try {
      emit(
        `PROXYWAR_OWNER_CAPABILITY_EVIDENCE ${JSON.stringify({ kind, ...value })}`,
      );
    } catch {
      // Evidence must never become action-path authority or availability risk.
    }
    return true;
  };

  return ({
    requestID,
    slot,
    actions,
    observation,
    response,
    spawn = false,
  }) => {
    const offered = Array.isArray(actions) ? actions : [];
    const base = {
      ...(boundedEvidenceID(requestID) ? { requestID } : {}),
      ...(Number.isSafeInteger(slot) && slot >= 0 ? { slot } : {}),
      ...(boundedEvidenceID(observation?.ownState?.playerID)
        ? { ownPlayerID: observation.ownState.playerID }
        : {}),
      selectedLegalActionID: boundedEvidenceID(response?.selectedLegalActionId),
      selectedLegalActionOffered: offered.some(
        (action) => action?.id === response?.selectedLegalActionId,
      ),
    };

    if (typeof response?.selectedDealActionId === "string") {
      record("deal_selection", {
        ...base,
        offeredDealActionIDs: offered
          .filter((action) => DEAL_KINDS.has(action?.kind))
          .slice(0, 16)
          .map((action) => action.id),
        selectedDealActionID: response.selectedDealActionId,
      });
    }

    if (
      typeof response?.selectedMessageActionId === "string" &&
      typeof response?.messageText === "string"
    ) {
      const selectedMessageAction = offered.find(
        (action) =>
          action?.kind === "message" &&
          action.id === response.selectedMessageActionId,
      );
      record("message_selection", {
        ...base,
        offeredMessageActionIDs: offered
          .filter((action) => action?.kind === "message")
          .slice(0, 8)
          .map((action) => action.id),
        selectedMessageActionID: response.selectedMessageActionId,
        ...(boundedEvidenceID(selectedMessageAction?.metadata?.recipientID)
          ? {
              selectedMessageRecipientID:
                selectedMessageAction.metadata.recipientID,
            }
          : {}),
        messageBodySHA256: sha256Utf8(response.messageText),
        messageBodyUTF8Bytes: new TextEncoder().encode(response.messageText)
          .byteLength,
        messageBodyUTF16CodeUnits: response.messageText.length,
      });
    }

    for (const entry of boundedInboundMessages(observation) ?? []) {
      const digest = sha256Utf8(entry.text);
      const key = `${entry.senderID}\u0000${entry.turnNumber}\u0000${digest}`;
      if (seenInbound.has(key)) continue;
      const recorded = record("message_observation", {
        ...base,
        senderID: entry.senderID,
        senderTurn: entry.turnNumber,
        messageBodySHA256: digest,
        messageBodyUTF8Bytes: new TextEncoder().encode(entry.text).byteLength,
        messageBodyUTF16CodeUnits: entry.text.length,
      });
      if (recorded) seenInbound.add(key);
    }

    if (!spawn && !spatialRecorded) {
      const spatial = boundedSpatialObservation(observation);
      const spatialBase = spatial
        ? spatial.schemaVersion === 3 || spatial.schemaVersion === 5
          ? {
              mapInfo: spatial.mapInfo,
              spatial: {
                schemaVersion: spatial.schemaVersion,
                visibilityModel: spatial.visibilityModel,
                ownShape: spatial.ownShape,
                positionedAssets: spatial.positionedAssets,
              },
              visiblePlayers: spatial.rivals,
            }
          : {
              schemaVersion: spatial.schemaVersion,
              visibilityModel: spatial.visibilityModel,
              ownShape: spatial.ownShape,
              rivals: spatial.rivals,
            }
        : null;
      record("spatial_observation", {
        ...base,
        present: spatial !== null,
        ...(spatial
          ? {
              schemaVersion: spatial.schemaVersion,
              visibilityModel: spatial.visibilityModel,
              minimapPresent: spatial.minimap !== undefined,
              ...(spatial.minimap !== undefined
                ? { minimapSchemaVersion: spatial.minimap.schemaVersion }
                : {}),
              baseSerializedUTF8Bytes: new TextEncoder().encode(
                JSON.stringify(spatialBase),
              ).byteLength,
              ...(spatial.minimap !== undefined
                ? {
                    minimapSerializedUTF8Bytes: new TextEncoder().encode(
                      JSON.stringify(spatial.minimap),
                    ).byteLength,
                  }
                : {}),
            }
          : {}),
      });
      spatialRecorded = true;
    }
  };
}

export function exactOfferedAction(actions, id, allowedKinds) {
  if (!Array.isArray(actions) || typeof id !== "string") return null;
  const action = actions.find((candidate) => candidate?.id === id);
  if (!action) return null;
  if (allowedKinds !== undefined && !allowedKinds.has(action.kind)) return null;
  return action;
}

export function dealResponseFields({ actions, observation, dealMove }) {
  if (
    boundedDealsObservation(
      observation?.deals,
      observation?.ownState?.playerID,
    ) === null
  )
    return {};
  const action = exactOfferedAction(actions, dealMove?.id, DEAL_KINDS);
  return action ? { selectedDealActionId: action.id } : {};
}

export function messageResponseFields({ actions, protocol, messageMove }) {
  const maxChars = advertisedMessageLimit(protocol);
  if (maxChars === null) return {};
  const action = exactOfferedAction(
    actions,
    messageMove?.id,
    new Set(["message"]),
  );
  if (!action || !isSafeAgentMessageText(messageMove?.text, maxChars))
    return {};
  return {
    selectedMessageActionId: action.id,
    // Deliberately the exact input string: no trim, slice, normalization, or
    // interpolation between validation and JSON serialization.
    messageText: messageMove.text,
  };
}

function boundedPercent(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function boundedNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isBoundedVisibleString(value, maxLength, allowEmpty = false) {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0) &&
    !CONTROL.test(value) &&
    !INVISIBLE_FORMAT_OR_SEPARATOR.test(value) &&
    !hasUnpairedSurrogate(value)
  );
}

export function isWithinOwnerSpatialSerializationCeiling(value) {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    OWNER_SPATIAL_SERIALIZED_MAX_BYTES
  );
}

function boundedMinimapV1(minimap, allowedPlayerIDs, ownPlayerID) {
  if (
    minimap?.schemaVersion !== 1 ||
    minimap.width !== 24 ||
    minimap.height !== 12 ||
    !Array.isArray(minimap.rows) ||
    minimap.rows.length !== 12 ||
    !minimap.rows.every(
      (row) => typeof row === "string" && MINIMAP_ROW.test(row),
    ) ||
    !Array.isArray(minimap.legend) ||
    minimap.legend.length > 64
  ) {
    return null;
  }
  const legend = [];
  const seenGlyphs = new Set();
  const seenPlayerIDs = new Set();
  for (const entry of minimap.legend) {
    if (
      !MINIMAP_GLYPH.test(entry?.glyph ?? "") ||
      !isBoundedVisibleString(entry?.playerID, 200) ||
      !allowedPlayerIDs.has(entry.playerID) ||
      typeof entry?.isYou !== "boolean" ||
      entry.isYou !== (entry.playerID === ownPlayerID) ||
      seenGlyphs.has(entry.glyph) ||
      seenPlayerIDs.has(entry.playerID)
    ) {
      return null;
    }
    seenGlyphs.add(entry.glyph);
    seenPlayerIDs.add(entry.playerID);
    legend.push({
      glyph: entry.glyph,
      playerID: entry.playerID,
      isYou: entry.isYou,
    });
  }
  if (!legend.some((entry) => entry.isYou)) return null;
  const allowedGlyphs = new Set([".", "~", ...seenGlyphs]);
  if (
    minimap.rows.some((row) =>
      [...row].some((glyph) => !allowedGlyphs.has(glyph)),
    )
  ) {
    return null;
  }
  const bounded = {
    schemaVersion: 1,
    width: 24,
    height: 12,
    rows: [...minimap.rows],
    legend,
  };
  return new TextEncoder().encode(JSON.stringify(bounded)).byteLength <=
    OWNER_MINIMAP_SERIALIZED_MAX_BYTES
    ? bounded
    : null;
}

function boundedMinimapV2(
  minimap,
  allowedPlayerIDs,
  ownPlayerID,
  mapInfo,
  expectedMarkersTotal,
) {
  const dimensionPair =
    (minimap?.width === 24 && minimap?.height === 12) ||
    (minimap?.width === 32 && minimap?.height === 16);
  if (
    minimap?.schemaVersion !== 2 ||
    !dimensionPair ||
    (mapInfo &&
      (mapInfo.width * mapInfo.height >= OWNER_MINIMAP_LARGE_TILE_THRESHOLD
        ? minimap.width !== 32 || minimap.height !== 16
        : minimap.width !== 24 || minimap.height !== 12)) ||
    !Array.isArray(minimap.ownershipRows) ||
    minimap.ownershipRows.length !== minimap.height ||
    !minimap.ownershipRows.every(
      (row) =>
        typeof row === "string" &&
        row.length === minimap.width &&
        MINIMAP_V2_OWNERSHIP_ROW.test(row),
    ) ||
    !Array.isArray(minimap.terrainRows) ||
    minimap.terrainRows.length !== minimap.height ||
    !minimap.terrainRows.every(
      (row) =>
        typeof row === "string" &&
        row.length === minimap.width &&
        MINIMAP_V2_TERRAIN_ROW.test(row),
    ) ||
    !Array.isArray(minimap.legend) ||
    minimap.legend.length > 64 ||
    !Array.isArray(minimap.markers) ||
    minimap.markers.length > 24 ||
    boundedNonnegativeInteger(minimap.markersTotal) === null ||
    (expectedMarkersTotal !== undefined &&
      minimap.markersTotal !== expectedMarkersTotal) ||
    minimap.markersTotal < minimap.markers.length ||
    minimap.markersReturned !== minimap.markers.length ||
    minimap.markersTruncated !== minimap.markers.length < minimap.markersTotal
  ) {
    return null;
  }
  const legend = [];
  const seenGlyphs = new Set();
  const seenPlayerIDs = new Set();
  for (const entry of minimap.legend) {
    if (
      !MINIMAP_GLYPH.test(entry?.glyph ?? "") ||
      !isBoundedVisibleString(entry?.playerID, 200) ||
      !allowedPlayerIDs.has(entry.playerID) ||
      typeof entry?.isYou !== "boolean" ||
      entry.isYou !== (entry.playerID === ownPlayerID) ||
      seenGlyphs.has(entry.glyph) ||
      seenPlayerIDs.has(entry.playerID)
    ) {
      return null;
    }
    seenGlyphs.add(entry.glyph);
    seenPlayerIDs.add(entry.playerID);
    legend.push({
      glyph: entry.glyph,
      playerID: entry.playerID,
      isYou: entry.isYou,
    });
  }
  if (legend.filter((entry) => entry.isYou).length !== 1) return null;
  const allowedGlyphs = new Set([".", "~", ...seenGlyphs]);
  if (
    minimap.ownershipRows.some((row) =>
      [...row].some((glyph) => !allowedGlyphs.has(glyph)),
    )
  ) {
    return null;
  }
  const markers = [];
  for (const marker of minimap.markers) {
    if (
      !isRecord(marker) ||
      !["D", "C", "P", "W"].includes(marker.type) ||
      !isBoundedVisibleString(marker.ownerPlayerID, 200) ||
      !allowedPlayerIDs.has(marker.ownerPlayerID) ||
      boundedNonnegativeInteger(marker.x) === null ||
      marker.x >= minimap.width ||
      boundedNonnegativeInteger(marker.y) === null ||
      marker.y >= minimap.height
    ) {
      return null;
    }
    markers.push({
      type: marker.type,
      ownerPlayerID: marker.ownerPlayerID,
      x: marker.x,
      y: marker.y,
    });
  }
  const bounded = {
    schemaVersion: 2,
    width: minimap.width,
    height: minimap.height,
    ownershipRows: [...minimap.ownershipRows],
    terrainRows: [...minimap.terrainRows],
    legend,
    markers,
    markersTotal: minimap.markersTotal,
    markersReturned: markers.length,
    markersTruncated: markers.length < minimap.markersTotal,
  };
  return new TextEncoder().encode(JSON.stringify(bounded)).byteLength <=
    OWNER_MINIMAP_SERIALIZED_MAX_BYTES
    ? bounded
    : null;
}

export function boundedSpatialMapInfo(mapInfo) {
  if (
    !isRecord(mapInfo) ||
    !isBoundedVisibleString(mapInfo.name, 120) ||
    !Number.isSafeInteger(mapInfo.width) ||
    mapInfo.width <= 0 ||
    mapInfo.width > 100_000 ||
    !Number.isSafeInteger(mapInfo.height) ||
    mapInfo.height <= 0 ||
    mapInfo.height > 100_000 ||
    !Number.isSafeInteger(mapInfo.width * mapInfo.height) ||
    mapInfo.tileRefEncoding !== "row-major-y-width-plus-x" ||
    !isRecord(mapInfo.coordinateFrame) ||
    mapInfo.coordinateFrame.origin !== "top_left" ||
    mapInfo.coordinateFrame.xIncreases !== "east" ||
    mapInfo.coordinateFrame.yIncreases !== "south"
  ) {
    return null;
  }
  return {
    name: mapInfo.name,
    width: mapInfo.width,
    height: mapInfo.height,
    tileRefEncoding: "row-major-y-width-plus-x",
    coordinateFrame: {
      origin: "top_left",
      xIncreases: "east",
      yIncreases: "south",
    },
  };
}

function boundedSpatialOwnShape(ownShape, requireL4 = false) {
  const quadrants = new Set([
    "northwest",
    "north",
    "northeast",
    "west",
    "center",
    "east",
    "southwest",
    "south",
    "southeast",
  ]);
  if (
    !isRecord(ownShape) ||
    !quadrants.has(ownShape.quadrant) ||
    !["complete", "omitted_budget"].includes(ownShape.regionAnalysis) ||
    !["largest_region_border", "all_border_budget_fallback"].includes(
      ownShape.centroidBasis,
    ) ||
    (ownShape.compactness !== undefined &&
      !["compact", "stretched", "fragmented"].includes(ownShape.compactness)) ||
    (ownShape.regionCount !== undefined &&
      boundedNonnegativeInteger(ownShape.regionCount) === null) ||
    (ownShape.largestRegionShare !== undefined &&
      boundedPercent(ownShape.largestRegionShare) === null) ||
    boundedPercent(ownShape.coastShare) === null ||
    (requireL4 &&
      boundedPercent(ownShape.largestNeighborBorderShare) === null) ||
    boundedPercent(ownShape.centroid?.xPct) === null ||
    boundedPercent(ownShape.centroid?.yPct) === null
  ) {
    return null;
  }
  return {
    quadrant: ownShape.quadrant,
    ...(ownShape.compactness !== undefined
      ? { compactness: ownShape.compactness }
      : {}),
    ...(ownShape.regionCount !== undefined
      ? { regionCount: ownShape.regionCount }
      : {}),
    ...(ownShape.largestRegionShare !== undefined
      ? { largestRegionShare: ownShape.largestRegionShare }
      : {}),
    regionAnalysis: ownShape.regionAnalysis,
    centroidBasis: ownShape.centroidBasis,
    coastShare: ownShape.coastShare,
    ...(ownShape.largestNeighborBorderShare !== undefined
      ? {
          largestNeighborBorderShare: ownShape.largestNeighborBorderShare,
        }
      : {}),
    centroid: {
      xPct: ownShape.centroid.xPct,
      yPct: ownShape.centroid.yPct,
    },
  };
}

function boundedSpatialV3Rivals(
  visiblePlayers,
  ownPlayerID,
  requireL4 = false,
  maxMapTiles,
) {
  if (
    !Array.isArray(visiblePlayers) ||
    visiblePlayers.length > 64 ||
    !Number.isSafeInteger(maxMapTiles) ||
    maxMapTiles <= 0
  )
    return null;
  const bearings = new Set([
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ]);
  const distances = new Set(["adjacent", "near", "far"]);
  const rivals = [];
  const seenRivalIDs = new Set();
  for (const player of visiblePlayers) {
    if (
      !isBoundedVisibleString(player?.playerID, 200) ||
      player.playerID === ownPlayerID ||
      seenRivalIDs.has(player.playerID) ||
      (requireL4 && typeof player.sharesBorder !== "boolean")
    ) {
      return null;
    }
    seenRivalIDs.add(player.playerID);
    let borderWithYou;
    if (player.borderWithYou !== undefined) {
      const border = player.borderWithYou;
      const terrain = border?.terrainBreakdown;
      const coverage = border?.defensePostFrontCoverage;
      if (
        !isRecord(border) ||
        boundedNonnegativeInteger(border.tiles) === null ||
        border.tiles === 0 ||
        border.tiles > maxMapTiles ||
        boundedPercent(border.shareOfYourBorder) === null ||
        !["land", "coastal", "mixed"].includes(border.terrain) ||
        boundedNonnegativeInteger(border.defensePostsCovering) === null ||
        border.defensePostsCovering > maxMapTiles ||
        typeof border.underAttackHere !== "boolean" ||
        !isRecord(terrain) ||
        boundedNonnegativeInteger(terrain.plains) === null ||
        boundedNonnegativeInteger(terrain.highland) === null ||
        boundedNonnegativeInteger(terrain.mountain) === null ||
        boundedNonnegativeInteger(terrain.shore) === null ||
        terrain.plains + terrain.highland + terrain.mountain !== border.tiles ||
        terrain.shore > border.tiles ||
        (border.terrain === "land" && terrain.shore !== 0) ||
        (border.terrain === "coastal" && terrain.shore !== border.tiles) ||
        (border.terrain === "mixed" &&
          (terrain.shore === 0 || terrain.shore === border.tiles)) ||
        !isRecord(coverage) ||
        boundedNonnegativeInteger(coverage.covered) === null ||
        boundedNonnegativeInteger(coverage.uncovered) === null ||
        coverage.covered + coverage.uncovered !== border.tiles ||
        (border.defensePostsCovering === 0) !== (coverage.covered === 0)
      ) {
        return null;
      }
      borderWithYou = {
        tiles: border.tiles,
        shareOfYourBorder: border.shareOfYourBorder,
        terrain: border.terrain,
        terrainBreakdown: {
          plains: terrain.plains,
          highland: terrain.highland,
          mountain: terrain.mountain,
          shore: terrain.shore,
        },
        defensePostsCovering: border.defensePostsCovering,
        defensePostFrontCoverage: {
          covered: coverage.covered,
          uncovered: coverage.uncovered,
        },
        underAttackHere: border.underAttackHere,
      };
    }
    let bordersWith;
    if (player.bordersWith !== undefined) {
      if (!Array.isArray(player.bordersWith) || player.bordersWith.length > 64)
        return null;
      bordersWith = [];
      const seenBorderPlayerIDs = new Set();
      for (const edge of player.bordersWith) {
        if (
          !isBoundedVisibleString(edge?.playerID, 200) ||
          edge.playerID === ownPlayerID ||
          edge.playerID === player.playerID ||
          seenBorderPlayerIDs.has(edge.playerID) ||
          !["minor", "major"].includes(edge?.sizeClass) ||
          (requireL4 &&
            (boundedNonnegativeInteger(edge?.tiles) === null ||
              edge.tiles === 0 ||
              edge.tiles > maxMapTiles))
        ) {
          return null;
        }
        seenBorderPlayerIDs.add(edge.playerID);
        bordersWith.push({
          playerID: edge.playerID,
          sizeClass: edge.sizeClass,
          ...(edge.tiles !== undefined ? { tiles: edge.tiles } : {}),
        });
      }
    }
    if (
      (player.bearing !== undefined && !bearings.has(player.bearing)) ||
      (requireL4 && (borderWithYou !== undefined) !== player.sharesBorder) ||
      (requireL4 &&
        borderWithYou !== undefined &&
        player.distanceClass !== "adjacent") ||
      (requireL4 && !distances.has(player.distanceClass)) ||
      (player.distanceClass !== undefined &&
        !distances.has(player.distanceClass)) ||
      (requireL4 && !Array.isArray(player.bordersWith))
    ) {
      return null;
    }
    let navalExposure;
    if (requireL4) {
      const naval = player.navalExposure;
      if (
        !isRecord(naval) ||
        boundedNonnegativeInteger(naval.transportReachableOwnShoreTiles) ===
          null ||
        naval.transportReachableOwnShoreTiles > maxMapTiles ||
        (naval.nearestEnemyPort !== undefined &&
          (!isRecord(naval.nearestEnemyPort) ||
            !bearings.has(naval.nearestEnemyPort.bearing) ||
            !["near", "far"].includes(naval.nearestEnemyPort.distanceClass)))
      ) {
        return null;
      }
      navalExposure = {
        transportReachableOwnShoreTiles: naval.transportReachableOwnShoreTiles,
        ...(naval.nearestEnemyPort !== undefined
          ? {
              nearestEnemyPort: {
                bearing: naval.nearestEnemyPort.bearing,
                distanceClass: naval.nearestEnemyPort.distanceClass,
              },
            }
          : {}),
      };
    }
    rivals.push({
      playerID: player.playerID,
      ...(bearings.has(player.bearing) ? { bearing: player.bearing } : {}),
      ...(distances.has(player.distanceClass)
        ? { distanceClass: player.distanceClass }
        : {}),
      ...(borderWithYou ? { borderWithYou } : {}),
      ...(bordersWith ? { bordersWith } : {}),
      ...(navalExposure ? { navalExposure } : {}),
    });
  }
  return rivals;
}

function boundedPositionedAssets(positioned, mapInfo, allowedPlayerIDs) {
  if (
    !isRecord(positioned) ||
    !["complete", "capped"].includes(positioned.analysis) ||
    !Array.isArray(positioned.structures) ||
    positioned.structures.length > 48 ||
    !Array.isArray(positioned.warships) ||
    positioned.warships.length > 48 ||
    boundedNonnegativeInteger(positioned.structuresTotal) === null ||
    positioned.structuresReturned !== positioned.structures.length ||
    typeof positioned.structuresTruncated !== "boolean" ||
    boundedNonnegativeInteger(positioned.warshipsTotal) === null ||
    positioned.warshipsReturned !== positioned.warships.length ||
    typeof positioned.warshipsTruncated !== "boolean"
  ) {
    return null;
  }
  if (
    positioned.structuresTotal < positioned.structures.length ||
    positioned.warshipsTotal < positioned.warships.length ||
    !Number.isSafeInteger(
      positioned.structuresTotal + positioned.warshipsTotal,
    ) ||
    positioned.structuresTruncated !==
      positioned.structures.length < positioned.structuresTotal ||
    positioned.warshipsTruncated !==
      positioned.warships.length < positioned.warshipsTotal ||
    (positioned.analysis === "complete" &&
      (positioned.structuresTruncated || positioned.warshipsTruncated)) ||
    (positioned.analysis === "capped" &&
      !positioned.structuresTruncated &&
      !positioned.warshipsTruncated)
  ) {
    return null;
  }

  const perPlayerStructures = new Map();
  const perPlayerWarships = new Map();
  const parse = (items, kinds, perPlayer) => {
    const result = [];
    for (const asset of items) {
      if (
        !isRecord(asset) ||
        !allowedPlayerIDs.has(asset.ownerPlayerID) ||
        !kinds.has(asset.type) ||
        !Number.isSafeInteger(asset.tile) ||
        asset.tile < 0 ||
        asset.tile >= mapInfo.width * mapInfo.height ||
        !Number.isSafeInteger(asset.x) ||
        !Number.isSafeInteger(asset.y) ||
        asset.x < 0 ||
        asset.x >= mapInfo.width ||
        asset.y < 0 ||
        asset.y >= mapInfo.height ||
        asset.tile !== asset.y * mapInfo.width + asset.x
      ) {
        return null;
      }
      const count = (perPlayer.get(asset.ownerPlayerID) ?? 0) + 1;
      if (count > 8) return null;
      perPlayer.set(asset.ownerPlayerID, count);
      result.push({
        ownerPlayerID: asset.ownerPlayerID,
        type: asset.type,
        tile: asset.tile,
        x: asset.x,
        y: asset.y,
      });
    }
    return result;
  };
  const structures = parse(
    positioned.structures,
    new Set(["Defense Post", "City", "Port"]),
    perPlayerStructures,
  );
  const warships = parse(
    positioned.warships,
    new Set(["Warship"]),
    perPlayerWarships,
  );
  if (!structures || !warships) return null;
  return {
    analysis: positioned.analysis,
    structures,
    structuresTotal: positioned.structuresTotal,
    structuresReturned: structures.length,
    structuresTruncated: positioned.structuresTruncated,
    warships,
    warshipsTotal: positioned.warshipsTotal,
    warshipsReturned: warships.length,
    warshipsTruncated: positioned.warshipsTruncated,
  };
}

/**
 * Accept only the declared no-fog/global-lockstep player-visible v1 contract.
 * A malformed optional minimap is omitted as a whole; it is never cropped,
 * padded, glyph-rewritten, or reconstructed from hidden map truth.
 */
export function boundedSpatialV1(observation) {
  const spatial = observation?.spatial;
  const ownShape = spatial?.ownShape;
  const quadrants = new Set([
    "northwest",
    "north",
    "northeast",
    "west",
    "center",
    "east",
    "southwest",
    "south",
    "southeast",
  ]);
  if (
    spatial?.schemaVersion !== 1 ||
    spatial.visibilityModel !== SPATIAL_VISIBILITY_MODEL ||
    !ownShape ||
    !quadrants.has(ownShape.quadrant) ||
    !["complete", "omitted_budget"].includes(ownShape.regionAnalysis) ||
    !["largest_region_border", "all_border_budget_fallback"].includes(
      ownShape.centroidBasis,
    ) ||
    (ownShape.compactness !== undefined &&
      !["compact", "stretched", "fragmented"].includes(ownShape.compactness)) ||
    (ownShape.regionCount !== undefined &&
      boundedNonnegativeInteger(ownShape.regionCount) === null) ||
    (ownShape.largestRegionShare !== undefined &&
      boundedPercent(ownShape.largestRegionShare) === null) ||
    boundedPercent(ownShape.coastShare) === null ||
    boundedPercent(ownShape.centroid?.xPct) === null ||
    boundedPercent(ownShape.centroid?.yPct) === null
  ) {
    return null;
  }

  if (
    !Array.isArray(observation.visiblePlayers) ||
    observation.visiblePlayers.length > 64
  )
    return null;
  const rivals = [];
  const ownPlayerID = observation?.ownState?.playerID;
  if (!isBoundedVisibleString(ownPlayerID, 200)) return null;
  const bearings = new Set([
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ]);
  const distances = new Set(["adjacent", "near", "far"]);
  for (const player of observation.visiblePlayers) {
    if (!isBoundedVisibleString(player?.playerID, 200)) return null;
    let borderWithYou;
    if (player.borderWithYou !== undefined) {
      const border = player.borderWithYou;
      if (
        !border ||
        typeof border !== "object" ||
        Array.isArray(border) ||
        boundedNonnegativeInteger(border.tiles) === null ||
        boundedPercent(border.shareOfYourBorder) === null ||
        !["land", "coastal", "mixed"].includes(border.terrain) ||
        boundedNonnegativeInteger(border.defensePostsCovering) === null ||
        typeof border.underAttackHere !== "boolean"
      ) {
        return null;
      }
      borderWithYou = {
        tiles: border.tiles,
        shareOfYourBorder: border.shareOfYourBorder,
        terrain: border.terrain,
        defensePostsCovering: border.defensePostsCovering,
        underAttackHere: border.underAttackHere,
      };
    }
    let bordersWith;
    if (player.bordersWith !== undefined) {
      if (!Array.isArray(player.bordersWith) || player.bordersWith.length > 64)
        return null;
      bordersWith = [];
      for (const edge of player.bordersWith) {
        if (
          !isBoundedVisibleString(edge?.playerID, 200) ||
          !["minor", "major"].includes(edge?.sizeClass)
        ) {
          return null;
        }
        bordersWith.push({
          playerID: edge.playerID,
          sizeClass: edge.sizeClass,
        });
      }
    }
    if (
      (player.bearing !== undefined && !bearings.has(player.bearing)) ||
      (player.distanceClass !== undefined &&
        !distances.has(player.distanceClass))
    ) {
      return null;
    }
    rivals.push({
      playerID: player.playerID,
      ...(bearings.has(player.bearing) ? { bearing: player.bearing } : {}),
      ...(distances.has(player.distanceClass)
        ? { distanceClass: player.distanceClass }
        : {}),
      ...(borderWithYou ? { borderWithYou } : {}),
      ...(bordersWith ? { bordersWith } : {}),
    });
  }

  const allowedPlayerIDs = new Set([
    ownPlayerID,
    ...rivals.map((rival) => rival.playerID),
  ]);
  if (
    allowedPlayerIDs.size !== rivals.length + 1 ||
    rivals.some((rival) =>
      (rival.bordersWith ?? []).some(
        (edge) => !allowedPlayerIDs.has(edge.playerID),
      ),
    )
  ) {
    return null;
  }
  const minimap = boundedMinimapV1(
    spatial.minimap,
    allowedPlayerIDs,
    ownPlayerID,
  );
  const bounded = {
    schemaVersion: 1,
    visibilityModel: SPATIAL_VISIBILITY_MODEL,
    ownShape: {
      quadrant: ownShape.quadrant,
      ...(ownShape.compactness !== undefined
        ? { compactness: ownShape.compactness }
        : {}),
      ...(ownShape.regionCount !== undefined
        ? { regionCount: ownShape.regionCount }
        : {}),
      ...(ownShape.largestRegionShare !== undefined
        ? { largestRegionShare: ownShape.largestRegionShare }
        : {}),
      regionAnalysis: ownShape.regionAnalysis,
      centroidBasis: ownShape.centroidBasis,
      coastShare: ownShape.coastShare,
      centroid: {
        xPct: ownShape.centroid.xPct,
        yPct: ownShape.centroid.yPct,
      },
    },
    rivals,
    ...(minimap ? { minimap } : {}),
  };
  return isWithinOwnerSpatialSerializationCeiling(bounded) ? bounded : null;
}

/**
 * Accept only the complete L1-L3 spatial schema. Coordinates and public asset
 * positions fail closed as one unit: no clamping, cropping, inferred owner,
 * partial container, or unknown visibility provenance reaches policy code.
 */
export function boundedSpatialV3(observation) {
  const spatial = observation?.spatial;
  if (
    spatial?.schemaVersion !== 3 ||
    spatial.visibilityModel !== SPATIAL_VISIBILITY_MODEL
  ) {
    return null;
  }
  const mapInfo = boundedSpatialMapInfo(observation?.mapInfo);
  const ownShape = boundedSpatialOwnShape(spatial.ownShape);
  const ownPlayerID = observation?.ownState?.playerID;
  const rivals = boundedSpatialV3Rivals(
    observation?.visiblePlayers,
    ownPlayerID,
    false,
    mapInfo ? mapInfo.width * mapInfo.height : null,
  );
  if (
    !mapInfo ||
    !ownShape ||
    !rivals ||
    !isBoundedVisibleString(ownPlayerID, 200)
  ) {
    return null;
  }
  const allowedPlayerIDs = new Set([
    ownPlayerID,
    ...rivals.map((rival) => rival.playerID),
  ]);
  if (
    allowedPlayerIDs.size !== rivals.length + 1 ||
    rivals.some((rival) =>
      (rival.bordersWith ?? []).some(
        (edge) => !allowedPlayerIDs.has(edge.playerID),
      ),
    )
  ) {
    return null;
  }
  const positionedAssets = boundedPositionedAssets(
    spatial.positionedAssets,
    mapInfo,
    allowedPlayerIDs,
  );
  if (!positionedAssets) return null;
  const minimap = boundedMinimapV1(
    spatial.minimap,
    allowedPlayerIDs,
    ownPlayerID,
  );
  const bounded = {
    schemaVersion: 3,
    visibilityModel: SPATIAL_VISIBILITY_MODEL,
    mapInfo,
    ownShape,
    rivals,
    positionedAssets,
  };
  const stageOne = {
    mapInfo,
    spatial: {
      schemaVersion: 3,
      visibilityModel: SPATIAL_VISIBILITY_MODEL,
      ownShape,
      positionedAssets,
    },
    visiblePlayers: rivals,
  };
  if (!isWithinOwnerSpatialSerializationCeiling(stageOne)) return null;
  return minimap ? { ...bounded, minimap } : bounded;
}

/**
 * Complete rich spatial L1-L5 contract. L4 weighted/naval exposure is required
 * on every rival. The L5 minimap remains an optional child capability and is
 * admitted only as a complete schema-2 object within its own byte ceiling.
 */
export function boundedSpatialV5(observation) {
  const spatial = observation?.spatial;
  if (
    spatial?.schemaVersion !== 5 ||
    spatial.visibilityModel !== SPATIAL_VISIBILITY_MODEL
  ) {
    return null;
  }
  const mapInfo = boundedSpatialMapInfo(observation?.mapInfo);
  const ownShape = boundedSpatialOwnShape(spatial.ownShape, true);
  const ownPlayerID = observation?.ownState?.playerID;
  const rivals = boundedSpatialV3Rivals(
    observation?.visiblePlayers,
    ownPlayerID,
    true,
    mapInfo ? mapInfo.width * mapInfo.height : null,
  );
  if (
    !mapInfo ||
    !ownShape ||
    !rivals ||
    !isBoundedVisibleString(ownPlayerID, 200)
  ) {
    return null;
  }
  const allowedPlayerIDs = new Set([
    ownPlayerID,
    ...rivals.map((rival) => rival.playerID),
  ]);
  if (
    allowedPlayerIDs.size !== rivals.length + 1 ||
    ownShape.largestNeighborBorderShare !==
      Math.max(
        0,
        ...rivals.map((rival) => rival.borderWithYou?.shareOfYourBorder ?? 0),
      ) ||
    rivals.some((rival) =>
      rival.bordersWith.some((edge) => !allowedPlayerIDs.has(edge.playerID)),
    ) ||
    rivals.some((rival) =>
      rival.bordersWith.some((edge) => {
        const neighbor = rivals.find(
          (candidate) => candidate.playerID === edge.playerID,
        );
        return !neighbor?.bordersWith.some(
          (reverse) => reverse.playerID === rival.playerID,
        );
      }),
    )
  ) {
    return null;
  }
  const positionedAssets = boundedPositionedAssets(
    spatial.positionedAssets,
    mapInfo,
    allowedPlayerIDs,
  );
  if (!positionedAssets) return null;
  const minimap = boundedMinimapV2(
    spatial.minimap,
    allowedPlayerIDs,
    ownPlayerID,
    mapInfo,
    positionedAssets.structuresTotal + positionedAssets.warshipsTotal,
  );
  const bounded = {
    schemaVersion: 5,
    visibilityModel: SPATIAL_VISIBILITY_MODEL,
    mapInfo,
    ownShape,
    rivals,
    positionedAssets,
  };
  const stageOne = {
    mapInfo,
    spatial: {
      schemaVersion: 5,
      visibilityModel: SPATIAL_VISIBILITY_MODEL,
      ownShape,
      positionedAssets,
    },
    visiblePlayers: rivals,
  };
  if (!isWithinOwnerSpatialSerializationCeiling(stageOne)) return null;
  return minimap ? { ...bounded, minimap } : bounded;
}

/** Backward-compatible feature detection for the public starter. */
export function boundedSpatialObservation(observation) {
  if (observation?.spatial?.schemaVersion === 5) {
    return boundedSpatialV5(observation);
  }
  if (observation?.spatial?.schemaVersion === 3) {
    return boundedSpatialV3(observation);
  }
  if (observation?.spatial?.schemaVersion === 1) {
    return boundedSpatialV1(observation);
  }
  return null;
}

/**
 * Stable ranking of the caller's already-offered actions. With spatial absent
 * or unusable it returns the original order. With a supported bounded schema
 * it can change only which existing action object comes first; it cannot
 * create an id or intent.
 */
export function rankOfferedActionsWithSpatial(actions, observation) {
  if (!Array.isArray(actions)) return [];
  const spatial = boundedSpatialObservation(observation);
  if (!spatial) return [...actions];

  const glyphByPlayer = new Map(
    (spatial.minimap?.legend ?? []).map((entry) => [
      entry.playerID,
      entry.glyph,
    ]),
  );
  const glyphArea = new Map();
  for (const row of spatial.minimap?.ownershipRows ??
    spatial.minimap?.rows ??
    []) {
    for (const glyph of row) {
      glyphArea.set(glyph, (glyphArea.get(glyph) ?? 0) + 1);
    }
  }
  const rivalByID = new Map(
    spatial.rivals.map((rival) => [rival.playerID, rival]),
  );
  const positionedPressureByPlayer = new Map();
  for (const asset of [
    ...(spatial.positionedAssets?.structures ?? []),
    ...(spatial.positionedAssets?.warships ?? []),
  ]) {
    positionedPressureByPlayer.set(
      asset.ownerPlayerID,
      (positionedPressureByPlayer.get(asset.ownerPlayerID) ?? 0) +
        (asset.type === "Warship" ? 4 : 1),
    );
  }

  return actions
    .map((action, index) => {
      const targetID = action?.metadata?.targetID;
      const rival = rivalByID.get(targetID);
      const glyph = glyphByPlayer.get(targetID);
      const score = rival
        ? (rival.distanceClass === "adjacent"
            ? 40
            : rival.distanceClass === "near"
              ? 12
              : 0) +
          (rival.borderWithYou?.shareOfYourBorder ?? 0) +
          (rival.borderWithYou?.underAttackHere ? 30 : 0) +
          (glyphArea.get(glyph) ?? 0) / 12 +
          (rival.borderWithYou?.defensePostFrontCoverage?.uncovered ?? 0) / 4 +
          ((rival.borderWithYou?.terrainBreakdown?.plains ?? 0) -
            (rival.borderWithYou?.terrainBreakdown?.mountain ?? 0)) /
            4 +
          (rival.navalExposure?.transportReachableOwnShoreTiles ?? 0) / 8 +
          (positionedPressureByPlayer.get(targetID) ?? 0)
        : 0;
      return { action, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.action);
}
