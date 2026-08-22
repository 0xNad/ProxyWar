import type {
  AgentBrain,
  AgentBrainActionResultFeedback,
  AgentBrainFailureInput,
  AgentBrainInput,
  AgentBrainType,
  AgentDecision,
  AgentObservation,
  LegalAction,
} from "./AgentTypes";
import type {
  ActiveCommanderPlan,
  CommanderPlanReplanReason,
} from "./CommanderPlanLifecycle";
import { compareCommanderStrings } from "./CommanderPrimitives";
import {
  MAX_COMMANDER_OPTION_ID_LENGTH,
  MAX_COMMANDER_RECENT_EVENTS,
} from "./CommanderStateBuilder";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import type { StrategicCommanderCaller } from "./StrategicCommanderCaller";
import type {
  BuiltStrategicOptions,
  CommanderRecentEvent,
  StrategicOptionCandidate,
} from "./StrategicCommanderTypes";
import {
  buildStrategicOptions,
  strategicOptionSurfaceSha256,
} from "./StrategicOptionBuilder";
import {
  commanderBatchFidelityStamp,
  executeStrategicOption,
  type CommanderBlockedReason,
  type CommanderExecutedAction,
  type StrategicOptionExecution,
} from "./StrategicOptionExecutor";
import type {
  StrategicOptionSelectorSource,
  StrategicOptionSelectorTelemetry,
} from "./StrategicOptionSelectors";

/**
 * StrategicCommanderV0 owns active, alive play. The injected tactical brain is
 * retained only for phases outside the V0 strategy contract (notably spawn).
 * Active play is binding-first and can never escape to a globally scoring
 * tactical policy when the selected plan is blocked.
 */
export class StrategicCommanderBrain implements AgentBrain {
  private identity: { gameID: string; agentID: string } | null = null;
  private activePlan: ActiveCommanderPlan | null = null;
  private nextDecisionSequence = 0;
  private decisionEpoch = 0;
  private pendingDecision: AgentDecision | null = null;
  private pendingPrimaryActionID: string | null = null;
  private inFlightOptions: BuiltStrategicOptions | null = null;
  private inFlightDecisionSequence: number | null = null;
  private previousDecisionFacts: CommanderDecisionFacts | null = null;
  private pendingRecentEvents: CommanderRecentEvent[] = [];
  private forcedReplanReason:
    | "option_not_executable"
    | "hold_streak_blocked"
    | null = null;

  constructor(
    private readonly caller: StrategicCommanderCaller,
    private readonly tactical: AgentBrain,
  ) {}

  get brainType(): AgentBrainType {
    return "strategic-commander";
  }

