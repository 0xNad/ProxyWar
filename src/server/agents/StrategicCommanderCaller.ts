import type { AgentObservation } from "./AgentTypes";
import {
  advanceCommanderPlan,
  commanderPlanProgress,
  commanderPlanSnapshot,
  commanderRequestIdentity,
  evaluateCommanderPlan,
  type ActiveCommanderPlan,
  type CommanderPlanCycle,
  type CommanderPlanEvaluation,
  type CommanderPlanFallbackDegradationCause,
  type CommanderPlanMaterial,
  type CommanderPlanRequest,
  type CommanderPlanResponseEnvelope,
} from "./CommanderPlanLifecycle";
import { buildCommanderState } from "./CommanderStateBuilder";
import {
  DEFAULT_LLM_OPTION_SELECTOR_TIMEOUT_MS,
  LlmOptionSelector,
} from "./LlmOptionSelector";
import type { LlmProvider } from "./LlmProvider";
import {
  strategicOptionFamilies,
  type BuiltCommanderState,
  type BuiltStrategicOptions,
  type CommanderRecentEvent,
  type CommanderState,
  type ExposedStrategicOption,
  type StrategicOptionCandidate,
  type StrategicOptionFamily,
  type StrategicOptionId,
} from "./StrategicCommanderTypes";
import {
  DeterministicOptionSelector,
  deterministicSelectorTelemetry,
  selectDeterministicStrategicOption,
  type StrategicOptionSelectionAttempt,
  type StrategicOptionSelector,
  type StrategicOptionSelectorSource,
  type StrategicOptionSelectorTelemetry,
} from "./StrategicOptionSelectors";

export const DEFAULT_COMMANDER_PROVIDER_TIMEOUT_MS =
  DEFAULT_LLM_OPTION_SELECTOR_TIMEOUT_MS;

export interface StrategicCommanderCycleInput {
  observation: AgentObservation;
  /** The Stage 1 construction for this exact decision. Bindings stay local. */
  options: BuiltStrategicOptions;
  decisionSequence: number;
  activePlan: ActiveCommanderPlan | null;
  forcedReplanReason?: "option_not_executable" | "hold_streak_blocked" | null;
  recentEvents?: readonly CommanderRecentEvent[];
}

/**
 * The caller's only executable output. `executable` carries verbatim copies of
 * the selected candidate's current binding — never ids from a previous
 * decision, a Commander response, or anywhere else.
 */
export type StrategicCommanderBindingResolution =
  | {
      status: "executable";
      selectedStrategicOptionId: StrategicOptionId;
      alignedPrimaryActionIDs: string[];
      alignedSupportActionIDs: string[];
    }
  | {
      status: "option_not_executable";
      selectedStrategicOptionId: StrategicOptionId;
    }
  | { status: "no_plan" };

export interface StrategicCommanderCycleOutcome {
  cycle: CommanderPlanCycle;
  providerCalled: boolean;
  /** Bounded provider error summary; null unless the provider call threw. */
  providerFailure: string | null;
  resolution: StrategicCommanderBindingResolution;
  primarySelectorSource: StrategicOptionSelectorSource;
  selectionTelemetry: StrategicOptionSelectorTelemetry;
  deterministicPreferredStrategicOptionId: StrategicOptionId | null;
  deterministicPreferredOptionAbsent: boolean;
}

/**
 * Shared Arm B/C caller. Composes the Stage 1-3 modules into one decision cycle and
 * owns exactly two boundaries:
 *
 * 1. The typed selector boundary: the injected selector is consulted only at
 *    a genuine replan boundary and receives the exact locked Commander state
 *    and exposed options — never observations, bindings, LegalAction ids, or
 *    Arm B's counterfactual answer.
 * 2. The executable boundary: the lifecycle-selected StrategicOptionId is
 *    resolved only to the currently offered candidate's existing binding. An
 *    option whose binding is missing or empty is not exposed at all, so a plan
 *    that selected it hits the existing lifecycle replan/fallback machinery
 *    (`option_not_executable` / `option_not_exposed`) instead of leaking as
 *    executable output.
 */
export class StrategicCommanderCaller {
  private readonly primarySelector: StrategicOptionSelector;
  readonly providerTimeoutMs: number | undefined;

  constructor(
    primarySelectorOrProvider: StrategicOptionSelector | LlmProvider,
    providerTimeoutMs = DEFAULT_COMMANDER_PROVIDER_TIMEOUT_MS,
    private readonly fallbackSelector: StrategicOptionSelector = new DeterministicOptionSelector(),
  ) {
    if (isStrategicOptionSelector(primarySelectorOrProvider)) {
      assertSupportedPrimarySelector(primarySelectorOrProvider);
      this.primarySelector = primarySelectorOrProvider;
      this.providerTimeoutMs =
        primarySelectorOrProvider.selectorSource === "llm"
          ? providerTimeoutMs
          : undefined;
    } else {
      this.primarySelector = new LlmOptionSelector({
        provider: primarySelectorOrProvider,
        timeoutMs: providerTimeoutMs,
      });
      this.providerTimeoutMs = providerTimeoutMs;
    }
  }

