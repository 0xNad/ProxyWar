import {
  freeTextMessagesEnabled,
  structuredDealsEnabled,
} from "./AgentTunables";
import { LegalAction } from "./AgentTypes";
import {
  MAX_SPAWN_PREFERENCE_ACTION_IDS,
  MAX_WIRE_ACTIONS_PER_DECISION,
  normalizeWireActionIds,
} from "./AgentWireProtocol";

const MAX_SPAWN_PREFERENCE_ID_LENGTH = 200;

export interface LlmDecisionParserOptions {
  maxReasonLength?: number;
  /**
   * STRICT (default): reject prose, code fences, unknown keys, and out-of-range
   * advisory fields, with coaching error messages. Used for EXTERNAL agents so we can
   * teach developers to return clean output and reject bad submissions.
   * ROBUST (strict:false): extract the decision from prose/fences/extra fields and
   * tolerate advisory-field noise. Used for the in-house Claude agent so its decisions
   * are not lost to format pedantry. Safety is identical in both modes: the result must
   * be a valid offered LegalAction.id; raw intents (no selectedLegalActionId) are rejected.
   */
  strict?: boolean;
}

export type LlmDecisionParseResult =
  | {
      ok: true;
      selectedLegalActionId: string;
      /**
       * OPTIONAL action batch. Present only when the reply carried a
       * `selectedLegalActionIds` array that normalized (scalar-first, deduped,
       * capped at MAX_WIRE_ACTIONS_PER_DECISION) to two or more offered ids —
       * a one-element batch IS the scalar and is omitted so single-action
       * replies stay byte-identical. Unlike the deal slot below, this key is
       * accepted unconditionally: acceptance is backward-compatible (old
       * emitters never send it) and the capability gate lives on the EMIT
       * side of the wire.
       */
      selectedLegalActionIds?: string[];
      /**
       * OPTIONAL spawn-only ranked ballot. Unlike `selectedLegalActionIds`,
       * these ids are preferences for one eventual spawn assignment, not a
       * batch of executable actions. Presence is preserved even for a
       * one-element ranking so the allocator can distinguish an authored
       * partial ballot from a legacy scalar-only reply.
       */
      spawnPreferenceLegalActionIds?: string[];
      /**
       * OPTIONAL second selection — the diplomacy slot
       * (PROXYWAR_TUNE_STRUCTURED_DEALS). When the reply carries the key, its
       * exact string is preserved: `validateAgentDealDecision` is the sole
       * authority and rejects anything that is not an exact offered deal
       * meta-action id.
       */
      selectedDealActionId?: string;
      /**
       * OPTIONAL third selection — the comms slot
       * (PROXYWAR_TUNE_FREETEXT_MESSAGES). The two keys must be present as a
       * string pair. Their exact strings are preserved so
       * `validateAgentMessageDecision` remains the sole authority on exact id
       * equality, blankness, the length cap, and the character set.
       */
      selectedMessageActionId?: string;
      messageText?: string;
      reason: string;
      confidence?: number;
      raw: string;
    }
  | {
      ok: false;
      reason: string;
      raw: string;
    };