  get internalDecisionTimeoutMs(): number | undefined {
    return this.caller.providerTimeoutMs;
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    this.resetOnIdentityChange(input.observation);
    if (
      input.observation.phase !== "active" ||
      input.observation.ownState?.isAlive !== true
    ) {
      return this.tactical.decide(input);
    }

    const options = buildStrategicOptions(input);
    const decisionSequence = this.nextDecisionSequence;
    this.nextDecisionSequence += 1;
    this.inFlightOptions = options;
    this.inFlightDecisionSequence = decisionSequence;
    const previousPlan = this.activePlan;
    const decisionEvents = deriveCommanderRecentEvents(
      input.observation,
      previousPlan,
      this.previousDecisionFacts,
    );
    const planDeltaEvents = decisionEvents.filter(
      (event) =>
        event.kind === "territory_changed" || event.kind === "troops_changed",
    );
    this.pendingRecentEvents = [
      ...this.pendingRecentEvents,
      ...decisionEvents.filter(
        (event) =>
          event.kind !== "territory_changed" && event.kind !== "troops_changed",
      ),
    ].slice(-MAX_COMMANDER_RECENT_EVENTS);
    const recentEvents = [
      ...planDeltaEvents,
      ...this.pendingRecentEvents.slice(
        -(MAX_COMMANDER_RECENT_EVENTS - planDeltaEvents.length),
      ),
    ];
    this.previousDecisionFacts = commanderDecisionFacts(input.observation);
    const forcedReplanReason = this.forcedReplanReason;
    this.forcedReplanReason = null;
    const decisionEpoch = this.decisionEpoch;
    const outcome = await this.caller.runCycle({
      observation: input.observation,
      options,
      decisionSequence,
      activePlan: previousPlan,
      forcedReplanReason,
      recentEvents,
    });
    if (decisionEpoch !== this.decisionEpoch) {
      this.clearInFlightDecision(decisionSequence);
      return invalidatedCycleDecision(
        input.legalActions,
        this.activePlan,
        decisionSequence,
      );
    }
    if (
      outcome.cycle.evaluation.disposition !== "continue" &&
      outcome.cycle.evaluation.reason !== "no_exposed_options"
    ) {
      this.pendingRecentEvents = [];
    }
    this.clearInFlightDecision(decisionSequence);
    const plannerLatencyMs = outcome.selectionTelemetry.planningLatencyMs;
    this.activePlan = outcome.cycle.plan;

    if (outcome.cycle.plan === null) {
      const execution = blockedWithoutPlan(input.legalActions);
      this.forcedReplanReason = "hold_streak_blocked";
      const decision = commanderDecision({
        execution,
        options,
        plan: null,
        previousPlan,
        providerCalled: outcome.providerCalled,
        providerFailure: outcome.providerFailure,
        responseDisposition: outcome.cycle.responseDisposition,
        plannerLatencyMs,
        fallbackReason: outcome.cycle.fallbackReason,
        rejectionCode: outcome.cycle.rejection?.code ?? null,
        rejectionDetail: outcome.cycle.rejection?.detail ?? null,
        replanReason: outcome.cycle.evaluation.reason,
        selectorSource: outcome.primarySelectorSource,
        selectionTelemetry: outcome.selectionTelemetry,
        deterministicPreferredStrategicOptionId:
          outcome.deterministicPreferredStrategicOptionId,
        deterministicPreferredOptionAbsent:
          outcome.deterministicPreferredOptionAbsent,
        ownTiles: input.observation.ownState?.tilesOwned ?? null,
        ownTroops: input.observation.ownState?.troops ?? null,
      });
      this.rememberIssuedDecision(decision, execution);
      return decision;
    }

    const plan = outcome.cycle.plan;
    const candidate = currentCandidate(options, plan);
    const planAgeDecisions = Math.max(
      0,
      decisionSequence - plan.start.decisionSequence,
    );
    const execution = executeStrategicOption({
      brainInput: input,
      plan,
      candidate,
      planAgeDecisions,
    });
    if (execution.immediateReplan) {
      this.forcedReplanReason = "hold_streak_blocked";
    }
    const decision = commanderDecision({
      execution,
      options,
      plan,
      previousPlan,
      providerCalled: outcome.providerCalled,
      providerFailure: outcome.providerFailure,
      responseDisposition: outcome.cycle.responseDisposition,
      plannerLatencyMs,
      fallbackReason: outcome.cycle.fallbackReason,
      rejectionCode: outcome.cycle.rejection?.code ?? null,
      rejectionDetail: outcome.cycle.rejection?.detail ?? null,
      replanReason: outcome.cycle.evaluation.reason,
      selectorSource: outcome.primarySelectorSource,
      selectionTelemetry: outcome.selectionTelemetry,
      deterministicPreferredStrategicOptionId:
        outcome.deterministicPreferredStrategicOptionId,
      deterministicPreferredOptionAbsent:
        outcome.deterministicPreferredOptionAbsent,
      ownTiles: input.observation.ownState?.tilesOwned ?? null,
      ownTroops: input.observation.ownState?.troops ?? null,
      planAgeDecisions,
    });
    this.rememberIssuedDecision(decision, execution);
    return decision;
  }

