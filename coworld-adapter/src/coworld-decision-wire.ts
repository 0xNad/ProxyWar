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
 *   selectedDealActionId   — OPTIONAL deal side channel, forwarded raw when
 *     bounded and as an explicit invalid sentinel when malformed/overlong
 *   selectedMessageActionId + messageText — OPTIONAL comms slot, forwarded as
 *     the messageActionID/messageText fields the league's AgentDecision declares;
 *     raw bounded strings (including blank/control-only strings) survive so
 *     the backend validator records the rejection
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
 * Runtime-safe mirror of AgentTypes.agentRuntimeModes. The deployed adapter
 * cannot value-import from src/ (integration and engine have different image
 * roots), so the parity test pins this finite vocabulary to the canonical one.
 */
export const COWORLD_AGENT_RUNTIME_MODES = [
  "local-policy-baseline",
  "mock-policy-planner",
  "llm-policy-planner",
  "llm-action-selector",
  "autopilot-executor",
] as const;

export type CoworldAgentRuntimeMode =
  (typeof COWORLD_AGENT_RUNTIME_MODES)[number];

/** Strict equality only; unrecognized/self-invented attribution is unknown. */
export function normalizeRuntimeMode(
  value: unknown,
): CoworldAgentRuntimeMode | undefined {
  return COWORLD_AGENT_RUNTIME_MODES.find((mode) => mode === value);
}

/**
 * Mirror of the SELF-REPORTED half of `AGENT_DEGRADATION_CAUSES`
 * (src/server/agents/AgentWireProtocol.ts). Duplicated as a literal for the same
 * reason the action cap is: the deployed player image cannot value-import from
 * src/ at runtime. `coworld-decision-wire.test.ts` pins this list against the
 * server's, so drift fails a test rather than silently dropping a cause the
 * league is emitting.
 *
 * The `brain-*` causes are deliberately absent from this player-accepted set.
 * They are the server's own observations, and a policy able to send them could
 * forge provenance - a seat that answered fine could stamp itself
 * `brain-timeout` and the artifact would read as though the server never heard
 * from it. The separate server set below is used only for trusted records.
 */
const SELF_REPORTED_DEGRADATION_CAUSES: ReadonlySet<string> = new Set([
  "plan-warmup",
  "plan-stale",
  "plan-unavailable",
  "plan-timeout",
  "plan-parse",
  "plan-rejected",
  "policy-error",
]);

const SERVER_REPORTED_DEGRADATION_CAUSES: ReadonlySet<string> = new Set([
  "brain-timeout",
  "brain-error",
]);

/**
 * Strict equality parse for a degradation cause already present on a trusted
 * decision record. Unlike the player-frame parser below, this accepts the
 * server-observed causes that AgentLeagueMatch stamps itself.
 */
export function normalizeRecordedDegradationCause(
  value: unknown,
): string | undefined {
  return typeof value === "string" &&
    (SELF_REPORTED_DEGRADATION_CAUSES.has(value) ||
      SERVER_REPORTED_DEGRADATION_CAUSES.has(value))
    ? value
    : undefined;
}

/**
 * Strict equality parse of an untrusted `degradedCause`, restricted to the
 * self-reported family. No trimming, no case folding: a policy that sends an
 * almost-right value has told us nothing, and `undefined` (we do not know) is the
 * honest record.
 */
export function normalizeDegradedCause(value: unknown): string | undefined {
  const cause = normalizeRecordedDegradationCause(value);
  return cause !== undefined && SELF_REPORTED_DEGRADATION_CAUSES.has(cause)
    ? cause
    : undefined;
}

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
 * accept passes through byte-identically. The validator measures the exact raw
 * quote and rejects rather than normalizes unsafe layout or excess length.
 */
export const MAX_WIRE_MESSAGE_TEXT_LENGTH = 4000;

/**
 * Stand-in for a body that overflows the transport bound. Not a truncation:
 * slicing an overlong body could yield a shorter message the agent never wrote.
 * This sentinel is exactly MAX_WIRE_MESSAGE_TEXT_LENGTH characters and is
 * therefore guaranteed to fail the validator's exact raw-length cap (the
 * parity test pins transport bound > validator cap).
 *
 * Any independently present id still rides along, so the attempt is recorded
 * as a rejection instead of vanishing — the same "preserve an explicit invalid
 * sentinel" discipline the spawn ballot uses, and the reason this is not the
 * silent adapter-side drop the header warns about.
 */
const OVERSIZE_MESSAGE_TEXT_SENTINEL = "x".repeat(MAX_WIRE_MESSAGE_TEXT_LENGTH);

/**
 * Existing wire convention for an authored action-id attempt whose original
 * value cannot safely be retained. Empty is bounded and cannot equal a legal
 * offered id, so exact backend lookup must reject it. This is deliberately not
 * an overlong prefix: truncation could turn an invalid id into a valid one.
 */
