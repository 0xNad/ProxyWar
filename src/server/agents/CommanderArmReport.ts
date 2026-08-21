import { createHash } from "node:crypto";
import { UnitType } from "../../core/game/Game";
import type { Winner } from "../../core/Schemas";
import type {
  AgentRunFinalState,
  AgentRunRosterEntry,
} from "./AgentDecisionLogWriter";
import type {
  AgentActionAuditSnapshot,
  AgentDecisionRecord,
} from "./AgentTypes";
import {
  commanderGameIDFromSeed,
  parseCommanderCanonicalGameConfig,
  type CommanderCanonicalGameConfig,
} from "./CommanderExperimentIdentity";
import {
  COMMANDER_BLOCKED_CYCLE_THRESHOLD,
  COMMANDER_OPTION_NOT_EXECUTABLE_DOMINANCE_THRESHOLD,
  summarizeCommanderFidelity,
  type CommanderFidelitySummary,
} from "./StrategicOptionFidelity";

export const COMMANDER_EXPERIMENT_SCHEMA_VERSION = 3;
export const COMMANDER_FIDELITY_THRESHOLD = 0.95;
export const COMMANDER_PREFERRED_ABSENCE_THRESHOLD = 0.05;
export const MIN_COMMANDER_PERFORMANCE_TRIPLETS = 2;
export const MAX_COMMANDER_EXPOSED_OPTIONS = 8;
export const MAX_COMMANDER_EXPOSED_PRESSURE_OPTIONS = 2;
export const COMMANDER_DELAYED_EFFECT_AUDIT_BOUND_CYCLES = 2;

export interface CommanderComponentHashes {
  sharedArchitecture: string;
  optionBuilder: string;
  stateBuilder: string;
  lifecycle: string;
  executorAndFidelity: string;
}

export interface CommanderArtifactProvenance {
  writer: "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts";
  manifestPath: string;
  decisionsPath: string;
  decisionsSha256: string;
  summaryPath: string;
  summarySha256: string;
  executedRunID: string;
  executedMatchID: string;
  executedSeed: string;
  stepsCompleted: number | null;
}

export type CommanderExperimentArm = "A" | "B" | "C";

export interface CommanderExperimentFlags {
  localSmoke: boolean;
  structuredDeals: boolean;
  freeTextMessages: boolean;
  optionExposureUsesDeterministicPreference: boolean;
  matchedOfferedOrderSpawnBallot: boolean;
  autopilotEndgameSteps: number;
  requireWinner: boolean;
}

export interface CommanderMatchedGameConfiguration {
  schemaVersion: number;
  scenario: string;
  runnerMode: "realtime" | "step-locked";
  agents: number;
  opponentBrainMode: string | null;
  planEveryDecisionSteps: number;
  runner: {
    turnsPerDecisionStep: number;
    turnsPerDecisionSchedule: number[] | null;
    maxDecisionMs: number;
    maxSteps: number;
    maxSpawnAdvanceTurns: number;
    requireWinner: boolean;
    waitForMirrorCatchup: boolean;
    autopilotEndgameSteps: number;
    replayTailTurns: number;
    matchedOfferedOrderSpawnBallot: boolean;
    variedSpawns: boolean;
  };
  selectedGameConfig: CommanderCanonicalGameConfig;
  disabledActionKinds: string[];
  rosterPolicy: string;
}

export interface CommanderArmRunInput {
  tripletID: string;
  arm: CommanderExperimentArm;
  sourceSha: string;
  sourceTreeDirty: boolean;
  /** Full sealed provider/environment/tunable treatment identity. */
  runtimeIdentitySha256: string;
  seed: string;
  runID: string;
  selectorSource:
    | "current-planner"
    | "deterministic"
    | "llm"
    | "conflict"
    | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  componentHashes: CommanderComponentHashes;
  /** Null only for an explicitly in-memory plumbing check. */
  artifactProvenance: CommanderArtifactProvenance | null;
  experimentFlags: CommanderExperimentFlags;
  gameConfiguration: CommanderMatchedGameConfiguration;
  gameConfigurationFingerprint: string;
  roster: AgentRunRosterEntry[];
  subjectAgentID: string;
  records: AgentDecisionRecord[];
  finalState: AgentRunFinalState | undefined;
  winner: Winner;
  turnCount: number;
  localSmoke: boolean;
  requireWinner: boolean;
  completed: boolean;
  autopilotEngagedAtStep: number | null;
}

export interface CommanderArmMetrics {
  wins: number;
  winnerDetermined: boolean;
  normalizedFinalTerritory: number | null;
  finalRank: number | null;
  survived: boolean | null;
  modelCalls: number;
  promptCharacters: number;
  planningLatencyMs: { total: number; mean: number | null };
  failures: {
    timeout: number;
    parse: number;
    transport: number;
    stale: number;
    invalidOption: number;
  };
  staleRejectedAttempts: number;
  staleAuthorityViolations: number;
  fallbackAuthoredPlans: number;
  fallbackStampViolations: number;
  planCount: number;
  decisionCycleCount: number;
  actionCount: number;
  eligibleOptionCount: { total: number; mean: number | null };
  exposedOptionCount: { total: number; mean: number | null };
  optionFamilyCoverage: {
    meanFamilies: number | null;
    allFourFamilyCycles: number;
  };
  omittedCandidateCount: number;
  omittedReasons: Record<string, number>;
  deterministicPreferredOptionAbsent: {
    count: number;
    opportunities: number;
    rate: number | null;
  };
  deterministicPreferredOptionStampViolations: number;
  selectedOptionDistribution: Record<string, number>;
  planDurationDecisions: {
    mean: number | null;
    byPlan: Record<string, number>;
  };
  replanReasons: Record<string, number>;
  strategicFidelity: number | null;
  fidelityCounts: {
    alignedPrimary: number;
    alignedSupport: number;
    emergency: number;
    blocked: number;
  };
  blockedDecisionCycles: {
    count: number;
    opportunities: number;
    rate: number | null;
  };
  supportActionCount: number;
  offFamilyActionViolations: number;
  laterLayerActionViolations: number;
  zeroPrimaryDecisionCycles: number;
  planIdentityViolations: number;
  batchPositionViolations: number;
  fidelityStampViolations: number;
  optionNotExecutableReplans: {
    count: number;
    opportunities: number;
    rate: number | null;
    dominates: boolean;
  };
  plansWithZeroAlignedActions: number;
  silentlyAbandonedPlans: number;
  planTransitions: {
    count: number;
    proven: number;
    violations: number;
  };
  optionAccountingViolations: number;
  planPrimaryActionViolations: number;
  planSupportActionViolations: number;
  selectorDisagreement: {
    count: number;
    opportunities: number;
    rate: number | null;
  };
  boundedOutcomeDeltasAfterDisagreement: Array<{
    planID: string;
    selectedOptionID: string;
    deterministicOptionID: string;
    horizonDecisions: number;
    observedDecisionCycles: number;
    tilesDelta: number | null;
    troopsDelta: number | null;
  }>;
  excludedFromLlmContribution: {
    fallbackDecisionCycles: number;
    fallbackActionRecords: number;
    staleDecisionCycles: number;
    autopilotDecisionCycles: number;
  };
  canonicalPathViolations: number;
  effectAudit: {
    immediateViolations: number;
    delayedConfirmed: number;
    delayedPending: number;
    delayedExpired: number;
    delayedFailed: number;
  };
}

export interface CommanderArmTripletReport {
  tripletID: string;
  integrity: { valid: boolean; invalidationReasons: string[] };
  terminalPerformanceEligibility: {
    estimand: "per-protocol";
    eligible: boolean;
    ineligibilityReasons: string[];
  };
  localSmoke: boolean;
  arms: Record<
    CommanderExperimentArm,
    Omit<CommanderArmRunInput, "records" | "finalState" | "winner"> & {
      spawnAssignments: Record<string, string>;
      derivedProvenance: CommanderDerivedPlanProvenance;
      metrics: CommanderArmMetrics;
    }
  >;
  comparisons: {
    A_vs_B: CommanderPairwiseComparison;
    B_vs_C: CommanderPairwiseComparison;
    A_vs_C: CommanderPairwiseComparison;
  };
}

export interface CommanderDerivedPlanProvenance {
  selectorSource:
    | "current-planner"
    | "deterministic"
    | "llm"
    | "conflict"
    | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  nonFallbackPlanStarts: number;
}

export interface CommanderAggregateArmMetrics {
  runs: number;
  wins: { count: number; opportunities: number; rate: number | null };
  winnersDetermined: {
    count: number;
    opportunities: number;
    rate: number | null;
  };
  survival: { count: number; opportunities: number; rate: number | null };
  normalizedFinalTerritory: {
    sum: number;
    observations: number;
    mean: number | null;
  };
  finalRank: { sum: number; observations: number; mean: number | null };
  modelCalls: number;
  planCount: number;
  decisionCycleCount: number;
  actionCount: number;
  fallbackAuthoredPlans: number;
  fidelity: {
    aligned: number;
    classifiedNonEmergency: number;
    rate: number | null;
  };
  staleRejectedAttempts: number;
  staleAuthorityViolations: number;
  autopilotDecisionCycles: number;
}

export interface CommanderArmReport {
  schemaVersion: 3;
  experimentKind: "strategic-commander-three-arm";
  status:
    | "plumbing-only"
    | "eligible-for-performance-interpretation"
    | "invalid";
  primaryCausalComparison: "B_vs_C";
  interpretation: {
    A_vs_B: string;
    B_vs_C: string;
    A_vs_C: string;
  };
  integrity: { valid: boolean; invalidationReasons: string[] };
  performanceEligibility: { eligible: boolean; reasons: string[] };
  performanceClaimsAllowed: boolean;
  localSmoke: boolean;
  tripletCount: number;
  triplets: CommanderArmTripletReport[];
  aggregate: {
    estimand: "per-protocol";
    includedTripletIDs: string[];
    excludedTripletIDs: string[];
    arms: Record<CommanderExperimentArm, CommanderAggregateArmMetrics>;
    comparisons: {
      A_vs_B: CommanderPairwiseComparison;
      B_vs_C: CommanderPairwiseComparison;
      A_vs_C: CommanderPairwiseComparison;
    };
  };
}

export interface CommanderPairwiseComparison {
  treatment: string;
  winDelta: number;
  normalizedTerritoryDelta: number | null;
  finalRankDelta: number | null;
  survivalDelta: number | null;
  caveat: string;
}