  failClosed(input: AgentBrainFailureInput): AgentDecision {
    // Invalidate any still-running provider/cycle promise before producing the
    // server fallback. A late completion may resolve, but it cannot install or
    // replace plan state after this epoch advances.
    const failedDecisionSequence =
      this.inFlightDecisionSequence ?? this.nextDecisionSequence;
    const planAgeDecisions =
      this.activePlan === null
        ? undefined
        : Math.max(
            0,
            failedDecisionSequence - this.activePlan.start.decisionSequence,
          );
    this.decisionEpoch += 1;
    this.forcedReplanReason = "hold_streak_blocked";
    const options = this.inFlightOptions ?? emptyBuiltOptions();
    this.inFlightOptions = null;
    this.inFlightDecisionSequence = null;
    const execution = blockedForOuterFailure(input.legalActions, input.cause);
    const decision = commanderDecision({
      execution,
      options,
      plan: this.activePlan,
      previousPlan: this.activePlan,
      providerCalled: null,
      providerFailure: null,
      responseDisposition: "rejected",
      plannerLatencyMs: null,
      fallbackReason: this.activePlan?.fallbackReason ?? null,
      rejectionCode: null,
      rejectionDetail: null,
      replanReason: "hold_streak_blocked",
      selectorSource: null,
      selectionTelemetry: null,
      deterministicPreferredStrategicOptionId: null,
      deterministicPreferredOptionAbsent: false,
      ownTiles: input.observation.ownState?.tilesOwned ?? null,
      ownTroops: input.observation.ownState?.troops ?? null,
      planAgeDecisions,
    });
    this.rememberIssuedDecision(decision, execution);
    return decision;
  }

  onActionResult(feedback: AgentBrainActionResultFeedback): void {
    if (
      feedback.decision !== this.pendingDecision ||
      feedback.requestedActionID !== this.pendingPrimaryActionID
    ) {
      return;
    }
    this.pendingDecision = null;
    this.pendingPrimaryActionID = null;
    if (!feedback.result.accepted) {
      this.decisionEpoch += 1;
      this.forcedReplanReason = "option_not_executable";
    }
  }

  private rememberIssuedDecision(
    decision: AgentDecision,
    execution: StrategicOptionExecution,
  ): void {
    this.pendingDecision = decision;
    this.pendingPrimaryActionID =
      execution.actions.find((entry) => entry.fidelity === "aligned_primary")
        ?.actionID ?? null;
  }

  private clearInFlightDecision(decisionSequence: number): void {
    if (this.inFlightDecisionSequence !== decisionSequence) return;
    this.inFlightOptions = null;
    this.inFlightDecisionSequence = null;
  }

  private resetOnIdentityChange(observation: AgentObservation): void {
    if (
      this.identity !== null &&
      this.identity.gameID === observation.gameID &&
      this.identity.agentID === observation.agentID
    ) {
      return;
    }
    this.identity = {
      gameID: observation.gameID,
      agentID: observation.agentID,
    };
    this.activePlan = null;
    this.nextDecisionSequence = 0;
    this.decisionEpoch += 1;
    this.pendingDecision = null;
    this.pendingPrimaryActionID = null;
    this.inFlightOptions = null;
    this.inFlightDecisionSequence = null;
    this.previousDecisionFacts = null;
    this.pendingRecentEvents = [];
    this.forcedReplanReason = null;
  }
}

interface CommanderDecisionFacts {
  tilesOwned: number;
  troops: number;
  incomingAttackerIDs: string[];
  rivalAliveByID: ReadonlyMap<string, boolean>;
}

