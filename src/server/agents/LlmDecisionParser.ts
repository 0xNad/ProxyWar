import { LegalAction } from "./AgentTypes";

export interface LlmDecisionParserOptions {
  maxReasonLength?: number;
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
    const normalized = stripSingleJsonFence(raw.trim());
    if (normalized.length === 0) {
      return this.fail(raw, "empty LLM response");
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

    const confidence = this.parseConfidence(raw, decision.confidence);
    if (!confidence.ok) {
      return confidence;
    }

    return {
      ok: true,
      selectedLegalActionId,
      reason,
      ...(confidence.value !== undefined
        ? { confidence: confidence.value }
        : {}),
      raw,
    };
  }

  private parseConfidence(
    raw: string,
    confidence: unknown,
  ): { ok: true; value?: number } | { ok: false; reason: string; raw: string } {
    if (confidence === undefined) {
      return { ok: true };
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      return this.fail(raw, "confidence must be a finite number");
    }
    return { ok: true, value: Math.max(0, Math.min(1, confidence)) };
  }

  private fail(raw: string, reason: string): LlmDecisionParseResult {
    return { ok: false, reason, raw };
  }
}

function stripSingleJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}