export function buildCommanderArmReport(
  runs: readonly CommanderArmRunInput[],
): CommanderArmReport {
  const grouped = exactTriplets(runs);
  const triplets = [...grouped.entries()].map(([tripletID, tripletRuns]) =>
    buildCommanderArmTripletReport(tripletID, tripletRuns),
  );
  const tripletInvalidationReasons = triplets.flatMap((triplet) =>
    triplet.integrity.invalidationReasons.map(
      (reason) => `${triplet.tripletID}: ${reason}`,
    ),
  );
  const invalidationReasons = [
    ...tripletInvalidationReasons,
    ...replicatedCorpusInvalidations(runs, triplets),
  ];
  const localSmoke = runs.some((run) => run.localSmoke);
  const valid = invalidationReasons.length === 0;
  const performanceReasons = performanceIneligibilityReasons(runs, triplets);
  const performanceClaimsAllowed = valid && performanceReasons.length === 0;
  const perProtocolTriplets = triplets.filter(isPerProtocolTripletEligible);
  const aggregateArms = {
    A: aggregateArmMetrics(
      perProtocolTriplets.map((triplet) => triplet.arms.A.metrics),
    ),
    B: aggregateArmMetrics(
      perProtocolTriplets.map((triplet) => triplet.arms.B.metrics),
    ),
    C: aggregateArmMetrics(
      perProtocolTriplets.map((triplet) => triplet.arms.C.metrics),
    ),
  } satisfies Record<CommanderExperimentArm, CommanderAggregateArmMetrics>;
  return {
    schemaVersion: COMMANDER_EXPERIMENT_SCHEMA_VERSION,
    experimentKind: "strategic-commander-three-arm",
    status: !valid
      ? "invalid"
      : performanceClaimsAllowed
        ? "eligible-for-performance-interpretation"
        : "plumbing-only",
    primaryCausalComparison: "B_vs_C",
    interpretation: {
      A_vs_B:
        "Abstraction and executor effect; in real-model runs this also includes removing Arm A's LLM planner.",
      B_vs_C:
        "Per-protocol causal comparison: LLM strategic selector contribution with the Commander architecture held fixed. Any C fallback, stale, timeout, parse, or transport plan excludes the entire matched triplet; no intention-to-treat claim is produced.",
      A_vs_C:
        "Overall product comparison; V0 Commander arms intentionally lack diplomacy and must not be treated as feature-equivalent.",
    },
    integrity: { valid, invalidationReasons },
    performanceEligibility: {
      eligible: performanceClaimsAllowed,
      reasons: performanceReasons,
    },
    performanceClaimsAllowed,
    localSmoke,
    tripletCount: triplets.length,
    triplets,
    aggregate: {
      estimand: "per-protocol",
      includedTripletIDs: perProtocolTriplets.map(
        (triplet) => triplet.tripletID,
      ),
      excludedTripletIDs: triplets
        .filter((triplet) => !isPerProtocolTripletEligible(triplet))
        .map((triplet) => triplet.tripletID),
      arms: aggregateArms,
      comparisons: {
        A_vs_B: aggregatePairwise(
          aggregateArms.A,
          aggregateArms.B,
          "abstraction-and-executor",
        ),
        B_vs_C: aggregatePairwise(
          aggregateArms.B,
          aggregateArms.C,
          "llm-selector",
        ),
        A_vs_C: aggregatePairwise(
          aggregateArms.A,
          aggregateArms.C,
          "overall-product",
        ),
      },
    },
  };
}

function buildCommanderArmTripletReport(
  tripletID: string,
  runs: readonly CommanderArmRunInput[],
): CommanderArmTripletReport {
  const byArm = exactArms(runs);
  for (const run of Object.values(byArm)) {
    assertCommanderPublicInputShape(run);
  }
  const arms = {
    A: publicArm(byArm.A),
    B: publicArm(byArm.B),
    C: publicArm(byArm.C),
  } satisfies CommanderArmTripletReport["arms"];
  const invalidationReasons = integrityInvalidations(arms, byArm);
  const integrity = {
    valid: invalidationReasons.length === 0,
    invalidationReasons,
  };
  const terminalIneligibilityReasons = terminalTripletIneligibilityReasons(
    arms,
    integrity.valid,
  );
  return {
    tripletID,
    integrity,
    terminalPerformanceEligibility: {
      estimand: "per-protocol",
      eligible: integrity.valid && terminalIneligibilityReasons.length === 0,
      ineligibilityReasons: terminalIneligibilityReasons,
    },
    localSmoke: runs.some((run) => run.localSmoke),
    arms,
    comparisons: {
      A_vs_B: pairwise(arms.A, arms.B, "abstraction-and-executor"),
      B_vs_C: pairwise(arms.B, arms.C, "llm-selector"),
      A_vs_C: pairwise(arms.A, arms.C, "overall-product"),
    },
  };
}

function assertCommanderPublicInputShape(run: CommanderArmRunInput): void {
  assertExactObjectKeys(
    run as unknown as Record<string, unknown>,
    [
      "tripletID",
      "arm",
      "sourceSha",
      "sourceTreeDirty",
      "runtimeIdentitySha256",
      "seed",
      "runID",
      "selectorSource",
      "provider",
      "model",
      "promptVersion",
      "componentHashes",
      "artifactProvenance",
      "experimentFlags",
      "gameConfiguration",
      "gameConfigurationFingerprint",
      "roster",
      "subjectAgentID",
      "records",
      "finalState",
      "winner",
      "turnCount",
      "localSmoke",
      "requireWinner",
      "completed",
      "autopilotEngagedAtStep",
    ],
    "Commander run has unknown or missing fields",
  );
  assertExactObjectKeys(
    run.experimentFlags as unknown as Record<string, unknown>,
    [
      "localSmoke",
      "structuredDeals",
      "freeTextMessages",
      "optionExposureUsesDeterministicPreference",
      "matchedOfferedOrderSpawnBallot",
      "autopilotEndgameSteps",
      "requireWinner",
    ],
    "Commander experiment flags have unknown or missing fields",
  );
  if (
    typeof run.experimentFlags.localSmoke !== "boolean" ||
    typeof run.experimentFlags.structuredDeals !== "boolean" ||
    typeof run.experimentFlags.freeTextMessages !== "boolean" ||
    typeof run.experimentFlags.optionExposureUsesDeterministicPreference !==
      "boolean" ||
    typeof run.experimentFlags.matchedOfferedOrderSpawnBallot !== "boolean" ||
    !Number.isSafeInteger(run.experimentFlags.autopilotEndgameSteps) ||
    run.experimentFlags.autopilotEndgameSteps < 0 ||
    typeof run.experimentFlags.requireWinner !== "boolean"
  ) {
    throw new Error("Commander experiment flags are malformed");
  }
  assertExactObjectKeys(
    run.gameConfiguration as unknown as Record<string, unknown>,
    [
      "schemaVersion",
      "scenario",
      "runnerMode",
      "agents",
      "opponentBrainMode",
      "planEveryDecisionSteps",
      "runner",
      "selectedGameConfig",
      "disabledActionKinds",
      "rosterPolicy",
    ],
    "Commander game configuration has unknown or missing fields",
  );
  for (const entry of run.roster) {
    assertExactObjectKeys(
      entry as unknown as Record<string, unknown>,
      ["agentID", "username", "profile", "clientID", "brainType"],
      "Commander roster row has unknown or missing fields",
    );
  }
}

export function commanderArmReportJson(report: CommanderArmReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function commanderArmReportMarkdown(report: CommanderArmReport): string {
  const lines = [
    "# StrategicCommanderV0 three-arm report",
    "",
    `Status: **${report.status}**`,
    "",
    report.performanceClaimsAllowed
      ? "Performance interpretation is permitted because every structural and replicated-evidence gate is green."
      : "This is plumbing evidence only. It is not evidence of strategic performance or LLM value.",
    "",
    `Primary causal comparison: **${report.primaryCausalComparison}**`,
    "",
    "## Integrity",
    "",
    `Valid: ${String(report.integrity.valid)}`,
    ...(report.integrity.invalidationReasons.length === 0
      ? ["Invalidation reasons: none"]
      : report.integrity.invalidationReasons.map((reason) => `- ${reason}`)),
    "",
    "## Performance eligibility",
    "",
    `Eligible: ${String(report.performanceEligibility.eligible)}`,
    ...(report.performanceEligibility.reasons.length === 0
      ? ["Ineligibility reasons: none"]
      : report.performanceEligibility.reasons.map((reason) => `- ${reason}`)),
    "",
    `Matched triplets: ${report.tripletCount}`,
    `Per-protocol aggregate triplets: ${report.aggregate.includedTripletIDs.length}; excluded: ${inlineJson(report.aggregate.excludedTripletIDs)}`,
    "",
    "## Aggregate arm metrics",
    "",
    "| Arm | Runs | Wins | Survival | Territory mean | Plans | Cycles | Actions | Fidelity | Fallback plans |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(["A", "B", "C"] as const).map((arm) => {
      const metrics = report.aggregate.arms[arm];
      return `| ${arm} | ${metrics.runs} | ${metrics.wins.count}/${metrics.wins.opportunities} (${percent(metrics.wins.rate)}) | ${metrics.survival.count}/${metrics.survival.opportunities} (${percent(metrics.survival.rate)}) | ${metrics.normalizedFinalTerritory.sum}/${metrics.normalizedFinalTerritory.observations} (${decimal(metrics.normalizedFinalTerritory.mean)}) | ${metrics.planCount} | ${metrics.decisionCycleCount} | ${metrics.actionCount} | ${metrics.fidelity.aligned}/${metrics.fidelity.classifiedNonEmergency} (${percent(metrics.fidelity.rate)}) | ${metrics.fallbackAuthoredPlans} |`;
    }),
    "",
    "## Matched triplets",
    "",
    ...report.triplets.flatMap(commanderTripletMarkdown),
    "## Pairwise interpretation",
    "",
    `- A vs B: ${report.interpretation.A_vs_B}`,
    `- B vs C: ${report.interpretation.B_vs_C}`,
    `- A vs C: ${report.interpretation.A_vs_C}`,
    "",
    "Short-horizon factual deltas after selector disagreements are descriptive only; they are not standalone causal estimates.",
    "",
  ];
  return lines.join("\n");
}

function commanderTripletMarkdown(
  triplet: CommanderArmTripletReport,
): string[] {
  const lines = [
    `### ${markdownCell(triplet.tripletID)}`,
    "",
    `Integrity: **${triplet.integrity.valid ? "valid" : "invalid"}**`,
    ...(triplet.integrity.invalidationReasons.length === 0
      ? ["Invalidation reasons: none"]
      : triplet.integrity.invalidationReasons.map((reason) => `- ${reason}`)),
    `Terminal per-protocol eligibility: **${triplet.terminalPerformanceEligibility.eligible ? "eligible" : "excluded"}**`,
    ...(triplet.terminalPerformanceEligibility.ineligibilityReasons.length === 0
      ? ["Terminal exclusion reasons: none"]
      : triplet.terminalPerformanceEligibility.ineligibilityReasons.map(
          (reason) => `- ${reason}`,
        )),
    "",
    "| Arm | Selector | Provider / model | Plans | Cycles | Actions | Fidelity | Fallback plans | Failures |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const armName of ["A", "B", "C"] as const) {
    const arm = triplet.arms[armName];
    const metrics = arm.metrics;
    lines.push(
      `| ${armName} | ${markdownCell(String(arm.derivedProvenance.selectorSource))} | ${markdownCell(`${arm.derivedProvenance.provider ?? "n/a"} / ${arm.derivedProvenance.model ?? "n/a"}`)} | ${metrics.planCount} | ${metrics.decisionCycleCount} | ${metrics.actionCount} | ${percent(metrics.strategicFidelity)} | ${metrics.fallbackAuthoredPlans} | ${markdownCell(JSON.stringify(metrics.failures))} |`,
    );
  }
  lines.push("");
  for (const armName of ["A", "B", "C"] as const) {
    const arm = triplet.arms[armName];
    const metrics = arm.metrics;
    lines.push(
      `#### Arm ${armName}`,
      "",
      `- Source: \`${arm.sourceSha}\`; dirty: ${String(arm.sourceTreeDirty)}; seed: \`${markdownCell(arm.seed)}\`; run: \`${markdownCell(arm.runID)}\``,
      `- Runtime treatment identity: \`${arm.runtimeIdentitySha256}\``,
      `- Selector provenance: ${inlineJson(arm.derivedProvenance)}; declared prompt: \`${markdownCell(arm.promptVersion ?? "n/a")}\``,
      `- Component hashes: ${inlineJson(arm.componentHashes)}`,
      `- Input artifacts: ${inlineJson(arm.artifactProvenance)}`,
      `- Game fingerprint: \`${arm.gameConfigurationFingerprint}\`; roster: ${inlineJson(arm.roster)}; spawn assignments: ${inlineJson(arm.spawnAssignments)}`,
      `- Outcome: wins=${metrics.wins}; winnerDetermined=${String(metrics.winnerDetermined)}; territory=${decimal(metrics.normalizedFinalTerritory)}; rank=${decimal(metrics.finalRank)}; survived=${String(metrics.survived)}`,
      `- Provider accounting: calls=${metrics.modelCalls}; promptCharacters=${metrics.promptCharacters}; latency=${inlineJson(metrics.planningLatencyMs)}; failures=${inlineJson(metrics.failures)}`,
      `- Plans: count=${metrics.planCount}; duration=${inlineJson(metrics.planDurationDecisions)}; replans=${inlineJson(metrics.replanReasons)}; transitions=${inlineJson(metrics.planTransitions)}; fallbackAuthored=${metrics.fallbackAuthoredPlans}`,
      `- Options: eligible=${inlineJson(metrics.eligibleOptionCount)}; exposed=${inlineJson(metrics.exposedOptionCount)}; familyCoverage=${inlineJson(metrics.optionFamilyCoverage)}; omitted=${metrics.omittedCandidateCount} ${inlineJson(metrics.omittedReasons)}; accountingViolations=${metrics.optionAccountingViolations}`,
      `- Selection: distribution=${inlineJson(metrics.selectedOptionDistribution)}; preferredAbsent=${inlineJson(metrics.deterministicPreferredOptionAbsent)}; disagreement=${inlineJson(metrics.selectorDisagreement)}`,
      `- Fidelity: cyclePrimary=${percent(metrics.strategicFidelity)}; counts=${inlineJson(metrics.fidelityCounts)}; blockedCycles=${inlineJson(metrics.blockedDecisionCycles)}; supportActions=${metrics.supportActionCount}; offFamily=${metrics.offFamilyActionViolations}; laterLayer=${metrics.laterLayerActionViolations}; zeroPrimaryCycles=${metrics.zeroPrimaryDecisionCycles}; planIdentityViolations=${metrics.planIdentityViolations}; batchPositionViolations=${metrics.batchPositionViolations}; stampViolations=${metrics.fidelityStampViolations}; optionNotExecutable=${inlineJson(metrics.optionNotExecutableReplans)}; zeroAlignedPlans=${metrics.plansWithZeroAlignedActions}; missingPrimaryPlans=${metrics.planPrimaryActionViolations}; excessSupportPlans=${metrics.planSupportActionViolations}; silentAbandonments=${metrics.silentlyAbandonedPlans}`,
      `- Exclusions: ${inlineJson(metrics.excludedFromLlmContribution)}; staleRejected=${metrics.staleRejectedAttempts}; staleAuthorityViolations=${metrics.staleAuthorityViolations}; canonicalPathViolations=${metrics.canonicalPathViolations}; effectAudit=${inlineJson(metrics.effectAudit)}`,
      `- Bounded post-disagreement deltas: ${inlineJson(metrics.boundedOutcomeDeltasAfterDisagreement)}`,
      "",
    );
  }
  return lines;
}