  runCycle(
    input: StrategicCommanderCycleInput,
  ): Promise<StrategicCommanderCycleOutcome> {
    return runStrategicCommanderCycle(
      this.primarySelector,
      input,
      this.fallbackSelector,
    );
  }
}

export async function runStrategicCommanderCycle(
  primarySelector: StrategicOptionSelector,
  input: StrategicCommanderCycleInput,
  fallbackSelector: StrategicOptionSelector = new DeterministicOptionSelector(),
): Promise<StrategicCommanderCycleOutcome> {
  assertSupportedPrimarySelector(primarySelector);
  if (fallbackSelector.selectorSource !== "deterministic") {
    throw new Error(
      "Commander fallback selector must be the deterministic Arm B selector",
    );
  }
  const own = input.observation.ownState;
  if (own === null) {
    throw new Error("Commander cycle requires available own player state");
  }
  const exposedOptions = executableExposedStrategicOptions(input.options);
  const eligibility = executableStrategicOptionEligibility(input.options);
  const recentEvents = input.recentEvents ?? [];
  const builtState = buildCommanderState({
    observation: input.observation,
    exposedOptions,
    decisionSequence: input.decisionSequence,
    plan: null,
    recentEvents,
  });
  const visiblePlayerIDs = new Set(
    input.observation.visiblePlayers.map((player) => player.playerID),
  );
  const material: CommanderPlanMaterial = {
    tilesOwned: own.tilesOwned,
    troops: own.troops,
    // Bounded to visible rivals so plan progress rendered back through the
    // Stage 2 state builder always references rivals it accepts.
    incomingAttackerIDs:
      input.observation.combat.incomingAttackPlayerIDs.filter((playerID) =>
        visiblePlayerIDs.has(playerID),
      ),
    alivePlayerIDs: new Set(
      input.observation.visiblePlayers
        .filter((player) => player.isAlive && !player.isDisconnected)
        .map((player) => player.playerID),
    ),
  };
  const request: CommanderPlanRequest = {
    gameID: input.observation.gameID,
    agentID: input.observation.agentID,
    decisionSequence: input.decisionSequence,
    turnNumber: input.observation.turnNumber,
    tick: input.observation.tick,
    eligibleOptionIDs: eligibility.optionIDs,
    eligibleFamilies: eligibility.families,
    exposedOptions,
    exposedOptionSetFingerprint: builtState.fingerprints.exposedOptionSet,
    materialStateFingerprint: builtState.fingerprints.materialState,
  };
  const identity = commanderRequestIdentity(request);
  const evaluation = evaluateCommanderPlan({
    plan: input.activePlan,
    request,
    material,
    forcedReplanReason: input.forcedReplanReason,
  });
  const lockedSelectionState = isReplanBoundary(evaluation)
    ? promptCommanderState({
        input,
        exposedOptions,
        recentEvents,
        evaluation,
        builtState,
        request,
        material,
      })
    : null;

  let selectionAttempt: StrategicOptionSelectionAttempt | null = null;
  let response: CommanderPlanResponseEnvelope | null = null;
  if (lockedSelectionState !== null) {
    selectionAttempt = await primarySelector.select(
      lockedSelectionState,
      lockedSelectionState.options,
    );
    if (selectionAttempt.ok) {
      response = {
        identity,
        parsed: {
          ok: true,
          raw: "",
          ...selectionAttempt.selection,
        },
      };
    } else if (
      selectionAttempt.telemetry.failureKind === "parse" ||
      selectionAttempt.telemetry.failureKind === "invalid-option"
    ) {
      response = {
        identity,
        parsed: {
          ok: false,
          raw: "",
          reason: selectionAttempt.telemetry.failureDetail,
        },
      };
    } else if (primarySelector.selectorSource !== "llm") {
      throw new Error(
        `Primary ${primarySelector.selectorSource} Commander selector failed: ${selectionAttempt.telemetry.failureDetail}`,
      );
    }
  }

  const needsFallback =
    lockedSelectionState !== null &&
    (selectionAttempt === null || selectionAttempt.ok === false);
  const fallbackAttempt =
    needsFallback && lockedSelectionState !== null
      ? await fallbackSelector.select(
          lockedSelectionState,
          lockedSelectionState.options,
        )
      : null;
  if (fallbackAttempt !== null && !fallbackAttempt.ok) {
    throw new Error(
      `Deterministic Commander fallback failed: ${fallbackAttempt.telemetry.failureDetail}`,
    );
  }
  const fallbackSelection = fallbackAttempt?.selection ?? null;
  const selectionTelemetry =
    selectionAttempt?.telemetry ?? noSelectionTelemetry(primarySelector);
  const providerFailure =
    selectionTelemetry.failureKind === "timeout" ||
    selectionTelemetry.failureKind === "transport"
      ? selectionTelemetry.failureDetail
      : null;
  const deterministicPreference = deterministicPreferenceForAccounting({
    state: lockedSelectionState ?? builtState.state,
    candidates: input.options.candidates,
    exposedOptions,
  });

  const cycle = advanceCommanderPlan({
    active: input.activePlan,
    request,
    material,
    response,
    fallbackSelection,
    primarySelector:
      primarySelector.selectorSource === "deterministic"
        ? "deterministic"
        : "commander",
    forcedReplanReason: input.forcedReplanReason,
    fallbackDegradationCause: cycleFallbackDegradationCause({
      failureKind: selectionTelemetry.failureKind,
      response,
    }),
  });
  return {
    cycle,
    providerCalled: selectionTelemetry.providerCalled,
    providerFailure,
    resolution: resolveCyclePlanBinding(cycle, input.options.candidates),
    primarySelectorSource: primarySelector.selectorSource,
    selectionTelemetry,
    deterministicPreferredStrategicOptionId: deterministicPreference.optionId,
    deterministicPreferredOptionAbsent: deterministicPreference.absent,
  };
}

