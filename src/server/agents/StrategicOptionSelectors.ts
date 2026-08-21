import {
  DEFAULT_COMMANDER_HORIZON_DECISIONS,
  type CommanderReplanTrigger,
  type CommanderState,
  type DevelopEconomyStrategicOptionEvidence,
  type ExposedStrategicOption,
  type PressureRivalStrategicOptionEvidence,
  type StrategicOptionId,
  type SurviveStrategicOptionEvidence,
} from "./StrategicCommanderTypes";

export const strategicOptionSelectorSources = [
  "llm",
  "deterministic",
  "random",
] as const;
export type StrategicOptionSelectorSource =
  (typeof strategicOptionSelectorSources)[number];

export interface StrategicOptionSelectorResult {
  selectedStrategicOptionId: StrategicOptionId;
  horizonDecisions: number;
  intent: string;
  replanTriggers: CommanderReplanTrigger[];
}

export const strategicOptionSelectionFailureKinds = [
  "timeout",
  "transport",
  "parse",
  "invalid-option",
] as const;

export type StrategicOptionSelectionFailureKind =
  (typeof strategicOptionSelectionFailureKinds)[number];

export const strategicOptionSelectionFailureDescriptions: Readonly<
  Record<StrategicOptionSelectionFailureKind, string>
> = {
  timeout: "Commander selector timed out",
  transport: "Commander selector transport failed",
  parse: "Commander selector response could not be parsed",
  "invalid-option":
    "Commander selector selected an option outside the locked set",
};

/**
 * Bounded, artifact-safe accounting for a selector attempt. Raw provider text
 * and the prompt itself deliberately never cross this seam.
 */
export interface StrategicOptionSelectorTelemetry {
  providerCalled: boolean;
  promptCharacters: number;
  planningLatencyMs: number;
  rawOutputPresent: boolean;
  parseOk: boolean | null;
  failureKind: StrategicOptionSelectionFailureKind | null;
  failureDetail: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
}

export type StrategicOptionSelectionAttempt =
  | {
      ok: true;
      selection: StrategicOptionSelectorResult;
      telemetry: StrategicOptionSelectorTelemetry;
    }
  | {
      ok: false;
      selection: null;
      telemetry: StrategicOptionSelectorTelemetry & {
        failureKind: StrategicOptionSelectionFailureKind;
        failureDetail: string;
      };
    };

/**
 * The selector authority boundary. Implementations see only the bounded state
 * and binding-free exposed options, never AgentObservation, LegalAction ids,
 * hidden candidates, action scores, or executor data.
 */
export interface StrategicOptionSelector {
  readonly selectorSource: StrategicOptionSelectorSource;
  select(
    state: CommanderState,
    options: readonly ExposedStrategicOption[],
  ): Promise<StrategicOptionSelectionAttempt>;
}

/**
 * Fixed, deliberately simple control policy from the accepted experiment
 * plan. This is Arm B's selector and the sole author of fallback plans.
 */
export class DeterministicOptionSelector implements StrategicOptionSelector {
  readonly selectorSource = "deterministic" as const;

  async select(
    state: CommanderState,
    options: readonly ExposedStrategicOption[],
  ): Promise<StrategicOptionSelectionAttempt> {
    return {
      ok: true,
      selection: selectDeterministicStrategicOption(state, options),
      telemetry: deterministicSelectorTelemetry(),
    };
  }
}

export function deterministicSelectorTelemetry(): StrategicOptionSelectorTelemetry {
  return {
    providerCalled: false,
    promptCharacters: 0,
    planningLatencyMs: 0,
    rawOutputPresent: false,
    parseOk: null,
    failureKind: null,
    failureDetail: null,
    provider: null,
    model: null,
    promptVersion: null,
  };
}

export function selectDeterministicStrategicOption(
  state: CommanderState,
  options: readonly ExposedStrategicOption[],
): StrategicOptionSelectorResult {
  assertLockedOptionSurface(state, options);
  const survive = options.find((option) => option.family === "survive");
  if (survive !== undefined) {
    const evidence = survive.evidence as SurviveStrategicOptionEvidence;
    if (
      evidence.incomingAttackCount > 0 &&
      evidence.strongerBorderRivalCount > 0
    ) {
      return deterministicResult(survive);
    }
  }

  const pressure = options.find((option) => {
    if (option.family !== "pressure_rival") return false;
    const evidence = option.evidence as PressureRivalStrategicOptionEvidence;
    return (
      evidence.sharesBorder &&
      !evidence.targetIsAllied &&
      evidence.targetTroops < state.self.troops
    );
  });
  if (pressure !== undefined) return deterministicResult(pressure);

  const economy = options.find((option) => {
    if (option.family !== "develop_economy") return false;
    return (option.evidence as DevelopEconomyStrategicOptionEvidence)
      .economicBuildAvailable;
  });
  if (economy !== undefined) return deterministicResult(economy);

  const expand = options.find((option) => option.family === "expand");
  if (expand !== undefined) return deterministicResult(expand);
  if (survive !== undefined) return deterministicResult(survive);

  throw new Error(
    "Deterministic Commander selector found no supported exposed option",
  );
}

function assertLockedOptionSurface(
  state: CommanderState,
  options: readonly ExposedStrategicOption[],
): void {
  const stateIDs = state.options.map((option) => option.id);
  const optionIDs = options.map((option) => option.id);
  if (
    stateIDs.length !== optionIDs.length ||
    stateIDs.some((id, index) => id !== optionIDs[index])
  ) {
    throw new Error(
      "Deterministic Commander selector options do not match locked state",
    );
  }
}

function deterministicResult(
  option: ExposedStrategicOption,
): StrategicOptionSelectorResult {
  return {
    selectedStrategicOptionId: option.id,
    horizonDecisions: DEFAULT_COMMANDER_HORIZON_DECISIONS,
    intent: `deterministic control selected ${option.family}`,
    replanTriggers: [],
  };
}
