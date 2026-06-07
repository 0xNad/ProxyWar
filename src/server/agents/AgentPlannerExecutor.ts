import { PlayerType, Relation, UnitType } from "../../core/game/Game";
import {
  nuclearStrikePriorityScore,
  nuclearTargetStructurePriority,
} from "./AgentNuclearPolicy";
import {
  scoreProfileRepairRerankAction,
  type AgentProfileRepairRerankScore,
} from "./AgentProfileRepairPolicy";
import { frontierAgentSkill } from "./AgentPlaybook";
import {
  compactSkillSummary,
  skillEvaluationForAction,
  StrategicSkillEvaluator,
} from "./AgentStrategicSkills";
import { buildAgentTacticalAffordances } from "./AgentTacticalAffordances";
import { tunedNumber } from "./AgentTunables";
import {
  AgentBrain,
  AgentBrainInput,
  AgentBrainType,
  AgentCommunicationIntent,
  AgentCommunicationSignal,
  AgentDecision,
  AgentOpponentModelEntry,
  AgentVisiblePlayer,
  AgentFrontierConversionTimingAffordance,
  AgentFrontierFinishPressureAffordance,
  AgentObjectiveKind,
  AgentObservation,
  AgentRuntimeMode,
  AgentStrategyProfile,
  AgentTransportTroopBankingAffordance,
  LegalAction,
  LegalActionKind,
  legalActionKinds,
} from "./AgentTypes";
import { LlmProvider } from "./LlmProvider";
import { RuleAgentBrain } from "./RuleAgentBrain";

export type FrontierPolicyModule =
  | "emergency_survival"
  | "spawn_opening"
  | "expansion"
  | "defense"
  | "economy"
  | "diplomacy"
  | "combat"
  | "naval"
  | "nuclear_endgame"
  | "utility_social";

export interface AgentTacticalSettings {
  reserveRatio?: number;
  triggerRatio?: number;
  expansionRatio?: number;
  maxConcurrentWars?: number;
  retreatThreshold?: number;
  maxActionsPerDecision?: number;
}

export type AgentPlanTurnIntent =
  | "spawn"
  | "growth"
  | "build"
  | "fortify"
  | "pressure"
  | "survive"
  | "diplomacy"
  | "naval";

export interface AgentSettings extends Required<AgentTacticalSettings> {
  seed: string;
  frontierFinishPressureEnabled: boolean;
  navalControlEnabled: boolean;
  lateGameStrikeTargetingEnabled: boolean;
  personalityDiplomacyPressureEnabled: boolean;
  openingExpansionTempoEnabled: boolean;
  transportTroopBankingEnabled: boolean;
  territoryFirstNeutralLandEnabled: boolean;
  humanReplayEconomyCadenceEnabled: boolean;
  profileRepairReRankEnabled: boolean;
  firstCityTargetAfterStableExpansion: boolean;
  portTileShareRatio: number;
  factoryTileShareRatio: number;
  samTileShareRatio: number;
  siloTileShareRatio: number;
  profileWeights: Record<
    AgentStrategyProfile,
    Partial<Record<FrontierPolicyModule, number>>
  >;
}

export interface StrategicPlan {
  planID: string;
  objective: AgentObjectiveKind;
  turnIntent?: AgentPlanTurnIntent;
  targetPlayerId: string | null;
  rationale: string;
  startedAtTick: number | null;
  maxDecisionCycles: number;
  successCriteria: string[];
  failureCriteria: string[];
  preferredActionKinds: LegalActionKind[];
  forbiddenActionKinds: LegalActionKind[];
  enabledModules?: FrontierPolicyModule[];
  tacticalSettings?: AgentTacticalSettings;
  plannerSource: "rule" | "mock-llm" | "codex-cli" | "real-llm";
}

export interface AgentPlanDecision {
  plan: StrategicPlan;
  reason: string;
  latencyMs: number;
  fallbackUsed: boolean;
  llmPlannerDegraded?: boolean;
  rawPlannerOutput?: string;
  promptLength?: number;
  parseOk?: boolean;
  parseFailureReason?: string;
  repairUsed?: boolean;
  repairReason?: string;
  repairPromptLength?: number;
}

export interface AgentPlanner {
  readonly plannerType: StrategicPlan["plannerSource"];
  plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision>;
}

export interface AgentExecutionDecision {
  actionID: string;
  actionIDs?: string[];
  reason: string;
  planFollowed: boolean;
  executorSource?: string;
  actionSelectionSource?: string;
  selectedSkill?: string;
  selectedSkillScore?: number;
  skillSummary?: string;
  alternativesConsidered?: string;
  selectedModules?: string;
  blockedHostileAttackSummary?: string;
  holdReasonCategory?: string;
  profileRepairRerankOpportunity?: boolean;
  profileRepairRerankSelected?: boolean;
  profileRepairRerankSuggestedActionID?: string;
  profileRepairRerankSuggestedActionKind?: string;
  profileRepairRerankSuggestedModule?: string;
  profileRepairRerankSelectedReason?: string;
  profileRepairRerankCandidates?: string;
}

export interface AgentExecutor {
  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision;
}

export interface PlannerExecutorAgentBrainOptions {
  profile: AgentStrategyProfile;
  planner: AgentPlanner;
  executor?: AgentExecutor;
  planEveryDecisionSteps?: number;
  brainType?: AgentBrainType;
  settings?: Partial<AgentSettings>;
  runtimeMode?: AgentRuntimeMode;
  executorSource?: string;
}

export { tunedNumber } from "./AgentTunables";

export const defaultAgentSettings: AgentSettings = {
  seed: "frontier-agent",
  reserveRatio: tunedNumber("RESERVE_RATIO", 0.35),
  triggerRatio: tunedNumber("TRIGGER_RATIO", 0.55),
  expansionRatio: tunedNumber("EXPANSION_RATIO", 0.15),
  maxConcurrentWars: tunedNumber("MAX_CONCURRENT_WARS", 1),
  retreatThreshold: tunedNumber("RETREAT_THRESHOLD", 0.35),
  maxActionsPerDecision: tunedNumber("MAX_ACTIONS_PER_DECISION", 4),
  frontierFinishPressureEnabled: true,
  navalControlEnabled: true,
  lateGameStrikeTargetingEnabled: true,
  personalityDiplomacyPressureEnabled: true,
  openingExpansionTempoEnabled: true,
  transportTroopBankingEnabled: true,
  territoryFirstNeutralLandEnabled: false,
  humanReplayEconomyCadenceEnabled: true,
  profileRepairReRankEnabled: true,
  firstCityTargetAfterStableExpansion: true,
  portTileShareRatio: tunedNumber("PORT_TILE_SHARE_RATIO", 0.06),
  factoryTileShareRatio: tunedNumber("FACTORY_TILE_SHARE_RATIO", 0.09),
  samTileShareRatio: tunedNumber("SAM_TILE_SHARE_RATIO", 0.18),
  siloTileShareRatio: tunedNumber("SILO_TILE_SHARE_RATIO", 0.28),
  profileWeights: {
    aggressive: {
      combat: 1.22,
      naval: 1.08,
      nuclear_endgame: 1.12,
      diplomacy: 0.82,
    },
    defensive: {
      emergency_survival: 1.22,
      defense: 1.28,
      economy: 1.06,
      combat: 0.82,
      nuclear_endgame: 0.92,
    },
    diplomatic: {
      diplomacy: 1.35,
      economy: 1.08,
      combat: 0.78,
      utility_social: 1.15,
    },
    opportunistic: {
      expansion: 1.12,
      economy: 1.12,
      naval: 1.1,
      combat: 1,
    },
  },
};

/** Internal, per-game accumulator behind the agent's theory-of-mind model. */
interface OpponentLedgerEntry {
  name: string;
  tileShareEma: number;
  attacksOnMe: number;
  wasAttackingMe: boolean;
  iAttacked: number;
  wasAttackedByMe: boolean;
  everAllied: boolean;
  betrayedMe: boolean;
  lastSignal: AgentCommunicationIntent | null;
}

const OPPONENT_MODEL_MAX_ENTRIES = 8;
const OPPONENT_MOMENTUM_EPS = 0.004;
const OPPONENT_TILESHARE_EMA_ALPHA = 0.2;

function opponentThreatLevel(
  player: AgentVisiblePlayer,
): "high" | "medium" | "low" {
  if (player.incomingAttack) {
    return "high";
  }
  const strongerHostileNeighbor =
    player.sharesBorder &&
    !player.isAllied &&
    (player.relativeTroopRatio ?? 1) < 1 &&
    (player.relation === Relation.Hostile ||
      player.relation === Relation.Distrustful);
  if (strongerHostileNeighbor) {
    return "high";
  }
  if (player.sharesBorder && !player.isAllied && !player.isFriendly) {
    return "medium";
  }
  return "low";
}

function predictOpponentNextAction(
  player: AgentVisiblePlayer,
  momentum: "rising" | "falling" | "flat",
  isLeader: boolean,
): string {
  if (player.incomingAttack) {
    return "attacking_me";
  }
  if (player.hasIncomingAllianceRequest) {
    return "wants_alliance_with_me";
  }
  if (player.isAllied && player.allianceInExtensionWindow === true) {
    return "alliance_expiring";
  }
  if (player.isAllied && (player.relativeTroopRatio ?? 1) < 0.8) {
    return "strong_ally_betrayal_risk";
  }
  const stronger = (player.relativeTroopRatio ?? 1) < 1;
  if (
    player.sharesBorder &&
    stronger &&
    (player.relation === Relation.Hostile ||
      player.relation === Relation.Distrustful)
  ) {
    return "may_attack_me";
  }
  if (isLeader && momentum === "rising") {
    return "snowballing_to_win";
  }
  if (momentum === "rising") {
    return "expanding";
  }
  if (momentum === "falling") {
    return "losing_ground";
  }
  return "stable";
}

function opponentTrust(
  player: AgentVisiblePlayer,
  entry: OpponentLedgerEntry,
): number {
  let trust = 0.5;
  if (entry.betrayedMe) {
    trust = 0.05;
  } else if (entry.attacksOnMe > 0) {
    trust = Math.max(0.1, 0.5 - entry.attacksOnMe * 0.12);
  } else if (entry.everAllied && player.isAllied) {
    trust = 0.85;
  } else if (player.relation === Relation.Friendly) {
    trust = 0.7;
  } else if (player.relation === Relation.Hostile) {
    trust = 0.2;
  }
  return Math.round(trust * 100) / 100;
}

export class PlannerExecutorAgentBrain implements AgentBrain {
  readonly brainType: AgentBrainType;
  private currentPlan: StrategicPlan | null = null;
  private decisionsSincePlan = 0;
  private readonly opponentLedger = new Map<string, OpponentLedgerEntry>();
  private opponentLedgerGameID: string | null = null;
  private readonly executor: AgentExecutor;
  private readonly planEveryDecisionSteps: number;
  private readonly runtimeMode: AgentRuntimeMode;
  private readonly executorSource: string;

  constructor(private readonly options: PlannerExecutorAgentBrainOptions) {
    this.brainType = options.brainType ?? "planner-executor";
    this.executor =
      options.executor ??
      new FrontierPolicyExecutor(options.profile, {
        settings: options.settings,
        seed: `${options.profile}:planner-executor`,
      });
    this.planEveryDecisionSteps = options.planEveryDecisionSteps ?? 3;
    this.runtimeMode =
      options.runtimeMode ?? runtimeModeForPlanner(options.planner.plannerType);
    this.executorSource =
      options.executorSource ?? defaultExecutorSource(this.executor);
  }

  /**
   * Update the persistent per-rival belief state from this tick's observation and
   * return a compact, ranked opponent model (theory-of-mind substrate). Runs every
   * decision so trends/betrayals accumulate; deterministic (derives only from the
   * ordered observation stream). Resets when a new game starts.
   */
  private updateOpponentModel(input: AgentBrainInput): AgentOpponentModelEntry[] {
    const obs = input.observation;
    if (this.opponentLedgerGameID !== obs.gameID) {
      this.opponentLedger.clear();
      this.opponentLedgerGameID = obs.gameID;
    }
    const latestSignalBySender = new Map<string, AgentCommunicationIntent>();
    for (const signal of obs.recentCommunications ?? []) {
      const senderID = signal.senderPlayerID ?? signal.senderAgentID;
      if (senderID) {
        latestSignalBySender.set(senderID, signal.intent);
      }
    }
    const ownTileShare = obs.ownState?.tileShare ?? 0;
    // Political actors only: nations + other agents, not weak tribes (PlayerType.Bot).
    const rivals = obs.visiblePlayers.filter(
      (player) => player.isAlive && player.type !== PlayerType.Bot,
    );
    const maxRivalTileShare = rivals.reduce(
      (max, player) => Math.max(max, player.tileShare ?? 0),
      0,
    );
    const entries: AgentOpponentModelEntry[] = rivals.map((player) => {
      const tileShare = player.tileShare ?? 0;
      const entry: OpponentLedgerEntry = this.opponentLedger.get(
        player.playerID,
      ) ?? {
        name: player.name,
        tileShareEma: tileShare,
        attacksOnMe: 0,
        wasAttackingMe: false,
        iAttacked: 0,
        wasAttackedByMe: false,
        everAllied: false,
        betrayedMe: false,
        lastSignal: null,
      };
      // Count distinct attack events (rising edge), not per-tick presence.
      if (player.incomingAttack && !entry.wasAttackingMe) {
        entry.attacksOnMe += 1;
      }
      entry.wasAttackingMe = player.incomingAttack;
      if (player.outgoingAttack && !entry.wasAttackedByMe) {
        entry.iAttacked += 1;
      }
      entry.wasAttackedByMe = player.outgoingAttack;
      if (player.isAllied) {
        entry.everAllied = true;
      }
      if (
        entry.everAllied &&
        !player.isAllied &&
        (player.incomingAttack || player.relation === Relation.Hostile)
      ) {
        entry.betrayedMe = true;
      }
      const signal = latestSignalBySender.get(player.playerID);
      if (signal !== undefined) {
        entry.lastSignal = signal;
      }
      const delta = tileShare - entry.tileShareEma;
      const momentum: "rising" | "falling" | "flat" =
        delta > OPPONENT_MOMENTUM_EPS
          ? "rising"
          : delta < -OPPONENT_MOMENTUM_EPS
            ? "falling"
            : "flat";
      entry.tileShareEma =
        entry.tileShareEma * (1 - OPPONENT_TILESHARE_EMA_ALPHA) +
        tileShare * OPPONENT_TILESHARE_EMA_ALPHA;
      entry.name = player.name;
      this.opponentLedger.set(player.playerID, entry);
      const isLeader =
        tileShare >= maxRivalTileShare &&
        tileShare >= ownTileShare &&
        tileShare > 0;
      return {
        playerID: player.playerID,
        name: player.name,
        tileShare: Math.round(tileShare * 1000) / 1000,
        relativeTroopRatio: player.relativeTroopRatio,
        relation: player.relation,
        isAllied: player.isAllied,
        momentum,
        attacksOnMe: entry.attacksOnMe,
        betrayedMe: entry.betrayedMe,
        isLeader,
        lastSignal: entry.lastSignal,
        threat: opponentThreatLevel(player),
        trust: opponentTrust(player, entry),
        predictedNextAction: predictOpponentNextAction(
          player,
          momentum,
          isLeader,
        ),
      };
    });
    entries.sort((a, b) => b.tileShare - a.tileShare);
    return entries.slice(0, OPPONENT_MODEL_MAX_ENTRIES);
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    input.observation.opponentModel = this.updateOpponentModel(input);
    const plannerRefreshReason = this.plannerRefreshReason(input);
    let planDecision: AgentPlanDecision | null = null;
    if (plannerRefreshReason !== null) {
      planDecision = await this.options.planner.plan(input, this.currentPlan);
      this.currentPlan = planDecision.plan;
      this.decisionsSincePlan = 0;
    }

    const plan =
      this.currentPlan ??
      (await new RuleAgentPlanner(this.options.profile).plan(input, null)).plan;
    const turnIntent = resolvedPlanTurnIntent(input, plan);
    const execution = this.executor.decide(input, plan);
    this.decisionsSincePlan += 1;
    const executorSource = execution.executorSource ?? this.executorSource;
    const actionSelectionSource =
      execution.actionSelectionSource ?? "local-policy-executor";
    const externalPlannerCall =
      planDecision !== null && isExternalPlannerSource(plan.plannerSource);
    const rawProviderOutputPresent =
      externalPlannerCall &&
      typeof planDecision?.rawPlannerOutput === "string" &&
      planDecision.rawPlannerOutput.trim().length > 0;

    return {
      actionID: execution.actionID,
      ...(execution.actionIDs !== undefined
        ? { actionIDs: execution.actionIDs }
        : {}),
      reason: `${execution.reason}; plan=${plan.objective}: ${plan.rationale}`,
      metadata: {
        brain: "planner-executor",
        brainType: this.brainType,
        runtimeMode: this.runtimeMode,
        plannerSource: plan.plannerSource,
        executorSource,
        actionSelectionSource,
        externalPlannerCall,
        externalActionCall: false,
        rawProviderOutputPresent,
        planID: plan.planID,
        planObjective: plan.objective,
        planTurnIntent: turnIntent,
        planRationale: plan.rationale,
        planPlannerSource: plan.plannerSource,
        planPreferredActionKinds: plan.preferredActionKinds.join(","),
        planForbiddenActionKinds: plan.forbiddenActionKinds.join(","),
        activePolicyObjective: plan.objective,
        activePolicyTurnIntent: turnIntent,
        activePolicyPreferredActionKinds: plan.preferredActionKinds.join(","),
        activePolicyForbiddenActionKinds: plan.forbiddenActionKinds.join(","),
        ...(plan.enabledModules !== undefined
          ? {
              planEnabledModules: plan.enabledModules.join(","),
              activePolicyEnabledModules: plan.enabledModules.join(","),
            }
          : {}),
        ...(plan.targetPlayerId !== null
          ? {
              planTargetPlayerId: plan.targetPlayerId,
              activePolicyTargetPlayerId: plan.targetPlayerId,
            }
          : {}),
        ...(plan.tacticalSettings !== undefined
          ? {
              planTacticalSettings: JSON.stringify(plan.tacticalSettings),
              activePolicyTacticalSettings: JSON.stringify(
                plan.tacticalSettings,
              ),
            }
          : {}),
        planMaxDecisionCycles: plan.maxDecisionCycles,
        planFollowed: execution.planFollowed,
        actionFollowedActivePolicy: execution.planFollowed,
        plannerRan: planDecision !== null,
        plannerRefreshReason: plannerRefreshReason ?? "active_plan_reused",
        plannerLatencyMs: planDecision?.latencyMs ?? 0,
        plannerFallbackUsed: planDecision?.fallbackUsed ?? false,
        ...(planDecision?.llmPlannerDegraded !== undefined
          ? { llmPlannerDegraded: planDecision.llmPlannerDegraded }
          : {}),
        ...(planDecision?.reason !== undefined
          ? { plannerDecisionReason: planDecision.reason }
          : {}),
        ...(execution.selectedSkill !== undefined
          ? { selectedSkill: execution.selectedSkill }
          : {}),
        ...(execution.selectedSkillScore !== undefined
          ? { selectedSkillScore: execution.selectedSkillScore }
          : {}),
        ...(execution.skillSummary !== undefined
          ? { skillSummary: execution.skillSummary }
          : {}),
        ...(execution.alternativesConsidered !== undefined
          ? { alternativesConsidered: execution.alternativesConsidered }
          : {}),
        ...(execution.blockedHostileAttackSummary !== undefined
          ? {
              blockedHostileAttackSummary:
                execution.blockedHostileAttackSummary,
            }
          : {}),
        ...(execution.holdReasonCategory !== undefined
          ? { holdReasonCategory: execution.holdReasonCategory }
          : {}),
        ...(execution.actionIDs !== undefined
          ? { scheduledActionIDs: execution.actionIDs.join(",") }
          : {}),
        ...(execution.selectedModules !== undefined
          ? { selectedModules: execution.selectedModules }
          : {}),
        ...(execution.profileRepairRerankOpportunity !== undefined
          ? {
              profileRepairRerankOpportunity:
                execution.profileRepairRerankOpportunity,
            }
          : {}),
        ...(execution.profileRepairRerankSelected !== undefined
          ? { profileRepairRerankSelected: execution.profileRepairRerankSelected }
          : {}),
        ...(execution.profileRepairRerankSuggestedActionID !== undefined
          ? {
              profileRepairRerankSuggestedActionID:
                execution.profileRepairRerankSuggestedActionID,
            }
          : {}),
        ...(execution.profileRepairRerankSuggestedActionKind !== undefined
          ? {
              profileRepairRerankSuggestedActionKind:
                execution.profileRepairRerankSuggestedActionKind,
            }
          : {}),
        ...(execution.profileRepairRerankSuggestedModule !== undefined
          ? {
              profileRepairRerankSuggestedModule:
                execution.profileRepairRerankSuggestedModule,
            }
          : {}),
        ...(execution.profileRepairRerankSelectedReason !== undefined
          ? {
              profileRepairRerankSelectedReason:
                execution.profileRepairRerankSelectedReason,
            }
          : {}),
        ...(execution.profileRepairRerankCandidates !== undefined
          ? {
              profileRepairRerankCandidates:
                execution.profileRepairRerankCandidates,
            }
          : {}),
        ...(planDecision?.rawPlannerOutput !== undefined
          ? { plannerRawOutput: planDecision.rawPlannerOutput }
          : {}),
        ...(planDecision?.promptLength !== undefined
          ? { plannerPromptLength: planDecision.promptLength }
          : {}),
        ...(planDecision?.parseOk !== undefined
          ? { plannerParseOk: planDecision.parseOk }
          : {}),
        ...(planDecision?.parseFailureReason !== undefined
          ? { plannerParseFailureReason: planDecision.parseFailureReason }
          : {}),
        ...(planDecision?.repairUsed !== undefined
          ? { plannerRepairUsed: planDecision.repairUsed }
          : {}),
        ...(planDecision?.repairReason !== undefined
          ? { plannerRepairReason: planDecision.repairReason }
          : {}),
        ...(planDecision?.repairPromptLength !== undefined
          ? { plannerRepairPromptLength: planDecision.repairPromptLength }
          : {}),
        fallbackUsed: false,
      },
    };
  }

  private plannerRefreshReason(input: AgentBrainInput): string | null {
    if (this.currentPlan === null) {
      return "no_active_plan";
    }
    if (this.decisionsSincePlan >= this.currentPlan.maxDecisionCycles) {
      return "plan_max_decision_cycles";
    }
    if (this.decisionsSincePlan >= this.planEveryDecisionSteps) {
      return "brain_plan_interval";
    }
    if (
      this.currentPlan.objective === "expand_territory" &&
      !shouldForceCrowdedNationOpeningExpansion(input) &&
      input.observation.memory.recentExpansionCount >= 1 &&
      (input.observation.objective?.kind === "pressure_rival" ||
        input.observation.strategic.priority === "attack") &&
      hasPlayerPressureAction(input.legalActions)
    ) {
      return "expansion_plan_diverged_to_pressure";
    }
    if (
      this.currentPlan.objective === "pressure_rival" &&
      shouldForceCrowdedNationOpeningExpansion(input)
    ) {
      return "pressure_plan_yielded_to_crowded_growth";
    }
    if (
      this.currentPlan.objective === "expand_territory" &&
      input.observation.strategic.priority === "build_defense" &&
      input.observation.strategic.urgency !== "low"
    ) {
      return "expansion_plan_diverged_to_defense";
    }
    if (input.observation.memory.repeatedActionCount >= 2) {
      return "repeated_action_memory";
    }
    if (
      (input.observation.memory.recentHoldCount ?? 0) >= 2 &&
      hasUsefulNonHoldAction(input.legalActions)
    ) {
      return "hold_streak_with_useful_actions";
    }
    const tactical =
      input.observation.tacticalAffordances ??
      buildAgentTacticalAffordances({
        observation: input.observation,
        legalActions: input.legalActions,
      });
    if (
      input.observation.memory.recentExpansionCount >= 2 &&
      ((tactical.frontierConversionTiming?.recommended === true &&
        tactical.frontierConversionTiming.executorReady === true) ||
        (tactical.frontierFinishPressure?.recommended === true &&
          (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0))
    ) {
      return "tactical_pressure_handoff_ready";
    }
    if (
      this.currentPlan.objective === "expand_territory" &&
      input.observation.memory.recentExpansionCount >= 2 &&
      tactical.openingExpansionTempo?.recommended !== true &&
      hasEconomicBuildAction(input.legalActions)
    ) {
      return "expansion_plan_handoff_to_economy";
    }
    if (input.observation.combat.incomingAttackPlayerIDs.length > 0) {
      return "incoming_attack";
    }
    if (
      this.currentPlan.objective === "build_alliance" &&
      hasPlayerPressureAction(input.legalActions) &&
      (this.options.profile !== "diplomatic" ||
        aliveVisibleOpponentCount(input.observation) <= 1 ||
        input.observation.strategic.priority === "attack" ||
        input.observation.strategic.priority === "build_defense" ||
        isDominantConversionMode(input.observation))
    ) {
      return "alliance_plan_stale";
    }
    if (
      input.observation.strategic.priority === "build_defense" &&
      input.observation.strategic.urgency !== "low" &&
      this.currentPlan.objective !== "fortify_border" &&
      this.currentPlan.objective !== "survive"
    ) {
      return "urgent_defense";
    }
    const currentPlan = this.currentPlan;
    return input.legalActions.some((action) =>
      actionAlignsPlan(action, currentPlan),
    )
      ? null
      : "no_legal_action_matches_plan";
  }
}

function runtimeModeForPlanner(
  plannerSource: StrategicPlan["plannerSource"],
): AgentRuntimeMode {
  if (plannerSource === "rule") {
    return "local-policy-baseline";
  }
  if (plannerSource === "mock-llm") {
    return "mock-policy-planner";
  }
  return "llm-policy-planner";
}

function isExternalPlannerSource(
  plannerSource: StrategicPlan["plannerSource"],
): boolean {
  return plannerSource === "codex-cli" || plannerSource === "real-llm";
}

function defaultExecutorSource(executor: AgentExecutor): string {
  if (executor instanceof FrontierPolicyExecutor) {
    return "frontier-policy-executor";
  }
  if (executor instanceof RuleAgentExecutor) {
    return "rule-agent-executor";
  }
  return "custom-agent-executor";
}

export class RuleAgentPlanner implements AgentPlanner {
  readonly plannerType = "rule" as const;

  constructor(private readonly profile: AgentStrategyProfile) {}

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    const started = Date.now();
    const objective = choosePlanObjective(input, this.profile);
    const plan = strategicPlanForObjective({
      objective,
      input,
      plannerSource: this.plannerType,
      rationale: ruleRationale(objective, input),
      targetPlayerId: reusablePlanTarget(input, previousPlan, objective),
    });
    return {
      plan,
      reason: plan.rationale,
      latencyMs: Date.now() - started,
      fallbackUsed: false,
    };
  }
}

export class RuleAgentExecutor implements AgentExecutor {
  constructor(private readonly profile: AgentStrategyProfile) {}

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    const skillEvaluation = new StrategicSkillEvaluator().evaluate({
      ...input,
      plan,
    });
    const rankedAligned = skillEvaluation.actions
      .filter((action) => {
        const legalAction = input.legalActions.find(
          (candidate) => candidate.id === action.actionID,
        );
        return legalAction !== undefined && actionAlignsPlan(legalAction, plan);
      })
      .sort((a, b) => b.totalScore - a.totalScore);
    const aligned = input.legalActions.find(
      (action) => action.id === rankedAligned[0]?.actionID,
    );
    if (aligned !== undefined) {
      const skill = skillEvaluationForAction(skillEvaluation, aligned.id);
      return {
        actionID: aligned.id,
        reason: `Rule executor selected ${aligned.label} to follow ${plan.objective} using ${skill?.topSkill ?? "strategy"} score ${skill?.totalScore ?? 0}`,
        planFollowed: true,
        selectedSkill: skill?.topSkill,
        selectedSkillScore: skill?.totalScore,
        skillSummary: compactSkillSummary(skillEvaluation),
        alternativesConsidered: skillEvaluation.actions
          .slice(0, 4)
          .map((action) => `${action.actionID}:${action.totalScore}`)
          .join(","),
      };
    }
    const allowed = input.legalActions.filter(
      (action) => !plan.forbiddenActionKinds.includes(action.kind),
    );
    const fallbackInput = {
      observation: input.observation,
      legalActions: allowed.length > 0 ? allowed : input.legalActions,
    };
    const fallback = new RuleAgentBrain(this.profile).decide(fallbackInput);
    const fallbackSkill = skillEvaluationForAction(
      skillEvaluation,
      fallback.actionID,
    );
    return {
      actionID: fallback.actionID,
      reason: `Rule executor used fallback because no legal action aligned with ${plan.objective}; selected ${fallbackSkill?.topSkill ?? "rule"} score ${fallbackSkill?.totalScore ?? 0}`,
      planFollowed: false,
      selectedSkill: fallbackSkill?.topSkill,
      selectedSkillScore: fallbackSkill?.totalScore,
      skillSummary: compactSkillSummary(skillEvaluation),
      alternativesConsidered: skillEvaluation.actions
        .slice(0, 4)
        .map((action) => `${action.actionID}:${action.totalScore}`)
        .join(","),
    };
  }
}

interface FrontierPolicyContribution {
  module: FrontierPolicyModule;
  score: number;
  reason: string;
}

interface FrontierPolicyScore {
  totalScore: number;
  contributions: FrontierPolicyContribution[];
  penalties: string[];
  profileRepairRerank: AgentProfileRepairRerankScore | null;
}

type FrontierSchedulerSlot =
  | "emergency_survival"
  | "spawn_opening"
  | "neutral_expansion"
  | "defensive_structure"
  | "economic_structure"
  | "diplomacy"
  | "combat_pressure"
  | "combat_attack"
  | "naval"
  | "nuclear_endgame"
  | "utility_social";

interface FrontierRankedAction {
  action: LegalAction;
  policy: FrontierPolicyScore;
  skill: ReturnType<typeof skillEvaluationForAction>;
  totalScore: number;
  primaryModule: FrontierPolicyModule;
  schedulerSlot: FrontierSchedulerSlot;
}

const frontierSchedulerOrder: readonly FrontierSchedulerSlot[] = [
  "emergency_survival",
  "spawn_opening",
  "neutral_expansion",
  "defensive_structure",
  "economic_structure",
  "diplomacy",
  "combat_pressure",
  "combat_attack",
  "naval",
  "nuclear_endgame",
  "utility_social",
];

const schedulerSlotModules: Record<
  FrontierSchedulerSlot,
  FrontierPolicyModule
> = {
  emergency_survival: "emergency_survival",
  spawn_opening: "spawn_opening",
  neutral_expansion: "expansion",
  defensive_structure: "defense",
  economic_structure: "economy",
  diplomacy: "diplomacy",
  combat_pressure: "combat",
  combat_attack: "combat",
  naval: "naval",
  nuclear_endgame: "nuclear_endgame",
  utility_social: "utility_social",
};

const schedulerSlotThresholds: Record<FrontierSchedulerSlot, number> = {
  emergency_survival: 28,
  spawn_opening: 10,
  neutral_expansion: 38,
  defensive_structure: 40,
  economic_structure: 40,
  diplomacy: 38,
  combat_pressure: 40,
  combat_attack: 42,
  naval: 42,
  nuclear_endgame: 40,
  utility_social: 55,
};

export class FrontierPolicyExecutor implements AgentExecutor {
  private readonly baseSettings: AgentSettings;

  constructor(
    private readonly profile: AgentStrategyProfile,
    options: { settings?: Partial<AgentSettings>; seed?: string } = {},
  ) {
    this.baseSettings = resolveAgentSettings(
      profile,
      options.settings,
      options.seed ?? profile,
    );
  }

  decide(input: AgentBrainInput, plan: StrategicPlan): AgentExecutionDecision {
    if (input.legalActions.length === 0) {
      return {
        actionID: "hold",
        reason:
          "Frontier policy had no legal actions, so it requested hold fallback",
        planFollowed: false,
      };
    }

    const settings = applyTacticalSettings(
      this.baseSettings,
      plan.tacticalSettings,
    );
    const skillEvaluation = new StrategicSkillEvaluator().evaluate({
      ...input,
      plan,
    });
    const scored: FrontierRankedAction[] = input.legalActions
      .map((action) => {
        const policy = scoreFrontierAction({
          input,
          plan,
          action,
          settings,
          profile: this.profile,
        });
        const skill = skillEvaluationForAction(skillEvaluation, action.id);
        const skillScore = skill?.totalScore ?? 0;
        const totalScore = clampScore(
          policy.totalScore + Math.round(skillScore * 0.28),
        );
        const primaryModule = primaryPolicyModule(policy, action);
        return {
          action,
          policy,
          skill,
          totalScore,
          primaryModule,
          schedulerSlot: schedulerSlotForAction(action, primaryModule),
        };
      })
      .sort(
        (a, b) =>
          b.totalScore - a.totalScore ||
          frontierActionTieBreak(a.action) - frontierActionTieBreak(b.action) ||
          frontierActionIntensityTieBreak(a.action, b.action) ||
          a.action.id.localeCompare(b.action.id),
      );

    const selectedBatch = selectFrontierActionBatch({
      input,
      plan,
      settings,
      scored,
    });
    const selected = selectedBatch[0] ?? scored[0];
    const profileRepairRerank = profileRepairRerankAudit(scored, selectedBatch);
    const topContributions = selectedBatch
      .map(
        (candidate) =>
          `${candidate.schedulerSlot}:${candidate.action.kind}/${candidate.totalScore}`,
      )
      .join(",");
    const penalties =
      selected.policy.penalties.length > 0
        ? ` penalties=${selected.policy.penalties.join("|")}`
        : "";
    const skillText = selected.skill
      ? ` skill=${selected.skill.topSkill}/${selected.skill.totalScore}`
      : " skill=none";
    const blockedHostileSummary = blockedHostileAttackSummary(scored);
    const contextText = holdContextText({
      selected,
      input,
      blockedHostileSummary,
    });
    const holdReasonCategory = holdReasonCategoryForSelected({
      selected,
      input,
      blockedHostileSummary,
    });
    return {
      actionID: selected.action.id,
      ...(selectedBatch.length > 1
        ? { actionIDs: selectedBatch.map((candidate) => candidate.action.id) }
        : {}),
      reason: `Frontier module scheduler queued ${selectedBatch.length} action(s), primary ${selected.action.label} total=${selected.totalScore} schedule=${topContributions}${skillText}${penalties}${contextText}`,
      planFollowed: selectedBatch.some((candidate) =>
        actionAlignsPlan(candidate.action, plan),
      ),
      selectedSkill: selected.skill?.topSkill,
      selectedSkillScore: selected.skill?.totalScore,
      skillSummary: compactSkillSummary(skillEvaluation),
      alternativesConsidered: scored
        .slice(0, 6)
        .map((candidate) => `${candidate.action.id}:${candidate.totalScore}`)
        .join(","),
      blockedHostileAttackSummary: blockedHostileSummary,
      ...(holdReasonCategory !== undefined ? { holdReasonCategory } : {}),
      selectedModules: selectedBatch
        .map(
          (candidate) =>
            `${candidate.schedulerSlot}:${candidate.primaryModule}`,
        )
        .join(","),
      ...profileRepairRerank,
    };
  }
}

function profileRepairRerankAudit(
  scored: FrontierRankedAction[],
  selectedBatch: FrontierRankedAction[],
): Pick<
  AgentExecutionDecision,
  | "profileRepairRerankOpportunity"
  | "profileRepairRerankSelected"
  | "profileRepairRerankSuggestedActionID"
  | "profileRepairRerankSuggestedActionKind"
  | "profileRepairRerankSuggestedModule"
  | "profileRepairRerankSelectedReason"
  | "profileRepairRerankCandidates"
> {
  const positiveCandidates = scored.filter(
    (candidate) => (candidate.policy.profileRepairRerank?.score ?? 0) > 0,
  );
  if (positiveCandidates.length === 0) {
    return {};
  }
  const suggested = positiveCandidates[0]!;
  const selectedRepair = selectedBatch.find(
    (candidate) => (candidate.policy.profileRepairRerank?.score ?? 0) > 0,
  );
  const selectedPrimary = selectedBatch[0];
  const selectedReason =
    selectedRepair?.policy.profileRepairRerank?.reason ??
    selectedPrimary?.policy.profileRepairRerank?.penaltyReason;
  return {
    profileRepairRerankOpportunity: true,
    profileRepairRerankSelected: selectedRepair !== undefined,
    profileRepairRerankSuggestedActionID: suggested.action.id,
    profileRepairRerankSuggestedActionKind: suggested.action.kind,
    profileRepairRerankSuggestedModule:
      suggested.policy.profileRepairRerank?.module,
    ...(selectedReason !== undefined
      ? { profileRepairRerankSelectedReason: selectedReason }
      : {}),
    profileRepairRerankCandidates: positiveCandidates
      .slice(0, 4)
      .map(
        (candidate) =>
          `${candidate.action.id}:${candidate.policy.profileRepairRerank?.score ?? 0}`,
      )
      .join(","),
  };
}

function holdContextText(input: {
  selected: FrontierRankedAction;
  input: AgentBrainInput;
  blockedHostileSummary: string;
}): string {
  if (input.selected.action.kind !== "hold") {
    return "";
  }
  if (
    input.input.observation.combat.attackablePlayerIDs.length === 0 &&
    (input.input.observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return " context=waiting for active transport to land before launching another action";
  }
  if (input.blockedHostileSummary !== "") {
    return ` context=hostile attacks offered but blocked by safety policy (${input.blockedHostileSummary})`;
  }
  if (!hasMapProgressLegalAction(input.input.legalActions)) {
    return " context=no map-progress action is legal; avoiding support or diplomacy busy-work";
  }
  return "";
}

function holdReasonCategoryForSelected(input: {
  selected: FrontierRankedAction;
  input: AgentBrainInput;
  blockedHostileSummary: string;
}): string | undefined {
  if (input.selected.action.kind !== "hold") {
    return undefined;
  }
  if (
    input.input.observation.combat.attackablePlayerIDs.length === 0 &&
    (input.input.observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return "transport_wait";
  }
  if (input.blockedHostileSummary !== "") {
    return "attack_safety";
  }
  if (
    input.input.observation.nonCombat.supportOptions.length > 0 &&
    !hasMapProgressLegalAction(input.input.legalActions)
  ) {
    return "support_cooldown";
  }
  if (!hasUsefulNonHoldAction(input.input.legalActions)) {
    return "no_safe_non_hold";
  }
  return "unexplained";
}

function hasMapProgressLegalAction(actions: readonly LegalAction[]): boolean {
  return actions.some(
    (action) =>
      action.kind === "attack" ||
      action.kind === "boat" ||
      action.kind === "build" ||
      action.kind === "upgrade_structure" ||
      action.kind === "retreat" ||
      action.kind === "boat_retreat" ||
      action.kind === "warship" ||
      action.kind === "move_warship" ||
      action.kind === "nuke",
  );
}

export class MockLlmPlanner implements AgentPlanner {
  readonly plannerType = "mock-llm" as const;

  constructor(private readonly profile: AgentStrategyProfile) {}

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    const rule = await new RuleAgentPlanner(this.profile).plan(
      input,
      previousPlan,
    );
    return {
      ...rule,
      plan: {
        ...rule.plan,
        plannerSource: this.plannerType,
        rationale: `Mock planner chose ${rule.plan.objective}: ${rule.plan.rationale}`,
      },
      rawPlannerOutput: JSON.stringify({
        objective: rule.plan.objective,
        turnIntent: resolvedPlanTurnIntent(input, rule.plan),
        rationale: rule.plan.rationale,
        maxDecisionCycles: rule.plan.maxDecisionCycles,
        preferredActionKinds: rule.plan.preferredActionKinds,
        enabledModules: rule.plan.enabledModules,
      }),
      parseOk: true,
    };
  }
}

export class LlmAgentPlanner implements AgentPlanner {
  readonly plannerType: "codex-cli" | "real-llm";

  constructor(
    private readonly options: {
      provider: LlmProvider;
      profile: AgentStrategyProfile;
      providerTimeoutMs?: number;
      plannerType: "codex-cli" | "real-llm";
    },
  ) {
    this.plannerType = options.plannerType;
  }

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    const started = Date.now();
    const decisionBrief = plannerDecisionBrief(input, previousPlan);
    const prompt = plannerPrompt(input, previousPlan, decisionBrief);
    let raw = "";
    try {
      raw = await withTimeout(
        this.options.provider.complete(prompt),
        this.options.providerTimeoutMs ?? 30_000,
      );
      const parsed = parsePlannerOutput(raw, input.legalActions);
      if (parsed.ok) {
        const controlViolation = mustFollowControlViolation(
          parsed,
          decisionBrief.plannerGuidance.recommendedControls,
          input.legalActions,
        );
        if (controlViolation !== null) {
          const repairPrompt = plannerRepairPrompt({
            controls: decisionBrief.plannerGuidance.recommendedControls,
            rawOutput: raw,
            violation: controlViolation,
          });
          const repairedRaw = await withTimeout(
            this.options.provider.complete(repairPrompt),
            this.options.providerTimeoutMs ?? 30_000,
          );
          const repaired = parsePlannerOutput(repairedRaw, input.legalActions);
          if (repaired.ok) {
            const repairedViolation = mustFollowControlViolation(
              repaired,
              decisionBrief.plannerGuidance.recommendedControls,
              input.legalActions,
            );
            if (repairedViolation === null) {
              return {
                plan: strategicPlanForObjective({
                  objective: repaired.objective,
                  turnIntent: repaired.turnIntent,
                  input,
                  plannerSource: this.plannerType,
                  rationale: repaired.rationale,
                  preferredActionKinds: repaired.preferredActionKinds,
                  enabledModules: repaired.enabledModules,
                  maxDecisionCycles: repaired.maxDecisionCycles,
                  targetPlayerId: repaired.targetPlayerId,
                  tacticalSettings: repaired.tacticalSettings,
                }),
                reason: repaired.rationale,
                latencyMs: Date.now() - started,
                fallbackUsed: false,
                rawPlannerOutput: `${raw}\n\nREPAIR_OUTPUT:\n${repairedRaw}`,
                promptLength: prompt.length,
                parseOk: true,
                repairUsed: true,
                repairReason: controlViolation,
                repairPromptLength: repairPrompt.length,
              };
            }
            return this.fallback(
              input,
              previousPlan,
              started,
              `${raw}\n\nREPAIR_OUTPUT:\n${repairedRaw}`,
              `planner repair still contradicted must-follow control: ${repairedViolation}`,
              prompt.length + repairPrompt.length,
            );
          }
          return this.fallback(
            input,
            previousPlan,
            started,
            `${raw}\n\nREPAIR_OUTPUT:\n${repairedRaw}`,
            `planner repair JSON invalid after must-follow violation (${controlViolation}): ${repaired.reason}`,
            prompt.length + repairPrompt.length,
          );
        }
        return {
          plan: strategicPlanForObjective({
            objective: parsed.objective,
            turnIntent: parsed.turnIntent,
            input,
            plannerSource: this.plannerType,
            rationale: parsed.rationale,
            preferredActionKinds: parsed.preferredActionKinds,
            enabledModules: parsed.enabledModules,
            maxDecisionCycles: parsed.maxDecisionCycles,
            targetPlayerId: parsed.targetPlayerId,
            tacticalSettings: parsed.tacticalSettings,
          }),
          reason: parsed.rationale,
          latencyMs: Date.now() - started,
          fallbackUsed: false,
          rawPlannerOutput: raw,
          promptLength: prompt.length,
          parseOk: true,
        };
      }
      return this.fallback(
        input,
        previousPlan,
        started,
        raw,
        parsed.reason,
        prompt.length,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.fallback(
        input,
        previousPlan,
        started,
        raw,
        reason,
        prompt.length,
      );
    }
  }

  private async fallback(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
    started: number,
    raw: string,
    reason: string,
    promptLength: number,
  ): Promise<AgentPlanDecision> {
    const fallback = await new RuleAgentPlanner(this.options.profile).plan(
      input,
      previousPlan,
    );
    return {
      ...fallback,
      plan: { ...fallback.plan, plannerSource: this.plannerType },
      reason: `Planner fallback after LLM planner failed: ${reason}`,
      latencyMs: Date.now() - started,
      fallbackUsed: true,
      // This fallback only runs for an LLM-backed planner (codex-cli/real-llm)
      // whose LLM planner call failed: the match is now running on local policy,
      // NOT LLM-controlled. Flag it so artifacts/audits can detect a degraded match.
      llmPlannerDegraded: true,
      rawPlannerOutput: raw,
      promptLength,
      parseOk: false,
      parseFailureReason: reason,
    };
  }
}

function resolveAgentSettings(
  profile: AgentStrategyProfile,
  overrides: Partial<AgentSettings> | undefined,
  seed: string,
): AgentSettings {
  const profileWeights = {
    ...defaultAgentSettings.profileWeights,
    ...(overrides?.profileWeights ?? {}),
  };
  const base: AgentSettings = {
    ...defaultAgentSettings,
    ...overrides,
    seed: overrides?.seed ?? seed,
    profileWeights,
  };
  return {
    ...base,
    reserveRatio: varyRatio(
      base.reserveRatio,
      `${base.seed}:${profile}:reserve`,
      0.08,
    ),
    triggerRatio: varyRatio(
      base.triggerRatio,
      `${base.seed}:${profile}:trigger`,
      0.06,
    ),
    expansionRatio: varyRatio(
      base.expansionRatio,
      `${base.seed}:${profile}:expansion`,
      0.08,
    ),
    retreatThreshold: varyRatio(
      base.retreatThreshold,
      `${base.seed}:${profile}:retreat`,
      0.06,
    ),
    maxConcurrentWars: Math.max(
      1,
      Math.min(3, Math.round(base.maxConcurrentWars)),
    ),
    maxActionsPerDecision: Math.max(
      1,
      Math.min(8, Math.round(base.maxActionsPerDecision)),
    ),
  };
}

function applyTacticalSettings(
  settings: AgentSettings,
  tactical: AgentTacticalSettings | undefined,
): AgentSettings {
  if (tactical === undefined) {
    return settings;
  }
  return {
    ...settings,
    reserveRatio: clampRatio(
      tactical.reserveRatio ?? settings.reserveRatio,
      0.1,
      0.8,
    ),
    triggerRatio: clampRatio(
      tactical.triggerRatio ?? settings.triggerRatio,
      0.2,
      1,
    ),
    expansionRatio: clampRatio(
      tactical.expansionRatio ?? settings.expansionRatio,
      0.05,
      0.4,
    ),
    retreatThreshold: clampRatio(
      tactical.retreatThreshold ?? settings.retreatThreshold,
      0.1,
      0.8,
    ),
    maxConcurrentWars: Math.max(
      1,
      Math.min(
        3,
        Math.round(tactical.maxConcurrentWars ?? settings.maxConcurrentWars),
      ),
    ),
    maxActionsPerDecision: Math.max(
      1,
      Math.min(
        8,
        Math.round(
          tactical.maxActionsPerDecision ?? settings.maxActionsPerDecision,
        ),
      ),
    ),
  };
}

function selectFrontierActionBatch(input: {
  input: AgentBrainInput;
  plan: StrategicPlan;
  settings: AgentSettings;
  scored: FrontierRankedAction[];
}): FrontierRankedAction[] {
  const { scored, plan, settings } = input;
  const first = scored[0];
  if (first === undefined) {
    return [];
  }

  const spawn = scored.find((candidate) => candidate.action.kind === "spawn");
  if (input.input.observation.phase === "spawn" || spawn !== undefined) {
    return [
      bestSpawnCandidate(scored, input.input.observation) ?? spawn ?? first,
    ];
  }

  const enabledModules = new Set(
    plan.enabledModules ?? enabledModulesForPlan(plan),
  );
  enabledModules.add("emergency_survival");
  enabledModules.add("utility_social");
  if (
    isHardNationScrum(input.input.observation) &&
    input.input.observation.strategic.priority === "build_defense" &&
    input.input.observation.strategic.urgency === "high"
  ) {
    enabledModules.add("diplomacy");
  }
  if (hardNationBufferSupportTargetID(input.input) !== null) {
    enabledModules.add("diplomacy");
  }
  const maxActions = Math.max(1, Math.min(8, settings.maxActionsPerDecision));
  const selected: FrontierRankedAction[] = [];
  const shouldPrioritizeDiversifier =
    shouldRotateOpeningExpansion(input.input) &&
    hasCompetitiveExpansionDiversifier(scored, plan);
  const earlyRepeatedPressureProbeEscalation =
    repeatedPressureProbeEscalationCandidate(input.input, plan, scored);
  if (earlyRepeatedPressureProbeEscalation !== undefined) {
    return [earlyRepeatedPressureProbeEscalation];
  }
  const criticalHomeCollapseRecovery = directSelectionCandidate(
    criticalHomeCollapseRecoveryCandidate(input.input, plan, scored),
  );
  if (criticalHomeCollapseRecovery !== undefined) {
    return [criticalHomeCollapseRecovery];
  }
  const survivalPanicProbeRecovery = directSelectionCandidate(
    survivalPanicProbeRecoveryCandidate(input.input, plan, scored),
  );
  if (survivalPanicProbeRecovery !== undefined) {
    return [survivalPanicProbeRecovery];
  }
  const hardNationOpeningForceExpansion = directSelectionCandidate(
    hardNationOpeningForceExpansionCandidate(input.input, scored),
  );
  if (hardNationOpeningForceExpansion !== undefined) {
    return [hardNationOpeningForceExpansion];
  }
  const demoQualityWeakNeighborPressure = directSelectionCandidate(
    demoQualityWeakNeighborPressureCandidate(input.input, plan, scored),
    { allowPlannerForbidden: true },
  );
  if (demoQualityWeakNeighborPressure !== undefined) {
    return combatFollowThroughBatch(
      demoQualityWeakNeighborPressure,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const demoQualityEconomyHandoff = directSelectionCandidate(
    demoQualityEconomyHandoffCandidate(input.input, plan, scored),
    { allowPlannerForbidden: true },
  );
  if (demoQualityEconomyHandoff !== undefined) {
    return [demoQualityEconomyHandoff];
  }
  const earlyNeutralIslandRush = directSelectionCandidate(
    earlyNeutralIslandRushCandidate(input.input, plan, settings, scored),
    { allowPlannerForbidden: true },
  );
  if (earlyNeutralIslandRush !== undefined) {
    return territoryMaximizerBatch(
      earlyNeutralIslandRush,
      scored,
      plan,
      maxActions,
      input.input.observation,
      settings,
    );
  }
  const neutralTerritoryMaximizer = directSelectionCandidate(
    neutralTerritoryMaximizerCandidate(input.input, plan, settings, scored),
    { allowPlannerForbidden: true },
  );
  if (neutralTerritoryMaximizer !== undefined) {
    return territoryMaximizerBatch(
      neutralTerritoryMaximizer,
      scored,
      plan,
      maxActions,
      input.input.observation,
      settings,
    );
  }
  const politicalPact = directSelectionCandidate(
    agentOnlyPoliticalPactCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (politicalPact !== undefined) {
    return politicalShowcaseBatch(
      politicalPact,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const politicalIntrigue = directSelectionCandidate(
    agentOnlyPoliticalIntrigueCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (politicalIntrigue !== undefined) {
    return politicalShowcaseBatch(
      politicalIntrigue,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const politicalNuclearEscalation = directSelectionCandidate(
    agentOnlyPoliticalNuclearCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (politicalNuclearEscalation !== undefined) {
    return politicalShowcaseBatch(
      politicalNuclearEscalation,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const politicalInfrastructure = directSelectionCandidate(
    agentOnlyPoliticalInfrastructureCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (politicalInfrastructure !== undefined) {
    return politicalShowcaseBatch(
      politicalInfrastructure,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const nuclearDeterrenceBuild = directSelectionCandidate(
    nuclearDeterrenceInfrastructureCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (nuclearDeterrenceBuild !== undefined) {
    return [nuclearDeterrenceBuild];
  }
  const nuclearStrike = directSelectionCandidate(
    nuclearEndgameStrikeCandidate(input.input, scored, settings),
    { allowPlannerForbidden: true },
  );
  if (nuclearStrike !== undefined) {
    return [nuclearStrike];
  }
  const humanReplayConversionCommit = directSelectionCandidate(
    humanReplayConversionCommitCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (humanReplayConversionCommit !== undefined) {
    return [humanReplayConversionCommit];
  }
  const earlyFrontierConversionTiming = directSelectionCandidate(
    strongFrontierConversionHandoffCandidate(
      input.input,
      scored,
      plan,
      settings,
    ),
  );
  if (earlyFrontierConversionTiming !== undefined) {
    return [earlyFrontierConversionTiming];
  }
  const reserveSafeFrontierConversion = directSelectionCandidate(
    reserveSafeFrontierConversionProbeCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (reserveSafeFrontierConversion !== undefined) {
    return [reserveSafeFrontierConversion];
  }
  const earlyTransportTroopBanking = directSelectionCandidate(
    transportTroopBankingCandidate(input.input, plan, settings, scored),
    { allowPlannerForbidden: true },
  );
  if (earlyTransportTroopBanking !== undefined) {
    return [earlyTransportTroopBanking];
  }
  const earlyNavalControl = directSelectionCandidate(
    navalControlCandidate(input.input, plan, settings, scored),
  );
  if (earlyNavalControl !== undefined) {
    return [earlyNavalControl];
  }
  const earlyFrontierFinishPressure = directSelectionCandidate(
    frontierFinishPressureAttackCandidate(input.input, scored, settings),
  );
  if (earlyFrontierFinishPressure !== undefined) {
    return combatFollowThroughBatch(
      earlyFrontierFinishPressure,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const repeatedProbeRecovery = directSelectionCandidate(
    repeatedLowProbeRecoveryCandidate(input.input, plan, settings, scored),
  );
  if (repeatedProbeRecovery !== undefined) {
    return neutralPriorityBatch(
      repeatedProbeRecovery,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const earlyNeutralBoatTempo = directSelectionCandidate(
    earlyNeutralBoatTempoCandidate(input.input, plan, settings, scored),
  );
  if (earlyNeutralBoatTempo !== undefined) {
    return [earlyNeutralBoatTempo];
  }
  const lowShareNeutralCatchUp = directSelectionCandidate(
    lowShareNeutralCatchUpCandidate(input.input, settings, scored),
  );
  if (lowShareNeutralCatchUp !== undefined) {
    return [lowShareNeutralCatchUp];
  }
  const standingNeutralLandGrab = directSelectionCandidate(
    standingNeutralLandGrabCandidate(input.input, plan, settings, scored),
  );
  if (standingNeutralLandGrab !== undefined) {
    return neutralPriorityBatch(
      standingNeutralLandGrab,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const hardNationOpeningBroadTargetProbe = directSelectionCandidate(
    hardNationOpeningBroadTargetProbeCandidate(input.input, scored),
  );
  if (hardNationOpeningBroadTargetProbe !== undefined) {
    return [hardNationOpeningBroadTargetProbe];
  }
  const hardNationOpeningReserveDiscipline = directSelectionCandidate(
    hardNationOpeningReserveDisciplineCandidate(input.input, scored),
  );
  if (hardNationOpeningReserveDiscipline !== undefined) {
    return [hardNationOpeningReserveDiscipline];
  }
  const openingNeutralRush = directSelectionCandidate(
    openingNeutralRushCandidate(input.input, plan, settings, scored),
  );
  if (openingNeutralRush !== undefined) {
    return [openingNeutralRush];
  }
  const openingExpansionTempo = directSelectionCandidate(
    openingExpansionTempoCandidate(input.input, plan, settings, scored),
  );
  if (openingExpansionTempo !== undefined) {
    enabledModules.add("expansion");
  }
  if (openingExpansionTempo !== undefined && maxActions <= 1) {
    return [openingExpansionTempo];
  }
  const transportTroopBanking = directSelectionCandidate(
    transportTroopBankingCandidate(input.input, plan, settings, scored),
    { allowPlannerForbidden: true },
  );
  if (transportTroopBanking !== undefined) {
    return [transportTroopBanking];
  }
  const navalControl = directSelectionCandidate(
    navalControlCandidate(input.input, plan, settings, scored),
  );
  if (navalControl !== undefined) {
    return [navalControl];
  }
  const hardNationBoxedEscapeTransport = directSelectionCandidate(
    hardNationBoxedEscapeTransportCandidate(input.input, scored),
  );
  if (hardNationBoxedEscapeTransport !== undefined) {
    return [hardNationBoxedEscapeTransport];
  }
  const standingNeutralIslandBoat = directSelectionCandidate(
    standingNeutralIslandBoatCandidate(input.input, plan, settings, scored),
  );
  if (standingNeutralIslandBoat !== undefined) {
    return neutralPriorityBatch(
      standingNeutralIslandBoat,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const humanReplayEconomyFoundation = directSelectionCandidate(
    humanReplayEconomyFoundationCandidate(input.input, plan, settings, scored),
  );
  if (humanReplayEconomyFoundation !== undefined) {
    return [humanReplayEconomyFoundation];
  }
  const repeatedPressureProbeRecovery = directSelectionCandidate(
    repeatedPressureProbeRecoveryCandidate(input.input, plan, scored),
  );
  if (repeatedPressureProbeRecovery !== undefined) {
    return [repeatedPressureProbeRecovery];
  }
  const urgentFortify = directSelectionCandidate(
    urgentFortifyPlanCandidate(input.input, plan, scored, settings),
  );
  if (urgentFortify !== undefined && openingExpansionTempo === undefined) {
    return [urgentFortify];
  }
  const hardNationFrontRecovery = directSelectionCandidate(
    hardNationFrontRecoveryCandidate(input.input, scored),
  );
  if (hardNationFrontRecovery !== undefined) {
    return [hardNationFrontRecovery];
  }
  const frontierFinishPressure = directSelectionCandidate(
    frontierFinishPressureAttackCandidate(input.input, scored, settings),
  );
  if (frontierFinishPressure !== undefined) {
    return combatFollowThroughBatch(
      frontierFinishPressure,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const frontierConversionTiming = directSelectionCandidate(
    frontierConversionTimingAttackCandidate(input.input, scored, plan),
  );
  if (frontierConversionTiming !== undefined) {
    return combatFollowThroughBatch(
      frontierConversionTiming,
      scored,
      plan,
      maxActions,
      input.input.observation,
    );
  }
  const repeatedHoldCommunication = directSelectionCandidate(
    demoQualityRepeatedHoldCommunicationCandidate(input.input, scored),
    { allowPlannerForbidden: true },
  );
  if (repeatedHoldCommunication !== undefined) {
    return [repeatedHoldCommunication];
  }
  const turnIntentPriority = directSelectionCandidate(
    turnIntentPriorityCandidate(input.input, plan, scored),
  );
  if (turnIntentPriority !== undefined) {
    return [turnIntentPriority];
  }
  const hardNationWeakSideConquest = directSelectionCandidate(
    hardNationWeakSideConquestCandidate(input.input, scored),
  );
  const hardNationStaleLeaderSideConversion = directSelectionCandidate(
    hardNationStaleLeaderProbeSideConversionCandidate(input.input, scored),
  );
  if (hardNationStaleLeaderSideConversion !== undefined) {
    return [hardNationStaleLeaderSideConversion];
  }
  const hardNationTacticalController = directSelectionCandidate(
    hardNationTacticalControllerCandidate(input.input, plan, scored),
  );
  if (hardNationTacticalController !== undefined) {
    return [hardNationTacticalController];
  }
  const hardNationBreakFrontFollowThrough = directSelectionCandidate(
    hardNationBreakFrontFollowThroughCandidate(input.input, scored),
  );
  if (hardNationBreakFrontFollowThrough !== undefined) {
    return [hardNationBreakFrontFollowThrough];
  }
  const hardNationEndgameLeaderStrike = directSelectionCandidate(
    hardNationEndgameLeaderStrikeCandidate(input.input, scored),
  );
  if (hardNationEndgameLeaderStrike !== undefined) {
    return [hardNationEndgameLeaderStrike];
  }
  const hardNationMajorTargetPressure = directSelectionCandidate(
    hardNationMajorTargetPressureCandidate(input.input, plan, scored),
  );
  if (hardNationMajorTargetPressure !== undefined) {
    return [hardNationMajorTargetPressure];
  }
  const hardNationAttackWaveCooldown = directSelectionCandidate(
    hardNationAttackWaveCooldownCandidate(input.input, scored),
  );
  if (hardNationAttackWaveCooldown !== undefined) {
    return [hardNationAttackWaveCooldown];
  }
  const hardNationSingleFrontPressure = directSelectionCandidate(
    hardNationSingleFrontPressureAttackCandidate(input.input, scored),
  );
  if (hardNationSingleFrontPressure !== undefined) {
    return [hardNationSingleFrontPressure];
  }
  const hardNationEndgameAllianceBreak = directSelectionCandidate(
    hardNationEndgameAllianceBreakCandidate(input.input, plan, scored),
  );
  if (hardNationEndgameAllianceBreak !== undefined) {
    return [hardNationEndgameAllianceBreak];
  }
  const hardNationLargeBaseFocusedPressure = directSelectionCandidate(
    hardNationLargeBaseFocusedPressureCandidate(input.input, scored),
  );
  if (hardNationLargeBaseFocusedPressure !== undefined) {
    return [hardNationLargeBaseFocusedPressure];
  }
  const hardNationDuelFinishAttack = directSelectionCandidate(
    hardNationDuelFinishAttackCandidate(input.input, scored),
  );
  if (hardNationDuelFinishAttack !== undefined) {
    return [hardNationDuelFinishAttack];
  }
  const hardNationDuelFinishHold = directSelectionCandidate(
    hardNationDuelFinishHoldCandidate(input.input, scored),
  );
  if (hardNationDuelFinishHold !== undefined) {
    return [hardNationDuelFinishHold];
  }
  const hardNationStalledFrontConversion = directSelectionCandidate(
    hardNationStalledFrontConversionCandidate(input.input, scored),
  );
  if (hardNationStalledFrontConversion !== undefined) {
    return [hardNationStalledFrontConversion];
  }
  const hardNationTinyRivalFinish = directSelectionCandidate(
    hardNationTinyRivalFinishCandidate(input.input, scored),
  );
  if (hardNationTinyRivalFinish !== undefined) {
    return [hardNationTinyRivalFinish];
  }
  const hardNationLargeRivalFeedAvoidance = directSelectionCandidate(
    hardNationLargeRivalFeedAvoidanceCandidate(input.input, scored),
  );
  if (hardNationLargeRivalFeedAvoidance !== undefined) {
    return [hardNationLargeRivalFeedAvoidance];
  }
  const hardNationEarlyRetreatRecovery = directSelectionCandidate(
    hardNationEarlyRetreatRecoveryCandidate(input.input, scored),
  );
  if (hardNationEarlyRetreatRecovery !== undefined) {
    return [hardNationEarlyRetreatRecovery];
  }
  const hardNationPacedFrontProbe = directSelectionCandidate(
    hardNationPacedFrontProbeCandidate(input.input, scored),
  );
  if (hardNationPacedFrontProbe !== undefined) {
    return [hardNationPacedFrontProbe];
  }
  const hardNationBoxedBreakoutProbe = directSelectionCandidate(
    hardNationBoxedBreakoutProbeCandidate(input.input, scored),
  );
  if (hardNationBoxedBreakoutProbe !== undefined) {
    return [hardNationBoxedBreakoutProbe];
  }
  const hardNationUnderdogFocusedConquest = directSelectionCandidate(
    hardNationUnderdogFocusedConquestCandidate(input.input, scored),
  );
  if (hardNationUnderdogFocusedConquest !== undefined) {
    return [hardNationUnderdogFocusedConquest];
  }
  const hardNationBoxedDefensePost = directSelectionCandidate(
    hardNationBoxedDefensePostCandidate(input.input, scored),
  );
  if (hardNationBoxedDefensePost !== undefined) {
    return [hardNationBoxedDefensePost];
  }
  const hardNationEarlyWeakSideProbe = directSelectionCandidate(
    hardNationEarlyWeakSideProbeCandidate(input.input, scored),
  );
  if (hardNationEarlyWeakSideProbe !== undefined) {
    return [hardNationEarlyWeakSideProbe];
  }
  const hardNationWeakenedRivalFinish = directSelectionCandidate(
    hardNationWeakenedRivalFinishCandidate(input.input, scored),
  );
  if (hardNationWeakenedRivalFinish !== undefined) {
    return [hardNationWeakenedRivalFinish];
  }
  const hardNationStalledNeutralTransport = scored
    .filter(
      (candidate) =>
        candidate.action.kind === "boat" &&
        isNeutralBoatAction(candidate.action) &&
        candidate.totalScore >= 80 &&
        hasPolicyContribution(
          candidate,
          "stalled island expansion needs a neutral transport path",
        ),
    )
    .sort((a, b) => {
      const ownTroops =
        input.input.observation.combat.ownTroops ??
        input.input.observation.ownState?.troops ??
        0;
      return (
        committedTroopRatio(b.action, ownTroops) -
          committedTroopRatio(a.action, ownTroops) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
  if (hardNationStalledNeutralTransport !== undefined) {
    return [hardNationStalledNeutralTransport];
  }
  if (hardNationWeakSideConquest !== undefined) {
    return [hardNationWeakSideConquest];
  }
  const hardNationSideConquest = scored.find(
    (candidate) =>
      candidate.totalScore >= 80 &&
      hasPolicyContribution(
        candidate,
        "hard-nation side conquest converts weaker frontier before leader race",
      ) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      !isBlockedRepeatedLowProbeCandidate(candidate) &&
      !isUnsafeUrgentDefenseAttackCandidate(candidate),
  );
  if (hardNationSideConquest !== undefined) {
    return [hardNationSideConquest];
  }
  const hardNationDefensiveLeaderCounter = directSelectionCandidate(
    hardNationDefensiveLeaderCounterattackCandidate(input.input, scored),
  );
  if (hardNationDefensiveLeaderCounter !== undefined) {
    return [hardNationDefensiveLeaderCounter];
  }
  const hardNationTransportRepath = scored.find(
    (candidate) =>
      candidate.action.kind === "boat" &&
      candidate.totalScore >= 80 &&
      !recentAcceptedActionKind(input.input.observation, "boat", 4) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      (hasPolicyContribution(
        candidate,
        "hard-nation side transport opens a safer conquest front",
      ) ||
        hasPolicyContribution(
          candidate,
          "hard-nation flank transport opens side conquest",
        )),
  );
  if (hardNationTransportRepath !== undefined) {
    return [hardNationTransportRepath];
  }
  const hardNationHighValueTransport = directSelectionCandidate(
    hardNationHighValueTransportCandidate(input.input, scored),
  );
  if (hardNationHighValueTransport !== undefined) {
    return [hardNationHighValueTransport];
  }
  const hardNationSideTransport = directSelectionCandidate(
    hardNationSideTransportCandidate(input.input, scored),
  );
  if (hardNationSideTransport !== undefined) {
    return [hardNationSideTransport];
  }
  const hardNationFlankTransport = directSelectionCandidate(
    hardNationFlankTransportCandidate(input.input, scored),
  );
  if (hardNationFlankTransport !== undefined) {
    return [hardNationFlankTransport];
  }
  const hardNationBoxedIncomingCounter = directSelectionCandidate(
    hardNationBoxedIncomingCounterattackCandidate(input.input, scored),
  );
  if (hardNationBoxedIncomingCounter !== undefined) {
    return [hardNationBoxedIncomingCounter];
  }
  const hardNationBoxedWeakSideBreakout = directSelectionCandidate(
    hardNationBoxedWeakSideBreakoutCandidate(input.input, scored),
  );
  if (hardNationBoxedWeakSideBreakout !== undefined) {
    return [hardNationBoxedWeakSideBreakout];
  }
  const hardNationStabilizedBoxBreakout = directSelectionCandidate(
    hardNationStabilizedBoxBreakoutCandidate(input.input, scored),
  );
  if (hardNationStabilizedBoxBreakout !== undefined) {
    return [hardNationStabilizedBoxBreakout];
  }
  const hardNationDecisiveLeaderPressure = directSelectionCandidate(
    hardNationDecisiveLeaderPressureCandidate(input.input, scored),
  );
  if (hardNationDecisiveLeaderPressure !== undefined) {
    return [hardNationDecisiveLeaderPressure];
  }
  const hardNationLeaderBlockedSideConversion =
    hardNationLeaderBlockedSideConversionCandidate(input.input, scored);
  if (hardNationLeaderBlockedSideConversion !== undefined) {
    const safeLeaderBlockedSideConversion = directSafetySelectionCandidate(
      hardNationLeaderBlockedSideConversion,
    );
    if (safeLeaderBlockedSideConversion !== undefined) {
      return [safeLeaderBlockedSideConversion];
    }
  }
  const hardNationDefensiveBorderCounter = directSelectionCandidate(
    hardNationDefensiveBorderCounterattackCandidate(input.input, scored),
  );
  if (hardNationDefensiveBorderCounter !== undefined) {
    return [hardNationDefensiveBorderCounter];
  }
  const hardNationMidgameCounterattack = directSelectionCandidate(
    hardNationMidgameCounterattackCandidate(input.input, scored),
  );
  if (hardNationMidgameCounterattack !== undefined) {
    return [hardNationMidgameCounterattack];
  }
  const hardNationLateAllianceAvoidance = directSelectionCandidate(
    hardNationLateAllianceAvoidanceCandidate(input.input, plan, scored),
  );
  if (hardNationLateAllianceAvoidance !== undefined) {
    return [hardNationLateAllianceAvoidance];
  }
  const plannedBuildWhileStalled = directSelectionCandidate(
    plannedBuildWhileStalledCandidate(input.input, plan, scored),
  );
  if (plannedBuildWhileStalled !== undefined) {
    return [plannedBuildWhileStalled];
  }
  const communicationResponse = directSelectionCandidate(
    communicationResponseCandidate(input.input, scored),
  );
  if (communicationResponse !== undefined) {
    return [communicationResponse];
  }

  if (
    openingExpansionTempo !== undefined &&
    isBatchCompatible(
      openingExpansionTempo.action,
      selected.map((item) => item.action),
    )
  ) {
    selected.push(openingExpansionTempo);
  }

  for (const slot of frontierSchedulerOrderForPlan(input.input, plan, scored)) {
    if (selected.length >= maxActions) {
      break;
    }
    if (slot === "neutral_expansion" && shouldPrioritizeDiversifier) {
      continue;
    }
    const module = schedulerSlotModules[slot];
    if (!enabledModules.has(module)) {
      continue;
    }
    const candidate = scored.find(
      (ranked) =>
        ranked.schedulerSlot === slot &&
        isWorthScheduling(ranked, plan, slot) &&
        isBatchFillerAllowed(ranked, selected, plan) &&
        isBatchCompatible(
          ranked.action,
          selected.map((item) => item.action),
        ),
    );
    if (candidate !== undefined) {
      selected.push(candidate);
    }
  }

  for (const reaction of socialReactionCandidates(
    scored,
    selected,
    plan,
    input.input.observation,
  )) {
    if (selected.length >= maxActions) {
      break;
    }
    selected.push(reaction);
  }

  const nonHold = selected.filter(
    (candidate) => candidate.action.kind !== "hold",
  );
  if (nonHold.length > 0) {
    return nonHold;
  }

  const useful = scored.find(
    (candidate) =>
      candidate.action.kind !== "hold" &&
      (enabledModules.has(candidate.primaryModule) ||
        actionAlignsPlan(candidate.action, plan)) &&
      isWorthScheduling(candidate, plan, candidate.schedulerSlot),
  );
  const alignedFallback = scored.find(
    (candidate) =>
      candidate.action.kind !== "hold" &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      actionAlignsPlan(candidate.action, plan) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      !isBlockedRepeatedLowProbeCandidate(candidate) &&
      !isUnsafeUrgentDefenseAttackCandidate(candidate),
  );
  const productiveFallback = scored.find(
    (candidate) =>
      candidate.action.kind !== "hold" &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      isProductiveFallbackAction(candidate.action) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      !isBlockedRepeatedLowProbeCandidate(candidate) &&
      !isUnsafeUrgentDefenseAttackCandidate(candidate) &&
      candidate.totalScore >= 48,
  );
  const crowdedOpeningGrowthFallback = shouldForceCrowdedNationOpeningExpansion(
    input.input,
  )
    ? scored.find(
        (candidate) =>
          isNeutralGrowthAction(candidate.action) &&
          !hasSchedulingBlockingPolicyPenalty(candidate) &&
          !isBlockedRepeatedLowProbeCandidate(candidate) &&
          !isUnsafeUrgentDefenseAttackCandidate(candidate) &&
          candidate.totalScore >= 20,
      )
    : undefined;
  const hold = scored.find((candidate) => candidate.action.kind === "hold");
  return [
    useful ??
      alignedFallback ??
      crowdedOpeningGrowthFallback ??
      productiveFallback ??
      hold ??
      first,
  ];
}

function socialReactionCandidates(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentBrainInput["observation"],
): FrontierRankedAction[] {
  const primary = selected.find((item) =>
    isMapProgressOrDiplomacyAction(item.action),
  );
  if (primary === undefined) {
    return [];
  }
  if (
    actionPlayerID(primary.action) === null &&
    primary.action.kind !== "alliance_request" &&
    primary.action.kind !== "alliance_extend"
  ) {
    return [];
  }
  return [
    contextualEmojiReactionCandidate(scored, selected, plan, primary.action),
    publicChatReactionCandidate(scored, selected, plan, primary.action),
  ].filter(
    (candidate): candidate is FrontierRankedAction =>
      candidate !== undefined &&
      !recentlySentSocialToSameTarget(observation, candidate.action),
  );
}

function communicationResponseCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const ownPlayerID = input.observation.ownState?.playerID ?? null;
  const focus = latestCommunicationSignal(
    input.observation,
    "coordinate_attack",
  );
  if (
    focus?.targetID !== undefined &&
    focus.targetID !== null &&
    focus.targetID !== ownPlayerID
  ) {
    const pressure = scored
      .filter((candidate) => {
        if (
          actionPlayerID(candidate.action) !== focus.targetID ||
          hasSchedulingBlockingPolicyPenalty(candidate) ||
          isUnsafeUrgentDefenseAttackCandidate(candidate) ||
          (isSocialFlavorAction(candidate.action) &&
            recentlySentSocialToSameTarget(input.observation, candidate.action))
        ) {
          return false;
        }
        if (
          candidate.action.kind === "attack" &&
          candidate.action.metadata?.expansion !== true
        ) {
          return candidate.totalScore >= 12;
        }
        return (
          candidate.action.kind === "target_player" ||
          candidate.action.kind === "embargo" ||
          candidate.action.kind === "quick_chat"
        );
      })
      .sort((a, b) => {
        const aPriority = communicationResponsePriority(a.action);
        const bPriority = communicationResponsePriority(b.action);
        return (
          bPriority - aPriority ||
          b.totalScore - a.totalScore ||
          a.action.id.localeCompare(b.action.id)
        );
      })[0];
    if (pressure !== undefined) {
      return pressure;
    }
  }

  const cooperation =
    latestCommunicationSignal(input.observation, "request_support") ??
    latestCommunicationSignal(input.observation, "propose_alliance");
  const senderPlayerID = cooperation?.senderPlayerID ?? null;
  if (senderPlayerID === null) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        metadataString(candidate.action, "recipientID") !== senderPlayerID &&
        metadataString(candidate.action, "targetID") !== senderPlayerID
      ) {
        return false;
      }
      if (
        isSocialFlavorAction(candidate.action) &&
        recentlySentSocialToSameTarget(input.observation, candidate.action)
      ) {
        return false;
      }
      return (
        candidate.action.kind === "alliance_request" ||
        candidate.action.kind === "alliance_extend" ||
        candidate.action.kind === "donate_gold" ||
        candidate.action.kind === "donate_troops" ||
        candidate.action.kind === "quick_chat" ||
        candidate.action.kind === "emoji"
      );
    })
    .sort(
      (a, b) =>
        communicationResponsePriority(b.action) -
          communicationResponsePriority(a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function latestCommunicationSignal(
  observation: AgentObservation,
  intent: AgentCommunicationSignal["intent"],
): AgentCommunicationSignal | null {
  return (
    [...(observation.recentCommunications ?? [])]
      .reverse()
      .find((signal) => signal.intent === intent) ?? null
  );
}

function communicationResponsePriority(action: LegalAction): number {
  if (action.kind === "attack") {
    return 6;
  }
  if (action.kind === "target_player") {
    return 5;
  }
  if (action.kind === "alliance_request" || action.kind === "alliance_extend") {
    return 4;
  }
  if (action.kind === "embargo") {
    return 3;
  }
  if (action.kind === "quick_chat" || action.kind === "emoji") {
    return 2;
  }
  if (action.kind === "donate_gold" || action.kind === "donate_troops") {
    return 1;
  }
  return 0;
}

function publicChatReactionCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  primaryAction: LegalAction,
): FrontierRankedAction | undefined {
  if (
    selected.length === 0 ||
    selected.some((item) => item.action.kind === "quick_chat")
  ) {
    return undefined;
  }
  return preferredSocialCandidate(
    scored,
    primaryAction,
    (candidate) =>
      candidate.action.kind === "quick_chat" &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      ) &&
      candidate.totalScore >= 8,
  );
}

function contextualEmojiReactionCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  primaryAction: LegalAction,
): FrontierRankedAction | undefined {
  if (selected.some((item) => item.action.kind === "emoji")) {
    return undefined;
  }
  return preferredSocialCandidate(
    scored,
    primaryAction,
    (candidate) =>
      candidate.action.kind === "emoji" &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      ) &&
      candidate.totalScore >= 8,
  );
}

function preferredSocialCandidate(
  scored: readonly FrontierRankedAction[],
  primaryAction: LegalAction,
  predicate: (candidate: FrontierRankedAction) => boolean,
): FrontierRankedAction | undefined {
  const targetID = actionPlayerID(primaryAction);
  const candidates = scored.filter(predicate);
  if (targetID === null) {
    return candidates[0];
  }
  const matchingTarget = candidates.filter(
    (candidate) => actionPlayerID(candidate.action) === targetID,
  );
  return (
    matchingTarget.find((candidate) => {
      const recipientID = metadataString(candidate.action, "recipientID");
      return recipientID !== null && recipientID !== targetID;
    }) ??
    matchingTarget[0] ??
    candidates[0]
  );
}

function earlyNeutralIslandRushCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    !settings.territoryFirstNeutralLandEnabled ||
    observation.phase !== "active" ||
    observation.turnNumber > 1_800 ||
    neutralGrowthHomeDanger(input) === "high"
  ) {
    return undefined;
  }
  if (
    incomingHomePressure(observation) &&
    immediateSurvivalActionAvailable(scored)
  ) {
    return undefined;
  }
  const activeTransportTargets = new Set(
    (observation.nonCombat.boatRetreatOptions ?? [])
      .map((option) => option.targetTile)
      .filter((tile): tile is number => typeof tile === "number"),
  );
  if (activeTransportTargets.size >= 3) {
    return undefined;
  }
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const desiredCommitment = desiredNeutralIslandBoatCommitment(
    observation,
    settings,
  );
  return scored
    .filter((candidate) => {
      if (
        !isNeutralBoatAction(candidate.action) ||
        candidate.action.risk.level === "high" ||
        hasPolicyPenalty(candidate, "neutral expansion is not gaining land")
      ) {
        return false;
      }
      if (
        plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.metadata?.expansion !== true
      ) {
        return false;
      }
      if (metadataString(candidate.action, "targetName") !== "Terra Nullius") {
        return false;
      }
      const targetTile = metadataNumber(candidate.action, "targetTile");
      if (targetTile > 0 && activeTransportTargets.has(targetTile)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aTarget = metadataNumber(a.action, "targetTile");
      const bTarget = metadataNumber(b.action, "targetTile");
      return (
        neutralBoatPriority(b.action) - neutralBoatPriority(a.action) ||
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        aTarget - bTarget ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function neutralTerritoryMaximizerCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (
    input.observation.phase !== "active" ||
    !input.legalActions.some(isNeutralGrowthAction)
  ) {
    return undefined;
  }
  if (!settings.territoryFirstNeutralLandEnabled) {
    if (
      plan.objective === "secure_economy" ||
      plan.objective === "fortify_border" ||
      plan.objective === "survive" ||
      plan.turnIntent === "build" ||
      plan.turnIntent === "fortify" ||
      plan.turnIntent === "survive" ||
      plan.turnIntent === "naval"
    ) {
      return undefined;
    }
    if (dangerousEstablishedNeutralGrowthUnderPressure(input)) {
      return undefined;
    }
    if (
      incomingHomePressure(input.observation) &&
      neutralGrowthHomeDanger(input) === "high" &&
      immediateSurvivalActionAvailable(scored)
    ) {
      return undefined;
    }
    if (
      recentRepeatedLowCommitmentAttackTargetID(input.observation, 8, 2) !==
      null
    ) {
      return undefined;
    }
    const tactical = buildAgentTacticalAffordances({
      observation: input.observation,
      legalActions: input.legalActions,
    });
    if (
      tactical.transportTroopBanking?.recommended === true ||
      (tactical.frontierFinishPressure?.recommended === true &&
        (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0) ||
      (tactical.frontierConversionTiming?.recommended === true &&
        tactical.frontierConversionTiming.executorReady === true)
    ) {
      return undefined;
    }
    const ownTroops =
      input.observation.combat.ownTroops ??
      input.observation.ownState?.troops ??
      0;
    const ownTileShare =
      input.observation.ownState?.tileShare ??
      input.observation.endgame?.ownTileShare ??
      0;
    if (
      plan.objective !== "expand_territory" &&
      plan.objective !== "pressure_rival" &&
      plan.objective !== "build_alliance"
    ) {
      return undefined;
    }
    if (
      plan.objective === "pressure_rival" &&
      ownTileShare >= 0.18 &&
      tactical.openingExpansionTempo?.recommended !== true
    ) {
      return undefined;
    }
    if (
      plan.objective === "pressure_rival" &&
      input.observation.memory.recentExpansionCount >= 3
    ) {
      return undefined;
    }
    const humanReplayBoat = scored.find(isHumanReplayOpeningBoatTempoCandidate);
    if (humanReplayBoat !== undefined) {
      return humanReplayBoat;
    }
    const landCandidates = scored.filter((candidate) =>
      neutralTerritoryCandidateAllowed(candidate, plan, true),
    );
    const boatCandidates = scored.filter((candidate) =>
      neutralTerritoryCandidateAllowed(candidate, plan, false),
    );
    const desiredLandCommitment =
      input.observation.memory.recentExpansionCount >= 3
        ? 0.1
        : ownTileShare < 0.08
          ? 0.35
          : desiredStandingNeutralLandCommitment(input.observation, settings);
    const desiredBoatCommitment = desiredNeutralIslandBoatCommitment(
      input.observation,
      settings,
    );
    return (
      landCandidates.sort((a, b) =>
        neutralTerritorySort(a, b, ownTroops, desiredLandCommitment),
      )[0] ??
      boatCandidates.sort((a, b) =>
        neutralTerritorySort(a, b, ownTroops, desiredBoatCommitment),
      )[0]
    );
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    0;
  const landCandidates = scored.filter((candidate) =>
    neutralTerritoryCandidateAllowed(candidate, plan, true, {
      ignoreIncomingPressurePenalty: true,
    }),
  );
  const desiredLandCommitment =
    input.observation.memory.recentExpansionCount >= 3
      ? 0.1
      : ownTileShare < 0.08
        ? 0.35
        : desiredStandingNeutralLandCommitment(input.observation, settings);
  const bestLand = landCandidates.sort((a, b) =>
    neutralTerritorySort(a, b, ownTroops, desiredLandCommitment),
  )[0];
  if (bestLand !== undefined) {
    return bestLand;
  }
  if (dangerousEstablishedNeutralGrowthUnderPressure(input)) {
    return undefined;
  }
  const tactical = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  if (
    (tactical.frontierFinishPressure?.recommended === true &&
      (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0) ||
    (tactical.frontierConversionTiming?.recommended === true &&
      tactical.frontierConversionTiming.executorReady === true)
  ) {
    return undefined;
  }
  const boatCandidates = scored.filter((candidate) =>
    neutralTerritoryCandidateAllowed(candidate, plan, false),
  );
  const desiredBoatCommitment = desiredNeutralIslandBoatCommitment(
    input.observation,
    settings,
  );
  return boatCandidates.sort((a, b) =>
    neutralTerritorySort(a, b, ownTroops, desiredBoatCommitment),
  )[0];
}

function neutralTerritoryCandidateAllowed(
  candidate: FrontierRankedAction,
  plan: StrategicPlan,
  landOnly: boolean,
  options: { ignoreIncomingPressurePenalty?: boolean } = {},
): boolean {
  const neutralMatch = landOnly
    ? isNeutralLandExpansionAction(candidate.action)
    : isNeutralBoatAction(candidate.action);
  if (!neutralMatch) {
    return false;
  }
  if (
    plan.forbiddenActionKinds.includes(candidate.action.kind) &&
    candidate.action.metadata?.expansion !== true
  ) {
    return false;
  }
  if (candidate.action.risk.level === "high") {
    return false;
  }
  if (hasPolicyPenalty(candidate, "neutral expansion is not gaining land")) {
    return false;
  }
  if (
    !options.ignoreIncomingPressurePenalty &&
    hasPolicyPenalty(
      candidate,
      "high incoming pressure should preserve troops before neutral expansion",
    )
  ) {
    return false;
  }
  if (
    !landOnly &&
    (hasPolicyPenalty(candidate, "existing transports should land") ||
      hasPolicyPenalty(candidate, "repeated transport launches"))
  ) {
    return false;
  }
  return true;
}

function neutralTerritorySort(
  a: FrontierRankedAction,
  b: FrontierRankedAction,
  ownTroops: number,
  desiredCommitment: number,
): number {
  return (
    neutralGrowthActionRank(a.action) - neutralGrowthActionRank(b.action) ||
    Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
      Math.abs(committedTroopRatio(b.action, ownTroops) - desiredCommitment) ||
    b.totalScore - a.totalScore ||
    a.action.id.localeCompare(b.action.id)
  );
}

function territoryMaximizerBatch(
  primary: FrontierRankedAction,
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  maxActions: number,
  observation: AgentObservation,
  settings: AgentSettings,
): FrontierRankedAction[] {
  const economyHandoffPrimary = demoQualityEconomyHandoffFromNeutralPrimary(
    primary,
    scored,
    plan,
    observation,
  );
  if (economyHandoffPrimary !== undefined) {
    if (maxActions <= 1) {
      return [economyHandoffPrimary];
    }
    const selected: FrontierRankedAction[] = [economyHandoffPrimary];
    if (
      isBatchCompatible(
        primary.action,
        selected.map((item) => item.action),
      )
    ) {
      selected.push(primary);
    }
    return selected;
  }
  if (maxActions <= 1) {
    return [primary];
  }
  const selected: FrontierRankedAction[] = [primary];
  const neutralGrowthCompanion = neutralGrowthCompanionCandidate(
    scored,
    selected,
    plan,
    observation,
    settings,
  );
  if (neutralGrowthCompanion !== undefined) {
    selected.push(neutralGrowthCompanion);
  }
  const tradeActionAvailable = scored.some(
    (candidate) =>
      candidate.action.kind === "donate_troops" ||
      candidate.action.kind === "donate_gold",
  );
  const attachCooperation = shouldAttachTerritoryFirstCooperation(
    observation,
    settings,
    plan,
    tradeActionAvailable,
  );
  const reciprocalAlliance =
    attachCooperation && settings.territoryFirstNeutralLandEnabled
      ? reciprocalAllianceCandidate(scored, selected, plan, observation)
      : undefined;
  for (const candidate of [
    reciprocalAlliance,
    attachCooperation
      ? cooperativeDiplomacyCandidate(scored, selected, plan, observation)
      : undefined,
    neutralEconomyFillerCandidate(scored, selected, plan, observation),
    attachCooperation
      ? visibleSocialCandidate(
          scored,
          selected,
          plan,
          observation,
          "quick_chat",
        )
      : undefined,
    attachCooperation
      ? visibleSocialCandidate(scored, selected, plan, observation, "emoji")
      : undefined,
  ]) {
    if (candidate === undefined || selected.length >= maxActions) {
      continue;
    }
    if (
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      )
    ) {
      selected.push(candidate);
    }
  }
  return selected;
}

function demoQualityEconomyHandoffFromNeutralPrimary(
  primary: FrontierRankedAction,
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentObservation,
): FrontierRankedAction | undefined {
  if (
    observation.phase !== "active" ||
    plan.objective !== "expand_territory" ||
    (!isNeutralLandExpansionAction(primary.action) &&
      !isNeutralBoatAction(primary.action)) ||
    observation.memory.recentExpansionCount < 2 ||
    observation.memory.recentBuildCount > 0 ||
    incomingHomePressure(observation) ||
    !hasPolicyPenalty(
      primary,
      "after two neutral expansions, safe economy or weak-rival handoff is ready",
    )
  ) {
    return undefined;
  }
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "build" &&
        candidate.action.risk.level !== "high" &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        !hasSchedulingBlockingPolicyPenalty(candidate) &&
        isEconomicUnit(metadataString(candidate.action, "unit")) &&
        isBatchCompatible(candidate.action, []),
    )
    .sort(
      (a, b) =>
        demoQualityEconomicUnitPriority(observation, b.action) -
          demoQualityEconomicUnitPriority(observation, a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function neutralGrowthCompanionCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentObservation,
  settings: AgentSettings,
): FrontierRankedAction | undefined {
  if (
    !settings.territoryFirstNeutralLandEnabled ||
    observation.phase !== "active" ||
    observation.turnNumber > 1_800 ||
    selected.length === 0 ||
    neutralGrowthHomeDanger({
      observation,
      legalActions: scored.map((candidate) => candidate.action),
    }) === "high"
  ) {
    return undefined;
  }
  const selectedActions = selected.map((item) => item.action);
  const hasLand = selectedActions.some(isNeutralLandExpansionAction);
  const hasBoat = selectedActions.some(isNeutralBoatAction);
  if (hasLand === hasBoat) {
    return undefined;
  }
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const activeTransportTargets = new Set(
    (observation.nonCombat.boatRetreatOptions ?? [])
      .map((option) => option.targetTile)
      .filter((tile): tile is number => typeof tile === "number"),
  );
  const predicate = (candidate: FrontierRankedAction): boolean => {
    if (
      selectedActions.some((action) => action.id === candidate.action.id) ||
      candidate.action.risk.level === "high" ||
      hasPolicyPenalty(candidate, "neutral expansion is not gaining land")
    ) {
      return false;
    }
    if (
      plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      candidate.action.metadata?.expansion !== true
    ) {
      return false;
    }
    if (hasLand) {
      if (
        !isNeutralBoatAction(candidate.action) ||
        metadataString(candidate.action, "targetName") !== "Terra Nullius"
      ) {
        return false;
      }
      const targetTile = metadataNumber(candidate.action, "targetTile");
      return targetTile <= 0 || !activeTransportTargets.has(targetTile);
    }
    return isNeutralLandExpansionAction(candidate.action);
  };
  const desiredCommitment = hasLand
    ? Math.min(0.16, desiredNeutralIslandBoatCommitment(observation, settings))
    : desiredStandingNeutralLandCommitment(observation, settings);
  return scored
    .filter(predicate)
    .sort(
      (a, b) =>
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function reciprocalAllianceCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentObservation,
): FrontierRankedAction | undefined {
  const signal = latestCommunicationSignal(observation, "propose_alliance");
  const senderID = signal?.senderPlayerID ?? null;
  const incomingAlliancePlayerIDs = new Set(
    observation.visiblePlayers
      .filter((player) => player.hasIncomingAllianceRequest === true)
      .map((player) => player.playerID),
  );
  if (senderID === null && incomingAlliancePlayerIDs.size === 0) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "alliance_request" ||
        plan.forbiddenActionKinds.includes(candidate.action.kind)
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      if (
        targetID === null ||
        (targetID !== senderID && !incomingAlliancePlayerIDs.has(targetID))
      ) {
        return false;
      }
      return isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      );
    })
    .sort(
      (a, b) =>
        allianceReciprocityPriority(b.action, observation) -
          allianceReciprocityPriority(a.action, observation) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function inputHasCooperationSignal(observation: AgentObservation): boolean {
  return (observation.recentCommunications ?? []).some(
    (signal) =>
      signal.intent === "propose_alliance" ||
      signal.intent === "request_support" ||
      signal.directToAgent === true,
  );
}

function shouldAttachTerritoryFirstCooperation(
  observation: AgentObservation,
  settings: AgentSettings,
  plan: StrategicPlan,
  tradeActionAvailable: boolean,
): boolean {
  if (plan.objective === "build_alliance") {
    return true;
  }
  if (!settings.territoryFirstNeutralLandEnabled) {
    return false;
  }
  if (tradeActionAvailable || inputHasCooperationSignal(observation)) {
    return true;
  }
  if ((observation.turnNumber ?? 0) < 500) {
    return false;
  }
  return false;
}

function cooperativeDiplomacyCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentObservation,
): FrontierRankedAction | undefined {
  return scored
    .filter((candidate) => {
      if (
        !(
          candidate.action.kind === "donate_troops" ||
          candidate.action.kind === "donate_gold" ||
          candidate.action.kind === "alliance_extend" ||
          candidate.action.kind === "alliance_request"
        ) ||
        plan.forbiddenActionKinds.includes(candidate.action.kind)
      ) {
        return false;
      }
      if (
        hasPolicyPenalty(candidate, "do not protect a runaway") ||
        hasPolicyPenalty(candidate, "do not ally with hard-nation conquest") ||
        hasPolicyPenalty(
          candidate,
          "do not donate resources to the current leader",
        )
      ) {
        return false;
      }
      return isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      );
    })
    .sort(
      (a, b) =>
        cooperativeDiplomacyPriority(b.action, observation) -
          cooperativeDiplomacyPriority(a.action, observation) ||
        cooperationTargetPriority(b.action, observation) -
          cooperationTargetPriority(a.action, observation) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function cooperativeDiplomacyPriority(
  action: LegalAction,
  observation: AgentObservation,
): number {
  const recentTroopDonations = observation.memory.recentActions.filter(
    (recent) => recent.actionKind === "donate_troops",
  ).length;
  const recentGoldDonations = observation.memory.recentActions.filter(
    (recent) => recent.actionKind === "donate_gold",
  ).length;
  if (
    action.kind === "donate_gold" &&
    recentTroopDonations > recentGoldDonations
  ) {
    return 5;
  }
  if (action.kind === "donate_troops") return 4;
  if (action.kind === "donate_gold") return 3;
  if (action.kind === "alliance_extend") return 2;
  if (action.kind === "alliance_request") return 1;
  return 0;
}

function allianceReciprocityPriority(
  action: LegalAction,
  observation: AgentObservation,
): number {
  const target = visiblePlayerForAction(observation, action);
  let priority = 0;
  if (target?.hasIncomingAllianceRequest === true) {
    priority += 20;
  }
  if (target?.type === PlayerType.Human) {
    priority += 10;
  }
  return priority;
}

function cooperationTargetPriority(
  action: LegalAction,
  observation: AgentObservation,
): number {
  const target = visiblePlayerForAction(observation, action);
  if (target?.type === PlayerType.Human) {
    return 4;
  }
  if (target?.type === PlayerType.Nation) {
    return -4;
  }
  return 0;
}

function visiblePlayerForAction(
  observation: AgentObservation,
  action: LegalAction,
): AgentObservation["visiblePlayers"][number] | undefined {
  const targetID = actionPlayerID(action);
  if (targetID === null) {
    return undefined;
  }
  return observation.visiblePlayers.find(
    (player) => player.playerID === targetID,
  );
}

function visibleSocialCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentObservation,
  kind: "quick_chat" | "emoji",
): FrontierRankedAction | undefined {
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === kind &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        !recentlySentSocialToSameTarget(observation, candidate.action) &&
        isBatchCompatible(
          candidate.action,
          selected.map((item) => item.action),
        ),
    )
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
    )[0];
}

function neutralEconomyFillerCandidate(
  scored: readonly FrontierRankedAction[],
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  observation: AgentObservation,
): FrontierRankedAction | undefined {
  const candidates = scored.filter((candidate) => {
    const politicalNukeOverride =
      agentOnlyPoliticalMatch(observation) && candidate.action.kind === "nuke";
    return (
      (candidate.schedulerSlot === "economic_structure" ||
        candidate.schedulerSlot === "defensive_structure" ||
        candidate.schedulerSlot === "nuclear_endgame" ||
        candidate.action.kind === "nuke" ||
        candidate.action.kind === "upgrade_structure") &&
      (!plan.forbiddenActionKinds.includes(candidate.action.kind) ||
        politicalNukeOverride) &&
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      )
    );
  });
  if (agentOnlyPoliticalMatch(observation)) {
    return candidates
      .filter(
        (candidate) =>
          politicalShowcaseInfrastructurePriority(
            observation,
            candidate.action,
          ) > 0,
      )
      .sort(
        (a, b) =>
          politicalShowcaseInfrastructurePriority(observation, b.action) -
            politicalShowcaseInfrastructurePriority(observation, a.action) ||
          b.totalScore - a.totalScore ||
          a.action.id.localeCompare(b.action.id),
      )[0];
  }
  return candidates[0];
}

function politicalShowcaseBatch(
  primary: FrontierRankedAction,
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  maxActions: number,
  observation: AgentObservation,
): FrontierRankedAction[] {
  if (maxActions <= 1) {
    return [primary];
  }
  const selected: FrontierRankedAction[] = [primary];
  for (const candidate of [
    visibleSocialCandidate(scored, selected, plan, observation, "quick_chat"),
    visibleSocialCandidate(scored, selected, plan, observation, "emoji"),
    cooperativeDiplomacyCandidate(scored, selected, plan, observation),
  ]) {
    if (candidate === undefined || selected.length >= maxActions) {
      continue;
    }
    if (
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      )
    ) {
      selected.push(candidate);
    }
  }
  return selected;
}

function combatFollowThroughBatch(
  primary: FrontierRankedAction,
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  maxActions: number,
  observation: AgentObservation,
): FrontierRankedAction[] {
  if (
    maxActions <= 1 ||
    primary.action.kind !== "attack" ||
    primary.action.metadata?.expansion === true
  ) {
    return [primary];
  }
  const selected: FrontierRankedAction[] = [primary];
  for (const candidate of [
    publicChatReactionCandidate(scored, selected, plan, primary.action),
    contextualEmojiReactionCandidate(scored, selected, plan, primary.action),
  ]) {
    if (candidate === undefined || selected.length >= maxActions) {
      continue;
    }
    if (
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      ) &&
      socialActionHasPurposefulTarget(candidate.action, selected, observation)
    ) {
      selected.push(candidate);
    }
  }
  return selected;
}

function socialActionHasPurposefulTarget(
  action: LegalAction,
  selected: readonly FrontierRankedAction[],
  observation: AgentObservation,
): boolean {
  const targetID = actionPlayerID(action);
  if (targetID === null) {
    return false;
  }
  if (selected.some((item) => actionPlayerID(item.action) === targetID)) {
    return true;
  }
  if (
    observation.combat.incomingAttackPlayerIDs.includes(targetID) ||
    observation.combat.attackablePlayerIDs.includes(targetID)
  ) {
    return true;
  }
  return (observation.recentCommunications ?? []).some(
    (signal) =>
      signal.senderPlayerID === targetID || signal.targetID === targetID,
  );
}

function demoQualityRepeatedHoldCommunicationCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    observation.phase !== "active" ||
    recentConsecutiveAcceptedActionKind(observation, "hold") < 2
  ) {
    return undefined;
  }
  const incomingTargetIDs = new Set(observation.combat.incomingAttackPlayerIDs);
  const planTargetID = observation.objective?.targetPlayerID ?? null;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "quick_chat" &&
        candidate.action.kind !== "emoji" &&
        candidate.action.kind !== "target_player" &&
        candidate.action.kind !== "embargo_stop"
      ) {
        return false;
      }
      if (recentlySentSocialToSameTarget(observation, candidate.action)) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      if (targetID === null) {
        return false;
      }
      if (
        candidate.action.kind === "quick_chat" &&
        metadataString(candidate.action, "quickChatKey") === "greet.hello"
      ) {
        return false;
      }
      return (
        incomingTargetIDs.has(targetID) ||
        targetID === planTargetID ||
        metadataString(candidate.action, "quickChatKey")?.startsWith(
          "defend.",
        ) === true
      );
    })
    .sort((a, b) => {
      const priority = (candidate: FrontierRankedAction): number => {
        if (
          candidate.action.kind === "quick_chat" &&
          metadataString(candidate.action, "quickChatKey")?.startsWith(
            "defend.",
          ) === true
        ) {
          return 5;
        }
        if (candidate.action.kind === "target_player") return 4;
        if (candidate.action.kind === "embargo_stop") return 3;
        if (candidate.action.kind === "quick_chat") return 2;
        if (candidate.action.kind === "emoji") return 1;
        return 0;
      };
      return (
        priority(b) - priority(a) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function agentOnlyPoliticalPactCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    !agentOnlyPoliticalMatch(observation) ||
    observation.turnNumber < 650 ||
    observation.turnNumber > 8_000 ||
    observation.combat.incomingAttackPlayerIDs.length > 1 ||
    recentAcceptedActionKind(observation, "alliance_request", 3) ||
    hasMapProgressLegalAction(input.legalActions)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "alliance_request" ||
        !hasAgentOnlyPoliticalPactContribution(candidate)
      ) {
        return false;
      }
      const target = visiblePlayerForAction(observation, candidate.action);
      return (
        target !== undefined &&
        target.isAlive &&
        target.type === PlayerType.Human
      );
    })
    .sort((a, b) => {
      const aTarget = visiblePlayerForAction(observation, a.action);
      const bTarget = visiblePlayerForAction(observation, b.action);
      return (
        Number(bTarget?.hasIncomingAllianceRequest === true) -
          Number(aTarget?.hasIncomingAllianceRequest === true) ||
        (bTarget?.tilesOwned ?? 0) - (aTarget?.tilesOwned ?? 0) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function agentOnlyPoliticalIntrigueCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    !agentOnlyPoliticalMatch(observation) ||
    observation.turnNumber < 1_500 ||
    observation.combat.incomingAttackPlayerIDs.length > 1 ||
    recentAcceptedActionKind(observation, "break_alliance", 14)
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownState.tilesOwned < 8_000 || ownTroops < 260_000) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "break_alliance" ||
        !hasAgentOnlyPoliticalIntrigueContribution(candidate)
      ) {
        return false;
      }
      const target = visiblePlayerForAction(observation, candidate.action);
      return target !== undefined && target.isAlive;
    })
    .sort((a, b) => {
      const aTarget = visiblePlayerForAction(observation, a.action);
      const bTarget = visiblePlayerForAction(observation, b.action);
      const leaderID = observation.endgame?.leaderID ?? null;
      const aLeader = aTarget?.playerID === leaderID ? 1 : 0;
      const bLeader = bTarget?.playerID === leaderID ? 1 : 0;
      return (
        bLeader - aLeader ||
        (bTarget?.tilesOwned ?? 0) - (aTarget?.tilesOwned ?? 0) ||
        (bTarget?.troops ?? 0) - (aTarget?.troops ?? 0) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function agentOnlyPoliticalNuclearCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    !agentOnlyPoliticalMatch(observation) ||
    observation.turnNumber < 1_600 ||
    observation.combat.incomingAttackPlayerIDs.length > 1 ||
    recentAcceptedActionKind(observation, "nuke", 10)
  ) {
    return undefined;
  }
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "nuke" &&
        politicalShowcaseInfrastructurePriority(observation, candidate.action) >
          0,
    )
    .sort(
      (a, b) =>
        politicalShowcaseInfrastructurePriority(observation, b.action) -
          politicalShowcaseInfrastructurePriority(observation, a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function agentOnlyPoliticalInfrastructureCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    !agentOnlyPoliticalMatch(observation) ||
    observation.turnNumber < 850 ||
    observation.combat.incomingAttackPlayerIDs.length > 1 ||
    observation.memory.recentBuildCount > 0
  ) {
    return undefined;
  }
  return scored
    .filter(
      (candidate) =>
        (candidate.action.kind === "build" ||
          candidate.action.kind === "upgrade_structure") &&
        politicalShowcaseInfrastructurePriority(
          observation,
          candidate.action,
        ) >= 120,
    )
    .sort(
      (a, b) =>
        politicalShowcaseInfrastructurePriority(observation, b.action) -
          politicalShowcaseInfrastructurePriority(observation, a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function nuclearDeterrenceInfrastructureCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    observation.turnNumber < 950 ||
    observation.memory.recentBuildCount > 0 ||
    observation.combat.incomingAttackPlayerIDs.length > 1
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (candidate.action.kind !== "build") {
        return false;
      }
      const priority = nuclearInfrastructurePriority(
        observation,
        candidate.action,
        input.legalActions,
      );
      return (
        priority >= 82 &&
        candidate.totalScore >= 54 &&
        !hasSchedulingBlockingPolicyPenalty(candidate)
      );
    })
    .sort(
      (a, b) =>
        nuclearInfrastructurePriority(
          observation,
          b.action,
          input.legalActions,
        ) -
          nuclearInfrastructurePriority(
            observation,
            a.action,
            input.legalActions,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function nuclearEndgameStrikeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
  settings: AgentSettings,
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    !settings.lateGameStrikeTargetingEnabled ||
    observation.turnNumber < 1_550 ||
    recentAcceptedActionKind(observation, "nuke", 8) ||
    observation.combat.incomingAttackPlayerIDs.length > 1
  ) {
    return undefined;
  }
  const strike = buildAgentTacticalAffordances({
    observation,
    legalActions: input.legalActions,
  }).lateGameStrikeTargeting;
  if (strike?.recommended === true && strike.bestStrikeActionID !== null) {
    const directStrike = scored
      .filter(
        (candidate) =>
          candidate.action.id === strike.bestStrikeActionID &&
          candidate.totalScore >= 58 &&
          !hasSchedulingBlockingPolicyPenalty(candidate),
      )
      .sort(
        (a, b) =>
          b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
      )[0];
    if (directStrike !== undefined) {
      return directStrike;
    }
  }
  return scored
    .filter((candidate) => {
      if (candidate.action.kind !== "nuke") {
        return false;
      }
      const priority = nuclearStrikePriority(observation, candidate.action);
      return (
        priority >= 118 &&
        candidate.totalScore >= 58 &&
        !hasSchedulingBlockingPolicyPenalty(candidate)
      );
    })
    .sort(
      (a, b) =>
        nuclearStrikePriority(observation, b.action) -
          nuclearStrikePriority(observation, a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function agentOnlyPoliticalMatch(observation: AgentObservation): boolean {
  const aliveVisible = observation.visiblePlayers.filter(
    (player) => player.isAlive,
  );
  const aliveHumans = aliveVisible.filter(
    (player) => player.type === PlayerType.Human,
  );
  return aliveHumans.length >= 2 && aliveHumans.length === aliveVisible.length;
}

function politicalShowcaseInfrastructurePriority(
  observation: AgentObservation,
  action: LegalAction,
): number {
  if (!agentOnlyPoliticalMatch(observation)) {
    return 0;
  }
  const unit = metadataString(action, "unit");
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const turnNumber = observation.turnNumber ?? 0;
  const cityCount = ownUnitCount(observation, UnitType.City);
  const factoryCount = ownUnitCount(observation, UnitType.Factory);
  const portCount = ownUnitCount(observation, UnitType.Port);
  const siloCount = ownUnitCount(observation, UnitType.MissileSilo);
  const samCount = ownUnitCount(observation, UnitType.SAMLauncher);
  if (action.kind === "nuke") {
    if (turnNumber < 1_600) {
      return 0;
    }
    if (unit === UnitType.MIRV) return 980;
    if (unit === UnitType.HydrogenBomb) return 930;
    if (unit === UnitType.AtomBomb) return 880;
    return 840;
  }
  if (action.kind === "build" && unit === UnitType.City) {
    if (cityCount === 0) return 760;
    return cityCount < Math.max(2, Math.floor(ownTiles / 22_000))
      ? 520 - cityCount * 32
      : 0;
  }
  if (action.kind === "build" && unit === UnitType.Factory) {
    if (factoryCount === 0 && ownTiles >= 6_000) return 720;
    return factoryCount < Math.max(2, Math.floor(ownTiles / 24_000))
      ? 500 - factoryCount * 34
      : 0;
  }
  if (action.kind === "build" && unit === UnitType.Port) {
    if (portCount === 0 && ownTiles >= 8_000) return 620;
    return portCount < Math.max(1, Math.floor(ownTiles / 30_000))
      ? 420 - portCount * 36
      : 0;
  }
  if (action.kind === "build" && unit === UnitType.MissileSilo) {
    if (
      turnNumber >= 1_000 &&
      ownTiles >= 5_000 &&
      cityCount + factoryCount > 0 &&
      siloCount === 0
    ) {
      return 700;
    }
    return turnNumber >= 2_200 && ownTileShare >= 0.14 && siloCount < 2
      ? 540 - siloCount * 80
      : 0;
  }
  if (action.kind === "build" && unit === UnitType.SAMLauncher) {
    return turnNumber >= 1_600 && ownTileShare >= 0.12 && samCount < 2
      ? 450 - samCount * 90
      : 0;
  }
  if (
    action.kind === "upgrade_structure" &&
    (unit === UnitType.City ||
      unit === UnitType.Factory ||
      unit === UnitType.Port ||
      unit === UnitType.MissileSilo)
  ) {
    return turnNumber >= 1_600 ? 360 : 0;
  }
  if (action.kind === "build" && unit === UnitType.DefensePost) {
    return observation.combat.incomingAttackPlayerIDs.length > 0 ? 240 : 80;
  }
  return 0;
}

function nuclearInfrastructurePriority(
  observation: AgentObservation,
  action: LegalAction,
  legalActions: readonly LegalAction[],
): number {
  if (action.kind !== "build") {
    return 0;
  }
  const unit = metadataString(action, "unit");
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const turnNumber = observation.turnNumber ?? 0;
  const cityCount = ownUnitCount(observation, UnitType.City);
  const factoryCount = ownUnitCount(observation, UnitType.Factory);
  const portCount = ownUnitCount(observation, UnitType.Port);
  const siloCount = ownUnitCount(observation, UnitType.MissileSilo);
  const samCount = ownUnitCount(observation, UnitType.SAMLauncher);
  const protectableCount = cityCount + factoryCount + portCount + siloCount;
  const nuclearActionsLegal = legalActions.some(
    (candidate) => candidate.kind === "nuke",
  );
  const leaderGap =
    (observation.endgame?.leaderTileShare ?? 0) -
    (observation.endgame?.ownTileShare ?? ownTileShare);
  const hasEconomy = cityCount + factoryCount + portCount > 0;
  if (unit === UnitType.MissileSilo) {
    if (turnNumber < 950 || ownTiles < 5_000 || !hasEconomy) {
      return 0;
    }
    let priority = siloCount === 0 ? 78 : 38;
    if (turnNumber >= 1_500) priority += 24;
    if (ownTileShare >= 0.12) priority += 18;
    if (leaderGap >= 0.05) priority += 24;
    if (siloCount >= 2 && ownTileShare < 0.24) priority -= 80;
    return priority;
  }
  if (unit === UnitType.SAMLauncher) {
    if (turnNumber < 1_150 || ownTileShare < 0.08 || protectableCount === 0) {
      return 0;
    }
    const desiredSamCount = Math.max(
      1,
      Math.min(4, Math.ceil(protectableCount / 3)),
    );
    let priority = samCount === 0 ? 72 : 40;
    if (siloCount > 0) priority += 28;
    if (nuclearActionsLegal) priority += 24;
    if (turnNumber >= 1_600) priority += 22;
    if (leaderGap >= 0.05) priority += 18;
    if (samCount >= desiredSamCount) priority -= 90;
    return priority;
  }
  return 0;
}

function nuclearStrikePriority(
  observation: AgentObservation,
  action: LegalAction,
): number {
  if (action.kind !== "nuke") {
    return 0;
  }
  const unit = metadataString(action, "unit");
  const targetID = actionPlayerID(action);
  const target = visiblePlayerForAction(observation, action);
  const targetIsLeader =
    targetID !== null && targetID === observation.endgame?.leaderID;
  const incomingAttacker =
    targetID !== null &&
    observation.combat.incomingAttackPlayerIDs.includes(targetID);
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const targetTileShare =
    metadataNumber(action, "targetTileShare") || target?.tileShare || 0;
  const targetStructureUnit = metadataString(action, "targetStructureUnit");
  const structurePriority =
    metadataNumber(action, "targetStructurePriority") ||
    nuclearTargetStructurePriority(targetStructureUnit);
  const samCoverage = metadataNumber(action, "targetSamCoverage");
  const targetPriority = metadataNumber(action, "nuclearTargetPriority");
  const leaderGap =
    (observation.endgame?.leaderTileShare ?? 0) -
    (observation.endgame?.ownTileShare ?? ownTileShare);
  return nuclearStrikePriorityScore({
    weaponUnit: unit,
    targetID,
    targetIsLeader,
    incomingAttacker,
    turnNumber: observation.turnNumber,
    ownTileShare,
    targetTileShare,
    targetStructureUnit,
    targetStructurePriority: structurePriority,
    targetSamCoverage: samCoverage,
    nuclearTargetPriority: targetPriority,
    leaderTileShareGap: leaderGap,
  });
}

function openingExpansionTempoCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (!settings.openingExpansionTempoEnabled) {
    return undefined;
  }
  const openingTempo = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  }).openingExpansionTempo;
  const humanReplaySafeGrowthWindow =
    openingTempo?.openingWindow === true &&
    plan.objective !== "pressure_rival" &&
    openingTempo.neutralExpansionAvailable &&
    openingTempo.homeDanger !== "high" &&
    (openingTempo.leaderGapDanger || (openingTempo.ownTileShare ?? 1) < 0.12) &&
    (openingTempo.ownTileShare ?? 1) < 0.16 &&
    input.observation.strategic.urgency !== "high";
  if (openingTempo?.recommended !== true && !humanReplaySafeGrowthWindow) {
    return undefined;
  }
  if (
    dangerousEstablishedNeutralGrowthUnderPressure(input) &&
    openingTempo?.behindExpectedTempo !== true
  ) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const desiredCommitment = desiredOpeningExpansionCommitment(
    input.observation,
    settings,
  );
  return scored
    .filter((candidate) => {
      const humanReplayOpeningBoat =
        isHumanReplayOpeningBoatTempoCandidate(candidate);
      const humanReplaySafeGrowth =
        humanReplaySafeGrowthWindow && isNeutralGrowthAction(candidate.action);
      return (
        isNeutralGrowthAction(candidate.action) &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        (!hasSchedulingBlockingPolicyPenalty(candidate) ||
          humanReplayOpeningBoat ||
          humanReplaySafeGrowth) &&
        candidate.totalScore >=
          (humanReplaySafeGrowth ? 1 : humanReplayOpeningBoat ? 18 : 24)
      );
    })
    .sort(
      (a, b) =>
        humanReplayOpeningGrowthRank(a) - humanReplayOpeningGrowthRank(b) ||
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function repeatedLowProbeRecoveryCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (
    plan.objective === "survive" ||
    (input.observation.strategic.priority === "build_defense" &&
      input.observation.strategic.urgency !== "low")
  ) {
    return undefined;
  }
  const repeatedTargetID = recentRepeatedLowCommitmentAttackTargetID(
    input.observation,
    8,
    2,
  );
  const blockedWeakProbeVisible = scored.some(
    isBlockedRepeatedLowProbeCandidate,
  );
  const tactical = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const tacticalRepeatedProbe =
    tactical.frontierFinishPressure?.repeatedLowCommitmentProbe === true &&
    tactical.frontierFinishPressure.homeDanger !== "high";
  if (
    repeatedTargetID === null &&
    !blockedWeakProbeVisible &&
    !tacticalRepeatedProbe
  ) {
    return undefined;
  }
  if (
    tactical.frontierFinishPressure?.recommended === true &&
    (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0
  ) {
    return undefined;
  }
  if (
    incomingHomePressure(input.observation) &&
    neutralGrowthHomeDanger(input) === "high" &&
    immediateSurvivalActionAvailable(scored)
  ) {
    return undefined;
  }
  if (dangerousEstablishedNeutralGrowthUnderPressure(input)) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const desiredCommitment = desiredStandingNeutralLandCommitment(
    input.observation,
    settings,
  );
  return scored
    .filter(
      (candidate) =>
        isNeutralGrowthAction(candidate.action) &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high",
    )
    .sort(
      (a, b) =>
        neutralGrowthActionRank(a.action) - neutralGrowthActionRank(b.action) ||
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function lowShareNeutralCatchUpCandidate(
  input: AgentBrainInput,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (!settings.openingExpansionTempoEnabled) {
    return undefined;
  }
  const observation = input.observation;
  if (observation.turnNumber < 1_200 || observation.turnNumber > 3_600) {
    return undefined;
  }
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const leaderGap =
    (observation.endgame?.leaderTileShare ?? ownTileShare) - ownTileShare;
  if (ownTileShare >= 0.12 && ownTiles >= 12_000 && leaderGap < 0.18) {
    return undefined;
  }
  if (
    incomingHomePressure(observation) &&
    neutralGrowthHomeDanger(input) === "high"
  ) {
    return undefined;
  }
  if (dangerousEstablishedNeutralGrowthUnderPressure(input)) {
    return undefined;
  }
  const tactical = buildAgentTacticalAffordances({
    observation,
    legalActions: input.legalActions,
  });
  const conversion = tactical.frontierConversionTiming;
  if (
    conversion?.recommended === true &&
    conversion.executorReady === true &&
    conversion.bestExecutorReadyTargetID !== null &&
    conversion.homeDanger !== "high" &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) >= 1.45
  ) {
    return undefined;
  }
  const urgentOpeningCatchUp =
    tactical.openingExpansionTempo?.recommended === true &&
    tactical.openingExpansionTempo.homeDanger !== "high" &&
    (tactical.openingExpansionTempo.ownTileShare ?? ownTileShare) <
      (tactical.openingExpansionTempo.expectedTileShare ?? 0.1);
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const desiredCommitment = desiredStandingNeutralLandCommitment(
    observation,
    settings,
  );
  return scored
    .filter(
      (candidate) =>
        isNeutralLandExpansionAction(candidate.action) &&
        (candidate.action.risk.level !== "high" || urgentOpeningCatchUp) &&
        candidate.totalScore >= 0,
    )
    .sort(
      (a, b) =>
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function openingNeutralRushCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (!settings.openingExpansionTempoEnabled) {
    return undefined;
  }
  const tactical = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const openingTempo = tactical.openingExpansionTempo;
  if (
    openingTempo?.openingWindow !== true ||
    !openingTempo.neutralExpansionAvailable ||
    openingTempo.homeDanger === "high"
  ) {
    return undefined;
  }
  if (input.observation.memory.recentExpansionCount < 6) {
    return undefined;
  }
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    openingTempo.ownTileShare ??
    1;
  if (ownTileShare >= 0.18 || input.observation.turnNumber > 1_200) {
    return undefined;
  }
  const frontierConversionReady =
    tactical.frontierConversionTiming?.recommended === true &&
    tactical.frontierConversionTiming.executorReady === true &&
    tactical.frontierConversionTiming.bestExecutorReadyTargetID !== null;
  if (
    frontierConversionReady &&
    (ownTileShare >= 0.12 || input.observation.turnNumber > 1_000)
  ) {
    return undefined;
  }
  if (
    tactical.frontierFinishPressure?.recommended === true &&
    (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0
  ) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const desiredCommitment = desiredOpeningExpansionCommitment(
    input.observation,
    settings,
  );
  return scored
    .filter(
      (candidate) =>
        isNeutralGrowthAction(candidate.action) &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        candidate.totalScore >= 0,
    )
    .sort(
      (a, b) =>
        neutralGrowthActionRank(a.action) - neutralGrowthActionRank(b.action) ||
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function standingNeutralLandGrabCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (input.observation.turnNumber < 300 || plan.turnIntent === "naval") {
    return undefined;
  }
  const tactical = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    tactical.openingExpansionTempo?.ownTileShare ??
    0;
  const pressureReady =
    (tactical.frontierFinishPressure?.recommended === true &&
      (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0) ||
    (tactical.frontierConversionTiming?.recommended === true &&
      tactical.frontierConversionTiming.executorReady === true);
  if (pressureReady) {
    return undefined;
  }
  if (
    scored.some(
      (candidate) =>
        isNeutralBoatAction(candidate.action) &&
        hasPolicyContribution(
          candidate,
          "human replay opening baseline uses early neutral transport",
        ),
    )
  ) {
    return undefined;
  }
  if (
    incomingHomePressure(input.observation) &&
    neutralGrowthHomeDanger(input) === "high" &&
    immediateSurvivalActionAvailable(scored)
  ) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const desiredCommitment = desiredStandingNeutralLandCommitment(
    input.observation,
    settings,
  );
  return scored
    .filter(
      (candidate) =>
        isNeutralLandExpansionAction(candidate.action) &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        neutralLandPriorityAllowsPolicy(input, candidate, ownTileShare),
    )
    .sort(
      (a, b) =>
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        (b.skill?.totalScore ?? 0) - (a.skill?.totalScore ?? 0) ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function standingNeutralIslandBoatCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const tactical = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const pressureReady =
    (tactical.frontierFinishPressure?.recommended === true &&
      (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0) ||
    (tactical.frontierConversionTiming?.recommended === true &&
      tactical.frontierConversionTiming.executorReady === true);
  if (pressureReady || tactical.transportTroopBanking?.recommended === true) {
    return undefined;
  }
  if (neutralGrowthHomeDanger(input) === "high") {
    return undefined;
  }
  if (
    scored.some(
      (candidate) =>
        isNeutralLandExpansionAction(candidate.action) &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high",
    )
  ) {
    return undefined;
  }
  if (
    incomingHomePressure(input.observation) &&
    neutralGrowthHomeDanger(input) === "high" &&
    immediateSurvivalActionAvailable(scored)
  ) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const desiredCommitment = desiredNeutralIslandBoatCommitment(
    input.observation,
    settings,
  );
  return scored
    .filter(
      (candidate) =>
        isNeutralBoatAction(candidate.action) &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high",
    )
    .sort(
      (a, b) =>
        Math.abs(committedTroopRatio(a.action, ownTroops) - desiredCommitment) -
          Math.abs(
            committedTroopRatio(b.action, ownTroops) - desiredCommitment,
          ) ||
        b.totalScore - a.totalScore ||
        (b.skill?.totalScore ?? 0) - (a.skill?.totalScore ?? 0) ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function earlyNeutralBoatTempoCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    plan.forbiddenActionKinds.includes("boat") ||
    observation.turnNumber < 600 ||
    observation.turnNumber > 3_600
  ) {
    return undefined;
  }
  const tactical = buildAgentTacticalAffordances({
    observation,
    legalActions: input.legalActions,
  });
  const pressureReady =
    (tactical.frontierFinishPressure?.recommended === true &&
      (tactical.frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0) ||
    (tactical.frontierConversionTiming?.recommended === true &&
      tactical.frontierConversionTiming.executorReady === true);
  if (pressureReady || tactical.transportTroopBanking?.recommended === true) {
    return undefined;
  }
  if (neutralGrowthHomeDanger(input) === "high") {
    return undefined;
  }
  if (
    incomingHomePressure(observation) &&
    neutralGrowthHomeDanger(input) === "high" &&
    immediateSurvivalActionAvailable(scored)
  ) {
    return undefined;
  }
  const neutralLandExpansionCount =
    tactical.openingExpansionTempo?.neutralLandExpansionActionCount ??
    scored.filter((candidate) => isNeutralLandExpansionAction(candidate.action))
      .length;
  const neutralBoatExpansionCount =
    tactical.openingExpansionTempo?.neutralBoatExpansionActionCount ??
    scored.filter((candidate) => isNeutralBoatAction(candidate.action)).length;
  const sparseLandBoatWindow =
    tactical.openingExpansionTempo?.recommended === true &&
    tactical.openingExpansionTempo.homeDanger !== "high" &&
    neutralBoatExpansionCount > 0 &&
    (neutralLandExpansionCount <= 3 ||
      neutralBoatExpansionCount >= neutralLandExpansionCount * 2) &&
    (tactical.openingExpansionTempo.ownTileShare ?? 1) < 0.12;
  const recentBoatLookback = sparseLandBoatWindow ? 1 : 3;
  if (recentAcceptedActionKind(observation, "boat", recentBoatLookback)) {
    return undefined;
  }
  const repeatedLandExpansion =
    observation.memory.recentExpansionCount >= 3 ||
    (observation.memory.repeatedActionKind === "attack" &&
      observation.memory.repeatedActionCount >= 3);
  const hasNeutralLand = neutralLandExpansionCount > 0;
  if (!sparseLandBoatWindow && (!repeatedLandExpansion || !hasNeutralLand)) {
    return undefined;
  }
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const desiredCommitment = Math.max(
    0.12,
    Math.min(0.25, desiredNeutralIslandBoatCommitment(observation, settings)),
  );
  return scored
    .filter(
      (candidate) =>
        isNeutralBoatAction(candidate.action) &&
        candidate.action.risk.level !== "high" &&
        (!hasPolicyPenalty(candidate, "existing transports should land") ||
          sparseLandBoatWindow) &&
        (!hasPolicyPenalty(candidate, "repeated transport launches") ||
          sparseLandBoatWindow),
    )
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      return (
        neutralBoatPriority(b.action) - neutralBoatPriority(a.action) ||
        Math.abs(aCommitment - desiredCommitment) -
          Math.abs(bCommitment - desiredCommitment) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function neutralPriorityBatch(
  primary: FrontierRankedAction,
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  maxActions: number,
  observation?: AgentObservation,
): FrontierRankedAction[] {
  const economyHandoffPrimary =
    observation === undefined
      ? undefined
      : demoQualityEconomyHandoffFromNeutralPrimary(
          primary,
          scored,
          plan,
          observation,
        );
  if (economyHandoffPrimary !== undefined) {
    if (maxActions <= 1) {
      return [economyHandoffPrimary];
    }
    const selected: FrontierRankedAction[] = [economyHandoffPrimary];
    if (
      isBatchCompatible(
        primary.action,
        selected.map((item) => item.action),
      )
    ) {
      selected.push(primary);
    }
    return selected;
  }
  if (maxActions <= 1) {
    return [primary];
  }
  const selected: FrontierRankedAction[] = [primary];
  const filler = scored.find(
    (candidate) =>
      candidate.action.kind !== "hold" &&
      candidate.action.id !== primary.action.id &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      (candidate.schedulerSlot === "economic_structure" ||
        candidate.schedulerSlot === "defensive_structure" ||
        candidate.action.kind === "build" ||
        candidate.action.kind === "upgrade_structure") &&
      isBatchCompatible(
        candidate.action,
        selected.map((item) => item.action),
      ),
  );
  if (filler !== undefined) {
    selected.push(filler);
  }
  return selected;
}

function incomingHomePressure(
  observation: AgentBrainInput["observation"],
): boolean {
  return (
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.combat.incomingAttacks?.length ?? 0) > 0
  );
}

function incomingThreatRatioForObservation(
  observation: AgentBrainInput["observation"],
): number {
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  if (ownTroops <= 0) {
    return 0;
  }
  const incomingThreatTroops = (
    observation.combat.incomingAttacks ?? []
  ).reduce((sum, attack) => sum + (attack.retreating ? 0 : attack.troops), 0);
  return incomingThreatTroops / ownTroops;
}

function dangerousEstablishedNeutralGrowthUnderPressure(
  input: AgentBrainInput,
): boolean {
  const observation = input.observation;
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  return (
    isHardNationStrategicContext(observation) &&
    observation.turnNumber >= 1_200 &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    ownTiles >= 8_000 &&
    ownTiles <= 20_000 &&
    incomingThreatRatioForObservation(observation) >= 0.45
  );
}

function neutralLandPriorityAllowsPolicy(
  input: AgentBrainInput,
  candidate: FrontierRankedAction,
  ownTileShare: number,
): boolean {
  if (hasPolicyPenalty(candidate, "neutral expansion is not gaining land")) {
    return false;
  }
  if (
    hasPolicyPenalty(
      candidate,
      "high incoming pressure should preserve troops before neutral expansion",
    )
  ) {
    return false;
  }
  if (
    hasPolicyPenalty(
      candidate,
      "stalled island expansion should launch transport",
    )
  ) {
    return false;
  }
  if (
    hasPolicyPenalty(candidate, "stronger border rival requires stabilizing") &&
    (input.observation.strategic.urgency === "high" || ownTileShare >= 0.18)
  ) {
    return false;
  }
  if (
    hasPolicyPenalty(candidate, "bordered rival pressure makes repeated") &&
    ownTileShare >= 0.18
  ) {
    return false;
  }
  if (
    hasPolicyPenalty(candidate, "pressure plan should not spend troops") &&
    ownTileShare >= 0.18
  ) {
    return false;
  }
  if (
    hasPolicyPenalty(
      candidate,
      "hard-nation land lead must convert rivals instead of farming neutral land",
    )
  ) {
    return false;
  }
  return true;
}

function neutralGrowthHomeDanger(input: AgentBrainInput): string {
  const tactical = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  return (
    tactical.frontierFinishPressure?.homeDanger ??
    tactical.frontierConversionTiming?.homeDanger ??
    tactical.openingExpansionTempo?.homeDanger ??
    tactical.transportTroopBanking?.homeDanger ??
    "low"
  );
}

function immediateSurvivalActionAvailable(
  scored: readonly FrontierRankedAction[],
): boolean {
  return scored.some(
    (candidate) =>
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      candidate.totalScore >= 70 &&
      (candidate.action.kind === "retreat" ||
        candidate.action.kind === "boat_retreat" ||
        isDefensiveAction(candidate.action)),
  );
}

function desiredStandingNeutralLandCommitment(
  observation: AgentBrainInput["observation"],
  settings: AgentSettings,
): number {
  const troopRatio =
    observation.combat.troopRatio ?? observation.ownState?.troopRatio ?? 0;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  if (troopRatio <= settings.retreatThreshold * 0.5) {
    return 0.1;
  }
  if (ownTileShare < 0.04) {
    return 0.35;
  }
  if (ownTileShare < 0.18 && troopRatio >= settings.triggerRatio * 0.7) {
    return 0.2;
  }
  if (ownTileShare < 0.26 && troopRatio >= settings.triggerRatio) {
    return 0.2;
  }
  return 0.1;
}

function desiredNeutralIslandBoatCommitment(
  observation: AgentBrainInput["observation"],
  settings: AgentSettings,
): number {
  const troopRatio =
    observation.combat.troopRatio ?? observation.ownState?.troopRatio ?? 0;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  if (troopRatio <= settings.retreatThreshold * 0.55) {
    return 0.08;
  }
  if (ownTileShare < 0.18 && troopRatio >= settings.triggerRatio) {
    return 0.25;
  }
  return 0.16;
}

function humanReplayOpeningGrowthRank(candidate: FrontierRankedAction): number {
  if (isHumanReplayOpeningBoatTempoCandidate(candidate)) {
    return 0;
  }
  return neutralGrowthActionRank(candidate.action);
}

function isHumanReplayOpeningBoatTempoCandidate(
  candidate: FrontierRankedAction,
): boolean {
  return hasPolicyContribution(
    candidate,
    "human replay opening baseline uses early neutral transport",
  );
}

function desiredOpeningExpansionCommitment(
  observation: AgentObservation,
  settings: AgentSettings,
): number {
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const troopRatio =
    observation.combat.troopRatio ?? observation.ownState?.troopRatio ?? 1;
  const recentExpansionCount = observation.memory.recentExpansionCount;
  if (
    recentExpansionCount >= 6 ||
    (recentExpansionCount >= 3 && troopRatio < 0.4)
  ) {
    return Math.min(settings.expansionRatio, 0.15);
  }
  if (
    recentExpansionCount >= 3 ||
    (recentExpansionCount >= 2 && troopRatio < 0.5)
  ) {
    return 0.2;
  }
  if (ownTiles < 6_000) {
    return 0.35;
  }
  if (ownTiles < 12_000) {
    return 0.25;
  }
  return settings.expansionRatio;
}

function transportTroopBankingCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (!settings.transportTroopBankingEnabled) {
    return undefined;
  }
  const banking = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  }).transportTroopBanking;
  if (!banking.recommended || plan.forbiddenActionKinds.includes("boat")) {
    return undefined;
  }
  const finishPressure = directSelectionCandidate(
    frontierFinishPressureAttackCandidate(input, scored, settings),
  );
  if (
    finishPressure !== undefined &&
    isDecisiveFinishPressureCandidate(finishPressure)
  ) {
    return undefined;
  }
  const safeNearCapBankingWindow =
    banking.nearCap &&
    banking.homeDanger !== "high" &&
    (banking.effectiveFutureTroopRatio ?? 0) >= 1.1 &&
    (banking.activeBankRatio ?? 0) < 0.65;
  if (
    !plan.preferredActionKinds.includes("boat") &&
    !banking.continuationReady &&
    !safeNearCapBankingWindow
  ) {
    return undefined;
  }
  const urgentLandPressure = scored.some(
    (candidate) =>
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true &&
      candidate.totalScore >= 92 &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
  if (
    urgentLandPressure &&
    !safeNearCapBankingWindow &&
    !plan.enabledModules?.includes("naval")
  ) {
    return undefined;
  }
  if ((banking.effectiveFutureTroopRatio ?? 1) > 1.75) {
    return undefined;
  }
  const cleanHighValueLandAttack = scored.some(
    (candidate) =>
      candidate.action.kind === "attack" &&
      candidate.totalScore >= 80 &&
      actionIsSafeBankingOverrideAttack(candidate) &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
  const highValueLandOrEconomyAction = scored.some(
    (candidate) =>
      (candidate.action.kind === "attack" ||
        candidate.action.kind === "build") &&
      candidate.totalScore >= 90 &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
  if (
    (banking.activeBankRatio ?? 0) >= 0.2 &&
    highValueLandOrEconomyAction &&
    !safeNearCapBankingWindow
  ) {
    return undefined;
  }
  const canContinueSafeBanking =
    safeNearCapBankingWindow &&
    banking.continuationReady &&
    (banking.activeBankRatio ?? 0) < 0.45;
  const canRestartSafeBanking =
    safeNearCapBankingWindow && banking.activeTransportCount === 0;
  const cleanNearCapLandConversion =
    safeNearCapBankingWindow && (banking.activeBankRatio ?? 0) < 0.25
      ? cleanNearCapLandConversionCandidate(input, scored)
      : undefined;
  if (cleanNearCapLandConversion !== undefined) {
    return cleanNearCapLandConversion;
  }
  const replayBankingWindow =
    safeNearCapBankingWindow &&
    banking.homeDanger !== "high" &&
    (banking.activeBankRatio ?? 0) < 0.52;
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "boat" &&
        candidate.action.risk.level !== "high" &&
        candidate.totalScore >= (replayBankingWindow ? 0 : 70) &&
        !(
          cleanHighValueLandAttack &&
          isPlayerBoatAction(candidate.action) &&
          !replayBankingWindow
        ) &&
        (!hasPolicyPenalty(candidate, "existing transports should land") ||
          canContinueSafeBanking) &&
        (!hasPolicyPenalty(candidate, "repeated transport launches") ||
          canContinueSafeBanking ||
          canRestartSafeBanking) &&
        transportTroopBankingLaunchTroops(candidate.action, banking) > 0 &&
        (safeNearCapBankingWindow ||
          hasPolicyContribution(
            candidate,
            "transport troop-banking converts capped population into future force",
          )),
    )
    .sort(
      (a, b) =>
        transportTroopBankingLaunchTroops(b.action, banking) -
          transportTroopBankingLaunchTroops(a.action, banking) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function navalControlCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  if (!settings.navalControlEnabled || plan.objective === "survive") {
    return undefined;
  }
  const naval = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  }).navalControl;
  if (naval?.recommended !== true || naval.bestNavalActionID === null) {
    return undefined;
  }
  return scored
    .filter(
      (candidate) =>
        candidate.action.id === naval.bestNavalActionID &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        !hasSchedulingBlockingPolicyPenalty(candidate) &&
        candidate.totalScore >= 32,
    )
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
    )[0];
}

function cleanNearCapLandConversionCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        candidate.totalScore < 80 ||
        hasSchedulingBlockingPolicyPenalty(candidate) ||
        !actionIsSafeBankingOverrideAttack(candidate)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio = metadataNumber(
        candidate.action,
        "relativeTroopRatio",
      );
      return (
        commitment >= 0.18 && commitment <= 0.32 && relativeTroopRatio >= 1.8
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function actionIsSafeBankingOverrideAttack(
  candidate: FrontierRankedAction,
): boolean {
  if (!actionIsFavorableHostileAttack(candidate.action)) {
    return false;
  }
  return (
    !hasPolicyPenalty(
      candidate,
      "attacking a stronger rival feeds them troops",
    ) &&
    !hasPolicyPenalty(
      candidate,
      "counterpressure probe is too small to stop an invasion",
    ) &&
    !hasPolicyPenalty(
      candidate,
      "urgent defense state makes non-leader attacks too risky",
    ) &&
    !hasPolicyPenalty(candidate, "troop ratio is below attack trigger") &&
    !hasPolicyPenalty(candidate, "active pressure makes new wars unsafe")
  );
}

function isDecisiveFinishPressureCandidate(
  candidate: FrontierRankedAction,
): boolean {
  return (
    directActionCommitment(candidate.action) >= 0.18 &&
    !hasPolicyPenalty(
      candidate,
      "counterpressure probe is too small to stop an invasion",
    )
  );
}

function demoQualityEconomyHandoffCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    observation.phase !== "active" ||
    plan.objective === "survive" ||
    observation.combat.incomingAttackPlayerIDs.length > 0
  ) {
    return undefined;
  }
  const poorDefensePostOffered = input.legalActions.some(
    isPoorDefensePostAction,
  );
  const legalEconomyBuildOffered = input.legalActions.some(
    (action) =>
      action.kind === "build" && isEconomicUnit(metadataString(action, "unit")),
  );
  const repeatedExpansionHandoff =
    plan.objective === "expand_territory" &&
    observation.memory.recentExpansionCount >= 2 &&
    observation.memory.recentBuildCount === 0 &&
    legalEconomyBuildOffered;
  if (!poorDefensePostOffered && !repeatedExpansionHandoff) {
    return undefined;
  }
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "build" &&
        candidate.action.risk.level !== "high" &&
        isEconomicUnit(metadataString(candidate.action, "unit")),
    )
    .sort(
      (a, b) =>
        demoQualityEconomicUnitPriority(input.observation, b.action) -
          demoQualityEconomicUnitPriority(input.observation, a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function demoQualityWeakNeighborPressureCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    observation.phase !== "active" ||
    plan.objective === "survive" ||
    (observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency === "high")
  ) {
    return undefined;
  }
  const affordances = buildAgentTacticalAffordances({
    observation,
    legalActions: input.legalActions,
  });
  const openingStillBehind =
    affordances.openingExpansionTempo?.recommended === true &&
    (affordances.openingExpansionTempo.ownTileShare ?? 0) <
      (affordances.openingExpansionTempo.expectedTileShare ?? 0) &&
    observation.turnNumber < 1_200 &&
    plan.objective !== "pressure_rival";
  if (openingStillBehind) {
    return undefined;
  }
  const pressureHandoffReady =
    observation.memory.recentExpansionCount >= 3 ||
    (observation.ownState?.tilesOwned ?? 0) >= 16_000 ||
    observation.turnNumber >= 1_200;
  if (!pressureHandoffReady) {
    return undefined;
  }
  const finishTargetID = affordances.frontierFinishPressure?.bestTargetID;
  if (finishTargetID !== null && finishTargetID !== undefined) {
    const finishPressure = affordances.frontierFinishPressure;
    const finishRatio = finishPressure?.bestTargetRelativeTroopRatio ?? 0;
    const finishTargetShare = finishPressure?.bestTargetTileShare ?? 1;
    const decisiveFinishWindow =
      finishRatio >= 2.25 ||
      finishTargetShare <= 0.05 ||
      (finishRatio >= 1.35 && finishTargetShare <= 0.08);
    if (
      recentAcceptedMediumAttackCount(observation, finishTargetID, 6) >= 2 &&
      !decisiveFinishWindow
    ) {
      return undefined;
    }
  }
  const finishPressure = directSelectionCandidate(
    frontierFinishPressureAttackCandidate(input, scored),
  );
  if (finishPressure !== undefined) {
    return finishPressure;
  }
  const conversion = affordances.frontierConversionTiming;
  if (
    conversion?.recommended !== true ||
    !conversion.executorReady ||
    conversion.bestExecutorReadyTargetID === null ||
    conversion.homeDanger === "high"
  ) {
    return undefined;
  }
  const currentTargetID = currentWarTargetID(input);
  const currentTargetHasReadyAttack =
    currentTargetID !== null &&
    scored.some(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        candidate.action.risk.level !== "high" &&
        actionTargetsPlayer(candidate.action, currentTargetID) &&
        actionIsFavorableHostileAttack(candidate.action),
    );
  const planTargetID =
    plan.objective === "pressure_rival" ? plan.targetPlayerId : null;
  const planTargetHasReadyAttack =
    planTargetID !== null &&
    scored.some(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        candidate.action.risk.level !== "high" &&
        actionTargetsPlayer(candidate.action, planTargetID) &&
        actionIsFavorableHostileAttack(candidate.action) &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) &&
        !hasPolicyPenalty(
          candidate,
          "attack would deplete the reserve below competitive defense",
        ),
    );
  const targetID = planTargetHasReadyAttack
    ? planTargetID!
    : currentTargetHasReadyAttack && plan.objective === "pressure_rival"
      ? currentTargetID!
      : conversion.bestExecutorReadyTargetID;
  const targetIsDecisiveFinish =
    targetID === finishTargetID &&
    ((affordances.frontierFinishPressure?.bestTargetRelativeTroopRatio ?? 0) >=
      2.25 ||
      (affordances.frontierFinishPressure?.bestTargetTileShare ?? 1) <= 0.05 ||
      ((affordances.frontierFinishPressure?.bestTargetRelativeTroopRatio ??
        0) >= 1.35 &&
        (affordances.frontierFinishPressure?.bestTargetTileShare ?? 1) <=
          0.08));
  if (
    !targetIsDecisiveFinish &&
    (recentAcceptedLowCommitmentAttackCount(observation, targetID, 8) >= 2 ||
      recentAcceptedMediumAttackCount(observation, targetID, 6) >= 2)
  ) {
    return undefined;
  }
  if (
    conversion.neutralExpansionAvailable === true &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) < 1.3 &&
    targetID === conversion.bestExecutorReadyTargetID
  ) {
    return undefined;
  }
  const canonicalConversion = directSelectionCandidate(
    frontierConversionTimingAttackCandidate(input, scored, plan),
  );
  if (canonicalConversion !== undefined) {
    return canonicalConversion;
  }
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const desiredCommitment =
    targetIsDecisiveFinish ||
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) >= 1.75 ||
    ((conversion.bestExecutorReadyRelativeTroopRatio ?? 0) >= 1.3 &&
      (conversion.bestExecutorReadyTileShare ?? 1) <= 0.08) ||
    observation.memory.recentExpansionCount >= 3
      ? 0.25
      : 0.1;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        !actionTargetsPlayer(candidate.action, targetID)
      ) {
        return false;
      }
      if (
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) ||
        hasPolicyPenalty(
          candidate,
          "attack would deplete the reserve below competitive defense",
        ) ||
        hasPolicyPenalty(
          candidate,
          "urgent defense state makes non-leader attacks too risky",
        ) ||
        hasPolicyPenalty(candidate, "troop ratio is below attack trigger")
      ) {
        return false;
      }
      if (!demoQualityPressureAllowsScheduling(candidate)) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      return (
        commitment >= 0.08 && commitment <= 0.32 && relativeTroopRatio >= 1.2
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      return (
        Math.abs(aCommitment - desiredCommitment) -
          Math.abs(bCommitment - desiredCommitment) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function demoQualityPressureAllowsScheduling(
  candidate: FrontierRankedAction,
): boolean {
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return true;
  }
  return blockers.every((reason) =>
    [
      "blocking policy penalty",
      "multi-rival opening pressure should use reserve-preserving probes",
      "medium and large attacks require a developed troop base",
      "medium attack needs a clear troop edge outside finish mode",
      "early multi-front hard-nation trades need a decisive edge",
    ].includes(reason),
  );
}

function demoQualityEconomicUnitPriority(
  observation: AgentObservation,
  action: LegalAction,
): number {
  const unit = metadataString(action, "unit");
  if (unit === UnitType.City || unit === "City") {
    return ownUnitCount(observation, UnitType.City) === 0 ? 30 : 3;
  }
  if (unit === UnitType.Factory || unit === "Factory") {
    return ownUnitCount(observation, UnitType.Factory) === 0 ? 20 : 2;
  }
  if (unit === UnitType.Port || unit === "Port") {
    return ownUnitCount(observation, UnitType.Port) === 0 ? 10 : 1;
  }
  return 0;
}

function humanReplayEconomyFoundationCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  settings: AgentSettings,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    observation.turnNumber < 900 ||
    observation.turnNumber > 7_200 ||
    plan.objective === "survive" ||
    (observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency === "high" &&
      observation.combat.incomingAttackPlayerIDs.length > 0)
  ) {
    return undefined;
  }
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const noCity = ownUnitCount(observation, UnitType.City) === 0;
  const noFactory = ownUnitCount(observation, UnitType.Factory) === 0;
  const noPort = ownUnitCount(observation, UnitType.Port) === 0;
  const foundationNeeded =
    noCity || (ownTiles >= 8_000 && (noFactory || noPort));
  const cadenceNeeded =
    settings.humanReplayEconomyCadenceEnabled &&
    !foundationNeeded &&
    humanReplayWinnerEconomyCadenceReady(input, plan, scored, ownTiles);
  if (!foundationNeeded && !cadenceNeeded) {
    return undefined;
  }
  const candidates = scored
    .filter(
      (candidate) =>
        candidate.action.kind === "build" &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        isEconomicUnit(metadataString(candidate.action, "unit")) &&
        candidate.totalScore >= (foundationNeeded ? 70 : 45),
    )
    .sort(
      (a, b) =>
        humanReplayEconomyFoundationPriority(
          input,
          b.action,
          ownTiles,
          settings,
        ) -
          humanReplayEconomyFoundationPriority(
            input,
            a.action,
            ownTiles,
            settings,
          ) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    );
  const best = candidates[0];
  if (
    best === undefined ||
    humanReplayEconomyFoundationPriority(
      input,
      best.action,
      ownTiles,
      settings,
    ) <= 0
  ) {
    return undefined;
  }
  return best;
}

function humanReplayWinnerEconomyCadenceReady(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
  ownTiles: number,
): boolean {
  const observation = input.observation;
  if (
    observation.turnNumber < 1_800 ||
    ownTiles < 12_000 ||
    observation.memory.recentBuildCount > 0 ||
    plan.objective === "survive" ||
    neutralGrowthHomeDanger(input) === "high" ||
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.combat.incomingAttacks?.length ?? 0) > 0
  ) {
    return false;
  }
  if (decisiveHumanReplayFinishPressureAvailable(scored)) {
    return false;
  }
  const targetEconomyCount = humanReplayWinnerEconomyTargetCount(ownTiles);
  const currentEconomyCount =
    ownUnitCount(observation, UnitType.City) +
    ownUnitCount(observation, UnitType.Factory) +
    ownUnitCount(observation, UnitType.Port);
  if (currentEconomyCount >= targetEconomyCount) {
    return false;
  }
  const directNeutralStillUrgent =
    ownTiles < 18_000 &&
    observation.memory.recentExpansionCount < 5 &&
    scored.some(
      (candidate) =>
        isNeutralLandExpansionAction(candidate.action) &&
        candidate.action.risk.level !== "high" &&
        !hasSchedulingBlockingPolicyPenalty(candidate),
    );
  if (directNeutralStillUrgent) {
    return false;
  }
  return true;
}

function humanReplayWinnerEconomyTargetCount(ownTiles: number): number {
  if (ownTiles < 18_000) {
    return 3;
  }
  if (ownTiles < 32_000) {
    return 4;
  }
  if (ownTiles < 52_000) {
    return 5;
  }
  return 6;
}

function decisiveHumanReplayFinishPressureAvailable(
  scored: readonly FrontierRankedAction[],
): boolean {
  return scored.some((candidate) => {
    if (
      candidate.action.kind !== "attack" ||
      candidate.action.metadata?.expansion === true ||
      candidate.action.risk.level === "high" ||
      hasSchedulingBlockingPolicyPenalty(candidate)
    ) {
      return false;
    }
    const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
    const relativeTroopRatio = metadataNumber(
      candidate.action,
      "relativeTroopRatio",
    );
    return (
      candidate.totalScore >= 82 &&
      targetTileShare > 0 &&
      targetTileShare <= 0.035 &&
      relativeTroopRatio >= 1.8
    );
  });
}

function humanReplayEconomyFoundationPriority(
  input: AgentBrainInput,
  action: LegalAction,
  ownTiles: number,
  settings: AgentSettings,
): number {
  const unit = metadataString(action, "unit");
  const cityCount = ownUnitCount(input.observation, UnitType.City);
  const factoryCount = ownUnitCount(input.observation, UnitType.Factory);
  const portCount = ownUnitCount(input.observation, UnitType.Port);
  if (unit === "City" && ownUnitCount(input.observation, UnitType.City) === 0) {
    return 300;
  }
  if (
    unit === "Factory" &&
    ownTiles >= 8_000 &&
    ownUnitCount(input.observation, UnitType.Factory) === 0
  ) {
    return 230;
  }
  if (
    unit === "Port" &&
    ownTiles >= 8_000 &&
    ownUnitCount(input.observation, UnitType.Port) === 0
  ) {
    return settings.humanReplayEconomyCadenceEnabled && cityCount > 0
      ? 245
      : 220;
  }
  if (unit === "City") {
    return cityCount < Math.max(1, Math.floor(ownTiles / 32_000))
      ? 190 - cityCount * 12
      : 160;
  }
  if (unit === "Factory") {
    return factoryCount < Math.max(1, Math.floor(ownTiles / 28_000))
      ? 185 - factoryCount * 14
      : 140;
  }
  if (unit === "Port") {
    return portCount < Math.max(2, Math.floor(ownTiles / 18_000))
      ? 195 - portCount * 16
      : 130;
  }
  return 0;
}

function urgentFortifyPlanCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
  settings?: Pick<AgentSettings, "frontierFinishPressureEnabled">,
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const urgentFortify =
    (plan.objective === "fortify_border" || plan.objective === "survive") &&
    plan.preferredActionKinds.some((kind) =>
      [
        "build",
        "upgrade_structure",
        "retreat",
        "boat_retreat",
        "hold",
      ].includes(kind),
    );
  const strategicFortify =
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency !== "low";
  if (!urgentFortify && !strategicFortify) {
    return undefined;
  }

  const defensiveStructure = scored
    .filter(
      (candidate) =>
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        (candidate.action.kind === "build" ||
          candidate.action.kind === "upgrade_structure") &&
        isDefensiveAction(candidate.action) &&
        candidate.action.risk.level !== "high" &&
        !isPoorDefensePostAction(candidate.action),
    )
    .sort((a, b) => {
      const aIncoming =
        a.action.metadata?.nearbyIncomingAttack === true ? 1 : 0;
      const bIncoming =
        b.action.metadata?.nearbyIncomingAttack === true ? 1 : 0;
      const aDefensive = metadataNumber(a.action, "defensiveValue");
      const bDefensive = metadataNumber(b.action, "defensiveValue");
      const aFrontier = metadataNumber(a.action, "frontierValue");
      const bFrontier = metadataNumber(b.action, "frontierValue");
      return (
        bIncoming - aIncoming ||
        bDefensive - aDefensive ||
        bFrontier - aFrontier ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
  if (defensiveStructure !== undefined) {
    return defensiveStructure;
  }

  const retreat = scored.find(
    (candidate) =>
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      (candidate.action.kind === "retreat" ||
        candidate.action.kind === "boat_retreat") &&
      !isNeutralRetreatAction(candidate.action) &&
      !shouldProtectFreshEscapeTransport(input, candidate.action) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      candidate.totalScore >= 60,
  );
  if (retreat !== undefined) {
    return retreat;
  }

  if (plan.objective !== "fortify_border" && plan.objective !== "survive") {
    return undefined;
  }
  if (
    frontierFinishPressureAttackCandidate(input, scored, settings) !==
      undefined ||
    frontierConversionTimingAttackCandidate(input, scored, plan) !== undefined
  ) {
    return undefined;
  }
  const criticalCounterattack = scored.find(
    (candidate) =>
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true &&
      hasPolicyContribution(
        candidate,
        "critical border collapse counterattack",
      ) &&
      isCredibleEmergencyCounterattack(candidate, {
        maxCommitment: 0.12,
        minRelativeTroopRatio: 0.25,
        maxTargetTileShare: 0.5,
      }) &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
  if (criticalCounterattack !== undefined) {
    return criticalCounterattack;
  }
  return scored.find(
    (candidate) =>
      candidate.action.kind === "hold" &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind),
  );
}

function turnIntentPriorityCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const turnIntent = resolvedPlanTurnIntent(input, plan);
  if (turnIntent === "build") {
    return plannedBuildCandidate(input, plan, scored);
  }
  if (turnIntent === "naval") {
    return plannedNavalIntentCandidate(input, plan, scored);
  }
  if (turnIntent === "pressure") {
    return plannedPressureIntentCandidate(input, plan, scored);
  }
  return undefined;
}

function plannedNavalIntentCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "boat" &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        navalIntentAllowsScheduling(input, candidate) &&
        candidate.totalScore >= 50,
    )
    .sort(
      (a, b) =>
        neutralBoatPriority(b.action) - neutralBoatPriority(a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function navalIntentAllowsScheduling(
  input: AgentBrainInput,
  candidate: FrontierRankedAction,
): boolean {
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return false;
  }
  const neutralBoatDiversifier =
    isNeutralBoatAction(candidate.action) &&
    input.observation.memory.repeatedActionKind === "attack" &&
    input.observation.memory.repeatedActionCount >= 4 &&
    input.observation.combat.incomingAttackPlayerIDs.length === 0 &&
    !recentAcceptedActionKind(input.observation, "boat", 4);
  if (!neutralBoatDiversifier) {
    return false;
  }
  const landExpansionTransportBlocker =
    "land expansion is safer than neutral transport while borders can still grow";
  const hasOnlyLandExpansionDefaultPenalty = candidate.policy.penalties.every(
    (penalty) =>
      penalty.includes(landExpansionTransportBlocker) ||
      penalty.includes("recent repeated action kind") ||
      penalty.includes("exact action was recently repeated"),
  );
  return blockers.every(
    (reason) =>
      reason === landExpansionTransportBlocker ||
      (reason === "blocking policy penalty" &&
        hasOnlyLandExpansionDefaultPenalty),
  );
}

function neutralBoatPriority(action: LegalAction): number {
  return isNeutralBoatAction(action) ? 1 : 0;
}

function plannedPressureIntentCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
        candidate.action.risk.level !== "high" &&
        pressureIntentAllowsScheduling(input, plan, candidate) &&
        candidate.totalScore >= 60,
    )
    .sort(
      (a, b) =>
        pressureProbePriority(input, b.action) -
          pressureProbePriority(input, a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function pressureIntentAllowsScheduling(
  input: AgentBrainInput,
  plan: StrategicPlan,
  candidate: FrontierRankedAction,
): boolean {
  const targetID = actionPlayerID(candidate.action);
  if (
    plan.targetPlayerId !== null &&
    targetID !== null &&
    targetID !== plan.targetPlayerId
  ) {
    return false;
  }
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return true;
  }
  const observation = input.observation;
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const commitment = committedTroopRatio(candidate.action, ownTroops);
  const metadataRelativeTroopRatio = metadataNumber(
    candidate.action,
    "relativeTroopRatio",
  );
  const visibleRelativeTroopRatio =
    targetID === null
      ? 0
      : (observation.visiblePlayers.find(
          (player) => player.playerID === targetID,
        )?.relativeTroopRatio ?? 0);
  const relativeTroopRatio =
    metadataRelativeTroopRatio || visibleRelativeTroopRatio;
  const pressureProbeWindow =
    commitment > 0 &&
    commitment <= 0.12 &&
    relativeTroopRatio >= 1.8 &&
    observation.combat.incomingAttackPlayerIDs.length === 0 &&
    (observation.combat.outgoingAttacks?.length ?? 0) <= 1 &&
    (observation.memory.recentExpansionCount >= 2 ||
      observation.memory.repeatedActionKind === "attack") &&
    (targetID === null ||
      recentAcceptedTargetID(observation, ["attack"], 1) !== targetID);
  if (!pressureProbeWindow) {
    return false;
  }
  return blockers.every((reason) =>
    [
      "troop ratio is below attack trigger",
      "attack would deplete the reserve below competitive defense",
      "multi-rival opening pressure should use reserve-preserving probes",
      "counterpressure probe is too small to stop an invasion",
      "blocking policy penalty",
    ].includes(reason),
  );
}

function pressureProbePriority(
  input: AgentBrainInput,
  action: LegalAction,
): number {
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const commitment = committedTroopRatio(action, ownTroops);
  return Math.round((0.2 - Math.min(0.2, commitment)) * 1_000);
}

function plannedBuildWhileStalledCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const buildIsPlanned =
    plan.preferredActionKinds.includes("build") ||
    plan.preferredActionKinds.includes("upgrade_structure") ||
    (plan.enabledModules?.some(
      (module) => module === "defense" || module === "economy",
    ) ??
      false);
  if (!buildIsPlanned) {
    return undefined;
  }
  if (
    input.observation.memory.recentBuildCount > 0 &&
    input.observation.strategic.priority !== "build_defense"
  ) {
    return undefined;
  }

  const cleanNonBuildProgress = scored.some(
    (candidate) =>
      candidate.action.kind !== "build" &&
      candidate.action.kind !== "upgrade_structure" &&
      candidate.action.kind !== "hold" &&
      !isSocialFlavorAction(candidate.action) &&
      isMapProgressOrDiplomacyAction(candidate.action) &&
      !hasSchedulingBlockingPolicyPenalty(candidate) &&
      candidate.totalScore >= 70,
  );
  if (cleanNonBuildProgress) {
    return undefined;
  }

  return plannedBuildCandidate(input, plan, scored);
}

function plannedBuildCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  return scored
    .filter((candidate) => {
      if (
        plan.forbiddenActionKinds.includes(candidate.action.kind) ||
        (candidate.action.kind !== "build" &&
          candidate.action.kind !== "upgrade_structure") ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      if (isDefensiveAction(candidate.action)) {
        return !isPoorDefensePostAction(candidate.action);
      }
      return isEconomicUnit(metadataString(candidate.action, "unit"));
    })
    .sort((a, b) => {
      const aPriority = plannedBuildPriority(input, a.action);
      const bPriority = plannedBuildPriority(input, b.action);
      return (
        bPriority - aPriority ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function plannedBuildPriority(
  input: AgentBrainInput,
  action: LegalAction,
): number {
  const unit = metadataString(action, "unit");
  if (unit === "City" && ownUnitCount(input.observation, UnitType.City) === 0) {
    return 120;
  }
  if (unit === "Factory") {
    return 90;
  }
  if (unit === "Port") {
    return 80;
  }
  if (isDefensePostAction(action)) {
    const urgentDefense =
      input.observation.strategic.priority === "build_defense" &&
      input.observation.strategic.urgency !== "low";
    return (
      (urgentDefense ? 95 : 70) +
      metadataNumber(action, "defensiveValue") * 20 +
      metadataNumber(action, "frontierValue") * 10
    );
  }
  return isDefensiveAction(action) ? 60 : 40;
}

function humanReplayConversionCommitCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const affordances = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const conversion = affordances.frontierConversionTiming;
  if (
    conversion?.recommended !== true ||
    !conversion.executorReady ||
    conversion.bestExecutorReadyTargetID === null ||
    conversion.homeDanger === "high" ||
    (conversion.incomingThreatRatio ?? 0) > 0.3
  ) {
    return undefined;
  }
  const openingTempo = affordances.openingExpansionTempo;
  if (
    openingTempo?.recommended === true &&
    openingTempo.behindExpectedTempo === true &&
    (openingTempo.ownTileShare ?? 1) < (openingTempo.expectedTileShare ?? 0)
  ) {
    return undefined;
  }
  const targetID = conversion.bestExecutorReadyTargetID;
  const targetLowProbeCount = recentAcceptedLowCommitmentAttackCount(
    input.observation,
    targetID,
    8,
  );
  const readyRatio = conversion.bestExecutorReadyRelativeTroopRatio ?? 0;
  const troopRatio =
    input.observation.combat.troopRatio ??
    input.observation.ownState?.troopRatio ??
    1;
  const defensiveButDominant =
    input.observation.strategic.priority === "build_defense" &&
    input.observation.strategic.urgency !== "low" &&
    readyRatio >= 2.35 &&
    troopRatio >= 0.5;
  const provenProbeWindow = targetLowProbeCount >= 2 && readyRatio >= 1.45;
  if (!provenProbeWindow && !defensiveButDominant) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const desiredCommitment = provenProbeWindow ? 0.25 : 0.1;
  return scored
    .filter((candidate) => {
      const candidateTargetID = actionPlayerID(candidate.action);
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        candidateTargetID !== targetID
      ) {
        return false;
      }
      const target =
        input.observation.visiblePlayers.find(
          (player) => player.playerID === candidateTargetID,
        ) ?? null;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target?.tileShare ||
        0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target?.relativeTroopRatio ||
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const minCommitment = provenProbeWindow ? 0.18 : 0;
      const maxCommitment = provenProbeWindow ? 0.32 : 0.12;
      return (
        commitment > 0 &&
        commitment >= minCommitment &&
        commitment <= maxCommitment &&
        actionMatchesFrontierConversionReadyAttack({
          action: candidate.action,
          conversion,
          actionPlayerID: candidateTargetID,
          troopCommitment: commitment,
          relativeTroopRatio,
          targetTileShare,
          ownTileShare:
            input.observation.ownState?.tileShare ??
            input.observation.endgame?.ownTileShare ??
            0,
        }) &&
        humanReplayConversionCommitAllowsScheduling(candidate, {
          relativeTroopRatio,
          defensiveButDominant,
        })
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - desiredCommitment) -
          Math.abs(bCommitment - desiredCommitment) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function humanReplayConversionCommitAllowsScheduling(
  candidate: FrontierRankedAction,
  context: {
    relativeTroopRatio: number;
    defensiveButDominant: boolean;
  },
): boolean {
  if (
    hasPolicyPenalty(
      candidate,
      "attacking a stronger rival feeds them troops",
    ) ||
    hasPolicyPenalty(
      candidate,
      "hard-nation underdog should not feed stronger rival probes",
    ) ||
    hasPolicyPenalty(candidate, "attack lacks a clear troop edge") ||
    hasPolicyPenalty(candidate, "medium counterattack needs edge") ||
    hasPolicyPenalty(candidate, "large counterattack needs decisive edge") ||
    hasPolicyPenalty(
      candidate,
      "early multi-front hard-nation trades need a decisive edge",
    ) ||
    hasPolicyPenalty(candidate, "hard-nation attack wave should rebuild troops")
  ) {
    return false;
  }
  if (
    hasPolicyPenalty(
      candidate,
      "urgent defense state makes non-leader attacks too risky",
    ) &&
    !context.defensiveButDominant &&
    context.relativeTroopRatio < 2.2
  ) {
    return false;
  }
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return true;
  }
  return blockers.every((reason) =>
    [
      "active pressure makes new wars unsafe",
      "urgent defense state makes non-leader attacks too risky",
      "troop ratio is below attack trigger",
      "attack would deplete the reserve below competitive defense",
      "max concurrent wars already reached",
      "finish current war before opening another front",
      "finish favorable current war before switching fronts",
      "hostile action does not match the active focus target",
      "multi-rival opening pressure should use reserve-preserving probes",
      "medium and large attacks require a developed troop base",
      "medium attack needs a clear troop edge outside finish mode",
      "blocking policy penalty",
    ].includes(reason),
  );
}

function strongFrontierConversionHandoffCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
  settings?: Pick<AgentSettings, "frontierFinishPressureEnabled">,
): FrontierRankedAction | undefined {
  if (
    plan.objective === "fortify_border" ||
    plan.objective === "survive" ||
    (input.observation.strategic.priority === "build_defense" &&
      input.observation.strategic.urgency !== "low")
  ) {
    return undefined;
  }
  const affordances = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const conversion = affordances.frontierConversionTiming;
  if (
    conversion?.recommended !== true ||
    !conversion.executorReady ||
    conversion.bestExecutorReadyTargetID === null
  ) {
    return undefined;
  }
  const finishPressure = directSelectionCandidate(
    frontierFinishPressureAttackCandidate(input, scored, settings),
  );
  if (
    finishPressure !== undefined &&
    actionTargetsPlayer(
      finishPressure.action,
      conversion.bestExecutorReadyTargetID,
    ) &&
    isDecisiveFinishPressureCandidate(finishPressure)
  ) {
    return undefined;
  }
  const currentTargetID = currentWarTargetID(input);
  const currentTargetHasReadyAttack =
    currentTargetID !== null &&
    scored.some(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        candidate.action.risk.level !== "high" &&
        actionTargetsPlayer(candidate.action, currentTargetID) &&
        actionIsFavorableHostileAttack(candidate.action),
    );
  const shouldSwitchToBestConversionTarget =
    conversion.homeDanger === "low" &&
    conversion.neutralExpansionAvailable === true &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) >= 1.45;
  const targetID =
    currentTargetHasReadyAttack && !shouldSwitchToBestConversionTarget
      ? currentTargetID
      : conversion.bestExecutorReadyTargetID;
  const troopRatio =
    input.observation.combat.troopRatio ??
    input.observation.ownState?.troopRatio ??
    1;
  if (
    recentAcceptedMediumAttackCount(input.observation, targetID, 6) >= 2 &&
    troopRatio < 0.58
  ) {
    return undefined;
  }
  if (
    conversion.homeDanger !== "low" &&
    conversion.neutralExpansionAvailable === true
  ) {
    return undefined;
  }
  if (
    conversion.neutralExpansionAvailable &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) < 1.45
  ) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        !actionTargetsPlayer(candidate.action, targetID)
      ) {
        return false;
      }
      if (
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) ||
        hasPolicyPenalty(
          candidate,
          "urgent defense should not trade into a stronger leader",
        ) ||
        hasPolicyPenalty(
          candidate,
          "attack would deplete the reserve below competitive defense",
        ) ||
        hasPolicyPenalty(
          candidate,
          "hard-nation attack wave should rebuild troops",
        )
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      const repeatedProbeStop =
        (affordances.frontierFinishPressure?.repeatedLowCommitmentProbe ===
          true &&
          affordances.frontierFinishPressure.activeTargetID === targetID) ||
        hasPolicyPenalty(
          candidate,
          "repeated low-commitment war probes are stalling conversion",
        );
      if (repeatedProbeStop && commitment < 0.18) {
        return false;
      }
      const repeatedLowProbeCount = recentAcceptedLowCommitmentAttackCount(
        input.observation,
        targetID,
        8,
      );
      if (
        repeatedLowProbeCount >= 3 &&
        (commitment < 0.18 || commitment > 0.32 || relativeTroopRatio < 1.55)
      ) {
        return false;
      }
      const maxCommitment =
        repeatedLowProbeCount >= 3
          ? 0.32
          : relativeTroopRatio >= 1.9
            ? 0.28
            : 0.12;
      return (
        commitment > 0 &&
        commitment <= maxCommitment &&
        relativeTroopRatio >= 1.25
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      const ownTiles = input.observation.ownState?.tilesOwned ?? 0;
      const leaderBlockedSideConversion =
        isLeaderBlockedWeakSideConversion(a) ||
        isLeaderBlockedWeakSideConversion(b);
      const plannerRequestedConversion =
        plan.objective === "pressure_rival" &&
        plan.targetPlayerId === targetID &&
        targetID === conversion.bestExecutorReadyTargetID;
      const desiredCommitment =
        recentAcceptedLowCommitmentAttackCount(
          input.observation,
          targetID,
          8,
        ) >= 3
          ? 0.25
          : leaderBlockedSideConversion && ownTiles >= 20_000
            ? 0.25
            : leaderBlockedSideConversion
              ? 0.1
              : plannerRequestedConversion &&
                  (aRelative >= 1.8 || bRelative >= 1.8)
                ? 0.25
                : (conversion.bestExecutorReadyAttackTroopPercent ?? 10) / 100;
      return (
        Math.abs(aCommitment - desiredCommitment) -
          Math.abs(bCommitment - desiredCommitment) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function reserveSafeFrontierConversionProbeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const affordances = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const conversion = affordances.frontierConversionTiming;
  if (
    conversion?.recommended !== true ||
    !conversion.executorReady ||
    conversion.bestExecutorReadyTargetID === null ||
    conversion.homeDanger === "high" ||
    (conversion.incomingThreatRatio ?? 0) > 0.3
  ) {
    return undefined;
  }
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    0;
  if (
    ownTileShare > 0 &&
    (conversion.bestExecutorReadyTileShare ?? 0) > ownTileShare * 1.18 &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) < 1.8
  ) {
    return undefined;
  }
  if (
    ownTileShare > 0 &&
    (conversion.bestExecutorReadyTileShare ?? 0) > ownTileShare * 1.08 &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) < 1.45
  ) {
    return undefined;
  }
  const targetID = conversion.bestExecutorReadyTargetID;
  if (
    recentAcceptedLowCommitmentAttackCount(input.observation, targetID, 8) >=
      3 ||
    recentAcceptedMediumAttackCount(input.observation, targetID, 6) >= 2
  ) {
    return undefined;
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  return scored
    .filter((candidate) => {
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (input.observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target?.relativeTroopRatio ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target?.tileShare ||
        0;
      const troopCommitment = committedTroopRatio(candidate.action, ownTroops);
      return (
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        candidate.action.risk.level !== "high" &&
        targetID === conversion.bestExecutorReadyTargetID &&
        troopCommitment > 0 &&
        troopCommitment <= 0.12 &&
        relativeTroopRatio >= 1.25 &&
        actionMatchesFrontierConversionReadyAttack({
          action: candidate.action,
          conversion,
          actionPlayerID: targetID,
          troopCommitment,
          relativeTroopRatio,
          targetTileShare,
          ownTileShare,
        }) &&
        frontierConversionTimingAllowsScheduling(candidate)
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        conversion.bestExecutorReadyRelativeTroopRatio ||
        0;
      return (
        Math.abs(aCommitment - 0.1) - Math.abs(bCommitment - 0.1) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function frontierConversionTimingAttackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
  plan?: StrategicPlan,
): FrontierRankedAction | undefined {
  const affordances = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  const conversion = affordances.frontierConversionTiming;
  if (conversion?.recommended !== true || !conversion.executorReady) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      const ownTroops =
        input.observation.combat.ownTroops ??
        input.observation.ownState?.troops ??
        0;
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (input.observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target?.tileShare ||
        0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target?.relativeTroopRatio ||
        0;
      const troopCommitment = committedTroopRatio(candidate.action, ownTroops);
      const repeatedProbeStop =
        (affordances.frontierFinishPressure?.repeatedLowCommitmentProbe ===
          true &&
          affordances.frontierFinishPressure.activeTargetID === targetID) ||
        hasPolicyPenalty(
          candidate,
          "repeated low-commitment war probes are stalling conversion",
        );
      if (repeatedProbeStop && troopCommitment < 0.18) {
        return false;
      }
      return (
        actionMatchesFrontierConversionReadyAttack({
          action: candidate.action,
          conversion,
          actionPlayerID: targetID,
          troopCommitment,
          relativeTroopRatio,
          targetTileShare,
          ownTileShare:
            input.observation.ownState?.tileShare ??
            input.observation.endgame?.ownTileShare ??
            0,
        }) && frontierConversionTimingAllowsScheduling(candidate)
      );
    })
    .sort((a, b) => {
      const ownTroops =
        input.observation.combat.ownTroops ??
        input.observation.ownState?.troops ??
        0;
      const ownTiles = input.observation.ownState?.tilesOwned ?? 0;
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const leaderBlockedSideConversion =
        isLeaderBlockedWeakSideConversion(a) ||
        isLeaderBlockedWeakSideConversion(b);
      const plannerRequestedConversion =
        plan?.objective === "pressure_rival" &&
        plan.targetPlayerId !== null &&
        plan.targetPlayerId === conversion.bestExecutorReadyTargetID;
      const decisiveConversionWindow =
        plannerRequestedConversion &&
        input.observation.memory.recentExpansionCount >= 3 &&
        (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) >= 1.8 &&
        conversion.homeDanger === "low";
      const desiredCommitment = decisiveConversionWindow
        ? 0.25
        : leaderBlockedSideConversion && ownTiles >= 20_000
          ? 0.25
          : leaderBlockedSideConversion
            ? 0.1
            : ownTiles > 0 && ownTiles < 20_000
              ? 0.1
              : 0.18;
      return (
        (leaderBlockedSideConversion
          ? Math.abs(aCommitment - desiredCommitment) -
            Math.abs(bCommitment - desiredCommitment)
          : b.totalScore - a.totalScore) ||
        bRelative - aRelative ||
        Math.abs(aCommitment - desiredCommitment) -
          Math.abs(bCommitment - desiredCommitment) ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function frontierConversionTimingAllowsScheduling(
  candidate: FrontierRankedAction,
): boolean {
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return true;
  }
  const allowedBlockingPolicyPenalty = hasPolicyPenalty(
    candidate,
    "expansion plan should not mix hostile pressure",
  );
  return blockers.every((reason) => {
    if (reason === "blocking policy penalty") {
      return allowedBlockingPolicyPenalty;
    }
    if (
      reason === "hard-nation endgame must pressure leader before side cleanup"
    ) {
      return isLeaderBlockedWeakSideConversion(candidate);
    }
    return [
      "multi-rival opening pressure should use reserve-preserving probes",
      "max concurrent wars already reached",
      "finish current war before opening another front",
      "finish favorable current war before switching fronts",
      "hostile action does not match the active focus target",
    ].includes(reason);
  });
}

function isLeaderBlockedWeakSideConversion(
  candidate: FrontierRankedAction,
): boolean {
  if (
    candidate.action.kind !== "attack" ||
    candidate.action.metadata?.expansion === true ||
    candidate.action.risk.level === "high" ||
    !hasPolicyContribution(
      candidate,
      "frontier conversion ready attack uses calibrated weak-rival window",
    ) ||
    !hasPolicyPenalty(
      candidate,
      "hard-nation endgame must pressure leader before side cleanup",
    )
  ) {
    return false;
  }

  const commitment = directActionCommitment(candidate.action);
  const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
  const relativeTroopRatio = metadataNumber(
    candidate.action,
    "relativeTroopRatio",
  );
  const reserveProbe =
    commitment > 0 &&
    commitment <= 0.12 &&
    targetTileShare > 0 &&
    targetTileShare <= 0.06 &&
    relativeTroopRatio >= 2;
  const tinyFinishStrike =
    commitment > 0.12 &&
    commitment <= 0.25 &&
    targetTileShare > 0 &&
    targetTileShare <= 0.025 &&
    relativeTroopRatio >= 3;
  return (
    (reserveProbe || tinyFinishStrike) &&
    !hasPolicyPenalty(candidate, "active pressure makes new wars unsafe") &&
    !hasPolicyPenalty(
      candidate,
      "urgent defense state makes non-leader attacks too risky",
    ) &&
    !hasPolicyPenalty(
      candidate,
      "recent retreat needs a troop rebuild before counterattack",
    ) &&
    !hasPolicyPenalty(
      candidate,
      "attack would deplete the reserve below competitive defense",
    )
  );
}

function frontierFinishPressureAttackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
  settings?: Pick<AgentSettings, "frontierFinishPressureEnabled">,
): FrontierRankedAction | undefined {
  if (settings?.frontierFinishPressureEnabled === false) {
    return undefined;
  }
  const finishPressure = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  }).frontierFinishPressure;
  if (finishPressure === undefined || finishPressure.bestTargetID === null) {
    return undefined;
  }
  const activeFrontOverride = shouldEscalateActiveFrontFinishPressure(
    input,
    finishPressure,
  );
  if (finishPressure.recommended !== true && !activeFrontOverride) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      const ownTroops =
        input.observation.combat.ownTroops ??
        input.observation.ownState?.troops ??
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return (
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        actionTargetsPlayer(candidate.action, finishPressure.bestTargetID!) &&
        commitment >= 0.18 &&
        (activeFrontOverride ||
          hasPolicyContribution(
            candidate,
            "frontier finish pressure escalates repeated probes",
          )) &&
        frontierFinishPressureAllowsScheduling(candidate, activeFrontOverride)
      );
    })
    .sort((a, b) => {
      const ownTroops =
        input.observation.combat.ownTroops ??
        input.observation.ownState?.troops ??
        0;
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function shouldEscalateActiveFrontFinishPressure(
  input: AgentBrainInput,
  finishPressure: AgentFrontierFinishPressureAffordance,
): boolean {
  if (
    finishPressure.recommended === true ||
    finishPressure.bestTargetID === null ||
    finishPressure.bestAttackID === null ||
    finishPressure.finishingAttackActionCount <= 0 ||
    finishPressure.decisiveAttackActionCount <= 0 ||
    finishPressure.recentTargetAttackCount < 2 ||
    finishPressure.recentLowCommitmentAttackCount < 2 ||
    finishPressure.bestAttackTroopPercent === null ||
    finishPressure.bestAttackTroopPercent < 25 ||
    (finishPressure.bestTargetRelativeTroopRatio ?? 0) < 1.45
  ) {
    return false;
  }
  if (
    input.observation.strategic.priority !== "build_defense" &&
    input.observation.memory.repeatedActionKind !== "attack"
  ) {
    return false;
  }
  return input.legalActions.some(
    (action) =>
      action.id === finishPressure.bestAttackID &&
      action.kind === "attack" &&
      action.metadata?.expansion !== true &&
      action.risk.level !== "high",
  );
}

function frontierFinishPressureAllowsScheduling(
  candidate: FrontierRankedAction,
  activeFrontOverride: boolean,
): boolean {
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return true;
  }
  if (!activeFrontOverride) {
    return false;
  }
  return blockers.every((reason) =>
    [
      "blocking policy penalty",
      "early multi-front hard-nation trades need a decisive edge",
      "multi-rival opening pressure should use reserve-preserving probes",
      "medium and large attacks require a developed troop base",
      "medium attack needs a clear troop edge outside finish mode",
    ].includes(reason),
  );
}

function repeatedPressureProbeEscalationCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const pressureIntent = resolvedPlanTurnIntent(input, plan) === "pressure";
  const survivalIntent =
    plan.objective === "survive" ||
    resolvedPlanTurnIntent(input, plan) === "survive";
  if (
    plan.objective !== "pressure_rival" &&
    !pressureIntent &&
    !survivalIntent
  ) {
    return undefined;
  }
  const targetID =
    recentRepeatedLowCommitmentAttackTargetID(input.observation, 8, 3) ??
    plan.targetPlayerId ??
    recentAcceptedTargetID(input.observation, ["attack"], 8);
  if (targetID === null) {
    return undefined;
  }
  if (
    recentAcceptedLowCommitmentAttackCount(input.observation, targetID, 8) < 3
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        !actionTargetsPlayer(candidate.action, targetID) ||
        (plan.forbiddenActionKinds.includes(candidate.action.kind) &&
          !survivalIntent) ||
        !repeatedProbeEscalationAllowsScheduling(candidate)
      ) {
        return false;
      }
      const ownTroops =
        input.observation.combat.ownTroops ??
        input.observation.ownState?.troops ??
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio = metadataNumber(
        candidate.action,
        "relativeTroopRatio",
      );
      return (
        commitment >= 0.18 &&
        commitment <= 0.42 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 1.35) &&
        candidate.totalScore >= 0
      );
    })
    .sort((a, b) => {
      const ownTroops =
        input.observation.combat.ownTroops ??
        input.observation.ownState?.troops ??
        0;
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        b.totalScore - a.totalScore ||
        bRelative - aRelative ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function repeatedProbeEscalationAllowsScheduling(
  candidate: FrontierRankedAction,
): boolean {
  const blockers = schedulingBlockingReasons(candidate);
  if (blockers.length === 0) {
    return true;
  }
  return blockers.every((reason) =>
    [
      "troop ratio is below attack trigger",
      "attack would deplete the reserve below competitive defense",
      "multi-rival opening pressure should use reserve-preserving probes",
      "medium and large attacks require a developed troop base",
      "medium attack needs a clear troop edge outside finish mode",
      "blocking policy penalty",
    ].includes(reason),
  );
}

function criticalHomeCollapseRecoveryCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const survivalIntent =
    plan.objective === "survive" ||
    resolvedPlanTurnIntent(input, plan) === "survive";
  if (!survivalIntent || observation.strategic.urgency !== "high") {
    return undefined;
  }
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  if (ownTiles <= 0 || ownTiles >= 9_000) {
    return undefined;
  }
  const tactical = buildAgentTacticalAffordances({
    observation,
    legalActions: input.legalActions,
  }).transportTroopBanking;
  const incomingThreatRatio = tactical.incomingThreatRatio ?? 0;
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  const activeTransportTroops = tactical.activeTransportTroops ?? 0;
  const tinyCoreTransportRecall = ownTiles < 1_000 && incomingThreatRatio >= 1;
  const endangeredTinyCoreTransportRecall =
    ownTiles < 3_000 &&
    incomingThreatRatio >= 0.05 &&
    activeTransportTroops >= Math.max(25_000, ownTroops * 0.12);
  if (
    tactical.homeDanger !== "high" &&
    incomingThreatRatio < 0.35 &&
    !endangeredTinyCoreTransportRecall
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (candidate.action.kind === "retreat") {
        return true;
      }
      if (candidate.action.kind !== "boat_retreat") {
        return false;
      }
      if (
        shouldProtectFreshEscapeTransport(input, candidate.action) &&
        !endangeredTinyCoreTransportRecall
      ) {
        return false;
      }
      const returningTroops = metadataNumber(candidate.action, "troops");
      if (tinyCoreTransportRecall || endangeredTinyCoreTransportRecall) {
        return returningTroops >= Math.max(15_000, ownTroops * 0.08);
      }
      return (
        returningTroops >= Math.max(40_000, ownTroops * 0.12) ||
        activeTransportTroops >= Math.max(40_000, ownTroops * 0.12)
      );
    })
    .sort((a, b) => {
      const aPriority = a.action.kind === "retreat" ? 2 : 1;
      const bPriority = b.action.kind === "retreat" ? 2 : 1;
      const aTroops = metadataNumber(a.action, "troops");
      const bTroops = metadataNumber(b.action, "troops");
      return (
        bPriority - aPriority ||
        bTroops - aTroops ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function survivalPanicProbeRecoveryCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const survivalIntent =
    plan.objective === "survive" ||
    resolvedPlanTurnIntent(input, plan) === "survive";
  if (
    !survivalIntent ||
    !plan.forbiddenActionKinds.includes("attack") ||
    (input.observation.strategic.urgency !== "high" &&
      input.observation.combat.incomingAttackPlayerIDs.length === 0)
  ) {
    return undefined;
  }
  const unsafeTinyCounterpressure = scored.some((candidate) => {
    if (
      candidate.action.kind !== "attack" ||
      candidate.action.metadata?.expansion === true
    ) {
      return false;
    }
    const ownTroops =
      input.observation.combat.ownTroops ??
      input.observation.ownState?.troops ??
      0;
    const commitment = committedTroopRatio(candidate.action, ownTroops);
    return (
      commitment > 0 &&
      commitment <= 0.12 &&
      (hasPolicyPenalty(
        candidate,
        "counterpressure probe is too small to stop an invasion",
      ) ||
        hasPolicyPenalty(candidate, "troop ratio is below attack trigger") ||
        hasPolicyPenalty(candidate, "attack lacks a clear troop edge"))
    );
  });
  if (!unsafeTinyCounterpressure) {
    return undefined;
  }
  const cleanMediumCounterattack = scored.some((candidate) => {
    if (
      candidate.action.kind !== "attack" ||
      candidate.action.metadata?.expansion === true ||
      candidate.action.risk.level === "high"
    ) {
      return false;
    }
    const ownTroops =
      input.observation.combat.ownTroops ??
      input.observation.ownState?.troops ??
      0;
    const commitment = committedTroopRatio(candidate.action, ownTroops);
    const relativeTroopRatio = metadataNumber(
      candidate.action,
      "relativeTroopRatio",
    );
    return (
      commitment >= 0.18 &&
      commitment <= 0.32 &&
      relativeTroopRatio >= 1.55 &&
      repeatedProbeEscalationAllowsScheduling(candidate)
    );
  });
  if (cleanMediumCounterattack) {
    return undefined;
  }
  const openingTempo = buildAgentTacticalAffordances({
    observation: input.observation,
    legalActions: input.legalActions,
  }).openingExpansionTempo;
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    openingTempo?.ownTileShare ??
    0;
  const neutralBoatRecoveryReady =
    openingTempo?.recommended === true &&
    openingTempo.homeDanger !== "high" &&
    openingTempo.neutralBoatExpansionActionCount > 0;
  const neutralLandRecoveryReady =
    (openingTempo?.recommended === true || ownTileShare < 0.1) &&
    openingTempo?.homeDanger !== "high" &&
    (openingTempo?.neutralLandExpansionActionCount ?? 0) > 0;
  return scored
    .filter((candidate) => {
      const neutralLandRecoveryCandidate =
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion === true &&
        neutralLandRecoveryReady;
      if (
        (plan.forbiddenActionKinds.includes(candidate.action.kind) &&
          !neutralLandRecoveryCandidate) ||
        (candidate.action.risk.level === "high" &&
          !neutralLandRecoveryCandidate)
      ) {
        return false;
      }
      if (candidate.action.kind === "hold") {
        return true;
      }
      if (
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion === true
      ) {
        return (
          neutralLandRecoveryCandidate &&
          neutralLandRecoveryAllowsPolicy(candidate)
        );
      }
      if (candidate.action.kind === "boat") {
        return (
          neutralBoatRecoveryReady &&
          isNeutralBoatAction(candidate.action) &&
          !hasSchedulingBlockingPolicyPenalty(candidate)
        );
      }
      if (
        candidate.action.kind !== "build" &&
        candidate.action.kind !== "upgrade_structure" &&
        candidate.action.kind !== "retreat" &&
        candidate.action.kind !== "boat_retreat"
      ) {
        return false;
      }
      return !hasSchedulingBlockingPolicyPenalty(candidate);
    })
    .sort(
      (a, b) =>
        repeatedPressureProbeRecoveryPriority(b.action) -
          repeatedPressureProbeRecoveryPriority(a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function repeatedPressureProbeRecoveryCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const pressureIntent = resolvedPlanTurnIntent(input, plan) === "pressure";
  const survivalIntent =
    plan.objective === "survive" ||
    resolvedPlanTurnIntent(input, plan) === "survive";
  if (
    plan.objective !== "pressure_rival" &&
    !pressureIntent &&
    !survivalIntent
  ) {
    return undefined;
  }
  const targetID =
    recentRepeatedLowCommitmentAttackTargetID(input.observation, 8, 3) ??
    plan.targetPlayerId ??
    recentAcceptedTargetID(input.observation, ["attack"], 8);
  if (
    targetID === null ||
    recentAcceptedLowCommitmentAttackCount(input.observation, targetID, 8) < 3
  ) {
    return undefined;
  }
  if (
    !survivalIntent &&
    scored.some(
      (candidate) =>
        candidate.action.kind === "attack" &&
        actionTargetsPlayer(candidate.action, targetID) &&
        hasPolicyContribution(
          candidate,
          "hard-nation side conquest converts weaker frontier before leader race",
        ),
    )
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        plan.forbiddenActionKinds.includes(candidate.action.kind) ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      if (candidate.action.kind === "hold") {
        return true;
      }
      if (
        candidate.action.kind !== "boat" &&
        candidate.action.kind !== "build" &&
        candidate.action.kind !== "upgrade_structure" &&
        candidate.action.kind !== "retreat" &&
        candidate.action.kind !== "boat_retreat"
      ) {
        return false;
      }
      return (
        !hasSchedulingBlockingPolicyPenalty(candidate) &&
        !hasPolicyPenalty(candidate, "existing transports should land") &&
        !hasPolicyPenalty(candidate, "repeated transport launches")
      );
    })
    .sort(
      (a, b) =>
        repeatedPressureProbeRecoveryPriority(b.action) -
          repeatedPressureProbeRecoveryPriority(a.action) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id),
    )[0];
}

function repeatedPressureProbeRecoveryPriority(action: LegalAction): number {
  if (action.kind === "build" || action.kind === "upgrade_structure") {
    return 4;
  }
  if (action.kind === "retreat" || action.kind === "boat_retreat") {
    return 3;
  }
  if (isNeutralLandExpansionAction(action)) {
    return 2;
  }
  if (action.kind === "boat") {
    return 2;
  }
  if (action.kind === "hold") {
    return 1;
  }
  return 0;
}

function neutralLandRecoveryAllowsPolicy(
  candidate: FrontierRankedAction,
): boolean {
  if (!isNeutralLandExpansionAction(candidate.action)) {
    return false;
  }
  if (
    hasPolicyPenalty(
      candidate,
      "neutral expansion is not gaining land from this boxed frontier",
    ) ||
    hasPolicyPenalty(
      candidate,
      "hard-nation land lead must convert rivals instead of farming neutral land",
    )
  ) {
    return false;
  }
  return true;
}

function recentlySentSocialToSameTarget(
  observation: AgentBrainInput["observation"],
  action: LegalAction,
): boolean {
  if (action.kind !== "emoji" && action.kind !== "quick_chat") {
    return false;
  }
  const targetID = actionPlayerID(action);
  if (targetID === null) {
    return false;
  }
  return observation.memory.recentActions.some(
    (recent) =>
      recent.actionKind === action.kind && recent.targetID === targetID,
  );
}

function communicationSignalForAction(
  action: LegalAction,
  observation: AgentObservation,
): AgentCommunicationSignal | null {
  const ownPlayerID = observation.ownState?.playerID ?? null;
  const actionTargetID = metadataString(action, "targetID");
  const actionRecipientID = metadataString(action, "recipientID");
  const actionPlayerID = actionTargetID ?? actionRecipientID;
  if (actionPlayerID === null) {
    return null;
  }
  return (
    [...(observation.recentCommunications ?? [])].reverse().find((signal) => {
      if (
        signal.intent === "coordinate_attack" ||
        signal.intent === "warn_threat"
      ) {
        return (
          signal.targetID !== null &&
          signal.targetID !== undefined &&
          signal.targetID !== ownPlayerID &&
          actionPlayerID === signal.targetID
        );
      }
      if (
        signal.intent === "request_support" ||
        signal.intent === "propose_alliance"
      ) {
        return (
          signal.senderPlayerID !== null &&
          signal.senderPlayerID !== undefined &&
          (actionRecipientID === signal.senderPlayerID ||
            actionTargetID === signal.senderPlayerID)
        );
      }
      return false;
    }) ?? null
  );
}

function isMapProgressOrDiplomacyAction(action: LegalAction): boolean {
  return (
    isDirectConquestAction(action) ||
    isNeutralGrowthAction(action) ||
    action.kind === "build" ||
    action.kind === "upgrade_structure" ||
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "break_alliance" ||
    action.kind === "donate_gold" ||
    action.kind === "donate_troops" ||
    action.kind === "embargo" ||
    action.kind === "embargo_stop" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player"
  );
}

function isProductiveFallbackAction(action: LegalAction): boolean {
  if (action.kind === "attack" && action.metadata?.expansion === true) {
    return true;
  }
  if (isNeutralBoatAction(action)) {
    return true;
  }
  return action.kind === "build" || action.kind === "upgrade_structure";
}

function frontierSchedulerOrderForPlan(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): readonly FrontierSchedulerSlot[] {
  if (
    plan.objective === "pressure_rival" &&
    scored.some(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        !hasSchedulingBlockingPolicyPenalty(candidate),
    )
  ) {
    return [
      "emergency_survival",
      "spawn_opening",
      "combat_attack",
      "combat_pressure",
      "defensive_structure",
      "economic_structure",
      "neutral_expansion",
      "naval",
      "nuclear_endgame",
      "utility_social",
    ];
  }
  if (
    plan.objective === "pressure_rival" &&
    isNavalConversionMode(
      input.observation,
      scored.map((item) => item.action),
    )
  ) {
    const bestNeutralExpansion = scored.find(
      (candidate) =>
        candidate.schedulerSlot === "neutral_expansion" &&
        !hasSchedulingBlockingPolicyPenalty(candidate),
    );
    const bestNavalAction = scored.find(
      (candidate) =>
        candidate.schedulerSlot === "naval" &&
        !hasSchedulingBlockingPolicyPenalty(candidate),
    );
    if (
      bestNeutralExpansion !== undefined &&
      bestNeutralExpansion.totalScore >= 70 &&
      (bestNavalAction === undefined ||
        bestNavalAction.totalScore < bestNeutralExpansion.totalScore - 20)
    ) {
      return [
        "emergency_survival",
        "spawn_opening",
        "neutral_expansion",
        "naval",
        "combat_pressure",
        "defensive_structure",
        "economic_structure",
        "combat_attack",
        "nuclear_endgame",
        "utility_social",
      ];
    }
    return [
      "emergency_survival",
      "spawn_opening",
      "naval",
      "combat_pressure",
      "defensive_structure",
      "economic_structure",
      "neutral_expansion",
      "nuclear_endgame",
      "utility_social",
    ];
  }
  return frontierSchedulerOrder;
}

function isBatchFillerAllowed(
  candidate: FrontierRankedAction,
  selected: readonly FrontierRankedAction[],
  plan: StrategicPlan,
): boolean {
  if (
    plan.objective === "pressure_rival" &&
    isPressureOnlySignalAction(candidate.action) &&
    selected.some((item) => isDirectConquestAction(item.action))
  ) {
    return false;
  }
  if (
    candidate.action.kind === "boat" &&
    selected.length > 0 &&
    candidate.totalScore < 70 &&
    !hasPolicyContribution(
      candidate,
      "hard-nation side transport opens a safer conquest front",
    ) &&
    !hasPolicyContribution(
      candidate,
      "hard-nation flank transport opens side conquest",
    )
  ) {
    return false;
  }
  if (!isSocialFlavorAction(candidate.action)) {
    return true;
  }
  if (plan.objective === "build_alliance") {
    return true;
  }
  return selected.length === 0 && candidate.totalScore >= 70;
}

function hasCompetitiveExpansionDiversifier(
  scored: readonly FrontierRankedAction[],
  plan: StrategicPlan,
): boolean {
  const neutral = scored.find(
    (candidate) =>
      candidate.schedulerSlot === "neutral_expansion" &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
  const diversifier = scored.find(
    (candidate) =>
      isExpansionDiversifierAction(candidate.action) &&
      !plan.forbiddenActionKinds.includes(candidate.action.kind) &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
  if (neutral === undefined || diversifier === undefined) {
    return false;
  }
  return (
    diversifier.totalScore >= 46 &&
    diversifier.totalScore >= neutral.totalScore - 10
  );
}

function bestSpawnCandidate(
  scored: readonly FrontierRankedAction[],
  observation: AgentObservation,
): FrontierRankedAction | undefined {
  const spawns = scored.filter(
    (candidate) => candidate.action.kind === "spawn",
  );
  if (spawns.length === 0) {
    return undefined;
  }
  const preferredBand = spawns.filter((candidate) => {
    const safety = metadataNumber(candidate.action, "safetyScore");
    return safety >= 0.25 && safety <= 0.85;
  });
  const fallbackBand = spawns.filter(
    (candidate) => metadataNumber(candidate.action, "safetyScore") >= 0.18,
  );
  const desperateBand = spawns.filter(
    (candidate) => metadataNumber(candidate.action, "safetyScore") >= 0.12,
  );
  const pool =
    preferredBand.length > 0
      ? preferredBand
      : fallbackBand.length > 0
        ? fallbackBand
        : desperateBand.length > 0
          ? desperateBand
          : spawns;
  const bestQuality = Math.max(
    ...pool.map((candidate) => spawnQuality(candidate.action)),
  );
  const bounds = spawnActionCoordinateBounds(pool);
  const regionalScoutPool = spawnRegionalScoutPool(pool, bounds, bestQuality);
  const scoutingPool = pool.filter(
    (candidate) =>
      spawnQuality(candidate.action) >=
      bestQuality - (bounds === null ? 0.04 : 0.24),
  );
  const selectedPool =
    regionalScoutPool.length >= 4
      ? regionalScoutPool
      : scoutingPool.length > 0
        ? scoutingPool
        : pool;
  return [...selectedPool].sort((a, b) => {
    const selectionDelta =
      spawnSelectionScore(b, observation, bounds) -
      spawnSelectionScore(a, observation, bounds);
    if (Math.abs(selectionDelta) > 0.01) {
      return selectionDelta;
    }
    const qualityDelta = spawnQuality(b.action) - spawnQuality(a.action);
    if (Math.abs(qualityDelta) > 0.01) {
      return qualityDelta;
    }
    const aSafety = metadataNumber(a.action, "safetyScore");
    const bSafety = metadataNumber(b.action, "safetyScore");
    if (aSafety < 0.25 && bSafety < 0.25) {
      const safetyDelta = bSafety - aSafety;
      if (Math.abs(safetyDelta) > 0.02) {
        return safetyDelta;
      }
    }
    return (
      metadataNumber(b.action, "localLandScore") -
        metadataNumber(a.action, "localLandScore") ||
      qualityDelta ||
      b.totalScore - a.totalScore ||
      a.action.id.localeCompare(b.action.id)
    );
  })[0];
}

function spawnSelectionScore(
  candidate: FrontierRankedAction,
  observation: AgentObservation,
  bounds: SpawnActionCoordinateBounds | null,
): number {
  return (
    spawnQuality(candidate.action) * 0.92 +
    humanSpawnRoomScore(candidate.action) * 0.12 +
    spawnProfilePreference(candidate.action, observation.profile) * 0.12 +
    spawnRoverScore(candidate.action, observation, bounds) * 0.34 +
    spawnMultiPointScoutScore(candidate.action, observation, bounds) * 0.06 +
    spawnRegionPreference(candidate.action, observation, bounds) * 0.08 -
    spawnHotStartPenalty(candidate.action) * 0.16
  );
}

function spawnRegionalScoutPool(
  candidates: readonly FrontierRankedAction[],
  bounds: SpawnActionCoordinateBounds | null,
  bestQuality: number,
): FrontierRankedAction[] {
  if (bounds === null || candidates.length <= 10) {
    return [];
  }

  const columns = 6;
  const rows = 5;
  const bestByCell = new Map<string, FrontierRankedAction>();
  for (const candidate of candidates) {
    const cell = spawnCellKey(candidate.action, bounds, columns, rows);
    if (cell === null) {
      continue;
    }
    const current = bestByCell.get(cell);
    if (
      current === undefined ||
      spawnRegionalScoutCandidateScore(candidate) >
        spawnRegionalScoutCandidateScore(current)
    ) {
      bestByCell.set(cell, candidate);
    }
  }

  return [...bestByCell.values()].filter((candidate) =>
    isViableRegionalSpawnScout(candidate.action, bestQuality),
  );
}

function spawnRegionalScoutCandidateScore(
  candidate: FrontierRankedAction,
): number {
  return (
    spawnQuality(candidate.action) +
    humanSpawnRoomScore(candidate.action) * 0.2 -
    spawnHotStartPenalty(candidate.action) * 0.15
  );
}

function isViableRegionalSpawnScout(
  action: LegalAction,
  bestQuality: number,
): boolean {
  const quality = spawnQuality(action);
  const safety = metadataNumber(action, "safetyScore");
  const localLand = metadataNumber(action, "localLandScore");
  if (safety < 0.18 || localLand < 0.5) {
    return false;
  }
  if (quality >= bestQuality - 0.24) {
    return true;
  }
  return safety >= 0.34 && localLand >= 0.88 && quality >= bestQuality - 0.34;
}

function humanSpawnRoomScore(action: LegalAction): number {
  const safety = metadataNumber(action, "safetyScore");
  const localLand = metadataNumber(action, "localLandScore");
  const diplomacy = metadataNumber(action, "diplomacyScore");
  const safetyBand = Math.max(0, 1 - Math.abs(safety - 0.34) / 0.24);
  return (
    localLand * 0.48 + safetyBand * 0.24 + diplomacy * 0.14 + safety * 0.14
  );
}

function spawnHotStartPenalty(action: LegalAction): number {
  const pressure = metadataNumber(action, "pressureScore");
  const safety = metadataNumber(action, "safetyScore");
  const localLand = metadataNumber(action, "localLandScore");
  const pressurePenalty =
    pressure > 0.78 && safety < 0.24 ? (pressure - 0.78) * 2.5 : 0;
  const crampedPenalty = localLand < 0.68 ? (0.68 - localLand) * 1.6 : 0;
  return pressurePenalty + crampedPenalty;
}

type SpawnActionCoordinateBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  diagonal: number;
};

function spawnActionCoordinateBounds(
  candidates: readonly FrontierRankedAction[],
): SpawnActionCoordinateBounds | null {
  const coordinates = candidates
    .map((candidate) => ({
      x: metadataNumber(candidate.action, "x"),
      y: metadataNumber(candidate.action, "y"),
    }))
    .filter(({ x, y }) => x > 0 || y > 0);
  if (coordinates.length === 0) {
    return null;
  }
  // Loop-based min/max (NOT Math.min(...xs)): spreading a large coordinate
  // array overflows the engine argument limit on big spawn pools.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of coordinates) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    diagonal: Math.max(1, Math.hypot(width, height)),
  };
}

function spawnProfilePreference(
  action: LegalAction,
  profile: AgentStrategyProfile,
): number {
  const pressure = metadataNumber(action, "pressureScore");
  const opportunity = metadataNumber(action, "opportunityScore");
  const safety = metadataNumber(action, "safetyScore");
  const diplomacy = metadataNumber(action, "diplomacyScore");
  const localLand = metadataNumber(action, "localLandScore");
  switch (profile) {
    case "aggressive":
      return (
        pressure * 0.38 + opportunity * 0.32 + localLand * 0.2 + safety * 0.1
      );
    case "defensive":
      return safety * 0.52 + localLand * 0.26 + diplomacy * 0.22;
    case "diplomatic":
      return (
        diplomacy * 0.44 + localLand * 0.26 + safety * 0.2 + pressure * 0.1
      );
    case "opportunistic":
      return opportunity * 0.42 + localLand * 0.34 + safety * 0.24;
  }
}

function spawnRoverScore(
  action: LegalAction,
  observation: AgentObservation,
  bounds: SpawnActionCoordinateBounds | null,
): number {
  if (bounds === null) {
    return 0;
  }
  const x = metadataNumber(action, "x");
  const y = metadataNumber(action, "y");
  if (x === 0 && y === 0) {
    return 0;
  }
  const seed = [
    observation.gameID,
    observation.clientID ?? observation.agentID,
    observation.username,
    observation.profile,
  ].join(":");
  const targetX =
    bounds.minX + stableFraction(`spawn:x:${seed}`) * bounds.width;
  const targetY =
    bounds.minY + stableFraction(`spawn:y:${seed}`) * bounds.height;
  const distance = Math.hypot(x - targetX, y - targetY);
  return Math.max(0, 1 - distance / bounds.diagonal);
}

function spawnMultiPointScoutScore(
  action: LegalAction,
  observation: AgentObservation,
  bounds: SpawnActionCoordinateBounds | null,
): number {
  if (bounds === null) {
    return 0;
  }
  const seed = spawnScoutSeed(observation);
  const primary = spawnDistanceScore(action, bounds, `primary:${seed}`);
  let bestWaypoint = 0;
  for (let index = 0; index < 4; index += 1) {
    bestWaypoint = Math.max(
      bestWaypoint,
      spawnDistanceScore(action, bounds, `waypoint:${index}:${seed}`),
    );
  }
  return primary * 0.65 + bestWaypoint * 0.35;
}

function spawnRegionPreference(
  action: LegalAction,
  observation: AgentObservation,
  bounds: SpawnActionCoordinateBounds | null,
): number {
  if (bounds === null) {
    return 0;
  }
  const cell = spawnCellKey(action, bounds, 6, 5);
  if (cell === null) {
    return 0;
  }
  return stableFraction(`spawn:region:${spawnScoutSeed(observation)}:${cell}`);
}

function spawnCellKey(
  action: LegalAction,
  bounds: SpawnActionCoordinateBounds,
  columns: number,
  rows: number,
): string | null {
  const x = metadataNumber(action, "x");
  const y = metadataNumber(action, "y");
  if (x === 0 && y === 0) {
    return null;
  }
  const cellX = Math.max(
    0,
    Math.min(
      columns - 1,
      Math.floor(((x - bounds.minX) / bounds.width) * columns),
    ),
  );
  const cellY = Math.max(
    0,
    Math.min(rows - 1, Math.floor(((y - bounds.minY) / bounds.height) * rows)),
  );
  return `${cellX}:${cellY}`;
}

function spawnDistanceScore(
  action: LegalAction,
  bounds: SpawnActionCoordinateBounds,
  seed: string,
): number {
  const x = metadataNumber(action, "x");
  const y = metadataNumber(action, "y");
  if (x === 0 && y === 0) {
    return 0;
  }
  const targetX =
    bounds.minX + stableFraction(`spawn:x:${seed}`) * bounds.width;
  const targetY =
    bounds.minY + stableFraction(`spawn:y:${seed}`) * bounds.height;
  const distance = Math.hypot(x - targetX, y - targetY);
  return Math.max(0, 1 - distance / bounds.diagonal);
}

function spawnScoutSeed(observation: AgentObservation): string {
  return [
    observation.gameID,
    observation.clientID ?? observation.agentID,
    observation.username,
    observation.profile,
  ].join(":");
}

function stableFraction(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function hardNationTacticalControllerCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  if (
    observation.ownState === null ||
    observation.phase !== "active" ||
    !isHardNationStrategicContext(observation)
  ) {
    return undefined;
  }
  return (
    hardNationControlledIncomingCounterCandidate(input, scored) ??
    hardNationRunawayLeaderControllerCandidate(input, scored) ??
    hardNationFocusedFrontControllerCandidate(input, scored) ??
    hardNationStalemateAllianceBreakCandidate(input, plan, scored)
  );
}

function hardNationControlledIncomingCounterCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const targetID = incomingPressureTargetID(input);
  if (ownState === null || targetID === null) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const target = observation.visiblePlayers.find(
    (player) => player.playerID === targetID,
  );
  if (
    target === undefined ||
    !target.isAlive ||
    ownState.tilesOwned < 30_000 ||
    ownTroops < 300_000
  ) {
    return undefined;
  }
  const targetTileShare = target.tileShare ?? 0;
  const targetIsLeader = targetID === observation.endgame?.leaderID;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (
    !targetIsLeader &&
    observation.endgame?.leaderID !== null &&
    observation.endgame?.leaderID !== ownState.playerID &&
    leaderTileShare >= 0.52 &&
    ownTileShare < 0.5 &&
    targetTileShare <= 0.12
  ) {
    return undefined;
  }
  const majorIncoming =
    targetIsLeader ||
    target.incomingAttack ||
    targetTileShare >= Math.max(0.18, ownTileShare * 0.78) ||
    target.tilesOwned >= ownState.tilesOwned * 0.65;
  if (!majorIncoming) {
    return undefined;
  }
  const recentTargetAttacks = recentAcceptedAttackCount(
    observation,
    targetID,
    4,
  );
  const recentLeaderProbeCount = targetIsLeader
    ? recentAcceptedAttackCount(observation, targetID, 8)
    : 0;
  const targetCandidate = scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, targetID) ||
        candidate.totalScore < 18
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      if (commitment <= 0) {
        return false;
      }
      const relativeTroopRatio = hardNationActionRelativeTroopRatio(
        candidate.action,
        target,
        ownTroops,
      );
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops;
      if (commitment > 0.32) {
        return false;
      }
      if (relativeTroopRatio > 0 && relativeTroopRatio < 1.02) {
        return false;
      }
      if (targetTroops > ownTroops * 1.05 && commitment > 0.12) {
        return false;
      }
      if (
        ownTroops < 550_000 &&
        commitment > 0.12 &&
        relativeTroopRatio < 1.45
      ) {
        return false;
      }
      if (
        ownState.tilesOwned < 24_000 &&
        commitment > 0.12 &&
        relativeTroopRatio < 1.75
      ) {
        return false;
      }
      if (
        ownState.tilesOwned < 32_000 &&
        commitment > 0.12 &&
        targetTileShare >= 0.32 &&
        relativeTroopRatio < 1.6
      ) {
        return false;
      }
      if (
        recentTargetAttacks >= 2 &&
        commitment > 0.12 &&
        relativeTroopRatio < 1.7
      ) {
        return false;
      }
      if (
        targetIsLeader &&
        commitment <= 0.12 &&
        !target.incomingAttack &&
        recentLeaderProbeCount >= 4 &&
        relativeTroopRatio < 1 &&
        ownState.tilesOwned >= 30_000
      ) {
        return false;
      }
      if (
        hasPolicyPenalty(candidate, "attack would deplete the reserve") &&
        commitment > 0.12 &&
        relativeTroopRatio < 1.7
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) =>
      hardNationAttackSort(input, target, a, b, {
        leaderTarget: targetIsLeader,
        incomingCounter: true,
      }),
    )[0];
  return targetCandidate;
}

function hardNationFocusedFrontControllerCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownState.tilesOwned < 30_000 || ownTroops < 650_000) {
    return undefined;
  }
  const recentBreakTargetID = recentAcceptedTargetID(
    observation,
    ["break_alliance"],
    8,
  );
  const leaderID = observation.endgame?.leaderID ?? null;
  const leader =
    leaderID === null
      ? null
      : (observation.visiblePlayers.find(
          (player) => player.playerID === leaderID,
        ) ?? null);
  const leaderTileShare =
    observation.endgame?.leaderTileShare ?? leader?.tileShare ?? 0;
  const matureLeaderRaceTargetID =
    leaderID !== null &&
    leader !== null &&
    leader.isAlive &&
    !leader.isAllied &&
    !leader.isFriendly &&
    ownState.tilesOwned >= 55_000 &&
    ownTroops >= 650_000 &&
    leaderTileShare >= 0.3 &&
    aliveVisibleOpponentCount(observation) <= 3 &&
    input.legalActions.some(
      (action) =>
        actionTargetsPlayer(action, leaderID) && isHostileLandAttack(action),
    )
      ? leaderID
      : null;
  const targetID =
    recentBreakTargetID ??
    matureLeaderRaceTargetID ??
    currentWarTargetID(input) ??
    recentCombatTargetID(input);
  if (
    targetID === null ||
    !input.legalActions.some(
      (action) =>
        actionTargetsPlayer(action, targetID) && isHostileLandAttack(action),
    )
  ) {
    return undefined;
  }
  const target = observation.visiblePlayers.find(
    (player) => player.playerID === targetID,
  );
  if (
    target === undefined ||
    !target.isAlive ||
    target.isAllied ||
    target.isFriendly
  ) {
    return undefined;
  }
  const incomingTargetID = incomingPressureTargetID(input);
  if (
    incomingTargetID !== null &&
    incomingTargetID !== targetID &&
    targetID === recentBreakTargetID
  ) {
    return undefined;
  }
  const targetIsLeader = targetID === observation.endgame?.leaderID;
  const recentTargetAttacks = recentAcceptedAttackCount(
    observation,
    targetID,
    5,
  );
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, targetID) ||
        candidate.totalScore < 18
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      if (commitment <= 0 || commitment > 0.42) {
        return false;
      }
      const relativeTroopRatio = hardNationActionRelativeTroopRatio(
        candidate.action,
        target,
        ownTroops,
      );
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      if (relativeTroopRatio > 0 && relativeTroopRatio < 0.95) {
        return false;
      }
      if (
        targetID === recentBreakTargetID &&
        relativeTroopRatio > 0 &&
        relativeTroopRatio < 1.12
      ) {
        return false;
      }
      if (targetIsLeader) {
        const leaderShare =
          observation.endgame?.leaderTileShare ?? targetTileShare;
        const matureLeaderRace =
          aliveVisibleOpponentCount(observation) <= 3 &&
          ownState.tilesOwned >= 55_000 &&
          ownTroops >= 650_000 &&
          leaderShare >= 0.3;
        if (leaderShare < 0.52 && !target.incomingAttack && !matureLeaderRace) {
          return false;
        }
        if (
          commitment > 0.12 &&
          relativeTroopRatio < (matureLeaderRace ? 1.05 : 1.15)
        ) {
          return false;
        }
        if (commitment > 0.28) {
          return false;
        }
        if (
          commitment <= 0.12 &&
          !target.incomingAttack &&
          recentTargetAttacks >= 4 &&
          relativeTroopRatio < 1 &&
          ownState.tilesOwned >= 30_000
        ) {
          return false;
        }
        return commitment <= 0.28;
      }
      if (
        targetID === recentBreakTargetID &&
        commitment > 0.12 &&
        commitment <= 0.32 &&
        targetTileShare >= 0.04 &&
        targetTileShare <= 0.18 &&
        relativeTroopRatio >= 1.55 &&
        ownTroops >= 800_000
      ) {
        return true;
      }
      if (
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      ) {
        return relativeTroopRatio >= 1.2;
      }
      if (commitment >= 0.35) {
        return (
          relativeTroopRatio >= 1.75 &&
          target.tilesOwned <= ownState.tilesOwned * 0.65 &&
          ownTroops >= 1_200_000
        );
      }
      if (commitment > 0.12 && relativeTroopRatio < 1.08) {
        return false;
      }
      if (recentTargetAttacks >= 3 && commitment > 0.12) {
        return false;
      }
      return true;
    })
    .sort((a, b) =>
      hardNationAttackSort(input, target, a, b, {
        leaderTarget: targetIsLeader,
        focusFollowThrough: true,
      }),
    )[0];
}

function hardNationRunawayLeaderControllerCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    leaderID === ownState.playerID
  ) {
    return undefined;
  }
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    leaderTileShare < 0.5 ||
    ownState.tilesOwned < 30_000 ||
    ownTroops < 800_000 ||
    recentAcceptedTargetID(observation, ["attack"], 1) === leaderID
  ) {
    return undefined;
  }
  const leader = observation.visiblePlayers.find(
    (player) => player.playerID === leaderID,
  );
  if (
    leader === undefined ||
    !leader.isAlive ||
    leader.isAllied ||
    leader.isFriendly
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, leaderID) ||
        candidate.totalScore < 18
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio = hardNationActionRelativeTroopRatio(
        candidate.action,
        leader,
        ownTroops,
      );
      if (commitment <= 0 || commitment > 0.28) {
        return false;
      }
      if (commitment > 0.12) {
        return (
          relativeTroopRatio >= 1.05 &&
          (leaderTileShare >= 0.56 ||
            ownState.tilesOwned >= 38_000 ||
            leader.incomingAttack)
        );
      }
      if (
        !leader.incomingAttack &&
        recentAcceptedAttackCount(observation, leaderID, 8) >= 4 &&
        relativeTroopRatio < 1 &&
        ownState.tilesOwned >= 30_000
      ) {
        return false;
      }
      return relativeTroopRatio >= 0.42 || leaderTileShare >= 0.58;
    })
    .sort((a, b) =>
      hardNationAttackSort(input, leader, a, b, {
        leaderTarget: true,
        runawayLeader: true,
      }),
    )[0];
}

function hardNationActionRelativeTroopRatio(
  action: LegalAction,
  target: AgentBrainInput["observation"]["visiblePlayers"][number],
  ownTroops: number,
): number {
  return (
    metadataNumber(action, "relativeTroopRatio") ||
    target.relativeTroopRatio ||
    (target.troops > 0 ? ownTroops / target.troops : 0)
  );
}

function hardNationDesiredAttackCommitment(input: {
  ownTiles: number;
  ownTroops: number;
  targetTiles: number;
  targetTileShare: number;
  relativeTroopRatio: number;
  leaderTarget: boolean;
  incomingCounter?: boolean;
  runawayLeader?: boolean;
}): number {
  if (input.leaderTarget) {
    if (
      input.incomingCounter === true &&
      input.ownTiles < 30_000 &&
      input.relativeTroopRatio < 1.8
    ) {
      return 0.1;
    }
    if (input.runawayLeader === true) {
      const leaderIsEscaping =
        input.targetTileShare >= 0.56 ||
        (input.ownTiles > 0 && input.targetTiles >= input.ownTiles * 1.2);
      return input.relativeTroopRatio >= 1.05 &&
        input.ownTroops >= 850_000 &&
        leaderIsEscaping
        ? 0.25
        : 0.1;
    }
    return input.relativeTroopRatio >= 1.15 ? 0.25 : 0.1;
  }
  if (
    input.targetTiles > 0 &&
    input.targetTiles <= input.ownTiles * 0.32 &&
    input.relativeTroopRatio >= 1.75 &&
    input.ownTroops >= 1_000_000
  ) {
    return 0.4;
  }
  if (
    input.incomingCounter !== true &&
    input.ownTiles < 30_000 &&
    input.targetTileShare >= 0.18
  ) {
    return 0.1;
  }
  if (
    input.relativeTroopRatio >= (input.incomingCounter ? 1.6 : 1.15) &&
    (input.ownTroops >= 650_000 ||
      (input.incomingCounter === true && input.relativeTroopRatio >= 1.45))
  ) {
    return 0.25;
  }
  return 0.1;
}

function hardNationAttackSort(
  input: AgentBrainInput,
  target: AgentBrainInput["observation"]["visiblePlayers"][number],
  a: FrontierRankedAction,
  b: FrontierRankedAction,
  options: {
    leaderTarget: boolean;
    incomingCounter?: boolean;
    focusFollowThrough?: boolean;
    runawayLeader?: boolean;
  },
): number {
  const ownState = input.observation.ownState;
  const ownTiles = ownState?.tilesOwned ?? 0;
  const ownTroops = input.observation.combat.ownTroops ?? ownState?.troops ?? 0;
  const aRelative = hardNationActionRelativeTroopRatio(
    a.action,
    target,
    ownTroops,
  );
  const bRelative = hardNationActionRelativeTroopRatio(
    b.action,
    target,
    ownTroops,
  );
  const targetTileShare =
    target.tileShare ||
    Math.max(
      metadataNumber(a.action, "targetTileShare"),
      metadataNumber(b.action, "targetTileShare"),
    );
  const targetTiles =
    target.tilesOwned ||
    Math.max(
      metadataNumber(a.action, "targetTiles"),
      metadataNumber(b.action, "targetTiles"),
    );
  const aCommitment = committedTroopRatio(a.action, ownTroops);
  const bCommitment = committedTroopRatio(b.action, ownTroops);
  const aDesired = hardNationDesiredAttackCommitment({
    ownTiles,
    ownTroops,
    targetTiles,
    targetTileShare,
    relativeTroopRatio: aRelative,
    leaderTarget: options.leaderTarget,
    incomingCounter: options.incomingCounter,
    runawayLeader: options.runawayLeader,
  });
  const bDesired = hardNationDesiredAttackCommitment({
    ownTiles,
    ownTroops,
    targetTiles,
    targetTileShare,
    relativeTroopRatio: bRelative,
    leaderTarget: options.leaderTarget,
    incomingCounter: options.incomingCounter,
    runawayLeader: options.runawayLeader,
  });
  return (
    Math.abs(aCommitment - aDesired) - Math.abs(bCommitment - bDesired) ||
    bRelative - aRelative ||
    b.totalScore - a.totalScore ||
    a.action.id.localeCompare(b.action.id)
  );
}

function recentAcceptedAttackCount(
  observation: AgentBrainInput["observation"],
  targetID: string,
  maxLookback: number,
): number {
  const recentActions = observation.memory.recentActions;
  const firstIndex = Math.max(0, recentActions.length - maxLookback);
  let count = 0;
  for (let index = recentActions.length - 1; index >= firstIndex; index -= 1) {
    const decision = recentActions[index];
    if (
      decision?.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      decision.targetID === targetID
    ) {
      count += 1;
    }
  }
  return count;
}

function recentAcceptedLowCommitmentAttackCount(
  observation: AgentBrainInput["observation"],
  targetID: string,
  maxLookback: number,
): number {
  const recentActions = observation.memory.recentActions;
  const firstIndex = Math.max(0, recentActions.length - maxLookback);
  let count = 0;
  for (let index = recentActions.length - 1; index >= firstIndex; index -= 1) {
    const decision = recentActions[index];
    const decisionTargetID =
      typeof decision?.targetID === "string"
        ? decision.targetID
        : targetIDFromActionID(decision?.actionID);
    const commitment = troopRatioFromActionID(decision?.actionID);
    if (
      decision?.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      decisionTargetID === targetID &&
      commitment > 0 &&
      commitment <= 0.12
    ) {
      count += 1;
    }
  }
  return count;
}

function recentRepeatedLowCommitmentAttackTargetID(
  observation: AgentBrainInput["observation"],
  maxLookback: number,
  minimumCount: number,
): string | null {
  const recentActions = observation.memory.recentActions;
  const firstIndex = Math.max(0, recentActions.length - maxLookback);
  const counts = new Map<string, number>();
  for (let index = recentActions.length - 1; index >= firstIndex; index -= 1) {
    const decision = recentActions[index];
    const targetID =
      typeof decision?.targetID === "string"
        ? decision.targetID
        : targetIDFromActionID(decision?.actionID);
    const commitment = troopRatioFromActionID(decision?.actionID);
    if (
      decision?.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      typeof targetID === "string" &&
      commitment > 0 &&
      commitment <= 0.12
    ) {
      const nextCount = (counts.get(targetID) ?? 0) + 1;
      if (nextCount >= minimumCount) {
        return targetID;
      }
      counts.set(targetID, nextCount);
    }
  }
  return null;
}

function recentAcceptedMediumAttackCount(
  observation: AgentBrainInput["observation"],
  targetID: string,
  maxLookback: number,
): number {
  const recentActions = observation.memory.recentActions;
  const firstIndex = Math.max(0, recentActions.length - maxLookback);
  let count = 0;
  for (let index = recentActions.length - 1; index >= firstIndex; index -= 1) {
    const decision = recentActions[index];
    const decisionTargetID =
      typeof decision?.targetID === "string"
        ? decision.targetID
        : targetIDFromActionID(decision?.actionID);
    if (
      decision?.accepted === true &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      decisionTargetID === targetID &&
      troopPercentFromActionID(decision.actionID) >= 25
    ) {
      count += 1;
    }
  }
  return count;
}

function hardNationOpeningForceExpansionCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    !isHardNationScrum(observation) ||
    ownState.tilesOwned >= 1_000 ||
    observation.memory.recentExpansionCount !== 0 ||
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.combat.incomingAttacks?.length ?? 0) > 0 ||
    !observation.memory.recentActions.some(
      (decision) =>
        decision.actionKind === "spawn" &&
        (decision.spawnPressureScore ?? 0) >= 0.8 &&
        (decision.spawnPressureScore ?? 0) < 0.84 &&
        (decision.spawnLocalLandScore ?? 1) <= 0.85,
    )
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion !== true ||
        candidate.totalScore < 50
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return commitment >= 0.45 && commitment <= 0.55;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      return (
        Math.abs(aCommitment - 0.5) - Math.abs(bCommitment - 0.5) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationOpeningBroadTargetProbeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const recentHostileAttack = observation.memory.recentActions.some(
    (decision) =>
      decision.accepted &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      typeof decision.targetID === "string",
  );
  if (
    ownTiles < 7_500 ||
    ownTiles > 10_000 ||
    ownTroops < 500_000 ||
    recentHostileAttack ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        target === null ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      return (
        commitment > 0 &&
        commitment <= 0.12 &&
        targetTileShare >= 0.18 &&
        targetTileShare <= 0.28 &&
        targetTroops <= ownTroops * 0.45 &&
        relativeTroopRatio >= 2.5
      );
    })
    .sort((a, b) => {
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aShare = metadataNumber(a.action, "targetTileShare");
      const bShare = metadataNumber(b.action, "targetTileShare");
      return (
        bRelative - aRelative ||
        bShare - aShare ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationOpeningReserveDisciplineCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const tick = observation.tick ?? observation.turnNumber;
  if (
    ownTiles < 14_000 ||
    ownTiles > 21_000 ||
    ownTroops < 350_000 ||
    ownTroops > 700_000 ||
    tick > 1_700 ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }

  const attacks = scored.filter(
    (candidate) =>
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true &&
      candidate.action.risk.level !== "high",
  );
  const sideTradeAttacks = attacks.filter((candidate) => {
    const targetID = actionPlayerID(candidate.action);
    const target =
      targetID === null
        ? null
        : (observation.visiblePlayers.find(
            (player) => player.playerID === targetID,
          ) ?? null);
    if (target === null || target.isAllied || target.isFriendly) {
      return false;
    }
    const relation = metadataNumber(candidate.action, "relation");
    const targetTileShare =
      metadataNumber(candidate.action, "targetTileShare") ||
      target.tileShare ||
      0;
    const relativeTroopRatio =
      metadataNumber(candidate.action, "relativeTroopRatio") ||
      target.relativeTroopRatio ||
      0;
    return (
      relation >= 2 &&
      targetTileShare >= 0.08 &&
      targetTileShare <= 0.13 &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1.45 &&
      candidate.action.metadata?.incomingAttack !== true
    );
  });
  const lowEdgeProbe = sideTradeAttacks.find((candidate) => {
    const commitment = committedTroopRatio(candidate.action, ownTroops);
    const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
    const relativeTroopRatio = metadataNumber(
      candidate.action,
      "relativeTroopRatio",
    );
    return (
      commitment > 0 &&
      commitment <= 0.12 &&
      targetTileShare > 0 &&
      targetTileShare <= 0.12 &&
      relativeTroopRatio < 1.3 &&
      candidate.totalScore >= 45 &&
      candidate.action.metadata?.outgoingAttack !== true
    );
  });
  if (lowEdgeProbe !== undefined) {
    return scored.find((candidate) => candidate.action.kind === "hold");
  }

  const overcommit = sideTradeAttacks
    .filter((candidate) => {
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return (
        ownTiles >= 17_000 &&
        commitment >= 0.24 &&
        commitment <= 0.42 &&
        candidate.totalScore >= 40
      );
    })
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
    )[0];
  if (overcommit === undefined) {
    return undefined;
  }
  const targetID = actionPlayerID(overcommit.action);
  if (targetID === null) {
    return undefined;
  }
  return attacks
    .filter((candidate) => {
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return (
        actionTargetsPlayer(candidate.action, targetID) &&
        commitment > 0 &&
        commitment <= 0.12 &&
        candidate.totalScore >= 0
      );
    })
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
    )[0];
}

function hardNationWeakSideConquestCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || hardNationOpponentCount(observation) < 1) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const leaderID = observation.endgame?.leaderID ?? null;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (
    leaderID !== null &&
    leaderID !== ownState.playerID &&
    (leaderTileShare >= 0.58 ||
      (leaderTileShare >= 0.55 && livingRivalCount(observation) <= 2)) &&
    ownTileShare < 0.5
  ) {
    return undefined;
  }
  if (ownTiles < 20_000 || ownTroops < 450_000 || ownTileShare < 0.1) {
    return undefined;
  }
  const committedWarTargetID =
    currentWarTargetID(input) ?? recentCombatTargetID(input);
  const candidates = scored
    .filter(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        candidate.totalScore >= 80 &&
        !hasPolicyPenalty(
          candidate,
          "boxed hard-nation opening must not feed rival before breakout",
        ) &&
        !hasPolicyPenalty(
          candidate,
          "early multi-front hard-nation trades need a decisive edge",
        ) &&
        !hasPolicyPenalty(
          candidate,
          "hard-nation endgame must pressure leader before side cleanup",
        ),
    )
    .map((candidate) => {
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === leaderID ||
        targetID === ownState.playerID ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return null;
      }
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const compactTileOK =
        targetTiles > 0
          ? targetTiles <= ownTiles * 0.82
          : targetTileShare > 0 &&
            targetTileShare <= Math.min(0.2, ownTileShare * 0.78);
      const isSmallSwitchTarget =
        targetTiles > 0 &&
        targetTiles <= ownTiles * 0.45 &&
        target.troops <= ownTroops * 0.5 &&
        (targetTileShare === 0 ||
          targetTileShare <= Math.min(0.1, ownTileShare * 0.55));
      if (
        leaderID !== null &&
        leaderID !== ownState.playerID &&
        leaderTileShare >= 0.54 &&
        ownTiles < 40_000 &&
        targetTileShare > 0 &&
        targetTileShare <= 0.06
      ) {
        return null;
      }
      if (
        !compactTileOK ||
        target.troops > ownTroops * 0.78 ||
        (relativeTroopRatio > 0 && relativeTroopRatio < 1.15) ||
        (committedWarTargetID !== null &&
          targetID !== committedWarTargetID &&
          !isSmallSwitchTarget)
      ) {
        return null;
      }
      return { candidate, targetTiles, targetTileShare, relativeTroopRatio };
    })
    .filter(
      (
        entry,
      ): entry is {
        candidate: FrontierRankedAction;
        targetTiles: number;
        targetTileShare: number;
        relativeTroopRatio: number;
      } => entry !== null,
    )
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.candidate.action, ownTroops);
      const bCommitment = committedTroopRatio(b.candidate.action, ownTroops);
      const desiredCommitment =
        ownTiles >= 28_000 &&
        ownTroops >= 600_000 &&
        Math.max(a.relativeTroopRatio, b.relativeTroopRatio) >= 1.35
          ? 0.25
          : 0.1;
      return (
        Math.abs(aCommitment - desiredCommitment) -
          Math.abs(bCommitment - desiredCommitment) ||
        b.candidate.totalScore - a.candidate.totalScore ||
        b.targetTiles - a.targetTiles ||
        b.targetTileShare - a.targetTileShare ||
        a.candidate.action.id.localeCompare(b.candidate.action.id)
      );
    });
  return candidates[0]?.candidate;
}

function hardNationStaleLeaderProbeSideConversionCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    leaderID === ownState.playerID ||
    !isHardNationStrategicContext(observation)
  ) {
    return undefined;
  }
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 40_000 ||
    ownTroops < 650_000 ||
    leaderTileShare < 0.5 ||
    leaderTileShare > 0.6 ||
    recentAcceptedAttackCount(observation, leaderID, 12) < 6
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 45
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === leaderID ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      return (
        commitment >= 0.18 &&
        commitment <= 0.32 &&
        targetTiles <= ownState.tilesOwned * 0.45 &&
        targetTileShare <= 0.08 &&
        target.troops <= ownTroops * 0.72 &&
        relativeTroopRatio >= 1.35 &&
        !hasPolicyPenalty(
          candidate,
          "hard-nation endgame must pressure leader before side cleanup",
        )
      );
    })
    .sort((a, b) => {
      const aTargetID = actionPlayerID(a.action);
      const bTargetID = actionPlayerID(b.action);
      const aTarget =
        aTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aTargetID,
            ) ?? null);
      const bTarget =
        bTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bTargetID,
            ) ?? null);
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aTiles =
        metadataNumber(a.action, "targetTiles") || aTarget?.tilesOwned || 0;
      const bTiles =
        metadataNumber(b.action, "targetTiles") || bTarget?.tilesOwned || 0;
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bTiles - aTiles ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationLateAllianceAvoidanceCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    !isHardNationScrum(observation) ||
    plan.objective === "build_alliance"
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 50_000 ||
    ownTroops < 350_000 ||
    observation.strategic.priority !== "build_defense" ||
    observation.strategic.urgency !== "high"
  ) {
    return undefined;
  }
  const badLateAlliance = scored.some(
    (candidate) =>
      candidate.action.kind === "alliance_request" &&
      hasPolicyPenalty(
        candidate,
        "hard-nation survival should not protect a conquest target in the land race",
      ),
  );
  if (!badLateAlliance) {
    return undefined;
  }
  const preferredKinds: readonly LegalActionKind[] = [
    "retreat",
    "boat_retreat",
    "target_player",
    "embargo_all",
    "boat",
    "hold",
  ];
  return scored
    .filter((candidate) => {
      if (!preferredKinds.includes(candidate.action.kind)) {
        return false;
      }
      if (isPlayerBoatAction(candidate.action)) {
        return false;
      }
      if (
        (candidate.action.kind === "retreat" ||
          candidate.action.kind === "boat_retreat") &&
        candidate.totalScore < 70
      ) {
        return false;
      }
      if (candidate.action.kind === "hold" && candidate.totalScore < 30) {
        return false;
      }
      return candidate.totalScore >= 0;
    })
    .sort((a, b) => {
      const aKind = preferredKinds.indexOf(a.action.kind);
      const bKind = preferredKinds.indexOf(b.action.kind);
      return (
        aKind - bKind ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationStalledFrontConversionCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownTiles < 16_000 ||
    ownTroops < 550_000 ||
    (observation.endgame?.leaderTileShare ?? 0) >= 0.55
  ) {
    return undefined;
  }
  const committedWarTargetID = currentWarTargetID(input);
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 50 ||
        hasPolicyPenalty(
          candidate,
          "boxed hard-nation opening must not feed rival before breakout",
        ) ||
        hasPolicyPenalty(
          candidate,
          "early multi-front hard-nation trades need a decisive edge",
        ) ||
        hasPolicyPenalty(
          candidate,
          "recent retreat needs a troop rebuild before counterattack",
        )
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === leaderID ||
        targetID === ownState.playerID ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const recentTargetAttacks = observation.memory.recentActions.filter(
        (decision) =>
          decision.accepted &&
          decision.actionKind === "attack" &&
          decision.expansion !== true &&
          decision.targetID === targetID,
      ).length;
      if (
        recentTargetAttacks < 3 ||
        (committedWarTargetID !== null && targetID !== committedWarTargetID)
      ) {
        return false;
      }
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return (
        commitment >= 0.18 &&
        commitment <= 0.32 &&
        (targetTileShare === 0 ||
          targetTileShare <=
            Math.min(0.2, Math.max(0.12, ownTileShare * 0.82))) &&
        targetTroops <= ownTroops * 0.72 &&
        relativeTroopRatio >= 1.45 &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) &&
        !hasPolicyPenalty(candidate, "attack lacks a clear troop edge")
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationTinyRivalFinishCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const leaderID = observation.endgame?.leaderID ?? null;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (
    leaderID !== null &&
    leaderID !== ownState.playerID &&
    leaderTileShare >= 0.52 &&
    ownTileShare < 0.5
  ) {
    return undefined;
  }
  if (ownTiles < 16_000 || ownTroops < 420_000) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 45 ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === ownState.playerID ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const recentTargetAttacks = observation.memory.recentActions.filter(
        (decision) =>
          decision.accepted &&
          decision.actionKind === "attack" &&
          decision.expansion !== true &&
          decision.targetID === targetID,
      ).length;
      return (
        targetTileShare > 0 &&
        targetTileShare <= 0.07 &&
        recentTargetAttacks >= 2 &&
        ((relativeTroopRatio > 0 && relativeTroopRatio >= 1.45) ||
          targetTroops <= ownTroops * 0.7) &&
        commitment >= 0.18 &&
        commitment <= 0.42 &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTarget = aRelative >= 2.2 ? 0.4 : 0.25;
      const bTarget = bRelative >= 2.2 ? 0.4 : 0.25;
      return (
        Math.abs(aCommitment - aTarget) - Math.abs(bCommitment - bTarget) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationLargeRivalFeedAvoidanceCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const tick = observation.tick ?? observation.turnNumber;
  if (
    ownTiles < 18_000 ||
    ownTiles > 26_000 ||
    ownTroops < 350_000 ||
    ownTroops > 750_000 ||
    tick > 3_600 ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  const hostileAttacks = scored.filter(
    (candidate) =>
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true,
  );
  const activeTargetID =
    currentWarTargetID(input) ?? recentCombatTargetID(input);
  const activeSmallFront = hostileAttacks.some((candidate) => {
    if (
      activeTargetID === null ||
      !actionTargetsPlayer(candidate.action, activeTargetID)
    ) {
      return false;
    }
    const commitment = committedTroopRatio(candidate.action, ownTroops);
    const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
    const relativeTroopRatio = metadataNumber(
      candidate.action,
      "relativeTroopRatio",
    );
    const recentTargetAttacks = observation.memory.recentActions.filter(
      (decision) =>
        decision.accepted &&
        decision.actionKind === "attack" &&
        decision.expansion !== true &&
        decision.targetID === activeTargetID,
    ).length;
    return (
      commitment > 0 &&
      commitment <= 0.12 &&
      targetTileShare > 0 &&
      targetTileShare <= 0.13 &&
      relativeTroopRatio >= 0.75 &&
      (candidate.action.metadata?.outgoingAttack === true ||
        recentTargetAttacks >= 3)
    );
  });
  if (activeSmallFront) {
    return undefined;
  }
  const safeAttack = hostileAttacks.some((candidate) => {
    if (candidate.action.risk.level === "high") {
      return false;
    }
    const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
    const relativeTroopRatio = metadataNumber(
      candidate.action,
      "relativeTroopRatio",
    );
    const targetTroops = metadataNumber(candidate.action, "targetTroops");
    return (
      (targetTileShare > 0 && targetTileShare < 0.16) ||
      relativeTroopRatio >= 1.25 ||
      (targetTroops > 0 && targetTroops <= ownTroops * 0.82)
    );
  });
  if (safeAttack || hostileAttacks.length === 0) {
    return undefined;
  }
  const feedAttack = hostileAttacks.find((candidate) => {
    const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
    const relativeTroopRatio = metadataNumber(
      candidate.action,
      "relativeTroopRatio",
    );
    return (
      targetTileShare >= 0.16 &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1.2 &&
      (hasPolicyPenalty(
        candidate,
        "attacking a stronger rival feeds them troops",
      ) ||
        hasPolicyPenalty(candidate, "attack lacks a clear troop edge") ||
        hasPolicyPenalty(candidate, "troop ratio is below attack trigger") ||
        hasPolicyPenalty(
          candidate,
          "hard-nation underdog should not feed stronger rival probes",
        ))
    );
  });
  if (feedAttack === undefined) {
    return undefined;
  }
  const strongInfrastructure = scored.find(
    (candidate) =>
      (candidate.action.kind === "build" ||
        candidate.action.kind === "upgrade_structure") &&
      candidate.action.risk.level !== "high" &&
      candidate.totalScore >= 80,
  );
  if (strongInfrastructure !== undefined) {
    return undefined;
  }
  return scored.find((candidate) => candidate.action.kind === "hold");
}

function hardNationEarlyRetreatRecoveryCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownTiles < 7_000 ||
    ownTiles > 18_500 ||
    ownTroops < 250_000 ||
    ownTroops > 760_000 ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  const recentRetreatTargetID =
    observation.memory.recentActions
      .slice(-5)
      .reverse()
      .find(
        (decision) =>
          decision.accepted &&
          (decision.actionKind === "retreat" ||
            decision.actionKind === "boat_retreat") &&
          typeof decision.targetID === "string",
      )?.targetID ?? null;
  if (recentRetreatTargetID === null) {
    return undefined;
  }
  const target =
    observation.visiblePlayers.find(
      (player) => player.playerID === recentRetreatTargetID,
    ) ?? null;
  if (
    target === null ||
    target.isAllied ||
    target.isFriendly ||
    !(target.canAttack || target.sharesBorder)
  ) {
    return undefined;
  }
  const sameFrontAttack = scored
    .filter(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true &&
        actionTargetsPlayer(candidate.action, recentRetreatTargetID),
    )
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
    )[0];
  if (sameFrontAttack === undefined) {
    return undefined;
  }
  const relativeTroopRatio =
    metadataNumber(sameFrontAttack.action, "relativeTroopRatio") ||
    target.relativeTroopRatio ||
    0;
  const commitment = committedTroopRatio(sameFrontAttack.action, ownTroops);
  const incomingFromTarget =
    observation.combat.incomingAttackPlayerIDs.includes(
      recentRetreatTargetID,
    ) || sameFrontAttack.action.metadata?.incomingAttack === true;
  const decisiveCounter =
    incomingFromTarget &&
    commitment > 0 &&
    commitment <= 0.28 &&
    relativeTroopRatio >= 2.4 &&
    !hasPolicyPenalty(sameFrontAttack, "recent retreat needs a troop rebuild");
  if (decisiveCounter) {
    return undefined;
  }
  const stabilizer = scored.find(
    (candidate) =>
      (candidate.action.kind === "build" ||
        candidate.action.kind === "upgrade_structure") &&
      candidate.action.risk.level !== "high" &&
      candidate.totalScore >= 45,
  );
  if (stabilizer !== undefined) {
    return stabilizer;
  }
  return scored.find((candidate) => candidate.action.kind === "hold");
}

function hardNationFrontRecoveryCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    observation.phase !== "active" ||
    !isHardNationStrategicContext(observation) ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const troopRatio = ownState.troopRatio ?? observation.combat.troopRatio ?? 1;
  if (ownTiles < 24_000 || ownTiles > 48_000 || ownTroops < 500_000) {
    return undefined;
  }

  const recentRetreatTargetID = recentAcceptedTargetID(
    observation,
    ["retreat"],
    7,
  );
  const recentRetreatRecovery =
    recentRetreatTargetID !== null &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high";
  const focusTargetID =
    recentRetreatTargetID ??
    currentWarTargetID(input) ??
    recentCombatTargetID(input);
  const recentMediumAttackWave =
    focusTargetID !== null &&
    ownTiles >= 30_000 &&
    recentAcceptedMediumAttackCount(observation, focusTargetID, 6) >= 2 &&
    (observation.memory.repeatedActionKind === "attack" ||
      troopRatio < 0.62 ||
      recentOwnTileLossRatio(observation, ownTiles) >= 0.02);
  const repeatedIncomingProbeRecovery =
    focusTargetID !== null &&
    ownTiles >= 20_000 &&
    ownTiles <= 42_000 &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    recentAcceptedLowCommitmentAttackCount(observation, focusTargetID, 6) >= 2;
  if (!recentRetreatRecovery && !recentMediumAttackWave) {
    if (!repeatedIncomingProbeRecovery) {
      return undefined;
    }
  }
  if (hasDecisiveRecoveryAttack(input, scored, focusTargetID)) {
    return undefined;
  }

  const stabilizer = scored
    .filter(
      (candidate) =>
        (candidate.action.kind === "build" ||
          candidate.action.kind === "upgrade_structure") &&
        candidate.action.risk.level !== "high" &&
        (isDefensiveAction(candidate.action) ||
          isEconomicUnit(metadataString(candidate.action, "unit"))),
    )
    .sort((a, b) => {
      const aDefensive = isDefensiveAction(a.action) ? 1 : 0;
      const bDefensive = isDefensiveAction(b.action) ? 1 : 0;
      return (
        bDefensive - aDefensive ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
  if (stabilizer !== undefined) {
    return stabilizer;
  }

  return scored.find((candidate) => candidate.action.kind === "hold");
}

function hasDecisiveRecoveryAttack(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
  focusTargetID: string | null,
): boolean {
  const observation = input.observation;
  const ownTroops =
    observation.combat.ownTroops ?? observation.ownState?.troops ?? 0;
  return scored.some((candidate) => {
    if (
      candidate.action.kind !== "attack" ||
      candidate.action.metadata?.expansion === true ||
      candidate.action.risk.level === "high" ||
      (focusTargetID !== null &&
        !actionTargetsPlayer(candidate.action, focusTargetID))
    ) {
      return false;
    }
    const targetID = actionPlayerID(candidate.action);
    const target =
      targetID === null
        ? null
        : (observation.visiblePlayers.find(
            (player) => player.playerID === targetID,
          ) ?? null);
    if (
      targetID === null ||
      target === null ||
      target.isAllied ||
      target.isFriendly
    ) {
      return false;
    }
    const commitment = committedTroopRatio(candidate.action, ownTroops);
    const relativeTroopRatio =
      metadataNumber(candidate.action, "relativeTroopRatio") ||
      target.relativeTroopRatio ||
      0;
    const targetTileShare =
      metadataNumber(candidate.action, "targetTileShare") ||
      target.tileShare ||
      0;
    const targetTroops =
      metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
    return (
      commitment >= 0.18 &&
      commitment <= 0.32 &&
      relativeTroopRatio >= 3.2 &&
      (targetTileShare === 0 || targetTileShare <= 0.16) &&
      targetTroops <= ownTroops * 0.35 &&
      !hasPolicyPenalty(
        candidate,
        "attacking a stronger rival feeds them troops",
      )
    );
  });
}

function _hardNationTinyFrontFocusCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const leaderID = observation.endgame?.leaderID ?? null;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (
    ownTiles < 6_000 ||
    ownTiles > 18_500 ||
    ownTroops < 240_000 ||
    ownTroops > 620_000 ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  if (
    leaderID !== null &&
    leaderID !== ownState.playerID &&
    leaderTileShare >= 0.52 &&
    ownTileShare < 0.5
  ) {
    return undefined;
  }
  const focusTargetID =
    currentWarTargetID(input) ?? recentCombatTargetID(input);
  if (focusTargetID === null || focusTargetID === leaderID) {
    return undefined;
  }
  const target =
    observation.visiblePlayers.find(
      (player) => player.playerID === focusTargetID,
    ) ?? null;
  if (
    target === null ||
    target.isAllied ||
    target.isFriendly ||
    !(target.canAttack || target.sharesBorder)
  ) {
    return undefined;
  }
  const recentTargetAttacks = observation.memory.recentActions.filter(
    (decision) =>
      decision.accepted &&
      decision.actionKind === "attack" &&
      decision.expansion !== true &&
      decision.targetID === focusTargetID,
  ).length;
  if (
    recentTargetAttacks < 2 &&
    !target.outgoingAttack &&
    !target.incomingAttack
  ) {
    return undefined;
  }
  const previous = newestAcceptedDecision(observation);
  const previousTargetID =
    typeof previous?.targetID === "string"
      ? previous.targetID
      : (targetIDFromActionID(previous?.actionID) ??
        targetIDFromName(observation, previous?.targetName));
  if (
    previous?.actionKind === "attack" &&
    previous.expansion !== true &&
    previousTargetID === focusTargetID &&
    troopRatioFromActionID(previous.actionID) >= 0.25 &&
    !target.incomingAttack
  ) {
    return undefined;
  }

  const targetCommitment = (candidate: FrontierRankedAction): number => {
    const targetTileShare =
      metadataNumber(candidate.action, "targetTileShare") ||
      target.tileShare ||
      0;
    const targetTroops =
      metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
    const relativeTroopRatio =
      metadataNumber(candidate.action, "relativeTroopRatio") ||
      target.relativeTroopRatio ||
      0;
    if (
      targetTileShare > 0 &&
      (targetTileShare <= 0.055 ||
        (targetTileShare <= 0.08 && relativeTroopRatio >= 2.25)) &&
      (relativeTroopRatio >= 1.45 ||
        targetTroops <= ownTroops * 0.72 ||
        ownTiles <= 11_000)
    ) {
      return 0.25;
    }
    return 0.1;
  };

  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 15 ||
        candidate.action.risk.level === "high" ||
        !actionTargetsPlayer(candidate.action, focusTargetID)
      ) {
        return false;
      }
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const modestShareProbe =
        targetTileShare > 0.08 &&
        targetTileShare <= 0.1 &&
        recentTargetAttacks >= 3 &&
        relativeTroopRatio >= 1.45 &&
        commitment <= 0.14;
      return (
        targetTileShare > 0 &&
        targetTileShare <= 0.1 &&
        (modestShareProbe || targetTileShare <= 0.08) &&
        ((relativeTroopRatio > 0 && relativeTroopRatio >= 1.18) ||
          targetTroops <= ownTroops * 0.78) &&
        commitment >= 0.08 &&
        commitment <= 0.28 &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) &&
        !hasPolicyPenalty(
          candidate,
          "hard-nation underdog should not feed stronger rival probes",
        ) &&
        !hasPolicyPenalty(
          candidate,
          "early multi-front hard-nation trades need a decisive edge",
        )
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const aTargetShare =
        metadataNumber(a.action, "targetTileShare") || target.tileShare || 0;
      const bTargetShare =
        metadataNumber(b.action, "targetTileShare") || target.tileShare || 0;
      return (
        Math.abs(aCommitment - targetCommitment(a)) -
          Math.abs(bCommitment - targetCommitment(b)) ||
        bRelative - aRelative ||
        aTargetShare - bTargetShare ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationWeakenedRivalFinishCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const leaderID = observation.endgame?.leaderID ?? null;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (
    leaderID !== null &&
    leaderID !== ownState.playerID &&
    leaderTileShare >= 0.55 &&
    livingRivalCount(observation) <= 2 &&
    ownTileShare < 0.5
  ) {
    return undefined;
  }
  if (ownTiles < 20_000 || ownTroops < 400_000) {
    return undefined;
  }
  const targetTileShareForCandidate = (
    candidate: FrontierRankedAction,
  ): number => {
    const metadataShare = metadataNumber(candidate.action, "targetTileShare");
    if (metadataShare > 0) {
      return metadataShare;
    }
    const targetID = actionPlayerID(candidate.action);
    return (
      (targetID === null
        ? undefined
        : observation.visiblePlayers.find(
            (player) => player.playerID === targetID,
          )?.tileShare) ?? 0
    );
  };
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 40 ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === ownState.playerID ||
        targetID === leaderID ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const recentTargetAttacks = observation.memory.recentActions.filter(
        (decision) =>
          decision.accepted &&
          decision.actionKind === "attack" &&
          decision.expansion !== true &&
          decision.targetID === targetID,
      ).length;
      const broadFinishTarget = targetTileShare > 0.08;
      const broadFinishAllowed =
        leaderTileShare < 0.36 ||
        ownTileShare >= 0.42 ||
        (ownTiles >= 55_000 && ownTroops >= 900_000);
      const mediumBroadFinishAllowed =
        broadFinishTarget &&
        broadFinishAllowed &&
        (targetTileShare <= 0.12 || relativeTroopRatio >= 1.55) &&
        ((relativeTroopRatio > 0 && relativeTroopRatio >= 1.3) ||
          targetTroops <= ownTroops * 0.68);
      const maxCommitment = broadFinishTarget
        ? mediumBroadFinishAllowed
          ? 0.28
          : 0.18
        : 0.42;
      const minCommitment = broadFinishTarget
        ? mediumBroadFinishAllowed
          ? 0.18
          : 0.08
        : 0.18;
      return (
        recentTargetAttacks >= 3 &&
        targetTileShare > 0 &&
        targetTileShare <= 0.14 &&
        (!broadFinishTarget || broadFinishAllowed) &&
        (targetTiles === 0 || targetTiles <= ownTiles * 0.55) &&
        ((relativeTroopRatio > 0 && relativeTroopRatio >= 1.25) ||
          targetTroops <= ownTroops * 0.8) &&
        commitment >= minCommitment &&
        commitment <= maxCommitment &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aTileShare = targetTileShareForCandidate(a);
      const bTileShare = targetTileShareForCandidate(b);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTargetCommitment =
        aTileShare > 0.08 && aTileShare > 0.12 && aRelative < 1.55 ? 0.1 : 0.25;
      const bTargetCommitment =
        bTileShare > 0.08 && bTileShare > 0.12 && bRelative < 1.55 ? 0.1 : 0.25;
      return (
        Math.abs(aCommitment - aTargetCommitment) -
          Math.abs(bCommitment - bTargetCommitment) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationBreakFrontFollowThroughCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTiles = ownState.tilesOwned;
  if (ownTroops < 1_000_000 || ownTiles < 35_000) {
    return undefined;
  }
  const recentBreakTargetID =
    recentAcceptedTargetID(observation, ["break_alliance"], 10) ??
    (recentAcceptedActionKind(observation, "break_alliance", 3)
      ? weakFrontierAttackTargetID(input)
      : null);
  if (recentBreakTargetID === null) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, recentBreakTargetID) ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      const target = observation.visiblePlayers.find(
        (player) => player.playerID === recentBreakTargetID,
      );
      if (
        target === undefined ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const controlledProbe =
        commitment > 0 &&
        commitment <= 0.12 &&
        targetTileShare >= 0.1 &&
        relativeTroopRatio >= 0.85 &&
        ownTroops >= 1_300_000;
      const committedFollowThrough =
        commitment >= 0.18 &&
        commitment <= 0.32 &&
        targetTileShare >= 0.18 &&
        relativeTroopRatio >= 1.2;
      return (
        (controlledProbe || committedFollowThrough) &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTargetCommitment = aRelative >= 1.2 ? 0.25 : 0.1;
      const bTargetCommitment = bRelative >= 1.2 ? 0.25 : 0.1;
      return (
        Math.abs(aCommitment - aTargetCommitment) -
          Math.abs(bCommitment - bTargetCommitment) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function _hardNationRaceSideCommitCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownTiles < 42_000 ||
    ownTroops < 450_000 ||
    aliveVisibleOpponentCount(observation) < 3 ||
    (observation.endgame?.leaderTileShare ?? 0) >= 0.64
  ) {
    return undefined;
  }
  const recentTargetID =
    currentWarTargetID(input) ??
    recentAcceptedTargetID(observation, ["attack"], 8);
  if (recentTargetID === null || recentTargetID === leaderID) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, recentTargetID) ||
        candidate.totalScore < 70 ||
        hasPolicyPenalty(
          candidate,
          "attack would deplete the reserve below competitive defense",
        ) ||
        hasPolicyPenalty(
          candidate,
          "troop commitment would violate reserves",
        ) ||
        hasPolicyPenalty(candidate, "troop ratio is below attack trigger") ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      ) {
        return false;
      }
      const target = observation.visiblePlayers.find(
        (player) => player.playerID === recentTargetID,
      );
      if (
        target === undefined ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      if (
        commitment > 0.32 &&
        (relativeTroopRatio < 1.55 ||
          ownTroops < 750_000 ||
          targetTroops > ownTroops * 0.75 ||
          (targetTiles > 0 && targetTiles > ownTiles * 0.42))
      ) {
        return false;
      }
      return (
        commitment >= 0.18 &&
        commitment <= 0.42 &&
        (targetTileShare === 0 || targetTileShare <= 0.22) &&
        (targetTiles === 0 || targetTiles <= ownTiles * 0.82) &&
        targetTroops <= ownTroops * 1.25 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 0.82)
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTarget = ownTroops >= 650_000 && aRelative >= 1.05 ? 0.4 : 0.25;
      const bTarget = ownTroops >= 650_000 && bRelative >= 1.05 ? 0.4 : 0.25;
      return (
        Math.abs(aCommitment - aTarget) - Math.abs(bCommitment - bTarget) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationPacedFrontProbeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 45_000 ||
    ownTroops < 500_000 ||
    ownTroops >= 850_000
  ) {
    return undefined;
  }
  const previous = newestAcceptedDecision(observation);
  const previousTargetID =
    typeof previous?.targetID === "string"
      ? previous.targetID
      : (targetIDFromActionID(previous?.actionID) ??
        targetIDFromName(observation, previous?.targetName));
  if (
    previous?.actionKind !== "attack" ||
    previous.expansion === true ||
    previousTargetID === null ||
    troopRatioFromActionID(previous.actionID) < 0.25
  ) {
    return undefined;
  }
  const target =
    observation.visiblePlayers.find(
      (player) => player.playerID === previousTargetID,
    ) ?? null;
  if (
    target === null ||
    target.isAllied ||
    target.isFriendly ||
    !(target.canAttack || target.sharesBorder)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, previousTargetID) ||
        candidate.totalScore < 0 ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      return (
        commitment > 0 &&
        commitment <= 0.12 &&
        (relativeTroopRatio === 0 || relativeTroopRatio < 1.8) &&
        targetTroops <= ownTroops * 1.35
      );
    })
    .sort(
      (a, b) =>
        b.totalScore - a.totalScore || a.action.id.localeCompare(b.action.id),
    )[0];
}

function hardNationBoxedDefensePostCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const defensePosts = ownState.unitCounts?.[UnitType.DefensePost] ?? 0;
  if (
    defensePosts > 0 ||
    ownState.tilesOwned < 4_500 ||
    ownState.tilesOwned > 7_500 ||
    (observation.combat.ownTroops ?? ownState.troops) < 250_000 ||
    observation.combat.attackablePlayerIDs.length === 0 ||
    observation.combat.borderedPlayerIDs.length === 0 ||
    observation.memory.recentExpansionCount < 4
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "build" ||
        !isDefensePostAction(candidate.action) ||
        candidate.action.risk.level === "high" ||
        isPoorDefensePostAction(candidate.action)
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aDefensive = metadataNumber(a.action, "defensiveValue");
      const bDefensive = metadataNumber(b.action, "defensiveValue");
      const aFrontier = metadataNumber(a.action, "frontierValue");
      const bFrontier = metadataNumber(b.action, "frontierValue");
      return (
        bDefensive - aDefensive ||
        bFrontier - aFrontier ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationBoxedBreakoutProbeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const neutralGrowthLegal = input.legalActions.some(isNeutralGrowthAction);
  const boxedAfterNeutralStall = recentNeutralExpansionMadeNoProgress(
    observation,
    ownTiles,
  );
  if (
    ownTiles < 3_500 ||
    ownTiles >= 7_000 ||
    ownTroops < 300_000 ||
    isOneVsOneFinishMode(observation) ||
    (neutralGrowthLegal && !boxedAfterNeutralStall)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 20
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      return (
        commitment > 0 &&
        commitment <= 0.12 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 0.55) &&
        targetTroops <= ownTroops * 1.85
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTargetID = actionPlayerID(a.action);
      const bTargetID = actionPlayerID(b.action);
      const aTarget =
        aTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aTargetID,
            ) ?? null);
      const bTarget =
        bTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bTargetID,
            ) ?? null);
      return (
        Number(bTarget?.incomingAttack === true) -
          Number(aTarget?.incomingAttack === true) ||
        Math.abs(aCommitment - 0.1) - Math.abs(bCommitment - 0.1) ||
        bRelative - aRelative ||
        (aTarget?.troops ?? 0) - (bTarget?.troops ?? 0) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationUnderdogFocusedConquestCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const neutralGrowthLegal = input.legalActions.some(isNeutralGrowthAction);
  const currentTargetID = currentWarTargetID(input);
  const boxedConquestMode =
    recentNeutralExpansionMadeNoProgress(observation, ownTiles) ||
    ownTiles < 10_000 ||
    ownTroops >= 450_000;
  if (
    ownTiles < 7_000 ||
    ownTiles >= 24_000 ||
    ownTroops < 450_000 ||
    isOneVsOneFinishMode(observation) ||
    !boxedConquestMode ||
    (neutralGrowthLegal &&
      currentTargetID === null &&
      !recentNeutralExpansionMadeNoProgress(observation, ownTiles))
  ) {
    return undefined;
  }
  const leaderID = observation.endgame?.leaderID ?? null;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 16
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const focusedTarget =
        currentTargetID === null ||
        targetID === currentTargetID ||
        target.incomingAttack ||
        targetTroops <= ownTroops * 0.62;
      if (!focusedTarget) {
        return false;
      }
      if (
        targetID === leaderID &&
        relativeTroopRatio > 0 &&
        relativeTroopRatio < 1.05
      ) {
        return false;
      }
      if (commitment <= 0 || commitment > 0.28) {
        return false;
      }
      if (commitment > 0.12) {
        return relativeTroopRatio >= 1.22 && targetTroops <= ownTroops * 0.95;
      }
      return (
        relativeTroopRatio === 0 ||
        relativeTroopRatio >= 0.78 ||
        targetTroops <= ownTroops * 1.28
      );
    })
    .sort((a, b) => {
      const aTargetID = actionPlayerID(a.action);
      const bTargetID = actionPlayerID(b.action);
      const aTarget =
        aTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aTargetID,
            ) ?? null);
      const bTarget =
        bTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bTargetID,
            ) ?? null);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        aTarget?.relativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        bTarget?.relativeTroopRatio ||
        0;
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aDesired = aRelative >= 1.22 ? 0.25 : 0.1;
      const bDesired = bRelative >= 1.22 ? 0.25 : 0.1;
      return (
        Number(bTargetID === currentTargetID) -
          Number(aTargetID === currentTargetID) ||
        Number(bTarget?.incomingAttack === true) -
          Number(aTarget?.incomingAttack === true) ||
        Math.abs(aCommitment - aDesired) - Math.abs(bCommitment - bDesired) ||
        bRelative - aRelative ||
        (aTarget?.troops ?? 0) - (bTarget?.troops ?? 0) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationEarlyWeakSideProbeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTiles = ownState.tilesOwned;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (ownTroops >= 700_000 || ownTiles < 24_000 || ownTiles > 36_000) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === ownState.playerID ||
        targetID === leaderID ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const recentTargetAttacks = observation.memory.recentActions.filter(
        (decision) =>
          decision.accepted &&
          decision.actionKind === "attack" &&
          decision.expansion !== true &&
          decision.targetID === targetID,
      ).length;
      return (
        commitment > 0 &&
        commitment <= 0.12 &&
        recentTargetAttacks >= 3 &&
        targetTileShare > 0.08 &&
        targetTileShare <= 0.125 &&
        (targetTiles === 0 || targetTiles <= ownTiles * 0.9) &&
        targetTroops <= ownTroops * 0.85 &&
        relativeTroopRatio >= 1.25 &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      );
    })
    .sort((a, b) => {
      const aShare = metadataNumber(a.action, "targetTileShare");
      const bShare = metadataNumber(b.action, "targetTileShare");
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        bShare - aShare ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function _dominantHardNationRivalPressureCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || hardNationOpponentCount(observation) < 1) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  if (
    ownTiles < 35_000 ||
    ownTroops < 500_000 ||
    ownTileShare < 0.44 ||
    observation.combat.attackablePlayerIDs.length === 0
  ) {
    return undefined;
  }
  const rivals = observation.visiblePlayers
    .filter(
      (player) =>
        player.isAlive &&
        player.playerID !== ownState.playerID &&
        !player.isAllied &&
        !player.isFriendly,
    )
    .sort((a, b) => b.tilesOwned - a.tilesOwned);
  const largestRival = rivals[0];
  if (
    largestRival === undefined ||
    largestRival.tilesOwned < 10_000 ||
    ownTiles < largestRival.tilesOwned * 1.2
  ) {
    return undefined;
  }
  const activeFocusTargetID =
    currentWarTargetID(input) ?? recentCombatTargetID(input);
  if (
    activeFocusTargetID !== null &&
    activeFocusTargetID !== largestRival.playerID
  ) {
    const focusTarget = observation.visiblePlayers.find(
      (player) => player.playerID === activeFocusTargetID,
    );
    if (
      focusTarget !== undefined &&
      focusTarget.tilesOwned <= ownTiles * 0.45 &&
      focusTarget.troops <= ownTroops * 0.95
    ) {
      return undefined;
    }
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, largestRival.playerID) ||
        candidate.totalScore < 35
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        largestRival.relativeTroopRatio ||
        0;
      if (commitment < 0.18 || commitment > 0.42) {
        return false;
      }
      if (
        relativeTroopRatio > 0 &&
        relativeTroopRatio < 0.75 &&
        ownTiles < largestRival.tilesOwned * 1.7
      ) {
        return false;
      }
      return !hasPolicyPenalty(
        candidate,
        "overmatched leader attacks feed a hard-nation snowball",
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        largestRival.relativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        largestRival.relativeTroopRatio ||
        0;
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationDefensiveLeaderCounterattackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    leaderID === ownState.playerID ||
    !isHardNationStrategicContext(observation)
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownState.tilesOwned < 18_000 || ownTroops < 700_000) {
    return undefined;
  }
  const leader = observation.visiblePlayers.find(
    (player) => player.playerID === leaderID,
  );
  if (
    leader === undefined ||
    !observation.combat.incomingAttackPlayerIDs.includes(leaderID)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, leaderID) ||
        candidate.totalScore < 80 ||
        hasSchedulingBlockingPolicyPenalty(candidate)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        leader.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || leader.troops;
      return (
        commitment >= 0.1 &&
        commitment <= 0.42 &&
        relativeTroopRatio >= 1.05 &&
        targetTroops <= ownTroops * 1.05
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationEndgameLeaderStrikeCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  const ownTroops = observation.combat.ownTroops ?? ownState?.troops ?? 0;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  const ownTileShare =
    ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const earlyContenderPressureWindow =
    ownState !== null &&
    ownState.tilesOwned >= 48_000 &&
    ownTileShare >= 0.3 &&
    ownTroops >= 850_000 &&
    aliveVisibleOpponentCount(observation) <= 3 &&
    leaderTileShare >= 0.38;
  const runawayLeaderPressureWindow =
    leaderTileShare >= 0.58 &&
    ownState !== null &&
    ownState.tilesOwned >= 24_000 &&
    ownTroops >= 700_000;
  if (
    ownState === null ||
    leaderID === null ||
    leaderID === ownState.playerID ||
    !isHardNationStrategicContext(observation) ||
    (!runawayLeaderPressureWindow && !earlyContenderPressureWindow)
  ) {
    return undefined;
  }
  const leader = observation.visiblePlayers.find(
    (player) => player.playerID === leaderID,
  );
  if (leader === undefined || leader.isAllied || leader.isFriendly) {
    return undefined;
  }
  const relativeFloor = earlyContenderPressureWindow ? 0.88 : 0.95;
  const mediumRelativeFloor = earlyContenderPressureWindow ? 1.08 : 1.15;
  const maxTargetTroopsMultiplier = earlyContenderPressureWindow ? 1.28 : 1.05;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, leaderID) ||
        candidate.totalScore < 28 ||
        hasSchedulingBlockingPolicyPenalty(candidate)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        leader.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || leader.troops;
      if (
        commitment <= 0 ||
        commitment > 0.3 ||
        relativeTroopRatio < relativeFloor ||
        targetTroops > ownTroops * maxTargetTroopsMultiplier
      ) {
        return false;
      }
      if (
        commitment > 0.12 &&
        (relativeTroopRatio < mediumRelativeFloor ||
          ownTroops < leader.troops * 0.88)
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        leader.relativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        leader.relativeTroopRatio ||
        0;
      const aTarget = aRelative >= mediumRelativeFloor ? 0.25 : 0.1;
      const bTarget = bRelative >= mediumRelativeFloor ? 0.25 : 0.1;
      return (
        Math.abs(aCommitment - aTarget) - Math.abs(bCommitment - bTarget) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationMajorTargetPressureCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const targetID = plan.targetPlayerId;
  if (
    ownState === null ||
    targetID === null ||
    targetID === ownState.playerID ||
    !isHardNationStrategicContext(observation) ||
    plan.objective !== "pressure_rival"
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownState.tilesOwned < 50_000 || ownTroops < 800_000) {
    return undefined;
  }
  const target =
    observation.visiblePlayers.find((player) => player.playerID === targetID) ??
    null;
  if (
    target === null ||
    target.isAllied ||
    target.isFriendly ||
    !(target.canAttack || target.sharesBorder)
  ) {
    return undefined;
  }
  const targetTileShare = target.tileShare ?? 0;
  if (
    targetTileShare < 0.16 &&
    target.tilesOwned < Math.max(24_000, ownState.tilesOwned * 0.45)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        !actionTargetsPlayer(candidate.action, targetID) ||
        candidate.totalScore < 45 ||
        hasSchedulingBlockingPolicyPenalty(candidate)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      if (commitment <= 0 || commitment > 0.32) {
        return false;
      }
      if (relativeTroopRatio > 0 && relativeTroopRatio < 1.05) {
        return false;
      }
      if (targetTroops > ownTroops * 1.08 && relativeTroopRatio < 1.18) {
        return false;
      }
      if (
        observation.memory.repeatedActionKind === "attack" &&
        observation.memory.repeatedActionCount >= 4 &&
        ownTroops < 1_000_000 &&
        commitment > 0.12
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const aTarget = aRelative >= 1.45 ? 0.25 : 0.1;
      const bTarget = bRelative >= 1.45 ? 0.25 : 0.1;
      return (
        Math.abs(aCommitment - aTarget) - Math.abs(bCommitment - bTarget) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationSingleFrontPressureAttackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 55_000 ||
    ownTroops < 800_000 ||
    aliveVisibleOpponentCount(observation) > 3
  ) {
    return undefined;
  }
  const hostileTargetIDs = [
    ...new Set(
      input.legalActions
        .filter(
          (action) =>
            action.kind === "attack" && action.metadata?.expansion !== true,
        )
        .map(actionPlayerID)
        .filter((targetID): targetID is string => targetID !== null),
    ),
  ];
  if (hostileTargetIDs.length !== 1) {
    return undefined;
  }
  const targetID = hostileTargetIDs[0];
  const target =
    observation.visiblePlayers.find((player) => player.playerID === targetID) ??
    null;
  if (
    target === null ||
    target.isAllied ||
    target.isFriendly ||
    !(target.canAttack || target.sharesBorder)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, targetID) ||
        candidate.totalScore < 70 ||
        hasSchedulingBlockingPolicyPenalty(candidate) ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      return (
        commitment >= 0.1 &&
        commitment <= 0.32 &&
        targetTroops <= ownTroops * 1.35 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 0.85)
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aTarget = ownTroops >= 950_000 ? 0.25 : 0.1;
      const bTarget = ownTroops >= 950_000 ? 0.25 : 0.1;
      return (
        Math.abs(aCommitment - aTarget) - Math.abs(bCommitment - bTarget) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationAttackWaveCooldownCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const troopRatio = ownState.troopRatio ?? observation.combat.troopRatio ?? 1;
  const recentHostileAttacks = observation.memory.recentActions.filter(
    (decision) =>
      decision.accepted &&
      decision.actionKind === "attack" &&
      decision.expansion !== true,
  ).length;
  if (
    ownState.tilesOwned < 55_000 ||
    aliveVisibleOpponentCount(observation) > 3 ||
    recentHostileAttacks < 5 ||
    (ownTroops >= 1_100_000 && troopRatio >= 0.5) ||
    (ownTroops >= 950_000 && troopRatio >= 0.58)
  ) {
    return undefined;
  }
  const decisiveAttack = scored.some((candidate) => {
    if (
      candidate.action.kind !== "attack" ||
      candidate.action.metadata?.expansion === true ||
      candidate.action.risk.level === "high"
    ) {
      return false;
    }
    const targetID = actionPlayerID(candidate.action);
    const target =
      targetID === null
        ? null
        : (observation.visiblePlayers.find(
            (player) => player.playerID === targetID,
          ) ?? null);
    if (target === null || target.isAllied || target.isFriendly) {
      return false;
    }
    const commitment = committedTroopRatio(candidate.action, ownTroops);
    const targetTroops =
      metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
    const relativeTroopRatio =
      metadataNumber(candidate.action, "relativeTroopRatio") ||
      target.relativeTroopRatio ||
      0;
    return (
      commitment > 0 &&
      commitment <= 0.25 &&
      relativeTroopRatio >= 1.55 &&
      targetTroops <= ownTroops * 0.75
    );
  });
  if (decisiveAttack) {
    return undefined;
  }
  return (
    scored.find(
      (candidate) =>
        (candidate.action.kind === "build" ||
          candidate.action.kind === "upgrade_structure") &&
        candidate.totalScore >= 60 &&
        candidate.action.risk.level !== "high",
    ) ??
    scored.find(
      (candidate) =>
        candidate.action.kind === "hold" && candidate.totalScore >= 0,
    )
  );
}

function hardNationEndgameAllianceBreakCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    !isHardNationStrategicContext(observation) ||
    ownState.tilesOwned < 50_000 ||
    aliveVisibleOpponentCount(observation) > 3 ||
    recentAcceptedActionKind(observation, "break_alliance", 8)
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownTroops < 900_000) {
    return undefined;
  }
  const hasDirectHostileAttack = input.legalActions.some(isHostileLandAttack);
  const forceOpenEndgameFront =
    !hasDirectHostileAttack &&
    ownState.tilesOwned >= 60_000 &&
    ownTroops >= 1_000_000;
  if (hasDirectHostileAttack && livingRivalCount(observation) > 1) {
    return undefined;
  }
  const leaderID = observation.endgame?.leaderID ?? null;
  return scored
    .filter((candidate) => {
      if (candidate.action.kind !== "break_alliance") {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      if (targetID === null || targetID === ownState.playerID) {
        return false;
      }
      const target =
        observation.visiblePlayers.find(
          (player) => player.playerID === targetID,
        ) ?? null;
      if (
        target !== null &&
        (!target.isAlive ||
          (!forceOpenEndgameFront &&
            !(target.isAllied || target.isFriendly || target.canBreakAlliance)))
      ) {
        return false;
      }
      if (forceOpenEndgameFront) {
        return true;
      }
      const targetTileShare = target?.tileShare ?? 0;
      const targetIsPlanFocus = targetID === plan.targetPlayerId;
      const targetIsLeader = targetID === leaderID;
      const targetIsEndgameThreat =
        targetIsLeader ||
        targetIsPlanFocus ||
        targetTileShare >= 0.16 ||
        (target?.tilesOwned ?? 0) >=
          Math.max(20_000, ownState.tilesOwned * 0.42);
      if (!targetIsEndgameThreat) {
        return false;
      }
      return (
        target === null ||
        target.troops <= ownTroops * 2.4 ||
        targetTileShare >= 0.24 ||
        targetIsLeader
      );
    })
    .sort((a, b) => {
      const aID = actionPlayerID(a.action);
      const bID = actionPlayerID(b.action);
      const aTarget =
        aID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aID,
            ) ?? null);
      const bTarget =
        bID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bID,
            ) ?? null);
      const aLeader = aID !== null && aID === leaderID ? 1 : 0;
      const bLeader = bID !== null && bID === leaderID ? 1 : 0;
      const aPlan = aID !== null && aID === plan.targetPlayerId ? 1 : 0;
      const bPlan = bID !== null && bID === plan.targetPlayerId ? 1 : 0;
      return (
        bLeader - aLeader ||
        bPlan - aPlan ||
        (bTarget?.tilesOwned ?? 0) - (aTarget?.tilesOwned ?? 0) ||
        (bTarget?.troops ?? 0) - (aTarget?.troops ?? 0) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationStalemateAllianceBreakCandidate(
  input: AgentBrainInput,
  plan: StrategicPlan,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    !isHardNationStrategicContext(observation) ||
    aliveVisibleOpponentCount(observation) > 3 ||
    recentAcceptedActionKind(observation, "break_alliance", 8) ||
    hasMapProgressLegalAction(input.legalActions) ||
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const leaderID = observation.endgame?.leaderID ?? null;
  const leaderBreakInterventionAvailable =
    leaderID !== null &&
    scored.some(
      (candidate) =>
        candidate.action.kind === "break_alliance" &&
        actionTargetsPlayer(candidate.action, leaderID) &&
        hasPolicyContribution(
          candidate,
          "break leader alliance before a hard-nation snowball becomes unwinnable",
        ),
    );
  const stalledPressurePlan =
    observation.strategic.priority === "pressure" ||
    plan.objective === "pressure_rival" ||
    observation.memory.repeatedActionKind === "hold" ||
    observation.memory.repeatedActionKind === "embargo_all";
  if (
    ownState.tilesOwned < 30_000 ||
    ownTroops < (leaderBreakInterventionAvailable ? 1_500_000 : 1_650_000) ||
    !stalledPressurePlan ||
    recentAcceptedActionKind(observation, "boat", 8) ||
    recentAcceptedActionKind(observation, "boat_retreat", 8)
  ) {
    return undefined;
  }
  const visibleOpponentCount = aliveVisibleOpponentCount(observation);
  const breakableTargets = observation.visiblePlayers.filter(
    (player) =>
      player.isAlive &&
      player.playerID !== ownState.playerID &&
      (player.isAllied ||
        player.isFriendly ||
        player.canBreakAlliance === true),
  );
  const largestBreakableTiles = Math.max(
    0,
    ...breakableTargets.map((player) => player.tilesOwned),
  );
  return scored
    .filter((candidate) => {
      if (candidate.action.kind !== "break_alliance") {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      if (targetID === null || targetID === ownState.playerID) {
        return false;
      }
      const target =
        observation.visiblePlayers.find(
          (player) => player.playerID === targetID,
        ) ?? null;
      if (
        target === null ||
        !target.isAlive ||
        !(
          target.isAllied ||
          target.isFriendly ||
          target.canBreakAlliance === true
        )
      ) {
        return false;
      }
      const targetTileShare = target.tileShare ?? 0;
      const targetIsPlanFocus = targetID === plan.targetPlayerId;
      const targetIsLeader = targetID === leaderID;
      const targetIsLargestBreakable =
        largestBreakableTiles > 0 &&
        target.tilesOwned >= largestBreakableTiles * 0.88;
      if (
        !targetIsPlanFocus &&
        !targetIsLeader &&
        !(visibleOpponentCount <= 2 && targetIsLargestBreakable)
      ) {
        return false;
      }
      if (
        target.tilesOwned < Math.max(8_000, ownState.tilesOwned * 0.18) &&
        targetTileShare < 0.06
      ) {
        return false;
      }
      if (!targetIsLeader && target.troops > ownTroops * 1.75) {
        return false;
      }
      const ownTileShare =
        ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
      const targetLandClose =
        (target.tilesOwned > 0 &&
          ownState.tilesOwned >= target.tilesOwned * 0.82) ||
        (targetTileShare > 0 && ownTileShare >= targetTileShare * 0.82);
      if (
        targetIsLeader &&
        visibleOpponentCount > 2 &&
        !targetIsPlanFocus &&
        !targetLandClose
      ) {
        return false;
      }
      const relativeTroopRatio =
        target.relativeTroopRatio ??
        (target.troops > 0 ? ownTroops / target.troops : 0);
      if (
        !targetIsLeader &&
        relativeTroopRatio > 0 &&
        relativeTroopRatio < 1.22
      ) {
        return false;
      }
      if (
        targetIsLeader &&
        relativeTroopRatio > 0 &&
        relativeTroopRatio < 1.02
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aID = actionPlayerID(a.action);
      const bID = actionPlayerID(b.action);
      const aTarget =
        aID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aID,
            ) ?? null);
      const bTarget =
        bID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bID,
            ) ?? null);
      const aPlan = aID !== null && aID === plan.targetPlayerId ? 1 : 0;
      const bPlan = bID !== null && bID === plan.targetPlayerId ? 1 : 0;
      const aLeader = aID !== null && aID === leaderID ? 1 : 0;
      const bLeader = bID !== null && bID === leaderID ? 1 : 0;
      const aSafer =
        aTarget !== null && aTarget.troops <= ownTroops * 1.35 ? 1 : 0;
      const bSafer =
        bTarget !== null && bTarget.troops <= ownTroops * 1.35 ? 1 : 0;
      const aRelative =
        aTarget === null
          ? 0
          : (aTarget.relativeTroopRatio ??
            (aTarget.troops > 0 ? ownTroops / aTarget.troops : 0));
      const bRelative =
        bTarget === null
          ? 0
          : (bTarget.relativeTroopRatio ??
            (bTarget.troops > 0 ? ownTroops / bTarget.troops : 0));
      return (
        bLeader - aLeader ||
        bSafer - aSafer ||
        bRelative - aRelative ||
        bPlan - aPlan ||
        (bTarget?.tilesOwned ?? 0) - (aTarget?.tilesOwned ?? 0) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationDuelFinishAttackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  if (
    ownState.tilesOwned < 34_000 ||
    ownTileShare < 0.34 ||
    ownTroops < 750_000 ||
    livingRivalCount(observation) > 2
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high"
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      return (
        commitment >= 0.18 &&
        commitment <= 0.42 &&
        targetTileShare >= 0.18 &&
        targetTileShare <= 0.55 &&
        targetTroops <= ownTroops * 1.3 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 1.18)
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTarget = aRelative >= 1.8 ? 0.4 : 0.25;
      const bTarget = bRelative >= 1.8 ? 0.4 : 0.25;
      return (
        Math.abs(aCommitment - aTarget) - Math.abs(bCommitment - bTarget) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationLargeBaseFocusedPressureCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  if (
    ownTiles < 58_000 ||
    ownTroops < 800_000 ||
    ownTileShare < 0.34 ||
    aliveVisibleOpponentCount(observation) > 3
  ) {
    return undefined;
  }
  const focusTargetID =
    currentWarTargetID(input) ?? recentCombatTargetID(input);
  if (focusTargetID === null || focusTargetID === ownState.playerID) {
    return undefined;
  }
  const leaderID = observation.endgame?.leaderID ?? null;
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.action.risk.level === "high" ||
        !actionTargetsPlayer(candidate.action, focusTargetID)
      ) {
        return false;
      }
      const target =
        observation.visiblePlayers.find(
          (player) => player.playerID === focusTargetID,
        ) ?? null;
      if (
        target === null ||
        target.isAllied ||
        target.isFriendly ||
        !(target.canAttack || target.sharesBorder)
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const targetTileShare =
        metadataNumber(candidate.action, "targetTileShare") ||
        target.tileShare ||
        0;
      if (
        focusTargetID === leaderID &&
        (ownTiles < 66_000 || relativeTroopRatio < 1.45)
      ) {
        return false;
      }
      return (
        commitment >= 0.18 &&
        commitment <= 0.32 &&
        targetTileShare <= 0.42 &&
        (relativeTroopRatio >= 1.22 || targetTroops <= ownTroops * 0.86) &&
        !hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationDuelFinishHoldCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const hostileRetreatTargetIDs = new Set(
    input.legalActions
      .filter(
        (action) =>
          action.kind === "retreat" && !isNeutralRetreatAction(action),
      )
      .map(actionPlayerID)
      .filter((targetID): targetID is string => targetID !== null),
  );
  if (
    ownState.tilesOwned < 38_000 ||
    (ownTileShare < 0.22 && ownState.tilesOwned < 50_000) ||
    ownTroops < 650_000 ||
    aliveVisibleOpponentCount(observation) > 2 ||
    hostileRetreatTargetIDs.size === 0
  ) {
    return undefined;
  }
  const recentAttackTargetID = recentAcceptedTargetID(
    observation,
    ["attack"],
    8,
  );
  if (
    recentAttackTargetID === null ||
    !hostileRetreatTargetIDs.has(recentAttackTargetID)
  ) {
    return undefined;
  }
  const stillHasWinningPressure = input.legalActions.some((action) => {
    if (
      action.kind !== "attack" ||
      action.metadata?.expansion === true ||
      action.risk.level === "high"
    ) {
      return false;
    }
    const targetID = actionPlayerID(action);
    if (targetID === null || !hostileRetreatTargetIDs.has(targetID)) {
      return false;
    }
    const target =
      observation.visiblePlayers.find(
        (player) => player.playerID === targetID,
      ) ?? null;
    if (
      target === null ||
      target.isAllied ||
      target.isFriendly ||
      !(target.canAttack || target.sharesBorder)
    ) {
      return false;
    }
    const targetTileShare =
      metadataNumber(action, "targetTileShare") || target.tileShare || 0;
    const targetTroops =
      metadataNumber(action, "targetTroops") || target.troops || 0;
    const relativeTroopRatio =
      metadataNumber(action, "relativeTroopRatio") ||
      target.relativeTroopRatio ||
      0;
    return (
      targetTileShare >= 0.12 &&
      targetTileShare <= 0.65 &&
      (targetTroops <= ownTroops * 1.45 || relativeTroopRatio >= 1.05)
    );
  });
  if (!stillHasWinningPressure) {
    return undefined;
  }
  return scored.find((candidate) => candidate.action.kind === "hold");
}

function hardNationDefensiveBorderCounterattackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  if (
    leaderID !== null &&
    leaderID !== ownState.playerID &&
    (observation.endgame?.leaderTileShare ?? 0) >= 0.55 &&
    livingRivalCount(observation) <= 2 &&
    ownTileShare < 0.5
  ) {
    return undefined;
  }
  if (
    ownState.tilesOwned < 6_000 ||
    ownState.tilesOwned >= 24_000 ||
    ownTroops < 250_000 ||
    ownTileShare >= 0.26 ||
    observation.strategic.priority !== "build_defense"
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        targetID === null ||
        targetID === leaderID ||
        target === null ||
        target.isAllied ||
        target.isFriendly ||
        candidate.totalScore < 70 ||
        hasSchedulingBlockingPolicyPenalty(candidate) ||
        hasPolicyPenalty(
          candidate,
          "boxed hard-nation opening must not feed rival before breakout",
        ) ||
        hasPolicyPenalty(
          candidate,
          "early multi-front hard-nation trades need a decisive edge",
        )
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") || target.tilesOwned;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      return (
        target.sharesBorder &&
        targetTiles >= ownState.tilesOwned * 0.85 &&
        targetTiles <= ownState.tilesOwned * 1.45 &&
        target.troops <= ownTroops * 0.9 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 1.45) &&
        commitment >= 0.18 &&
        commitment <= 0.42
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationBoxedIncomingCounterattackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownTiles < 6_000 ||
    ownTiles >= 20_000 ||
    ownTroops < 300_000 ||
    observation.combat.incomingAttackPlayerIDs.length === 0 ||
    observation.strategic.priority !== "build_defense"
  ) {
    return undefined;
  }
  const incoming = new Set(observation.combat.incomingAttackPlayerIDs);
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 78 ||
        hasSchedulingBlockingPolicyPenalty(candidate) ||
        hasPolicyPenalty(
          candidate,
          "boxed hard-nation opening must not feed rival before breakout",
        ) ||
        hasPolicyPenalty(
          candidate,
          "hard-nation underdog should not feed stronger rival probes",
        ) ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) ||
        hasPolicyPenalty(candidate, "attack lacks a clear troop edge")
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        !incoming.has(targetID) ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return commitment > 0 && commitment <= 0.28;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationBoxedWeakSideBreakoutCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownTiles < 8_000 ||
    ownTiles >= 20_000 ||
    ownTroops < 500_000 ||
    observation.combat.incomingAttackPlayerIDs.length === 0 ||
    observation.strategic.priority !== "build_defense"
  ) {
    return undefined;
  }
  const incoming = new Set(observation.combat.incomingAttackPlayerIDs);
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 88 ||
        hasPolicyPenalty(
          candidate,
          "hard-nation underdog should not feed stronger rival probes",
        ) ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) ||
        hasPolicyPenalty(candidate, "attack lacks a clear troop edge") ||
        hasPolicyPenalty(
          candidate,
          "medium counterattack needs edge against a larger rival",
        ) ||
        hasPolicyPenalty(
          candidate,
          "large counterattack needs decisive edge against a larger rival",
        )
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === leaderID ||
        incoming.has(targetID) ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      return (
        commitment > 0 &&
        commitment <= 0.12 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 0.9) &&
        targetTroops <= ownTroops * 1.12
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aTargetID = actionPlayerID(a.action);
      const bTargetID = actionPlayerID(b.action);
      const aTarget =
        aTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aTargetID,
            ) ?? null);
      const bTarget =
        bTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bTargetID,
            ) ?? null);
      const aTargetTiles =
        metadataNumber(a.action, "targetTiles") || aTarget?.tilesOwned || 0;
      const bTargetTiles =
        metadataNumber(b.action, "targetTiles") || bTarget?.tilesOwned || 0;
      return (
        Math.abs(aCommitment - 0.1) - Math.abs(bCommitment - 0.1) ||
        aTargetTiles - bTargetTiles ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationStabilizedBoxBreakoutCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    hardNationOpponentCount(observation) < 1 ||
    leaderID === null
  ) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const landExpansionAvailable = input.legalActions.some(
    (action) => action.kind === "attack" && action.metadata?.expansion === true,
  );
  if (
    ownTiles < 7_500 ||
    ownTiles >= 14_000 ||
    ownTroops < 720_000 ||
    landExpansionAvailable ||
    (observation.memory.recentHoldCount ?? 0) < 4 ||
    observation.strategic.urgency === "high" ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 20 ||
        hasPolicyPenalty(
          candidate,
          "hard-nation underdog should not feed stronger rival probes",
        ) ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) ||
        hasPolicyPenalty(candidate, "attack lacks a clear troop edge") ||
        hasPolicyPenalty(
          candidate,
          "medium leader pressure needs parity outside finish mode",
        ) ||
        hasPolicyPenalty(
          candidate,
          "overmatched leader attacks feed a hard-nation snowball",
        )
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === leaderID ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      return (
        commitment >= 0.08 &&
        commitment <= 0.28 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 0.9) &&
        targetTroops <= ownTroops * 1.18 &&
        (targetTiles === 0 || targetTiles <= ownTiles * 3.5)
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTargetID = actionPlayerID(a.action);
      const bTargetID = actionPlayerID(b.action);
      const aTarget =
        aTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aTargetID,
            ) ?? null);
      const bTarget =
        bTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bTargetID,
            ) ?? null);
      const aTargetTiles =
        metadataNumber(a.action, "targetTiles") || aTarget?.tilesOwned || 0;
      const bTargetTiles =
        metadataNumber(b.action, "targetTiles") || bTarget?.tilesOwned || 0;
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        aTargetTiles - bTargetTiles ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationLeaderBlockedSideConversionCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    hardNationOpponentCount(observation) < 1
  ) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  const landExpansionAvailable = input.legalActions.some(
    (action) => action.kind === "attack" && action.metadata?.expansion === true,
  );
  const leaderAttackAvailable = input.legalActions.some(
    (action) =>
      action.kind === "attack" &&
      action.metadata?.expansion !== true &&
      actionTargetsPlayer(action, leaderID),
  );
  if (
    ownTiles < 9_500 ||
    ownTiles >= 32_000 ||
    ownTroops < 780_000 ||
    leaderTileShare < 0.34 ||
    landExpansionAvailable ||
    leaderAttackAvailable ||
    observation.strategic.urgency === "high" ||
    isOneVsOneFinishMode(observation)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        candidate.totalScore < 20 ||
        hasPolicyPenalty(
          candidate,
          "hard-nation underdog should not feed stronger rival probes",
        ) ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        ) ||
        hasPolicyPenalty(candidate, "attack lacks a clear troop edge") ||
        hasPolicyPenalty(
          candidate,
          "medium leader pressure needs parity outside finish mode",
        ) ||
        hasPolicyPenalty(
          candidate,
          "overmatched leader attacks feed a hard-nation snowball",
        )
      ) {
        return false;
      }
      const targetID = actionPlayerID(candidate.action);
      const target =
        targetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === targetID,
            ) ?? null);
      if (
        targetID === null ||
        target === null ||
        targetID === leaderID ||
        target.isAllied ||
        target.isFriendly ||
        !target.sharesBorder
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      return (
        commitment >= 0.1 &&
        commitment <= 0.42 &&
        (relativeTroopRatio === 0 || relativeTroopRatio >= 0.85) &&
        targetTroops <= ownTroops * 1.25 &&
        (targetTiles === 0 || targetTiles <= ownTiles * 4)
      );
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aTargetID = actionPlayerID(a.action);
      const bTargetID = actionPlayerID(b.action);
      const aTarget =
        aTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === aTargetID,
            ) ?? null);
      const bTarget =
        bTargetID === null
          ? null
          : (observation.visiblePlayers.find(
              (player) => player.playerID === bTargetID,
            ) ?? null);
      const aTargetTroops =
        metadataNumber(a.action, "targetTroops") || aTarget?.troops || 0;
      const bTargetTroops =
        metadataNumber(b.action, "targetTroops") || bTarget?.troops || 0;
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        aTargetTroops - bTargetTroops ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationDecisiveLeaderPressureCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    hardNationOpponentCount(observation) < 1
  ) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (
    ownTiles < 20_000 ||
    ownTroops < 1_150_000 ||
    leaderTileShare < 0.42 ||
    recentAcceptedTargetID(observation, ["attack"], 2) === leaderID
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, leaderID) ||
        candidate.totalScore < 20 ||
        hasSchedulingBlockingPolicyPenalty(candidate) ||
        hasPolicyPenalty(
          candidate,
          "urgent defense should not trade into a stronger leader",
        )
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return commitment >= 0.24 && commitment <= 0.32;
    })
    .sort((a, b) => {
      const aRelative = metadataNumber(a.action, "relativeTroopRatio");
      const bRelative = metadataNumber(b.action, "relativeTroopRatio");
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationMidgameCounterattackCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 48_000 ||
    ownTroops < 500_000 ||
    observation.strategic.priority !== "build_defense" ||
    observation.strategic.urgency !== "high" ||
    aliveVisibleOpponentCount(observation) < 3
  ) {
    return undefined;
  }
  const targetID =
    recentAcceptedTargetID(observation, ["attack"], 6) ??
    currentWarTargetID(input);
  const targetIsRunawayLeader =
    targetID === observation.endgame?.leaderID &&
    (observation.endgame?.leaderTileShare ?? 0) >= 0.55;
  if (targetID === null || targetIsRunawayLeader) {
    return undefined;
  }
  const target =
    observation.visiblePlayers.find((player) => player.playerID === targetID) ??
    null;
  if (
    target === null ||
    target.isAllied ||
    target.isFriendly ||
    !(target.canAttack || target.sharesBorder)
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "attack" ||
        candidate.action.metadata?.expansion === true ||
        !actionTargetsPlayer(candidate.action, targetID) ||
        candidate.totalScore < 0 ||
        hasSchedulingBlockingPolicyPenalty(candidate) ||
        hasPolicyPenalty(
          candidate,
          "attacking a stronger rival feeds them troops",
        )
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      const targetTiles =
        metadataNumber(candidate.action, "targetTiles") ||
        target.tilesOwned ||
        0;
      const targetTroops =
        metadataNumber(candidate.action, "targetTroops") || target.troops || 0;
      const relativeTroopRatio =
        metadataNumber(candidate.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      if (
        commitment < 0.1 ||
        commitment > 0.42 ||
        (relativeTroopRatio > 0 && relativeTroopRatio < 0.9) ||
        targetTroops > ownTroops * 1.45 ||
        (targetTiles > 0 && targetTiles > ownState.tilesOwned)
      ) {
        return false;
      }
      if (
        commitment > 0.3 &&
        (relativeTroopRatio < 1.25 || targetTroops > ownTroops * 1.1)
      ) {
        return false;
      }
      if (
        candidate.action.risk.level === "high" &&
        (commitment > 0.25 ||
          (relativeTroopRatio > 0 && relativeTroopRatio < 1.1))
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      const aRelative =
        metadataNumber(a.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      const bRelative =
        metadataNumber(b.action, "relativeTroopRatio") ||
        target.relativeTroopRatio ||
        0;
      return (
        Math.abs(aCommitment - 0.25) - Math.abs(bCommitment - 0.25) ||
        bRelative - aRelative ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationSideTransportCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    leaderID === ownState.playerID ||
    !isHardNationScrum(observation) ||
    (observation.endgame?.leaderTileShare ?? 0) < 0.34 ||
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownState.tilesOwned < 16_000 || ownTroops < 520_000) {
    return undefined;
  }
  const cleanNonLeaderAttack = scored.some((candidate) => {
    const targetID = actionPlayerID(candidate.action);
    return (
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true &&
      targetID !== null &&
      targetID !== leaderID &&
      candidate.totalScore >= 72 &&
      !hasSchedulingBlockingPolicyPenalty(candidate)
    );
  });
  if (cleanNonLeaderAttack) {
    return undefined;
  }
  return scored.find((candidate) => {
    if (candidate.action.kind !== "boat" || candidate.totalScore < 48) {
      return false;
    }
    const targetID = metadataString(candidate.action, "targetID");
    const target =
      targetID === null
        ? null
        : (observation.visiblePlayers.find(
            (player) => player.playerID === targetID,
          ) ?? null);
    return (
      target !== null &&
      targetID !== null &&
      targetID !== leaderID &&
      !targetHasLandContact(observation, targetID) &&
      !target.isAllied &&
      !target.isFriendly &&
      target.troops <= ownTroops * 1.2 &&
      !hasSchedulingBlockingPolicyPenalty(candidate)
    );
  });
}

function hardNationBoxedEscapeTransportCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return undefined;
  }
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const incomingThreatTroops = (
    observation.combat.incomingAttacks ?? []
  ).reduce((sum, attack) => sum + (attack.retreating ? 0 : attack.troops), 0);
  const incomingThreatRatio =
    ownTroops > 0 ? incomingThreatTroops / ownTroops : 0;
  const recentTileLossRatio = recentOwnTileLossRatio(observation, ownTiles);
  const collapsingLandBase =
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    ownTiles < 20_000 &&
    ownTroops >= 280_000 &&
    recentTileLossRatio >= 0.25;
  const desperateEscape =
    incomingThreatRatio >= 0.75 &&
    ownTiles < 8_000 &&
    ownTroops >= 80_000 &&
    (observation.memory.recentHoldCount ?? 0) >= 2;
  const minEscapeTroops = collapsingLandBase
    ? 280_000
    : desperateEscape
      ? 80_000
      : 380_000;
  const maxEscapeTiles = collapsingLandBase
    ? 20_000
    : desperateEscape
      ? 8_000
      : 12_000;
  const minHoldCount = collapsingLandBase ? 0 : desperateEscape ? 2 : 3;
  const landExpansionAvailable = input.legalActions.some(
    (action) => action.kind === "attack" && action.metadata?.expansion === true,
  );
  const boxedAfterNeutralStall = recentNeutralExpansionMadeNoProgress(
    observation,
    ownTiles,
  );
  if (
    ownTiles >= maxEscapeTiles ||
    ownTroops < minEscapeTroops ||
    (landExpansionAvailable && !boxedAfterNeutralStall) ||
    (observation.memory.recentHoldCount ?? 0) < minHoldCount ||
    recentAcceptedActionKind(observation, "boat", 4) ||
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      if (
        candidate.action.kind !== "boat" ||
        !isNeutralBoatAction(candidate.action) ||
        hasPolicyPenalty(candidate, "existing transports should land") ||
        hasPolicyPenalty(candidate, "repeated transport launches")
      ) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return commitment >= 0.08 && commitment <= 0.25;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      if (collapsingLandBase) {
        return (
          bCommitment - aCommitment ||
          b.totalScore - a.totalScore ||
          a.action.id.localeCompare(b.action.id)
        );
      }
      return (
        Math.abs(aCommitment - 0.16) - Math.abs(bCommitment - 0.16) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationHighValueTransportCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return undefined;
  }
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 16_000 ||
    ownTroops < 520_000 ||
    recentAcceptedActionKind(observation, "boat", 4) ||
    recentAcceptedActionKind(observation, "boat_retreat", 8) ||
    input.legalActions.some(
      (action) =>
        action.kind === "attack" && action.metadata?.expansion === true,
    ) ||
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return undefined;
  }
  return scored
    .filter((candidate) => {
      const highValueTransport =
        candidate.totalScore >= 96 ||
        (candidate.skill?.topSkill === "opportunism" &&
          (candidate.skill.totalScore ?? 0) >= 96);
      if (candidate.action.kind !== "boat" || !highValueTransport) {
        return false;
      }
      if (
        hasPolicyPenalty(
          candidate,
          "hostile action does not match the active focus target",
        ) ||
        hasPolicyPenalty(
          candidate,
          "neutral land expansion is safer than a transport invasion",
        )
      ) {
        return false;
      }
      const targetTileShare = metadataNumber(
        candidate.action,
        "targetTileShare",
      );
      const targetID = metadataString(candidate.action, "targetID");
      if (targetID !== null && targetHasLandContact(observation, targetID)) {
        return false;
      }
      if (candidate.totalScore < 96 && targetTileShare > 0.25) {
        return false;
      }
      const commitment = committedTroopRatio(candidate.action, ownTroops);
      return commitment >= 0.08 && commitment <= 0.25;
    })
    .sort((a, b) => {
      const aCommitment = committedTroopRatio(a.action, ownTroops);
      const bCommitment = committedTroopRatio(b.action, ownTroops);
      return (
        Math.abs(aCommitment - 0.16) - Math.abs(bCommitment - 0.16) ||
        b.totalScore - a.totalScore ||
        a.action.id.localeCompare(b.action.id)
      );
    })[0];
}

function hardNationFlankTransportCandidate(
  input: AgentBrainInput,
  scored: readonly FrontierRankedAction[],
): FrontierRankedAction | undefined {
  const observation = input.observation;
  const ownState = observation.ownState;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    leaderID === null ||
    leaderID === ownState.playerID ||
    !isHardNationScrum(observation)
  ) {
    return undefined;
  }
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const leader = observation.visiblePlayers.find(
    (player) => player.playerID === leaderID,
  );
  if (
    ownState.tilesOwned < 16_000 ||
    ownTroops < 450_000 ||
    ownTileShare >= 0.48 ||
    (observation.endgame?.leaderTileShare ?? 0) < 0.34 ||
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0 ||
    leader === undefined ||
    leader.troops <= ownTroops * 1.05
  ) {
    return undefined;
  }
  const cleanNonLeaderAttack = scored.some((candidate) => {
    const targetID = actionPlayerID(candidate.action);
    return (
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true &&
      targetID !== null &&
      targetID !== leaderID &&
      candidate.totalScore >= 72 &&
      !hasSchedulingBlockingPolicyPenalty(candidate)
    );
  });
  if (cleanNonLeaderAttack) {
    return undefined;
  }
  const onlyBadLeaderLandPressure = scored.some((candidate) => {
    const targetID = actionPlayerID(candidate.action);
    return (
      candidate.action.kind === "attack" &&
      candidate.action.metadata?.expansion !== true &&
      targetID === leaderID &&
      hasSchedulingBlockingPolicyPenalty(candidate)
    );
  });
  if (!onlyBadLeaderLandPressure) {
    return undefined;
  }
  return scored.find(
    (candidate) =>
      isNeutralBoatAction(candidate.action) &&
      candidate.totalScore >= 48 &&
      !hasSchedulingBlockingPolicyPenalty(candidate),
  );
}

function shouldRotateOpeningExpansion(input: AgentBrainInput): boolean {
  const observation = input.observation;
  if (observation.memory.recentExpansionCount < 3) {
    return false;
  }
  if (shouldForceCrowdedNationOpeningExpansion(input)) {
    return false;
  }
  if (!input.legalActions.some(isExpansionDiversifierAction)) {
    return false;
  }
  return !isOpeningExpansionTempo(observation);
}

function isOpeningExpansionTempo(
  observation: AgentBrainInput["observation"],
  tileShareLimit = 0.16,
): boolean {
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const incomingPressure =
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.combat.incomingAttacks?.length ?? 0) > 0;
  return (
    observation.combat.canExpandIntoNeutral &&
    !incomingPressure &&
    !isOneVsOneDuelMode(observation) &&
    aliveVisibleOpponentCount(observation) > 1 &&
    ownTileShare < tileShareLimit &&
    (observation.endgame?.leaderTileShare ?? 0) < 0.36
  );
}

function shouldForceCrowdedNationOpeningExpansion(
  input: AgentBrainInput,
): boolean {
  const observation = input.observation;
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const incomingPressure =
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.combat.incomingAttacks?.length ?? 0) > 0;
  const hardNationScrum = hardNationOpponentCount(observation);
  const nationOnlyScrum = isHardNationScrum(observation);
  const veryCrowdedNationScrum = hardNationScrum >= 8;
  const neutralGrowthLegal = input.legalActions.some(isNeutralGrowthAction);
  const tileLimit = veryCrowdedNationScrum ? 8_000 : 16_000;
  const shareLimit = veryCrowdedNationScrum ? 0.12 : 0.21;
  const leaderShareLimit = veryCrowdedNationScrum ? 0.34 : 0.4;
  return (
    nationOnlyScrum &&
    neutralGrowthLegal &&
    !incomingPressure &&
    !isOneVsOneDuelMode(observation) &&
    ownTiles < tileLimit &&
    ownTileShare < shareLimit &&
    (observation.endgame?.leaderTileShare ?? 0) < leaderShareLimit
  );
}

function hardNationOpponentCount(
  observation: AgentBrainInput["observation"],
): number {
  return observation.visiblePlayers.filter(
    (player) => player.isAlive && player.type === PlayerType.Nation,
  ).length;
}

function isHardNationScrum(
  observation: AgentBrainInput["observation"],
): boolean {
  const hardNationScrum = hardNationOpponentCount(observation);
  const aliveOpponents = aliveVisibleOpponentCount(observation);
  return (
    hardNationScrum >= 3 &&
    aliveOpponents > 0 &&
    hardNationScrum / aliveOpponents >= 0.75
  );
}

function isHardNationStrategicContext(
  observation: AgentBrainInput["observation"],
): boolean {
  if (isHardNationScrum(observation)) {
    return true;
  }
  const hardNationOpponents = hardNationOpponentCount(observation);
  const aliveOpponents = aliveVisibleOpponentCount(observation);
  return (
    hardNationOpponents >= 1 &&
    aliveOpponents > 0 &&
    aliveOpponents <= 3 &&
    hardNationOpponents / aliveOpponents >= 0.5
  );
}

function recentNeutralExpansionMadeNoProgress(
  observation: AgentBrainInput["observation"],
  ownTiles: number,
): boolean {
  const recentExpansionTiles = observation.memory.recentActions
    .filter(
      (decision) =>
        decision.accepted &&
        (decision.actionKind === "attack" || decision.actionKind === "boat") &&
        decision.expansion === true &&
        typeof decision.ownTiles === "number",
    )
    .map((decision) => decision.ownTiles ?? 0);
  if (recentExpansionTiles.length < 3) {
    return false;
  }
  const maxRecentTiles = Math.max(...recentExpansionTiles);
  const minRecentTiles = Math.min(...recentExpansionTiles);
  return (
    maxRecentTiles - minRecentTiles <= 160 && ownTiles - maxRecentTiles <= 160
  );
}

function hardNationBufferSupportTargetID(
  input: AgentBrainInput,
): string | null {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (
    ownState === null ||
    !isHardNationScrum(observation) ||
    hasMapProgressLegalAction(input.legalActions) ||
    (observation.nonCombat.boatRetreatOptions?.length ?? 0) > 0
  ) {
    return null;
  }
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (ownTileShare < 0.24 || ownTileShare >= 0.34 || ownTroops < 650_000) {
    return null;
  }
  const leaderID = observation.endgame?.leaderID ?? null;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  if (leaderID === null || leaderTileShare < 0.3 || leaderTileShare >= 0.38) {
    return null;
  }
  const supportableIDs = new Set(
    observation.nonCombat.supportOptions.map((option) => option.recipientID),
  );
  if (!supportableIDs.has(leaderID)) {
    return null;
  }
  const leader = observation.visiblePlayers.find(
    (player) => player.playerID === leaderID,
  );
  if (
    leader === undefined ||
    !leader.isAlive ||
    leader.playerID === ownState.playerID ||
    (leader.tileShare ?? 0) < 0.12 ||
    (leader.tileShare ?? 0) > 0.42
  ) {
    return null;
  }
  if (!leader.incomingAttack || leader.outgoingAttack) {
    return null;
  }
  const strongestChallengerTroops = Math.max(
    0,
    ...observation.visiblePlayers
      .filter(
        (player) =>
          player.isAlive &&
          player.playerID !== ownState.playerID &&
          player.playerID !== leaderID,
      )
      .map((player) => player.troops),
  );
  if (strongestChallengerTroops < leader.troops * 1.08) {
    return null;
  }
  return leaderID;
}

function hasEconomicBuildAction(legalActions: readonly LegalAction[]): boolean {
  return legalActions.some(
    (action) =>
      (action.kind === "build" || action.kind === "upgrade_structure") &&
      isEconomicUnit(metadataString(action, "unit")),
  );
}

function hasCleanHostileAttack(legalActions: readonly LegalAction[]): boolean {
  return legalActions.some((action) => {
    if (action.kind !== "attack" || action.metadata?.expansion === true) {
      return false;
    }
    const relativeTroopRatio = metadataNumber(action, "relativeTroopRatio");
    const troopCommitment = committedTroopRatio(action, 1);
    return (
      action.risk.level !== "high" &&
      (relativeTroopRatio === 0 || relativeTroopRatio >= 1.2) &&
      troopCommitment > 0 &&
      troopCommitment <= 0.28
    );
  });
}

function hasUsefulBuildAction(legalActions: readonly LegalAction[]): boolean {
  return legalActions.some(
    (action) =>
      (action.kind === "build" || action.kind === "upgrade_structure") &&
      action.risk.level !== "high" &&
      (isEconomicUnit(metadataString(action, "unit")) ||
        (isDefensiveAction(action) && !isPoorDefensePostAction(action))),
  );
}

function hasCleanPlannerProgressAction(
  legalActions: readonly LegalAction[],
): boolean {
  return legalActions.some(
    (action) =>
      action.risk.level !== "high" &&
      (isNeutralGrowthAction(action) ||
        actionIsFavorableHostileAttack(action) ||
        isPlayerBoatAction(action)),
  );
}

function hasOnlyNavalGrowth(input: AgentBrainInput): boolean {
  const hasNavalGrowth = input.legalActions.some(isNeutralBoatAction);
  if (!hasNavalGrowth) {
    return false;
  }
  return !input.legalActions.some(
    (action) =>
      action.kind === "attack" &&
      (action.metadata?.expansion === true ||
        actionIsFavorableHostileAttack(action)),
  );
}

function shouldPrioritizeHardNationEconomy(input: AgentBrainInput): boolean {
  const observation = input.observation;
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const incomingPressure =
    observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (observation.combat.incomingAttacks?.length ?? 0) > 0;
  if (
    !isHardNationScrum(observation) ||
    incomingPressure ||
    ownTiles < 8_000 ||
    ownTileShare >= 0.45 ||
    !hasEconomicBuildAction(input.legalActions)
  ) {
    return false;
  }
  const economicStructureCount =
    ownUnitCount(observation, UnitType.City) +
    ownUnitCount(observation, UnitType.Factory) +
    ownUnitCount(observation, UnitType.Port);
  if (ownUnitCount(observation, UnitType.City) === 0) {
    return true;
  }
  if (economicStructureCount < Math.max(2, Math.floor(ownTiles / 16_000))) {
    return true;
  }
  return (
    observation.memory.recentBuildCount === 0 &&
    (observation.memory.recentExpansionCount >= 2 ||
      !hasCleanHostileAttack(input.legalActions))
  );
}

function isWorthScheduling(
  candidate: FrontierRankedAction,
  plan: StrategicPlan,
  slot: FrontierSchedulerSlot,
): boolean {
  if (candidate.action.kind === "hold") {
    return false;
  }
  if (plan.forbiddenActionKinds.includes(candidate.action.kind)) {
    return false;
  }
  if (hasSchedulingBlockingPolicyPenalty(candidate)) {
    return false;
  }
  if (isBlockedRepeatedLowProbeCandidate(candidate)) {
    return false;
  }
  if (isUnsafeUrgentDefenseAttackCandidate(candidate)) {
    return false;
  }
  if (
    candidate.action.kind === "retreat" ||
    candidate.action.kind === "boat_retreat"
  ) {
    return candidate.totalScore >= (plan.objective === "survive" ? 68 : 75);
  }
  const preferred = plan.preferredActionKinds.includes(candidate.action.kind);
  const module = schedulerSlotModules[slot];
  const moduleScore =
    candidate.policy.contributions.find(
      (contribution) => contribution.module === module,
    )?.score ?? 0;
  const threshold = preferred ? 20 : schedulerSlotThresholds[slot];
  if (candidate.action.kind === "delete_unit") {
    return candidate.totalScore >= 72;
  }
  const minimumTotalScore = preferred ? 18 : 34;
  if (candidate.totalScore < minimumTotalScore) {
    return false;
  }
  if (isSocialFlavorAction(candidate.action) && !preferred) {
    return plan.objective === "build_alliance" && candidate.totalScore >= 18;
  }
  return candidate.totalScore >= threshold || moduleScore >= threshold;
}

function hasPolicyPenalty(
  candidate: FrontierRankedAction,
  text: string,
): boolean {
  return candidate.policy.penalties.some((penalty) => penalty.includes(text));
}

function directSelectionCandidate(
  candidate: FrontierRankedAction | undefined,
  options: { allowPlannerForbidden?: boolean } = {},
): FrontierRankedAction | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  if (
    hasPolicyPenalty(candidate, "slow planner forbids this action kind") &&
    options.allowPlannerForbidden !== true &&
    !hasPlannerForbiddenDirectOverride(candidate)
  ) {
    return undefined;
  }
  if (
    candidate.action.kind === "break_alliance" &&
    hasSchedulingBlockingPolicyPenalty(candidate) &&
    !hasHardNationAllianceBreakContribution(candidate) &&
    !hasAgentOnlyPoliticalIntrigueContribution(candidate)
  ) {
    return undefined;
  }
  if (
    hasPolicyPenalty(
      candidate,
      "hard-nation endgame must pressure leader before side cleanup",
    ) &&
    !isLeaderBlockedWeakSideConversion(candidate)
  ) {
    return undefined;
  }
  if (isBlockedRepeatedLowProbeCandidate(candidate)) {
    return undefined;
  }
  if (isUnsafeUrgentDefenseAttackCandidate(candidate)) {
    return undefined;
  }
  return candidate;
}

function hasPlannerForbiddenDirectOverride(
  candidate: FrontierRankedAction,
): boolean {
  return (
    candidate.action.metadata?.expansion === true ||
    hasEmergencyUnsafeAttackOverride(candidate)
  );
}

function directSafetySelectionCandidate(
  candidate: FrontierRankedAction | undefined,
): FrontierRankedAction | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  if (isBlockedRepeatedLowProbeCandidate(candidate)) {
    return undefined;
  }
  if (isUnsafeUrgentDefenseAttackCandidate(candidate)) {
    return undefined;
  }
  return candidate;
}

function isBlockedRepeatedLowProbeCandidate(
  candidate: FrontierRankedAction,
): boolean {
  const troopCommitment = directActionCommitment(candidate.action);
  const frontierConversionReadyAttack = hasPolicyContribution(
    candidate,
    "frontier conversion ready attack uses calibrated weak-rival window",
  );
  const staleCounterpressureProbe =
    hasPolicyPenalty(
      candidate,
      "counterpressure probe is too small to stop an invasion",
    ) &&
    (hasPolicyPenalty(candidate, "recent repeated action kind") ||
      hasPolicyPenalty(candidate, "exact action was recently repeated"));
  const opensExtraFront =
    hasPolicyPenalty(candidate, "max concurrent wars already reached") ||
    hasPolicyPenalty(
      candidate,
      "finish current war before opening another front",
    );
  const repeatedConversionProbe =
    hasPolicyPenalty(
      candidate,
      "repeated low-commitment war probes are stalling conversion",
    ) || staleCounterpressureProbe;
  return (
    candidate.action.kind === "attack" &&
    candidate.action.metadata?.expansion !== true &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    !frontierConversionReadyAttack &&
    (repeatedConversionProbe || opensExtraFront) &&
    !hasPolicyContribution(
      candidate,
      "hard-nation side conquest converts weaker frontier before leader race",
    ) &&
    !hasPolicyContribution(
      candidate,
      "critical border collapse counterattack is better than passive elimination",
    ) &&
    !hasPolicyContribution(
      candidate,
      "last-stand hard-nation counterattack is better than passive elimination",
    )
  );
}

function isUnsafeUrgentDefenseAttackCandidate(
  candidate: FrontierRankedAction,
): boolean {
  if (
    candidate.action.kind !== "attack" ||
    candidate.action.metadata?.expansion === true
  ) {
    return false;
  }
  if (!hasUnsafeUrgentDefensePenalty(candidate)) {
    return false;
  }
  if (
    hasPolicyContribution(
      candidate,
      "frontier conversion ready attack uses calibrated weak-rival window",
    )
  ) {
    return false;
  }
  return !hasEmergencyUnsafeAttackOverride(candidate);
}

function hasUnsafeUrgentDefensePenalty(
  candidate: FrontierRankedAction,
): boolean {
  return [
    "active pressure makes new wars unsafe",
    "urgent defense state makes non-leader attacks too risky",
    "attacking a stronger rival feeds them troops",
    "troop ratio is below attack trigger",
    "attack would deplete the reserve below competitive defense",
  ].some((reason) => hasPolicyPenalty(candidate, reason));
}

function hasEmergencyUnsafeAttackOverride(
  candidate: FrontierRankedAction,
): boolean {
  if (
    hasPolicyContribution(
      candidate,
      "critical border collapse counterattack is better than passive elimination",
    )
  ) {
    return isCredibleEmergencyCounterattack(candidate, {
      maxCommitment: 0.12,
      minRelativeTroopRatio: 0.25,
      maxTargetTileShare: 0.5,
    });
  }
  if (
    hasPolicyContribution(
      candidate,
      "medium counterattack blunts incoming hard-nation leader pressure",
    )
  ) {
    return isCredibleEmergencyCounterattack(candidate, {
      maxCommitment: 0.28,
      minRelativeTroopRatio: 0.55,
      maxTargetTileShare: 0.55,
    });
  }
  if (
    hasPolicyContribution(
      candidate,
      "medium counterattack contests a boxed hard-nation border",
    )
  ) {
    return isCredibleEmergencyCounterattack(candidate, {
      maxCommitment: 0.28,
      minRelativeTroopRatio: 0.75,
      maxTargetTileShare: 0.45,
    });
  }
  if (
    hasPolicyContribution(
      candidate,
      "last-stand hard-nation counterattack is better than passive elimination",
    )
  ) {
    return isCredibleEmergencyCounterattack(candidate, {
      maxCommitment: 0.28,
      minRelativeTroopRatio: 0.2,
      maxTargetTileShare: 0.65,
    });
  }
  if (
    hasPolicyContribution(
      candidate,
      "boxed hard-nation frontier must break out after expansion stalls",
    )
  ) {
    return isCredibleEmergencyCounterattack(candidate, {
      maxCommitment: 0.28,
      minRelativeTroopRatio: 0.75,
      maxTargetTileShare: 0.45,
    });
  }
  if (
    hasPolicyContribution(
      candidate,
      "frontier finish pressure escalates repeated probes",
    )
  ) {
    return true;
  }
  if (
    hasPolicyContribution(
      candidate,
      "hard-nation side conquest converts weaker frontier before leader race",
    )
  ) {
    return isWeakSideConquestEmergencyOverride(candidate, {
      maxCommitment: 0.18,
      minRelativeTroopRatio: 1.8,
      maxTargetTileShare: 0.12,
    });
  }
  if (
    hasPolicyContribution(
      candidate,
      "hard-nation race finish converts side rival before leader wins",
    )
  ) {
    return isWeakSideConquestEmergencyOverride(candidate, {
      maxCommitment: 0.28,
      minRelativeTroopRatio: 1.45,
      maxTargetTileShare: 0.16,
    });
  }
  return false;
}

function isCredibleEmergencyCounterattack(
  candidate: FrontierRankedAction,
  settings: {
    maxCommitment: number;
    minRelativeTroopRatio: number;
    maxTargetTileShare: number;
  },
): boolean {
  const commitment = directActionCommitment(candidate.action);
  const relativeTroopRatio = metadataNumber(
    candidate.action,
    "relativeTroopRatio",
  );
  const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
  return (
    candidate.action.risk.level !== "high" &&
    candidate.action.metadata?.incomingAttack === true &&
    commitment > 0 &&
    commitment <= settings.maxCommitment &&
    relativeTroopRatio > 0 &&
    relativeTroopRatio >= settings.minRelativeTroopRatio &&
    (targetTileShare === 0 || targetTileShare <= settings.maxTargetTileShare)
  );
}

function isWeakSideConquestEmergencyOverride(
  candidate: FrontierRankedAction,
  settings: {
    maxCommitment: number;
    minRelativeTroopRatio: number;
    maxTargetTileShare: number;
  },
): boolean {
  const commitment = directActionCommitment(candidate.action);
  const relativeTroopRatio = metadataNumber(
    candidate.action,
    "relativeTroopRatio",
  );
  const targetTileShare = metadataNumber(candidate.action, "targetTileShare");
  const isTinyDecisiveFinish =
    commitment <= 0.28 &&
    relativeTroopRatio >= 3 &&
    targetTileShare > 0 &&
    targetTileShare <= 0.04;
  return (
    commitment > 0 &&
    (isTinyDecisiveFinish ||
      (commitment <= settings.maxCommitment &&
        (relativeTroopRatio === 0 ||
          relativeTroopRatio >= settings.minRelativeTroopRatio) &&
        (targetTileShare === 0 ||
          targetTileShare <= settings.maxTargetTileShare)))
  );
}

function hasPolicyContribution(
  candidate: FrontierRankedAction,
  text: string,
): boolean {
  return candidate.policy.contributions.some((contribution) =>
    contribution.reason.includes(text),
  );
}

function isHardNationAllianceBreakIntervention(
  candidate: FrontierRankedAction,
): boolean {
  return (
    candidate.action.kind === "break_alliance" &&
    !hasPolicyPenalty(
      candidate,
      "hard-nation multi-rival leader break must follow active plan",
    ) &&
    (hasPolicyContribution(
      candidate,
      "break leader alliance before a hard-nation snowball becomes unwinnable",
    ) ||
      hasPolicyContribution(
        candidate,
        "break rising challenger alliance before it overtakes the hard-nation leader",
      ) ||
      hasPolicyContribution(
        candidate,
        "break weak frontier alliance for hard-nation growth race",
      ) ||
      hasPolicyContribution(
        candidate,
        "break dominant alliance to force hard-nation endgame conquest",
      ))
  );
}

function hasHardNationAllianceBreakContribution(
  candidate: FrontierRankedAction,
): boolean {
  return (
    candidate.action.kind === "break_alliance" &&
    (hasPolicyContribution(
      candidate,
      "break leader alliance before a hard-nation snowball becomes unwinnable",
    ) ||
      hasPolicyContribution(
        candidate,
        "break rising challenger alliance before it overtakes the hard-nation leader",
      ) ||
      hasPolicyContribution(
        candidate,
        "break weak frontier alliance for hard-nation growth race",
      ) ||
      hasPolicyContribution(
        candidate,
        "break dominant alliance to force hard-nation endgame conquest",
      ))
  );
}

function hasAgentOnlyPoliticalIntrigueContribution(
  candidate: FrontierRankedAction,
): boolean {
  return (
    candidate.action.kind === "break_alliance" &&
    hasPolicyContribution(
      candidate,
      "agent-only political theatre breaks fragile pact",
    )
  );
}

function hasAgentOnlyPoliticalPactContribution(
  candidate: FrontierRankedAction,
): boolean {
  return (
    candidate.action.kind === "alliance_request" &&
    hasPolicyContribution(
      candidate,
      "agent-only political theatre forms temporary pacts",
    )
  );
}

function hasBlockingPolicyPenalty(candidate: FrontierRankedAction): boolean {
  const hardNationEscapeTransport = hasPolicyContribution(
    candidate,
    "boxed hard-nation escape transport creates a new land base",
  );
  const agentOnlyPoliticalIntrigue =
    hasAgentOnlyPoliticalIntrigueContribution(candidate);
  return (
    hasPolicyPenalty(candidate, "one-vs-one matches need pressure") ||
    hasPolicyPenalty(
      candidate,
      "early neutral expansion should not be diluted",
    ) ||
    hasPolicyPenalty(
      candidate,
      "high incoming pressure should preserve troops before neutral expansion",
    ) ||
    (hasPolicyPenalty(candidate, "repeated neutral expansion should rotate") &&
      !hasPolicyContribution(
        candidate,
        "stalled island expansion needs a neutral transport path",
      )) ||
    hasPolicyPenalty(
      candidate,
      "expansion plan should not mix hostile pressure",
    ) ||
    hasPolicyPenalty(
      candidate,
      "early expansion should not be diluted by alliance",
    ) ||
    hasPolicyPenalty(candidate, "stopping embargo on a rival") ||
    hasPolicyPenalty(
      candidate,
      "neutral expansion retreat wastes growth tempo",
    ) ||
    (hasPolicyPenalty(
      candidate,
      "land expansion is safer than neutral transport",
    ) &&
      !hasPolicyContribution(
        candidate,
        "stalled island expansion needs a neutral transport path",
      )) ||
    hasPolicyPenalty(
      candidate,
      "hard-nation land lead must convert rivals instead of farming neutral land",
    ) ||
    hasPolicyPenalty(candidate, "do not protect a runaway") ||
    hasPolicyPenalty(
      candidate,
      "do not re-ally with the active conquest target",
    ) ||
    hasPolicyPenalty(
      candidate,
      "do not re-ally with recent hard-nation war target",
    ) ||
    hasPolicyPenalty(
      candidate,
      "hard-nation midgame must convert land instead of new alliances",
    ) ||
    hasPolicyPenalty(
      candidate,
      "built-in hard nations do not spend their first structure",
    ) ||
    hasPolicyPenalty(candidate, "do not stop pressure on runaway leader") ||
    hasPolicyPenalty(
      candidate,
      "runaway leader pressure needs direct pressure",
    ) ||
    hasPolicyPenalty(
      candidate,
      "hard-nation multi-rival leader break must follow active plan",
    ) ||
    (hasPolicyPenalty(candidate, "do not break non-leader alliances") &&
      !agentOnlyPoliticalIntrigue) ||
    (hasPolicyPenalty(candidate, "multi-rival matches should keep alliances") &&
      !agentOnlyPoliticalIntrigue) ||
    hasPolicyPenalty(candidate, "early nation must keep gold and troops") ||
    hasPolicyPenalty(
      candidate,
      "hard-nation benchmark should not feed rival nations",
    ) ||
    hasPolicyPenalty(
      candidate,
      "do not ally with weak hard-nation conquest target",
    ) ||
    hasPolicyPenalty(
      candidate,
      "do not ally with hard-nation conquest target",
    ) ||
    hasPolicyPenalty(
      candidate,
      "do not ally with hard-nation side-conquest target",
    ) ||
    hasPolicyPenalty(
      candidate,
      "do not ally with runaway hard-nation leader",
    ) ||
    hasPolicyPenalty(
      candidate,
      "boxed hard-nation opening must not feed rival before breakout",
    ) ||
    hasPolicyPenalty(
      candidate,
      "boxed hard-nation opening should not escalate pressure before a land base",
    ) ||
    hasPolicyPenalty(
      candidate,
      "hard-nation underdog should not feed stronger rival probes",
    ) ||
    hasPolicyPenalty(
      candidate,
      "early multi-front hard-nation trades need a decisive edge",
    ) ||
    hasPolicyPenalty(
      candidate,
      "recent retreat needs a troop rebuild before counterattack",
    ) ||
    hasPolicyPenalty(candidate, "stronger border rival requires stabilizing") ||
    (hasPolicyPenalty(
      candidate,
      "stronger border rival makes neutral transport too slow",
    ) &&
      !hardNationEscapeTransport &&
      !hasPolicyContribution(
        candidate,
        "stalled island expansion needs a neutral transport path",
      )) ||
    hasPolicyPenalty(
      candidate,
      "critical border collapse should use survival actions",
    ) ||
    (hasPolicyPenalty(
      candidate,
      "bordered rival pressure makes repeated neutral expansion stale",
    ) &&
      !hardNationEscapeTransport) ||
    hasPolicyPenalty(
      candidate,
      "finish recently opened alliance front before switching targets",
    ) ||
    (hasPolicyPenalty(
      candidate,
      "pressure plan should not spend troops on neutral land",
    ) &&
      !hardNationEscapeTransport)
  );
}

function hasSchedulingBlockingPolicyPenalty(
  candidate: FrontierRankedAction,
): boolean {
  return schedulingBlockingReasons(candidate).length > 0;
}

function transportTroopBankingLaunchTroops(
  action: LegalAction,
  banking: AgentTransportTroopBankingAffordance,
): number {
  const metadataTroops = metadataNumber(action, "troops");
  if (metadataTroops > 0) {
    return metadataTroops;
  }
  const ownTroops = banking.ownTroops ?? 0;
  const actionIDPercent = troopPercentFromActionID(action.id);
  if (ownTroops > 0 && actionIDPercent > 0) {
    return Math.round(ownTroops * (actionIDPercent / 100));
  }
  if (banking.availableBoatLaunchTroops.length === 1) {
    return banking.availableBoatLaunchTroops[0] ?? 0;
  }
  return 0;
}

function schedulingBlockingReasons(candidate: FrontierRankedAction): string[] {
  const reasons: string[] = [];
  if (
    candidate.action.kind === "attack" &&
    candidate.action.metadata?.expansion !== true
  ) {
    const desperationCounterattack = hasPolicyContribution(
      candidate,
      "critical border collapse counterattack",
    );
    const credibleDesperationCounterattack =
      desperationCounterattack &&
      isCredibleEmergencyCounterattack(candidate, {
        maxCommitment: 0.12,
        minRelativeTroopRatio: 0.25,
        maxTargetTileShare: 0.5,
      });
    const leaderDefensiveCounterattack = hasPolicyContribution(
      candidate,
      "medium counterattack blunts incoming hard-nation leader pressure",
    );
    const hardNationBorderCounterattack = hasPolicyContribution(
      candidate,
      "medium counterattack contests a boxed hard-nation border",
    );
    const hardNationLastStandCounterattack = hasPolicyContribution(
      candidate,
      "last-stand hard-nation counterattack",
    );
    const hardNationBoxedBreakoutProbe = hasPolicyContribution(
      candidate,
      "boxed hard-nation frontier must break out",
    );
    const hardNationRunawayLeaderProbe = hasPolicyContribution(
      candidate,
      "runaway hard-nation leader probe",
    );
    const largeBaseHardNationLeaderProbe = hasPolicyContribution(
      candidate,
      "large-base hard-nation leader probe buys endgame time",
    );
    const hardNationLeaderAttackWave = hasPolicyContribution(
      candidate,
      "sustained leader attack wave",
    );
    const dominantHardNationRivalPressure = hasPolicyContribution(
      candidate,
      "dominant hard-nation leader pressures largest rival",
    );
    const frontierConversionReadyAttack = hasPolicyContribution(
      candidate,
      "frontier conversion ready attack uses calibrated weak-rival window",
    );
    const frontierFinishPressureAttack = hasPolicyContribution(
      candidate,
      "frontier finish pressure escalates repeated probes",
    );
    for (const reason of [
      "active pressure makes new wars unsafe",
      "urgent defense state makes non-leader attacks too risky",
      "attacking a stronger rival feeds them troops",
      "attack lacks a clear troop edge",
      "urgent defense should not trade into a stronger leader",
      "repeated leader probe needs a troop rebuild window",
      "repeated incoming leader probe needs a troop rebuild window",
      "medium leader pressure needs parity outside finish mode",
      "medium leader attacks need a decisive edge while rivals remain",
      "overmatched leader attacks feed a hard-nation snowball",
      "urgent defense should grow before challenging an overlarge leader",
      "troop ratio is below attack trigger",
      "attack would deplete the reserve below competitive defense",
      "max concurrent wars already reached",
      "finish current war before opening another front",
      "finish favorable current war before switching fronts",
      "hard-nation endgame must pressure leader before side cleanup",
      "grow through weaker rival before trading into stronger leader",
      "boxed hard-nation opening must not feed rival before breakout",
      "medium counterattack needs edge against a larger rival",
      "large counterattack needs decisive edge against a larger rival",
      "early multi-front hard-nation trades need a decisive edge",
      "hard-nation underdog should not feed stronger rival probes",
      "recent retreat needs a troop rebuild before counterattack",
      "hard-nation attack wave should rebuild troops before another medium strike",
      "tiny cleanup attack must preserve reserves for the hard-nation leader",
      "hostile action does not match the active focus target",
    ]) {
      if (
        frontierConversionReadyAttack &&
        [
          "active pressure makes new wars unsafe",
          "urgent defense state makes non-leader attacks too risky",
          "troop ratio is below attack trigger",
          "attack would deplete the reserve below competitive defense",
          "multi-rival opening pressure should use reserve-preserving probes",
          "medium attack needs a clear troop edge outside finish mode",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        frontierFinishPressureAttack &&
        [
          "troop ratio is below attack trigger",
          "attack would deplete the reserve below competitive defense",
          "multi-rival opening pressure should use reserve-preserving probes",
          "medium attack needs a clear troop edge outside finish mode",
          "hard-nation attack wave should rebuild troops before another medium strike",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        dominantHardNationRivalPressure &&
        [
          "attacking a stronger rival feeds them troops",
          "attack lacks a clear troop edge",
          "medium attack needs a clear troop edge outside finish mode",
          "large attack needs a decisive troop edge outside finish mode",
          "attack would deplete the reserve below competitive defense",
          "urgent defense state makes non-leader attacks too risky",
          "hostile action does not match the active focus target",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        (reason === "attack lacks a clear troop edge" ||
          reason === "attacking a stronger rival feeds them troops") &&
        hasPolicyContribution(
          candidate,
          "large nation can pressure the land leader",
        )
      ) {
        continue;
      }
      if (
        reason === "attack lacks a clear troop edge" &&
        hasPolicyContribution(
          candidate,
          "large nation can probe the land leader",
        )
      ) {
        continue;
      }
      if (
        reason === "overmatched leader attacks feed a hard-nation snowball" &&
        hasPolicyContribution(
          candidate,
          "large nation can probe the land leader",
        )
      ) {
        continue;
      }
      if (
        (reason === "attack lacks a clear troop edge" ||
          reason === "attacking a stronger rival feeds them troops") &&
        hasPolicyContribution(
          candidate,
          "reserve-safe leader containment probe",
        )
      ) {
        continue;
      }
      if (
        hardNationRunawayLeaderProbe &&
        [
          "active pressure makes new wars unsafe",
          "max concurrent wars already reached",
          "hostile action does not match the active focus target",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        largeBaseHardNationLeaderProbe &&
        [
          "active pressure makes new wars unsafe",
          "attacking a stronger rival feeds them troops",
          "attack lacks a clear troop edge",
          "urgent defense should not trade into a stronger leader",
          "repeated leader probe needs a troop rebuild window",
          "medium leader pressure needs parity outside finish mode",
          "overmatched leader attacks feed a hard-nation snowball",
          "urgent defense should grow before challenging an overlarge leader",
          "troop ratio is below attack trigger",
          "attack would deplete the reserve below competitive defense",
          "max concurrent wars already reached",
          "hostile action does not match the active focus target",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        hardNationLeaderAttackWave &&
        [
          "active pressure makes new wars unsafe",
          "attack lacks a clear troop edge",
          "urgent defense should not trade into a stronger leader",
          "medium leader pressure needs parity outside finish mode",
          "medium leader attacks need a decisive edge while rivals remain",
          "troop ratio is below attack trigger",
          "attack would deplete the reserve below competitive defense",
          "max concurrent wars already reached",
          "hostile action does not match the active focus target",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        leaderDefensiveCounterattack &&
        [
          "attack lacks a clear troop edge",
          "urgent defense should not trade into a stronger leader",
          "medium leader pressure needs parity outside finish mode",
          "medium leader attacks need a decisive edge while rivals remain",
          "attack would deplete the reserve below competitive defense",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        hardNationBorderCounterattack &&
        [
          "attacking a stronger rival feeds them troops",
          "attack lacks a clear troop edge",
          "urgent defense state makes non-leader attacks too risky",
          "medium counterattack needs edge against a larger rival",
          "medium attack needs a clear troop edge outside finish mode",
          "attack would deplete the reserve below competitive defense",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        [
          "attack lacks a clear troop edge",
          "medium leader pressure needs parity outside finish mode",
          "medium leader attacks need a decisive edge while rivals remain",
          "attack would deplete the reserve below competitive defense",
        ].includes(reason) &&
        hasPolicyContribution(candidate, "parity leader containment strike")
      ) {
        continue;
      }
      if (
        [
          "active pressure makes new wars unsafe",
          "urgent defense state makes non-leader attacks too risky",
        ].includes(reason) &&
        hasPolicyContribution(
          candidate,
          "hard-nation side conquest converts weaker frontier before leader race",
        )
      ) {
        continue;
      }
      if (
        (hardNationLastStandCounterattack || hardNationBoxedBreakoutProbe) &&
        [
          "active pressure makes new wars unsafe",
          "urgent defense state makes non-leader attacks too risky",
          "attacking a stronger rival feeds them troops",
          "attack lacks a clear troop edge",
          "urgent defense should not trade into a stronger leader",
          "medium leader pressure needs parity outside finish mode",
          "medium leader attacks need a decisive edge while rivals remain",
          "troop ratio is below attack trigger",
          "attack would deplete the reserve below competitive defense",
          "max concurrent wars already reached",
          "finish current war before opening another front",
          "hostile action does not match the active focus target",
          "multi-rival opening pressure should use reserve-preserving probes",
          "hard-nation underdog should not feed stronger rival probes",
        ].includes(reason)
      ) {
        continue;
      }
      if (
        reason === "hostile action does not match the active focus target" &&
        (hasPolicyContribution(
          candidate,
          "follow through after breaking alliance front",
        ) ||
          hasPolicyContribution(
            candidate,
            "hard-nation side conquest converts weaker frontier before leader race",
          ) ||
          hasPolicyContribution(
            candidate,
            "hard-nation race finish converts side rival before leader wins",
          ))
      ) {
        continue;
      }
      if (
        [
          "attack lacks a clear troop edge",
          "medium attack needs a clear troop edge outside finish mode",
          "attack would deplete the reserve below competitive defense",
          "troop ratio is below attack trigger",
        ].includes(reason) &&
        hasPolicyContribution(
          candidate,
          "hard-nation race finish converts side rival before leader wins",
        )
      ) {
        continue;
      }
      if (
        reason === "attacking a stronger rival feeds them troops" &&
        hasPolicyContribution(
          candidate,
          "small counterattack contests an incoming leader invasion",
        )
      ) {
        continue;
      }
      if (
        credibleDesperationCounterattack &&
        [
          "active pressure makes new wars unsafe",
          "urgent defense state makes non-leader attacks too risky",
          "attacking a stronger rival feeds them troops",
          "attack lacks a clear troop edge",
          "troop ratio is below attack trigger",
          "attack would deplete the reserve below competitive defense",
          "max concurrent wars already reached",
          "finish current war before opening another front",
          "hostile action does not match the active focus target",
          "medium and large attacks require a developed troop base",
          "large attacks require a durable land and troop lead",
          "large attack needs a decisive troop edge outside finish mode",
          "medium attack needs a clear troop edge outside finish mode",
        ].includes(reason)
      ) {
        continue;
      }
      if (hasPolicyPenalty(candidate, reason)) {
        reasons.push(reason);
      }
    }
  }
  if (
    isHostilePressureAction(candidate.action) &&
    candidate.action.kind !== "attack" &&
    !isHardNationAllianceBreakIntervention(candidate) &&
    hasPolicyPenalty(
      candidate,
      "hostile action does not match the active focus target",
    )
  ) {
    reasons.push("hostile action does not match the active focus target");
  }
  if (hasBlockingPolicyPenalty(candidate)) {
    reasons.push("blocking policy penalty");
  }
  for (const reason of [
    "transport retreat without immediate pressure",
    "retreating offensive attacks without incoming pressure",
    "hard-nation contested frontier should counterattack before retreating",
    "multi-rival opening pressure should use reserve-preserving probes",
    "medium and large attacks require a developed troop base",
    "large attacks require a durable land and troop lead",
    "existing transports should land",
    "fresh escape transport should land before retreating",
    "land attacks are available",
    "repeated transport launches",
    "dominant conversion should use favorable attacks",
    "dominant conversion should attack favorable borders",
    "naval conversion should move troops",
    "naval conversion should launch transport",
    "desperate counterattack against stronger rival must stay probe-sized",
  ]) {
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "frontier finish pressure escalates repeated probes",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "frontier conversion ready attack uses calibrated weak-rival window",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      hasPolicyContribution(
        candidate,
        "medium counterattack blunts incoming hard-nation leader pressure",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      hasPolicyContribution(
        candidate,
        "medium counterattack contests a boxed hard-nation border",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "last-stand hard-nation counterattack",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "large attack needs a decisive troop edge outside finish mode",
        "medium attack needs a clear troop edge outside finish mode",
        "desperate counterattack against stronger rival must stay probe-sized",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "boxed hard-nation frontier must break out",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "large attack needs a decisive troop edge outside finish mode",
        "medium attack needs a clear troop edge outside finish mode",
        "desperate counterattack against stronger rival must stay probe-sized",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "large nation can pressure the land leader",
      ) &&
      reason ===
        "multi-rival opening pressure should use reserve-preserving probes"
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "dominant hard-nation leader pressures largest rival",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "large attack needs a decisive troop edge outside finish mode",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(candidate, "runaway hard-nation leader probe") &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "large attack needs a decisive troop edge outside finish mode",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "follow through after breaking alliance front",
      ) &&
      reason ===
        "multi-rival opening pressure should use reserve-preserving probes"
    ) {
      continue;
    }
    if (
      candidate.action.kind === "attack" &&
      hasPolicyContribution(
        candidate,
        "critical border collapse counterattack",
      ) &&
      [
        "multi-rival opening pressure should use reserve-preserving probes",
        "medium and large attacks require a developed troop base",
        "large attacks require a durable land and troop lead",
        "large attack needs a decisive troop edge outside finish mode",
        "medium attack needs a clear troop edge outside finish mode",
      ].includes(reason)
    ) {
      continue;
    }
    if (hasPolicyPenalty(candidate, reason)) {
      reasons.push(reason);
    }
  }
  if (candidate.action.kind === "boat") {
    for (const reason of [
      "land expansion is safer than neutral transport while borders can still grow",
      "avoid transport spam while an invasion is already active",
    ]) {
      if (
        reason ===
          "land expansion is safer than neutral transport while borders can still grow" &&
        hasPolicyContribution(
          candidate,
          "human replay opening baseline uses early neutral transport",
        )
      ) {
        continue;
      }
      if (hasPolicyPenalty(candidate, reason)) {
        reasons.push(reason);
      }
    }
  }
  if (isNeutralGrowthAction(candidate.action)) {
    for (const reason of [
      "hard-nation land lead must convert rivals instead of farming neutral land",
      "neutral expansion is not gaining land from this boxed frontier",
    ]) {
      if (hasPolicyPenalty(candidate, reason)) {
        reasons.push(reason);
      }
    }
  }
  return reasons;
}

function blockedHostileAttackSummary(
  scored: readonly FrontierRankedAction[],
): string {
  return scored
    .filter(
      (candidate) =>
        candidate.action.kind === "attack" &&
        candidate.action.metadata?.expansion !== true,
    )
    .map((candidate) => ({
      id: candidate.action.id,
      reasons: schedulingBlockingReasons(candidate),
    }))
    .filter((entry) => entry.reasons.length > 0)
    .slice(0, 4)
    .map((entry) => `${entry.id}:${entry.reasons.slice(0, 2).join("+")}`)
    .join(",");
}

function isBatchCompatible(
  action: LegalAction,
  selected: LegalAction[],
): boolean {
  if (selected.length === 0) {
    return true;
  }
  if (action.kind === "hold" || action.kind === "spawn") {
    return false;
  }
  if (selected.some((candidate) => candidate.id === action.id)) {
    return false;
  }
  if (selected.some((candidate) => candidate.kind === action.kind)) {
    return false;
  }
  if (
    isTroopMovementAction(action) &&
    selected.some((candidate) => isTroopMovementAction(candidate))
  ) {
    return false;
  }
  if (
    isStructureManagementAction(action) &&
    selected.some((candidate) => isStructureManagementAction(candidate))
  ) {
    return false;
  }
  return selected.every((candidate) => !hasTargetConflict(action, candidate));
}

function isTroopMovementAction(action: LegalAction): boolean {
  return (
    action.kind === "attack" ||
    action.kind === "retreat" ||
    action.kind === "boat" ||
    action.kind === "boat_retreat"
  );
}

function isStructureManagementAction(action: LegalAction): boolean {
  return (
    action.kind === "build" ||
    action.kind === "upgrade_structure" ||
    action.kind === "delete_unit"
  );
}

function isSocialFlavorAction(action: LegalAction): boolean {
  return action.kind === "quick_chat" || action.kind === "emoji";
}

function hasTargetConflict(a: LegalAction, b: LegalAction): boolean {
  const aTarget = actionPlayerID(a);
  const bTarget = actionPlayerID(b);
  if (aTarget === null || bTarget === null || aTarget !== bTarget) {
    return false;
  }
  const allianceA = isAllianceManagementAction(a);
  const allianceB = isAllianceManagementAction(b);
  if (allianceA && allianceB) {
    return true;
  }
  const embargoA = a.kind === "embargo" || a.kind === "embargo_stop";
  const embargoB = b.kind === "embargo" || b.kind === "embargo_stop";
  if (embargoA && embargoB) {
    return true;
  }
  return (
    (isFriendlyDiplomacyAction(a) && isHostilePressureAction(b)) ||
    (isFriendlyDiplomacyAction(b) && isHostilePressureAction(a))
  );
}

function isAllianceManagementAction(action: LegalAction): boolean {
  return (
    action.kind === "alliance_request" ||
    action.kind === "alliance_reject" ||
    action.kind === "alliance_extend" ||
    action.kind === "break_alliance"
  );
}

function isFriendlyDiplomacyAction(action: LegalAction): boolean {
  return (
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "donate_gold" ||
    action.kind === "donate_troops" ||
    action.kind === "embargo_stop"
  );
}

function isHostilePressureAction(action: LegalAction): boolean {
  return (
    action.kind === "attack" ||
    isPlayerBoatAction(action) ||
    action.kind === "embargo" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player" ||
    action.kind === "break_alliance" ||
    action.kind === "nuke"
  );
}

function isNeutralGrowthAction(action: LegalAction): boolean {
  return isNeutralLandExpansionAction(action) || isNeutralBoatAction(action);
}

function isNeutralLandExpansionAction(action: LegalAction): boolean {
  return action.kind === "attack" && action.metadata?.expansion === true;
}

function neutralGrowthActionRank(action: LegalAction): number {
  if (isNeutralLandExpansionAction(action)) {
    return 0;
  }
  if (isNeutralBoatAction(action)) {
    return 1;
  }
  return 2;
}

function isPlayerBoatAction(action: LegalAction): boolean {
  return action.kind === "boat" && metadataString(action, "targetID") !== null;
}

function isNeutralBoatAction(action: LegalAction): boolean {
  if (action.kind !== "boat" || action.metadata?.navalInvasion === true) {
    return false;
  }
  return (
    metadataString(action, "targetID") === null ||
    metadataString(action, "targetName") === "Terra Nullius" ||
    action.metadata?.expansion === true
  );
}

function isPressureOnlySignalAction(action: LegalAction): boolean {
  return (
    action.kind === "embargo" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player" ||
    action.kind === "break_alliance" ||
    action.kind === "alliance_reject"
  );
}

function isDirectConquestAction(action: LegalAction): boolean {
  return (
    (action.kind === "attack" && action.metadata?.expansion !== true) ||
    isPlayerBoatAction(action) ||
    action.kind === "nuke"
  );
}

function isExpansionDiversifierAction(action: LegalAction): boolean {
  if (action.kind === "build" || action.kind === "upgrade_structure") {
    return true;
  }
  return (
    (action.kind === "attack" && action.metadata?.expansion !== true) ||
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "embargo" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player"
  );
}

function actionPlayerID(action: LegalAction): string | null {
  return (
    metadataString(action, "targetID") ??
    metadataString(action, "recipientID") ??
    metadataString(action, "playerID")
  );
}

function targetHasLandContact(
  observation: AgentBrainInput["observation"],
  playerID: string,
): boolean {
  const target = observation.visiblePlayers.find(
    (player) => player.playerID === playerID,
  );
  return (
    target?.canAttack === true ||
    target?.sharesBorder === true ||
    observation.combat.attackablePlayerIDs.includes(playerID) ||
    observation.combat.borderedPlayerIDs.includes(playerID)
  );
}

function livingRivalCount(observation: AgentBrainInput["observation"]): number {
  const ownID = observation.ownState?.playerID ?? null;
  return observation.visiblePlayers.filter(
    (player) =>
      player.isAlive &&
      player.playerID !== ownID &&
      !player.isAllied &&
      !player.isFriendly,
  ).length;
}

function aliveVisibleOpponentCount(
  observation: AgentBrainInput["observation"],
): number {
  const ownID = observation.ownState?.playerID ?? null;
  return observation.visiblePlayers.filter(
    (player) => player.isAlive && player.playerID !== ownID,
  ).length;
}

function isOneVsOneFinishMode(
  observation: AgentBrainInput["observation"],
): boolean {
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  return ownTileShare >= 0.68 && aliveVisibleOpponentCount(observation) <= 1;
}

function isOneVsOneDuelMode(
  observation: AgentBrainInput["observation"],
): boolean {
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  return ownTileShare >= 0.55 && aliveVisibleOpponentCount(observation) <= 1;
}

function isDominantConversionMode(
  observation: AgentBrainInput["observation"],
): boolean {
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const ownID = observation.ownState?.playerID ?? null;
  const largestOpponentTiles = Math.max(
    0,
    ...observation.visiblePlayers
      .filter((player) => player.isAlive && player.playerID !== ownID)
      .map((player) => player.tilesOwned),
  );
  return (
    observation.combat.attackablePlayerIDs.length > 0 &&
    (ownTileShare >= 0.55 ||
      (ownTileShare >= 0.44 &&
        ownTiles >= 35_000 &&
        ownTiles >= largestOpponentTiles * 1.65))
  );
}

function isNavalConversionMode(
  observation: AgentBrainInput["observation"],
  legalActions: readonly LegalAction[],
): boolean {
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  return (
    ownTileShare >= 0.55 &&
    observation.combat.attackablePlayerIDs.length === 0 &&
    aliveVisibleOpponentCount(observation) > 0 &&
    legalActions.some(isPlayerBoatAction)
  );
}

function actionIsFavorableHostileAttack(action: LegalAction): boolean {
  if (action.kind !== "attack" || action.metadata?.expansion === true) {
    return false;
  }
  if (action.risk.level === "high") {
    return false;
  }
  const relativeTroopRatio = metadataNumber(action, "relativeTroopRatio");
  const troopPercentage =
    metadataNumber(action, "troopPercentage") ||
    metadataNumber(action, "troopPercent");
  return (
    (relativeTroopRatio === 0 || relativeTroopRatio >= 1.2) &&
    (troopPercentage === 0 || troopPercentage >= 0.1)
  );
}

function actionMatchesFrontierConversionReadyAttack(input: {
  action: LegalAction;
  conversion: AgentFrontierConversionTimingAffordance | null;
  actionPlayerID: string | null;
  troopCommitment: number;
  relativeTroopRatio: number;
  targetTileShare: number;
  ownTileShare: number;
}): boolean {
  const { action, conversion } = input;
  if (
    conversion?.recommended !== true ||
    !conversion.executorReady ||
    conversion.bestExecutorReadyTargetID === null ||
    input.actionPlayerID !== conversion.bestExecutorReadyTargetID ||
    action.kind !== "attack" ||
    action.metadata?.expansion === true ||
    action.risk.level === "high"
  ) {
    return false;
  }
  const targetShareLimit =
    input.ownTileShare > 0
      ? input.ownTileShare * (input.relativeTroopRatio >= 1.9 ? 1.6 : 1.35)
      : Number.POSITIVE_INFINITY;
  if (input.targetTileShare > 0 && input.targetTileShare > targetShareLimit) {
    return false;
  }
  return (
    (input.troopCommitment > 0 &&
      input.troopCommitment <= 0.12 &&
      input.relativeTroopRatio >= 1.25) ||
    (input.troopCommitment <= 0.28 && input.relativeTroopRatio >= 1.45) ||
    (input.troopCommitment <= 0.42 && input.relativeTroopRatio >= 1.9)
  );
}

function actionMatchesFrontierFinishPressureAttack(input: {
  action: LegalAction;
  finishPressure: AgentFrontierFinishPressureAffordance | null;
  actionPlayerID: string | null;
  troopCommitment: number;
  relativeTroopRatio: number;
}): boolean {
  const { action, finishPressure } = input;
  if (
    finishPressure?.recommended !== true ||
    finishPressure.bestTargetID === null ||
    input.actionPlayerID !== finishPressure.bestTargetID ||
    action.kind !== "attack" ||
    action.metadata?.expansion === true ||
    action.risk.level === "high"
  ) {
    return false;
  }
  return (
    input.troopCommitment >= 0.18 &&
    input.troopCommitment <= 0.42 &&
    (input.relativeTroopRatio === 0 || input.relativeTroopRatio >= 1.35)
  );
}

function leaderPressureSideConquestTargetID(
  input: AgentBrainInput,
): string | null {
  const observation = input.observation;
  const ownState = observation.ownState;
  const ownID = ownState?.playerID ?? null;
  const leaderID = observation.endgame?.leaderID ?? null;
  if (
    ownState === null ||
    ownID === null ||
    leaderID === null ||
    leaderID === ownID
  ) {
    return null;
  }

  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const leaderTileShare = observation.endgame?.leaderTileShare ?? 0;
  const leader = observation.visiblePlayers.find(
    (player) => player.playerID === leaderID,
  );
  const leaderRelativeTroopRatio = leader?.relativeTroopRatio ?? 1;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  if (
    ownState.tilesOwned < 12_000 ||
    ownTroops < 250_000 ||
    ownTileShare >= 0.48 ||
    leaderTileShare < 0.3 ||
    leaderRelativeTroopRatio >= 0.9
  ) {
    return null;
  }

  const leaderLandActions = input.legalActions.filter(
    (action) =>
      actionTargetsPlayer(action, leaderID) && isHostileLandAttack(action),
  );
  if (
    leaderLandActions.length === 0 ||
    leaderLandActions.some(actionIsFavorableHostileAttack)
  ) {
    return null;
  }

  const candidates = observation.visiblePlayers
    .filter(
      (player) =>
        player.isAlive &&
        player.canAttack &&
        player.playerID !== ownID &&
        player.playerID !== leaderID &&
        !player.isAllied &&
        !player.isFriendly,
    )
    .map((player) => {
      const actions = input.legalActions.filter(
        (action) =>
          actionTargetsPlayer(action, player.playerID) &&
          isHostileLandAttack(action),
      );
      const favorableAction = actions.find((action) => {
        const commitment = committedTroopRatio(action, ownTroops);
        return actionIsFavorableHostileAttack(action) && commitment <= 0.28;
      });
      const relativeTroopRatio = player.relativeTroopRatio ?? 0;
      const tileShare = player.tileShare ?? 0;
      const isClearlyEdible =
        relativeTroopRatio >= 1.2 ||
        (tileShare > 0 && tileShare <= ownTileShare * 0.8) ||
        player.troops <= ownTroops * 0.72;
      if (favorableAction === undefined || !isClearlyEdible) {
        return null;
      }
      const score =
        (player.sharesBorder ? 36 : 0) +
        Math.min(44, Math.max(0, relativeTroopRatio - 1) * 24) +
        Math.min(28, tileShare * 120) +
        (player.incomingAttack ? 12 : 0) +
        (player.outgoingAttack ? 8 : 0);
      return { playerID: player.playerID, score };
    })
    .filter(
      (candidate): candidate is { playerID: string; score: number } =>
        candidate !== null,
    )
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.playerID ?? null;
}

function hasPlayerPressureAction(
  legalActions: readonly LegalAction[],
): boolean {
  return legalActions.some(
    (action) =>
      (action.kind === "attack" && action.metadata?.expansion !== true) ||
      action.kind === "embargo" ||
      action.kind === "embargo_all" ||
      action.kind === "target_player",
  );
}

function hasUsefulFortifyAction(legalActions: readonly LegalAction[]): boolean {
  return legalActions.some(
    (action) =>
      action.kind === "retreat" ||
      action.kind === "build" ||
      action.kind === "upgrade_structure" ||
      action.kind === "warship" ||
      action.kind === "move_warship",
  );
}

function isNeutralRetreatAction(action: LegalAction): boolean {
  return (
    action.kind === "retreat" &&
    (action.metadata?.targetID === null ||
      metadataString(action, "targetName") === "Terra Nullius")
  );
}

function primaryPolicyModule(
  policy: FrontierPolicyScore,
  action: LegalAction,
): FrontierPolicyModule {
  return policy.contributions[0]?.module ?? moduleForAction(action);
}

function schedulerSlotForAction(
  action: LegalAction,
  primaryModule: FrontierPolicyModule,
): FrontierSchedulerSlot {
  if (action.kind === "spawn") {
    return "spawn_opening";
  }
  if (isNeutralRetreatAction(action)) {
    return "utility_social";
  }
  if (action.kind === "retreat" || action.kind === "boat_retreat") {
    return "emergency_survival";
  }
  if (action.kind === "attack" && action.metadata?.expansion === true) {
    return "neutral_expansion";
  }
  if (isNeutralBoatAction(action)) {
    return "neutral_expansion";
  }
  if (action.kind === "attack") {
    return "combat_attack";
  }
  if (
    action.kind === "embargo" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player" ||
    action.kind === "break_alliance" ||
    action.kind === "alliance_reject"
  ) {
    return "combat_pressure";
  }
  if (
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "donate_gold" ||
    action.kind === "donate_troops" ||
    action.kind === "embargo_stop"
  ) {
    return "diplomacy";
  }
  if (isSocialFlavorAction(action)) {
    return "utility_social";
  }
  if (
    action.kind === "warship" ||
    action.kind === "move_warship" ||
    action.kind === "boat"
  ) {
    return "naval";
  }
  if (
    action.kind === "nuke" ||
    (action.kind === "build" &&
      (metadataString(action, "unit") === UnitType.SAMLauncher ||
        metadataString(action, "unit") === UnitType.MissileSilo))
  ) {
    return "nuclear_endgame";
  }
  if (
    (action.kind === "build" || action.kind === "upgrade_structure") &&
    isDefensiveAction(action)
  ) {
    return "defensive_structure";
  }
  if (
    (action.kind === "build" || action.kind === "upgrade_structure") &&
    isEconomicUnit(metadataString(action, "unit"))
  ) {
    return "economic_structure";
  }
  if (action.kind === "delete_unit") {
    return "utility_social";
  }
  return moduleToSchedulerSlot(primaryModule);
}

function moduleForAction(action: LegalAction): FrontierPolicyModule {
  if (action.kind === "spawn") {
    return "spawn_opening";
  }
  if (isNeutralRetreatAction(action)) {
    return "utility_social";
  }
  if (action.kind === "retreat" || action.kind === "boat_retreat") {
    return "emergency_survival";
  }
  if (
    (action.kind === "attack" && action.metadata?.expansion === true) ||
    isNeutralBoatAction(action)
  ) {
    return "expansion";
  }
  if (
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "alliance_reject" ||
    action.kind === "donate_gold" ||
    action.kind === "donate_troops" ||
    action.kind === "embargo_stop" ||
    action.kind === "quick_chat" ||
    action.kind === "emoji"
  ) {
    return "diplomacy";
  }
  if (
    action.kind === "warship" ||
    action.kind === "move_warship" ||
    action.kind === "boat"
  ) {
    return "naval";
  }
  if (
    action.kind === "nuke" ||
    (action.kind === "build" &&
      (metadataString(action, "unit") === UnitType.SAMLauncher ||
        metadataString(action, "unit") === UnitType.MissileSilo))
  ) {
    return "nuclear_endgame";
  }
  if (isDefensiveAction(action)) {
    return "defense";
  }
  if (
    (action.kind === "build" || action.kind === "upgrade_structure") &&
    isEconomicUnit(metadataString(action, "unit"))
  ) {
    return "economy";
  }
  if (
    action.kind === "attack" ||
    action.kind === "embargo" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player" ||
    action.kind === "break_alliance"
  ) {
    return "combat";
  }
  return "utility_social";
}

function moduleToSchedulerSlot(
  module: FrontierPolicyModule,
): FrontierSchedulerSlot {
  switch (module) {
    case "emergency_survival":
      return "emergency_survival";
    case "spawn_opening":
      return "spawn_opening";
    case "expansion":
      return "neutral_expansion";
    case "defense":
      return "defensive_structure";
    case "economy":
      return "economic_structure";
    case "diplomacy":
      return "diplomacy";
    case "combat":
      return "combat_attack";
    case "naval":
      return "naval";
    case "nuclear_endgame":
      return "nuclear_endgame";
    case "utility_social":
      return "utility_social";
  }
}

function enabledModulesForPlan(plan: StrategicPlan): FrontierPolicyModule[] {
  return modulesForObjectiveAndKinds(plan.objective, plan.preferredActionKinds);
}

function modulesForObjectiveAndKinds(
  objective: AgentObjectiveKind,
  actionKinds: readonly LegalActionKind[],
): FrontierPolicyModule[] {
  const modules = new Set<FrontierPolicyModule>();
  for (const kind of actionKinds) {
    modules.add(moduleForActionKind(kind));
    if (kind === "build" || kind === "upgrade_structure") {
      modules.add("defense");
      modules.add("nuclear_endgame");
    }
  }
  modules.add(moduleForObjective(objective));
  modules.add("emergency_survival");
  modules.add("utility_social");
  return [...frontierSchedulerOrder]
    .map((slot) => schedulerSlotModules[slot])
    .filter(
      (module, index, ordered) =>
        modules.has(module) && ordered.indexOf(module) === index,
    );
}

function moduleForObjective(
  objective: AgentObjectiveKind,
): FrontierPolicyModule {
  switch (objective) {
    case "choose_spawn":
      return "spawn_opening";
    case "expand_territory":
      return "expansion";
    case "secure_economy":
      return "economy";
    case "fortify_border":
      return "defense";
    case "pressure_rival":
      return "combat";
    case "build_alliance":
      return "diplomacy";
    case "survive":
      return "emergency_survival";
  }
}

function moduleForActionKind(kind: LegalActionKind): FrontierPolicyModule {
  switch (kind) {
    case "spawn":
      return "spawn_opening";
    case "attack":
    case "target_player":
    case "break_alliance":
    case "embargo":
    case "embargo_all":
    case "alliance_reject":
      return "combat";
    case "retreat":
    case "boat_retreat":
      return "emergency_survival";
    case "boat":
    case "warship":
    case "move_warship":
      return "naval";
    case "alliance_request":
    case "alliance_extend":
    case "donate_gold":
    case "donate_troops":
    case "embargo_stop":
    case "quick_chat":
    case "emoji":
      return "diplomacy";
    case "build":
    case "upgrade_structure":
      return "economy";
    case "nuke":
      return "nuclear_endgame";
    case "delete_unit":
    case "hold":
      return "utility_social";
  }
}

function scoreFrontierAction(input: {
  input: AgentBrainInput;
  plan: StrategicPlan;
  action: LegalAction;
  settings: AgentSettings;
  profile: AgentStrategyProfile;
}): FrontierPolicyScore {
  const { action, settings, profile } = input;
  const observation = input.input.observation;
  const contributions: FrontierPolicyContribution[] = [];
  const penalties: string[] = [];
  let penaltyScore = 0;
  let profileRepairRerank: AgentProfileRepairRerankScore | null = null;
  const ownTroops =
    observation.ownState?.troops ?? observation.combat.ownTroops ?? 0;
  const troopRatio =
    observation.combat.troopRatio ?? observation.ownState?.troopRatio ?? 0;
  const incomingCount =
    observation.combat.incomingAttackPlayerIDs.length +
    (observation.combat.incomingAttacks?.length ?? 0);
  const activeTransportCount =
    observation.nonCombat.boatRetreatOptions?.length ?? 0;
  const incomingAttackPlayerIDs = new Set(
    observation.combat.incomingAttackPlayerIDs.filter((id) => id !== null),
  );
  const outgoingWarPlayerIDs = new Set(
    observation.combat.outgoingAttackPlayerIDs.filter((id) => id !== null),
  );
  const outgoingWars = outgoingWarPlayerIDs.size;
  const targetID = metadataString(action, "targetID") ?? null;
  const recipientID = metadataString(action, "recipientID") ?? null;
  const actionPlayerID = targetID ?? recipientID;
  const isNeutralRetreat = isNeutralRetreatAction(action);
  const target =
    actionPlayerID === null
      ? null
      : (observation.visiblePlayers.find(
          (player) => player.playerID === actionPlayerID,
        ) ?? null);
  const communicationSignal = communicationSignalForAction(action, observation);
  const targetIsLeader =
    actionPlayerID !== null && observation.endgame?.leaderID === actionPlayerID;
  const ownIsLeader =
    observation.ownState !== null &&
    observation.endgame?.leaderID === observation.ownState.playerID;
  const finishMode = isOneVsOneFinishMode(observation);
  const duelMode = isOneVsOneDuelMode(observation);
  const dominantConversionMode = isDominantConversionMode(observation);
  const favorableHostileAttackAvailable = input.input.legalActions.some(
    actionIsFavorableHostileAttack,
  );
  const leaderID = observation.endgame?.leaderID ?? null;
  const favorableNonLeaderHostileAttackAvailable =
    input.input.legalActions.some((candidate) => {
      const candidateTargetID = metadataString(candidate, "targetID");
      return (
        candidate.kind === "attack" &&
        candidate.metadata?.expansion !== true &&
        candidateTargetID !== null &&
        candidateTargetID !== leaderID &&
        actionIsFavorableHostileAttack(candidate)
      );
    });
  const navalConversionMode = isNavalConversionMode(
    observation,
    input.input.legalActions,
  );
  const leaderPressure =
    !ownIsLeader && (observation.endgame?.leaderTileShare ?? 0) >= 0.3;
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const ownTiles = observation.ownState?.tilesOwned ?? 0;
  const troopCommitment = committedTroopRatio(action, ownTroops);
  const tacticalAffordances = buildAgentTacticalAffordances({
    observation,
    legalActions: input.input.legalActions,
  });
  const openingExpansionTempo =
    tacticalAffordances.openingExpansionTempo ?? null;
  const frontierConversionTiming =
    tacticalAffordances.frontierConversionTiming ?? null;
  const frontierFinishPressure =
    tacticalAffordances.frontierFinishPressure ?? null;
  const personalityDiplomacyPressure =
    tacticalAffordances.personalityDiplomacyPressure ?? null;
  const transportTroopBanking = tacticalAffordances.transportTroopBanking;
  const openingExpansionTempoAction =
    settings.openingExpansionTempoEnabled &&
    openingExpansionTempo?.recommended === true &&
    isNeutralGrowthAction(action);
  const transportTroopBankingAction =
    settings.transportTroopBankingEnabled &&
    action.kind === "boat" &&
    transportTroopBanking.recommended;
  const personalityDiplomacyPressureAction =
    settings.personalityDiplomacyPressureEnabled &&
    personalityDiplomacyPressure?.recommended === true &&
    (action.id === personalityDiplomacyPressure.bestSocialActionID ||
      (actionPlayerID !== null &&
        actionPlayerID === personalityDiplomacyPressure.bestSocialTargetID &&
        (isPressureOnlySignalAction(action) ||
          isFriendlyDiplomacyAction(action) ||
          isSocialFlavorAction(action))));
  const leavesReserve =
    action.kind !== "attack" && action.kind !== "boat"
      ? true
      : troopRatio - troopCommitment >= settings.reserveRatio * 0.5 ||
        troopCommitment <= settings.expansionRatio + 0.05;
  const neutralGrowthAvailable = input.input.legalActions.some(
    isNeutralGrowthAction,
  );
  const hostileBorderActionAvailable = input.input.legalActions.some(
    (candidate) =>
      candidate.kind === "attack" && candidate.metadata?.expansion !== true,
  );
  const strongerAttackableThreat = observation.visiblePlayers.some(
    (player) =>
      player.canAttack &&
      player.isAlive &&
      !player.isAllied &&
      !player.isFriendly &&
      ((player.relativeTroopRatio ?? 1) < 0.95 ||
        player.troops > ownTroops * 1.12),
  );
  const criticalBorderCollapse =
    strongerAttackableThreat &&
    (((observation.strategic.priority === "build_defense" ||
      observation.strategic.priority === "attack") &&
      observation.strategic.urgency === "high" &&
      ownTiles < 12_000) ||
      ownTiles < 5_000);
  const landExpansionAvailable = input.input.legalActions.some(
    (candidate) =>
      candidate.kind === "attack" && candidate.metadata?.expansion === true,
  );
  const earlyNeutralExpansion =
    neutralGrowthAvailable &&
    incomingCount === 0 &&
    !leaderPressure &&
    (ownTileShare === 0 ||
      ownTileShare < 0.24 ||
      observation.combat.attackablePlayerIDs.length === 0);
  const executorReadyWeakRivalPressure =
    ((frontierFinishPressure?.recommended === true &&
      (frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0) ||
      (frontierConversionTiming?.recommended === true &&
        frontierConversionTiming.executorReady === true)) &&
    (frontierFinishPressure?.homeDanger ??
      frontierConversionTiming?.homeDanger ??
      "low") !== "high";
  const safeEconomyHandoffAvailable =
    observation.memory.recentExpansionCount >= 2 &&
    observation.memory.recentBuildCount === 0 &&
    hasEconomicBuildAction(input.input.legalActions);
  const repeatedNeutralHandoffReady =
    observation.memory.recentExpansionCount >= 2 &&
    !earlyNeutralExpansion &&
    openingExpansionTempo?.recommended !== true &&
    (safeEconomyHandoffAvailable || executorReadyWeakRivalPressure);
  const shouldDiversifyExpansion =
    repeatedNeutralHandoffReady ||
    (observation.memory.recentExpansionCount >= 3 &&
      !earlyNeutralExpansion &&
      input.input.legalActions.some(isExpansionDiversifierAction));
  const borderedPressureExpansionStale =
    hostileBorderActionAvailable &&
    observation.memory.recentExpansionCount >= 2 &&
    (input.plan.objective === "pressure_rival" || !earlyNeutralExpansion) &&
    observation.strategic.priority !== "expand" &&
    (observation.combat.attackablePlayerIDs.length > 0 ||
      observation.combat.borderedPlayerIDs.length > 0) &&
    ownTiles >= 8_000;
  const forcedCrowdedOpeningExpansion =
    shouldForceCrowdedNationOpeningExpansion(input.input);
  const hardNationScrum = isHardNationScrum(observation);
  const hardNationStrategicContext = isHardNationStrategicContext(observation);
  const hardNationEconomyAvailable =
    hardNationScrum &&
    ownTiles >= 8_000 &&
    observation.memory.recentBuildCount === 0 &&
    hasEconomicBuildAction(input.input.legalActions);
  const hardNationFlankTransport =
    isNeutralBoatAction(action) &&
    hardNationScrum &&
    leaderPressure &&
    !finishMode &&
    !dominantConversionMode &&
    activeTransportCount === 0 &&
    ownTiles >= 16_000 &&
    ownTroops >= 450_000 &&
    !landExpansionAvailable &&
    !favorableNonLeaderHostileAttackAvailable &&
    observation.combat.attackablePlayerIDs.length > 0;
  const hardNationCollapsingEscapeTransport =
    hardNationOpponentCount(observation) >= 1 &&
    !finishMode &&
    !dominantConversionMode &&
    activeTransportCount === 0 &&
    ownTiles >= 5_000 &&
    !landExpansionAvailable &&
    !recentAcceptedActionKind(observation, "boat", 4) &&
    observation.combat.attackablePlayerIDs.length > 0 &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    ownTiles < 20_000 &&
    ownTroops >= 280_000 &&
    recentOwnTileLossRatio(observation, ownTiles) >= 0.25;
  const hardNationBoxedEscapeTransport =
    action.kind === "boat" &&
    hardNationOpponentCount(observation) >= 1 &&
    !finishMode &&
    !dominantConversionMode &&
    activeTransportCount === 0 &&
    ownTiles >= 5_000 &&
    !landExpansionAvailable &&
    !recentAcceptedActionKind(observation, "boat", 4) &&
    observation.combat.attackablePlayerIDs.length > 0 &&
    (hardNationCollapsingEscapeTransport ||
      (ownTiles < 12_000 &&
        ownTroops >= 380_000 &&
        (observation.memory.recentHoldCount ?? 0) >= 3));
  const hardNationSideInvasionTransport =
    action.kind === "boat" &&
    typeof action.metadata?.targetID === "string" &&
    hardNationScrum &&
    leaderPressure &&
    target !== null &&
    targetID !== null &&
    !targetIsLeader &&
    !targetHasLandContact(observation, targetID) &&
    !target.isAllied &&
    !target.isFriendly &&
    !finishMode &&
    !dominantConversionMode &&
    activeTransportCount === 0 &&
    ownTiles >= 16_000 &&
    ownTroops >= 520_000 &&
    target.troops <= ownTroops * 1.2 &&
    !favorableNonLeaderHostileAttackAvailable &&
    observation.combat.attackablePlayerIDs.length > 0;
  const humanReplayOpeningBoatTempo =
    isNeutralBoatAction(action) &&
    observation.turnNumber >= 600 &&
    observation.turnNumber <= 3_000 &&
    observation.memory.recentExpansionCount >= 2 &&
    activeTransportCount === 0 &&
    incomingCount === 0 &&
    !recentAcceptedActionKind(observation, "boat", 4) &&
    !leaderPressure &&
    ownTroops >= 80_000 &&
    troopRatio >= 0.38;

  const add = (module: FrontierPolicyModule, score: number, reason: string) => {
    if (score === 0) {
      return;
    }
    contributions.push({
      module,
      score: score * moduleWeight(settings, profile, module),
      reason,
    });
  };
  const penalize = (score: number, reason: string) => {
    if (score <= 0) {
      return;
    }
    penaltyScore += score;
    penalties.push(reason);
  };

  if (settings.profileRepairReRankEnabled) {
    const repairScore = scoreProfileRepairRerankAction({
      profile,
      observation,
      legalActions: input.input.legalActions,
      action,
    });
    if (repairScore !== null) {
      profileRepairRerank = repairScore;
      add(repairScore.module, repairScore.score, repairScore.reason);
      penalize(
        repairScore.penaltyScore ?? 0,
        repairScore.penaltyReason ?? "",
      );
    }
  }

  if (communicationSignal !== null) {
    if (communicationSignal.intent === "coordinate_attack") {
      add(
        action.kind === "attack" ? "combat" : "diplomacy",
        action.kind === "attack"
          ? 92
          : action.kind === "target_player"
            ? 76
            : action.kind === "quick_chat"
              ? 44
              : 34,
        `${communicationSignal.senderName} called a focus target`,
      );
    }
    if (
      communicationSignal.intent === "request_support" ||
      communicationSignal.intent === "propose_alliance"
    ) {
      add(
        "diplomacy",
        action.kind === "alliance_request" || action.kind === "alliance_extend"
          ? 96
          : action.kind === "donate_gold" || action.kind === "donate_troops"
            ? 70
            : 34,
        `${communicationSignal.senderName} requested cooperation`,
      );
    }
    if (communicationSignal.intent === "warn_threat") {
      add(
        "defense",
        action.kind === "retreat" || action.kind === "boat_retreat" ? 72 : 38,
        `${communicationSignal.senderName} warned about a threat`,
      );
    }
  }
  if (
    agentOnlyPoliticalMatch(observation) &&
    action.kind === "alliance_request"
  ) {
    const targetTileShare = target?.tileShare ?? 0;
    add(
      "diplomacy",
      target?.hasIncomingAllianceRequest === true
        ? 190
        : targetTileShare >= 0.12
          ? 152
          : 126,
      "agent-only political theatre forms temporary pacts before the betrayal window",
    );
  }

  const reservePressure =
    troopRatio < settings.retreatThreshold * 0.65 &&
    !isNeutralRetreat &&
    !finishMode;
  const existingWarTarget =
    targetID !== null && outgoingWarPlayerIDs.has(targetID);
  const incomingAttackTarget =
    targetID !== null && incomingAttackPlayerIDs.has(targetID);
  const activeCombatTarget = existingWarTarget || incomingAttackTarget;
  const recentHostileAttacksAgainstTarget =
    actionPlayerID === null
      ? 0
      : observation.memory.recentActions.filter(
          (decision) =>
            decision.accepted &&
            decision.actionKind === "attack" &&
            decision.expansion !== true &&
            decision.targetID === actionPlayerID,
        ).length;
  const recentBreakAllianceTargetID = recentAcceptedTargetID(
    observation,
    ["break_alliance"],
    8,
  );
  const recentUntargetedBreakAlliance =
    recentBreakAllianceTargetID === null &&
    recentAcceptedActionKind(observation, "break_alliance", 3);
  const inferredBreakFrontTargetID = recentUntargetedBreakAlliance
    ? weakFrontierAttackTargetID(input.input)
    : null;
  const recentOpenedFrontTargetID =
    recentBreakAllianceTargetID ?? inferredBreakFrontTargetID;
  const recentCombatFocusTargetID = recentCombatTargetID(input.input);
  const followsRecentBreakTarget =
    recentOpenedFrontTargetID !== null &&
    actionPlayerID === recentOpenedFrontTargetID;
  const switchesOffRecentBreakTarget =
    recentOpenedFrontTargetID !== null &&
    actionPlayerID !== null &&
    actionPlayerID !== recentOpenedFrontTargetID;
  const stickyRecentCombatTarget = recentHostileAttacksAgainstTarget >= 2;
  const leaderPressureAttackOverridesFocus =
    targetIsLeader &&
    leaderPressure &&
    ownTiles >= 20_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.28;
  const actionRelativeTroopRatio = metadataNumber(action, "relativeTroopRatio");
  const relativeTroopRatio =
    actionRelativeTroopRatio > 0
      ? actionRelativeTroopRatio
      : (target?.relativeTroopRatio ?? 0);
  const targetTileShare =
    metadataNumber(action, "targetTileShare") || target?.tileShare || 0;
  const targetTiles =
    metadataNumber(action, "targetTiles") || target?.tilesOwned || 0;
  const frontierConversionReadyAttack =
    actionMatchesFrontierConversionReadyAttack({
      action,
      conversion: frontierConversionTiming,
      actionPlayerID,
      troopCommitment,
      relativeTroopRatio,
      targetTileShare,
      ownTileShare,
    });
  const frontierFinishPressureAttack =
    actionMatchesFrontierFinishPressureAttack({
      action,
      finishPressure: frontierFinishPressure,
      actionPlayerID,
      troopCommitment,
      relativeTroopRatio,
    });
  const largestVisibleRival =
    observation.visiblePlayers
      .filter(
        (player) =>
          player.isAlive &&
          player.playerID !== observation.ownState?.playerID &&
          !player.isAllied &&
          !player.isFriendly,
      )
      .sort((a, b) => b.tilesOwned - a.tilesOwned)[0] ?? null;
  const hardNationStalledNeutralTransport =
    hardNationOpponentCount(observation) >= 1 &&
    isNeutralBoatAction(action) &&
    activeTransportCount === 0 &&
    ownTiles >= 4_500 &&
    ownTiles < 9_000 &&
    observation.memory.recentExpansionCount >= 4 &&
    largestVisibleRival !== null &&
    largestVisibleRival.tilesOwned >= ownTiles * 2 &&
    landExpansionAvailable;
  const hardNationStalledNeutralExpansion =
    hardNationOpponentCount(observation) >= 1 &&
    action.kind === "attack" &&
    action.metadata?.expansion === true &&
    activeTransportCount <= 2 &&
    ownTiles >= 4_500 &&
    ownTiles < 9_000 &&
    observation.memory.recentExpansionCount >= 4 &&
    largestVisibleRival !== null &&
    largestVisibleRival.tilesOwned >= ownTiles * 2 &&
    input.input.legalActions.some((candidate) =>
      isNeutralBoatAction(candidate),
    );
  const hardNationNoGrowthNeutralExpansion =
    hardNationOpponentCount(observation) >= 1 &&
    action.kind === "attack" &&
    action.metadata?.expansion === true &&
    ownTiles >= 4_500 &&
    ownTiles < 10_000 &&
    observation.combat.attackablePlayerIDs.length > 0 &&
    recentNeutralExpansionMadeNoProgress(observation, ownTiles);
  const strongestOtherOpponentTroops =
    target === null
      ? 0
      : Math.max(
          0,
          ...observation.visiblePlayers
            .filter(
              (player) =>
                player.isAlive &&
                player.playerID !== target.playerID &&
                player.playerID !== observation.ownState?.playerID,
            )
            .map((player) => player.troops),
        );
  const hardNationLeaderAllianceBreak =
    action.kind === "break_alliance" &&
    hardNationScrum &&
    targetIsLeader &&
    !ownIsLeader &&
    (aliveVisibleOpponentCount(observation) <= 2 ||
      actionPlayerID === input.plan.targetPlayerId ||
      (targetTileShare > 0 && ownTileShare >= targetTileShare * 0.82) ||
      (targetTiles > 0 && ownTiles >= targetTiles * 0.82)) &&
    !hasMapProgressLegalAction(input.input.legalActions) &&
    activeTransportCount === 0 &&
    incomingCount === 0 &&
    ownTiles >= 20_000 &&
    ownTileShare >= 0.22 &&
    ownTileShare < 0.42 &&
    ownTroops >= 1_500_000 &&
    target !== null &&
    !target.incomingAttack &&
    target.troops >= strongestOtherOpponentTroops * 1.2 &&
    targetTiles >= Math.max(24_000, ownTiles * 0.95) &&
    targetTiles <= ownTiles + 7_000 &&
    relativeTroopRatio >= 1.25;
  const hardNationChallengerAllianceBreak =
    action.kind === "break_alliance" &&
    hardNationScrum &&
    !targetIsLeader &&
    !ownIsLeader &&
    !hasMapProgressLegalAction(input.input.legalActions) &&
    activeTransportCount === 0 &&
    incomingCount === 0 &&
    ownTiles >= 20_000 &&
    ownTileShare >= 0.22 &&
    ownTileShare < 0.38 &&
    ownTroops >= 1_500_000 &&
    target !== null &&
    target.troops >= strongestOtherOpponentTroops * 0.95 &&
    (observation.endgame?.leaderTileShare ?? 0) <= 0.36 &&
    targetTiles >= Math.max(28_000, ownTiles * 1.04) &&
    targetTiles <= ownTiles + 7_000 &&
    relativeTroopRatio >= 1.15;
  const hardNationWeakFrontierAllianceBreak =
    action.kind === "break_alliance" &&
    hardNationScrum &&
    !targetIsLeader &&
    !ownIsLeader &&
    !hasMapProgressLegalAction(input.input.legalActions) &&
    activeTransportCount === 0 &&
    incomingCount === 0 &&
    ownTiles >= 20_000 &&
    ownTileShare >= 0.22 &&
    ownTileShare < 0.36 &&
    ownTroops >= 1_300_000 &&
    target !== null &&
    target.sharesBorder &&
    (observation.endgame?.leaderTileShare ?? 0) <= 0.38 &&
    targetTileShare > 0.06 &&
    targetTileShare <= Math.min(0.18, ownTileShare * 0.7) &&
    targetTiles >= 8_000 &&
    targetTiles <= ownTiles * 0.72 &&
    target.troops <= ownTroops * 0.62 &&
    target.troops <= strongestOtherOpponentTroops * 0.9 &&
    relativeTroopRatio >= 1.55;
  const hardNationDominantAllianceBreak =
    action.kind === "break_alliance" &&
    hardNationScrum &&
    !hasMapProgressLegalAction(input.input.legalActions) &&
    activeTransportCount === 0 &&
    incomingCount === 0 &&
    ownTiles >= 60_000 &&
    ownTileShare >= 0.42 &&
    ownTroops >= 1_200_000 &&
    target !== null &&
    targetTiles >= 10_000 &&
    targetTiles <= ownTiles * 1.2 &&
    targetTileShare >= 0.1 &&
    target.troops >= ownTroops * 0.35 &&
    (targetIsLeader ||
      target.troops >= strongestOtherOpponentTroops * 0.95 ||
      targetTileShare >= 0.18);
  const hardNationBufferSupportTarget = hardNationBufferSupportTargetID(
    input.input,
  );
  const weakFrontierConquestTargetID = hardNationScrum
    ? weakFrontierAttackTargetID(input.input)
    : null;
  const hardNationConquestDiplomacyTarget =
    (action.kind === "alliance_request" || action.kind === "alliance_extend") &&
    hardNationScrum &&
    target !== null &&
    !targetIsLeader &&
    ownTiles >= 12_000 &&
    ownTroops >= 450_000 &&
    (target.canAttack || target.sharesBorder) &&
    (targetTiles === 0 || targetTiles <= ownTiles * 0.86) &&
    target.troops <= ownTroops * 0.86 &&
    (relativeTroopRatio === 0 || relativeTroopRatio >= 1.05);
  const hardNationSideConquestDiplomacyTarget =
    (action.kind === "alliance_request" || action.kind === "alliance_extend") &&
    hardNationScrum &&
    leaderPressure &&
    target !== null &&
    !targetIsLeader &&
    ownTiles >= 16_000 &&
    ownTroops >= 450_000 &&
    targetTiles > 0 &&
    targetTiles <= ownTiles * 1.05 &&
    target.troops <= ownTroops * 1.15 &&
    (relativeTroopRatio === 0 || relativeTroopRatio >= 0.8);
  const hardNationRunawayLeaderAlliance =
    (action.kind === "alliance_request" || action.kind === "alliance_extend") &&
    hardNationScrum &&
    targetIsLeader &&
    leaderPressure &&
    target !== null &&
    ownTiles >= 12_000 &&
    ownTileShare < 0.5 &&
    livingRivalCount(observation) > 1 &&
    (targetTileShare >= Math.max(0.34, ownTileShare * 1.05) ||
      target.troops >= ownTroops * 1.12);
  const hardNationBufferSupport =
    (action.kind === "donate_gold" || action.kind === "donate_troops") &&
    hardNationBufferSupportTarget !== null &&
    actionPlayerID === hardNationBufferSupportTarget;
  const recentConquestDiplomacyTarget =
    actionPlayerID !== null &&
    (actionPlayerID === recentOpenedFrontTargetID ||
      actionPlayerID === recentCombatFocusTargetID ||
      outgoingWarPlayerIDs.has(actionPlayerID));
  const recentHardNationBreakTargetID = recentAcceptedTargetID(
    observation,
    ["break_alliance"],
    32,
  );
  const recentHardNationWarTargetAlliance =
    (action.kind === "alliance_request" || action.kind === "alliance_extend") &&
    hardNationOpponentCount(observation) >= 1 &&
    input.plan.objective !== "build_alliance" &&
    actionPlayerID !== null &&
    ownTiles >= 24_000 &&
    (actionPlayerID === recentHardNationBreakTargetID ||
      recentAcceptedMediumAttackCount(observation, actionPlayerID, 18) >= 2);
  const stickyWinningFront =
    stickyRecentCombatTarget &&
    relativeTroopRatio >= 1.2 &&
    ownTiles >= 24_000 &&
    !criticalBorderCollapse;
  const finishableRivalAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    !targetIsLeader &&
    relativeTroopRatio >= 1.35 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.28 &&
    ownTiles >= 8_000 &&
    (activeCombatTarget || recentHostileAttacksAgainstTarget >= 1) &&
    (targetTileShare === 0 || targetTileShare <= 0.3);
  const decisiveFinishableRivalAttack =
    finishableRivalAttack &&
    targetTileShare <= 0.08 &&
    (relativeTroopRatio === 0 || relativeTroopRatio >= 2.5) &&
    troopCommitment <= 0.28;
  const unsafeMediumCounterattackAgainstLargerRival =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    !targetIsLeader &&
    activeCombatTarget &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.3 &&
    relativeTroopRatio > 0 &&
    relativeTroopRatio < 1.35 &&
    targetTileShare >= 0.2 &&
    ownTiles < 32_000 &&
    !criticalBorderCollapse;
  const unsafeLargeCounterattackAgainstLargerRival =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    !targetIsLeader &&
    activeCombatTarget &&
    troopCommitment >= 0.35 &&
    relativeTroopRatio > 0 &&
    relativeTroopRatio < 2.2 &&
    targetTileShare >= 0.2 &&
    ownTiles < 36_000 &&
    !finishMode &&
    !dominantConversionMode &&
    !criticalBorderCollapse;
  const leaderBreakthroughAttack =
    targetIsLeader &&
    leaderPressure &&
    relativeTroopRatio >= 1.55 &&
    troopCommitment >= 0.35 &&
    troopCommitment <= 0.42 &&
    ownTiles >= 28_000 &&
    ownTroops >= 700_000 &&
    targetTileShare >= 0.3 &&
    targetTileShare <= 0.58;
  const urgentDefenseLeaderEdge =
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high"
      ? 2.2
      : 1.4;
  const leaderContainmentStrike =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    targetIsLeader &&
    leaderPressure &&
    targetTileShare >= 0.58 &&
    ownTiles >= 24_000 &&
    ownTroops >= 850_000 &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.28 &&
    ((targetTileShare >= 0.65 && relativeTroopRatio >= 1.05) ||
      relativeTroopRatio >= 1.18) &&
    (incomingAttackTarget ||
      targetTileShare >= 0.62 ||
      targetTileShare >= 0.68 ||
      observation.strategic.priority === "build_defense");
  const incomingLeaderDefensiveCounterattack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    targetIsLeader &&
    incomingAttackTarget &&
    leaderPressure &&
    ownTiles >= 18_000 &&
    ownTroops >= 700_000 &&
    target !== null &&
    targetTileShare >= 0.38 &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.42 &&
    relativeTroopRatio >= 1.05 &&
    target.troops <= ownTroops * 1.05 &&
    !finishMode &&
    !dominantConversionMode;
  const hardNationLeaderAttackWaveContinuation =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    targetIsLeader &&
    leaderPressure &&
    targetTileShare >= 0.3 &&
    ownTiles >= 35_000 &&
    ownTroops >= 900_000 &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.28 &&
    relativeTroopRatio >=
      (targetTileShare >= 0.5 && ownTileShare >= 0.4 ? 1.12 : 1.25) &&
    !finishMode &&
    !dominantConversionMode &&
    !criticalBorderCollapse;
  const durableLeaderMediumTrade =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    targetIsLeader &&
    leaderPressure &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.3 &&
    targetTileShare >= 0.34 &&
    relativeTroopRatio > 0 &&
    relativeTroopRatio < urgentDefenseLeaderEdge &&
    !finishMode &&
    !dominantConversionMode &&
    !criticalBorderCollapse &&
    !incomingLeaderDefensiveCounterattack &&
    !leaderContainmentStrike &&
    !hardNationLeaderAttackWaveContinuation &&
    !leaderBreakthroughAttack;
  const leaderPressureNeedsGrowth =
    (targetTileShare >= 0.4 &&
      (relativeTroopRatio === 0 || relativeTroopRatio < 2.4)) ||
    (targetTileShare >= 0.35 &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1.4);
  const repeatedIncomingLeaderProbeWithoutEdge =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    targetIsLeader &&
    incomingAttackTarget &&
    ownTileShare < 0.35 &&
    targetTileShare >= 0.5 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    relativeTroopRatio > 0 &&
    relativeTroopRatio < 0.95 &&
    recentHostileAttacksAgainstTarget >= 3 &&
    !finishMode &&
    !dominantConversionMode &&
    !criticalBorderCollapse;
  const incomingLeaderDefensiveProbe =
    targetIsLeader &&
    incomingAttackTarget &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    ownTiles >= 20_000 &&
    relativeTroopRatio >= 1.05;
  const endgameLeaderPressureProbe =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    targetIsLeader &&
    targetTileShare >= 0.52 &&
    ownTileShare >= 0.22 &&
    ownTiles >= 24_000 &&
    ownTroops >= 700_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    relativeTroopRatio >= 0.95 &&
    livingRivalCount(observation) <= 2;
  const hardNationRunawayLeaderProbe =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationOpponentCount(observation) >= 1 &&
    targetIsLeader &&
    leaderPressure &&
    targetTileShare >= 0.5 &&
    ownTiles >= 12_000 &&
    ownTileShare > 0 &&
    ownTileShare < 0.5 &&
    ownTroops >= 400_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    !finishMode &&
    !dominantConversionMode &&
    (relativeTroopRatio >= 0.45 || targetTileShare >= 0.6);
  const largeBaseHardNationLeaderProbe =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    targetIsLeader &&
    leaderPressure &&
    targetTileShare >= 0.5 &&
    ownTiles >= 40_000 &&
    ownTroops >= 850_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    !finishMode &&
    !dominantConversionMode &&
    (relativeTroopRatio >= 0.55 || targetTileShare >= 0.62);
  const dominantHardNationLargestRivalAttack = false;
  const leaderContainmentProbe =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    targetIsLeader &&
    leaderPressure &&
    targetTileShare >= 0.38 &&
    ownTiles >= 10_000 &&
    ownTroops >= 500_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    (relativeTroopRatio >= 0.95 ||
      relativeTroopRatio >= 0.8 ||
      (targetTileShare >= 0.38 &&
        ownTileShare >= 0.32 &&
        ownTiles >= 30_000 &&
        ownTroops >= 850_000 &&
        relativeTroopRatio >= 0.95) ||
      (targetTileShare >= 0.68 && relativeTroopRatio >= 0.65) ||
      (targetTileShare >= 0.7 && relativeTroopRatio >= 0.55)) &&
    (incomingAttackTarget ||
      existingWarTarget ||
      recentHostileAttacksAgainstTarget >= 1 ||
      (targetTileShare >= 0.38 &&
        ownTileShare >= 0.32 &&
        ownTiles >= 30_000 &&
        ownTroops >= 850_000) ||
      (targetTileShare >= 0.58 && ownTiles >= 25_000 && ownTroops >= 850_000) ||
      observation.strategic.priority === "build_defense");
  const overlargeLeaderNeedsUrgentGrowth =
    (observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency === "high") ||
    (targetTileShare >= 0.45 &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1 &&
      !incomingAttackTarget);
  const overlargeLeaderPressure =
    isHostilePressureAction(action) &&
    targetIsLeader &&
    overlargeLeaderNeedsUrgentGrowth &&
    ownTileShare < 0.38 &&
    leaderPressureNeedsGrowth &&
    !finishMode &&
    !dominantConversionMode &&
    !incomingLeaderDefensiveProbe &&
    !endgameLeaderPressureProbe &&
    !largeBaseHardNationLeaderProbe &&
    !leaderContainmentProbe &&
    !leaderContainmentStrike &&
    !criticalBorderCollapse;
  const hardNationOvermatchedLeaderAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    targetIsLeader &&
    leaderPressure &&
    target !== null &&
    ownTileShare < 0.48 &&
    targetTileShare >= Math.max(0.32, ownTileShare * 0.95) &&
    target.troops >= ownTroops * 1.05 &&
    (relativeTroopRatio === 0 || relativeTroopRatio < 1.15) &&
    !incomingLeaderDefensiveProbe &&
    !endgameLeaderPressureProbe &&
    !largeBaseHardNationLeaderProbe &&
    !leaderContainmentStrike &&
    !incomingLeaderDefensiveCounterattack &&
    !leaderBreakthroughAttack &&
    !(
      leaderContainmentProbe &&
      relativeTroopRatio >= 1.05 &&
      target.troops <= ownTroops * 1.05
    ) &&
    !criticalBorderCollapse;
  const committedWarTargetID = currentWarTargetID(input.input);
  const activeWarOrRecentTargetID =
    committedWarTargetID ?? recentCombatFocusTargetID;
  const committedWarAttack =
    actionPlayerID !== null && actionPlayerID === committedWarTargetID;
  const offFocusCommittedWarAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    actionPlayerID !== null &&
    committedWarTargetID !== null &&
    actionPlayerID !== committedWarTargetID &&
    !incomingAttackTarget &&
    !finishMode &&
    !dominantConversionMode;
  const sideConquestTargetID = leaderPressureSideConquestTargetID(input.input);
  const sideConquestAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    actionPlayerID !== null &&
    actionPlayerID === sideConquestTargetID;
  const hardNationWeakSideConquestAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    !targetIsLeader &&
    target !== null &&
    ownTiles >= 12_000 &&
    ownTileShare >= 0.1 &&
    ownTroops >= 450_000 &&
    targetTiles >= 5_000 &&
    targetTiles <= ownTiles * 0.82 &&
    (targetTileShare === 0 ||
      targetTileShare <= Math.min(0.18, ownTileShare * 0.78)) &&
    target.troops <= ownTroops * 0.78 &&
    (relativeTroopRatio === 0 || relativeTroopRatio >= 1.15) &&
    troopCommitment > 0 &&
    troopCommitment <= 0.28 &&
    (activeWarOrRecentTargetID === null ||
      actionPlayerID === activeWarOrRecentTargetID ||
      ownTiles >= 20_000 ||
      (targetTiles > 0 &&
        targetTiles <= ownTiles * 0.45 &&
        target.troops <= ownTroops * 0.5)) &&
    !criticalBorderCollapse;
  const hardNationRaceFinishAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    !targetIsLeader &&
    target !== null &&
    ownTiles >= 14_000 &&
    ownTroops >= 1_300_000 &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.42 &&
    (activeCombatTarget || recentHostileAttacksAgainstTarget >= 1) &&
    (targetTiles === 0 || targetTiles <= ownTiles * 1.15) &&
    target.troops <= ownTroops * 1.35 &&
    !criticalBorderCollapse;
  const hardNationBreakFrontMediumFollowThrough =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    followsRecentBreakTarget &&
    target !== null &&
    ownTroops >= 1_000_000 &&
    targetTileShare >= 0.18 &&
    relativeTroopRatio >= 1.2 &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.32 &&
    !criticalBorderCollapse;
  const hardNationBreakFrontProbeDribble =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    followsRecentBreakTarget &&
    target !== null &&
    ownTroops >= 1_000_000 &&
    targetTileShare >= 0.18 &&
    relativeTroopRatio >= 1.2 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    !criticalBorderCollapse;
  const earlyHardNationWeakSideProbe =
    hardNationWeakSideConquestAttack &&
    ownTroops < 700_000 &&
    targetTileShare > 0.08 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12;
  const earlyHardNationWeakSideOvercommit =
    hardNationWeakSideConquestAttack &&
    ownTroops < 700_000 &&
    targetTileShare > 0.08 &&
    troopCommitment >= 0.18;
  const hardNationEndgameSideCleanupDelay =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    !targetIsLeader &&
    target !== null &&
    (observation.endgame?.leaderTileShare ?? 0) >= 0.68 &&
    ownTileShare < 0.5 &&
    targetTileShare > 0.005 &&
    targetTileShare <= Math.min(0.18, Math.max(0.06, ownTileShare * 0.5)) &&
    (metadataNumber(action, "targetTroops") || target.troops) >
      ownTroops * 0.06 &&
    !criticalBorderCollapse;
  const hardNationDefensiveBorderCounterattack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    !targetIsLeader &&
    target !== null &&
    target.sharesBorder &&
    observation.strategic.priority === "build_defense" &&
    !(
      leaderID !== null &&
      targetID !== leaderID &&
      (observation.endgame?.leaderTileShare ?? 0) >= 0.55 &&
      livingRivalCount(observation) <= 2 &&
      ownTileShare < 0.5
    ) &&
    ownTiles >= 6_000 &&
    ownTiles < 24_000 &&
    ownTileShare < 0.26 &&
    ownTroops >= 250_000 &&
    targetTiles >= ownTiles * 0.85 &&
    targetTiles <= ownTiles * 1.45 &&
    target.troops <= ownTroops * 0.9 &&
    (relativeTroopRatio === 0 || relativeTroopRatio >= 1.45) &&
    troopCommitment >= 0.18 &&
    troopCommitment <= 0.42;
  const hardNationLastStandCounterattack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationOpponentCount(observation) >= 1 &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    target !== null &&
    targetID !== null &&
    targetHasLandContact(observation, targetID) &&
    ownTiles > 0 &&
    ownTiles < 9_000 &&
    ownTroops >= 20_000 &&
    criticalBorderCollapse &&
    (relativeTroopRatio === 0 ||
      relativeTroopRatio >= 0.9 ||
      ownTiles < 1_500) &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    !finishMode &&
    !dominantConversionMode;
  const hardNationBoxedBreakoutProbe =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    target !== null &&
    targetID !== null &&
    targetHasLandContact(observation, targetID) &&
    ownTiles >= 4_500 &&
    ownTiles < 8_500 &&
    ownTroops >= 250_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    relativeTroopRatio >= 0.9 &&
    recentNeutralExpansionMadeNoProgress(observation, ownTiles) &&
    !finishMode &&
    !dominantConversionMode;
  const hardNationBoxedOpeningBadTrade =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    !finishMode &&
    !dominantConversionMode &&
    !hardNationWeakSideConquestAttack &&
    !hardNationRaceFinishAttack &&
    !hardNationLastStandCounterattack &&
    !hardNationBoxedBreakoutProbe &&
    !leaderContainmentProbe &&
    !leaderContainmentStrike &&
    target !== null &&
    ownTiles >= 8_000 &&
    ownTiles < 12_000 &&
    aliveVisibleOpponentCount(observation) >= 4 &&
    troopCommitment > 0 &&
    recentNeutralExpansionMadeNoProgress(observation, ownTiles) &&
    !criticalBorderCollapse &&
    !(
      targetTiles > 0 &&
      targetTiles <= ownTiles * 0.45 &&
      target.troops <= ownTroops * 0.45 &&
      relativeTroopRatio >= 1.6
    ) &&
    !(
      troopCommitment <= 0.12 &&
      relativeTroopRatio >= 1.25 &&
      target.troops <= ownTroops * 0.85 &&
      (targetTiles === 0 || targetTiles <= ownTiles * 1.35)
    ) &&
    (relativeTroopRatio === 0 ||
      relativeTroopRatio < 1.45 ||
      target.troops > ownTroops * 0.7 ||
      targetTiles >= ownTiles * 0.7);
  const hardNationContestedFrontRetreat =
    action.kind === "retreat" &&
    hardNationScrum &&
    !isNeutralRetreat &&
    target !== null &&
    !finishMode &&
    ownTiles >= 6_000 &&
    ownTroops >= 180_000 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.34 &&
    (incomingAttackTarget ||
      incomingCount > 0 ||
      observation.strategic.priority === "build_defense") &&
    (!criticalBorderCollapse || ownTiles >= 10_000);
  const hardNationUnderdogTileShareThreshold =
    ownTiles < 12_000
      ? Math.max(0.12, ownTileShare * 1.2)
      : Math.max(0.18, ownTileShare * 1.35);
  const hardNationUnderdogFeedAttack =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    !finishMode &&
    !dominantConversionMode &&
    !hardNationWeakSideConquestAttack &&
    !hardNationRaceFinishAttack &&
    !hardNationDefensiveBorderCounterattack &&
    !hardNationLastStandCounterattack &&
    !leaderContainmentProbe &&
    !leaderContainmentStrike &&
    target !== null &&
    ownTiles >= 8_000 &&
    ownTiles < 24_000 &&
    targetTiles >= Math.max(14_000, ownTiles * 1.35) &&
    targetTileShare >= hardNationUnderdogTileShareThreshold &&
    (relativeTroopRatio === 0 ||
      relativeTroopRatio < 1.05 ||
      target.troops > ownTroops * 1.15) &&
    troopCommitment > 0 &&
    !(criticalBorderCollapse && ownTiles < 6_000 && troopCommitment <= 0.12) &&
    !(
      targetIsLeader &&
      incomingAttackTarget &&
      ownTiles >= 18_000 &&
      troopCommitment <= 0.12 &&
      relativeTroopRatio >= 0.65
    );
  const hardNationEarlyMultiFrontMediumTrade =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    !finishMode &&
    !dominantConversionMode &&
    !hardNationWeakSideConquestAttack &&
    !hardNationRaceFinishAttack &&
    !hardNationLastStandCounterattack &&
    !leaderContainmentProbe &&
    !leaderContainmentStrike &&
    target !== null &&
    ownTiles >= 8_000 &&
    ownTiles < 24_000 &&
    aliveVisibleOpponentCount(observation) >= 4 &&
    observation.combat.borderedPlayerIDs.length >= 2 &&
    troopCommitment >= 0.18 &&
    relativeTroopRatio > 0 &&
    relativeTroopRatio < 1.75 &&
    targetTiles >= ownTiles * 0.65 &&
    !criticalBorderCollapse;
  const hardNationReserveDrainingCleanup =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    leaderPressure &&
    !targetIsLeader &&
    target !== null &&
    ownTiles >= 45_000 &&
    ownTroops < 650_000 &&
    targetTileShare > 0 &&
    targetTileShare <= 0.08 &&
    troopCommitment >= 0.25 &&
    relativeTroopRatio >= 1.2 &&
    !finishMode &&
    !dominantConversionMode;
  const repeatedLowCommitmentWarProbe =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    activeCombatTarget &&
    troopCommitment > 0 &&
    troopCommitment <= 0.12 &&
    recentHostileAttacksAgainstTarget >= 3 &&
    targetTiles > 1_500 &&
    !finishMode &&
    !criticalBorderCollapse &&
    (relativeTroopRatio === 0 ||
      relativeTroopRatio < 2.2 ||
      target === null ||
      target.troops > ownTroops * 0.45);
  const hardNationAttackWaveNeedsRecovery =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationStrategicContext &&
    ownTiles >= 35_000 &&
    observation.memory.repeatedActionKind === "attack" &&
    observation.memory.repeatedActionCount >= 4 &&
    troopCommitment >= 0.18 &&
    troopRatio < settings.triggerRatio &&
    !decisiveFinishableRivalAttack &&
    !leaderContainmentStrike &&
    !hardNationLeaderAttackWaveContinuation &&
    !hardNationLastStandCounterattack;
  const overlargeHardNationCleanupCommitment =
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    hardNationScrum &&
    ownTiles >= 35_000 &&
    !targetIsLeader &&
    targetTileShare > 0 &&
    targetTileShare <= 0.1 &&
    target !== null &&
    target.troops <= ownTroops * 0.58 &&
    relativeTroopRatio >= 2 &&
    troopCommitment >= 0.35 &&
    !finishMode &&
    !dominantConversionMode;
  const committedWarHasFavorableAttack =
    committedWarTargetID !== null &&
    input.input.legalActions.some(
      (candidate) =>
        actionTargetsPlayer(candidate, committedWarTargetID) &&
        actionIsFavorableHostileAttack(candidate),
    );
  const frontSwitchWhileCurrentWarIsFavorable =
    isHostilePressureAction(action) &&
    actionPlayerID !== null &&
    committedWarTargetID !== null &&
    actionPlayerID !== committedWarTargetID &&
    committedWarHasFavorableAttack &&
    !finishMode &&
    !dominantConversionMode &&
    !criticalBorderCollapse &&
    ownTiles >= 16_000 &&
    (!incomingAttackTarget ||
      targetTileShare >= 0.18 ||
      relativeTroopRatio === 0 ||
      relativeTroopRatio < 1.65);
  const strongerLeaderTradeBeforeSideConquest =
    isHostilePressureAction(action) &&
    actionPlayerID !== null &&
    sideConquestTargetID !== null &&
    actionPlayerID !== sideConquestTargetID &&
    targetIsLeader &&
    !hardNationRunawayLeaderProbe &&
    !finishMode &&
    !dominantConversionMode &&
    !criticalBorderCollapse &&
    ownTiles >= 16_000 &&
    !leaderBreakthroughAttack &&
    !leaderContainmentProbe &&
    !leaderContainmentStrike &&
    (relativeTroopRatio === 0 || relativeTroopRatio < 1.2);
  if (incomingCount > 0 || reservePressure) {
    if (action.kind === "retreat" || action.kind === "boat_retreat") {
      const retreatCommitment = committedTroopRatio(action, ownTroops);
      add(
        "emergency_survival",
        action.kind === "boat_retreat"
          ? 72
          : isNeutralRetreat
            ? 0
            : retreatCommitment >= 0.18
              ? 92
              : retreatCommitment >= 0.08
                ? 46
                : 14,
        "retreat preserves meaningfully committed troops under pressure",
      );
    }
    if (isDefensiveAction(action)) {
      add(
        "emergency_survival",
        72,
        "defensive action helps absorb current pressure",
      );
    }
    if (
      action.kind === "alliance_request" ||
      action.kind === "alliance_extend"
    ) {
      add("emergency_survival", 38, "diplomacy can reduce hostile fronts");
    }
    if (action.kind === "hold") {
      add("emergency_survival", 20, "holding protects reserves under threat");
    }
    if (action.kind === "attack" && action.metadata?.expansion !== true) {
      if (!activeCombatTarget && !stickyRecentCombatTarget) {
        penalize(
          targetIsLeader ? 8 : 36,
          "active pressure makes new wars unsafe",
        );
      }
    }
  }
  if (
    finishMode &&
    incomingCount === 0 &&
    (action.kind === "retreat" || action.kind === "boat_retreat")
  ) {
    const retreatCommitment = committedTroopRatio(action, ownTroops);
    penalize(
      retreatCommitment >= 0.3 ? 18 : 56,
      "finish mode should continue pressure unless a large force is truly at risk",
    );
  }
  if (isNeutralRetreat) {
    penalize(
      incomingCount === 0 ? 130 : 170,
      incomingCount === 0
        ? "neutral expansion retreat wastes growth tempo when there is no incoming danger"
        : "neutral expansion retreat wastes growth tempo under pressure",
    );
  }

  if (observation.phase === "spawn") {
    if (action.kind === "spawn") {
      add("spawn_opening", 86, "spawn is required to enter the map");
      add(
        "spawn_opening",
        metadataNumber(action, "safetyScore") * 18,
        "spawn safety",
      );
      add(
        "spawn_opening",
        metadataNumber(action, "opportunityScore") * 14,
        "spawn opportunity",
      );
    }
  } else {
    if (
      settings.firstCityTargetAfterStableExpansion &&
      observation.memory.recentExpansionCount >= 2 &&
      action.kind === "build" &&
      metadataString(action, "unit") === "City"
    ) {
      add(
        "spawn_opening",
        46,
        "first city after stable expansion follows nation-bot opening",
      );
    }
  }

  if (action.kind === "attack" && action.metadata?.expansion === true) {
    const riskyLowLandOpeningSpawn = observation.memory.recentActions.some(
      (decision) =>
        decision.actionKind === "spawn" &&
        (decision.spawnPressureScore ?? 0) >= 0.8 &&
        (decision.spawnLocalLandScore ?? 1) <= 0.85,
    );
    const nationOpeningForceExpansion =
      hardNationScrum &&
      ownTiles < 1_000 &&
      observation.memory.recentExpansionCount === 0 &&
      riskyLowLandOpeningSpawn &&
      troopCommitment >= 0.45 &&
      troopCommitment <= 0.55;
    const openingBurstExpansion =
      forcedCrowdedOpeningExpansion &&
      ownTiles < 12_000 &&
      troopRatio >= settings.triggerRatio &&
      troopCommitment >= 0.3 &&
      troopCommitment <= 0.38;
    add(
      "expansion",
      troopRatio >= settings.triggerRatio ? 62 : 30,
      "neutral expansion grows tile share",
    );
    if (forcedCrowdedOpeningExpansion) {
      add(
        "expansion",
        44,
        "crowded hard-nation opening needs land base before pressure",
      );
    }
    if (openingExpansionTempoAction) {
      add(
        "expansion",
        72,
        "opening tempo converts legal neutral growth before the map closes",
      );
    }
    if (nationOpeningForceExpansion) {
      add(
        "expansion",
        132,
        "first hard-nation expansion mirrors built-in nation opening tempo",
      );
    } else if (openingBurstExpansion) {
      add(
        "expansion",
        54,
        "hard-nation opening uses a nation-style burst expansion",
      );
    } else if (
      troopCommitment >
      settings.expansionRatio + tunedNumber("OVEREXPAND_PENALTY_MARGIN", 0.08)
    ) {
      penalize(46, "large neutral expansion is only for the opening land grab");
    }
    if (troopCommitment <= settings.expansionRatio + 0.03) {
      add("expansion", 18, "expansion commitment stays near configured ratio");
    }
    if (leaderPressure) {
      penalize(42, "runaway leader pressure makes neutral expansion secondary");
    }
    if (
      strongerAttackableThreat &&
      observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency !== "low" &&
      (ownTileShare >= tunedNumber("DEFENSE_STABILIZE_TILESHARE", 0.24) ||
        criticalBorderCollapse)
    ) {
      penalize(
        122,
        "stronger border rival requires stabilizing before more neutral expansion",
      );
    }
    if (dangerousEstablishedNeutralGrowthUnderPressure(input.input)) {
      penalize(
        190,
        "high incoming pressure should preserve troops before neutral expansion",
      );
    }
    if (shouldDiversifyExpansion) {
      penalize(
        repeatedNeutralHandoffReady ? 92 : 38,
        repeatedNeutralHandoffReady
          ? "after two neutral expansions, safe economy or weak-rival handoff is ready"
          : "repeated neutral expansion should rotate into economy, diplomacy, or pressure",
      );
    }
    if (borderedPressureExpansionStale) {
      penalize(
        input.plan.objective === "pressure_rival" ? 128 : 112,
        input.plan.objective === "pressure_rival"
          ? "pressure plan should not spend troops on neutral land while hostile borders exist"
          : "bordered rival pressure makes repeated neutral expansion stale",
      );
    }
    if (hardNationStalledNeutralExpansion) {
      penalize(
        140,
        "stalled island expansion should launch transport instead of repeating neutral attacks",
      );
    }
    if (hardNationNoGrowthNeutralExpansion) {
      penalize(
        220,
        "neutral expansion is not gaining land from this boxed frontier",
      );
    }
    if (
      hardNationScrum &&
      ownTiles >= 24_000 &&
      hostileBorderActionAvailable &&
      livingRivalCount(observation) > 1
    ) {
      penalize(
        142,
        "hard-nation land lead must convert rivals instead of farming neutral land",
      );
    }
    if (
      duelMode &&
      input.input.legalActions.some(
        (candidate) =>
          candidate.kind === "attack" && candidate.metadata?.expansion !== true,
      )
    ) {
      penalize(
        58,
        "one-vs-one duel mode should pressure rival land over stale neutral expansion",
      );
    }
  }
  if (isNeutralBoatAction(action)) {
    add("expansion", 44, "transport reaches neutral land that borders cannot");
    if (humanReplayOpeningBoatTempo) {
      add(
        "expansion",
        landExpansionAvailable ? 96 : 72,
        "human replay opening baseline uses early neutral transport",
      );
      add(
        "naval",
        28,
        "top human replays launch opening boats around the first minute",
      );
    }
    if (openingExpansionTempoAction) {
      add(
        "expansion",
        landExpansionAvailable ? 28 : 64,
        "opening tempo uses neutral transport when land growth is constrained",
      );
    }
    if (hardNationStalledNeutralTransport) {
      add(
        "naval",
        132,
        "stalled island expansion needs a neutral transport path",
      );
    }
    if (hardNationFlankTransport) {
      add(
        "naval",
        88,
        "hard-nation flank transport opens side conquest while leader attacks are unsafe",
      );
      add(
        "combat",
        36,
        "transport seeks a safer front instead of feeding the hard-nation leader",
      );
    }
    if (hardNationBoxedEscapeTransport) {
      add(
        "naval",
        138,
        "boxed hard-nation escape transport creates a new land base",
      );
      add(
        "expansion",
        42,
        "transport is the remaining growth path after boxed land attacks stall",
      );
    }
    if (forcedCrowdedOpeningExpansion && !landExpansionAvailable) {
      add(
        "expansion",
        activeTransportCount === 0 ? 58 : activeTransportCount === 1 ? 34 : 12,
        "crowded hard-nation opening uses neutral transport when land is blocked",
      );
    }
    if (landExpansionAvailable && !humanReplayOpeningBoatTempo) {
      penalize(
        82,
        "land expansion is safer than neutral transport while borders can still grow",
      );
    }
    if (
      leaderPressure &&
      !hardNationFlankTransport &&
      !hardNationBoxedEscapeTransport
    ) {
      penalize(
        34,
        "runaway leader pressure makes distant neutral transport secondary",
      );
    }
    if (
      borderedPressureExpansionStale &&
      !hardNationFlankTransport &&
      !hardNationBoxedEscapeTransport
    ) {
      penalize(
        input.plan.objective === "pressure_rival" ? 118 : 96,
        input.plan.objective === "pressure_rival"
          ? "pressure plan should not spend troops on neutral land while hostile borders exist"
          : "bordered rival pressure makes repeated neutral expansion stale",
      );
    }
    if (
      strongerAttackableThreat &&
      observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency !== "low" &&
      (ownTileShare >= 0.24 || criticalBorderCollapse) &&
      !hardNationFlankTransport &&
      !hardNationBoxedEscapeTransport
    ) {
      penalize(104, "stronger border rival makes neutral transport too slow");
    }
    if (duelMode && hasPlayerPressureAction(input.input.legalActions)) {
      penalize(46, "one-vs-one duel mode makes neutral transports secondary");
    }
    if (shouldDiversifyExpansion) {
      penalize(
        repeatedNeutralHandoffReady
          ? 84
          : forcedCrowdedOpeningExpansion
            ? 12
            : 34,
        repeatedNeutralHandoffReady
          ? "after two neutral expansions, safe economy or weak-rival handoff is ready"
          : forcedCrowdedOpeningExpansion
            ? "crowded hard-nation opening can keep expanding through transports"
            : "repeated neutral expansion should rotate into economy, diplomacy, or pressure",
      );
    }
  }

  if (isDefensiveAction(action)) {
    if (
      settings.openingExpansionTempoEnabled &&
      openingExpansionTempo?.recommended === true &&
      neutralGrowthAvailable &&
      !criticalBorderCollapse
    ) {
      penalize(
        64,
        "opening tempo should spend legal neutral growth before static defense",
      );
    }
    if (isPoorDefensePostAction(action)) {
      penalize(
        hasEconomicBuildAction(input.input.legalActions) ? 320 : 240,
        hasEconomicBuildAction(input.input.legalActions)
          ? "poor Defense Post is blocked while City, Factory, or Port is legal"
          : "Defense Post lacks a hostile frontier or incoming attack to cover",
      );
    } else {
      add("defense", defensePolicyScore(action), defensePolicyReason(action));
    }
    const hardNationFirstDefensePostException =
      (observation.combat.attackablePlayerIDs.length >= 2 &&
        ownTiles <= 14_000 &&
        ownTroops >= 220_000) ||
      (ownTroops <= 190_000 &&
        ownTiles >= 10_000 &&
        observation.combat.borderedPlayerIDs.length >= 2);
    if (
      isDefensePostAction(action) &&
      hardNationScrum &&
      ownUnitCount(observation, UnitType.City) === 0 &&
      ownUnitCount(observation, UnitType.Factory) === 0 &&
      !hardNationFirstDefensePostException
    ) {
      penalize(
        210,
        "built-in hard nations do not spend their first structure on Defense Post",
      );
    }
  }
  if (
    action.kind === "upgrade_structure" &&
    isDefenseUnit(metadataString(action, "unit"))
  ) {
    add("defense", 38, "upgrading defense is cheaper than losing dense land");
  }
  if (action.kind === "retreat" || action.kind === "boat_retreat") {
    const retreatCommitment = committedTroopRatio(action, ownTroops);
    add(
      "defense",
      isNeutralRetreat ? 8 : retreatCommitment >= 0.08 ? 42 : 10,
      "retreat converts losing pressure into preserved troops",
    );
    if (hardNationContestedFrontRetreat) {
      penalize(
        190,
        "hard-nation contested frontier should counterattack before retreating",
      );
    }
    if (
      action.kind === "retreat" &&
      incomingCount === 0 &&
      !isNeutralRetreat &&
      !finishMode &&
      troopRatio >= settings.retreatThreshold * 0.65
    ) {
      penalize(
        76,
        "retreating offensive attacks without incoming pressure gives up initiative",
      );
    }
  }

  if (
    action.kind === "build" &&
    isEconomicUnit(metadataString(action, "unit"))
  ) {
    const unit = metadataString(action, "unit");
    add("economy", 62, "economic structure compounds gold and troops");
    if (hardNationScrum && ownTiles >= 8_000) {
      if (unit === "City" && ownUnitCount(observation, UnitType.City) === 0) {
        add(
          "economy",
          76,
          "hard-nation match needs an early city before pressure trades",
        );
      } else if (unit === "Factory") {
        add(
          "economy",
          54,
          "hard-nation match needs factory production to keep troop pace",
        );
      } else if (unit === "Port") {
        add(
          "economy",
          46,
          "hard-nation match uses ports to match built-in income tempo",
        );
      }
      if (observation.memory.recentBuildCount === 0) {
        add(
          "economy",
          22,
          "hard-nation economy window should be cashed before more pressure",
        );
      }
    }
    if (shouldDiversifyExpansion && observation.memory.recentBuildCount === 0) {
      add(
        "economy",
        repeatedNeutralHandoffReady ? 74 : 32,
        repeatedNeutralHandoffReady
          ? "economy build is the post-expansion handoff"
          : "economy build breaks a repeated neutral-expansion streak",
      );
    }
    if (executorReadyWeakRivalPressure) {
      penalize(
        52,
        "executor-ready weak-rival pressure should attack before another economy build",
      );
    }
    if (
      metadataString(action, "unit") === "Port" &&
      (observation.ownState?.tileShare ?? 0) >= settings.portTileShareRatio
    ) {
      add("economy", 16, "port ratio target is now reachable");
    }
    if (
      metadataString(action, "unit") === "Factory" &&
      (observation.ownState?.tileShare ?? 0) >= settings.factoryTileShareRatio
    ) {
      add("economy", 14, "factory ratio target is now reachable");
    }
  }
  if (
    action.kind === "upgrade_structure" &&
    isEconomicUnit(metadataString(action, "unit"))
  ) {
    add("economy", 42, "upgrade improves existing production");
    if (hardNationScrum && ownTiles >= 12_000) {
      add(
        "economy",
        48,
        "hard-nation match upgrades production instead of wasting safe gold",
      );
    }
    if (shouldDiversifyExpansion) {
      add("economy", 20, "upgrade breaks a repeated neutral-expansion streak");
    }
  }
  if (
    action.kind === "build" &&
    metadataString(action, "unit") === UnitType.MissileSilo
  ) {
    add("economy", 20, "missile silo unlocks endgame deterrence");
  }

  if (action.kind === "alliance_request" || action.kind === "alliance_extend") {
    const _pressureTargetAlliance =
      action.kind === "alliance_request" &&
      hardNationScrum &&
      input.plan.objective === "pressure_rival" &&
      input.plan.targetPlayerId !== null &&
      actionPlayerID === input.plan.targetPlayerId &&
      ownTiles >= 24_000 &&
      ownTroops >= 600_000 &&
      hasPlayerPressureAction(input.input.legalActions);
    const _hardNationMidgameRivalAlliance =
      action.kind === "alliance_request" &&
      hardNationScrum &&
      input.plan.objective !== "build_alliance" &&
      ownTiles >= 34_000 &&
      ownTroops >= 300_000 &&
      ownTileShare >= 0.26 &&
      target !== null &&
      hasPlayerPressureAction(input.input.legalActions) &&
      (targetIsLeader ||
        targetTileShare >= 0.12 ||
        target.troops >= ownTroops * 0.75);
    const survivalAllianceTarget =
      action.kind === "alliance_request" &&
      hardNationScrum &&
      observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency === "high" &&
      target !== null &&
      livingRivalCount(observation) > 1 &&
      ownTileShare > 0 &&
      ownTileShare < 0.38 &&
      (targetIsLeader ||
        target.incomingAttack === true ||
        (target.relativeTroopRatio ?? 1) < 1.15);
    const hardNationSurvivalAllianceTrap =
      action.kind === "alliance_request" &&
      hardNationScrum &&
      ownTiles >= 42_000 &&
      ownTroops >= 350_000 &&
      input.plan.objective !== "build_alliance" &&
      (hasPlayerPressureAction(input.input.legalActions) ||
        input.input.legalActions.some(
          (candidate) => candidate.kind === "boat",
        )) &&
      (ownTiles >= 50_000 ||
        survivalAllianceTarget ||
        recentConquestDiplomacyTarget ||
        hardNationConquestDiplomacyTarget ||
        hardNationSideConquestDiplomacyTarget);
    add("diplomacy", 66, "alliances secure flanks and reduce wars");
    if (survivalAllianceTarget) {
      add(
        "diplomacy",
        targetIsLeader ? 138 : 112,
        "hard-nation survival should try to turn one dangerous front neutral",
      );
    }
    if (forcedCrowdedOpeningExpansion && action.kind === "alliance_request") {
      add(
        "diplomacy",
        target?.sharesBorder === true ? 54 : 36,
        "crowded hard-nation opening needs flank alliances before wars start",
      );
    }
    if (shouldDiversifyExpansion) {
      add(
        "diplomacy",
        18,
        "diplomacy breaks a repeated neutral-expansion streak",
      );
    }
    if (
      earlyNeutralExpansion &&
      !forcedCrowdedOpeningExpansion &&
      profile !== "diplomatic" &&
      input.plan.objective !== "build_alliance"
    ) {
      penalize(
        92,
        "early expansion should not be diluted by alliance requests",
      );
    }
    if (
      (targetIsLeader || input.plan.objective === "pressure_rival") &&
      !survivalAllianceTarget
    ) {
      penalize(
        120,
        "do not protect a runaway or pressure target with alliance",
      );
    }
    if (
      hardNationScrum &&
      input.plan.objective !== "build_alliance" &&
      ownTiles >= 18_000 &&
      hasCleanHostileAttack(input.input.legalActions) &&
      !survivalAllianceTarget
    ) {
      penalize(
        190,
        "hard-nation midgame must convert land instead of new alliances",
      );
    }
    if (recentConquestDiplomacyTarget && !survivalAllianceTarget) {
      penalize(170, "do not re-ally with the active conquest target");
    }
    const recentWarTargetSurvivalException =
      survivalAllianceTarget && targetIsLeader && targetTileShare >= 0.42;
    if (
      recentHardNationWarTargetAlliance &&
      !recentWarTargetSurvivalException
    ) {
      penalize(280, "do not re-ally with recent hard-nation war target");
    }
    if (hardNationSurvivalAllianceTrap) {
      penalize(
        260,
        "hard-nation survival should not protect a conquest target in the land race",
      );
    }
    if (
      weakFrontierConquestTargetID !== null &&
      actionPlayerID === weakFrontierConquestTargetID &&
      !survivalAllianceTarget
    ) {
      penalize(190, "do not ally with weak hard-nation conquest target");
    }
    if (hardNationConquestDiplomacyTarget) {
      penalize(210, "do not ally with hard-nation conquest target");
    }
    if (hardNationSideConquestDiplomacyTarget) {
      penalize(210, "do not ally with hard-nation side-conquest target");
    }
    if (hardNationRunawayLeaderAlliance) {
      penalize(230, "do not ally with runaway hard-nation leader");
    }
    if (
      target !== null &&
      livingRivalCount(observation) <= 1 &&
      target.isAllied !== true
    ) {
      penalize(
        140,
        "one-vs-one matches need pressure, not alliance with the only rival",
      );
    }
  }
  if (action.kind === "donate_gold" || action.kind === "donate_troops") {
    add("diplomacy", 50, "support keeps useful allies alive");
    if (hardNationBufferSupport) {
      add(
        "diplomacy",
        action.kind === "donate_gold" ? 150 : 72,
        "buffer support slows a hard-nation snowball while no conquest is legal",
      );
      if (action.kind === "donate_troops") {
        penalize(
          72,
          "gold support preserves troop parity better than troop donations",
        );
      }
    }
    if (
      hardNationScrum &&
      input.plan.objective !== "build_alliance" &&
      !hardNationBufferSupport
    ) {
      penalize(180, "hard-nation benchmark should not feed rival nations");
    }
    if (targetIsLeader && !hardNationBufferSupport) {
      penalize(140, "do not donate resources to the current leader");
    }
    if (ownTileShare > 0 && ownTileShare < 0.25) {
      penalize(
        86,
        "early nation must keep gold and troops for its own scaling",
      );
    }
    if (leaderPressure && !targetIsLeader && !hardNationBufferSupport) {
      penalize(
        90,
        "runaway leader pressure needs direct pressure, not indirect support",
      );
    }
    if (
      input.plan.objective !== "build_alliance" &&
      incomingCount === 0 &&
      !hardNationBufferSupport
    ) {
      penalize(
        42,
        "support outside an alliance plan delays territorial conversion",
      );
    }
  }
  if (action.kind === "embargo_stop") {
    add("diplomacy", 32, "ending embargo can reopen alliance or trade options");
    if (leaderPressure && targetIsLeader) {
      penalize(120, "do not stop pressure on runaway leader");
    }
    if (
      input.plan.objective !== "build_alliance" &&
      target?.isAllied !== true &&
      target?.isFriendly !== true
    ) {
      penalize(70, "stopping embargo on a rival gives up pressure");
    }
  }
  if (action.kind === "alliance_reject") {
    add(
      "diplomacy",
      targetIsLeader ? 28 : 8,
      "rejecting alliance can avoid protecting a leader",
    );
  }
  if (action.kind === "quick_chat" || action.kind === "emoji") {
    add("diplomacy", 12, "communication is low-cost coordination");
  }
  if (personalityDiplomacyPressureAction) {
    const best = action.id === personalityDiplomacyPressure?.bestSocialActionID;
    const module =
      isPressureOnlySignalAction(action) || action.kind === "alliance_reject"
        ? "combat"
        : isSocialFlavorAction(action)
          ? "utility_social"
          : "diplomacy";
    add(
      module,
      best ? 82 : 34,
      "personality diplomacy pressure recommends a profile-specific social beat",
    );
  }

  if (action.kind === "attack" && action.metadata?.expansion !== true) {
    add(
      "combat",
      targetIsLeader
        ? 88
        : relativeTroopRatio >= 1.4 && troopRatio >= settings.triggerRatio
          ? 72
          : 34,
      "attack timing uses relative troops and reserve trigger",
    );
    if (frontierConversionReadyAttack) {
      add(
        "combat",
        troopCommitment <= 0.12 ? 128 : troopCommitment <= 0.28 ? 108 : 86,
        "frontier conversion ready attack uses calibrated weak-rival window",
      );
    }
    if (frontierFinishPressureAttack) {
      add(
        "combat",
        troopCommitment <= 0.28 ? 156 : 118,
        "frontier finish pressure escalates repeated probes",
      );
    }
    if (targetIsLeader) {
      add("combat", 28, "target is current land leader");
      if (
        incomingAttackTarget &&
        ownTiles >= 20_000 &&
        troopCommitment > 0 &&
        troopCommitment <= 0.12 &&
        relativeTroopRatio >= 0.65
      ) {
        add(
          "emergency_survival",
          82,
          "small counterattack contests an incoming leader invasion",
        );
      }
      if (
        ownTiles >= 20_000 &&
        ownTileShare >= 0.2 &&
        troopCommitment > 0 &&
        troopCommitment <= 0.12 &&
        relativeTroopRatio >= 0.65
      ) {
        add(
          "combat",
          36,
          "large nation can probe the land leader before they snowball",
        );
      }
      if (
        ownTiles >= 20_000 &&
        ownTileShare >= 0.2 &&
        troopCommitment > 0 &&
        troopCommitment <= 0.28 &&
        relativeTroopRatio >= 0.75
      ) {
        add(
          "combat",
          28,
          "large nation can pressure the land leader with reserve-safe attacks",
        );
      }
    }
    if (leaderBreakthroughAttack) {
      add(
        "combat",
        96,
        "decisive leader breakthrough uses a clear troop edge before they snowball",
      );
    }
    if (endgameLeaderPressureProbe) {
      add(
        "combat",
        96,
        "endgame leader pressure must slow a likely winning nation",
      );
    }
    if (hardNationRunawayLeaderProbe) {
      add(
        "combat",
        162,
        "runaway hard-nation leader probe is better than side cleanup",
      );
    }
    if (largeBaseHardNationLeaderProbe) {
      add(
        "combat",
        176,
        "large-base hard-nation leader probe buys endgame time",
      );
    }
    if (leaderContainmentProbe) {
      add(
        "emergency_survival",
        118,
        "reserve-safe leader containment probe slows a hard-nation invasion",
      );
    }
    if (leaderContainmentStrike) {
      add(
        "emergency_survival",
        132,
        "parity leader containment strike contests a hard-nation win push",
      );
    }
    if (hardNationLeaderAttackWaveContinuation) {
      add(
        "combat",
        118,
        "sustained leader attack wave uses a clear troop edge before they recover",
      );
    }
    if (sideConquestAttack) {
      add(
        "combat",
        troopCommitment <= 0.28 ? 64 : 34,
        "finish weaker rival to grow before the leader duel",
      );
    }
    if (hardNationWeakSideConquestAttack) {
      add(
        "combat",
        earlyHardNationWeakSideProbe ? 154 : troopCommitment >= 0.18 ? 132 : 92,
        "hard-nation side conquest converts weaker frontier before leader race",
      );
    }
    if (earlyHardNationWeakSideOvercommit) {
      penalize(
        72,
        "early hard-nation side conquest should preserve reserves with probes",
      );
    }
    if (finishableRivalAttack) {
      add(
        "combat",
        decisiveFinishableRivalAttack ? 82 : troopCommitment >= 0.18 ? 52 : 38,
        "finish weakened rival before they recover",
      );
    }
    if (hardNationRaceFinishAttack) {
      add(
        "combat",
        troopCommitment >= 0.35 ? 148 : 112,
        "hard-nation race finish converts side rival before leader wins",
      );
    }
    if (hardNationEndgameSideCleanupDelay) {
      penalize(
        220,
        "hard-nation endgame must pressure leader before side cleanup",
      );
    }
    if (followsRecentBreakTarget) {
      add(
        "combat",
        hardNationBreakFrontMediumFollowThrough
          ? 206
          : troopCommitment >= 0.18
            ? 126
            : 82,
        "follow through after breaking alliance front",
      );
      if (hardNationBreakFrontProbeDribble) {
        penalize(68, "broken alliance front needs decisive follow-through");
      }
    } else if (
      switchesOffRecentBreakTarget &&
      !incomingAttackTarget &&
      !criticalBorderCollapse
    ) {
      penalize(
        148,
        "finish recently opened alliance front before switching targets",
      );
    }
    if (activeCombatTarget) {
      add("combat", 34, "counterpressure targets the active combat front");
      if (troopCommitment >= 0.25 && troopCommitment <= 0.42) {
        add(
          "combat",
          24,
          "counterpressure uses nation-style reserve commitment",
        );
      } else if (troopCommitment > 0 && troopCommitment < 0.18) {
        penalize(30, "counterpressure probe is too small to stop an invasion");
      }
    } else if (stickyWinningFront) {
      add(
        "combat",
        troopCommitment >= 0.18 ? 46 : 28,
        "continue recent winning front before the rival recovers",
      );
    }
    if (finishMode && livingRivalCount(observation) <= 1) {
      add(
        "combat",
        50,
        "finish mode converts a dominant tile lead into conquest",
      );
      if (troopCommitment >= 0.25) {
        add("combat", 18, "finish mode favors decisive attack commitment");
      } else {
        penalize(14, "finish mode probe is too small to close the game");
      }
    }
    if (duelMode && !finishMode) {
      add("combat", 44, "one-vs-one duel should keep direct border pressure");
    }
    if (dominantConversionMode) {
      add(
        "combat",
        troopCommitment >= 0.25 ? 74 : 48,
        "dominant map share should convert with direct hostile attacks",
      );
      if (troopCommitment < 0.1) {
        penalize(20, "dominant conversion probe is too small to finish rivals");
      }
      if (troopCommitment >= 0.35 && relativeTroopRatio < 2.5) {
        penalize(
          32,
          "dominant conversion should prefer reserve-safe pressure over oversized attacks",
        );
      } else if (troopCommitment >= 0.18 && troopCommitment <= 0.3) {
        add(
          "combat",
          16,
          "dominant conversion uses reserve-safe sustained pressure",
        );
      }
    }
    if (dominantHardNationLargestRivalAttack) {
      add(
        "combat",
        troopCommitment >= 0.25 ? 152 : 128,
        "dominant hard-nation leader pressures largest rival before side fronts",
      );
    }
    if (
      criticalBorderCollapse &&
      action.risk.level !== "high" &&
      troopCommitment >= 0.1 &&
      (relativeTroopRatio === 0 ||
        relativeTroopRatio >= 0.95 ||
        (troopCommitment <= 0.12 && relativeTroopRatio >= 0.65) ||
        (ownTiles < 2_000 &&
          incomingAttackTarget &&
          relativeTroopRatio >= 0.25))
    ) {
      const strongerCounterattack =
        relativeTroopRatio > 0 && relativeTroopRatio < 1.05;
      if (!strongerCounterattack || troopCommitment <= 0.12) {
        add(
          "emergency_survival",
          troopCommitment >= 0.25 ? 190 : 150,
          "critical border collapse counterattack is better than passive elimination",
        );
      } else {
        penalize(
          148,
          "desperate counterattack against stronger rival must stay probe-sized",
        );
      }
    }
    if (incomingLeaderDefensiveCounterattack) {
      add(
        "emergency_survival",
        troopCommitment >= 0.25 ? 172 : 136,
        "medium counterattack blunts incoming hard-nation leader pressure",
      );
    }
    if (hardNationDefensiveBorderCounterattack) {
      add(
        "emergency_survival",
        troopCommitment >= 0.25 ? 156 : 124,
        "medium counterattack contests a boxed hard-nation border",
      );
    }
    if (hardNationLastStandCounterattack) {
      add(
        "emergency_survival",
        220,
        "last-stand hard-nation counterattack is better than passive elimination",
      );
    }
    if (hardNationBoxedBreakoutProbe) {
      add(
        "emergency_survival",
        180,
        "boxed hard-nation frontier must break out after expansion stalls",
      );
    }
    if (
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 0.9 &&
      !dominantHardNationLargestRivalAttack
    ) {
      penalize(78, "attacking a stronger rival feeds them troops");
    } else if (
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1.15 &&
      !dominantHardNationLargestRivalAttack
    ) {
      penalize(38, "attack lacks a clear troop edge");
    }
    if (repeatedLowCommitmentWarProbe) {
      penalize(
        22,
        "repeated low-commitment war probes are stalling conversion",
      );
    }
    if (
      frontierFinishPressure?.recommended === true &&
      actionPlayerID === frontierFinishPressure.bestTargetID &&
      troopCommitment > 0 &&
      troopCommitment <= 0.12
    ) {
      penalize(
        86,
        "frontier finish pressure should escalate beyond repeated probes",
      );
    }
    if (hardNationAttackWaveNeedsRecovery) {
      penalize(
        170,
        "hard-nation attack wave should rebuild troops before another medium strike",
      );
    }
    const recentRetreatTargetID = recentAcceptedTargetID(
      observation,
      ["retreat"],
      6,
    );
    if (
      hardNationOpponentCount(observation) >= 1 &&
      observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency === "high" &&
      recentRetreatTargetID !== null &&
      actionPlayerID === recentRetreatTargetID &&
      !finishMode &&
      !dominantConversionMode &&
      !hardNationLastStandCounterattack &&
      !criticalBorderCollapse
    ) {
      penalize(
        260,
        "recent retreat needs a troop rebuild before counterattack",
      );
    }
    if (overlargeHardNationCleanupCommitment) {
      penalize(
        96,
        "hard-nation weak-target cleanup should avoid oversized commitments",
      );
    }
    if (hardNationUnderdogFeedAttack) {
      penalize(
        210,
        "hard-nation underdog should not feed stronger rival probes",
      );
    }
    if (
      observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency === "high" &&
      targetIsLeader &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1.15 &&
      !finishMode &&
      !endgameLeaderPressureProbe &&
      !leaderContainmentProbe &&
      !leaderContainmentStrike &&
      !hardNationLeaderAttackWaveContinuation &&
      !incomingLeaderDefensiveCounterattack &&
      !dominantHardNationLargestRivalAttack &&
      !(criticalBorderCollapse && troopCommitment <= 0.12) &&
      !(
        incomingAttackTarget &&
        ownTiles >= 20_000 &&
        troopCommitment > 0 &&
        troopCommitment <= 0.12 &&
        relativeTroopRatio >= 0.65
      )
    ) {
      penalize(128, "urgent defense should not trade into a stronger leader");
    }
    if (
      targetIsLeader &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1 &&
      troopCommitment > 0 &&
      troopCommitment <= 0.12 &&
      !incomingAttackTarget &&
      !finishMode &&
      !dominantConversionMode &&
      !endgameLeaderPressureProbe &&
      !leaderContainmentProbe &&
      !dominantHardNationLargestRivalAttack &&
      !criticalBorderCollapse &&
      (existingWarTarget ||
        recentHostileAttacksAgainstTarget >= 1 ||
        observation.memory.repeatedActionKind === "attack")
    ) {
      penalize(118, "repeated leader probe needs a troop rebuild window");
    }
    if (repeatedIncomingLeaderProbeWithoutEdge) {
      penalize(
        168,
        "repeated incoming leader probe needs a troop rebuild window",
      );
    }
    if (
      targetIsLeader &&
      relativeTroopRatio > 0 &&
      relativeTroopRatio < 1.15 &&
      troopCommitment >= 0.18 &&
      !incomingAttackTarget &&
      !finishMode &&
      !dominantConversionMode &&
      !leaderContainmentStrike &&
      !hardNationLeaderAttackWaveContinuation &&
      !dominantHardNationLargestRivalAttack
    ) {
      penalize(112, "medium leader pressure needs parity outside finish mode");
    }
    if (durableLeaderMediumTrade) {
      penalize(
        118,
        "medium leader attacks need a decisive edge while rivals remain",
      );
    }
    if (overlargeLeaderPressure) {
      penalize(
        138,
        "urgent defense should grow before challenging an overlarge leader",
      );
    }
    if (hardNationOvermatchedLeaderAttack) {
      penalize(190, "overmatched leader attacks feed a hard-nation snowball");
    }
    if (hardNationBoxedOpeningBadTrade) {
      penalize(
        210,
        "boxed hard-nation opening must not feed rival before breakout",
      );
    }
    if (
      !finishMode &&
      livingRivalCount(observation) > 1 &&
      ownTileShare < 0.35 &&
      !activeCombatTarget &&
      !stickyWinningFront &&
      !sideConquestAttack &&
      !hardNationWeakSideConquestAttack &&
      !hardNationRaceFinishAttack &&
      !finishableRivalAttack &&
      troopCommitment > 0.12
    ) {
      penalize(
        86,
        "multi-rival opening pressure should use reserve-preserving probes",
      );
    }
    if (
      !finishMode &&
      !activeCombatTarget &&
      troopCommitment >= 0.25 &&
      (ownTroops < 180_000 || ownTiles < 9_000)
    ) {
      penalize(104, "medium and large attacks require a developed troop base");
    }
    if (
      !finishMode &&
      !activeCombatTarget &&
      troopCommitment >= 0.35 &&
      (ownTroops < 450_000 || ownTiles < 18_000)
    ) {
      penalize(126, "large attacks require a durable land and troop lead");
    }
    if (
      !finishMode &&
      troopCommitment >= 0.35 &&
      (relativeTroopRatio === 0 || relativeTroopRatio < 2.2) &&
      !activeCombatTarget &&
      !targetIsLeader
    ) {
      penalize(
        74,
        "large attack needs a decisive troop edge outside finish mode",
      );
    }
    if (
      !finishMode &&
      troopCommitment >= 0.25 &&
      (relativeTroopRatio === 0 || relativeTroopRatio < 1.6) &&
      !targetIsLeader &&
      !stickyWinningFront &&
      !dominantHardNationLargestRivalAttack &&
      !hardNationWeakSideConquestAttack &&
      !hardNationRaceFinishAttack
    ) {
      penalize(
        46,
        "medium attack needs a clear troop edge outside finish mode",
      );
    }
    if (unsafeMediumCounterattackAgainstLargerRival) {
      penalize(132, "medium counterattack needs edge against a larger rival");
    }
    if (hardNationEarlyMultiFrontMediumTrade) {
      penalize(
        168,
        "early multi-front hard-nation trades need a decisive edge",
      );
    }
    if (hardNationReserveDrainingCleanup) {
      penalize(
        132,
        "tiny cleanup attack must preserve reserves for the hard-nation leader",
      );
    }
    if (unsafeLargeCounterattackAgainstLargerRival) {
      penalize(
        158,
        "large counterattack needs decisive edge against a larger rival",
      );
    }
    if (frontSwitchWhileCurrentWarIsFavorable) {
      penalize(132, "finish favorable current war before switching fronts");
    }
    if (strongerLeaderTradeBeforeSideConquest) {
      penalize(
        146,
        "grow through weaker rival before trading into stronger leader",
      );
    }
    if (
      troopRatio < settings.triggerRatio &&
      !targetIsLeader &&
      !finishMode &&
      !dominantConversionMode &&
      !frontierConversionReadyAttack &&
      !frontierFinishPressureAttack &&
      !sideConquestAttack &&
      !hardNationWeakSideConquestAttack &&
      !hardNationRaceFinishAttack &&
      !finishableRivalAttack
    ) {
      penalize(72, "troop ratio is below attack trigger");
    }
    if (
      troopRatio < 0.42 &&
      !finishMode &&
      !dominantConversionMode &&
      !frontierConversionReadyAttack &&
      !frontierFinishPressureAttack &&
      !leaderBreakthroughAttack &&
      !decisiveFinishableRivalAttack &&
      !incomingLeaderDefensiveProbe &&
      !leaderContainmentProbe &&
      !leaderContainmentStrike &&
      !hardNationLeaderAttackWaveContinuation &&
      !dominantHardNationLargestRivalAttack &&
      !hardNationRaceFinishAttack
    ) {
      penalize(
        62,
        "attack would deplete the reserve below competitive defense",
      );
    }
    if (
      observation.strategic.priority === "build_defense" &&
      observation.strategic.urgency !== "low" &&
      !targetIsLeader &&
      !incomingAttackTarget &&
      !stickyWinningFront &&
      !dominantHardNationLargestRivalAttack
    ) {
      penalize(42, "urgent defense state makes non-leader attacks too risky");
    }
    if (
      outgoingWars >= settings.maxConcurrentWars &&
      !activeCombatTarget &&
      !dominantConversionMode
    ) {
      penalize(48, "max concurrent wars already reached");
    }
    if (offFocusCommittedWarAttack) {
      penalize(132, "finish current war before opening another front");
    }
  }
  const staleHardNationOpeningPressure =
    hardNationScrum &&
    input.plan.objective === "expand_territory" &&
    neutralGrowthAvailable &&
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    target !== null &&
    !targetIsLeader &&
    ownTiles >= 12_000 &&
    ownTiles < 24_000 &&
    observation.memory.recentExpansionCount >= 2 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.28 &&
    relativeTroopRatio >= 1.15 &&
    target.troops <= ownTroops * 0.92 &&
    (targetTiles === 0 || targetTiles <= ownTiles * 1.55) &&
    !criticalBorderCollapse;
  if (
    input.plan.objective === "expand_territory" &&
    neutralGrowthAvailable &&
    isHostilePressureAction(action) &&
    !isNeutralGrowthAction(action)
  ) {
    if (staleHardNationOpeningPressure) {
      add(
        "combat",
        troopCommitment <= 0.12 ? 64 : 46,
        "stale hard-nation opening should pressure a favorable border",
      );
    } else if (
      borderedPressureExpansionStale &&
      ownTiles >= 20_000 &&
      isDirectConquestAction(action) &&
      troopCommitment <= 0.12
    ) {
      add(
        "combat",
        32,
        "stale bordered expansion can use a small direct border probe",
      );
    } else {
      penalize(
        86,
        "expansion plan should not mix hostile pressure while neutral growth is legal",
      );
    }
  }
  if (
    frontierConversionTiming?.recommended === true &&
    isNeutralGrowthAction(action)
  ) {
    penalize(
      72,
      "frontier conversion ready target should outrank neutral growth",
    );
  }
  if (
    frontierFinishPressure?.recommended === true &&
    (frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0 &&
    isNeutralGrowthAction(action)
  ) {
    penalize(
      88,
      "frontier finish pressure should convert the weak rival before more neutral growth",
    );
  }
  if (action.kind === "embargo" || action.kind === "embargo_all") {
    add(
      "combat",
      targetIsLeader || action.kind === "embargo_all" ? 42 : 28,
      "embargo applies pressure without spending troops",
    );
    if (hardNationEconomyAvailable && !leaderPressure) {
      penalize(
        action.kind === "embargo_all" ? 50 : 36,
        "hard-nation match should spend safe gold before symbolic pressure",
      );
    }
    if (forcedCrowdedOpeningExpansion) {
      penalize(
        118,
        "crowded hard-nation opening needs land before pressure-only embargoes",
      );
    }
    if (shouldDiversifyExpansion) {
      add("combat", 18, "embargo breaks a repeated neutral-expansion streak");
    }
    if (earlyNeutralExpansion) {
      penalize(
        88,
        "early neutral expansion should not be diluted by pressure actions",
      );
    }
    if (dominantConversionMode && favorableHostileAttackAvailable) {
      penalize(
        action.kind === "embargo_all" ? 70 : 46,
        "dominant conversion should use favorable attacks before pressure-only embargoes",
      );
    }
    if (navalConversionMode && activeTransportCount === 0) {
      penalize(
        action.kind === "embargo_all" ? 56 : 38,
        "naval conversion should move troops before pressure-only embargoes",
      );
    }
  }
  if (action.kind === "target_player") {
    add(
      "combat",
      targetIsLeader ? 38 : 22,
      "target mark focuses future pressure",
    );
    if (hardNationEconomyAvailable && !leaderPressure) {
      penalize(
        42,
        "hard-nation match should spend safe gold before symbolic pressure",
      );
    }
    if (forcedCrowdedOpeningExpansion) {
      penalize(
        118,
        "crowded hard-nation opening needs land before target marks",
      );
    }
    if (earlyNeutralExpansion) {
      penalize(
        88,
        "early neutral expansion should not be diluted by pressure actions",
      );
    }
    if (dominantConversionMode && favorableHostileAttackAvailable) {
      penalize(
        38,
        "dominant conversion should attack favorable borders before target marks",
      );
    }
    if (navalConversionMode && activeTransportCount === 0) {
      penalize(
        34,
        "naval conversion should launch transport before target marks",
      );
    }
  }
  if (isPressureOnlySignalAction(action)) {
    if (frontierConversionTiming?.recommended === true) {
      penalize(
        84,
        "frontier conversion ready target should outrank pressure-only actions",
      );
    }
    if (
      frontierFinishPressure?.recommended === true &&
      (frontierFinishPressure.decisiveAttackActionCount ?? 0) > 0
    ) {
      penalize(
        90,
        "frontier finish pressure should attack before pressure-only actions",
      );
    }
    if (
      hardNationScrum &&
      ownTiles > 0 &&
      ownTiles < 20_000 &&
      !finishMode &&
      !dominantConversionMode &&
      !hardNationLeaderAllianceBreak &&
      !hardNationChallengerAllianceBreak &&
      !hardNationWeakFrontierAllianceBreak &&
      !hardNationDominantAllianceBreak
    ) {
      penalize(
        190,
        "boxed hard-nation opening should not escalate pressure before a land base",
      );
    }
    if (frontSwitchWhileCurrentWarIsFavorable) {
      penalize(92, "finish favorable current war before switching fronts");
    }
    if (strongerLeaderTradeBeforeSideConquest) {
      penalize(
        104,
        "grow through weaker rival before trading into stronger leader",
      );
    }
    if (overlargeLeaderPressure) {
      penalize(
        96,
        "urgent defense should grow before challenging an overlarge leader",
      );
    }
  }
  if (isPressureOnlySignalAction(action) && criticalBorderCollapse) {
    penalize(
      130,
      "critical border collapse should use survival actions before symbolic pressure",
    );
  }
  if (action.kind === "break_alliance") {
    if (agentOnlyPoliticalMatch(observation)) {
      const targetTileShare = target?.tileShare ?? 0;
      add(
        "combat",
        targetIsLeader
          ? 260
          : targetTileShare >= Math.max(0.12, ownTileShare * 0.45)
            ? 224
            : 188,
        "agent-only political theatre breaks fragile pact for drama and endgame leverage",
      );
    }
    if (
      hardNationScrum &&
      targetIsLeader &&
      aliveVisibleOpponentCount(observation) > 2 &&
      actionPlayerID !== input.plan.targetPlayerId &&
      !hardNationLeaderAllianceBreak
    ) {
      penalize(
        260,
        "hard-nation multi-rival leader break must follow active plan",
      );
    }
    add(
      "combat",
      targetIsLeader ? 44 : 10,
      "breaking alliance is only attractive against a leader",
    );
    if (hardNationLeaderAllianceBreak) {
      add(
        "combat",
        176,
        "break leader alliance before a hard-nation snowball becomes unwinnable",
      );
    }
    if (hardNationChallengerAllianceBreak) {
      add(
        "combat",
        188,
        "break rising challenger alliance before it overtakes the hard-nation leader",
      );
    }
    if (hardNationWeakFrontierAllianceBreak) {
      add(
        "combat",
        222,
        "break weak frontier alliance for hard-nation growth race",
      );
    }
    if (hardNationDominantAllianceBreak) {
      add(
        "combat",
        218,
        "break dominant alliance to force hard-nation endgame conquest",
      );
    }
    if (
      !hardNationLeaderAllianceBreak &&
      !hardNationChallengerAllianceBreak &&
      !hardNationWeakFrontierAllianceBreak &&
      !hardNationDominantAllianceBreak &&
      !finishMode &&
      aliveVisibleOpponentCount(observation) > 1
    ) {
      penalize(
        targetIsLeader ? 126 : 104,
        "multi-rival matches should keep alliances until the endgame",
      );
    }
    if (
      !finishMode &&
      target !== null &&
      ownTileShare < 0.5 &&
      targetTileShare >= ownTileShare * 0.85
    ) {
      if (
        !hardNationLeaderAllianceBreak &&
        !hardNationChallengerAllianceBreak &&
        !hardNationWeakFrontierAllianceBreak &&
        !hardNationDominantAllianceBreak
      ) {
        penalize(82, "breaking a comparable alliance opens a losing front");
      }
    }
    if (
      !targetIsLeader &&
      !hardNationChallengerAllianceBreak &&
      !hardNationWeakFrontierAllianceBreak &&
      !hardNationDominantAllianceBreak
    ) {
      penalize(96, "do not break non-leader alliances");
    }
  }

  if (action.kind === "boat") {
    const boatTargetsPlayer = typeof action.metadata?.targetID === "string";
    if (transportTroopBankingAction) {
      const launchTroops = transportTroopBankingLaunchTroops(
        action,
        transportTroopBanking,
      );
      const launchRatio =
        transportTroopBanking.largestAvailableBoatLaunchTroops <= 0
          ? 1
          : launchTroops /
            transportTroopBanking.largestAvailableBoatLaunchTroops;
      add(
        "naval",
        116 + Math.round(Math.min(1, launchRatio) * 34),
        "transport troop-banking converts capped population into future force",
      );
      if (launchRatio < 0.75) {
        penalize(
          28,
          "transport troop-banking should prefer the largest safe launch",
        );
      }
    }
    add(
      "naval",
      boatTargetsPlayer
        ? navalConversionMode
          ? targetIsLeader
            ? 92
            : 78
          : targetIsLeader
            ? 24
            : 12
        : 52,
      "transport creates naval expansion or invasion",
    );
    if (boatTargetsPlayer && navalConversionMode) {
      add(
        "combat",
        26,
        "naval invasion is the available path back to conquest",
      );
      const relativeTroopRatio = target?.relativeTroopRatio ?? 0;
      if (relativeTroopRatio >= 1.4 || targetIsLeader) {
        add("naval", 18, "transport targets a favorable or leading rival");
      }
      if (troopCommitment >= 0.16 && troopCommitment <= 0.28) {
        add(
          "naval",
          24,
          "late-game naval conversion needs a meaningful landing force",
        );
      } else if (troopCommitment > 0 && troopCommitment < 0.12) {
        penalize(20, "late-game naval probe is too small to convert a lead");
      }
    }
    if (hardNationSideInvasionTransport) {
      add(
        "naval",
        96,
        "hard-nation side transport opens a safer conquest front",
      );
      add(
        "combat",
        42,
        "side invasion avoids feeding the hard-nation leader directly",
      );
    }
    if (boatTargetsPlayer) {
      const relativeTroopRatio = target?.relativeTroopRatio ?? 0;
      if (
        observation.combat.attackablePlayerIDs.length > 0 &&
        !hardNationSideInvasionTransport
      ) {
        penalize(
          112,
          "land attacks are available; do not dilute pressure with transports",
        );
      }
      if (
        targetID !== null &&
        targetHasLandContact(observation, targetID) &&
        !finishMode &&
        !dominantConversionMode
      ) {
        penalize(
          150,
          "land-contact rival should be attacked from the border instead of by transport",
        );
      }
      if (
        observation.memory.repeatedActionKind === "boat" &&
        observation.memory.repeatedActionCount >= 2
      ) {
        penalize(
          86,
          "repeated transport launches should pause for land pressure",
        );
      }
      if (activeTransportCount >= 3) {
        penalize(88, "existing transports should land before launching more");
      } else if (activeTransportCount >= 1) {
        penalize(
          32,
          "avoid transport spam while an invasion is already active",
        );
      }
      if (
        !navalConversionMode &&
        !finishMode &&
        !hardNationSideInvasionTransport &&
        (ownTileShare < 0.45 ||
          (relativeTroopRatio > 0 && relativeTroopRatio < 1.25))
      ) {
        penalize(95, "naval invasion lacks enough map control or troop edge");
      }
      if (
        input.input.legalActions.some(
          (candidate) =>
            candidate.kind === "attack" &&
            candidate.metadata?.expansion === true,
        )
      ) {
        penalize(
          36,
          "neutral land expansion is safer than a transport invasion",
        );
      }
    }
  }
  if (action.kind === "warship") {
    add("naval", 48, "warship protects ports and hunts transports");
  }
  if (action.kind === "move_warship") {
    add("naval", 42, "warship movement responds to sea-lane targets");
  }
  if (action.kind === "boat_retreat") {
    add("naval", 36, "transport retreat saves embarked troops");
    if (shouldProtectFreshEscapeTransport(input.input, action)) {
      penalize(190, "fresh escape transport should land before retreating");
    }
    if (incomingCount === 0) {
      penalize(
        72,
        "transport retreat without immediate pressure can create a naval loop",
      );
    }
  }

  if (action.kind === "nuke") {
    if (!settings.lateGameStrikeTargetingEnabled) {
      penalize(220, "late-game strike targeting experiment disabled");
    } else {
      const strikePriority = nuclearStrikePriority(observation, action);
      add(
        "nuclear_endgame",
        (targetIsLeader || !ownIsLeader ? 74 : 38) +
          Math.round(strikePriority * 0.32),
        "nuclear action can break leader structures or close endgame",
      );
      const targetStructureUnit = metadataString(action, "targetStructureUnit");
      if (targetStructureUnit === UnitType.MissileSilo) {
        add("nuclear_endgame", 52, "nuke disables enemy counterstrike silo");
      } else if (targetStructureUnit === UnitType.SAMLauncher) {
        add("nuclear_endgame", 48, "nuke clears enemy air defense coverage");
      } else if (
        targetStructureUnit === UnitType.City ||
        targetStructureUnit === UnitType.Factory ||
        targetStructureUnit === UnitType.Port
      ) {
        add("nuclear_endgame", 24, "nuke hits valuable enemy economy");
      }
      if (
        metadataNumber(action, "targetSamCoverage") > 0 &&
        targetStructureUnit !== UnitType.SAMLauncher
      ) {
        penalize(
          18,
          "target is under SAM coverage; prefer air-defense or silo targets first",
        );
      }
      if (recentAcceptedActionKind(observation, "nuke", 8)) {
        penalize(46, "recent nuke should land before another strike");
      }
    }
  }
  if (
    action.kind === "build" &&
    metadataString(action, "unit") === UnitType.SAMLauncher
  ) {
    const infrastructurePriority = nuclearInfrastructurePriority(
      observation,
      action,
      input.input.legalActions,
    );
    if ((observation.ownState?.tileShare ?? 0) >= settings.samTileShareRatio) {
      add(
        "nuclear_endgame",
        36,
        "SAM coverage protects a meaningful tile share",
      );
    }
    if (infrastructurePriority > 0) {
      add(
        "nuclear_endgame",
        Math.round(infrastructurePriority * 0.55),
        "human replay timing favors SAM coverage before nuclear exchanges",
      );
    }
  }
  if (
    action.kind === "build" &&
    metadataString(action, "unit") === UnitType.MissileSilo
  ) {
    const infrastructurePriority = nuclearInfrastructurePriority(
      observation,
      action,
      input.input.legalActions,
    );
    if ((observation.ownState?.tileShare ?? 0) >= settings.siloTileShareRatio) {
      add(
        "nuclear_endgame",
        44,
        "silo ratio target reached for endgame weapons",
      );
    }
    if (infrastructurePriority > 0) {
      add(
        "nuclear_endgame",
        Math.round(infrastructurePriority * 0.58),
        "human replay timing favors first missile silo after economy foundation",
      );
    }
  }

  if (action.kind === "delete_unit") {
    add(
      "utility_social",
      input.plan.preferredActionKinds.includes("delete_unit") ? 42 : 18,
      "delete can clear a bad or doomed structure",
    );
    penalize(
      input.plan.preferredActionKinds.includes("delete_unit") ? 12 : 28,
      "delete_unit is destructive unless scenario-specific",
    );
  }
  if (action.kind === "quick_chat" || action.kind === "emoji") {
    add("utility_social", 8, "social action is legal and cheap");
    if (
      action.kind === "quick_chat" &&
      action.metadata?.nuclearThreat === true
    ) {
      add(
        "nuclear_endgame",
        20,
        "nuclear deterrence threat targets a larger rival",
      );
    }
  }
  if (action.kind === "hold") {
    add("utility_social", 6, "hold remains a legal fallback");
    if (
      settings.openingExpansionTempoEnabled &&
      openingExpansionTempo?.recommended === true &&
      neutralGrowthAvailable
    ) {
      penalize(64, "opening tempo cannot stall while neutral growth is legal");
    }
    if (forcedCrowdedOpeningExpansion) {
      penalize(
        38,
        "crowded hard-nation opening cannot stall while growth is legal",
      );
    }
    if (
      activeTransportCount > 0 &&
      observation.combat.attackablePlayerIDs.length === 0
    ) {
      add(
        "naval",
        24,
        "wait for active transport to land before launching more troops",
      );
    }
    if (
      settings.transportTroopBankingEnabled &&
      transportTroopBanking.recommended
    ) {
      penalize(
        72,
        "transport troop-banking should not wait while capped growth is wasted",
      );
    }
    if (executorReadyWeakRivalPressure) {
      penalize(
        104,
        "executor-ready weak-rival pressure should attack instead of holding",
      );
    }
    if (
      settings.personalityDiplomacyPressureEnabled &&
      personalityDiplomacyPressure?.recommended === true
    ) {
      penalize(
        34,
        "personality diplomacy pressure has a legal story beat available",
      );
    }
  }

  if (input.plan.preferredActionKinds.includes(action.kind)) {
    add("utility_social", 22, "matches slow planner preferred action kind");
  }
  if (input.plan.forbiddenActionKinds.includes(action.kind)) {
    penalize(52, "slow planner forbids this action kind");
  }
  if (actionPlayerID !== null && actionPlayerID === input.plan.targetPlayerId) {
    add("utility_social", 14, "matches slow planner target");
  }
  const planTargetHostileAttacks =
    input.plan.targetPlayerId === null
      ? []
      : input.input.legalActions.filter(
          (candidate) =>
            actionTargetsPlayer(candidate, input.plan.targetPlayerId!) &&
            isHostileLandAttack(candidate),
        );
  const bestPlanTargetRelativeTroopRatio = Math.max(
    0,
    ...planTargetHostileAttacks.map((candidate) =>
      metadataNumber(candidate, "relativeTroopRatio"),
    ),
  );
  const planTargetHasDecisiveHostileAttack = planTargetHostileAttacks.some(
    (candidate) =>
      actionIsFavorableHostileAttack(candidate) &&
      metadataNumber(candidate, "relativeTroopRatio") >= 1.35,
  );
  const planTargetIsIncomingAttack =
    input.plan.targetPlayerId !== null &&
    (incomingAttackPlayerIDs.has(input.plan.targetPlayerId) ||
      (observation.combat.incomingAttacks ?? []).some(
        (attack) => attack.targetID === input.plan.targetPlayerId,
      ));
  const staleDefenseFocusBreakout =
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    action.kind === "attack" &&
    action.metadata?.expansion !== true &&
    !targetIsLeader &&
    ownTiles >= 30_000 &&
    relativeTroopRatio >= 1.35 &&
    troopCommitment > 0 &&
    troopCommitment <= 0.3;
  const staleFocusFavorableAttack =
    staleDefenseFocusBreakout ||
    (actionIsFavorableHostileAttack(action) &&
      (!planTargetHasDecisiveHostileAttack ||
        relativeTroopRatio >= 1.9 ||
        (planTargetIsIncomingAttack && relativeTroopRatio >= 1.75) ||
        (relativeTroopRatio >= 1.75 &&
          relativeTroopRatio >= bestPlanTargetRelativeTroopRatio + 0.45)));
  if (
    input.plan.targetPlayerId !== null &&
    input.plan.objective !== "expand_territory" &&
    actionPlayerID !== null &&
    actionPlayerID !== input.plan.targetPlayerId &&
    isHostilePressureAction(action) &&
    !staleFocusFavorableAttack &&
    !leaderPressureAttackOverridesFocus &&
    !sideConquestAttack &&
    !committedWarAttack &&
    !(dominantConversionMode && actionIsFavorableHostileAttack(action))
  ) {
    penalize(64, "hostile action does not match the active focus target");
  }

  if (
    !leavesReserve &&
    !dominantConversionMode &&
    !frontierConversionReadyAttack &&
    !frontierFinishPressureAttack &&
    !hardNationLeaderAttackWaveContinuation
  ) {
    penalize(34, "troop commitment would violate reserves");
  }
  if (action.risk.level === "high" && action.kind !== "nuke") {
    penalize(28, "high-risk legal action");
  } else if (action.risk.level === "medium") {
    penalize(10, "medium-risk legal action");
  }
  if (observation.memory.repeatedActionKind === action.kind) {
    penalize(
      Math.min(30, observation.memory.repeatedActionCount * 8),
      "recent repeated action kind",
    );
  }
  if (observation.memory.avoidActionIDs.includes(action.id)) {
    penalize(42, "exact action was recently repeated");
  }
  const planTurnIntent = resolvedPlanTurnIntent(input.input, input.plan);
  if (actionMatchesPlanTurnIntent(action, planTurnIntent)) {
    add(
      moduleForAction(action),
      24,
      `action matches planner turn intent ${planTurnIntent}`,
    );
  } else if (
    planTurnIntent === "build" &&
    action.kind === "hold" &&
    hasUsefulBuildAction(input.input.legalActions)
  ) {
    penalize(34, "build turn should not hold while useful build is legal");
  }
  if (
    action.kind === "hold" &&
    hasUsefulNonHoldAction(input.input.legalActions)
  ) {
    penalize(86, "unexplained hold while useful non-hold actions exist");
  }
  if (
    action.kind === "hold" &&
    dominantConversionMode &&
    favorableHostileAttackAvailable
  ) {
    penalize(
      88,
      "dominant conversion cannot stall while favorable attacks exist",
    );
  }

  const totalScore = clampScore(
    contributions.reduce((sum, contribution) => sum + contribution.score, 0) -
      penaltyScore,
  );
  return {
    totalScore,
    contributions: contributions.sort((a, b) => b.score - a.score).slice(0, 8),
    penalties,
    profileRepairRerank,
  };
}

function moduleWeight(
  settings: AgentSettings,
  profile: AgentStrategyProfile,
  module: FrontierPolicyModule,
): number {
  return settings.profileWeights[profile][module] ?? 1;
}

function metadataNumber(action: LegalAction, key: string): number {
  const value = action.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metadataString(action: LegalAction, key: string): string | null {
  const value = action.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function committedTroopRatio(action: LegalAction, ownTroops: number): number {
  const troopPercentage = metadataNumber(action, "troopPercentage");
  if (troopPercentage > 0 && troopPercentage <= 1) {
    return troopPercentage;
  }
  const troopPercent = metadataNumber(action, "troopPercent");
  if (troopPercent > 0) {
    return troopPercent / 100;
  }
  const troops = metadataNumber(action, "troops");
  if (troops > 0 && ownTroops > 0) {
    return troops / ownTroops;
  }
  return 0;
}

function directActionCommitment(action: LegalAction): number {
  return (
    committedTroopRatio(action, 0) || troopPercentFromActionID(action.id) / 100
  );
}

function recentOwnTileLossRatio(
  observation: AgentBrainInput["observation"],
  currentOwnTiles: number,
): number {
  const recentPeakTiles = Math.max(
    currentOwnTiles,
    ...observation.memory.recentActions
      .map((decision) => decision.ownTiles ?? 0)
      .filter((tiles) => tiles > 0),
  );
  if (recentPeakTiles <= 0 || currentOwnTiles >= recentPeakTiles) {
    return 0;
  }
  return (recentPeakTiles - currentOwnTiles) / recentPeakTiles;
}

function shouldProtectFreshEscapeTransport(
  input: AgentBrainInput,
  action: LegalAction,
): boolean {
  if (action.kind !== "boat_retreat") {
    return false;
  }
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationStrategicContext(observation)) {
    return false;
  }
  const activeRetreatOptions = observation.nonCombat.boatRetreatOptions ?? [];
  if (activeRetreatOptions.length === 0) {
    return false;
  }
  const recentTransportLaunch = recentAcceptedActionKind(
    observation,
    "boat",
    8,
  );
  const unitID = metadataNumber(action, "unitID");
  const matchedTransport =
    unitID > 0
      ? activeRetreatOptions.find((option) => option.unitID === unitID)
      : undefined;
  const activeTransportTroops =
    metadataNumber(action, "troops") ||
    matchedTransport?.troops ||
    Math.max(0, ...activeRetreatOptions.map((option) => option.troops ?? 0));
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const activeBankRatio = ownTroops > 0 ? activeTransportTroops / ownTroops : 0;
  const incomingThreatTroops = (
    observation.combat.incomingAttacks ?? []
  ).reduce((sum, attack) => sum + (attack.retreating ? 0 : attack.troops), 0);
  const incomingThreatRatio =
    ownTroops > 0 ? incomingThreatTroops / ownTroops : 0;
  const collapsingActiveEscape =
    ownState.tilesOwned < 20_000 &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    recentOwnTileLossRatio(observation, ownState.tilesOwned) >= 0.25;
  const tinyCoreUnderDirectCollapse =
    ownState.tilesOwned < 1_000 &&
    observation.strategic.priority === "build_defense" &&
    observation.strategic.urgency === "high" &&
    incomingThreatRatio >= 1;
  if (tinyCoreUnderDirectCollapse) {
    return false;
  }
  const highValueActiveTransport =
    recentTransportLaunch &&
    activeRetreatOptions.length <= 3 &&
    activeTransportTroops >= 50_000 &&
    activeBankRatio >= 0.12 &&
    activeBankRatio <= 0.45 &&
    ownState.tilesOwned >= 3_000;
  return (
    highValueActiveTransport ||
    ((ownState.tilesOwned < 10_000 || collapsingActiveEscape) &&
      activeRetreatOptions.length <= 2 &&
      activeTransportTroops >= 20_000 &&
      activeBankRatio <= 0.35 &&
      (recentTransportLaunch ||
        ownState.tilesOwned < 1_000 ||
        incomingThreatRatio >= 0.75 ||
        observation.strategic.urgency === "high" ||
        observation.strategic.scores.threat >= 0.8))
  );
}

function troopRatioFromActionID(actionID: string | undefined): number {
  if (typeof actionID !== "string") {
    return 0;
  }
  const match = actionID.match(/:(10|25|40)$/);
  return match === null ? 0 : Number(match[1]) / 100;
}

function isDefensiveAction(action: LegalAction): boolean {
  return (
    action.kind === "warship" ||
    action.kind === "move_warship" ||
    action.kind === "retreat" ||
    action.kind === "boat_retreat" ||
    ((action.kind === "build" || action.kind === "upgrade_structure") &&
      (action.metadata?.role === "defensive" ||
        isDefenseUnit(metadataString(action, "unit"))))
  );
}

function defensePolicyScore(action: LegalAction): number {
  if (!isDefensePostAction(action)) {
    return 58;
  }
  const defensiveValue = metadataNumber(action, "defensiveValue");
  const frontierValue = metadataNumber(action, "frontierValue");
  const incoming = action.metadata?.nearbyIncomingAttack === true;
  return Math.min(
    88,
    34 + defensiveValue * 42 + frontierValue * 18 + (incoming ? 18 : 0),
  );
}

function defensePolicyReason(action: LegalAction): string {
  if (isDefensePostAction(action)) {
    const reason = action.metadata?.buildPlacementReason;
    return typeof reason === "string"
      ? reason
      : "Defense Post covers a proven hostile frontier";
  }
  return "defensive build or patrol reduces border risk";
}

function isPoorDefensePostAction(action: LegalAction): boolean {
  if (!isDefensePostAction(action) || !hasBuildPlacementMetadata(action)) {
    return false;
  }
  const defensiveValue = metadataNumber(action, "defensiveValue");
  const nearbyEnemyCount = metadataNumber(action, "nearbyEnemyCount");
  const hostileBorderDistance = metadataNumber(action, "hostileBorderDistance");
  return (
    action.metadata?.nearbyIncomingAttack !== true &&
    nearbyEnemyCount === 0 &&
    defensiveValue < 0.28 &&
    (hostileBorderDistance === 0 || hostileBorderDistance > 60)
  );
}

function isDefensePostAction(action: LegalAction): boolean {
  const unit = metadataString(action, "unit");
  return unit === "Defense Post" || unit === "DefensePost";
}

function hasBuildPlacementMetadata(action: LegalAction): boolean {
  return (
    action.metadata?.defensiveValue !== undefined ||
    action.metadata?.frontierValue !== undefined ||
    action.metadata?.hostileBorderDistance !== undefined
  );
}

function isDefenseUnit(unit: string | null): boolean {
  return (
    unit === "DefensePost" ||
    unit === "Defense Post" ||
    unit === "SAMLauncher" ||
    unit === UnitType.SAMLauncher ||
    unit === "Warship"
  );
}

function isEconomicUnit(unit: string | null): boolean {
  return unit === "City" || unit === "Factory" || unit === "Port";
}

function ownUnitCount(
  observation: AgentBrainInput["observation"],
  unit: UnitType,
): number {
  return observation.ownState?.unitCounts?.[unit] ?? 0;
}

function hasUsefulNonHoldAction(legalActions: LegalAction[]): boolean {
  return legalActions.some(
    (action) => action.kind !== "hold" && action.risk.level !== "high",
  );
}

function frontierActionTieBreak(action: LegalAction): number {
  const order: Partial<Record<LegalActionKind, number>> = {
    spawn: 0,
    retreat: 1,
    boat_retreat: 2,
    attack: 3,
    boat: 4,
    build: 5,
    upgrade_structure: 6,
    alliance_request: 7,
    alliance_extend: 8,
    donate_troops: 9,
    donate_gold: 10,
    embargo: 11,
    embargo_all: 12,
    target_player: 13,
    warship: 14,
    move_warship: 15,
    nuke: 16,
    embargo_stop: 17,
    alliance_reject: 18,
    break_alliance: 19,
    quick_chat: 20,
    emoji: 21,
    delete_unit: 22,
    hold: 99,
  };
  return order[action.kind] ?? 50;
}

function frontierActionIntensityTieBreak(
  a: LegalAction,
  b: LegalAction,
): number {
  if (a.kind !== b.kind) {
    return 0;
  }
  if (a.kind === "spawn") {
    return spawnQuality(b) - spawnQuality(a);
  }
  if (a.kind === "attack") {
    const aCommitment = committedTroopRatio(a, 1);
    const bCommitment = committedTroopRatio(b, 1);
    if (a.metadata?.expansion === true && b.metadata?.expansion === true) {
      return bCommitment - aCommitment;
    }
    const aRunawayPressure =
      a.metadata?.expansion !== true &&
      metadataNumber(a, "targetTileShare") >= 0.68;
    const bRunawayPressure =
      b.metadata?.expansion !== true &&
      metadataNumber(b, "targetTileShare") >= 0.68;
    if (aRunawayPressure !== bRunawayPressure) {
      return aRunawayPressure ? -1 : 1;
    }
    const relativeTroopRatio =
      metadataNumber(a, "relativeTroopRatio") ||
      metadataNumber(b, "relativeTroopRatio");
    const incomingCounterattack =
      a.metadata?.incomingAttack === true ||
      b.metadata?.incomingAttack === true;
    const smallestTargetShare = Math.min(
      ...[
        metadataNumber(a, "targetTileShare"),
        metadataNumber(b, "targetTileShare"),
      ].filter((share) => share > 0),
    );
    const tinyFinishPocket =
      Number.isFinite(smallestTargetShare) &&
      smallestTargetShare <= 0.02 &&
      relativeTroopRatio >= 2;
    const desiredCommitment = tinyFinishPocket
      ? 0.4
      : incomingCounterattack && relativeTroopRatio >= 0.5
        ? 0.25
        : relativeTroopRatio >= 2
          ? 0.4
          : relativeTroopRatio >= 1.15
            ? 0.25
            : 0.1;
    return (
      Math.abs(aCommitment - desiredCommitment) -
      Math.abs(bCommitment - desiredCommitment)
    );
  }
  return 0;
}

function spawnQuality(action: LegalAction): number {
  const safetyScore = metadataNumber(action, "safetyScore");
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safetyScore - 0.32) / 0.24);
  const localLandScore = metadataNumber(action, "localLandScore");
  const lowSafetyPenalty =
    safetyScore < 0.18
      ? (0.18 - safetyScore) * 2.4 + 0.16
      : safetyScore < 0.23
        ? (0.23 - safetyScore) * 1.1
        : 0;
  return (
    metadataNumber(action, "opportunityScore") * 0.32 +
    metadataNumber(action, "pressureScore") * 0.18 +
    middleSafetyBand * 0.03 +
    localLandScore * 0.5 +
    safetyScore * 0.25 +
    metadataNumber(action, "diplomacyScore") * 0.28 -
    lowSafetyPenalty
  );
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampRatio(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value * 100) / 100));
}

function varyRatio(value: number, seed: string, width: number): number {
  const normalized = hashToUnit(seed) - 0.5;
  return clampRatio(value * (1 + normalized * width), 0.01, 1);
}

function hashToUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function choosePlanObjective(
  input: AgentBrainInput,
  profile: AgentStrategyProfile,
): AgentObjectiveKind {
  const observationObjective = input.observation.objective;
  if (input.observation.phase === "spawn") {
    return "choose_spawn";
  }
  const troopRatio =
    input.observation.combat.troopRatio ??
    input.observation.ownState?.troopRatio ??
    1;
  const incomingPressure =
    input.observation.combat.incomingAttackPlayerIDs.length > 0 ||
    (input.observation.combat.incomingAttacks?.length ?? 0) > 0;
  const hasLandRetreat = input.legalActions.some(
    (action) => action.kind === "retreat" && !isNeutralRetreatAction(action),
  );
  const hasNeutralGrowth = input.legalActions.some(isNeutralGrowthAction);
  const forceCrowdedOpeningExpansion =
    shouldForceCrowdedNationOpeningExpansion(input);
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    0;
  const ownTiles = input.observation.ownState?.tilesOwned ?? 0;
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const shouldKeepOpeningExpansion =
    hasNeutralGrowth &&
    !incomingPressure &&
    !isOneVsOneDuelMode(input.observation) &&
    aliveVisibleOpponentCount(input.observation) > 1 &&
    ownTileShare < openingExpansionTileShareLimit(profile) &&
    (input.observation.endgame?.leaderTileShare ?? 0) < 0.36;
  const dominantPressureAvailable =
    input.legalActions.some(actionIsFavorableHostileAttack) &&
    (isDominantConversionMode(input.observation) ||
      (isHardNationScrum(input.observation) &&
        ownTiles >= 50_000 &&
        ownTroops >= 800_000 &&
        aliveVisibleOpponentCount(input.observation) <= 3));
  if (
    dominantPressureAvailable &&
    (ownTiles >= 50_000 ||
      troopRatio >= defaultAgentSettings.retreatThreshold * 0.5)
  ) {
    return "pressure_rival";
  }
  if (
    !isOneVsOneFinishMode(input.observation) &&
    ((incomingPressure &&
      input.legalActions.some(
        (action) => action.kind === "retreat" || action.kind === "boat_retreat",
      )) ||
      (hasLandRetreat &&
        troopRatio < defaultAgentSettings.retreatThreshold * 0.6))
  ) {
    return "survive";
  }
  if (
    input.observation.strategic.priority === "build_defense" &&
    input.observation.strategic.urgency !== "low"
  ) {
    if (
      forceCrowdedOpeningExpansion &&
      !hasUsefulFortifyAction(input.legalActions)
    ) {
      return "expand_territory";
    }
    if (
      !hasUsefulFortifyAction(input.legalActions) &&
      hasPlayerPressureAction(input.legalActions)
    ) {
      return "pressure_rival";
    }
    return "fortify_border";
  }
  if (forceCrowdedOpeningExpansion) {
    return "expand_territory";
  }
  if (shouldPrioritizeHardNationEconomy(input)) {
    return "secure_economy";
  }
  if (
    shouldKeepOpeningExpansion &&
    (observationObjective?.kind !== "pressure_rival" ||
      (input.observation.memory.recentExpansionCount < 2 &&
        !hasPlayerPressureAction(input.legalActions)))
  ) {
    return "expand_territory";
  }
  if (hasLeaderPressureOpportunity(input)) {
    return "pressure_rival";
  }
  if (
    isNavalConversionMode(input.observation, input.legalActions) &&
    profile !== "defensive"
  ) {
    return "pressure_rival";
  }
  if (
    isDominantConversionMode(input.observation) &&
    input.legalActions.some(actionIsFavorableHostileAttack)
  ) {
    return "pressure_rival";
  }
  if (observationObjective?.status === "active") {
    if (
      observationObjective.kind === "expand_territory" &&
      input.observation.memory.recentExpansionCount >= 2 &&
      input.observation.strategic.priority !== "expand" &&
      hasPlayerPressureAction(input.legalActions)
    ) {
      return "pressure_rival";
    }
    if (
      isOneVsOneDuelMode(input.observation) &&
      hasPlayerPressureAction(input.legalActions) &&
      observationObjective.kind !== "choose_spawn" &&
      observationObjective.kind !== "survive"
    ) {
      return "pressure_rival";
    }
    if (
      observationObjective.kind === "build_alliance" &&
      (profile !== "diplomatic" ||
        aliveVisibleOpponentCount(input.observation) <= 1)
    ) {
      return hasNeutralGrowth
        ? "expand_territory"
        : input.legalActions.some(
              (action) =>
                action.kind === "attack" ||
                action.kind === "embargo" ||
                action.kind === "embargo_all" ||
                action.kind === "target_player",
            )
          ? "pressure_rival"
          : "expand_territory";
    }
    if (
      observationObjective.kind === "pressure_rival" &&
      shouldKeepOpeningExpansion &&
      input.observation.memory.recentExpansionCount < 2 &&
      !hasPlayerPressureAction(input.legalActions)
    ) {
      return "expand_territory";
    }
    return observationObjective.kind;
  }
  if (
    input.legalActions.some((action) => action.kind === "nuke") &&
    (input.observation.endgame?.leaderTileShare ?? 0) >= 0.28
  ) {
    return "pressure_rival";
  }
  if (input.observation.memory.recentExpansionCount >= 2) {
    const hasBuild = input.legalActions.some(
      (action) =>
        action.kind === "build" || action.kind === "upgrade_structure",
    );
    if (hasBuild) {
      return "secure_economy";
    }
  }
  if (
    profile === "diplomatic" &&
    aliveVisibleOpponentCount(input.observation) > 1
  ) {
    return "build_alliance";
  }
  if (profile === "defensive") {
    return "fortify_border";
  }
  if (
    input.legalActions.some(
      (action) =>
        action.kind === "attack" && action.metadata?.expansion !== true,
    )
  ) {
    return "pressure_rival";
  }
  if (
    input.legalActions.some(
      (action) =>
        (action.kind === "attack" && action.metadata?.expansion === true) ||
        isNeutralBoatAction(action),
    )
  ) {
    return "expand_territory";
  }
  return "survive";
}

function openingExpansionTileShareLimit(profile: AgentStrategyProfile): number {
  switch (profile) {
    case "aggressive":
      return 0.16;
    case "defensive":
      return 0.18;
    case "diplomatic":
      return 0.2;
    case "opportunistic":
      return 0.22;
  }
}

function strategicPlanForObjective(input: {
  objective: AgentObjectiveKind;
  turnIntent?: AgentPlanTurnIntent;
  input: AgentBrainInput;
  plannerSource: StrategicPlan["plannerSource"];
  rationale: string;
  preferredActionKinds?: LegalActionKind[];
  enabledModules?: FrontierPolicyModule[];
  maxDecisionCycles?: number;
  targetPlayerId?: string | null;
  tacticalSettings?: AgentTacticalSettings;
}): StrategicPlan {
  const preferredActionKinds =
    input.preferredActionKinds ?? preferredKinds(input.objective);
  const enabledModules =
    input.enabledModules ??
    modulesForObjectiveAndKinds(input.objective, preferredActionKinds);
  return {
    planID: `${input.input.observation.agentID}:${input.objective}:${input.input.observation.turnNumber}`,
    objective: input.objective,
    turnIntent:
      input.turnIntent ??
      choosePlanTurnIntent({
        objective: input.objective,
        input: input.input,
        preferredActionKinds,
        enabledModules,
      }),
    targetPlayerId:
      input.targetPlayerId !== undefined
        ? input.targetPlayerId
        : targetForPlan(input.input),
    rationale: input.rationale,
    startedAtTick: input.input.observation.tick,
    maxDecisionCycles: input.maxDecisionCycles ?? 3,
    successCriteria: successCriteria(input.objective),
    failureCriteria: [
      "no legal actions align with the plan",
      "repeated-action penalty becomes high",
      "agent comes under attack",
    ],
    preferredActionKinds,
    forbiddenActionKinds: forbiddenKinds(input.objective),
    enabledModules,
    ...(input.tacticalSettings !== undefined
      ? { tacticalSettings: input.tacticalSettings }
      : {}),
    plannerSource: input.plannerSource,
  };
}

function resolvedPlanTurnIntent(
  input: AgentBrainInput,
  plan: StrategicPlan,
): AgentPlanTurnIntent {
  if (
    plan.turnIntent !== undefined &&
    planTurnIntentIsActionable(input, plan.turnIntent)
  ) {
    return plan.turnIntent;
  }
  return choosePlanTurnIntent({
    objective: plan.objective,
    input,
    preferredActionKinds: plan.preferredActionKinds,
    enabledModules: plan.enabledModules ?? enabledModulesForPlan(plan),
  });
}

function planTurnIntentIsActionable(
  input: AgentBrainInput,
  turnIntent: AgentPlanTurnIntent,
): boolean {
  if (turnIntent === "build") {
    return hasUsefulBuildAction(input.legalActions);
  }
  return input.legalActions.some((action) =>
    actionMatchesPlanTurnIntent(action, turnIntent),
  );
}

function choosePlanTurnIntent(input: {
  objective: AgentObjectiveKind;
  input: AgentBrainInput;
  preferredActionKinds: readonly LegalActionKind[];
  enabledModules: readonly FrontierPolicyModule[];
}): AgentPlanTurnIntent {
  switch (input.objective) {
    case "choose_spawn":
      return "spawn";
    case "secure_economy":
      return "build";
    case "fortify_border":
      return "fortify";
    case "survive":
      return "survive";
    case "build_alliance":
      return "diplomacy";
    case "pressure_rival":
      return "pressure";
    case "expand_territory":
      break;
  }

  if (
    input.enabledModules.includes("naval") &&
    hasOnlyNavalGrowth(input.input)
  ) {
    return "naval";
  }
  const buildIsPlanned =
    input.preferredActionKinds.includes("build") ||
    input.preferredActionKinds.includes("upgrade_structure") ||
    input.enabledModules.includes("economy") ||
    input.enabledModules.includes("defense");
  if (
    buildIsPlanned &&
    hasUsefulBuildAction(input.input.legalActions) &&
    input.input.observation.memory.recentBuildCount === 0 &&
    (input.input.observation.memory.repeatedActionCount >= 2 ||
      (input.input.observation.memory.recentHoldCount ?? 0) >= 2 ||
      !hasCleanPlannerProgressAction(input.input.legalActions))
  ) {
    return "build";
  }
  return "growth";
}

function actionAlignsPlan(action: LegalAction, plan: StrategicPlan): boolean {
  if (!plan.preferredActionKinds.includes(action.kind)) {
    return false;
  }
  if (plan.forbiddenActionKinds.includes(action.kind)) {
    return false;
  }
  switch (plan.objective) {
    case "choose_spawn":
      return action.kind === "spawn";
    case "expand_territory":
      return (
        (action.kind === "attack" && action.metadata?.expansion === true) ||
        isNeutralBoatAction(action)
      );
    case "secure_economy":
      return (
        ((action.kind === "build" || action.kind === "upgrade_structure") &&
          (action.metadata?.role === "economic" ||
            action.metadata?.unit === "City" ||
            action.metadata?.unit === "Factory" ||
            action.metadata?.unit === "Port")) ||
        (action.kind === "build" &&
          action.metadata?.unit === UnitType.MissileSilo)
      );
    case "fortify_border":
      return (
        isDefensiveAction(action) ||
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "retreat" ||
        action.kind === "boat_retreat"
      );
    case "pressure_rival":
      return (
        action.kind === "embargo" ||
        action.kind === "embargo_all" ||
        action.kind === "target_player" ||
        action.kind === "alliance_reject" ||
        action.kind === "nuke" ||
        action.kind === "warship" ||
        action.kind === "move_warship" ||
        action.kind === "break_alliance" ||
        isPlayerBoatAction(action) ||
        (action.kind === "attack" && action.metadata?.expansion !== true)
      );
    case "build_alliance":
      return (
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "donate_gold" ||
        action.kind === "donate_troops" ||
        action.kind === "embargo_stop" ||
        action.kind === "quick_chat" ||
        action.kind === "emoji"
      );
    case "survive":
      return (
        action.kind === "hold" ||
        action.kind === "retreat" ||
        action.kind === "boat_retreat" ||
        action.kind === "delete_unit" ||
        isDefensiveAction(action) ||
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "embargo_stop"
      );
  }
}

function actionMatchesPlanTurnIntent(
  action: LegalAction,
  turnIntent: AgentPlanTurnIntent,
): boolean {
  switch (turnIntent) {
    case "spawn":
      return action.kind === "spawn";
    case "growth":
      return isNeutralGrowthAction(action);
    case "build":
      return action.kind === "build" || action.kind === "upgrade_structure";
    case "fortify":
      return isDefensiveAction(action) || action.kind === "retreat";
    case "pressure":
      return (
        isHostilePressureAction(action) ||
        (action.kind === "boat" && isPlayerBoatAction(action))
      );
    case "survive":
      return (
        action.kind === "hold" ||
        action.kind === "retreat" ||
        action.kind === "boat_retreat" ||
        action.kind === "delete_unit" ||
        isDefensiveAction(action)
      );
    case "diplomacy":
      return (
        action.kind === "alliance_request" ||
        action.kind === "alliance_extend" ||
        action.kind === "donate_gold" ||
        action.kind === "donate_troops" ||
        action.kind === "embargo_stop"
      );
    case "naval":
      return (
        action.kind === "boat" ||
        action.kind === "boat_retreat" ||
        action.kind === "warship" ||
        action.kind === "move_warship"
      );
  }
}

function preferredKinds(objective: AgentObjectiveKind): LegalActionKind[] {
  switch (objective) {
    case "choose_spawn":
      return ["spawn", "hold"];
    case "expand_territory":
      return ["attack", "boat", "build", "upgrade_structure", "hold"];
    case "secure_economy":
      return ["build", "upgrade_structure", "attack", "boat", "hold"];
    case "fortify_border":
      return [
        "retreat",
        "boat_retreat",
        "build",
        "warship",
        "move_warship",
        "upgrade_structure",
        "alliance_request",
        "alliance_extend",
        "hold",
      ];
    case "pressure_rival":
      return [
        "attack",
        "embargo",
        "embargo_all",
        "target_player",
        "alliance_reject",
        "nuke",
        "warship",
        "move_warship",
        "boat",
        "break_alliance",
        "build",
        "hold",
      ];
    case "build_alliance":
      return [
        "alliance_request",
        "alliance_extend",
        "donate_troops",
        "donate_gold",
        "embargo_stop",
        "quick_chat",
        "emoji",
        "hold",
      ];
    case "survive":
      return [
        "retreat",
        "boat_retreat",
        "build",
        "warship",
        "move_warship",
        "upgrade_structure",
        "delete_unit",
        "alliance_request",
        "alliance_extend",
        "embargo_stop",
        "hold",
      ];
  }
}

function forbiddenKinds(objective: AgentObjectiveKind): LegalActionKind[] {
  switch (objective) {
    case "build_alliance":
    case "fortify_border":
      return ["embargo", "embargo_all", "break_alliance", "nuke"];
    case "survive":
      return ["attack", "embargo", "embargo_all", "break_alliance", "nuke"];
    default:
      return [];
  }
}

function successCriteria(objective: AgentObjectiveKind): string[] {
  switch (objective) {
    case "choose_spawn":
      return ["agent submitted an accepted spawn intent"];
    case "expand_territory":
      return ["agent expands into neutral territory or gains tiles"];
    case "secure_economy":
      return ["agent builds an economic structure"];
    case "fortify_border":
      return ["agent builds defense or reduces diplomatic risk"];
    case "pressure_rival":
      return ["agent attacks or embargoes a valid rival"];
    case "build_alliance":
      return ["agent sends alliance or support action"];
    case "survive":
      return ["agent avoids unsafe conflict and remains alive"];
  }
}

function ruleRationale(
  objective: AgentObjectiveKind,
  input: AgentBrainInput,
): string {
  return `${objective} selected from ${input.observation.profile} profile, objective state, memory, and currently legal actions`;
}

function reusablePlanTarget(
  input: AgentBrainInput,
  previousPlan: StrategicPlan | null,
  objective: AgentObjectiveKind,
): string | null | undefined {
  if (
    objective !== "pressure_rival" ||
    previousPlan?.objective !== "pressure_rival" ||
    previousPlan.targetPlayerId === null
  ) {
    return undefined;
  }
  const previousTargetID = previousPlan.targetPlayerId;
  const targetStillVisible = input.observation.visiblePlayers.some(
    (player) => player.playerID === previousTargetID && player.isAlive,
  );
  const targetStillActionable = input.legalActions.some(
    (action) =>
      actionTargetsPlayer(action, previousTargetID) &&
      isPreferredPlanConquestAction(input, action),
  );
  if (!targetStillVisible || !targetStillActionable) {
    return undefined;
  }

  const committedWarTargetID = currentWarTargetID(input);
  if (committedWarTargetID !== null) {
    return committedWarTargetID === previousTargetID
      ? previousTargetID
      : undefined;
  }

  const sideConquestTargetID = leaderPressureSideConquestTargetID(input);
  if (sideConquestTargetID !== null) {
    return sideConquestTargetID === previousTargetID
      ? previousTargetID
      : undefined;
  }

  const leaderID = input.observation.endgame?.leaderID ?? null;
  const ownID = input.observation.ownState?.playerID ?? null;
  if (
    leaderID !== null &&
    leaderID !== ownID &&
    leaderID !== previousTargetID &&
    (input.observation.endgame?.leaderTileShare ?? 0) >= 0.34 &&
    input.legalActions.some((action) => actionTargetsPlayer(action, leaderID))
  ) {
    return undefined;
  }

  const incomingTargetID = incomingPressureTargetID(input);
  if (
    incomingTargetID !== null &&
    incomingTargetID !== previousTargetID &&
    input.legalActions.some((action) =>
      actionTargetsPlayer(action, incomingTargetID),
    )
  ) {
    return undefined;
  }

  return previousTargetID;
}

function targetForPlan(input: AgentBrainInput): string | null {
  const incomingTargetID = incomingPressureTargetID(input);
  if (
    incomingTargetID !== null &&
    input.legalActions.some((action) =>
      actionTargetsPlayer(action, incomingTargetID),
    )
  ) {
    return incomingTargetID;
  }
  const committedWarTargetID = currentWarTargetID(input);
  if (committedWarTargetID !== null) {
    return committedWarTargetID;
  }
  const sideConquestTargetID = leaderPressureSideConquestTargetID(input);
  if (sideConquestTargetID !== null) {
    return sideConquestTargetID;
  }
  const leaderID = input.observation.endgame?.leaderID ?? null;
  const ownID = input.observation.ownState?.playerID ?? null;
  if (leaderID !== null && leaderID !== ownID) {
    const leaderAction = input.legalActions.find(
      (action) =>
        actionTargetsPlayer(action, leaderID) &&
        isPreferredPlanConquestAction(input, action),
    );
    if (leaderAction !== undefined) {
      return leaderID;
    }
  }
  const weakestID = input.observation.combat.weakestAttackableTargetID;
  if (
    weakestID !== null &&
    input.legalActions.some(
      (action) =>
        actionTargetsPlayer(action, weakestID) &&
        isPreferredPlanConquestAction(input, action),
    )
  ) {
    return weakestID;
  }
  const strategicTargetID = input.observation.strategic.targetPlayerIDs[0];
  if (
    strategicTargetID !== undefined &&
    input.legalActions.some(
      (action) =>
        actionTargetsPlayer(action, strategicTargetID) &&
        isPreferredPlanConquestAction(input, action),
    )
  ) {
    return strategicTargetID;
  }
  const target =
    input.legalActions.find(
      (action) =>
        isPreferredPlanConquestAction(input, action) &&
        (typeof action.metadata?.targetID === "string" ||
          typeof action.metadata?.recipientID === "string"),
    ) ??
    input.legalActions.find(
      (action) =>
        typeof action.metadata?.targetID === "string" ||
        typeof action.metadata?.recipientID === "string",
    );
  const value = target?.metadata?.targetID ?? target?.metadata?.recipientID;
  return typeof value === "string" ? value : null;
}

function currentWarTargetID(input: AgentBrainInput): string | null {
  const outgoingWarIDs = [
    ...new Set(
      input.observation.combat.outgoingAttackPlayerIDs.filter(
        (playerID): playerID is string => typeof playerID === "string",
      ),
    ),
  ];
  if (outgoingWarIDs.length === 0) {
    return recentCombatTargetID(input);
  }
  const ownTroops =
    input.observation.combat.ownTroops ??
    input.observation.ownState?.troops ??
    0;
  const leaderID = input.observation.endgame?.leaderID ?? null;
  const candidates = outgoingWarIDs
    .map((playerID) => {
      const actions = input.legalActions.filter(
        (action) =>
          actionTargetsPlayer(action, playerID) &&
          isPreferredPlanConquestAction(input, action),
      );
      if (actions.length === 0) {
        return null;
      }
      const player =
        input.observation.visiblePlayers.find(
          (visiblePlayer) => visiblePlayer.playerID === playerID,
        ) ?? null;
      const bestRelativeTroopRatio = Math.max(
        player?.relativeTroopRatio ?? 0,
        ...actions.map((action) =>
          metadataNumber(action, "relativeTroopRatio"),
        ),
      );
      const targetTileShare =
        Math.max(
          player?.tileShare ?? 0,
          ...actions.map((action) => metadataNumber(action, "targetTileShare")),
        ) || 0;
      const bestCommitment = Math.max(
        ...actions.map((action) => committedTroopRatio(action, ownTroops)),
      );
      const favorableAction = actions.some(actionIsFavorableHostileAttack);
      const leaderPenalty =
        playerID === leaderID &&
        bestRelativeTroopRatio > 0 &&
        bestRelativeTroopRatio < 1.05
          ? 34
          : 0;
      const oversizedPenalty =
        bestCommitment >= 0.35 &&
        bestRelativeTroopRatio > 0 &&
        bestRelativeTroopRatio < 1.8
          ? 18
          : 0;
      const score =
        (favorableAction ? 80 : 0) +
        (player?.sharesBorder ? 18 : 0) +
        (player?.incomingAttack ? 24 : 0) +
        (player?.outgoingAttack ? 10 : 0) +
        Math.min(60, Math.max(0, bestRelativeTroopRatio - 1) * 30) +
        (targetTileShare > 0 ? Math.max(0, 34 - targetTileShare * 80) : 0) -
        leaderPenalty -
        oversizedPenalty;
      return { playerID, score };
    })
    .filter(
      (candidate): candidate is { playerID: string; score: number } =>
        candidate !== null,
    )
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.playerID ?? null;
}

function recentCombatTargetID(input: AgentBrainInput): string | null {
  const targetCounts = new Map<string, number>();
  const newestTargets: string[] = [];
  for (
    let index = input.observation.memory.recentActions.length - 1;
    index >= 0;
    index -= 1
  ) {
    const decision = input.observation.memory.recentActions[index];
    const targetID = decision?.targetID;
    if (
      decision?.accepted !== true ||
      decision.actionKind !== "attack" ||
      decision.expansion === true ||
      typeof targetID !== "string"
    ) {
      continue;
    }
    if (!targetCounts.has(targetID)) {
      newestTargets.push(targetID);
    }
    targetCounts.set(targetID, (targetCounts.get(targetID) ?? 0) + 1);
  }

  for (const targetID of newestTargets) {
    if ((targetCounts.get(targetID) ?? 0) < 2) {
      continue;
    }
    if (
      input.legalActions.some(
        (action) =>
          actionTargetsPlayer(action, targetID) && isHostileLandAttack(action),
      )
    ) {
      return targetID;
    }
  }
  return null;
}

function recentAcceptedTargetID(
  observation: AgentBrainInput["observation"],
  actionKinds: readonly LegalActionKind[],
  maxLookback: number,
): string | null {
  const allowedKinds = new Set(actionKinds);
  const recentActions = observation.memory.recentActions;
  const firstIndex = Math.max(0, recentActions.length - maxLookback);
  for (let index = recentActions.length - 1; index >= firstIndex; index -= 1) {
    const decision = recentActions[index];
    const targetID =
      typeof decision?.targetID === "string"
        ? decision.targetID
        : (targetIDFromActionID(decision?.actionID) ??
          targetIDFromName(observation, decision?.targetName));
    if (
      decision?.accepted !== false &&
      allowedKinds.has(decision.actionKind) &&
      typeof targetID === "string"
    ) {
      return targetID;
    }
  }
  return null;
}

function recentAcceptedActionKind(
  observation: AgentBrainInput["observation"],
  actionKind: LegalActionKind,
  maxLookback: number,
): boolean {
  const recentActions = observation.memory.recentActions;
  const firstIndex = Math.max(0, recentActions.length - maxLookback);
  for (let index = recentActions.length - 1; index >= firstIndex; index -= 1) {
    const decision = recentActions[index];
    if (decision?.accepted !== false && decision.actionKind === actionKind) {
      return true;
    }
  }
  return false;
}

function recentConsecutiveAcceptedActionKind(
  observation: AgentBrainInput["observation"],
  actionKind: LegalActionKind,
): number {
  let count = 0;
  for (
    let index = observation.memory.recentActions.length - 1;
    index >= 0;
    index -= 1
  ) {
    const decision = observation.memory.recentActions[index];
    if (decision?.accepted === false) {
      continue;
    }
    if (decision?.actionKind !== actionKind) {
      break;
    }
    count += 1;
  }
  return count;
}

function newestAcceptedDecision(
  observation: AgentBrainInput["observation"],
):
  | AgentBrainInput["observation"]["memory"]["recentActions"][number]
  | undefined {
  for (
    let index = observation.memory.recentActions.length - 1;
    index >= 0;
    index -= 1
  ) {
    const decision = observation.memory.recentActions[index];
    if (decision?.accepted !== false) {
      return decision;
    }
  }
  return undefined;
}

function weakFrontierAttackTargetID(input: AgentBrainInput): string | null {
  const observation = input.observation;
  const ownState = observation.ownState;
  if (ownState === null || !isHardNationScrum(observation)) {
    return null;
  }
  const ownID = ownState.playerID;
  const ownTileShare =
    ownState.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const ownTiles = ownState.tilesOwned;
  const ownTroops = observation.combat.ownTroops ?? ownState.troops;
  const leaderID = observation.endgame?.leaderID ?? null;
  const legalAttackTargetIDs = new Set(
    input.legalActions
      .filter(
        (action) =>
          action.kind === "attack" && action.metadata?.expansion !== true,
      )
      .map(
        (action) =>
          metadataString(action, "targetID") ?? targetIDFromActionID(action.id),
      )
      .filter(
        (targetID): targetID is string =>
          targetID !== null && targetID.length > 0,
      ),
  );
  const candidates = observation.visiblePlayers
    .filter(
      (player) =>
        player.isAlive &&
        player.playerID !== ownID &&
        player.playerID !== leaderID &&
        legalAttackTargetIDs.has(player.playerID) &&
        player.tilesOwned >= 7_000 &&
        player.tilesOwned <= ownTiles * 0.75 &&
        ((player.tileShare ?? 0) === 0 ||
          ((player.tileShare ?? 0) > 0.06 &&
            (player.tileShare ?? 0) <= Math.min(0.18, ownTileShare * 0.72))) &&
        player.troops <= ownTroops * 0.78 &&
        ((player.relativeTroopRatio ?? 0) === 0 ||
          (player.relativeTroopRatio ?? 0) >= 1.15),
    )
    .sort(
      (a, b) =>
        b.tilesOwned - a.tilesOwned ||
        (b.tileShare ?? 0) - (a.tileShare ?? 0) ||
        (b.relativeTroopRatio ?? 0) - (a.relativeTroopRatio ?? 0),
    );
  return candidates[0]?.playerID ?? null;
}

function targetIDFromActionID(actionID: string | undefined): string | null {
  if (typeof actionID !== "string") {
    return null;
  }
  const [, targetID] = actionID.split(":");
  return targetID === undefined || targetID.length === 0 ? null : targetID;
}

function troopPercentFromActionID(actionID: string | undefined): number {
  if (typeof actionID !== "string") {
    return 0;
  }
  const parts = actionID.split(":");
  const value = Number(parts[parts.length - 1]);
  return Number.isFinite(value) ? value : 0;
}

function targetIDFromName(
  observation: AgentBrainInput["observation"],
  targetName: string | undefined,
): string | null {
  if (typeof targetName !== "string") {
    return null;
  }
  return (
    observation.visiblePlayers.find((player) => player.name === targetName)
      ?.playerID ?? null
  );
}

function isPreferredPlanConquestAction(
  input: AgentBrainInput,
  action: LegalAction,
): boolean {
  if (!isDirectConquestAction(action)) {
    return false;
  }
  if (!input.legalActions.some(isHostileLandAttack)) {
    return true;
  }
  return isHostileLandAttack(action);
}

function isHostileLandAttack(action: LegalAction): boolean {
  return action.kind === "attack" && action.metadata?.expansion !== true;
}

function incomingPressureTargetID(input: AgentBrainInput): string | null {
  const incomingAttacks = [...(input.observation.combat.incomingAttacks ?? [])]
    .filter(
      (attack) =>
        attack.targetID !== null &&
        input.legalActions.some((action) =>
          actionTargetsPlayer(action, attack.targetID!),
        ),
    )
    .sort((a, b) => b.troops - a.troops);
  if (incomingAttacks[0]?.targetID !== undefined) {
    return incomingAttacks[0].targetID;
  }
  return (
    input.observation.combat.incomingAttackPlayerIDs.find((playerID) =>
      input.legalActions.some((action) =>
        actionTargetsPlayer(action, playerID),
      ),
    ) ?? null
  );
}

function hasLeaderPressureOpportunity(input: AgentBrainInput): boolean {
  const leaderID = input.observation.endgame?.leaderID ?? null;
  const ownID = input.observation.ownState?.playerID ?? null;
  if (
    leaderID === null ||
    leaderID === ownID ||
    (input.observation.endgame?.leaderTileShare ?? 0) < 0.3
  ) {
    return false;
  }
  return input.legalActions.some(
    (action) =>
      actionTargetsPlayer(action, leaderID) &&
      (action.kind === "attack" ||
        action.kind === "embargo" ||
        action.kind === "target_player" ||
        action.kind === "break_alliance" ||
        action.kind === "nuke"),
  );
}

function actionTargetsPlayer(action: LegalAction, playerID: string): boolean {
  return (
    action.metadata?.targetID === playerID ||
    action.metadata?.recipientID === playerID ||
    action.metadata?.playerID === playerID
  );
}

function plannerDecisionBrief(
  input: AgentBrainInput,
  previousPlan: StrategicPlan | null,
) {
  const observation = input.observation;
  const tactical = buildAgentTacticalAffordances({
    observation,
    legalActions: input.legalActions,
  });
  const opening = tactical?.openingExpansionTempo;
  const conversion = tactical?.frontierConversionTiming;
  const finish = tactical?.frontierFinishPressure;
  const banking = tactical?.transportTroopBanking;
  const neutralGrowthActions = input.legalActions.filter(isNeutralGrowthAction);
  const hostileAttacks = input.legalActions.filter(isHostileLandAttack);
  const buildActions = input.legalActions.filter(
    (action) => action.kind === "build" || action.kind === "upgrade_structure",
  );
  const economicBuildActions = buildActions.filter((action) =>
    isEconomicUnit(metadataString(action, "unit")),
  );
  const diplomacyActions = input.legalActions.filter((action) =>
    isPlannerDiplomacyAction(action),
  );
  const homeDanger =
    finish?.homeDanger ??
    conversion?.homeDanger ??
    opening?.homeDanger ??
    banking?.homeDanger ??
    "low";
  const pressureReadyTargetID =
    finish?.bestTargetID ?? conversion?.bestExecutorReadyTargetID ?? null;
  const pressureReady =
    homeDanger !== "high" &&
    ((finish?.recommended === true &&
      (finish.decisiveAttackActionCount ?? 0) > 0 &&
      finish.bestTargetID !== null) ||
      (conversion?.recommended === true &&
        conversion.executorReady === true &&
        conversion.bestExecutorReadyTargetID !== null));
  const growthSafe =
    neutralGrowthActions.length > 0 &&
    homeDanger !== "high" &&
    pressureReady === false;
  const noExecutableBuild =
    buildActions.length === 0 &&
    (previousPlan?.objective === "secure_economy" ||
      observation.strategic.priority === "build_economy");
  const recommendedControls = plannerRecommendedControls({
    observation,
    neutralGrowthActionCount: neutralGrowthActions.length,
    hasBoatAction: input.legalActions.some((action) => action.kind === "boat"),
    pressureReady,
    pressureReadyTargetID,
    buildActionCount: buildActions.length,
    economicBuildActionCount: economicBuildActions.length,
    homeDanger,
  });

  return {
    version: "frontier-planner-brief-v1",
    current: {
      phase: observation.phase,
      turnNumber: observation.turnNumber,
      profile: observation.profile,
      ownTiles: observation.ownState?.tilesOwned ?? null,
      ownTileShare:
        observation.ownState?.tileShare ??
        observation.endgame?.ownTileShare ??
        null,
      ownTroopRatio:
        observation.ownState?.troopRatio ?? observation.combat.troopRatio,
      strategicPriority: observation.strategic.priority,
      strategicUrgency: observation.strategic.urgency,
      homeDanger,
      previousPlan:
        previousPlan === null
          ? null
          : {
              objective: previousPlan.objective,
              turnIntent: previousPlan.turnIntent ?? null,
              targetPlayerId: previousPlan.targetPlayerId,
              maxDecisionCycles: previousPlan.maxDecisionCycles,
              enabledModules: previousPlan.enabledModules ?? null,
            },
    },
    legalActionMix: {
      counts: legalActionKindCounts(input.legalActions),
      neutralGrowthActionCount: neutralGrowthActions.length,
      hostileAttackActionCount: hostileAttacks.length,
      buildActionCount: buildActions.length,
      economicBuildActionCount: economicBuildActions.length,
      diplomacyActionCount: diplomacyActions.length,
      bestNeutralGrowthAction: summarizePlannerAction(neutralGrowthActions[0]),
      bestHostileAttackAction: summarizePlannerAction(hostileAttacks[0]),
      bestBuildAction: summarizePlannerAction(buildActions[0]),
      bestEconomicBuildAction: summarizePlannerAction(economicBuildActions[0]),
    },
    tacticalReadiness: {
      openingExpansionTempo:
        opening === undefined
          ? null
          : {
              recommended: opening.recommended,
              openingWindow: opening.openingWindow,
              ownTileShare: opening.ownTileShare,
              expectedTileShare: opening.expectedTileShare,
              leaderTileShareGap: opening.leaderTileShareGap,
              neutralLandExpansionActionCount:
                opening.neutralLandExpansionActionCount,
              neutralBoatExpansionActionCount:
                opening.neutralBoatExpansionActionCount,
              homeDanger: opening.homeDanger,
            },
      frontierConversionTiming:
        conversion === undefined
          ? null
          : {
              recommended: conversion.recommended,
              strategicWindow: conversion.strategicWindow,
              executorReady: conversion.executorReady,
              neutralExpansionActionCount:
                conversion.neutralExpansionActionCount,
              favorableHostileAttackActionCount:
                conversion.favorableHostileAttackActionCount,
              executorReadyHostileAttackActionCount:
                conversion.executorReadyHostileAttackActionCount,
              bestExecutorReadyTargetID: conversion.bestExecutorReadyTargetID,
              bestExecutorReadyTargetName:
                conversion.bestExecutorReadyTargetName,
              bestExecutorReadyRelativeTroopRatio:
                conversion.bestExecutorReadyRelativeTroopRatio,
              homeDanger: conversion.homeDanger,
            },
      frontierFinishPressure:
        finish === undefined
          ? null
          : {
              recommended: finish.recommended,
              repeatedLowCommitmentProbe: finish.repeatedLowCommitmentProbe,
              decisiveAttackActionCount: finish.decisiveAttackActionCount,
              bestTargetID: finish.bestTargetID,
              bestTargetName: finish.bestTargetName,
              bestTargetRelativeTroopRatio: finish.bestTargetRelativeTroopRatio,
              bestAttackTroopPercent: finish.bestAttackTroopPercent,
              homeDanger: finish.homeDanger,
            },
      transportTroopBanking:
        banking === undefined
          ? null
          : {
              nearCap: banking.nearCap,
              recommended: banking.recommended,
              troopRatio: banking.troopRatio,
              activeTransportCount: banking.activeTransportCount,
              largestAvailableBoatLaunchTroops:
                banking.largestAvailableBoatLaunchTroops,
              homeDanger: banking.homeDanger,
            },
    },
    plannerGuidance: {
      recommendedControls,
      recommendedPosture: plannerPostureHints({
        observation,
        growthSafe,
        pressureReady,
        pressureReadyTargetID,
        noExecutableBuild,
        buildActionCount: buildActions.length,
        homeDanger,
      }),
      targetPlayerIdPolicy: pressureReady
        ? `Use ${pressureReadyTargetID} only if choosing pressure; otherwise use null.`
        : "Use null for growth/economy/fortify plans; no pressure target is executor-ready.",
      modulePolicy:
        growthSafe && diplomacyActions.length > 0
          ? "For safe opening growth, exclude diplomacy unless the plan is explicitly build_alliance or a named alliance is needed for survival."
          : "Enable only modules that match the chosen objective; keep defense available when pressure or growth may expose borders.",
      tacticalSettingsPolicy:
        homeDanger === "high"
          ? "Raise reserveRatio and lower maxActionsPerDecision until danger falls."
          : "Keep normal reserves; lower reserveRatio only for a decisive executor-ready finish or conversion window.",
    },
  };
}

function plannerRecommendedControls(input: {
  observation: AgentObservation;
  neutralGrowthActionCount: number;
  hasBoatAction: boolean;
  pressureReady: boolean;
  pressureReadyTargetID: string | null;
  buildActionCount: number;
  economicBuildActionCount: number;
  homeDanger: string;
}) {
  const ownTileShare =
    input.observation.ownState?.tileShare ??
    input.observation.endgame?.ownTileShare ??
    0;
  if (input.observation.phase === "spawn") {
    return {
      strength: "must_follow",
      objective: "choose_spawn",
      turnIntent: "spawn",
      targetPlayerId: null,
      preferredActionKinds: ["spawn", "hold"],
      enabledModules: ["spawn_opening"],
      maxDecisionCycles: 1,
      reason: "spawn phase is active",
    };
  }
  if (input.homeDanger === "high") {
    return {
      strength: "must_follow",
      objective: "survive",
      turnIntent: "survive",
      targetPlayerId: input.pressureReadyTargetID,
      preferredActionKinds: ["retreat", "build", "attack", "hold"],
      enabledModules: ["emergency_survival", "defense", "combat"],
      maxDecisionCycles: 1,
      reason: "home danger is high",
    };
  }
  // Base-building first. An agent with essentially no territory that attacks a
  // comparable rival just bleeds troops and gets eliminated (measured: 65% of
  // decisions were pressure_rival while sitting at ~0% tile share -> dead). While
  // below the base floor and safe neutral land remains, EXPANSION is must_follow and
  // outranks the pressure gate: claim neutral land and weak tribes to build a base
  // before pressuring rivals. Uses the existing directive machinery (no prompt bloat).
  if (
    ownTileShare < tunedNumber("BASE_TILESHARE_FLOOR", 0.1) &&
    input.neutralGrowthActionCount > 0 &&
    input.homeDanger !== "high"
  ) {
    return {
      strength: "must_follow",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      preferredActionKinds: input.hasBoatAction
        ? ["attack", "boat", "hold"]
        : ["attack", "hold"],
      enabledModules: input.hasBoatAction
        ? ["expansion", "economy", "defense", "naval"]
        : ["expansion", "economy", "defense"],
      maxDecisionCycles: 2,
      reason:
        "no territorial base yet (tile share below base floor): claim neutral land and weak tribes before pressuring comparable rivals",
    };
  }
  if (input.pressureReady && input.pressureReadyTargetID !== null) {
    return {
      strength: "must_follow",
      objective: "pressure_rival",
      turnIntent: "pressure",
      targetPlayerId: input.pressureReadyTargetID,
      preferredActionKinds: ["attack", "target_player", "embargo", "hold"],
      enabledModules: ["combat", "defense", "economy"],
      maxDecisionCycles: 1,
      reason:
        "frontier conversion or finish pressure is executor-ready; do not stay on growth",
    };
  }
  if (
    input.economicBuildActionCount > 0 &&
    input.homeDanger === "low" &&
    ownTileShare >= 0.08 &&
    ownTileShare < 0.2 &&
    input.observation.memory.recentExpansionCount >= 4
  ) {
    return {
      strength: "must_follow",
      objective: "secure_economy",
      turnIntent: "build",
      targetPlayerId: null,
      preferredActionKinds: ["build", "attack", "hold"],
      enabledModules: ["economy", "defense", "expansion"],
      maxDecisionCycles: 1,
      reason:
        "low-share hard-nation run has legal economic build after sustained expansion; take economy before attack loop repeats",
    };
  }
  if (input.neutralGrowthActionCount > 0 && input.homeDanger !== "high") {
    return {
      strength: "strong_hint",
      objective: "expand_territory",
      turnIntent: "growth",
      targetPlayerId: null,
      preferredActionKinds: input.hasBoatAction
        ? ["attack", "boat", "hold"]
        : ["attack", "hold"],
      enabledModules: input.hasBoatAction
        ? ["expansion", "economy", "defense", "naval"]
        : ["expansion", "economy", "defense"],
      maxDecisionCycles: 3,
      reason:
        "safe neutral growth remains and no higher-priority pressure/build gate fired",
    };
  }
  return {
    strength: "weak_hint",
    objective: input.observation.objective?.kind ?? "secure_economy",
    turnIntent: "build",
    targetPlayerId: null,
    preferredActionKinds: ["build", "attack", "hold"],
    enabledModules: ["economy", "defense", "expansion"],
    maxDecisionCycles: 2,
    reason: "no decisive pressure or opening-growth gate fired",
  };
}

function plannerControlDirective(
  controls: ReturnType<typeof plannerRecommendedControls>,
): string {
  const prefix =
    controls.strength === "must_follow"
      ? "MUST FOLLOW"
      : controls.strength === "strong_hint"
        ? "STRONG HINT"
        : "WEAK HINT";
  return [
    `${prefix}: objective=${controls.objective}`,
    `turnIntent=${controls.turnIntent}`,
    `targetPlayerId=${controls.targetPlayerId ?? "null"}`,
    `preferredActionKinds=${controls.preferredActionKinds.join(",")}`,
    `enabledModules=${controls.enabledModules.join(",")}`,
    `maxDecisionCycles=${controls.maxDecisionCycles}`,
    `reason=${controls.reason}`,
  ].join("; ");
}

type ParsedPlannerPlan = Extract<PlannerParseResult, { ok: true }>;

function mustFollowControlViolation(
  parsed: ParsedPlannerPlan,
  controls: ReturnType<typeof plannerRecommendedControls>,
  legalActions: readonly LegalAction[],
): string | null {
  if (controls.strength !== "must_follow") {
    return null;
  }
  if (parsed.objective !== controls.objective) {
    return `objective ${parsed.objective} did not match ${controls.objective}`;
  }
  if (parsed.turnIntent !== controls.turnIntent) {
    return `turnIntent ${parsed.turnIntent} did not match ${controls.turnIntent}`;
  }
  if (parsed.targetPlayerId !== controls.targetPlayerId) {
    return `targetPlayerId ${parsed.targetPlayerId ?? "null"} did not match ${
      controls.targetPlayerId ?? "null"
    }`;
  }
  if (parsed.maxDecisionCycles !== controls.maxDecisionCycles) {
    return `maxDecisionCycles ${parsed.maxDecisionCycles} did not match ${controls.maxDecisionCycles}`;
  }
  const legalKinds = new Set(legalActions.map((action) => action.kind));
  const primaryKind = controls.preferredActionKinds.find(
    (kind): kind is LegalActionKind =>
      isLegalActionKind(kind) && legalKinds.has(kind),
  );
  if (
    primaryKind !== undefined &&
    !parsed.preferredActionKinds.includes(primaryKind)
  ) {
    return `preferredActionKinds omitted primary legal kind ${primaryKind}`;
  }
  const primaryModule = controls.enabledModules[0];
  if (
    isFrontierPolicyModule(primaryModule) &&
    !(parsed.enabledModules ?? []).includes(primaryModule)
  ) {
    return `enabledModules omitted primary module ${primaryModule}`;
  }
  return null;
}

function plannerRepairPrompt(input: {
  controls: ReturnType<typeof plannerRecommendedControls>;
  rawOutput: string;
  violation: string;
}): string {
  const controls = input.controls;
  return [
    "Your previous planner JSON contradicted a MUST FOLLOW control.",
    "Return corrected JSON only. Do not select a LegalAction.id and do not output game intents.",
    "The corrected JSON must match objective, turnIntent, targetPlayerId, maxDecisionCycles, primary preferred action kind, and primary module from MUST_FOLLOW_CONTROL.",
    "MUST_FOLLOW_CONTROL:",
    JSON.stringify(controls),
    "VIOLATION:",
    input.violation,
    "CORRECTED_JSON_TEMPLATE:",
    JSON.stringify({
      objective: controls.objective,
      turnIntent: controls.turnIntent,
      rationale: `Following must-follow planner control: ${controls.reason}.`,
      maxDecisionCycles: controls.maxDecisionCycles,
      preferredActionKinds: controls.preferredActionKinds,
      enabledModules: controls.enabledModules,
      targetPlayerId: controls.targetPlayerId,
      tacticalSettings: {
        reserveRatio: controls.objective === "survive" ? 0.45 : 0.35,
        triggerRatio: 0.55,
        expansionRatio: controls.objective === "expand_territory" ? 0.15 : 0.12,
        maxConcurrentWars: 1,
        retreatThreshold: controls.objective === "survive" ? 0.45 : 0.35,
        maxActionsPerDecision: controls.maxDecisionCycles === 1 ? 3 : 4,
      },
    }),
    "PREVIOUS_JSON:",
    input.rawOutput,
  ].join("\n");
}

function plannerPostureHints(input: {
  observation: AgentObservation;
  growthSafe: boolean;
  pressureReady: boolean;
  pressureReadyTargetID: string | null;
  noExecutableBuild: boolean;
  buildActionCount: number;
  homeDanger: string;
}): string[] {
  const hints: string[] = [];
  if (input.observation.phase === "spawn") {
    hints.push("choose_spawn/spawn until spawned");
    return hints;
  }
  if (input.homeDanger === "high") {
    hints.push("survive or fortify before voluntary growth or pressure");
  }
  if (input.pressureReady) {
    hints.push(
      `pressure_rival/pressure is allowed because executor-ready target ${input.pressureReadyTargetID} exists`,
    );
  } else {
    hints.push("do not switch to pressure; no executor-ready pressure target");
  }
  if (input.growthSafe) {
    hints.push(
      "prefer expand_territory/growth with targetPlayerId null while safe neutral growth remains",
    );
  }
  if (input.noExecutableBuild) {
    hints.push(
      "secure_economy without build actions should use growth intent and expansion/naval modules",
    );
  } else if (input.buildActionCount > 0) {
    hints.push("build/fortify intent can execute because build actions exist");
  }
  if (
    input.observation.memory.repeatedActionKind !== null &&
    input.observation.memory.repeatedActionCount >= 3
  ) {
    hints.push(
      `memory shows repeated ${input.observation.memory.repeatedActionKind}; refresh objective only if the repeated action stopped improving position`,
    );
  }
  return hints;
}

function legalActionKindCounts(
  actions: readonly LegalAction[],
): Partial<Record<LegalActionKind, number>> {
  const counts: Partial<Record<LegalActionKind, number>> = {};
  for (const action of actions) {
    counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  }
  return counts;
}

function summarizePlannerAction(action: LegalAction | undefined) {
  if (action === undefined) {
    return null;
  }
  return {
    id: action.id,
    kind: action.kind,
    risk: action.risk.level,
    targetID: metadataString(action, "targetID"),
    targetName: metadataString(action, "targetName"),
    troopPercent:
      metadataNumber(action, "troopPercentage") ||
      metadataNumber(action, "troopPercent") ||
      troopPercentFromActionID(action.id),
    relativeTroopRatio: metadataNumber(action, "relativeTroopRatio") || null,
    expansion: action.metadata?.expansion === true,
  };
}

function isPlannerDiplomacyAction(action: LegalAction): boolean {
  return (
    action.kind === "alliance_request" ||
    action.kind === "alliance_extend" ||
    action.kind === "alliance_reject" ||
    action.kind === "break_alliance" ||
    action.kind === "donate_gold" ||
    action.kind === "donate_troops" ||
    action.kind === "embargo_stop"
  );
}

function plannerPrompt(
  input: AgentBrainInput,
  previousPlan: StrategicPlan | null,
  decisionBrief = plannerDecisionBrief(input, previousPlan),
): string {
  return [
    "You are the slow planner for an AI Nations League agent.",
    "Return JSON only. Do not select a LegalAction.id and do not output game intents.",
    "Read PLANNER_DECISION_BRIEF first. It is the compact tactical summary; use the full observation only to verify details.",
    "If PLANNER_DECISION_BRIEF.plannerGuidance.recommendedControls.strength is must_follow, follow that objective/turnIntent/target/modules unless the full observation directly contradicts it.",
    "CURRENT_CONTROL_DIRECTIVE:",
    plannerControlDirective(decisionBrief.plannerGuidance.recommendedControls),
    "END_CURRENT_CONTROL_DIRECTIVE",
    "Choose one objective from: choose_spawn, expand_territory, secure_economy, fortify_border, pressure_rival, build_alliance, survive.",
    "Choose one turnIntent from: spawn, growth, build, fortify, pressure, survive, diplomacy, naval. turnIntent is the category the executor should prioritize this cycle if a matching legal action is safe.",
    "Treat tacticalAffordances as executor-readiness signals, not generic encouragement to fight. Keep growth/build/fortify unless a pressure affordance is explicitly ready.",
    "Only switch from growth to pressure for frontierConversionTiming when recommended=true, executorReady=true, bestExecutorReadyTargetID is present, and homeDanger is not high. Otherwise keep growth or economy tempo.",
    "Only switch to finish pressure when frontierFinishPressure.recommended=true and decisiveAttackActionCount is positive. Avoid repeated 10% probes when no decisive executor-ready attack exists.",
    "For growth/economy plans, set targetPlayerId to null unless the brief says a specific target is needed now.",
    "For safe opening growth, do not enable diplomacy unless a specific alliance is needed for survival or the objective is build_alliance.",
    "Choose enabledModules from: emergency_survival, spawn_opening, expansion, defense, economy, diplomacy, combat, naval, nuclear_endgame, utility_social.",
    "Include targetPlayerId and tacticalSettings for reserveRatio, triggerRatio, expansionRatio, maxConcurrentWars, retreatThreshold, and maxActionsPerDecision.",
    "OPPONENT MODELING (theory of mind): each visiblePlayers entry now carries relation, alliance status/expiry (allianceExpiresAt, allianceInExtensionWindow), pending alliance requests (hasIncoming/OutgoingAllianceRequest), embargoes (hasEmbargoAgainst), and incoming/outgoing attacks. observation.recentCommunications shows what other players just signaled (propose_alliance, coordinate_attack, warn_threat, request_support, taunt) and to whom. Use these to infer each rival's intentions, not just their troop counts: who is a dependable ally, who is likely to betray, who is coordinating against whom, and who is snowballing into the lead.",
    "DIPLOMACY: prefer build_alliance/pressure_rival objectives when an alliance protects a flank or balances a stronger rival, when a rival proposes one (hasIncomingAllianceRequest), or when two rivals are coordinating against you. Anticipate betrayal: an ally whose alliance is expiring (allianceInExtensionWindow) or who would gain by turning on you is a betrayal risk; consider pre-empting or breaking the alliance first. Politics and timely betrayal are legitimate winning play, not noise.",
    'Required JSON: {"objective":"expand_territory","turnIntent":"growth","rationale":"short reason","maxDecisionCycles":3,"preferredActionKinds":["attack"],"enabledModules":["expansion","economy","defense"],"targetPlayerId":null,"tacticalSettings":{"reserveRatio":0.35,"triggerRatio":0.55,"expansionRatio":0.15,"maxConcurrentWars":1,"retreatThreshold":0.35,"maxActionsPerDecision":4}}',
    "PLANNER_DECISION_BRIEF:",
    JSON.stringify(decisionBrief),
    "END_PLANNER_DECISION_BRIEF",
    "OPPONENT_MODEL (your persistent beliefs about each rival this game, ranked by territory; use for theory of mind — trust is 0..1, predictedNextAction is your own running guess, betrayedMe/attacksOnMe are memory of their past conduct toward you):",
    JSON.stringify(input.observation.opponentModel ?? []),
    "END_OPPONENT_MODEL",
    "FRONTIER_AGENT_SKILL:",
    frontierAgentSkill,
    "END_FRONTIER_AGENT_SKILL",
    "Observation:",
    JSON.stringify({
      profile: input.observation.profile,
      phase: input.observation.phase,
      ownState: input.observation.ownState,
      visiblePlayers: input.observation.visiblePlayers.map((player) => ({
        playerID: player.playerID,
        name: player.name,
        type: player.type,
        isAlive: player.isAlive,
        troops: player.troops,
        maxTroops: player.maxTroops,
        troopRatio: player.troopRatio,
        tilesOwned: player.tilesOwned,
        tileShare: player.tileShare,
        sharesBorder: player.sharesBorder,
        isAllied: player.isAllied,
        isFriendly: player.isFriendly,
        relation: player.relation,
        canAttack: player.canAttack,
        relativeTroopRatio: player.relativeTroopRatio,
        canRequestAlliance: player.canRequestAlliance,
        hasIncomingAllianceRequest: player.hasIncomingAllianceRequest,
        hasOutgoingAllianceRequest: player.hasOutgoingAllianceRequest,
        canBreakAlliance: player.canBreakAlliance,
        canExtendAlliance: player.canExtendAlliance,
        canRejectAlliance: player.canRejectAlliance,
        allianceExpiresAt: player.allianceExpiresAt,
        allianceInExtensionWindow: player.allianceInExtensionWindow,
        canEmbargo: player.canEmbargo,
        hasEmbargoAgainst: player.hasEmbargoAgainst,
        canStopEmbargo: player.canStopEmbargo,
        incomingAttack: player.incomingAttack,
        outgoingAttack: player.outgoingAttack,
        canDonateGold: player.canDonateGold,
        canDonateTroops: player.canDonateTroops,
        canTarget: player.canTarget,
      })),
      objective: input.observation.objective,
      endgame: input.observation.endgame,
      strategic: input.observation.strategic,
      memory: input.observation.memory,
      recentCommunications: (input.observation.recentCommunications ?? [])
        .slice(-12)
        .map((signal) => ({
          turn: signal.turnNumber,
          from: signal.senderName,
          fromID: signal.senderPlayerID ?? signal.senderAgentID,
          to: signal.recipientName ?? null,
          kind: signal.actionKind,
          intent: signal.intent,
          target: signal.targetName ?? null,
          message: signal.message ?? signal.emojiText ?? null,
          direct: signal.directToAgent,
        })),
      combat: input.observation.combat,
      tacticalAffordances: buildAgentTacticalAffordances({
        observation: input.observation,
        legalActions: input.legalActions,
      }),
      legalActions: input.legalActions.map((action) => ({
        id: action.id,
        kind: action.kind,
        label: action.label,
        metadata: action.metadata ?? {},
        risk: action.risk,
      })),
      previousPlan,
    }),
    "FINAL_DECISION_CHECK:",
    plannerControlDirective(decisionBrief.plannerGuidance.recommendedControls),
    decisionBrief.plannerGuidance.recommendedControls.strength === "must_follow"
      ? "Your JSON must match this MUST FOLLOW directive. Do not claim that an executor-ready pressure/build/survival window is absent when this directive says it is present."
      : "If this is a hint, use judgment, but keep targetPlayerId null for growth/economy/fortify.",
    "END_FINAL_DECISION_CHECK",
  ].join("\n");
}

type PlannerParseResult =
  | {
      ok: true;
      objective: AgentObjectiveKind;
      turnIntent: AgentPlanTurnIntent;
      rationale: string;
      maxDecisionCycles: number;
      preferredActionKinds: LegalActionKind[];
      enabledModules?: FrontierPolicyModule[];
      targetPlayerId: string | null;
      tacticalSettings?: AgentTacticalSettings;
    }
  | { ok: false; reason: string };

/**
 * Extract the first balanced top-level JSON object from arbitrary text (handles
 * string literals + escapes). LLM CLIs (esp. Claude) frequently wrap the plan JSON
 * in prose ("Here is the plan: {...} let me know") or append a trailing note, which
 * a strict JSON.parse rejects. Pulling out the first {...} lets a valid plan inside
 * chatter still parse, cutting planner fallbacks. Returns null if none found.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parsePlannerOutput(
  raw: string,
  legalActions: LegalAction[],
): PlannerParseResult {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    // Fall back to extracting the first balanced JSON object before giving up, so a
    // valid plan wrapped in prose / code fences / trailing notes still parses.
    const extracted =
      extractFirstJsonObject(normalized) ?? extractFirstJsonObject(raw);
    if (extracted !== null) {
      try {
        parsed = JSON.parse(extracted);
      } catch {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `planner JSON malformed: ${message}` };
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `planner JSON malformed: ${message}` };
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "planner response must be a JSON object" };
  }
  const value = parsed as Record<string, unknown>;
  if (!isObjective(value.objective)) {
    return { ok: false, reason: "planner objective is invalid" };
  }
  if (typeof value.rationale !== "string" || value.rationale.trim() === "") {
    return { ok: false, reason: "planner rationale must be a string" };
  }
  const maxDecisionCycles =
    typeof value.maxDecisionCycles === "number" &&
    Number.isFinite(value.maxDecisionCycles)
      ? Math.max(1, Math.min(8, Math.round(value.maxDecisionCycles)))
      : 3;
  const preferredActionKinds = parsePreferredKinds(
    value.preferredActionKinds,
    legalActions,
    value.objective,
  );
  const enabledModules = parseEnabledModules(
    value.enabledModules,
    value.objective,
    preferredActionKinds,
  );
  const targetPlayerId =
    typeof value.targetPlayerId === "string" &&
    value.targetPlayerId.trim() !== ""
      ? value.targetPlayerId.trim()
      : null;
  const tacticalSettings = parseTacticalSettings(value.tacticalSettings);
  const turnIntent = parseTurnIntent(
    value.turnIntent,
    value.objective,
    preferredActionKinds,
  );
  return {
    ok: true,
    objective: value.objective,
    turnIntent,
    rationale: value.rationale.trim().slice(0, 280),
    maxDecisionCycles,
    preferredActionKinds,
    enabledModules,
    targetPlayerId,
    ...(tacticalSettings !== undefined ? { tacticalSettings } : {}),
  };
}

function parseTurnIntent(
  raw: unknown,
  objective: AgentObjectiveKind,
  preferredActionKinds: readonly LegalActionKind[],
): AgentPlanTurnIntent {
  if (isPlanTurnIntent(raw)) {
    return raw;
  }
  return fallbackTurnIntentForObjective(objective, preferredActionKinds);
}

function parsePreferredKinds(
  raw: unknown,
  legalActions: LegalAction[],
  objective: AgentObjectiveKind,
): LegalActionKind[] {
  const legalKinds = new Set(legalActions.map((action) => action.kind));
  if (Array.isArray(raw)) {
    const values = raw.filter(
      (value): value is LegalActionKind =>
        isLegalActionKind(value) && legalKinds.has(value),
    );
    if (values.length > 0) {
      return [...new Set(values)];
    }
  }
  return preferredKinds(objective).filter((kind) => legalKinds.has(kind));
}

function parseEnabledModules(
  raw: unknown,
  objective: AgentObjectiveKind,
  preferredActionKinds: readonly LegalActionKind[],
): FrontierPolicyModule[] {
  if (Array.isArray(raw)) {
    const values = raw.filter(isFrontierPolicyModule);
    if (values.length > 0) {
      return [...new Set(values)];
    }
  }
  return modulesForObjectiveAndKinds(objective, preferredActionKinds);
}

function parseTacticalSettings(
  raw: unknown,
): AgentTacticalSettings | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const settings: AgentTacticalSettings = {};
  assignNumberSetting(settings, value, "reserveRatio", 0.1, 0.8);
  assignNumberSetting(settings, value, "triggerRatio", 0.2, 1);
  assignNumberSetting(settings, value, "expansionRatio", 0.05, 0.4);
  assignNumberSetting(settings, value, "retreatThreshold", 0.1, 0.8);
  assignNumberSetting(settings, value, "maxConcurrentWars", 1, 3, true);
  assignNumberSetting(settings, value, "maxActionsPerDecision", 1, 8, true);
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function assignNumberSetting(
  settings: AgentTacticalSettings,
  value: Record<string, unknown>,
  key: keyof AgentTacticalSettings,
  min: number,
  max: number,
  integer = false,
): void {
  const raw = value[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return;
  }
  const clamped = Math.max(min, Math.min(max, integer ? Math.round(raw) : raw));
  settings[key] = clamped;
}

function isObjective(value: unknown): value is AgentObjectiveKind {
  return (
    value === "choose_spawn" ||
    value === "expand_territory" ||
    value === "secure_economy" ||
    value === "fortify_border" ||
    value === "pressure_rival" ||
    value === "build_alliance" ||
    value === "survive"
  );
}

function isPlanTurnIntent(value: unknown): value is AgentPlanTurnIntent {
  return (
    value === "spawn" ||
    value === "growth" ||
    value === "build" ||
    value === "fortify" ||
    value === "pressure" ||
    value === "survive" ||
    value === "diplomacy" ||
    value === "naval"
  );
}

function fallbackTurnIntentForObjective(
  objective: AgentObjectiveKind,
  preferredActionKinds: readonly LegalActionKind[],
): AgentPlanTurnIntent {
  switch (objective) {
    case "choose_spawn":
      return "spawn";
    case "secure_economy":
      return "build";
    case "fortify_border":
      return "fortify";
    case "pressure_rival":
      return "pressure";
    case "build_alliance":
      return "diplomacy";
    case "survive":
      return "survive";
    case "expand_territory":
      return preferredActionKinds.includes("boat") ? "growth" : "growth";
  }
}

function isLegalActionKind(value: unknown): value is LegalActionKind {
  return legalActionKinds.includes(value as LegalActionKind);
}

function isFrontierPolicyModule(value: unknown): value is FrontierPolicyModule {
  return (
    value === "emergency_survival" ||
    value === "spawn_opening" ||
    value === "expansion" ||
    value === "defense" ||
    value === "economy" ||
    value === "diplomacy" ||
    value === "combat" ||
    value === "naval" ||
    value === "nuclear_endgame" ||
    value === "utility_social"
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutID = setTimeout(
          () => reject(new Error(`Planner timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutID !== undefined) {
      clearTimeout(timeoutID);
    }
  }
}