const INVALID_WIRE_ACTION_ID_SENTINEL = "";

/** Bounded invalid witness for a non-string comms field that would vanish. */
const INVALID_WIRE_MESSAGE_TEXT_SENTINEL = "";

export interface NormalizedDecisionResponse {
  actionID: string;
  actionIDs?: string[];
  /**
   * Untrusted wire shape carried verbatim enough for the backend's runtime
   * whole-ballot validator. It may deliberately be null or contain non-string
   * entries as bounded evidence of a malformed authored ballot.
   */
  spawnPreferenceActionIDs?: unknown;
  /** Present whenever the wire carried selectedDealActionId, even malformed. */
  dealActionID?: string;
  /**
   * Comms slot, named to match the AgentDecision fields the league reads
   * (AgentTypes.messageActionID / messageText). Fields are forwarded
   * independently so the backend validator can distinguish id-only from
   * text-only attempts. A bounded invalid sentinel is used only when every
   * present value would otherwise disappear.
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

  // Optional second selection (the diplomacy slot). Presence is authoritative:
  // a bounded string rides verbatim (including whitespace), while a malformed
  // or overlong value becomes an explicit invalid sentinel. Never trim or
  // truncate: either could turn a rejected attempt into an offered id.
  const dealActionID = Object.hasOwn(message, "selectedDealActionId")
    ? typeof message.selectedDealActionId === "string" &&
      message.selectedDealActionId.length <= MAX_WIRE_ACTION_ID_LENGTH
      ? message.selectedDealActionId
      : INVALID_WIRE_ACTION_ID_SENTINEL
    : undefined;

  // Optional third selection (the comms slot). Forward the two authored fields
  // independently so id-only and text-only attempts retain their truthful
  // backend rejection. Raw bounded strings — including padded ids and
  // blank/control-only bodies — stay raw. An overlong id always becomes the
  // explicit invalid-id sentinel. A non-string value is omitted when the
  // other authored string already preserves the attempt; only when every
  // present value would otherwise vanish do we retain one invalid sentinel.
  // This is a bounds/shape gate only, never a menu-membership authority.
  const messageActionIDRaw = message.selectedMessageActionId;
  const messageTextRaw = message.messageText;
  const messageActionIDPresent = Object.hasOwn(
    message,
    "selectedMessageActionId",
  );
  const messageTextPresent = Object.hasOwn(message, "messageText");
  let messageActionID: string | undefined;
  let messageText: string | undefined;
  if (messageActionIDPresent && typeof messageActionIDRaw === "string") {
    messageActionID =
      messageActionIDRaw.length <= MAX_WIRE_ACTION_ID_LENGTH
        ? messageActionIDRaw
        : INVALID_WIRE_ACTION_ID_SENTINEL;
  }
  if (messageTextPresent && typeof messageTextRaw === "string") {
    messageText =
      messageTextRaw.length > MAX_WIRE_MESSAGE_TEXT_LENGTH
        ? OVERSIZE_MESSAGE_TEXT_SENTINEL
        : messageTextRaw;
  }
  if (
    messageActionID === undefined &&
    messageText === undefined &&
    (messageActionIDPresent || messageTextPresent)
  ) {
    if (messageActionIDPresent) {
      messageActionID = INVALID_WIRE_ACTION_ID_SENTINEL;
    } else {
      messageText = INVALID_WIRE_MESSAGE_TEXT_SENTINEL;
    }
  }

  return {
    actionID,
    ...(actionIDs !== undefined ? { actionIDs } : {}),
    ...(spawnPreferenceActionIDs !== undefined
      ? { spawnPreferenceActionIDs }
      : {}),
    ...(dealActionID !== undefined ? { dealActionID } : {}),
    ...(messageActionID !== undefined ? { messageActionID } : {}),
    ...(messageText !== undefined ? { messageText } : {}),
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
  const runtimeMode = normalizeRuntimeMode(message.runtimeMode);
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
      ...(runtimeMode !== undefined ? { runtimeMode } : {}),
      ...(message.llmPlannerDegraded === true
        ? { llmPlannerDegraded: true }
        : {}),
      // WHY it degraded, when the policy chose to say. Optional, strictly parsed,
      // and only ever recorded next to a degradation the policy itself declared:
      // a cause arriving without the flag would let a seat that reported health
      // carry failure evidence. League seats are `external-http`, so the server
      // cannot infer warmup from a dead planner - this field is the only way that
      // distinction reaches an artifact.
      ...(message.llmPlannerDegraded === true &&
      normalizeDegradedCause(message.degradedCause) !== undefined
        ? { degradedCause: normalizeDegradedCause(message.degradedCause) }
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