function commanderDecisionFacts(
  observation: AgentObservation,
): CommanderDecisionFacts | null {
  const own = observation.ownState;
  if (own === null) return null;
  const visiblePlayerIDs = new Set(
    observation.visiblePlayers.map((player) => player.playerID),
  );
  return {
    tilesOwned: own.tilesOwned,
    troops: own.troops,
    incomingAttackerIDs: [
      ...new Set(
        observation.combat.incomingAttackPlayerIDs.filter((playerID) =>
          visiblePlayerIDs.has(playerID),
        ),
      ),
    ].sort(compareCommanderStrings),
    rivalAliveByID: new Map(
      observation.visiblePlayers
        .map((player) => [player.playerID, player.isAlive] as const)
        .sort(([left], [right]) => compareCommanderStrings(left, right)),
    ),
  };
}

/** Fixed-template facts only; no raw recent-decision prose is consulted. */
function deriveCommanderRecentEvents(
  observation: AgentObservation,
  activePlan: ActiveCommanderPlan | null,
  previous: CommanderDecisionFacts | null,
): CommanderRecentEvent[] {
  const current = commanderDecisionFacts(observation);
  if (current === null) return [];
  const events: CommanderRecentEvent[] = [];
  if (activePlan !== null) {
    if (current.tilesOwned !== activePlan.start.tilesOwned) {
      events.push({
        kind: "territory_changed",
        fromTiles: activePlan.start.tilesOwned,
        toTiles: current.tilesOwned,
      });
    }
    if (current.troops !== activePlan.start.troops) {
      events.push({
        kind: "troops_changed",
        fromTroops: activePlan.start.troops,
        toTroops: current.troops,
      });
    }
  }
  if (previous !== null) {
    if (current.tilesOwned < previous.tilesOwned) {
      events.push({
        kind: "tiles_lost",
        fromTiles: previous.tilesOwned,
        toTiles: current.tilesOwned,
      });
    }
    const priorAttackers = new Set(previous.incomingAttackerIDs);
    for (const playerID of current.incomingAttackerIDs) {
      if (!priorAttackers.has(playerID)) {
        events.push({ kind: "incoming_attacker", playerID });
      }
    }
    for (const [playerID, wasAlive] of previous.rivalAliveByID) {
      if (wasAlive && current.rivalAliveByID.get(playerID) === false) {
        events.push({ kind: "rival_eliminated", playerID });
      }
    }
  }
  return events.slice(0, MAX_COMMANDER_RECENT_EVENTS);
}

function currentCandidate(
  options: BuiltStrategicOptions,
  plan: ActiveCommanderPlan,
): StrategicOptionCandidate | null {
  return (
    options.candidates.find(
      (candidate) => candidate.id === plan.selectedStrategicOptionId,
    ) ?? null
  );
}

function emptyBuiltOptions(): BuiltStrategicOptions {
  return {
    candidates: [],
    exposed: [],
    record: { eligibleOptionIds: [], exposedOptionIds: [], omitted: [] },
  };
}

function invalidatedCycleDecision(
  legalActions: readonly LegalAction[],
  plan: ActiveCommanderPlan | null,
  decisionSequence: number,
): AgentDecision {
  return commanderDecision({
    execution: blockedForOuterFailure(legalActions, "brain-error"),
    options: emptyBuiltOptions(),
    plan,
    previousPlan: plan,
    providerCalled: false,
    providerFailure: "Commander cycle result arrived after invalidation",
    responseDisposition: "rejected",
    plannerLatencyMs: 0,
    fallbackReason: plan?.fallbackReason ?? null,
    rejectionCode: null,
    rejectionDetail: "Commander cycle result arrived after invalidation",
    replanReason: "hold_streak_blocked",
    selectorSource: null,
    selectionTelemetry: null,
    deterministicPreferredStrategicOptionId: null,
    deterministicPreferredOptionAbsent: false,
    ownTiles: null,
    ownTroops: null,
    planAgeDecisions:
      plan === null
        ? undefined
        : Math.max(0, decisionSequence - plan.start.decisionSequence),
  });
}

