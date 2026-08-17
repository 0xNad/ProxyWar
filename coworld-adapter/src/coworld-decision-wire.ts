/**
 * Pure wire logic for the Coworld player protocol's decision exchange —
 * extracted from no-docker-coworld-episode.ts (whose top-level `await main()`
 * and runtime `ws` require make it un-importable by tests).
 *
 * Envelope (game -> player):
 *   { type: "decision_request", requestID, slot,
 *     protocol: { maxActionsPerDecision, maxSpawnPreferences,
 *                 maxMessageChars? }, request }
 * `protocol` is the capability advertisement for the OPTIONAL action batch,
 * the independent spawn-only preference ballot, and the comms slot:
 * emitters must send `selectedLegalActionIds` ONLY when it is present, so a
 * new player against an old image degrades to primary-only instead of relying
 * on the old parser's tolerance. The inner `request` payload is untouched.
 *
 * Reply (player -> game):
 *   selectedLegalActionId  — REQUIRED scalar primary (unchanged contract)
 *   selectedLegalActionIds — OPTIONAL batch; normalized here to scalar-first,
 *     deduped, capped, each id trimmed and length-bounded
 *   spawnPreferenceLegalActionIds — OPTIONAL spawn-only ballot, forwarded as
 *     spawnPreferenceActionIDs with malformed/overflow evidence preserved for
 *     whole-ballot backend rejection
 *   selectedDealActionId   — deal side channel (unchanged)
 *   selectedMessageActionId + messageText — OPTIONAL comms slot, forwarded as
 *     the messageActionID/messageText PAIR the league's AgentDecision declares
 *
 * Bounds-only discipline: menu membership is deliberately NOT checked here.
 * The league runner's decision validator is the recording authority — dropping
 * ids at the adapter would hide rejections from batchRejectedActionIDs.
 */

/**
 * Mirror of src/server/agents/AgentWireProtocol.ts's
 * MAX_WIRE_ACTIONS_PER_DECISION. A literal, not an import: the deployed image
 * copies coworld-adapter to /app/integration with the engine at /app/proxywar,
 * so a static value-import from src/ would break at runtime. The parity test
 * beside this file pins the two constants to each other.
 */
export const MAX_WIRE_ACTIONS_PER_DECISION = 5;

/**
 * Mirror of AgentWireProtocol.MAX_SPAWN_PREFERENCE_ACTION_IDS. This is
 * deliberately independent from executable action batching.
 */
export const MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS = 16;

/**
 * Per-id length bound, matching the existing selectedDealActionId discipline:
 * a real action id is ~60 chars, and every id here can land in
 * decisions.jsonl (batchActionIDs / batchRejectedActionIDs / validator
 * reasons) — unbounded agent-controlled text per decision is the long-episode
 * memory class the 0.1.19 work closed.
 */
export const MAX_WIRE_ACTION_ID_LENGTH = 200;

/**
 * Transport bound for the comms body. DELIBERATELY far above
 * AgentTunables.FREETEXT_MESSAGE_MAX_CHARS (280), and the parity test beside
 * this file pins that inequality — it is the whole reason this number is safe.
 *
 * The validator REJECTS over-cap text rather than truncating it, because "a
 * trimmed promise is a different promise". If this transport clamped to the
 * cap instead, a 300-char message would arrive as a 280-char message the
 * validator then ACCEPTS — silently rewriting an agent's words and stamping
 * the rewrite into `commsSlotText` as verbatim negotiation evidence. That is
 * the exact failure the reject-don't-rewrite contract exists to prevent, and
 * it would be introduced HERE, one layer below the code that forbids it.
 *
 * So the bound sits high enough that every text the validator could possibly
 * accept passes through byte-identically. Note the validator collapses
 * whitespace BEFORE measuring, so a legitimately-accepted message can be much
 * longer raw than 280; the headroom covers pretty-printed bodies rather than
 * assuming that policies emit tight text.
 */
export const MAX_WIRE_MESSAGE_TEXT_LENGTH = 4000;

/**
 * Stand-in for a body that overflows the transport bound. Not a truncation:
 * slicing an overlong body could yield text that collapses UNDER the cap and
 * is then accepted as a shorter message the agent never wrote. This sentinel
 * is exactly MAX_WIRE_MESSAGE_TEXT_LENGTH non-whitespace characters, so it
 * cannot collapse below its own length and is therefore guaranteed to fail the
 * validator's cap check (the parity test pins bound > cap).
 *
 * The paired id still rides along, so the attempt is recorded as a normal
 * rejection in `commsSlotRequestedID`/`commsSlotRejected` instead of vanishing
 * — the same "preserve an explicit invalid sentinel" discipline the spawn
 * ballot uses, and the reason this is not the silent adapter-side drop the
 * header warns about.
 */
const OVERSIZE_MESSAGE_TEXT_SENTINEL = "x".repeat(MAX_WIRE_MESSAGE_TEXT_LENGTH);