function cycleFallbackDegradationCause(input: {
  failureKind: StrategicOptionSelectorTelemetry["failureKind"];
  response: CommanderPlanResponseEnvelope | null;
}): CommanderPlanFallbackDegradationCause | null {
  if (input.failureKind === "timeout") {
    return "plan-timeout";
  }
  if (input.failureKind === "transport") {
    return "policy-error";
  }
  return input.response?.parsed.ok === false ? "plan-parse" : null;
}

/**
 * The commander-visible option set: exactly the Stage 1 exposure, minus any
 * option whose candidate binding cannot execute right now. Filtering here is
 * what routes a stale plan for such an option into the lifecycle's explicit
 * `option_not_executable` replan, and a Commander response naming one
 * into the existing `option_not_exposed` rejection and fallback.
 */
export function executableExposedStrategicOptions(
  options: BuiltStrategicOptions,
): ExposedStrategicOption[] {
  return options.exposed.filter(
    (option) =>
      resolveStrategicOptionBinding(option.id, options.candidates) !== null,
  );
}

/** Hidden all-current eligibility used only by lifecycle continuation. */
export function executableStrategicOptionEligibility(
  options: BuiltStrategicOptions,
): { optionIDs: StrategicOptionId[]; families: StrategicOptionFamily[] } {
  const executableIDs = new Set(
    options.candidates
      .filter(
        (candidate) =>
          resolveStrategicOptionBinding(candidate.id, options.candidates) !==
          null,
      )
      .map((candidate) => candidate.id),
  );
  const optionIDs = options.record.eligibleOptionIds.filter((optionID) =>
    executableIDs.has(optionID),
  );
  const families = strategicOptionFamilies.filter((family) =>
    options.candidates.some(
      (candidate) =>
        candidate.family === family && executableIDs.has(candidate.id),
    ),
  );
  return { optionIDs, families };
}

/**
 * Resolves a StrategicOptionId to verbatim copies of its current candidate
 * binding, or null when the option is missing or has no primary action to
 * execute. Ids are copied, never synthesized.
 */
export function resolveStrategicOptionBinding(
  selectedStrategicOptionId: StrategicOptionId,
  candidates: readonly StrategicOptionCandidate[],
): StrategicOptionCandidate["binding"] | null {
  const candidate = candidates.find(
    (entry) => entry.id === selectedStrategicOptionId,
  );
  if (candidate === undefined) {
    return null;
  }
  const primary = candidate.binding.alignedPrimaryActionIDs;
  const support = candidate.binding.alignedSupportActionIDs;
  if (
    !Array.isArray(primary) ||
    !Array.isArray(support) ||
    primary.length === 0 ||
    primary.some((actionID) => typeof actionID !== "string") ||
    support.some((actionID) => typeof actionID !== "string")
  ) {
    return null;
  }
  return {
    alignedPrimaryActionIDs: [...primary],
    alignedSupportActionIDs: [...support],
  };
}

/** A new plan is needed and there is at least one option to choose from. */
function isReplanBoundary(evaluation: CommanderPlanEvaluation): boolean {
  return (
    evaluation.disposition !== "continue" &&
    evaluation.reason !== "no_exposed_options"
  );
}