function blockedForOuterFailure(
  legalActions: readonly LegalAction[],
  cause: AgentBrainFailureInput["cause"],
): StrategicOptionExecution {
  const hold = legalActions.find((action) => action.kind === "hold");
  if (hold === undefined) {
    throw new Error(
      "Commander fail-closed path requires an offered hold action",
    );
  }
  return {
    actionID: hold.id,
    actions: [
      {
        actionID: hold.id,
        fidelity: "hold_plan_blocked",
        emergencyCondition: null,
      },
    ],
    blockedReason:
      cause === "brain-timeout" ? "outer_brain_timeout" : "outer_brain_error",
    immediateReplan: true,
    reason: `hold: ${cause}`,
  };
}

function blockedWithoutPlan(
  legalActions: readonly LegalAction[],
): StrategicOptionExecution {
  const hold = legalActions.find((action) => action.kind === "hold");
  if (hold === undefined) {
    throw new Error("Commander active play requires an offered hold action");
  }
  const actions: CommanderExecutedAction[] = [
    {
      actionID: hold.id,
      fidelity: "hold_plan_blocked",
      emergencyCondition: null,
    },
  ];
  return {
    actionID: hold.id,
    actions,
    blockedReason: "candidate_missing",
    immediateReplan: true,
    reason: "hold: no active Commander plan",
  };
}

