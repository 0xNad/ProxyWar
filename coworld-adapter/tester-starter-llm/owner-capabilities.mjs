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
const DEAL_ARRAY_FIELDS = [
  "incomingProposals",
  "outgoingProposals",
  "activeDeals",
  "proposalOptions",
  "rivalReliability",
];

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
    !isRecord(deals) ||
    !Number.isSafeInteger(deals.decisionStep) ||
    deals.decisionStep < 0
  ) {
    return null;
  }
  for (const field of DEAL_ARRAY_FIELDS) {
    if (!isBoundedRecordArray(deals[field], 64)) return null;
  }
  for (const deal of deals.activeDeals) {
    if (!isBoundedRecordArray(deal.obligations, 64)) return null;
  }
  return deals;
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
      const spatial = boundedSpatialV1(observation);
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

function boundedMinimap(minimap) {
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
      typeof entry?.isYou !== "boolean" ||
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
  return bounded;
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

  const minimap = boundedMinimap(spatial.minimap);
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
 * Stable ranking of the caller's already-offered actions. With spatial absent
 * or unusable it returns the original order. With v1 present it can change only
 * which existing action object comes first; it cannot create an id or intent.
 */
export function rankOfferedActionsWithSpatial(actions, observation) {
  if (!Array.isArray(actions)) return [];
  const spatial = boundedSpatialV1(observation);
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
          (glyphArea.get(glyph) ?? 0) / 12
        : 0;
      return { action, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.action);
}
