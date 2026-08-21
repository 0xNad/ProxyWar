import { withDeferredDecisionTimeout } from "./AgentDecisionTimeout";
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
import { buildCommanderPrompt } from "./CommanderPromptBuilder";
import { parseCommanderResponse } from "./CommanderResponseParser";
import { buildCommanderState } from "./CommanderStateBuilder";
import type { LlmProvider } from "./LlmProvider";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import type {
  BuiltCommanderState,
  BuiltStrategicOptions,
  CommanderRecentEvent,
  CommanderState,
  ExposedStrategicOption,
  StrategicOptionCandidate,
  StrategicOptionId,
} from "./StrategicCommanderTypes";
import {
  DeterministicOptionSelector,
  type StrategicOptionSelector,
} from "./StrategicOptionSelectors";

export const MAX_COMMANDER_PROVIDER_FAILURE_LENGTH = 200;
export const DEFAULT_COMMANDER_PROVIDER_TIMEOUT_MS = 12_000;

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
}

/**
 * Stage 4 caller. Composes the Stage 1-3 modules into one decision cycle and
 * owns exactly two boundaries:
 *
 * 1. The provider boundary: the injected LlmProvider is consulted only at a
 *    genuine replan boundary — never while the lifecycle continues a valid
 *    installed plan and never when no strategic options are exposed.
 * 2. The executable boundary: the lifecycle-selected StrategicOptionId is
 *    resolved only to the currently offered candidate's existing binding. An
 *    option whose binding is missing or empty is not exposed at all, so a plan
 *    that selected it hits the existing lifecycle replan/fallback machinery
 *    (`option_not_executable` / `option_not_exposed`) instead of leaking as
 *    executable output.
 */
export class StrategicCommanderCaller {
  constructor(
    private readonly provider: LlmProvider,
    readonly providerTimeoutMs = DEFAULT_COMMANDER_PROVIDER_TIMEOUT_MS,
    private readonly fallbackSelector: StrategicOptionSelector = new DeterministicOptionSelector(),
  ) {}

  runCycle(
    input: StrategicCommanderCycleInput,
  ): Promise<StrategicCommanderCycleOutcome> {
    return runStrategicCommanderCycle(
      this.provider,
      input,
      this.providerTimeoutMs,
      this.fallbackSelector,
    );
  }
}

export async function runStrategicCommanderCycle(
  provider: LlmProvider,
  input: StrategicCommanderCycleInput,
  providerTimeoutMs = DEFAULT_COMMANDER_PROVIDER_TIMEOUT_MS,
  fallbackSelector: StrategicOptionSelector = new DeterministicOptionSelector(),
): Promise<StrategicCommanderCycleOutcome> {
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
        .filter((player) => player.isAlive)
        .map((player) => player.playerID),
    ),
  };
  const request: CommanderPlanRequest = {
    gameID: input.observation.gameID,
    agentID: input.observation.agentID,
    decisionSequence: input.decisionSequence,
    turnNumber: input.observation.turnNumber,
    tick: input.observation.tick,
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

  let providerCalled = false;
  let providerFailure: string | null = null;
  let response: CommanderPlanResponseEnvelope | null = null;
  if (lockedSelectionState !== null) {
    const prompt = buildCommanderPrompt(lockedSelectionState);
    providerCalled = true;
    try {
      const providerPromise = Promise.resolve().then(() =>
        provider.complete(prompt),
      );
      const raw = await withDeferredDecisionTimeout(
        providerPromise,
        providerTimeoutMs,
        () =>
          new Error(
            `Commander provider timed out after ${providerTimeoutMs}ms`,
          ),
      ).promise;
      response = {
        identity,
        parsed: parseCommanderResponse(raw, identity.exposedOptionIDs),
      };
    } catch (error) {
      // A null response drives the existing commander_result_absent fallback,
      // so a provider outage can never stall the cycle or leak an exception.
      providerFailure = boundedProviderFailure(error);
    }
  }

  const fallbackSelection =
    lockedSelectionState !== null &&
    (response === null || response.parsed.ok === false)
      ? await fallbackSelector.select(
          lockedSelectionState,
          lockedSelectionState.options,
        )
      : null;

  const cycle = advanceCommanderPlan({
    active: input.activePlan,
    request,
    material,
    response,
    fallbackSelection,
    forcedReplanReason: input.forcedReplanReason,
    fallbackDegradationCause: cycleFallbackDegradationCause({
      providerFailure,
      response,
    }),
  });
  return {
    cycle,
    providerCalled,
    providerFailure,
    resolution: resolveCyclePlanBinding(cycle, input.options.candidates),
  };
}

function cycleFallbackDegradationCause(input: {
  providerFailure: string | null;
  response: CommanderPlanResponseEnvelope | null;
}): CommanderPlanFallbackDegradationCause | null {
  if (input.providerFailure !== null) {
    return /timed out/i.test(input.providerFailure)
      ? "plan-timeout"
      : "policy-error";
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

function boundedProviderFailure(error: unknown): string {
  const message = sanitizeUntrustedDisplayString(
    error instanceof Error ? error.message : String(error),
    MAX_COMMANDER_PROVIDER_FAILURE_LENGTH,
  );
  return message.length === 0 ? "Commander provider call failed" : message;
}
