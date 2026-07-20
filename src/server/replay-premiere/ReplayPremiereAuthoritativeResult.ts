import type {
  PremiereEligibility,
  PremiereSeatIdentity,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  cloneAndFreezeReplayPremiereValue,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";

export type PremiereWinnerTuple =
  | ["player", string, ...string[]]
  | ["team", string, string, ...string[]]
  | ["nation", string, string, ...string[]];

export interface PremiereCanonicalAuthoritativeResult {
  schemaVersion: 1;
  sourceKind: "controlled_result" | "coworld_result";
  sourceRunId: string;
  sourceId: string;
  gameId: string;
  completedAt: string;
  turnCount: number;
  /** null is the sole void representation; a tuple must name >=1 winner. */
  winner: PremiereWinnerTuple | null;
  seats: Array<{
    seatId: string;
    displayName: string;
    won: boolean;
  }>;
}

export interface PremiereAuthoritativeResultBytes {
  encoding: "canonical_json_utf8_base64";
  bytes: string;
  sha256: string;
}

/**
 * Validates the exact canonical result bytes that become public at reveal.
 * A winner tuple and a void are mutually exclusive: null means void and all
 * seats must be false; a tuple must resolve to at least one unique known seat,
 * and the won flags must equal that set exactly.
 */
export function verifyPremiereAuthoritativeResultBytes(options: {
  eligibilityRecord: PremiereEligibility;
  resultBytes: Uint8Array;
}): PremiereCanonicalAuthoritativeResult {
  const bytes = Buffer.from(options.resultBytes);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > 1_000_000 ||
    sha256Hex(bytes) !== options.eligibilityRecord.authoritativeResult.resultHash
  ) {
    throw resultIntegrity("authoritative_result_hash_mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw resultIntegrity("authoritative_result_invalid_json", error);
  }
  assertReplayPremiereJsonValue(parsed, "authoritative result");
  if (canonicalReplayPremiereJson(parsed) !== bytes.toString("utf8")) {
    throw resultIntegrity("authoritative_result_not_canonical_json");
  }
  validateResultObject(parsed, options.eligibilityRecord);
  return cloneAndFreezeReplayPremiereValue(
    parsed as unknown as PremiereCanonicalAuthoritativeResult,
    "authoritative result",
  );
}

export function encodePremiereAuthoritativeResult(
  resultBytes: Uint8Array,
): PremiereAuthoritativeResultBytes {
  const bytes = Buffer.from(resultBytes);
  return cloneAndFreezeReplayPremiereValue(
    {
      encoding: "canonical_json_utf8_base64" as const,
      bytes: bytes.toString("base64"),
      sha256: sha256Hex(bytes),
    },
    "authoritative result envelope",
  );
}

export function decodePremiereAuthoritativeResult(
  envelope: PremiereAuthoritativeResultBytes,
): Buffer {
  if (
    envelope.encoding !== "canonical_json_utf8_base64" ||
    typeof envelope.bytes !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.bytes)
  ) {
    throw resultIntegrity("authoritative_result_invalid_encoding");
  }
  const bytes = Buffer.from(envelope.bytes, "base64");
  if (
    bytes.toString("base64") !== envelope.bytes ||
    sha256Hex(bytes) !== envelope.sha256
  ) {
    throw resultIntegrity("authoritative_result_envelope_hash_mismatch");
  }
  return bytes;
}

function validateResultObject(
  value: ReplayPremiereJsonValue,
  eligibility: PremiereEligibility,
): void {
  if (!isRecord(value)) throw resultIntegrity("authoritative_result_not_object");
  assertExactKeys(value, [
    "schemaVersion",
    "sourceKind",
    "sourceRunId",
    "sourceId",
    "gameId",
    "completedAt",
    "turnCount",
    "winner",
    "seats",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.sourceKind !== eligibility.authoritativeResult.sourceKind ||
    value.sourceRunId !== eligibility.sourceRunId ||
    value.sourceId !== eligibility.authoritativeResult.sourceId ||
    typeof value.gameId !== "string" ||
    value.gameId.length === 0 ||
    value.gameId.length > 128 ||
    !isCanonicalTimestamp(value.completedAt) ||
    !Number.isSafeInteger(value.turnCount) ||
    Number(value.turnCount) <= 0 ||
    !Array.isArray(value.seats)
  ) {
    throw resultIntegrity("authoritative_result_contract_mismatch");
  }
  validateResultSeats(value.seats, eligibility.seats, value.winner);
}

function validateResultSeats(
  value: ReplayPremiereJsonValue[],
  expectedSeats: PremiereSeatIdentity[],
  winnerValue: ReplayPremiereJsonValue,
): void {
  if (value.length !== expectedSeats.length) {
    throw resultIntegrity("authoritative_result_seat_count_mismatch");
  }
  const expectedById = new Map(expectedSeats.map((seat) => [seat.seatId, seat]));
  const actualIds = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) throw resultIntegrity("authoritative_result_invalid_seat");
    assertExactKeys(entry, ["seatId", "displayName", "won"]);
    if (
      typeof entry.seatId !== "string" ||
      typeof entry.displayName !== "string" ||
      typeof entry.won !== "boolean" ||
      actualIds.has(entry.seatId) ||
      expectedById.get(entry.seatId)?.displayName !== entry.displayName
    ) {
      throw resultIntegrity("authoritative_result_invalid_seat");
    }
    actualIds.add(entry.seatId);
  }
  if (actualIds.size !== expectedById.size) {
    throw resultIntegrity("authoritative_result_seat_identity_mismatch");
  }
  const winners = parseWinnerSeatIds(winnerValue, actualIds);
  for (const entry of value) {
    if (!isRecord(entry) || entry.won !== winners.has(String(entry.seatId))) {
      throw resultIntegrity("authoritative_result_winner_flag_mismatch");
    }
  }
}

function parseWinnerSeatIds(
  value: ReplayPremiereJsonValue,
  seatIds: ReadonlySet<string>,
): Set<string> {
  if (value === null) return new Set();
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    (value[0] !== "player" && value[0] !== "team" && value[0] !== "nation")
  ) {
    throw resultIntegrity("authoritative_result_invalid_winner");
  }
  const winnerIds = value[0] === "player" ? value.slice(1) : value.slice(2);
  if (
    winnerIds.length === 0 ||
    new Set(winnerIds).size !== winnerIds.length ||
    winnerIds.some((seatId) => !seatIds.has(String(seatId)))
  ) {
    throw resultIntegrity("authoritative_result_invalid_winner_resolution");
  }
  return new Set(winnerIds.map(String));
}

function assertExactKeys(
  value: Record<string, ReplayPremiereJsonValue>,
  keys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw resultIntegrity("authoritative_result_unknown_or_missing_field");
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(
  value: ReplayPremiereJsonValue,
): value is Record<string, ReplayPremiereJsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultIntegrity(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere authoritative result failed verification: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}
