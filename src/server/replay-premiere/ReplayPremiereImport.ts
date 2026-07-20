import {
  GameStartInfoSchema,
  TurnSchema,
  type GameStartInfo,
  type Turn,
} from "../../core/Schemas";
import type { PremiereSourceRecord } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";

const outcomeBearingKeys = new Set([
  "allplayersstats",
  "authoritativeresult",
  "decisiontail",
  "diagnostics",
  "duration",
  "finalstandings",
  "finalstate",
  "gameendinfo",
  "gameresult",
  "lobbyfilltime",
  "numturns",
  "persistentid",
  "ratingmovement",
  "result",
  "results",
  "reward",
  "stats",
  "winner",
  "winnerid",
  "winnerseat",
  "winnerslot",
]);

export interface PremiereReplayImportTurn {
  turn: unknown;
}

export interface PremiereReplayImportInput {
  gameStartInfo: unknown;
  turns: PremiereReplayImportTurn[];
  turnCount: number;
  turnIntervalMs: number;
}

export interface PremiereReplayImportLimits {
  maxBootstrapBytes: number;
  maxTurnBytes: number;
  maxTurnRecords: number;
  maxTotalTurnBytes: number;
}

export interface ImportedPremiereReplay {
  schemaVersion: 1;
  gameStartInfo: GameStartInfo;
  publicBootstrap: ReplayPremiereJsonValue;
  publicBootstrapHash: string;
  records: PremiereSourceRecord[];
}

/**
 * This is the only supported untyped import boundary for real-client
 * progressive replay data. It validates with the canonical core schemas but
 * does not modify deterministic core behavior.
 */
export function importPremiereReplay(
  input: PremiereReplayImportInput,
  limits: PremiereReplayImportLimits,
): ImportedPremiereReplay {
  validateLimits(limits);
  assertNoOutcomeBearingReplayFields(input.gameStartInfo);
  const parsedStartInfo = GameStartInfoSchema.strict().safeParse(
    input.gameStartInfo,
  );
  if (!parsedStartInfo.success) {
    throw invalidImport("invalid_game_start_info", parsedStartInfo.error);
  }
  if (
    parsedStartInfo.data.players.length < 2 ||
    new Set(parsedStartInfo.data.players.map((player) => player.clientID))
      .size !== parsedStartInfo.data.players.length
  ) {
    throw invalidImport("invalid_or_duplicate_replay_players");
  }
  const publicBootstrap = toJsonValue(parsedStartInfo.data, "game start info");
  if (
    Buffer.byteLength(canonicalReplayPremiereJson(publicBootstrap), "utf8") >
    limits.maxBootstrapBytes
  ) {
    throw capacityError("bootstrap_byte_ceiling_exceeded");
  }
  if (
    !Number.isSafeInteger(input.turnCount) ||
    input.turnCount < 4 ||
    input.turnCount > limits.maxTurnRecords ||
    !Number.isSafeInteger(input.turnIntervalMs) ||
    input.turnIntervalMs <= 0 ||
    input.turnIntervalMs > 60_000
  ) {
    throw invalidImport("invalid_turn_count_or_interval");
  }
  if (!Array.isArray(input.turns) || input.turns.length > input.turnCount) {
    throw capacityError("turn_record_ceiling_exceeded");
  }
  const records: PremiereSourceRecord[] = [];
  const parsedSparseTurns: Turn[] = [];
  let previousTurnNumber = -1;
  for (const source of input.turns) {
    assertNoOutcomeBearingReplayFields(source.turn);
    const parsedTurn = TurnSchema.strict().safeParse(source.turn);
    if (!parsedTurn.success) {
      throw invalidImport("invalid_turn_record", parsedTurn.error);
    }
    if (
      !Number.isSafeInteger(parsedTurn.data.turnNumber) ||
      parsedTurn.data.turnNumber < 0 ||
      parsedTurn.data.turnNumber <= previousTurnNumber ||
      parsedTurn.data.turnNumber >= input.turnCount
    ) {
      throw invalidImport("duplicate_or_out_of_order_turn");
    }
    parsedSparseTurns.push(parsedTurn.data);
    previousTurnNumber = parsedTurn.data.turnNumber;
  }
  const sparseByTurn = new Map(
    parsedSparseTurns.map((turn) => [turn.turnNumber, turn]),
  );
  let totalTurnBytes = 0;
  for (let sequence = 0; sequence < input.turnCount; sequence += 1) {
    const denseTurn: Turn = sparseByTurn.get(sequence) ?? {
      turnNumber: sequence,
      intents: [],
    };
    const payload = toJsonValue(denseTurn, "turn record");
    const turnBytes = Buffer.byteLength(
      canonicalReplayPremiereJson(payload),
      "utf8",
    );
    if (turnBytes > limits.maxTurnBytes) {
      throw capacityError("turn_byte_ceiling_exceeded");
    }
    totalTurnBytes += turnBytes;
    if (totalTurnBytes > limits.maxTotalTurnBytes) {
      throw capacityError("total_turn_byte_ceiling_exceeded");
    }
    records.push({
      sequence,
      turn: sequence,
      nominalOffsetMs: sequence * input.turnIntervalMs,
      payload,
    });
  }
  return {
    schemaVersion: 1,
    gameStartInfo: parsedStartInfo.data,
    publicBootstrap,
    publicBootstrapHash: hashReplayPremiereJson(publicBootstrap),
    records,
  };
}

export function assertNoOutcomeBearingReplayFields(
  value: unknown,
  depth = 0,
): void {
  if (depth > 64) throw capacityError("replay_import_depth_exceeded");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoOutcomeBearingReplayFields(entry, depth + 1);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLocaleLowerCase("en-US").replace(/[_-]/g, "");
    if (outcomeBearingKeys.has(normalized)) {
      throw new ReplayPremiereError(
        "outcome_bearing_import_field",
        "PREMIERE_INTEGRITY_FAILURE",
        422,
        `Outcome-bearing field rejected at replay import: ${key}`,
      );
    }
    assertNoOutcomeBearingReplayFields(entry, depth + 1);
  }
}

function toJsonValue(
  value: GameStartInfo | Turn,
  source: string,
): ReplayPremiereJsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  assertReplayPremiereJsonValue(serialized, source);
  return serialized;
}

function validateLimits(limits: PremiereReplayImportLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidImport(`invalid_${name}`);
    }
  }
}

function invalidImport(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    422,
    `Replay premiere import rejected: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function capacityError(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    `Replay premiere import rejected: ${operatorCode}`,
  );
}