function inlineJson(value: unknown): string {
  return `\`${markdownCell(JSON.stringify(value))}\``;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}

export function fingerprintCommanderExperimentValue(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(value))
    .digest("hex")
    .slice(0, 24);
}

function armMetrics(run: CommanderArmRunInput): CommanderArmMetrics {
  const allSubject = run.records
    .filter((record) => record.agentID === run.subjectAgentID)
    .sort((a, b) => a.sequence - b.sequence);
  const autopilot = allSubject.filter(isAutopilot);
  const canonicalRows = allSubject.filter((record) => !isAutopilot(record));
  const actions = allSubject.filter(
    (record) => record.chosenActionKind !== "spawn" && !isAutopilot(record),
  );
  const cycles = actions.filter(isPrimaryBatchRow);
  const planStarts = cycles.filter(
    (record) => metadataBoolean(record, "commanderPlanInstalled") === true,
  );
  const planIDs = distinctStrings(
    cycles.map((record) => metadataString(record, "planID")),
  );
  const fallbackSets = fallbackPlanSets(actions);
  const fallbackPlanIDs = fallbackSets.excluded;
  const isFallbackPlanRecord = (record: AgentDecisionRecord) => {
    const planID = metadataString(record, "planID");
    return planID !== null && fallbackPlanIDs.has(planID);
  };
  const contributionCycles = cycles.filter(
    (record) =>
      !isFallbackPlanRecord(record) && !isRejectedOrFailedAttempt(record),
  );
  const contributionActions = actions.filter(
    (record) =>
      !isFallbackPlanRecord(record) && !isRejectedOrFailedAttempt(record),
  );
  const nonFallbackPlanStarts = planStarts.filter(
    (record) =>
      !isFallbackPlanRecord(record) && !isRejectedOrFailedAttempt(record),
  );
  const eligibleCounts = cycles.map(
    (record) =>
      csv(metadataString(record, "commanderEligibleOptionIds")).length,
  );
  const exposedCounts = cycles.map(
    (record) => csv(metadataString(record, "commanderExposedOptionIds")).length,
  );
  const familyCounts = cycles.map(
    (record) =>
      new Set(
        csv(metadataString(record, "commanderExposedOptionIds")).map(
          optionFamily,
        ),
      ).size,
  );
  const omitted = cycles.flatMap((record) =>
    omittedEntries(metadataString(record, "commanderOmittedOptions")),
  );
  const preference = deterministicPreferenceAudit(planStarts);
  const commanderArm = run.arm !== "A";
  const fidelity = commanderArm
    ? summarizeCommanderFidelity(actions)
    : emptyCommanderFidelitySummary();
  const effectAudit = effectAuditMetrics(run, canonicalRows);
  const durations = planDurations(cycles);
  const transitions = commanderArm
    ? planTransitionAudit(cycles)
    : { count: 0, proven: 0, violations: 0 };
  const optionAccountingViolations = commanderArm
    ? sum(cycles.map(optionAccountingViolationCount))
    : 0;
  const planActions = commanderArm
    ? {
        primaryViolations: fidelity.zeroPrimaryDecisionCycles,
        supportViolations: fidelity.supportPerPlanViolations,
      }
    : { primaryViolations: 0, supportViolations: 0 };
  const fallbackStampViolations = commanderArm
    ? fallbackPlanStampViolations(actions, planIDs, fallbackSets)
    : 0;
  const disagreementRows = nonFallbackPlanStarts.filter((record) => {
    if (metadataString(record, "commanderSelectorSource") !== "llm") {
      return false;
    }
    const selected = metadataString(record, "planObjective");
    const deterministic = metadataString(
      record,
      "commanderDeterministicPreferredOptionId",
    );
    return (
      selected !== null && deterministic !== null && selected !== deterministic
    );
  });
  const disagreementOpportunities = nonFallbackPlanStarts.filter(
    (record) =>
      metadataString(record, "commanderSelectorSource") === "llm" &&
      metadataString(record, "commanderDeterministicPreferredOptionId") !==
        null,
  );
  const staleRejectedAttempts = cycles.filter(isRejectedStaleAttempt).length;
  const staleAuthorityViolations = cycles.filter(
    isStaleAuthorityViolation,
  ).length;
  const planningLatencies = cycles
    .filter((record) => metadataBoolean(record, "externalPlannerCall") === true)
    .map((record) => metadataNumber(record, "plannerLatencyMs") ?? 0);
  const selectedDistribution = countStrings(
    nonFallbackPlanStarts.map((record) =>
      metadataString(record, "planObjective"),
    ),
  );
  const final = finalOutcome(run);
  return {
    wins: final.won ? 1 : 0,
    winnerDetermined: final.winnerDetermined,
    normalizedFinalTerritory: final.normalizedTerritory,
    finalRank: final.rank,
    survived: final.survived,
    modelCalls: cycles.filter(
      (record) => metadataBoolean(record, "externalPlannerCall") === true,
    ).length,
    promptCharacters: sum(
      cycles.map(
        (record) => metadataNumber(record, "commanderPromptCharacters") ?? 0,
      ),
    ),
    planningLatencyMs: {
      total: sum(planningLatencies),
      mean: mean(planningLatencies),
    },
    failures: {
      timeout: countMetadata(
        cycles,
        "commanderSelectionFailureKind",
        "timeout",
      ),
      parse: countMetadata(cycles, "commanderSelectionFailureKind", "parse"),
      transport: countMetadata(
        cycles,
        "commanderSelectionFailureKind",
        "transport",
      ),
      stale: staleRejectedAttempts,
      invalidOption: countMetadata(
        cycles,
        "commanderSelectionFailureKind",
        "invalid-option",
      ),
    },
    staleRejectedAttempts,
    staleAuthorityViolations,
    fallbackAuthoredPlans: fallbackPlanIDs.size,
    fallbackStampViolations,
    planCount: planIDs.length,
    decisionCycleCount: cycles.length,
    actionCount: actions.length,
    eligibleOptionCount: {
      total: sum(eligibleCounts),
      mean: mean(eligibleCounts),
    },
    exposedOptionCount: {
      total: sum(exposedCounts),
      mean: mean(exposedCounts),
    },
    optionFamilyCoverage: {
      meanFamilies: mean(familyCounts),
      allFourFamilyCycles: familyCounts.filter((count) => count === 4).length,
    },
    omittedCandidateCount: omitted.length,
    omittedReasons: countStrings(omitted.map((entry) => entry.reason)),
    deterministicPreferredOptionAbsent: {
      count: preference.absent,
      opportunities: preference.opportunities,
      rate: ratio(preference.absent, preference.opportunities),
    },
    deterministicPreferredOptionStampViolations: preference.violations,
    selectedOptionDistribution: selectedDistribution,
    planDurationDecisions: durations,
    replanReasons: countStrings(
      cycles.map((record) => metadataString(record, "commanderReplanReason")),
    ),
    strategicFidelity: fidelity.fidelityRate,
    fidelityCounts: {
      alignedPrimary: fidelity.counts.aligned_primary,
      alignedSupport: fidelity.counts.aligned_support,
      emergency: fidelity.counts.hard_emergency_override,
      blocked: fidelity.counts.hold_plan_blocked,
    },
    blockedDecisionCycles: {
      count: fidelity.blockedDecisionCycles,
      opportunities: fidelity.primaryDecisionCycles,
      rate: fidelity.blockedCycleRate,
    },
    supportActionCount: fidelity.supportActions,
    offFamilyActionViolations: fidelity.offFamilyActionViolations,
    laterLayerActionViolations: fidelity.laterLayerActionViolations,
    zeroPrimaryDecisionCycles: fidelity.zeroPrimaryDecisionCycles,
    planIdentityViolations: fidelity.planIdentityViolations,
    batchPositionViolations: fidelity.batchPositionViolations,
    fidelityStampViolations: fidelity.fidelityStampViolations,
    optionNotExecutableReplans: fidelity.optionNotExecutableReplans,
    plansWithZeroAlignedActions: commanderArm
      ? fidelity.plansWithZeroAlignedActions
      : 0,
    silentlyAbandonedPlans: transitions.violations,
    planTransitions: transitions,
    optionAccountingViolations,
    planPrimaryActionViolations: planActions.primaryViolations,
    planSupportActionViolations: planActions.supportViolations,
    selectorDisagreement: {
      count: disagreementRows.length,
      opportunities: disagreementOpportunities.length,
      rate: ratio(disagreementRows.length, disagreementOpportunities.length),
    },
    boundedOutcomeDeltasAfterDisagreement: disagreementRows.map((record) =>
      boundedOutcomeDelta(record, cycles),
    ),
    excludedFromLlmContribution: {
      fallbackDecisionCycles: cycles.length - contributionCycles.length,
      fallbackActionRecords: actions.length - contributionActions.length,
      staleDecisionCycles: staleRejectedAttempts,
      autopilotDecisionCycles: autopilot.filter(isPrimaryBatchRow).length,
    },
    canonicalPathViolations: canonicalRows.reduce(
      (total, record) => total + canonicalActionViolationCount(run, record),
      0,
    ),
    effectAudit,
  };
}