export interface NormalizedDecisionResponse {
  actionID: string;
  actionIDs?: string[];
  /**
   * Untrusted wire shape carried verbatim enough for the backend's runtime
   * whole-ballot validator. It may deliberately be null or contain non-string
   * entries as bounded evidence of a malformed authored ballot.
   */
  spawnPreferenceActionIDs?: unknown;
  dealActionID?: string;
  /**
   * Comms slot, named to match the AgentDecision fields the league reads
   * (AgentTypes.messageActionID / messageText). Present only as a PAIR — see
   * normalizeDecisionResponse.
   */
  messageActionID?: string;
  messageText?: string;
  reason: string;
}

export interface DecisionResponseNormalizationContext {
  /** True only when the pending request offered a non-empty all-spawn menu. */
  allSpawnMenu?: boolean;
}

export function decisionRequestEnvelope(input: {
  requestID: string;
  slot: number;
  request: unknown;
  /**
   * The live FREETEXT_MESSAGE_MAX_CHARS, supplied by the caller ONLY while the
   * free-text flag is on. Injected rather than imported on purpose: this module
   * is copied to /app/integration while the engine lives at /app/proxywar, so a
   * static import of AgentTunables would break at image runtime — and reading
   * the env var here instead would fork the flag's meaning into a second place.
   * Omitted (flag off) keeps the envelope byte-identical to shipped behavior.
   */
  maxMessageChars?: number;
}): Record<string, unknown> {
  const maxMessageChars =
    typeof input.maxMessageChars === "number" &&
    Number.isFinite(input.maxMessageChars) &&
    input.maxMessageChars > 0
      ? Math.floor(input.maxMessageChars)
      : undefined;
  return {
    type: "decision_request",
    requestID: input.requestID,
    slot: input.slot,
    protocol: {
      maxActionsPerDecision: MAX_WIRE_ACTIONS_PER_DECISION,
      maxSpawnPreferences: MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
      // Advertised only when the feature is actually on, so a policy can
      // detect the capability instead of guessing, and an old image simply
      // never advertises it.
      ...(maxMessageChars !== undefined ? { maxMessageChars } : {}),
    },
    request: input.request,
  };
}

export function normalizeDecisionResponse(
  message: Record<string, unknown>,
  context: DecisionResponseNormalizationContext = {},
): NormalizedDecisionResponse {
  // Scalar cap included: previously unbounded, and it flows into the same
  // decisions.jsonl surfaces as the batch ids. A >200-char string can never
  // be a legal id, so this only bounds what a hostile/buggy seat can stamp.
  const actionID = String(message.selectedLegalActionId ?? "")
    .trim()
    .slice(0, MAX_WIRE_ACTION_ID_LENGTH);

  const executableBatchOnSpawnMenu =
    context.allSpawnMenu === true &&
    message.selectedLegalActionIds !== undefined;
  let actionIDs: string[] | undefined;
  if (
    !executableBatchOnSpawnMenu &&
    Array.isArray(message.selectedLegalActionIds)
  ) {
    const normalized: string[] = [];
    // Stops once the cap is held: an inbound frame may carry thousands of
    // agent-controlled ids, and every extra one would cost a full linear
    // `includes` scan. Ids past the cap can never survive it, so the early
    // exit changes no output.
    const push = (value: string): boolean => {
      const id = value.trim().slice(0, MAX_WIRE_ACTION_ID_LENGTH);
      if (id.length > 0 && !normalized.includes(id)) {
        normalized.push(id);
      }
      return normalized.length < MAX_WIRE_ACTIONS_PER_DECISION;
    };
    const hasRoom = actionID.length === 0 || push(actionID);
    if (hasRoom) {
      for (const entry of message.selectedLegalActionIds) {
        if (typeof entry === "string" && !push(entry)) {
          break;
        }
      }
    }
    const capped = normalized.slice(0, MAX_WIRE_ACTIONS_PER_DECISION);
    // A one-element batch IS the scalar: omit it so single-action replies
    // resolve byte-identically to a reply that never sent the key.
    actionIDs = capped.length >= 2 ? capped : undefined;
  }

  let spawnPreferenceActionIDs: unknown;
  if (executableBatchOnSpawnMenu) {
    // Executable batching has no meaning during the one-spawn allocation
    // ballot. Preserve an explicit invalid sentinel so backend validation
    // defaults the whole ballot; never silently reinterpret the response as a
    // valid scalar-only or ranked spawn reply.
    spawnPreferenceActionIDs = null;
  } else if (message.spawnPreferenceLegalActionIds !== undefined) {
    const raw = message.spawnPreferenceLegalActionIds;
    if (!Array.isArray(raw)) {
      // Presence matters: omitting this would silently reinterpret a malformed
      // explicit ballot as a valid legacy scalar-only reply. A bounded null
      // sentinel preserves the non-array shape for the backend's specific
      // whole-ballot rejection without retaining arbitrary agent data.
      spawnPreferenceActionIDs = null;
    } else {
      // Retain at most cap+1 entries: the extra entry proves overflow without
      // walking or retaining an unbounded agent-controlled array. Do not trim,
      // dedupe, prepend the scalar, or truncate overlong ids into potentially
      // valid offered ids; overlong strings become an empty sentinel while
      // bounded non-string types remain visible to backend validation.
      spawnPreferenceActionIDs = raw
        .slice(0, MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS + 1)
        .map((entry) =>
          typeof entry === "string" && entry.length > MAX_WIRE_ACTION_ID_LENGTH
            ? ""
            : entry,
        );
    }
  }

  // Optional second selection (the diplomacy slot). Forwarded only when the
  // player actually sent a non-empty string; the league runner's
  // AgentDecisionValidator is the sole authority on whether it is a legal
  // deal action id.
  const dealActionID =
    typeof message.selectedDealActionId === "string" &&
    message.selectedDealActionId.trim().length > 0
      ? message.selectedDealActionId.trim().slice(0, MAX_WIRE_ACTION_ID_LENGTH)
      : undefined;

  // Optional third selection (the comms slot). Forwarded as a PAIR or not at
  // all, mirroring LlmDecisionParser.parsedMessageSlot: an id must never reach
  // the validator without the body it has to be judged with. This is a SHAPE
  // gate, not a menu gate — whether the id is a currently-offered `message:`
  // action remains AgentDecisionValidator's call alone, as does the 280-char
  // cap and the control/bidi/zero-width contract.
  const messageActionIDRaw = message.selectedMessageActionId;
  const messageTextRaw = message.messageText;
  let messageActionID: string | undefined;
  let messageText: string | undefined;
  if (
    typeof messageActionIDRaw === "string" &&
    typeof messageTextRaw === "string"
  ) {
    const trimmedID = messageActionIDRaw
      .trim()
      .slice(0, MAX_WIRE_ACTION_ID_LENGTH);
    if (trimmedID.length > 0 && messageTextRaw.trim().length > 0) {
      messageActionID = trimmedID;
      // The body rides UNTRIMMED past the emptiness guard above. The validator
      // owns normalization (it collapses whitespace, then measures); doing it
      // here too is how the delivered text and the stamped `commsSlotText`
      // evidence drift apart.
      messageText =
        messageTextRaw.length > MAX_WIRE_MESSAGE_TEXT_LENGTH
          ? OVERSIZE_MESSAGE_TEXT_SENTINEL
          : messageTextRaw;
    }
  }

  return {
    actionID,
    ...(actionIDs !== undefined ? { actionIDs } : {}),
    ...(spawnPreferenceActionIDs !== undefined
      ? { spawnPreferenceActionIDs }
      : {}),
    ...(dealActionID !== undefined ? { dealActionID } : {}),
    ...(messageActionID !== undefined && messageText !== undefined
      ? { messageActionID, messageText }
      : {}),
    reason:
      typeof message.reason === "string"
        ? message.reason.slice(0, 500)
        : "Coworld player returned no reason.",
  };
}