interface LlmDecisionJson {
  selectedLegalActionId?: unknown;
  selectedLegalActionIds?: unknown;
  spawnPreferenceLegalActionIds?: unknown;
  selectedDealActionId?: unknown;
  selectedMessageActionId?: unknown;
  messageText?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

const allowedKeys = new Set([
  "selectedLegalActionId",
  "selectedLegalActionIds",
  "spawnPreferenceLegalActionIds",
  "reason",
  "confidence",
]);

/**
 * The optional deal slot is accepted only while the structured-deal flag is
 * on: with the flag off the strict parser still rejects the key as an unknown
 * field, exactly as it does today, so flag-off behavior is byte-identical.
 * A reply that never carries the key behaves identically either way.
 */
function dealSlotKeyAllowed(): boolean {
  return structuredDealsEnabled();
}

type ParsedDealSlot =
  | { ok: true; actionID?: string }
  | { ok: false; reason: string };

function parsedDealActionId(decision: LlmDecisionJson): ParsedDealSlot {
  if (!dealSlotKeyAllowed()) {
    return { ok: true };
  }
  if (!("selectedDealActionId" in decision)) {
    return { ok: true };
  }
  const value = decision.selectedDealActionId;
  if (typeof value !== "string") {
    return {
      ok: false,
      reason: "selectedDealActionId must be a string when present",
    };
  }
  return { ok: true, actionID: value };
}

/**
 * Same contract as the deal slot: the comms keys are accepted only while the
 * free-text flag is on, so with the flag off the strict parser still rejects
 * them as unknown fields and behavior is byte-identical.
 */
function commsSlotKeysAllowed(): boolean {
  return freeTextMessagesEnabled();
}

type ParsedMessageSlot =
  | { ok: true; slot?: { actionID: string; text: string } }
  | { ok: false; reason: string };

function parsedMessageSlot(decision: LlmDecisionJson): ParsedMessageSlot {
  if (!commsSlotKeysAllowed()) {
    return { ok: true };
  }
  const hasID = "selectedMessageActionId" in decision;
  const hasText = "messageText" in decision;
  if (!hasID && !hasText) {
    return { ok: true };
  }
  if (hasID !== hasText) {
    return {
      ok: false,
      reason:
        "selectedMessageActionId and messageText must be provided together",
    };
  }
  const id = decision.selectedMessageActionId;
  const text = decision.messageText;
  if (typeof id !== "string") {
    return {
      ok: false,
      reason: "selectedMessageActionId must be a string when present",
    };
  }
  if (typeof text !== "string") {
    return {
      ok: false,
      reason: "messageText must be a string when present",
    };
  }
  // Both strings are passed through verbatim. The validator owns exact id
  // matching and all text safety checks; dropping or repairing a present pair
  // here would erase the rejection evidence.
  return { ok: true, slot: { actionID: id, text } };
}

export class LlmDecisionParser {
  constructor(private readonly options: LlmDecisionParserOptions = {}) {}

  parse(raw: string, legalActions: LegalAction[]): LlmDecisionParseResult {
    return (this.options.strict ?? true)
      ? this.parseStrict(raw, legalActions)
      : this.parseRobust(raw, legalActions);
  }

