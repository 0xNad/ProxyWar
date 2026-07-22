import { Difficulty, GameMapSize, GameMapType } from "../../core/game/Game";
import { legalActionKinds, type LegalActionKind } from "../agents/AgentTypes";
import {
  assertReplayPremiereJsonValue,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";

export const replayPremiereControlledBrainModes = [
  "rule",
  "mock-llm",
  "planner",
] as const;

export type ReplayPremiereControlledBrainMode =
  (typeof replayPremiereControlledBrainModes)[number];

export interface ReplayPremiereControlledExecutionConfig {
  schemaVersion: 1;
  scenario: "league";
  brainMode: ReplayPremiereControlledBrainMode;
  runnerMode: "step-locked";
  planEveryDecisionSteps: number;
  runner: {
    turnsPerDecisionStep: number;
    turnsPerDecisionSchedule: null;
    maxDecisionMs: number;
    maxSteps: number;
    maxSpawnAdvanceTurns: number;
    requireWinner: true;
    waitForMirrorCatchup: true;
    autopilotEndgameSteps: 0;
    replayTailTurns: number;
  };
  game: {
    bots: 0;
    nations: "disabled";
    map: string;
    mapSize: string;
    difficulty: string;
    varySpawns: boolean;
  };
  disabledActionKinds: LegalActionKind[];
}

/**
 * The single strict allowlist shared by the controlled source generator and
 * the publication verifier. This validates the generator's actual phase-zero
 * execution envelope, rather than accepting merely self-consistent provenance.
 */
export function validateReplayPremiereControlledExecutionConfig(
  value: unknown,
): ReplayPremiereControlledExecutionConfig {
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "scenario",
      "brainMode",
      "runnerMode",
      "planEveryDecisionSteps",
      "runner",
      "game",
      "disabledActionKinds",
    ],
    "controlled execution config",
  );
  const runner = strictRecord(
    record.runner,
    [
      "turnsPerDecisionStep",
      "turnsPerDecisionSchedule",
      "maxDecisionMs",
      "maxSteps",
      "maxSpawnAdvanceTurns",
      "requireWinner",
      "waitForMirrorCatchup",
      "autopilotEndgameSteps",
      "replayTailTurns",
    ],
    "controlled runner config",
  );
  const game = strictRecord(
    record.game,
    ["bots", "nations", "map", "mapSize", "difficulty", "varySpawns"],
    "controlled game config",
  );
  if (
    record.schemaVersion !== 1 ||
    record.scenario !== "league" ||
    !(replayPremiereControlledBrainModes as readonly unknown[]).includes(
      record.brainMode,
    ) ||
    record.runnerMode !== "step-locked" ||
    !boundedInteger(record.planEveryDecisionSteps, 1, 10) ||
    !boundedInteger(runner.turnsPerDecisionStep, 1, 2_000) ||
    runner.turnsPerDecisionSchedule !== null ||
    !boundedInteger(runner.maxDecisionMs, 1, 180_000) ||
    !boundedInteger(runner.maxSteps, 1, 500) ||
    !boundedInteger(runner.maxSpawnAdvanceTurns, 1, 10_000) ||
    runner.requireWinner !== true ||
    runner.waitForMirrorCatchup !== true ||
    runner.autopilotEndgameSteps !== 0 ||
    !boundedInteger(runner.replayTailTurns, 0, 10_000) ||
    game.bots !== 0 ||
    game.nations !== "disabled" ||
    typeof game.map !== "string" ||
    !(Object.values(GameMapType) as string[]).includes(game.map) ||
    typeof game.mapSize !== "string" ||
    !(Object.values(GameMapSize) as string[]).includes(game.mapSize) ||
    typeof game.difficulty !== "string" ||
    !(Object.values(Difficulty) as string[]).includes(game.difficulty) ||
    typeof game.varySpawns !== "boolean" ||
    !Array.isArray(record.disabledActionKinds)
  ) {
    throw new Error("controlled execution config is outside the allowlist");
  }
  const disabledActionKinds = record.disabledActionKinds;
  if (
    disabledActionKinds.some(
      (kind) =>
        typeof kind !== "string" ||
        !(legalActionKinds as readonly string[]).includes(kind),
    ) ||
    disabledActionKinds.join("\0") !==
      [...new Set(disabledActionKinds)].sort().join("\0")
  ) {
    throw new Error(
      "controlled execution disabled-action config is not canonical",
    );
  }
  const parsed = value as ReplayPremiereControlledExecutionConfig;
  const jsonValue: unknown = parsed;
  assertReplayPremiereJsonValue(jsonValue, "controlled execution config");
  return parsed;
}

export function controlledExecutionConfigJson(
  value: ReplayPremiereControlledExecutionConfig,
): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(value, "controlled execution config");
  return value;
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
  return record;
}

function boundedInteger(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