/**
 * The prompt shows the expiring plan only while it is still valid (a `replan`
 * of an active plan). A terminated plan lost its authority — and may reference
 * an eliminated rival the state builder would rightly reject — so the
 * Commander replans from a clean slate.
 */
function promptCommanderState(args: {
  input: StrategicCommanderCycleInput;
  exposedOptions: ExposedStrategicOption[];
  recentEvents: readonly CommanderRecentEvent[];
  evaluation: CommanderPlanEvaluation;
  builtState: BuiltCommanderState;
  request: CommanderPlanRequest;
  material: CommanderPlanMaterial;
}): CommanderState {
  const activePlan = args.input.activePlan;
  if (
    activePlan === null ||
    args.evaluation.disposition !== "replan" ||
    args.evaluation.reason === "no_active_plan"
  ) {
    return args.builtState.state;
  }
  if (
    activePlan.targetPlayerID !== null &&
    !args.input.observation.visiblePlayers.some(
      (player) => player.playerID === activePlan.targetPlayerID,
    )
  ) {
    return args.builtState.state;
  }
  const progress = commanderPlanProgress(
    activePlan,
    args.request,
    args.material,
  );
  const withPlan = buildCommanderState({
    observation: args.input.observation,
    exposedOptions: args.exposedOptions,
    decisionSequence: args.input.decisionSequence,
    plan: commanderPlanSnapshot(activePlan, progress),
    recentEvents: args.recentEvents,
  });
  if (
    withPlan.fingerprints.exposedOptionSet !==
      args.builtState.fingerprints.exposedOptionSet ||
    withPlan.fingerprints.materialState !==
      args.builtState.fingerprints.materialState
  ) {
    // The request identity remains the execution authority. If a future state
    // projection change makes the explanatory plan snapshot diverge, omit the
    // snapshot rather than throwing into an unrelated tactical fallback.
    return args.builtState.state;
  }
  return withPlan.state;
}

/**
 * Defensive final gate: with exposure filtered above, every plan the lifecycle
 * can return resolves; if an inconsistent caller ever bypasses that, the plan
 * surfaces as `option_not_executable` rather than as executable output.
 */
function resolveCyclePlanBinding(
  cycle: CommanderPlanCycle,
  candidates: readonly StrategicOptionCandidate[],
): StrategicCommanderBindingResolution {
  if (cycle.plan === null) {
    return { status: "no_plan" };
  }
  const selectedStrategicOptionId = cycle.plan.selectedStrategicOptionId;
  const binding = resolveStrategicOptionBinding(
    selectedStrategicOptionId,
    candidates,
  );
  if (binding === null) {
    return { status: "option_not_executable", selectedStrategicOptionId };
  }
  return {
    status: "executable",
    selectedStrategicOptionId,
    alignedPrimaryActionIDs: binding.alignedPrimaryActionIDs,
    alignedSupportActionIDs: binding.alignedSupportActionIDs,
  };
}

function noSelectionTelemetry(
  selector: StrategicOptionSelector,
): StrategicOptionSelectorTelemetry {
  return {
    ...deterministicSelectorTelemetry(),
    providerCalled: false,
    parseOk: null,
    provider: selector.selectorSource === "llm" ? "not-called" : null,
  };
}

function deterministicPreferenceForAccounting(input: {
  state: CommanderState;
  candidates: readonly StrategicOptionCandidate[];
  exposedOptions: readonly ExposedStrategicOption[];
}): { optionId: StrategicOptionId | null; absent: boolean } {
  const allEligibleOptions: ExposedStrategicOption[] = input.candidates.map(
    ({ binding: _binding, ...visible }) => ({
      ...visible,
      evidence: { ...visible.evidence },
    }),
  );
  if (allEligibleOptions.length === 0) {
    return { optionId: null, absent: false };
  }
  const accountingState: CommanderState = {
    ...input.state,
    options: allEligibleOptions,
  };
  const optionId = selectDeterministicStrategicOption(
    accountingState,
    accountingState.options,
  ).selectedStrategicOptionId;
  return {
    optionId,
    absent: !input.exposedOptions.some((option) => option.id === optionId),
  };
}

function isStrategicOptionSelector(
  value: StrategicOptionSelector | LlmProvider,
): value is StrategicOptionSelector {
  return (
    typeof (value as Partial<StrategicOptionSelector>).selectorSource ===
      "string" &&
    typeof (value as Partial<StrategicOptionSelector>).select === "function"
  );
}

function assertSupportedPrimarySelector(
  selector: StrategicOptionSelector,
): void {
  if (
    selector.selectorSource !== "llm" &&
    selector.selectorSource !== "deterministic"
  ) {
    throw new Error(
      `Unsupported Stage 5 primary selector source: ${selector.selectorSource}`,
    );
  }
}