/**
 * The AgentDecision the league runner actually receives from a Coworld seat:
 * the normalized wire selection PLUS the episode-local metadata envelope.
 *
 * Deliberately `NormalizedDecisionResponse & { metadata }` rather than a
 * re-listed field set. Re-listing is exactly how the comms slot was lost once
 * already — a decision field that is normalized but not composed is a field
 * the league never sees.
 */
export interface ComposedCoworldDecision extends NormalizedDecisionResponse {
  metadata: Record<string, unknown>;
}

/**
 * Composes the resolved decision from the normalized selection and the
 * episode-local facts the socket handler owns (slot, requestID, offered menu
 * size, raw frame).
 *
 * Extracted from no-docker-coworld-episode.ts so it is TESTABLE: that file
 * ends in a top-level `await main()` and requires `ws` at import time, so no
 * test can import it, and the composition — the last hop before
 * AgentLeagueMatch — was previously only ever reconstructed by hand in a test.
 * A reconstruction cannot catch the real spread being replaced by explicit
 * field picking, which is the drift class this guards.
 *
 * Pure: no I/O, no clock, no module state.
 */
export function composeCoworldDecision(input: {
  normalized: NormalizedDecisionResponse;
  /** The raw decision_response frame, for player-reported degradation flags. */
  message: Record<string, unknown>;
  slot: number;
  requestID: string;
  offeredLegalActionCount: number;
}): ComposedCoworldDecision {
  const { normalized, message, slot, requestID, offeredLegalActionCount } =
    input;
  return {
    ...normalized,
    metadata: {
      brain: "coworld-websocket",
      externalActionCall: true,
      parseSuccess: true,
      // Degradation flags come from the player on the wire — never assume
      // health. A policy whose brain failed must show up in fallback_count
      // and replays (the v1 bedrock seat failed silently for 60+ rounds
      // because this was hardcoded false).
      fallbackUsed: message.fallbackUsed === true,
      ...(message.llmPlannerDegraded === true
        ? { llmPlannerDegraded: true }
        : {}),
      coworldSlot: slot,
      coworldRequestID: requestID,
      rawProviderOutputPresent: true,
      externalRawOutput: JSON.stringify(message).slice(0, 1000),
      offeredLegalActionCount,
      confidence:
        typeof message.confidence === "number" ? message.confidence : undefined,
    },
  };
}