function commanderDecision(args: {
  execution: StrategicOptionExecution;
  options: BuiltStrategicOptions;
  plan: ActiveCommanderPlan | null;
  previousPlan: ActiveCommanderPlan | null;
  providerCalled: boolean | null;
  providerFailure: string | null;
  responseDisposition: string;
  plannerLatencyMs: number | null;
  fallbackReason: string | null;
  rejectionCode: string | null;
  rejectionDetail: string | null;
  replanReason: CommanderPlanReplanReason | string;
  selectorSource: StrategicOptionSelectorSource | null;
  selectionTelemetry: StrategicOptionSelectorTelemetry | null;
  deterministicPreferredStrategicOptionId: string | null;
  deterministicPreferredOptionAbsent: boolean;
  ownTiles: number | null;
  ownTroops: number | null;
  planAgeDecisions?: number;
}): AgentDecision {
  const { execution, plan } = args;
  const firstFidelity = execution.actions[0]!.fidelity;
  const actionIDs = execution.actions.map((action) => action.actionID);
  const optionID = plan?.selectedStrategicOptionId ?? null;
  const optionEvidence: Record<string, string | number | boolean | null> = {};
  if (optionID !== null && plan !== null) {
    const key =
      plan.selector === "commander"
        ? "commanderSelectedStrategicOptionId"
        : plan.selector === "deterministic"
          ? "commanderDeterministicSelectedStrategicOptionId"
          : "commanderFallbackSelectedStrategicOptionId";
    optionEvidence[key] = sanitizeUntrustedDisplayString(
      optionID,
      MAX_COMMANDER_OPTION_ID_LENGTH,
    );
  }
  const previousPlanID =
    args.previousPlan !== null &&
    (plan === null || args.previousPlan.planID !== plan.planID)
      ? args.previousPlan.planID
      : null;
  const parseSucceeded = args.selectionTelemetry?.parseOk === true;
  const plannerFailure = args.providerFailure ?? args.rejectionDetail;
  const degradedCause = plan?.fallbackDegradationCause ?? null;
  return {
    actionID: execution.actionID,
    ...(actionIDs.length > 1 ? { actionIDs } : {}),
    reason: execution.reason,
    metadata: {
      runtimeMode: "commander-v0-selector",
      plannerSource: "strategic-commander-v0",
      executorSource: "strategic-option-executor-v0",
      actionSelectionSource: "strategic-option-binding",
      ...(args.providerCalled === null
        ? {}
        : { externalPlannerCall: args.providerCalled }),
      externalActionCall: false,
      rawProviderOutputPresent:
        args.selectionTelemetry?.rawOutputPresent ?? false,
      ...optionEvidence,
      planID: plan?.planID ?? null,
      planObjective: optionID,
      commanderSelectedOptionID: optionID,
      commanderSelectedOptionFamily: plan?.family ?? null,
      planRationale: plan?.intent ?? null,
      planFollowed:
        firstFidelity === "aligned_primary" ||
        firstFidelity === "aligned_support",
      ...(args.providerCalled === null
        ? {}
        : {
            plannerRan: args.providerCalled,
            plannerLatencyMs: args.plannerLatencyMs ?? 0,
          }),
      plannerFallbackUsed: plan?.selector === "fallback",
      ...(args.selectionTelemetry?.parseOk === null ||
      args.selectionTelemetry === null
        ? {}
        : { plannerParseOk: parseSucceeded }),
      ...(args.selectionTelemetry?.failureDetail !== null &&
      args.selectionTelemetry !== null
        ? { plannerParseFailureReason: args.selectionTelemetry.failureDetail }
        : {}),
      ...(plannerFailure !== null &&
      (args.selectionTelemetry === null ||
        args.selectionTelemetry.failureDetail === null)
        ? { plannerParseFailureReason: plannerFailure }
        : {}),
      llmPlannerDegraded: plan?.selector === "fallback",
      ...(degradedCause === null ? {} : { degradedCause }),
      commanderSelectorSource:
        plan === null
          ? "none"
          : plan.selector === "commander"
            ? "llm"
            : plan.selector === "deterministic"
              ? "deterministic"
              : "fallback-deterministic",
      commanderPrimarySelectorSource: args.selectorSource,
      commanderFingerprint:
        plan === null
          ? null
          : `${plan.origin.exposedOptionSetFingerprint}:${plan.origin.materialStateFingerprint}`,
      commanderEligibleOptionIds:
        args.options.record.eligibleOptionIds.join(","),
      commanderOptionSurfaceSha256: strategicOptionSurfaceSha256(args.options),
      commanderExposedOptionIds: args.options.record.exposedOptionIds.join(","),
      commanderOmittedOptions: args.options.record.omitted
        .map((entry) => `${entry.id}:${entry.reason}`)
        .join(","),
      commanderFidelity: firstFidelity,
      commanderBatchFidelities: commanderBatchFidelityStamp(execution.actions),
      commanderReplanReason: args.replanReason,
      commanderResponseDisposition: args.responseDisposition,
      commanderRejectionCode: args.rejectionCode,
      commanderPreviousPlanID: previousPlanID,
      commanderPlanInstalled:
        plan !== null &&
        (args.previousPlan === null ||
          args.previousPlan.planID !== plan.planID),
      commanderHorizonDecisions: plan?.horizonDecisions ?? null,
      commanderPlanAgeDecisions: args.planAgeDecisions ?? 0,
      commanderBlockedReason: execution.blockedReason,
      commanderImmediateReplan: execution.immediateReplan,
      commanderEmergencyCondition: null,
      commanderDeterministicPreferredOptionId:
        args.deterministicPreferredStrategicOptionId,
      commanderDeterministicPreferredOptionAbsent:
        args.deterministicPreferredOptionAbsent,
      commanderPromptCharacters: args.selectionTelemetry?.promptCharacters ?? 0,
      commanderSelectionFailureKind:
        args.selectionTelemetry?.failureKind ?? null,
      commanderSelectorProvider: args.selectionTelemetry?.provider ?? null,
      commanderSelectorModel: args.selectionTelemetry?.model ?? null,
      commanderPromptVersion: args.selectionTelemetry?.promptVersion ?? null,
      commanderPromptSha256: args.selectionTelemetry?.promptSha256 ?? null,
      commanderSelfTiles: args.ownTiles,
      commanderSelfTroops: args.ownTroops,
    },
  };
}

export type { CommanderBlockedReason };
