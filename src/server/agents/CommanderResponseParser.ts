import { Buffer } from "node:buffer";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import {
  commanderReplanTriggers,
  DEFAULT_COMMANDER_HORIZON_DECISIONS,
  MAX_COMMANDER_HORIZON_DECISIONS,
  MAX_COMMANDER_INTENT_LENGTH,
  MIN_COMMANDER_HORIZON_DECISIONS,
  type CommanderReplanTrigger,
  type CommanderResponseParseResult,
  type StrategicOptionId,
} from "./StrategicCommanderTypes";

export const MAX_COMMANDER_RESPONSE_LENGTH = 8_192;

const RESPONSE_KEYS = new Set([
  "selectedStrategicOptionId",
  "horizonDecisions",
  "intent",
  "replanTriggers",
  "confidence",
]);

export class CommanderResponseParser {
  parse(
    raw: string,
    lockedOptionIDs: readonly StrategicOptionId[],
  ): CommanderResponseParseResult {
    return parseCommanderResponse(raw, lockedOptionIDs);
  }
}

/**
 * Parses only syntax plus the declared response contract. It deliberately has
 * no access to state, option scores, policies, or any fallback selector.
 */
export function parseCommanderResponse(
  raw: string,
  lockedOptionIDs: readonly StrategicOptionId[],
): CommanderResponseParseResult {
  if (
    typeof raw !== "string" ||
    raw.trim().length === 0 ||
    raw.length > MAX_COMMANDER_RESPONSE_LENGTH ||
    Buffer.byteLength(raw, "utf8") > MAX_COMMANDER_RESPONSE_LENGTH
  ) {
    return failure(raw, "Commander response is empty or exceeds its bound");
  }

  const candidate = responseJsonCandidate(raw);
  if (candidate === null) {
    return failure(
      raw,
      "Commander response does not contain a complete JSON object",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return failure(raw, "Commander response is not valid JSON");
  }
  if (!isPlainRecord(parsed)) {
    return failure(raw, "Commander response must be a JSON object");
  }
  if (hasDuplicateTopLevelKeys(candidate)) {
    return failure(
      raw,
      "Commander response contains a duplicate top-level field",
    );
  }

  const unknownKey = Object.keys(parsed).find((key) => !RESPONSE_KEYS.has(key));
  if (unknownKey !== undefined) {
    return failure(
      raw,
      `Commander response contains unknown field: ${unknownKey}`,
    );
  }

  const selectedOptionID = parsed.selectedStrategicOptionId;
  const lockedOptionIDSet = new Set(lockedOptionIDs);
  if (
    typeof selectedOptionID !== "string" ||
    !lockedOptionIDSet.has(selectedOptionID as StrategicOptionId)
  ) {
    return failure(
      raw,
      "selectedStrategicOptionId is not in the locked option set",
    );
  }

  const rawHorizon = parsed.horizonDecisions;
  if (
    rawHorizon !== undefined &&
    (typeof rawHorizon !== "number" || !Number.isInteger(rawHorizon))
  ) {
    return failure(raw, "horizonDecisions must be an integer from 2 through 6");
  }
  const horizon =
    rawHorizon === undefined
      ? DEFAULT_COMMANDER_HORIZON_DECISIONS
      : Math.min(
          MAX_COMMANDER_HORIZON_DECISIONS,
          Math.max(MIN_COMMANDER_HORIZON_DECISIONS, rawHorizon),
        );

  const rawIntent = parsed.intent;
  if (typeof rawIntent !== "string") {
    return failure(raw, "intent is missing, empty, or exceeds its bound");
  }
  const sanitizedIntent = sanitizeUntrustedDisplayString(
    rawIntent,
    MAX_COMMANDER_INTENT_LENGTH,
  );
  if (sanitizedIntent.length === 0) {
    return failure(raw, "intent is missing, empty, or exceeds its bound");
  }

  const rawTriggers = parsed.replanTriggers;
  if (
    !Array.isArray(rawTriggers) ||
    rawTriggers.length > commanderReplanTriggers.length
  ) {
    return failure(raw, "replanTriggers must be a bounded array");
  }
  const triggers: CommanderReplanTrigger[] = [];
  const seenTriggers = new Set<string>();
  for (const trigger of rawTriggers) {
    if (
      typeof trigger !== "string" ||
      !commanderReplanTriggers.includes(trigger as CommanderReplanTrigger) ||
      seenTriggers.has(trigger)
    ) {
      return failure(
        raw,
        "replanTriggers contains an unknown or duplicate value",
      );
    }
    seenTriggers.add(trigger);
    triggers.push(trigger as CommanderReplanTrigger);
  }

  const confidence = parsed.confidence;
  const normalizedConfidence =
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
      ? confidence
      : undefined;

  return {
    ok: true,
    raw,
    selectedStrategicOptionId: selectedOptionID as StrategicOptionId,
    horizonDecisions: horizon,
    intent: sanitizedIntent,
    replanTriggers: triggers,
    ...(normalizedConfidence === undefined
      ? {}
      : { confidence: normalizedConfidence }),
  };
}

function responseJsonCandidate(raw: string): string | null {
  const normalized = stripOuterCodeFence(raw.trim());
  try {
    const parsed = JSON.parse(normalized) as unknown;
    return isPlainRecord(parsed) ? normalized : null;
  } catch {
    // A prose wrapper may still contain one complete, balanced JSON object.
  }
  return extractFirstBalancedObject(normalized);
}

function stripOuterCodeFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

function extractFirstBalancedObject(value: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return null;
}

/** JSON.parse keeps the final duplicate key, so reject duplicates from source. */
function hasDuplicateTopLevelKeys(json: string): boolean {
  const keys = new Set<string>();
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (let index = 0; index < json.length; index++) {
    const character = json[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        if (objectDepth === 1 && arrayDepth === 0) {
          let next = index + 1;
          while (/\s/.test(json[next] ?? "")) {
            next += 1;
          }
          if (json[next] === ":") {
            const key = JSON.parse(
              json.slice(stringStart, index + 1),
            ) as string;
            if (keys.has(key)) {
              return true;
            }
            keys.add(key);
          }
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
    } else if (character === "{") {
      objectDepth += 1;
    } else if (character === "}") {
      objectDepth -= 1;
    } else if (character === "[") {
      arrayDepth += 1;
    } else if (character === "]") {
      arrayDepth -= 1;
    }
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function failure(raw: string, reason: string): CommanderResponseParseResult {
  return { ok: false, raw, reason };
}
