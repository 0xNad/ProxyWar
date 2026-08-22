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
export const OWNER_MINIMAP_SERIALIZED_MAX_BYTES = 2 * 1024;
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
      !isStrictOpaqueID(terms.targetPlayerID) ||
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

function boundedDealProposal(proposal) {
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
    !isStrictOpaqueID(proposal.dealID) ||
    !isStrictOpaqueID(proposal.proposerPlayerID) ||
    !isBoundedName(proposal.proposerName) ||
    !isStrictOpaqueID(proposal.recipientPlayerID) ||
    !isBoundedName(proposal.recipientName) ||
    proposal.proposerPlayerID === proposal.recipientPlayerID ||
    !isNonnegativeSafeInteger(proposal.proposedAtStep) ||
    !isNonnegativeSafeInteger(proposal.answerableThroughStep) ||
    proposal.answerableThroughStep < proposal.proposedAtStep
  ) {
    return null;
  }
  const terms = boundedDealTerms(proposal.terms);
  return terms === null
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
    !isStrictOpaqueID(obligation.obligorPlayerID) ||
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
      !isStrictOpaqueID(obligation.targetPlayerID) ||
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

function boundedActiveDeal(deal) {
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
    !isStrictOpaqueID(deal.dealID) ||
    !DEAL_TEMPLATES.has(deal.template) ||
    !isStrictOpaqueID(deal.proposerPlayerID) ||
    !isBoundedName(deal.proposerName) ||
    !isStrictOpaqueID(deal.recipientPlayerID) ||
    !isBoundedName(deal.recipientName) ||
    deal.proposerPlayerID === deal.recipientPlayerID ||
    !isNonnegativeSafeInteger(deal.activeFromStep) ||
    !isNonnegativeSafeInteger(deal.expiresAfterStep) ||
    deal.expiresAfterStep < deal.activeFromStep ||
    !isNonnegativeSafeInteger(deal.stepsRemaining) ||
    deal.stepsRemaining > deal.expiresAfterStep - deal.activeFromStep + 1 ||
    !isBoundedRecordArray(deal.obligations, MAX_DEAL_OBSERVATION_ROWS)
  ) {
    return null;
  }
  const expected = DEAL_OBLIGATION_SHAPE.get(deal.template);
  if (deal.obligations.length !== expected.count) return null;
  const obligations = deal.obligations.map(boundedDealObligation);
  if (
    obligations.some((obligation) => obligation === null) ||
    obligations.some((obligation) => obligation.kind !== expected.kind)
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
    !isStrictOpaqueID(option.recipientPlayerID) ||
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
    !isStrictOpaqueID(reliability.playerID) ||
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
  return Number.isInteger(value) && value > 0
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

export function boundedDealsObservation(deals) {
  if (
    !hasExactKeys(deals, [
      "decisionStep",
      "incomingProposals",
      "outgoingProposals",
      "activeDeals",
      "proposalOptions",
      "rivalReliability",
    ]) ||
    !Number.isSafeInteger(deals.decisionStep) ||
    deals.decisionStep < 0
  ) {
    return null;
  }
  const normalizers = {
    incomingProposals: boundedDealProposal,
    outgoingProposals: boundedDealProposal,
    activeDeals: boundedActiveDeal,
    proposalOptions: boundedProposalOption,
    rivalReliability: boundedRivalReliability,
  };
  const bounded = { decisionStep: deals.decisionStep };
  for (const [field, normalize] of Object.entries(normalizers)) {
    if (!isBoundedRecordArray(deals[field], MAX_DEAL_OBSERVATION_ROWS)) {
      return null;
    }
    const rows = deals[field].map(normalize);
    if (rows.some((row) => row === null)) return null;
    bounded[field] = rows;
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
    const key = `${option.recipientPlayerID}\u0000${option.terms.template}`;
    if (optionKeys.has(key)) return null;
    optionKeys.add(key);
  }
  const reliabilityPlayerIDs = new Set();
  for (const entry of bounded.rivalReliability) {
    if (reliabilityPlayerIDs.has(entry.playerID)) return null;
    reliabilityPlayerIDs.add(entry.playerID);
  }
  return bounded;
}

export function boundedInboundMessages(observation) {
  const inbound = observation?.nonCombat?.inboundMessages;
  if (!Array.isArray(inbound) || inbound.length > 8) return null;
  for (const entry of inbound) {
    if (
      !isRecord(entry) ||
      !isBoundedVisibleString(entry.senderID, 200) ||
      !isBoundedVisibleString(entry.senderName, 120, true) ||
      !Number.isSafeInteger(entry.turnNumber) ||
      entry.turnNumber < 0 ||
      !isSafeAgentMessageText(entry.text, OWNER_MESSAGE_MAX_CHARS)
    ) {
      return null;
    }
  }
  return inbound;
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
  const deals = boundedDealsObservation(rawDeals);
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
      record("spatial_observation", {
        ...base,
        present: spatial !== null,
        ...(spatial
          ? {
              schemaVersion: spatial.schemaVersion,
              visibilityModel: spatial.visibilityModel,
              minimapPresent: spatial.minimap !== undefined,
              serializedUTF8Bytes: new TextEncoder().encode(
                JSON.stringify(spatial),
              ).byteLength,
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
  if (boundedDealsObservation(observation?.deals) === null) return {};
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
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
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

function boundedMinimap(minimap, allowedPlayerIDs, ownPlayerID) {
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

function boundedSpatialOwnShape(ownShape) {
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
    centroid: {
      xPct: ownShape.centroid.xPct,
      yPct: ownShape.centroid.yPct,
    },
  };
}

function boundedSpatialV3Rivals(visiblePlayers) {
  if (!Array.isArray(visiblePlayers) || visiblePlayers.length > 64) return null;
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
  for (const player of visiblePlayers) {
    if (!isBoundedVisibleString(player?.playerID, 200)) return null;
    let borderWithYou;
    if (player.borderWithYou !== undefined) {
      const border = player.borderWithYou;
      const terrain = border?.terrainBreakdown;
      const coverage = border?.defensePostFrontCoverage;
      if (
        !isRecord(border) ||
        boundedNonnegativeInteger(border.tiles) === null ||
        boundedPercent(border.shareOfYourBorder) === null ||
        !["land", "coastal", "mixed"].includes(border.terrain) ||
        boundedNonnegativeInteger(border.defensePostsCovering) === null ||
        typeof border.underAttackHere !== "boolean" ||
        !isRecord(terrain) ||
        boundedNonnegativeInteger(terrain.plains) === null ||
        boundedNonnegativeInteger(terrain.highland) === null ||
        boundedNonnegativeInteger(terrain.mountain) === null ||
        boundedNonnegativeInteger(terrain.shore) === null ||
        terrain.plains + terrain.highland + terrain.mountain !== border.tiles ||
        terrain.shore > border.tiles ||
        !isRecord(coverage) ||
        boundedNonnegativeInteger(coverage.covered) === null ||
        boundedNonnegativeInteger(coverage.uncovered) === null ||
        coverage.covered + coverage.uncovered !== border.tiles
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
  const minimap = boundedMinimap(
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
  const rivals = boundedSpatialV3Rivals(observation?.visiblePlayers);
  const ownPlayerID = observation?.ownState?.playerID;
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
  const minimap = boundedMinimap(
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
    ...(minimap ? { minimap } : {}),
  };
  return isWithinOwnerSpatialSerializationCeiling(bounded) ? bounded : null;
}

/** Backward-compatible feature detection for the public starter. */
export function boundedSpatialObservation(observation) {
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
  for (const row of spatial.minimap?.rows ?? []) {
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
          (positionedPressureByPlayer.get(targetID) ?? 0)
        : 0;
      return { action, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.action);
}
