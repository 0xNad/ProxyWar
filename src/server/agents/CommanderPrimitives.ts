import { Buffer } from "node:buffer";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";

/** Locale-independent UTF-16 code-unit ordering used by every Commander seam. */
export function compareCommanderStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A stable identifier is bounded in both JavaScript code units and UTF-8
 * bytes. The byte bound matters for non-ASCII identifiers that are later
 * serialized into request fingerprints and artifacts.
 */
export function boundedCommanderIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    Buffer.byteLength(value, "utf8") > maxLength ||
    sanitizeUntrustedDisplayString(value, maxLength) !== value
  ) {
    throw new Error(`${field} must be a bounded stable identifier`);
  }
  return value;
}

export function nonNegativeCommanderInteger(
  value: unknown,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

export function nonNegativeCommanderFinite(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

export function boundedCommanderPlayerIDs(
  values: Iterable<unknown>,
  field: string,
  maxLength: number,
  limit?: number,
): string[] {
  const normalized = [
    ...new Set(
      [...values].map((value) =>
        boundedCommanderIdentifier(value, field, maxLength),
      ),
    ),
  ].sort(compareCommanderStrings);
  return limit === undefined ? normalized : normalized.slice(0, limit);
}