function integrityInvalidations(
  arms: CommanderArmTripletReport["arms"],
  rawArms: Record<CommanderExperimentArm, CommanderArmRunInput>,
): string[] {
  const reasons: string[] = [];
  const allArms = [arms.A, arms.B, arms.C] as const;
  if (new Set(allArms.map((arm) => arm.subjectAgentID)).size !== 1) {
    reasons.push("subject seat differs across arms");
  }
  if (subjectRosterEntry(arms.A)?.brainType !== "planner-executor") {
    reasons.push("Arm A is not the current PlannerExecutor architecture");
  }
  if (
    subjectRosterEntry(arms.B)?.brainType !== "strategic-commander" ||
    subjectRosterEntry(arms.C)?.brainType !== "strategic-commander"
  ) {
    reasons.push("Arm B or C is not the StrategicCommander architecture");
  }
  if (
    arms.B.selectorSource !== "deterministic" ||
    arms.C.selectorSource !== "llm"
  ) {
    reasons.push("Arm B/C selector provenance is incorrect");
  }
  const componentKeys: Array<keyof CommanderComponentHashes> = [
    "sharedArchitecture",
    "optionBuilder",
    "stateBuilder",
    "lifecycle",
    "executorAndFidelity",
  ] as const;
  for (const key of componentKeys) {
    if (
      allArms.some((arm) => !/^[0-9a-f]{64}$/i.test(arm.componentHashes[key]))
    ) {
      reasons.push(`required ${key} content hash is missing or malformed`);
    }
    if (arms.B.componentHashes[key] !== arms.C.componentHashes[key]) {
      reasons.push(`Arm B/C ${key} content hash differs`);
    }
  }
  if (
    allArms.some(
      (arm) =>
        !/^[0-9a-f]{40,64}$/i.test(arm.sourceSha) ||
        arm.seed.trim() === "" ||
        arm.runID.trim() === "",
    )
  ) {
    reasons.push("required source, seed, or run provenance is missing");
  }
  if (new Set(allArms.map((arm) => arm.sourceSha)).size !== 1) {
    reasons.push("source SHA differs across arms");
  }
  if (
    allArms.some((arm) => !/^[a-f0-9]{64}$/i.test(arm.runtimeIdentitySha256))
  ) {
    reasons.push("runtime treatment identity is missing or malformed");
  }
  if (new Set(allArms.map((arm) => arm.runtimeIdentitySha256)).size !== 1) {
    reasons.push("runtime treatment identity differs across arms");
  }
  if (new Set(allArms.map((arm) => arm.seed)).size !== 1) {
    reasons.push("seed differs across arms");
  }
  if (new Set(allArms.map((arm) => arm.runID)).size !== 1) {
    reasons.push("matched run identity differs across arms");
  }
  const artifactBackedArms = allArms.filter(
    (arm) => arm.artifactProvenance !== null,
  );
  if (
    artifactBackedArms.length > 0 &&
    artifactBackedArms.length !== allArms.length
  ) {
    reasons.push("matched artifact execution identity is incomplete");
  }
  if (
    artifactBackedArms.length === allArms.length &&
    new Set(
      artifactBackedArms.map((arm) => arm.artifactProvenance!.executedMatchID),
    ).size !== 1
  ) {
    reasons.push("matched executed game identity differs across arms");
  }
  if (
    new Set(
      allArms.map((arm) =>
        fingerprintCommanderExperimentValue(arm.experimentFlags),
      ),
    ).size !== 1
  ) {
    reasons.push("experiment flags differ across arms");
  }
  if (
    arms.B.experimentFlags.optionExposureUsesDeterministicPreference !==
      false ||
    arms.C.experimentFlags.optionExposureUsesDeterministicPreference !== false
  ) {
    reasons.push("option exposure preference-independence is not proven");
  }
  if (
    allArms.some(
      (arm) =>
        arm.experimentFlags.structuredDeals !== false ||
        arm.experimentFlags.freeTextMessages !== false,
    )
  ) {
    reasons.push("excluded social experiment flags are not proven off");
  }
  if (
    allArms.some(
      (arm) =>
        arm.experimentFlags.matchedOfferedOrderSpawnBallot !== true ||
        arm.experimentFlags.matchedOfferedOrderSpawnBallot !==
          arm.gameConfiguration.runner.matchedOfferedOrderSpawnBallot,
    )
  ) {
    reasons.push("matched offered-order spawn ballot is not proven active");
  }
  if (
    allArms.some(
      (arm) =>
        arm.experimentFlags.autopilotEndgameSteps !==
        arm.gameConfiguration.runner.autopilotEndgameSteps,
    )
  ) {
    reasons.push("autopilot experiment label disagrees with runner config");
  }
  if (new Set(allArms.map((arm) => arm.localSmoke)).size !== 1) {
    reasons.push("local-smoke provenance differs across arms");
  }
  if (
    allArms.some(
      (arm) => arm.localSmoke !== (arm.experimentFlags.localSmoke === true),
    )
  ) {
    reasons.push("local-smoke label disagrees with experiment flags");
  }
  if (
    allArms.some((arm) => {
      const derived = arm.derivedProvenance;
      return (
        !arm.localSmoke &&
        [derived.provider, derived.model].some(
          (value) => value !== null && isMockLike(value),
        )
      );
    })
  ) {
    reasons.push(
      "local-smoke label disagrees with mock provider/model provenance",
    );
  }
  if (
    allArms.some(
      (arm) =>
        arm.requireWinner !== (arm.experimentFlags.requireWinner === true),
    )
  ) {
    reasons.push("require-winner label disagrees with experiment flags");
  }
  const actualConfigurationFingerprints = allArms.map((arm) =>
    fingerprintCommanderExperimentValue(arm.gameConfiguration),
  );
  if (
    new Set(allArms.map((arm) => arm.gameConfigurationFingerprint)).size !==
      1 ||
    new Set(actualConfigurationFingerprints).size !== 1
  ) {
    reasons.push("matched game configuration differs across arms");
  }
  if (
    allArms.some(
      (arm, index) =>
        arm.gameConfigurationFingerprint !==
        actualConfigurationFingerprints[index],
    )
  ) {
    reasons.push(
      "recorded game configuration fingerprint does not match its configuration",
    );
  }
  if (
    !sameNormalizedRoster(arms.A, arms.B) ||
    !sameNormalizedRoster(arms.B, arms.C)
  ) {
    reasons.push(
      "roster, seat, profile, or stable participant identity differs",
    );
  }
  if (
    !sameRecord(arms.A.spawnAssignments, arms.B.spawnAssignments) ||
    !sameRecord(arms.B.spawnAssignments, arms.C.spawnAssignments)
  ) {
    reasons.push("actual spawn assignments differ across arms");
  }
  for (const arm of allArms) {
    if (!hasCompleteSpawnAssignments(arm)) {
      reasons.push(`Arm ${arm.arm} actual spawn assignments are incomplete`);
    }
    if (arm.metrics.actionCount === 0 || arm.turnCount <= 0) {
      reasons.push(`Arm ${arm.arm} has no canonical active-play trajectory`);
    }
    const spawnViolations = spawnSelectionEvidenceViolations(rawArms[arm.arm]);
    if (spawnViolations > 0) {
      reasons.push(`Arm ${arm.arm} spawn-selection evidence is invalid`);
    }
    const raw = rawArms[arm.arm];
    const derivedCompleted =
      raw.winner !== undefined && raw.finalState?.phase === "finished";
    if (raw.completed !== derivedCompleted) {
      reasons.push(`Arm ${arm.arm} completion label disagrees with artifacts`);
    }
    if (arm.metrics.canonicalPathViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} failed offered-id, acceptance, or submitted-intent proof`,
      );
    }
    if (
      arm.metrics.effectAudit.immediateViolations > 0 ||
      arm.metrics.effectAudit.delayedExpired > 0 ||
      arm.metrics.effectAudit.delayedFailed > 0
    ) {
      reasons.push(
        `Arm ${arm.arm} failed immediate or bounded delayed-effect audit proof`,
      );
    }
    const artifact = arm.artifactProvenance;
    if (
      artifact !== null &&
      (artifact.executedRunID !== arm.runID ||
        artifact.executedSeed !== arm.seed ||
        artifact.executedMatchID !== commanderGameIDFromSeed(arm.seed))
    ) {
      reasons.push(
        `Arm ${arm.arm} artifact execution identity is inconsistent`,
      );
    }
  }
  if (!sameInitialOptionSurface(rawArms.B, rawArms.C)) {
    reasons.push("Arm B/C initial exposed option surfaces differ");
  }
  for (const arm of allArms) {
    const derived = arm.derivedProvenance;
    if (
      derived.selectorSource !== arm.selectorSource ||
      derived.provider !== arm.provider ||
      derived.model !== arm.model ||
      derived.promptVersion !== arm.promptVersion
    ) {
      reasons.push(
        `Arm ${arm.arm} run labels disagree with plan-start telemetry`,
      );
    }
    if (experimentAssertionViolations(rawArms[arm.arm]) > 0) {
      reasons.push(
        `Arm ${arm.arm} experiment assertions disagree with runtime telemetry`,
      );
    }
  }
  if (
    arms.B.derivedProvenance.selectorSource !== "deterministic" ||
    arms.C.derivedProvenance.selectorSource !== "llm"
  ) {
    reasons.push("Arm B/C plan starts do not prove selector authority");
  }
  for (const arm of [arms.B, arms.C]) {
    const metrics = arm.metrics;
    if (
      metrics.strategicFidelity === null ||
      metrics.strategicFidelity < COMMANDER_FIDELITY_THRESHOLD
    ) {
      reasons.push(`Arm ${arm.arm} strategic fidelity is below 95 percent`);
    }
    if (metrics.silentlyAbandonedPlans > 0) {
      reasons.push(`Arm ${arm.arm} silently abandoned a plan`);
    }
    if (metrics.staleAuthorityViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} applied or retained stale-response evidence`,
      );
    }
    if (metrics.fidelityCounts.emergency > 0) {
      reasons.push(`Arm ${arm.arm} used a forbidden V0 emergency action`);
    }
    if (metrics.offFamilyActionViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} executed an action incompatible with its Commander plan`,
      );
    }
    if (metrics.laterLayerActionViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} executed an invalid later-layer Commander action`,
      );
    }
    if (metrics.zeroPrimaryDecisionCycles > 0) {
      reasons.push(
        `Arm ${arm.arm} has a Commander cycle without one compatible primary`,
      );
    }
    if (metrics.planIdentityViolations > 0) {
      reasons.push(`Arm ${arm.arm} plan identity changed within a plan`);
    }
    if (metrics.batchPositionViolations > 0) {
      reasons.push(`Arm ${arm.arm} Commander batch position is invalid`);
    }
    if (metrics.fidelityStampViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} Commander fidelity stamp disagrees with recomputation`,
      );
    }
    if (metrics.plansWithZeroAlignedActions > 0) {
      reasons.push(`Arm ${arm.arm} has a plan with zero aligned actions`);
    }
    if (metrics.optionAccountingViolations > 0) {
      reasons.push(`Arm ${arm.arm} option accounting is invalid`);
    }
    if (metrics.planPrimaryActionViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} has a Commander cycle without a primary action`,
      );
    }
    if (metrics.planSupportActionViolations > 0) {
      reasons.push(`Arm ${arm.arm} has more than one support action in a plan`);
    }
    if (metrics.fallbackStampViolations > 0) {
      reasons.push(`Arm ${arm.arm} fallback plan provenance is inconsistent`);
    }
    if (metrics.deterministicPreferredOptionStampViolations > 0) {
      reasons.push(
        `Arm ${arm.arm} deterministic preferred-option evidence is invalid`,
      );
    }
    const absentRate = metrics.deterministicPreferredOptionAbsent.rate;
    if (
      absentRate !== null &&
      absentRate > COMMANDER_PREFERRED_ABSENCE_THRESHOLD
    ) {
      reasons.push(
        `Arm ${arm.arm} deterministic preferred option absence exceeds 5 percent`,
      );
    }
  }
  if (
    arms.C.metrics.planCount > 0 &&
    arms.C.derivedProvenance.nonFallbackPlanStarts === 0
  ) {
    reasons.push("Arm C has no non-fallback LLM-authored plan opportunities");
  }
  return [...new Set(reasons)];
}