  // ---- STRICT (external agents: coaching + reject) ----
  private parseStrict(
    raw: string,
    legalActions: LegalAction[],
  ): LlmDecisionParseResult {
    const normalized = raw.trim();
    if (normalized.length === 0) {
      return this.fail(raw, "empty LLM response");
    }
    if (isMarkdownFence(normalized)) {
      return this.fail(
        raw,
        "markdown code fence is not allowed; return the JSON object only",
      );
    }
    if (!startsWithJsonValue(normalized)) {
      return this.fail(
        raw,
        "response must be strict JSON only, with no prose or logs before the object",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(raw, `malformed JSON: ${message}`);
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return this.fail(raw, "LLM response must be a JSON object");
    }

    for (const key of Object.keys(parsed)) {
      if (key === "selectedDealActionId" && dealSlotKeyAllowed()) {
        continue;
      }
      if (
        (key === "selectedMessageActionId" || key === "messageText") &&
        commsSlotKeysAllowed()
      ) {
        continue;
      }
      if (!allowedKeys.has(key)) {
        if (key === "actionId") {
          return this.fail(
            raw,
            "unknown JSON field: actionId. Use selectedLegalActionId instead.",
          );
        }
        return this.fail(raw, `unknown JSON field: ${key}`);
      }
    }

    const decision = parsed as LlmDecisionJson;
    if (typeof decision.selectedLegalActionId !== "string") {
      return this.fail(raw, "selectedLegalActionId must be a string");
    }
    const selectedLegalActionId = decision.selectedLegalActionId.trim();
    if (selectedLegalActionId.length === 0) {
      return this.fail(raw, "selectedLegalActionId cannot be empty");
    }
    if (!legalActions.some((action) => action.id === selectedLegalActionId)) {
      return this.fail(
        raw,
        `unknown selectedLegalActionId: ${selectedLegalActionId}`,
      );
    }

    if (
      isSpawnPreferenceMenu(legalActions) &&
      decision.selectedLegalActionIds !== undefined
    ) {
      return this.fail(
        raw,
        "selectedLegalActionIds is not allowed on an all-spawn menu; use spawnPreferenceLegalActionIds for the one-spawn preference ballot",
      );
    }

    let selectedLegalActionIds: string[] | undefined;
    if (decision.selectedLegalActionIds !== undefined) {
      const batch = decision.selectedLegalActionIds;
      if (
        !Array.isArray(batch) ||
        batch.some((entry) => typeof entry !== "string")
      ) {
        return this.fail(
          raw,
          "selectedLegalActionIds must be an array of strings",
        );
      }
      if (batch.some((entry: string) => entry.trim().length === 0)) {
        return this.fail(raw, "selectedLegalActionIds entries cannot be empty");
      }
      const normalized = normalizeWireActionIds(
        selectedLegalActionId,
        batch as string[],
      );
      if (normalized.length > MAX_WIRE_ACTIONS_PER_DECISION) {
        return this.fail(
          raw,
          `selectedLegalActionIds exceeds ${MAX_WIRE_ACTIONS_PER_DECISION} actions per decision (primary included)`,
        );
      }
      const unknown = normalized.find(
        (id) => !legalActions.some((action) => action.id === id),
      );
      if (unknown !== undefined) {
        return this.fail(
          raw,
          `unknown selectedLegalActionIds entry: ${unknown}`,
        );
      }
      // A one-element batch IS the scalar; omit so single-action replies stay
      // byte-identical to a reply that never sent the key.
      selectedLegalActionIds = normalized.length >= 2 ? normalized : undefined;
    }

    const spawnPreferences = validateSpawnPreferences(
      decision.spawnPreferenceLegalActionIds,
      selectedLegalActionId,
      legalActions,
    );
    if (!spawnPreferences.ok) {
      return this.fail(raw, spawnPreferences.reason);
    }

    if (typeof decision.reason !== "string") {
      return this.fail(raw, "reason must be a string");
    }
    const reason = decision.reason.trim();
    if (reason.length === 0) {
      return this.fail(raw, "reason cannot be empty");
    }
    const maxReasonLength = this.options.maxReasonLength ?? 280;
    if (reason.length > maxReasonLength) {
      return this.fail(raw, `reason exceeds ${maxReasonLength} characters`);
    }

    if (decision.confidence !== undefined) {
      if (
        typeof decision.confidence !== "number" ||
        !Number.isFinite(decision.confidence)
      ) {
        return this.fail(raw, "confidence must be a finite number");
      }
      if (decision.confidence < 0 || decision.confidence > 1) {
        return this.fail(raw, "confidence must be between 0 and 1");
      }
    }

    const dealSlot = parsedDealActionId(decision);
    if (!dealSlot.ok) {
      return this.fail(raw, dealSlot.reason);
    }
    const messageSlot = parsedMessageSlot(decision);
    if (!messageSlot.ok) {
      return this.fail(raw, messageSlot.reason);
    }
    return {
      ok: true,
      selectedLegalActionId,
      ...(selectedLegalActionIds !== undefined
        ? { selectedLegalActionIds }
        : {}),
      ...(spawnPreferences.value !== undefined
        ? { spawnPreferenceLegalActionIds: spawnPreferences.value }
        : {}),
      ...(dealSlot.actionID !== undefined
        ? { selectedDealActionId: dealSlot.actionID }
        : {}),
      ...(messageSlot.slot !== undefined
        ? {
            selectedMessageActionId: messageSlot.slot.actionID,
            messageText: messageSlot.slot.text,
          }
        : {}),
      reason,
      ...(typeof decision.confidence === "number"
        ? { confidence: decision.confidence }
        : {}),
      raw,
    };
  }

  // ---- ROBUST (in-house Claude agent: extract + tolerate) ----
  private parseRobust(
    raw: string,
    legalActions: LegalAction[],
  ): LlmDecisionParseResult {
    const normalized = raw.trim();
    if (normalized.length === 0) {
      return this.fail(raw, "empty LLM response");
    }

    const candidate =
      extractFirstJsonObject(stripCodeFence(normalized)) ??
      extractFirstJsonObject(normalized);
    if (candidate === null) {
      return this.fail(raw, "no JSON object found in response");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(raw, `malformed JSON: ${message}`);
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return this.fail(raw, "LLM response must be a JSON object");
    }

    const record = parsed as Record<string, unknown>;
    const decision = parsed as LlmDecisionJson;
    if (
      typeof decision.selectedLegalActionId !== "string" &&
      typeof record.actionId === "string"
    ) {
      decision.selectedLegalActionId = record.actionId;
    }
    if (typeof decision.selectedLegalActionId !== "string") {
      return this.fail(raw, "selectedLegalActionId must be a string");
    }
    const selectedLegalActionId = decision.selectedLegalActionId.trim();
    if (selectedLegalActionId.length === 0) {
      return this.fail(raw, "selectedLegalActionId cannot be empty");
    }
    if (!legalActions.some((action) => action.id === selectedLegalActionId)) {
      return this.fail(
        raw,
        `unknown selectedLegalActionId: ${selectedLegalActionId}`,
      );
    }

    if (
      isSpawnPreferenceMenu(legalActions) &&
      decision.selectedLegalActionIds !== undefined
    ) {
      return this.fail(
        raw,
        "selectedLegalActionIds is not allowed on an all-spawn menu; use spawnPreferenceLegalActionIds for the one-spawn preference ballot",
      );
    }

    const reason =
      typeof decision.reason === "string" && decision.reason.trim().length > 0
        ? decision.reason.trim().slice(0, this.options.maxReasonLength ?? 280)
        : "(no reason given)";

    const confidence =
      typeof decision.confidence === "number" &&
      Number.isFinite(decision.confidence) &&
      decision.confidence >= 0 &&
      decision.confidence <= 1
        ? decision.confidence
        : undefined;

    // Tolerant batch handling: keep offered string ids, drop the rest,
    // truncate to the wire cap. Same normalization rule as strict mode.
    let selectedLegalActionIds: string[] | undefined;
    if (Array.isArray(decision.selectedLegalActionIds)) {
      const offered = decision.selectedLegalActionIds
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(
          (entry) =>
            entry.length > 0 &&
            legalActions.some((action) => action.id === entry),
        );
      const normalized = normalizeWireActionIds(
        selectedLegalActionId,
        offered,
      ).slice(0, MAX_WIRE_ACTIONS_PER_DECISION);
      selectedLegalActionIds = normalized.length >= 2 ? normalized : undefined;
    }

    // Spawn preferences are allocation input, not advisory output. Robust
    // mode therefore applies the same whole-ballot rejection as strict mode:
    // silently dropping, deduping, or truncating a malformed ranking could
    // turn it into a different valid ballot.
    const spawnPreferences = validateSpawnPreferences(
      decision.spawnPreferenceLegalActionIds,
      selectedLegalActionId,
      legalActions,
    );
    if (!spawnPreferences.ok) {
      return this.fail(raw, spawnPreferences.reason);
    }

    const dealSlot = parsedDealActionId(decision);
    if (!dealSlot.ok) {
      return this.fail(raw, dealSlot.reason);
    }
    const messageSlot = parsedMessageSlot(decision);
    if (!messageSlot.ok) {
      return this.fail(raw, messageSlot.reason);
    }
    return {
      ok: true,
      selectedLegalActionId,
      ...(selectedLegalActionIds !== undefined
        ? { selectedLegalActionIds }
        : {}),
      ...(spawnPreferences.value !== undefined
        ? { spawnPreferenceLegalActionIds: spawnPreferences.value }
        : {}),
      ...(dealSlot.actionID !== undefined
        ? { selectedDealActionId: dealSlot.actionID }
        : {}),
      ...(messageSlot.slot !== undefined
        ? {
            selectedMessageActionId: messageSlot.slot.actionID,
            messageText: messageSlot.slot.text,
          }
        : {}),
      reason,
      ...(confidence !== undefined ? { confidence } : {}),
      raw,
    };
  }

  private fail(raw: string, reason: string): LlmDecisionParseResult {
    return { ok: false, reason, raw };
  }
}

type SpawnPreferenceValidation =
  | { ok: true; value?: string[] }
  | { ok: false; reason: string };

function validateSpawnPreferences(
  rawPreferences: unknown,
  selectedLegalActionId: string,
  legalActions: LegalAction[],
): SpawnPreferenceValidation {
  if (rawPreferences === undefined) {
    return { ok: true };
  }
  if (
    legalActions.length === 0 ||
    legalActions.some((action) => action.kind !== "spawn")
  ) {
    return {
      ok: false,
      reason:
        "spawnPreferenceLegalActionIds is allowed only when every offered legal action is a spawn action",
    };
  }
  if (!Array.isArray(rawPreferences)) {
    return {
      ok: false,
      reason: "spawnPreferenceLegalActionIds must be an array of strings",
    };
  }
  if (rawPreferences.length === 0) {
    return {
      ok: false,
      reason: "spawnPreferenceLegalActionIds cannot be empty",
    };
  }
  if (rawPreferences.length > MAX_SPAWN_PREFERENCE_ACTION_IDS) {
    return {
      ok: false,
      reason: `spawnPreferenceLegalActionIds exceeds ${MAX_SPAWN_PREFERENCE_ACTION_IDS} preferences`,
    };
  }
  if (rawPreferences.some((entry) => typeof entry !== "string")) {
    return {
      ok: false,
      reason: "spawnPreferenceLegalActionIds must be an array of strings",
    };
  }

  const preferences = rawPreferences as string[];
  if (preferences.some((entry) => entry.length === 0)) {
    return {
      ok: false,
      reason: "spawnPreferenceLegalActionIds entries cannot be empty",
    };
  }
  if (
    preferences.some((entry) => entry.length > MAX_SPAWN_PREFERENCE_ID_LENGTH)
  ) {
    return {
      ok: false,
      reason: `spawnPreferenceLegalActionIds entries cannot exceed ${MAX_SPAWN_PREFERENCE_ID_LENGTH} characters`,
    };
  }
  if (preferences[0] !== selectedLegalActionId) {
    return {
      ok: false,
      reason:
        "selectedLegalActionId must be the first spawnPreferenceLegalActionIds entry",
    };
  }
  if (new Set(preferences).size !== preferences.length) {
    return {
      ok: false,
      reason: "spawnPreferenceLegalActionIds cannot contain duplicate ids",
    };
  }
  const offered = new Set(legalActions.map((action) => action.id));
  const unknown = preferences.find((id) => !offered.has(id));
  if (unknown !== undefined) {
    return {
      ok: false,
      reason: `unknown spawnPreferenceLegalActionIds entry: ${unknown}`,
    };
  }
  return { ok: true, value: preferences };
}

function isSpawnPreferenceMenu(legalActions: LegalAction[]): boolean {
  return (
    legalActions.length > 0 &&
    legalActions.every((action) => action.kind === "spawn")
  );
}

function isMarkdownFence(value: string): boolean {
  return /^```(?:json)?\s*[\s\S]*```$/i.test(value);
}

function startsWithJsonValue(value: string): boolean {
  return (
    value.startsWith("{") ||
    value.startsWith("[") ||
    value.startsWith('"') ||
    value.startsWith("null") ||
    value.startsWith("true") ||
    value.startsWith("false") ||
    /^-?\d/.test(value)
  );
}

/** Strip a single leading/trailing markdown code fence if the whole string is fenced. */
function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
}

/**
 * Extract the first balanced top-level JSON object from arbitrary text (string-aware so
 * braces inside string literals don't break balancing). Returns null if none found.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
