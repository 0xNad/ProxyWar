import { LegalAction } from "./AgentTypes";

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
  reason?: unknown;
  confidence?: unknown;
}

const allowedKeys = new Set(["selectedLegalActionId", "reason", "confidence"]);

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

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this.fail(raw, "LLM response must be a JSON object");
    }

    for (const key of Object.keys(parsed)) {
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

    return {
      ok: true,
      selectedLegalActionId,
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

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
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

    return {
      ok: true,
      selectedLegalActionId,
      reason,
      ...(confidence !== undefined ? { confidence } : {}),
      raw,
    };
  }

  private fail(raw: string, reason: string): LlmDecisionParseResult {
    return { ok: false, reason, raw };
  }
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