function publicArm(
  run: CommanderArmRunInput,
): CommanderArmTripletReport["arms"][CommanderExperimentArm] {
  return {
    tripletID: run.tripletID,
    arm: run.arm,
    sourceSha: run.sourceSha,
    sourceTreeDirty: run.sourceTreeDirty,
    runtimeIdentitySha256: run.runtimeIdentitySha256,
    seed: run.seed,
    runID: run.runID,
    selectorSource: run.selectorSource,
    provider: run.provider,
    model: run.model,
    promptVersion: run.promptVersion,
    componentHashes: {
      sharedArchitecture: run.componentHashes.sharedArchitecture,
      optionBuilder: run.componentHashes.optionBuilder,
      stateBuilder: run.componentHashes.stateBuilder,
      lifecycle: run.componentHashes.lifecycle,
      executorAndFidelity: run.componentHashes.executorAndFidelity,
    },
    artifactProvenance:
      run.artifactProvenance === null
        ? null
        : {
            writer: run.artifactProvenance.writer,
            manifestPath: run.artifactProvenance.manifestPath,
            decisionsPath: run.artifactProvenance.decisionsPath,
            decisionsSha256: run.artifactProvenance.decisionsSha256,
            summaryPath: run.artifactProvenance.summaryPath,
            summarySha256: run.artifactProvenance.summarySha256,
            executedRunID: run.artifactProvenance.executedRunID,
            executedMatchID: run.artifactProvenance.executedMatchID,
            executedSeed: run.artifactProvenance.executedSeed,
            stepsCompleted: run.artifactProvenance.stepsCompleted,
          },
    experimentFlags: projectExperimentFlags(run.experimentFlags),
    gameConfiguration: projectMatchedGameConfiguration(run.gameConfiguration),
    gameConfigurationFingerprint: run.gameConfigurationFingerprint,
    roster: run.roster.map((entry) => ({
      agentID: entry.agentID,
      username: entry.username,
      profile: entry.profile,
      clientID: entry.clientID,
      brainType: entry.brainType,
    })),
    subjectAgentID: run.subjectAgentID,
    turnCount: run.turnCount,
    localSmoke: run.localSmoke,
    requireWinner: run.requireWinner,
    completed: run.completed,
    autopilotEngagedAtStep: run.autopilotEngagedAtStep,
    spawnAssignments: deriveSpawnAssignments(run),
    derivedProvenance: derivePlanStartProvenance(run),
    metrics: armMetrics(run),
  };
}

function projectExperimentFlags(
  flags: CommanderExperimentFlags,
): CommanderExperimentFlags {
  return {
    localSmoke: flags.localSmoke,
    structuredDeals: flags.structuredDeals,
    freeTextMessages: flags.freeTextMessages,
    optionExposureUsesDeterministicPreference:
      flags.optionExposureUsesDeterministicPreference,
    matchedOfferedOrderSpawnBallot: flags.matchedOfferedOrderSpawnBallot,
    autopilotEndgameSteps: flags.autopilotEndgameSteps,
    requireWinner: flags.requireWinner,
  };
}

function projectMatchedGameConfiguration(
  config: CommanderMatchedGameConfiguration,
): CommanderMatchedGameConfiguration {
  return {
    schemaVersion: config.schemaVersion,
    scenario: config.scenario,
    runnerMode: config.runnerMode,
    agents: config.agents,
    opponentBrainMode: config.opponentBrainMode,
    planEveryDecisionSteps: config.planEveryDecisionSteps,
    runner: {
      turnsPerDecisionStep: config.runner.turnsPerDecisionStep,
      turnsPerDecisionSchedule:
        config.runner.turnsPerDecisionSchedule === null
          ? null
          : [...config.runner.turnsPerDecisionSchedule],
      maxDecisionMs: config.runner.maxDecisionMs,
      maxSteps: config.runner.maxSteps,
      maxSpawnAdvanceTurns: config.runner.maxSpawnAdvanceTurns,
      requireWinner: config.runner.requireWinner,
      waitForMirrorCatchup: config.runner.waitForMirrorCatchup,
      autopilotEndgameSteps: config.runner.autopilotEndgameSteps,
      replayTailTurns: config.runner.replayTailTurns,
      matchedOfferedOrderSpawnBallot:
        config.runner.matchedOfferedOrderSpawnBallot,
      variedSpawns: config.runner.variedSpawns,
    },
    selectedGameConfig: parseCommanderCanonicalGameConfig(
      config.selectedGameConfig,
    ),
    disabledActionKinds: [...config.disabledActionKinds],
    rosterPolicy: config.rosterPolicy,
  };
}

function deriveSpawnAssignments(
  run: CommanderArmRunInput,
): Record<string, string> {
  const assignments: Record<string, string> = {};
  const rosterAgentIDs = new Set(run.roster.map((entry) => entry.agentID));
  for (const record of run.records) {
    if (!rosterAgentIDs.has(record.agentID)) continue;
    const evidence = record.spawnSelectionEvidence;
    if (
      evidence === undefined ||
      record.chosenActionKind !== "spawn" ||
      canonicalActionViolationCount(run, record) > 0 ||
      evidence.participantID.trim() === "" ||
      !evidence.priorityParticipantIDs.includes(evidence.participantID) ||
      evidence.assignedActionID !== record.chosenActionID ||
      !evidence.offeredActionIDs.includes(evidence.assignedActionID) ||
      assignments[record.agentID] !== undefined
    ) {
      continue;
    }
    assignments[record.agentID] = evidence.assignedActionID;
  }
  return assignments;
}

function spawnSelectionEvidenceViolations(run: CommanderArmRunInput): number {
  const rosterAgentIDs = new Set(run.roster.map((entry) => entry.agentID));
  const seen = new Set<string>();
  let violations = 0;
  for (const record of run.records) {
    const isSpawn = record.chosenActionKind === "spawn";
    const evidence = record.spawnSelectionEvidence;
    if (!isSpawn && evidence === undefined) continue;
    if (!rosterAgentIDs.has(record.agentID)) {
      violations += 1;
      continue;
    }
    if (evidence === undefined) {
      violations += 1;
      seen.add(record.agentID);
      continue;
    }
    if (
      !isSpawn ||
      canonicalActionViolationCount(run, record) > 0 ||
      evidence.participantID.trim() === "" ||
      !evidence.priorityParticipantIDs.includes(evidence.participantID) ||
      evidence.assignedActionID !== record.chosenActionID ||
      !evidence.offeredActionIDs.includes(evidence.assignedActionID) ||
      seen.has(record.agentID)
    ) {
      violations += 1;
    }
    seen.add(record.agentID);
  }
  for (const agentID of rosterAgentIDs) {
    if (!seen.has(agentID)) violations += 1;
  }
  return violations;
}

export function deriveCommanderPlanStartProvenance(
  run: CommanderArmRunInput,
): CommanderDerivedPlanProvenance {
  const activePrimary = run.records
    .filter(
      (record) =>
        record.agentID === run.subjectAgentID &&
        record.chosenActionKind !== "spawn" &&
        !isAutopilot(record) &&
        isPrimaryBatchRow(record),
    )
    .sort((left, right) => left.sequence - right.sequence);
  const fallbackPlanIDs = fallbackPlanSets(activePrimary).excluded;
  const planStarts = activePrimary.filter((record, index) => {
    const planID = metadataString(record, "planID");
    if (
      (planID !== null && fallbackPlanIDs.has(planID)) ||
      isRejectedOrFailedAttempt(record)
    ) {
      return false;
    }
    if (run.arm !== "A") {
      return metadataBoolean(record, "commanderPlanInstalled") === true;
    }
    const priorPlanID =
      index === 0 ? null : metadataString(activePrimary[index - 1]!, "planID");
    return (
      metadataBoolean(record, "plannerRan") === true ||
      metadataString(record, "planID") !== priorPlanID
    );
  });
  const selectorValues = planStarts.map((record) =>
    run.arm === "A" ? "current-planner" : commanderSelectorAuthority(record),
  );
  const providerValues = planStarts.map((record) =>
    run.arm === "A"
      ? metadataString(record, "commanderRuntimeProvider")
      : run.arm === "C"
        ? metadataString(record, "commanderSelectorProvider")
        : null,
  );
  const modelValues = planStarts.map((record) =>
    run.arm === "A"
      ? metadataString(record, "commanderRuntimeModel")
      : run.arm === "C"
        ? metadataString(record, "commanderSelectorModel")
        : null,
  );
  const promptValues = planStarts.map((record) =>
    run.arm === "A"
      ? metadataString(record, "commanderRuntimePromptVersion")
      : run.arm === "C"
        ? metadataString(record, "commanderPromptVersion")
        : null,
  );
  return {
    selectorSource: singleNullableValue(
      selectorValues,
    ) as CommanderDerivedPlanProvenance["selectorSource"],
    provider: singleNullableValue(providerValues),
    model: singleNullableValue(modelValues),
    promptVersion: singleNullableValue(promptValues),
    nonFallbackPlanStarts: planStarts.length,
  };
}

const derivePlanStartProvenance = deriveCommanderPlanStartProvenance;

function commanderSelectorAuthority(
  record: AgentDecisionRecord,
): string | null {
  const installed = metadataString(record, "commanderSelectorSource");
  const primary = metadataString(record, "commanderPrimarySelectorSource");
  return installed === primary ? installed : "conflict";
}

function experimentAssertionViolations(run: CommanderArmRunInput): number {
  const activePrimary = run.records
    .filter(
      (record) =>
        record.agentID === run.subjectAgentID &&
        record.chosenActionKind !== "spawn" &&
        !isAutopilot(record) &&
        isPrimaryBatchRow(record),
    )
    .sort((left, right) => left.sequence - right.sequence);
  const planStarts = activePrimary.filter((record, index) => {
    if (run.arm !== "A") {
      return metadataBoolean(record, "commanderPlanInstalled") === true;
    }
    const priorPlanID =
      index === 0 ? null : metadataString(activePrimary[index - 1]!, "planID");
    return (
      metadataBoolean(record, "plannerRan") === true ||
      metadataString(record, "planID") !== priorPlanID
    );
  });
  let violations = 0;
  for (const record of planStarts) {
    const asserted = {
      provider: metadataString(record, "commanderExperimentProvider"),
      model: metadataString(record, "commanderExperimentModel"),
      promptVersion: metadataString(record, "commanderExperimentPromptVersion"),
    };
    const actual =
      run.arm === "A"
        ? {
            provider: metadataString(record, "commanderRuntimeProvider"),
            model: metadataString(record, "commanderRuntimeModel"),
            promptVersion: metadataString(
              record,
              "commanderRuntimePromptVersion",
            ),
          }
        : run.arm === "C"
          ? {
              provider: metadataString(record, "commanderSelectorProvider"),
              model: metadataString(record, "commanderSelectorModel"),
              promptVersion: metadataString(record, "commanderPromptVersion"),
            }
          : { provider: null, model: null, promptVersion: null };
    if (
      asserted.provider !== actual.provider ||
      asserted.model !== actual.model ||
      asserted.promptVersion !== actual.promptVersion
    ) {
      violations += 1;
    }
  }
  return violations;
}

function exactArms(
  runs: readonly CommanderArmRunInput[],
): Record<CommanderExperimentArm, CommanderArmRunInput> {
  if (runs.length !== 3) {
    throw new Error("Commander report requires exactly Arms A, B, and C");
  }
  const result = Object.fromEntries(
    runs.map((run) => [run.arm, run]),
  ) as Partial<Record<CommanderExperimentArm, CommanderArmRunInput>>;
  if (
    result.A === undefined ||
    result.B === undefined ||
    result.C === undefined
  ) {
    throw new Error(
      "Commander report requires one run for each of Arms A, B, and C",
    );
  }
  return result as Record<CommanderExperimentArm, CommanderArmRunInput>;
}

