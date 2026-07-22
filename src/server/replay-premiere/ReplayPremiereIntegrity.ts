import { createHash } from "node:crypto";
import { ReplayPremiereError } from "./ReplayPremiereErrors";

export type ReplayPremiereJsonPrimitive = string | number | boolean | null;
export type ReplayPremiereJsonValue =
  | ReplayPremiereJsonPrimitive
  | ReplayPremiereJsonValue[]
  | { [key: string]: ReplayPremiereJsonValue };

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

interface CanonicalJsonBudget {
  nodes: number;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

export function sha256Hex(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalReplayPremiereJson(
  value: ReplayPremiereJsonValue,
): string {
  const budget: CanonicalJsonBudget = { nodes: 0 };
  return canonicalize(value, 0, budget);
}

export function hashReplayPremiereJson(value: ReplayPremiereJsonValue): string {
  return sha256Hex(canonicalReplayPremiereJson(value));
}

/**
 * Takes ownership of JSON-shaped data at a trust boundary. Canonical
 * serialization both rejects unsupported values and severs every caller-owned
 * reference; recursive freezing then prevents hashes from becoming stale while
 * the accepted value is retained or returned.
 */
export function cloneAndFreezeReplayPremiereValue<T>(
  value: T,
  source = "value",
): T {
  assertReplayPremiereJsonValue(value, source);
  const cloned: unknown = JSON.parse(
    canonicalReplayPremiereJson(value as ReplayPremiereJsonValue),
  );
  return deepFreeze(cloned) as T;
}

export function assertReplayPremiereJsonValue(
  value: unknown,
  source = "value",
): asserts value is ReplayPremiereJsonValue {
  try {
    canonicalReplayPremiereJson(value as ReplayPremiereJsonValue);
  } catch (error) {
    if (error instanceof ReplayPremiereError) {
      throw error;
    }
    throw new ReplayPremiereError(
      "invalid_json_value",
      "PREMIERE_INVALID_REQUEST",
      400,
      `${source} is not canonical JSON data`,
      { cause: error },
    );
  }
}

function canonicalize(
  value: ReplayPremiereJsonValue,
  depth: number,
  budget: CanonicalJsonBudget,
): string {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 64) {
    throw new ReplayPremiereError(
      "json_complexity_exceeded",
      "PREMIERE_CAPACITY_EXCEEDED",
      413,
      "Replay premiere JSON complexity ceiling exceeded",
    );
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ReplayPremiereError(
        "non_finite_json_number",
        "PREMIERE_INVALID_REQUEST",
        400,
        "Replay premiere JSON contains a non-finite number",
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalize(entry, depth + 1, budget))
      .join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new ReplayPremiereError(
      "unsupported_json_value",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere data contains an unsupported JSON value",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReplayPremiereError(
      "non_plain_json_object",
      "PREMIERE_INVALID_REQUEST",
      400,
      "Replay premiere data contains a non-plain JSON object",
    );
  }
  const record = value as Record<string, ReplayPremiereJsonValue>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1, budget)}`,
    )
    .join(",")}}`;
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
  }
  return Object.freeze(value);
}