function exactTriplets(
  runs: readonly CommanderArmRunInput[],
): Map<string, CommanderArmRunInput[]> {
  if (runs.length === 0 || runs.length % 3 !== 0) {
    throw new Error(
      "Commander report requires one or more complete A/B/C triplets",
    );
  }
  const grouped = new Map<string, CommanderArmRunInput[]>();
  for (const run of runs) {
    if (run.tripletID.trim() === "") {
      throw new Error("Commander run is missing its matched triplet identity");
    }
    const group = grouped.get(run.tripletID) ?? [];
    group.push(run);
    grouped.set(run.tripletID, group);
  }
  for (const group of grouped.values()) exactArms(group);
  return new Map(
    [...grouped.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function replicatedCorpusInvalidations(
  runs: readonly CommanderArmRunInput[],
  triplets: readonly CommanderArmTripletReport[],
): string[] {
  const reasons: string[] = [];
  const tripletRunIDs = triplets.map((triplet) => triplet.arms.A.runID);
  if (new Set(tripletRunIDs).size !== tripletRunIDs.length) {
    reasons.push("replicated triplets reuse an executed run identity");
  }
  const artifactRuns = runs.filter(
    (
      run,
    ): run is CommanderArmRunInput & {
      artifactProvenance: CommanderArtifactProvenance;
    } => run.artifactProvenance !== null,
  );
  if (artifactRuns.length === 0) return reasons;
  const tripletMatchIDs = triplets
    .map((triplet) => triplet.arms.A.artifactProvenance?.executedMatchID)
    .filter((value): value is string => value !== undefined);
  if (
    tripletMatchIDs.length > 0 &&
    new Set(tripletMatchIDs).size !== tripletMatchIDs.length
  ) {
    reasons.push("replicated triplets reuse an executed game identity");
  }
  const paths = artifactRuns.flatMap((run) => [
    run.artifactProvenance.manifestPath,
    run.artifactProvenance.decisionsPath,
    run.artifactProvenance.summaryPath,
  ]);
  if (new Set(paths).size !== paths.length) {
    reasons.push("replicated arms reuse an artifact path");
  }
  const decisionsHashes = artifactRuns.map(
    (run) => run.artifactProvenance.decisionsSha256,
  );
  if (new Set(decisionsHashes).size !== decisionsHashes.length) {
    reasons.push("replicated arms reuse a decisions corpus");
  }
  const artifactTuples = artifactRuns.map((run) =>
    stableJson({
      decisionsPath: run.artifactProvenance.decisionsPath,
      decisionsSha256: run.artifactProvenance.decisionsSha256,
      summaryPath: run.artifactProvenance.summaryPath,
      summarySha256: run.artifactProvenance.summarySha256,
    }),
  );
  if (new Set(artifactTuples).size !== artifactTuples.length) {
    reasons.push("replicated arms reuse an artifact path/hash identity");
  }
  return reasons;
}

function pairwise(
  control: CommanderArmTripletReport["arms"][CommanderExperimentArm],
  treatment: CommanderArmTripletReport["arms"][CommanderExperimentArm],
  treatmentName: string,
): CommanderPairwiseComparison {
  return {
    treatment: treatmentName,
    winDelta: treatment.metrics.wins - control.metrics.wins,
    normalizedTerritoryDelta: nullableDelta(
      control.metrics.normalizedFinalTerritory,
      treatment.metrics.normalizedFinalTerritory,
    ),
    finalRankDelta: nullableDelta(
      control.metrics.finalRank,
      treatment.metrics.finalRank,
    ),
    survivalDelta:
      control.metrics.survived === null || treatment.metrics.survived === null
        ? null
        : Number(treatment.metrics.survived) - Number(control.metrics.survived),
    caveat:
      "A single run or short local smoke has no performance evidentiary weight; pairwise deltas require replicated matched games.",
  };
}

function aggregateArmMetrics(
  metrics: readonly CommanderArmMetrics[],
): CommanderAggregateArmMetrics {
  const survivalKnown = metrics.filter((entry) => entry.survived !== null);
  const territories = metrics
    .map((entry) => entry.normalizedFinalTerritory)
    .filter((value): value is number => value !== null);
  const ranks = metrics
    .map((entry) => entry.finalRank)
    .filter((value): value is number => value !== null);
  const aligned = sum(
    metrics.map((entry) => entry.fidelityCounts.alignedPrimary),
  );
  const classifiedNonEmergency = sum(
    metrics.map(
      (entry) =>
        entry.blockedDecisionCycles.opportunities -
        entry.fidelityCounts.emergency,
    ),
  );
  return {
    runs: metrics.length,
    wins: {
      count: sum(metrics.map((entry) => entry.wins)),
      opportunities: metrics.length,
      rate: ratio(sum(metrics.map((entry) => entry.wins)), metrics.length),
    },
    winnersDetermined: {
      count: metrics.filter((entry) => entry.winnerDetermined).length,
      opportunities: metrics.length,
      rate: ratio(
        metrics.filter((entry) => entry.winnerDetermined).length,
        metrics.length,
      ),
    },
    survival: {
      count: survivalKnown.filter((entry) => entry.survived === true).length,
      opportunities: survivalKnown.length,
      rate: ratio(
        survivalKnown.filter((entry) => entry.survived === true).length,
        survivalKnown.length,
      ),
    },
    normalizedFinalTerritory: {
      sum: sum(territories),
      observations: territories.length,
      mean: mean(territories),
    },
    finalRank: {
      sum: sum(ranks),
      observations: ranks.length,
      mean: mean(ranks),
    },
    modelCalls: sum(metrics.map((entry) => entry.modelCalls)),
    planCount: sum(metrics.map((entry) => entry.planCount)),
    decisionCycleCount: sum(metrics.map((entry) => entry.decisionCycleCount)),
    actionCount: sum(metrics.map((entry) => entry.actionCount)),
    fallbackAuthoredPlans: sum(
      metrics.map((entry) => entry.fallbackAuthoredPlans),
    ),
    fidelity: {
      aligned,
      classifiedNonEmergency,
      rate: ratio(aligned, classifiedNonEmergency),
    },
    staleRejectedAttempts: sum(
      metrics.map((entry) => entry.staleRejectedAttempts),
    ),
    staleAuthorityViolations: sum(
      metrics.map((entry) => entry.staleAuthorityViolations),
    ),
    autopilotDecisionCycles: sum(
      metrics.map(
        (entry) => entry.excludedFromLlmContribution.autopilotDecisionCycles,
      ),
    ),
  };
}

function aggregatePairwise(
  control: CommanderAggregateArmMetrics,
  treatment: CommanderAggregateArmMetrics,
  treatmentName: string,
): CommanderPairwiseComparison {
  return {
    treatment: treatmentName,
    winDelta: nullableDelta(control.wins.rate, treatment.wins.rate) ?? 0,
    normalizedTerritoryDelta: nullableDelta(
      control.normalizedFinalTerritory.mean,
      treatment.normalizedFinalTerritory.mean,
    ),
    finalRankDelta: nullableDelta(
      control.finalRank.mean,
      treatment.finalRank.mean,
    ),
    survivalDelta: nullableDelta(
      control.survival.rate,
      treatment.survival.rate,
    ),
    caveat:
      "Raw counts and rates are aggregated over matched triplets; eligibility does not establish statistical power or strategic value.",
  };
}

function performanceIneligibilityReasons(
  runs: readonly CommanderArmRunInput[],
  triplets: readonly CommanderArmTripletReport[],
): string[] {
  const reasons: string[] = [];
  const perProtocolTriplets = triplets.filter(isPerProtocolTripletEligible);
  if (perProtocolTriplets.length < MIN_COMMANDER_PERFORMANCE_TRIPLETS) {
    reasons.push(
      `fewer than ${MIN_COMMANDER_PERFORMANCE_TRIPLETS} uncontaminated per-protocol matched triplets`,
    );
  }
  for (const triplet of triplets) {
    for (const reason of triplet.terminalPerformanceEligibility
      .ineligibilityReasons) {
      reasons.push(`${triplet.tripletID}: ${reason}`);
    }
  }
  if (runs.some((run) => run.localSmoke)) {
    reasons.push("local-smoke evidence cannot support performance claims");
  }
  if (runs.some((run) => run.sourceTreeDirty)) {
    reasons.push("source tree was dirty");
  }
  if (runs.some((run) => run.artifactProvenance === null)) {
    reasons.push("one or more arms lack artifact-backed input provenance");
  }
  if (new Set(runs.map((run) => run.sourceSha)).size !== 1) {
    reasons.push("replicated triplets do not share one source SHA");
  }
  if (
    runs.some((run) => !/^[a-f0-9]{64}$/i.test(run.runtimeIdentitySha256)) ||
    new Set(runs.map((run) => run.runtimeIdentitySha256)).size !== 1
  ) {
    reasons.push(
      "replicated triplets do not share one valid runtime treatment identity",
    );
  }
  if (runs.some((run) => !run.requireWinner)) {
    reasons.push("require-winner was not enabled for every arm");
  }
  if (
    runs.some(
      (run) =>
        !run.completed ||
        run.winner === undefined ||
        run.finalState?.phase !== "finished",
    )
  ) {
    reasons.push("one or more arms lack a completed winner-determined match");
  }
  if (
    runs.some(
      (run) =>
        run.autopilotEngagedAtStep !== null || run.records.some(isAutopilot),
    )
  ) {
    reasons.push("one or more final outcomes were contaminated by autopilot");
  }
  const tripletSeeds = triplets.map((triplet) => triplet.arms.A.seed);
  if (new Set(tripletSeeds).size !== tripletSeeds.length) {
    reasons.push("replicated triplets do not use distinct seeds");
  }
  const configurationFingerprints = triplets.map(
    (triplet) => triplet.arms.A.gameConfigurationFingerprint,
  );
  if (new Set(configurationFingerprints).size !== 1) {
    reasons.push("replicated triplets do not share one game configuration");
  }
  const aProviders = triplets.map(
    (triplet) => triplet.arms.A.derivedProvenance.provider,
  );
  const cProviders = triplets.map(
    (triplet) => triplet.arms.C.derivedProvenance.provider,
  );
  const aModels = triplets.map(
    (triplet) => triplet.arms.A.derivedProvenance.model,
  );
  const cModels = triplets.map(
    (triplet) => triplet.arms.C.derivedProvenance.model,
  );
  const aPrompts = triplets.map(
    (triplet) => triplet.arms.A.derivedProvenance.promptVersion,
  );
  const cPrompts = triplets.map(
    (triplet) => triplet.arms.C.derivedProvenance.promptVersion,
  );
  if (
    [...aProviders, ...cProviders, ...aModels, ...cModels].some(
      (value) => value === null || isMockLike(value),
    )
  ) {
    reasons.push("provider/model provenance is missing, mock, or scripted");
  }
  if (
    aPrompts.some((value) => value === null) ||
    cPrompts.some((value) => value === null)
  ) {
    reasons.push("prompt-version provenance is incomplete");
  }
  if (
    new Set(aProviders).size !== 1 ||
    new Set(cProviders).size !== 1 ||
    new Set(aModels).size !== 1 ||
    new Set(cModels).size !== 1 ||
    new Set(aPrompts).size !== 1 ||
    new Set(cPrompts).size !== 1
  ) {
    reasons.push("provider, model, or prompt parameters vary across replicas");
  }
  if (
    triplets.some(
      (triplet) =>
        triplet.arms.A.derivedProvenance.provider !==
          triplet.arms.C.derivedProvenance.provider ||
        triplet.arms.A.derivedProvenance.model !==
          triplet.arms.C.derivedProvenance.model,
    )
  ) {
    reasons.push("Arm A and C do not use comparable provider/model parameters");
  }
  for (const triplet of triplets) {
    for (const armName of ["B", "C"] as const) {
      const metrics = triplet.arms[armName].metrics;
      if (
        metrics.blockedDecisionCycles.rate !== null &&
        metrics.blockedDecisionCycles.rate > COMMANDER_BLOCKED_CYCLE_THRESHOLD
      ) {
        reasons.push(
          `${triplet.tripletID}: Arm ${armName} blocked Commander cycles exceed 5 percent`,
        );
      }
      if (metrics.optionNotExecutableReplans.dominates) {
        reasons.push(
          `${triplet.tripletID}: Arm ${armName} option_not_executable reaches the preregistered ${COMMANDER_OPTION_NOT_EXECUTABLE_DOMINANCE_THRESHOLD * 100} percent non-bootstrap replan threshold`,
        );
      }
      if (
        metrics.fidelityCounts.emergency > 0 ||
        metrics.offFamilyActionViolations > 0 ||
        metrics.laterLayerActionViolations > 0 ||
        metrics.zeroPrimaryDecisionCycles > 0
      ) {
        reasons.push(
          `${triplet.tripletID}: Arm ${armName} has a forbidden fidelity violation`,
        );
      }
    }
    for (const armName of ["A", "B", "C"] as const) {
      if (triplet.arms[armName].metrics.effectAudit.delayedPending > 0) {
        reasons.push(
          `${triplet.tripletID}: Arm ${armName} has an unresolved bounded delayed-effect audit`,
        );
      }
    }
  }
  reasons.push(...replicatedCorpusInvalidations(runs, triplets));
  return [...new Set(reasons)];
}

function terminalTripletIneligibilityReasons(
  arms: CommanderArmTripletReport["arms"],
  integrityValid: boolean,
): string[] {
  const metrics = arms.C.metrics;
  const reasons: string[] = [];
  if (!integrityValid) {
    reasons.push(
      "triplet integrity is invalid; per-protocol terminal outcomes require structurally valid evidence",
    );
  }
  if (metrics.fallbackAuthoredPlans > 0) {
    reasons.push(
      "Arm C contains a fallback-authored plan; per-protocol terminal outcomes require zero",
    );
  }
  if (metrics.staleRejectedAttempts > 0) {
    reasons.push(
      "Arm C contains a stale selector attempt; per-protocol terminal outcomes require zero",
    );
  }
  if (metrics.staleAuthorityViolations > 0) {
    reasons.push(
      "Arm C applied or retained stale selector authority; per-protocol terminal outcomes require zero",
    );
  }
  if (metrics.failures.timeout > 0) {
    reasons.push(
      "Arm C contains a selector timeout; per-protocol terminal outcomes require zero",
    );
  }
  if (metrics.failures.parse > 0) {
    reasons.push(
      "Arm C contains a selector parse failure; per-protocol terminal outcomes require zero",
    );
  }
  if (metrics.failures.transport > 0) {
    reasons.push(
      "Arm C contains a selector transport failure; per-protocol terminal outcomes require zero",
    );
  }
  return reasons;
}

function isPerProtocolTripletEligible(
  triplet: CommanderArmTripletReport,
): boolean {
  return (
    triplet.integrity.valid && triplet.terminalPerformanceEligibility.eligible
  );
}

function isMockLike(value: string): boolean {
  return /mock|fake|scripted|test|local/i.test(value);
}

function emptyCommanderFidelitySummary(): CommanderFidelitySummary {
  return {
    counts: {
      aligned_primary: 0,
      aligned_support: 0,
      hard_emergency_override: 0,
      hold_plan_blocked: 0,
    },
    actionsUnderCommanderPlans: 0,
    classifiedDecisions: 0,
    unknownDecisions: 0,
    rejectedDecisions: 0,
    unattributedDecisions: 0,
    planCount: 0,
    plansWithZeroAlignedActions: 0,
    planTransitions: 0,
    silentlyAbandonedPlans: 0,
    primaryDecisionCycles: 0,
    alignedPrimaryCycles: 0,
    blockedDecisionCycles: 0,
    blockedCycleRate: null,
    supportActions: 0,
    offFamilyActionViolations: 0,
    laterLayerActionViolations: 0,
    zeroPrimaryDecisionCycles: 0,
    planIdentityViolations: 0,
    batchPositionViolations: 0,
    fidelityStampViolations: 0,
    supportPerPlanViolations: 0,
    optionNotExecutableReplans: {
      count: 0,
      opportunities: 0,
      rate: null,
      dominates: false,
    },
    fidelityRate: null,
    interpretable: false,
  };
}

function planDurations(
  records: readonly AgentDecisionRecord[],
): CommanderArmMetrics["planDurationDecisions"] {
  const byPlan: Record<string, number> = {};
  for (const record of records) {
    const planID = metadataString(record, "planID");
    if (planID !== null) byPlan[planID] = (byPlan[planID] ?? 0) + 1;
  }
  return { mean: mean(Object.values(byPlan)), byPlan };
}

function planTransitionAudit(
  records: readonly AgentDecisionRecord[],
): CommanderArmMetrics["planTransitions"] {
  const replanReasons = new Set([
    "horizon_expiry",
    "option_not_executable",
    "hold_streak_blocked",
    "target_dead",
    "home_attacked",
    "option_appeared",
  ]);
  const terminateReasons = new Set([
    "no_exposed_options",
    "game_mismatch",
    "agent_mismatch",
    "decision_sequence_regressed",
  ]);
  let count = 0;
  let proven = 0;
  let violations = 0;
  for (let index = 0; index < records.length; index++) {
    const previous = index === 0 ? null : records[index - 1]!;
    const current = records[index]!;
    const previousPlanID =
      previous === null ? null : metadataString(previous, "planID");
    const currentPlanID = metadataString(current, "planID");
    const declaredPrevious = metadataString(current, "commanderPreviousPlanID");
    const installed =
      metadataBoolean(current, "commanderPlanInstalled") === true;
    const reason = metadataString(current, "commanderReplanReason");
    if (previousPlanID === currentPlanID) {
      if (declaredPrevious !== null || installed) violations += 1;
      continue;
    }
    count += 1;
    const priorMatches = declaredPrevious === previousPlanID;
    const installationMatches = installed === (currentPlanID !== null);
    const reasonMatches =
      previousPlanID === null && currentPlanID !== null
        ? reason === "no_active_plan"
        : previousPlanID !== null && currentPlanID === null
          ? terminateReasons.has(reason ?? "")
          : replanReasons.has(reason ?? "") ||
            terminateReasons.has(reason ?? "");
    if (priorMatches && installationMatches && reasonMatches) {
      proven += 1;
    } else {
      violations += 1;
    }
  }
  return { count, proven, violations };
}

interface CommanderFallbackPlanSets {
  required: ReadonlySet<string>;
  stamped: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
}

function fallbackPlanSets(
  records: readonly AgentDecisionRecord[],
): CommanderFallbackPlanSets {
  const required = new Set(
    distinctStrings(
      records
        .filter(independentlyRequiresFallbackPlan)
        .map((record) => metadataString(record, "planID")),
    ),
  );
  const stamped = new Set(
    distinctStrings(
      records
        .filter(
          (record) =>
            metadataBoolean(record, "plannerFallbackUsed") === true ||
            metadataString(record, "commanderSelectorSource") ===
              "fallback-deterministic",
        )
        .map((record) => metadataString(record, "planID")),
    ),
  );
  return {
    required,
    stamped,
    excluded: new Set([...required, ...stamped]),
  };
}

function independentlyRequiresFallbackPlan(
  record: AgentDecisionRecord,
): boolean {
  if (metadataString(record, "degradedCause") !== null) return true;
  if (metadataBoolean(record, "commanderPlanInstalled") !== true) return false;
  return isRejectedOrFailedAttempt(record);
}

function isRejectedOrFailedAttempt(record: AgentDecisionRecord): boolean {
  return (
    metadataString(record, "commanderResponseDisposition") === "rejected" ||
    metadataString(record, "commanderRejectionCode") !== null ||
    metadataString(record, "commanderSelectionFailureKind") !== null ||
    metadataString(record, "plannerParseFailureReason") !== null
  );
}

function fallbackPlanStampViolations(
  records: readonly AgentDecisionRecord[],
  planIDs: readonly string[],
  fallbackSets: CommanderFallbackPlanSets,
): number {
  let violations = 0;
  for (const planID of planIDs) {
    const planRecords = records.filter(
      (record) => metadataString(record, "planID") === planID,
    );
    const shouldBeFallback = fallbackSets.required.has(planID);
    if (fallbackSets.stamped.has(planID) !== shouldBeFallback) {
      violations += 1;
    }
    const expectedSelector = shouldBeFallback ? "fallback-deterministic" : null;
    const primarySelectors = new Set(
      planRecords.map((record) =>
        metadataString(record, "commanderPrimarySelectorSource"),
      ),
    );
    if (primarySelectors.size !== 1 || primarySelectors.has(null)) {
      violations += 1;
    }
    for (const record of planRecords) {
      const stampedFallback =
        metadataBoolean(record, "plannerFallbackUsed") === true;
      const selector = metadataString(record, "commanderSelectorSource");
      if (stampedFallback !== shouldBeFallback) violations += 1;
      if (
        shouldBeFallback
          ? selector !== expectedSelector
          : selector === "fallback-deterministic"
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

function deterministicPreferenceAudit(
  planStarts: readonly AgentDecisionRecord[],
): { absent: number; opportunities: number; violations: number } {
  let absent = 0;
  let opportunities = 0;
  let violations = 0;
  for (const record of planStarts) {
    const preferred = metadataString(
      record,
      "commanderDeterministicPreferredOptionId",
    );
    if (preferred === null) {
      violations += 1;
      continue;
    }
    opportunities += 1;
    const eligible = csv(metadataString(record, "commanderEligibleOptionIds"));
    const exposed = csv(metadataString(record, "commanderExposedOptionIds"));
    const derivedAbsent = !exposed.includes(preferred);
    if (!eligible.includes(preferred)) violations += 1;
    if (
      metadataBoolean(record, "commanderDeterministicPreferredOptionAbsent") !==
      derivedAbsent
    ) {
      violations += 1;
    }
    if (derivedAbsent) absent += 1;
  }
  return { absent, opportunities, violations };
}

function canonicalActionViolationCount(
  _run: CommanderArmRunInput,
  record: AgentDecisionRecord,
): number {
  if (!record.legalActionIDs.includes(record.chosenActionID)) return 1;
  if (record.result.accepted !== true) return 1;
  if (record.chosenActionKind === "hold") {
    return record.intent === null && record.result.submittedIntent === null
      ? 0
      : 1;
  }
  if (
    record.intent === null ||
    record.intent === undefined ||
    record.result.submittedIntent === null ||
    record.result.submittedIntent === undefined
  ) {
    return 1;
  }
  if (stableJson(record.intent) !== stableJson(record.result.submittedIntent)) {
    return 1;
  }
  return 0;
}

function effectAuditMetrics(
  run: CommanderArmRunInput,
  records: readonly AgentDecisionRecord[],
): CommanderArmMetrics["effectAudit"] {
  const result: CommanderArmMetrics["effectAudit"] = {
    immediateViolations: 0,
    delayedConfirmed: 0,
    delayedPending: 0,
    delayedExpired: 0,
    delayedFailed: 0,
  };
  if (run.gameConfiguration.runnerMode !== "step-locked") return result;
  const ordered = [...records].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (let index = 0; index < ordered.length; index++) {
    const record = ordered[index]!;
    if (
      record.chosenActionKind === "hold" ||
      record.result.accepted !== true ||
      record.intent === null ||
      record.result.submittedIntent === null ||
      stableJson(record.intent) !== stableJson(record.result.submittedIntent)
    ) {
      continue;
    }
    const status = record.audit?.auditStatus;
    if (!isDelayedEffectAction(record)) {
      if (status !== "confirmed") result.immediateViolations += 1;
      continue;
    }
    if (status === "failed" || status === "not_applicable") {
      result.delayedFailed += 1;
      continue;
    }
    if (status === "confirmed") {
      result.delayedConfirmed += 1;
      continue;
    }
    const later = ordered
      .slice(index + 1)
      .filter(
        (candidate) =>
          candidate.agentID === record.agentID &&
          candidate.chosenActionKind !== "spawn" &&
          isPrimaryBatchRow(candidate),
      )
      .slice(0, COMMANDER_DELAYED_EFFECT_AUDIT_BOUND_CYCLES);
    if (later.some((candidate) => delayedEffectVisible(record, candidate))) {
      result.delayedConfirmed += 1;
    } else if (later.length >= COMMANDER_DELAYED_EFFECT_AUDIT_BOUND_CYCLES) {
      result.delayedExpired += 1;
    } else {
      result.delayedPending += 1;
    }
  }
  return result;
}

function isDelayedEffectAction(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "boat" ||
    record.chosenActionKind === "boat_retreat"
  );
}

function delayedEffectVisible(
  source: AgentDecisionRecord,
  later: AgentDecisionRecord,
): boolean {
  const baseline = source.audit?.before ?? null;
  const snapshots = [later.audit?.before, later.audit?.after].filter(
    (snapshot): snapshot is AgentActionAuditSnapshot =>
      snapshot !== null && snapshot !== undefined,
  );
  return snapshots.some((snapshot) =>
    source.intent?.type === "boat"
      ? boatEffectVisible(baseline, snapshot)
      : source.intent?.type === "cancel_boat"
        ? cancelBoatEffectVisible(baseline, snapshot, source.intent.unitID)
        : false,
  );
}

function boatEffectVisible(
  baseline: AgentActionAuditSnapshot | null,
  candidate: AgentActionAuditSnapshot,
): boolean {
  const beforeCount = baseline?.unitCounts[UnitType.TransportShip] ?? 0;
  const afterCount = candidate.unitCounts[UnitType.TransportShip] ?? 0;
  // Troop loss is not transport-specific: an unrelated attack or core event
  // can lower the same balance. Only direct transport evidence can close this
  // delayed audit.
  return afterCount > beforeCount;
}

function cancelBoatEffectVisible(
  baseline: AgentActionAuditSnapshot | null,
  candidate: AgentActionAuditSnapshot,
  unitID: number,
): boolean {
  const key = `${UnitType.TransportShip}:${unitID}`;
  const existed = baseline?.unitTiles?.[key] !== undefined;
  const exists = candidate.unitTiles?.[key] !== undefined;
  const retreating =
    candidate.transportRetreatingUnitIDs?.includes(unitID) ?? false;
  return (existed && !exists) || retreating;
}

function optionAccountingViolationCount(record: AgentDecisionRecord): number {
  const eligible = csv(metadataString(record, "commanderEligibleOptionIds"));
  const exposed = csv(metadataString(record, "commanderExposedOptionIds"));
  const omitted = omittedEntries(
    metadataString(record, "commanderOmittedOptions"),
  );
  const omittedIDs = omitted.map((entry) => entry.id);
  let violations = 0;
  if (eligible.length === 0 || exposed.length === 0) violations += 1;
  if (!allUnique(eligible)) violations += 1;
  if (!allUnique(exposed)) violations += 1;
  if (!allUnique(omittedIDs)) violations += 1;
  if (exposed.some((id) => omittedIDs.includes(id))) violations += 1;
  if (!sameStringSet(eligible, [...exposed, ...omittedIDs])) violations += 1;
  if (exposed.length > MAX_COMMANDER_EXPOSED_OPTIONS) violations += 1;
  if (
    exposed.filter((id) => optionFamily(id) === "pressure_rival").length >
    MAX_COMMANDER_EXPOSED_PRESSURE_OPTIONS
  ) {
    violations += 1;
  }
  if (
    [...eligible, ...exposed, ...omittedIDs].some(
      (id) => !isStrategicOptionID(id),
    )
  ) {
    violations += 1;
  }
  const eligibleFamilies = new Set(eligible.map(optionFamily));
  const exposedFamilies = new Set(exposed.map(optionFamily));
  if ([...eligibleFamilies].some((family) => !exposedFamilies.has(family))) {
    violations += 1;
  }
  for (const entry of omitted) {
    if (
      !new Set(["family_cap", "pressure_target_cap", "exposure_cap"]).has(
        entry.reason,
      )
    ) {
      violations += 1;
    } else if (
      entry.reason === "pressure_target_cap" &&
      (optionFamily(entry.id) !== "pressure_rival" ||
        exposed.filter((id) => optionFamily(id) === "pressure_rival").length !==
          MAX_COMMANDER_EXPOSED_PRESSURE_OPTIONS)
    ) {
      violations += 1;
    } else if (
      entry.reason === "exposure_cap" &&
      exposed.length !== MAX_COMMANDER_EXPOSED_OPTIONS
    ) {
      violations += 1;
    } else if (
      entry.reason === "family_cap" &&
      !exposedFamilies.has(optionFamily(entry.id))
    ) {
      violations += 1;
    }
  }
  const eligiblePressure = eligible.filter(
    (id) => optionFamily(id) === "pressure_rival",
  ).length;
  const exposedPressure = exposed.filter(
    (id) => optionFamily(id) === "pressure_rival",
  ).length;
  const omittedPressure = omitted.filter(
    (entry) => optionFamily(entry.id) === "pressure_rival",
  ).length;
  if (
    exposedPressure !==
      Math.min(eligiblePressure, MAX_COMMANDER_EXPOSED_PRESSURE_OPTIONS) ||
    omittedPressure !== Math.max(0, eligiblePressure - exposedPressure)
  ) {
    violations += 1;
  }
  return violations;
}

function boundedOutcomeDelta(
  disagreement: AgentDecisionRecord,
  cycles: readonly AgentDecisionRecord[],
): CommanderArmMetrics["boundedOutcomeDeltasAfterDisagreement"][number] {
  const horizon =
    metadataNumber(disagreement, "commanderHorizonDecisions") ?? 3;
  const startIndex = cycles.indexOf(disagreement);
  const window = cycles.slice(startIndex, startIndex + Math.max(1, horizon));
  const final = window.at(-1) ?? disagreement;
  return {
    planID: metadataString(disagreement, "planID") ?? "unknown",
    selectedOptionID:
      metadataString(disagreement, "planObjective") ?? "unknown",
    deterministicOptionID:
      metadataString(disagreement, "commanderDeterministicPreferredOptionId") ??
      "unknown",
    horizonDecisions: horizon,
    observedDecisionCycles: window.length,
    tilesDelta: nullableDelta(
      metadataNumber(disagreement, "commanderSelfTiles"),
      metadataNumber(final, "commanderSelfTiles"),
    ),
    troopsDelta: nullableDelta(
      metadataNumber(disagreement, "commanderSelfTroops"),
      metadataNumber(final, "commanderSelfTroops"),
    ),
  };
}

function finalOutcome(run: CommanderArmRunInput): {
  won: boolean;
  winnerDetermined: boolean;
  normalizedTerritory: number | null;
  rank: number | null;
  survived: boolean | null;
} {
  const subject = run.finalState?.players.find(
    (player) => player.agentID === run.subjectAgentID,
  );
  const allPlayers = [
    ...(run.finalState?.players ?? []),
    ...(run.finalState?.opponents ?? []),
  ].filter((player) => player.tilesOwned !== null);
  const totalTiles = sum(allPlayers.map((player) => player.tilesOwned ?? 0));
  const subjectTiles = subject?.tilesOwned ?? null;
  const sorted = [...allPlayers].sort(
    (left, right) => (right.tilesOwned ?? 0) - (left.tilesOwned ?? 0),
  );
  const subjectClientID = run.roster.find(
    (entry) => entry.agentID === run.subjectAgentID,
  )?.clientID;
  const won = run.winner?.[0] === "player" && run.winner[1] === subjectClientID;
  const rankIndex =
    subject === undefined
      ? -1
      : sorted.findIndex((player) => player.agentID === subject.agentID);
  return {
    won,
    winnerDetermined: run.winner !== undefined,
    normalizedTerritory:
      subjectTiles === null || totalTiles === 0
        ? null
        : subjectTiles / totalTiles,
    rank: rankIndex === -1 ? null : rankIndex + 1,
    survived: subject?.isAlive ?? null,
  };
}

function sameNormalizedRoster(
  left: {
    roster: AgentRunRosterEntry[];
    subjectAgentID: string;
  },
  right: {
    roster: AgentRunRosterEntry[];
    subjectAgentID: string;
  },
): boolean {
  const normalize = (run: {
    roster: AgentRunRosterEntry[];
    subjectAgentID: string;
  }) =>
    run.roster.map((entry, index) => ({
      index,
      agentID: entry.agentID,
      clientID: entry.clientID,
      username: entry.username,
      profile: entry.profile,
      brainType:
        entry.agentID === run.subjectAgentID
          ? "subject-treatment"
          : entry.brainType,
    }));
  return stableJson(normalize(left)) === stableJson(normalize(right));
}

function subjectRosterEntry(
  arm: CommanderArmTripletReport["arms"][CommanderExperimentArm],
): AgentRunRosterEntry | undefined {
  return arm.roster.find((entry) => entry.agentID === arm.subjectAgentID);
}

function hasCompleteSpawnAssignments(
  arm: CommanderArmTripletReport["arms"][CommanderExperimentArm],
): boolean {
  const assignedIDs = Object.keys(arm.spawnAssignments).sort();
  const rosterIDs = arm.roster.map((entry) => entry.agentID).sort();
  return (
    stableJson(rosterIDs) === stableJson(assignedIDs) &&
    assignedIDs.every((agentID) =>
      /^spawn:\d+$/.test(arm.spawnAssignments[agentID] ?? ""),
    )
  );
}

function sameInitialOptionSurface(
  left: CommanderArmRunInput,
  right: CommanderArmRunInput,
): boolean {
  const first = (run: CommanderArmRunInput) =>
    run.records.find(
      (record) =>
        record.agentID === run.subjectAgentID &&
        metadataString(record, "commanderExposedOptionIds") !== null &&
        record.chosenActionKind !== "spawn" &&
        isPrimaryBatchRow(record),
    );
  const leftFirst = first(left);
  const rightFirst = first(right);
  if (leftFirst === undefined || rightFirst === undefined) return false;
  return (
    metadataString(leftFirst, "commanderEligibleOptionIds") ===
      metadataString(rightFirst, "commanderEligibleOptionIds") &&
    metadataString(leftFirst, "commanderExposedOptionIds") ===
      metadataString(rightFirst, "commanderExposedOptionIds") &&
    metadataString(leftFirst, "commanderFingerprint") ===
      metadataString(rightFirst, "commanderFingerprint")
  );
}

function isPrimaryBatchRow(record: AgentDecisionRecord): boolean {
  const batchIndex = metadataNumber(record, "batchIndex");
  return batchIndex === null || batchIndex === 0;
}

function isAutopilot(record: AgentDecisionRecord): boolean {
  return metadataString(record, "runtimeMode") === "autopilot-executor";
}

function isRejectedStaleAttempt(record: AgentDecisionRecord): boolean {
  return (
    metadataString(record, "commanderRejectionCode") ===
      "decision_sequence_stale" &&
    metadataString(record, "commanderResponseDisposition") === "rejected"
  );
}

function isStaleAuthorityViolation(record: AgentDecisionRecord): boolean {
  return (
    metadataString(record, "commanderRejectionCode") ===
      "decision_sequence_stale" &&
    metadataString(record, "commanderResponseDisposition") !== "rejected"
  );
}

function countMetadata(
  records: readonly AgentDecisionRecord[],
  key: string,
  value: string,
): number {
  return records.filter((record) => metadataString(record, key) === value)
    .length;
}

function metadataString(
  record: AgentDecisionRecord,
  key: string,
): string | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataNumber(
  record: AgentDecisionRecord,
  key: string,
): number | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataBoolean(
  record: AgentDecisionRecord,
  key: string,
): boolean | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function optionFamily(optionID: string): string {
  return optionID.startsWith("pressure_rival:") ? "pressure_rival" : optionID;
}

function omittedEntries(
  value: string | null,
): Array<{ id: string; reason: string }> {
  return csv(value).map((entry) => {
    const split = entry.lastIndexOf(":");
    return split === -1
      ? { id: entry, reason: "unknown" }
      : { id: entry.slice(0, split), reason: entry.slice(split + 1) };
  });
}

function csv(value: string | null): string[] {
  return value === null
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function distinctStrings(values: readonly (string | null)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
}

function countStrings(
  values: readonly (string | null)[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (value !== null) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    new Set(left).size === new Set(right).size &&
    [...new Set(left)].every((value) => new Set(right).has(value))
  );
}

function isStrategicOptionID(value: string): boolean {
  return (
    value === "expand" ||
    value === "develop_economy" ||
    value === "survive" ||
    /^pressure_rival:[^,:\s]+$/.test(value)
  );
}

function singleNullableValue(
  values: readonly (string | null)[],
): string | null {
  if (values.length === 0) return null;
  const normalized = values.map((value) => value ?? "<null>");
  if (new Set(normalized).size !== 1) return "conflict";
  return values[0] ?? null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function nullableDelta(
  control: number | null,
  treatment: number | null,
): number | null {
  return control === null || treatment === null ? null : treatment - control;
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  errorMessage: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(errorMessage);
  }
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}
