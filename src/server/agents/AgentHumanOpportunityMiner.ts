import type {
  AgentHomeDangerLevel,
  AgentTacticalAffordances,
  LegalActionKind,
} from "./AgentTypes";

export interface AgentHumanOpportunityBaseline {
  firstNeutralAttackMinute: number | null;
  firstPlayerAttackMinute: number | null;
  firstBoatMinute: number | null;
  firstBuildMinute: number | null;
  neutralAttacksFirstTwoMinutes: number | null;
  neutralAttacksFirstFiveMinutes: number | null;
  playerAttacksFirstFiveMinutes: number | null;
  boatsFirstFiveMinutes: number | null;
  tradeShips: number | null;
  tradeGold: number | null;
  capturedCities: number | null;
  capturedFactories: number | null;
  capturedPorts: number | null;
}

export interface AgentHumanOpportunityReportInput {
  reportID: string;
  generatedAt?: number;
  source: string;
  humanCorpusID?: string | null;
  humanBaseline: AgentHumanOpportunityBaseline;
  turnsPerMinute?: number;
  runs: AgentHumanOpportunityRunInput[];
}

export interface AgentHumanOpportunityRunInput {
  runID: string;
  benchmarkRunIndex?: number | null;
  won?: boolean | null;
  survived?: boolean | null;
  tileShare?: number | null;
  turns?: number | null;
  records: AgentDecisionRecordLike[];
}

export interface AgentDecisionRecordLike {
  sequence?: number;
  gameID?: string;
  turnNumber: number;
  agentID: string;
  username?: string;
  profile?: string;
  chosenActionKind?: LegalActionKind | string;
  selectedActionKind?: LegalActionKind | string;
  chosenActionID?: string;
  selectedLegalActionId?: string;
  chosenActionMetadata?: Record<string, string | number | boolean | null>;
  selectedActionMetadata?: Record<string, string | number | boolean | null>;
  decisionMetadata?: Record<string, string | number | boolean | null>;
  legalActionIDsByKind?: Partial<Record<LegalActionKind | string, string[]>>;
  tacticalAffordances?: AgentTacticalAffordances;
  strategicPriority?: string;
  strategicUrgency?: string;
  reason?: string;
  batchActionIDs?: string[];
}

export type AgentRepeatedProbeClass =
  | "none"
  | "decisive_escalation_available"
  | "banking_alternative"
  | "growth_or_economy_alternative"
  | "buying_time_pressure"
  | "stale_no_clear_alternative";

export interface AgentHumanOpportunitySubjectSummary {
  runID: string;
  benchmarkRunIndex: number | null;
  agentID: string;
  username: string;
  profile: string | null;
  won: boolean | null;
  survived: boolean | null;
  tileShare: number | null;
  turns: number | null;
  decisionCount: number;
  decisionCycleCount: number;
  firstSpawnMinute: number | null;
  firstNeutralExpansionMinute: number | null;
  firstPlayerAttackMinute: number | null;
  firstBoatMinute: number | null;
  firstBuildMinute: number | null;
  neutralExpansionFirstTwoMinutes: number;
  neutralExpansionFirstFiveMinutes: number;
  playerAttacksFirstFiveMinutes: number;
  boatsFirstFiveMinutes: number;
  buildsFirstFiveMinutes: number;
  socialActionsFirstFiveMinutes: number;
  holdActionsFirstFiveMinutes: number;
  legalNeutralLandCyclesFirstTwoMinutes: number;
  missedNeutralLandCyclesFirstTwoMinutes: number;
  legalNeutralBoatCyclesFirstFiveMinutes: number;
  missedNeutralBoatCyclesFirstFiveMinutes: number;
  legalEconomyBuildCyclesFirstThreeMinutes: number;
  missedEconomyBuildCyclesFirstThreeMinutes: number;
  legalPressureCyclesFirstThreeMinutes: number;
  missedPressureCyclesFirstThreeMinutes: number;
  conversionRecommendedCycles: number;
  missedConversionCycles: number;
  bankingRecommendedCycles: number;
  missedBankingCycles: number;
  repeatedProbeCycles: number;
  missedRepeatedProbeCycles: number;
  repeatedProbeEscalationOpportunityCycles: number;
  repeatedProbeBankingAlternativeCycles: number;
  repeatedProbeGrowthAlternativeCycles: number;
  repeatedProbeBuyingTimeCycles: number;
  repeatedProbeNoClearAlternativeCycles: number;
  attackSafetyOpportunityCycles: number;
  attackSafetyNeutralGrowthOpportunityCycles: number;
  unsafeUrgentDefenseAttackCycles: number;
  gaps: string[];
}

export interface AgentHumanOpportunityGapExample {
  runID: string;
  benchmarkRunIndex: number | null;
  agentID: string;
  username: string;
  turnNumber: number;
  minute: number;
  selectedActionIds: string[];
  selectedActionKinds: string[];
  neutralLandOptions: number;
  neutralBoatOptions: number;
  economyBuildOptions: number;
  hostileAttackOptions: number;
  conversionReadyOptions: number;
  bankingBoatOptions: number;
  repeatedLowProbe: boolean;
  repeatedProbeClass: AgentRepeatedProbeClass;
  attackSafetyHold: boolean;
  attackSafetyNeutralGrowthOpportunity: boolean;
  unsafeUrgentDefenseAttack: boolean;
  homeDanger: AgentHomeDangerLevel | "unknown";
  reason: string | null;
}

export interface AgentHumanOpportunityGap {
  gapID:
    | "opening_neutral_saturation"
    | "early_neutral_boats"
    | "economy_timing"
    | "pressure_handoff"
    | "weak_rival_conversion"
    | "transport_troop_banking"
    | "repeated_probe_discipline"
    | "attack_safety_opportunity"
    | "unsafe_urgent_defense_attack";
  title: string;
  severity: "high" | "medium" | "low" | "none";
  affectedSubjectCount: number;
  missedDecisionCycleCount: number;
  evidence: string;
  examples: AgentHumanOpportunityGapExample[];
  nextExperiment: string;
}

export interface AgentHumanOpportunityReport {
  schemaVersion: 1;
  reportID: string;
  generatedAt: string;
  source: string;
  humanCorpusID: string | null;
  turnsPerMinute: number;
  subjectCount: number;
  humanBaseline: AgentHumanOpportunityBaseline;
  aggregate: AgentHumanOpportunityAggregate;
  subjects: AgentHumanOpportunitySubjectSummary[];
  gaps: AgentHumanOpportunityGap[];
  llmReviewPacket: {
    role: "human_baseline_opportunity_researcher";
    constraints: string[];
    requestedOutput: string[];
  };
}

export interface AgentHumanOpportunityAggregate {
  firstNeutralExpansionMinute: number | null;
  firstPlayerAttackMinute: number | null;
  firstBoatMinute: number | null;
  firstBuildMinute: number | null;
  neutralExpansionFirstTwoMinutes: number | null;
  neutralExpansionFirstFiveMinutes: number | null;
  playerAttacksFirstFiveMinutes: number | null;
  boatsFirstFiveMinutes: number | null;
  buildsFirstFiveMinutes: number | null;
  socialActionsFirstFiveMinutes: number | null;
  holdActionsFirstFiveMinutes: number | null;
  missedNeutralLandCyclesFirstTwoMinutes: number;
  missedNeutralBoatCyclesFirstFiveMinutes: number;
  missedEconomyBuildCyclesFirstThreeMinutes: number;
  missedPressureCyclesFirstThreeMinutes: number;
  missedConversionCycles: number;
  missedBankingCycles: number;
  missedRepeatedProbeCycles: number;
  repeatedProbeEscalationOpportunityCycles: number;
  repeatedProbeBankingAlternativeCycles: number;
  repeatedProbeGrowthAlternativeCycles: number;
  repeatedProbeBuyingTimeCycles: number;
  repeatedProbeNoClearAlternativeCycles: number;
  attackSafetyOpportunityCycles: number;
  attackSafetyNeutralGrowthOpportunityCycles: number;
  unsafeUrgentDefenseAttackCycles: number;
}

interface DecisionCycle {
  run: AgentHumanOpportunityRunInput;
  agentID: string;
  username: string;
  profile: string | null;
  turnNumber: number;
  minute: number;
  records: AgentDecisionRecordLike[];
}

export function buildAgentHumanOpportunityReport(
  input: AgentHumanOpportunityReportInput,
): AgentHumanOpportunityReport {
  const turnsPerMinute = input.turnsPerMinute ?? 600;
  cachedCycles.length = 0;
  const subjects = input.runs.flatMap((run) =>
    summarizeRunSubjects(run, turnsPerMinute, input.humanBaseline),
  );
  const gaps = buildGaps(subjects, input.humanBaseline);
  return {
    schemaVersion: 1,
    reportID: input.reportID,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    source: input.source,
    humanCorpusID: input.humanCorpusID ?? null,
    turnsPerMinute,
    subjectCount: subjects.length,
    humanBaseline: input.humanBaseline,
    aggregate: aggregateSubjects(subjects),
    subjects,
    gaps,
    llmReviewPacket: {
      role: "human_baseline_opportunity_researcher",
      constraints: [
        "Use this report to compare canonical agent decisions with mined human replay timing.",
        "Do not propose raw game intents or a second action schema.",
        "Any in-match change must still select one existing LegalAction.id through the canonical validator.",
        "Prefer general opportunity categories over one-off map-specific rules.",
      ],
      requestedOutput: [
        "Identify the highest-severity gap and the exact agent module that should change.",
        "Name the LegalAction kinds that were visible but not selected.",
        "Separate opening timing misses from conversion, banking, repeated-probe, urgent-defense, and attack-safety misses.",
        "Propose one benchmarkable A/B change and a promotion metric.",
      ],
    },
  };
}

export function humanOpportunityReportMarkdown(
  report: AgentHumanOpportunityReport,
): string {
  return [
    `# Human Baseline Opportunity Report: ${report.reportID}`,
    "",
    `Generated: ${report.generatedAt}`,
    `Source: ${report.source}`,
    `Human corpus: ${report.humanCorpusID ?? "unknown"}`,
    `Subjects: ${report.subjectCount}`,
    "",
    "## Human Baseline",
    "",
    markdownTable(
      [
        "First Neutral",
        "First Player",
        "First Boat",
        "First Build",
        "Neutral 0-2m",
        "Neutral 0-5m",
        "Player 0-5m",
        "Boats 0-5m",
      ],
      [
        [
          formatMinute(report.humanBaseline.firstNeutralAttackMinute),
          formatMinute(report.humanBaseline.firstPlayerAttackMinute),
          formatMinute(report.humanBaseline.firstBoatMinute),
          formatMinute(report.humanBaseline.firstBuildMinute),
          formatNumber(report.humanBaseline.neutralAttacksFirstTwoMinutes),
          formatNumber(report.humanBaseline.neutralAttacksFirstFiveMinutes),
          formatNumber(report.humanBaseline.playerAttacksFirstFiveMinutes),
          formatNumber(report.humanBaseline.boatsFirstFiveMinutes),
        ],
      ],
    ),
    "",
    "## Agent Aggregate",
    "",
    markdownTable(
      [
        "First Neutral",
        "First Player",
        "First Boat",
        "First Build",
        "Neutral 0-2m",
        "Neutral 0-5m",
        "Player 0-5m",
        "Boats 0-5m",
        "Missed Neutral",
        "Missed Boats",
        "Missed Economy",
        "Missed Pressure",
        "Missed Conversion",
        "Missed Banking",
        "Repeated Probes",
        "Probe Esc.",
        "Probe Alt.",
        "Probe Buy",
        "Safety Holds",
        "Safety Neutral",
        "Unsafe Defense",
      ],
      [
        [
          formatMinute(report.aggregate.firstNeutralExpansionMinute),
          formatMinute(report.aggregate.firstPlayerAttackMinute),
          formatMinute(report.aggregate.firstBoatMinute),
          formatMinute(report.aggregate.firstBuildMinute),
          formatNumber(report.aggregate.neutralExpansionFirstTwoMinutes),
          formatNumber(report.aggregate.neutralExpansionFirstFiveMinutes),
          formatNumber(report.aggregate.playerAttacksFirstFiveMinutes),
          formatNumber(report.aggregate.boatsFirstFiveMinutes),
          String(report.aggregate.missedNeutralLandCyclesFirstTwoMinutes),
          String(report.aggregate.missedNeutralBoatCyclesFirstFiveMinutes),
          String(report.aggregate.missedEconomyBuildCyclesFirstThreeMinutes),
          String(report.aggregate.missedPressureCyclesFirstThreeMinutes),
          String(report.aggregate.missedConversionCycles),
          String(report.aggregate.missedBankingCycles),
          String(report.aggregate.missedRepeatedProbeCycles),
          String(report.aggregate.repeatedProbeEscalationOpportunityCycles),
          String(
            report.aggregate.repeatedProbeBankingAlternativeCycles +
              report.aggregate.repeatedProbeGrowthAlternativeCycles,
          ),
          String(report.aggregate.repeatedProbeBuyingTimeCycles),
          String(report.aggregate.attackSafetyOpportunityCycles),
          String(report.aggregate.attackSafetyNeutralGrowthOpportunityCycles),
          String(report.aggregate.unsafeUrgentDefenseAttackCycles),
        ],
      ],
    ),
    "",
    "## Gaps",
    "",
    markdownTable(
      ["Gap", "Severity", "Subjects", "Missed Cycles", "Evidence"],
      report.gaps.map((gap) => [
        gap.title,
        gap.severity,
        String(gap.affectedSubjectCount),
        String(gap.missedDecisionCycleCount),
        gap.evidence,
      ]),
    ),
    "",
    "## Subject Timelines",
    "",
    markdownTable(
      [
        "Run",
        "Agent",
        "First Neutral",
        "First Player",
        "First Boat",
        "First Build",
        "Neutral 0-2m",
        "Player 0-5m",
        "Boats 0-5m",
        "Miss Conv.",
        "Miss Bank",
        "Rep. Probe",
        "Probe Esc.",
        "Probe Alt.",
        "Probe Buy",
        "Safety Holds",
        "Safety Neutral",
        "Unsafe Def.",
        "Gaps",
      ],
      report.subjects.map((subject) => [
        subject.runID,
        subject.username,
        formatMinute(subject.firstNeutralExpansionMinute),
        formatMinute(subject.firstPlayerAttackMinute),
        formatMinute(subject.firstBoatMinute),
        formatMinute(subject.firstBuildMinute),
        String(subject.neutralExpansionFirstTwoMinutes),
        String(subject.playerAttacksFirstFiveMinutes),
        String(subject.boatsFirstFiveMinutes),
        String(subject.missedConversionCycles),
        String(subject.missedBankingCycles),
        String(subject.missedRepeatedProbeCycles),
        String(subject.repeatedProbeEscalationOpportunityCycles),
        String(
          subject.repeatedProbeBankingAlternativeCycles +
            subject.repeatedProbeGrowthAlternativeCycles,
        ),
        String(subject.repeatedProbeBuyingTimeCycles),
        String(subject.attackSafetyOpportunityCycles),
        String(subject.attackSafetyNeutralGrowthOpportunityCycles),
        String(subject.unsafeUrgentDefenseAttackCycles),
        subject.gaps.join(", ") || "none",
      ]),
    ),
    "",
    "## Examples",
    "",
    ...report.gaps.flatMap((gap) => [
      `### ${gap.title}`,
      "",
      gap.examples.length === 0
        ? "No examples captured."
        : markdownTable(
            [
              "Run",
              "Agent",
              "Minute",
              "Selected",
              "Neutral",
              "Boats",
              "Economy",
              "Hostile",
              "Conv.",
              "Bank",
              "Repeat",
              "Probe Class",
              "Safety",
              "Unsafe",
              "Reason",
            ],
            gap.examples.map((example) => [
              example.runID,
              example.username,
              formatMinute(example.minute),
              example.selectedActionIds.join(", "),
              String(example.neutralLandOptions),
              String(example.neutralBoatOptions),
              String(example.economyBuildOptions),
              String(example.hostileAttackOptions),
              String(example.conversionReadyOptions),
              String(example.bankingBoatOptions),
              example.repeatedLowProbe ? "yes" : "no",
              example.repeatedProbeClass,
              example.attackSafetyHold ? "yes" : "no",
              example.unsafeUrgentDefenseAttack ? "yes" : "no",
              example.reason ?? "",
            ]),
          ),
      "",
      `Next experiment: ${gap.nextExperiment}`,
      "",
    ]),
    "## LLM Review Packet",
    "",
    "```json",
    JSON.stringify(report.llmReviewPacket, null, 2),
    "```",
    "",
  ].join("\n");
}

export function humanBaselineFromOpportunityAtlas(
  atlas: unknown,
): AgentHumanOpportunityBaseline {
  const root = atlas as {
    baselines?: {
      winners?: Record<string, unknown>;
      topCandidates?: Record<string, unknown>;
    };
  };
  const winners = root.baselines?.winners ?? {};
  return {
    firstNeutralAttackMinute: numberField(winners, "firstNeutralAttackMedian"),
    firstPlayerAttackMinute: numberField(winners, "firstPlayerAttackMedian"),
    firstBoatMinute: numberField(winners, "firstBoatMedian"),
    firstBuildMinute: numberField(winners, "firstBuildMedian"),
    neutralAttacksFirstTwoMinutes: numberField(
      winners,
      "neutralAttacks0to2Median",
    ),
    neutralAttacksFirstFiveMinutes: numberField(
      winners,
      "neutralAttacks0to5Median",
    ),
    playerAttacksFirstFiveMinutes: numberField(
      winners,
      "playerAttacks0to5Median",
    ),
    boatsFirstFiveMinutes: numberField(winners, "boats0to5Median"),
    tradeShips: numberField(winners, "tradeShipsMedian"),
    tradeGold: numberField(winners, "tradeGoldMedian"),
    capturedCities: numberField(winners, "capturedCitiesMedian"),
    capturedFactories: numberField(winners, "capturedFactoriesMedian"),
    capturedPorts: numberField(winners, "capturedPortsMedian"),
  };
}

function summarizeRunSubjects(
  run: AgentHumanOpportunityRunInput,
  turnsPerMinute: number,
  baseline: AgentHumanOpportunityBaseline,
): AgentHumanOpportunitySubjectSummary[] {
  const byAgent = new Map<string, AgentDecisionRecordLike[]>();
  for (const record of run.records) {
    const agentRecords = byAgent.get(record.agentID) ?? [];
    agentRecords.push(record);
    byAgent.set(record.agentID, agentRecords);
  }

  return Array.from(byAgent.entries()).map(([agentID, records]) => {
    records.sort(
      (left, right) =>
        left.turnNumber - right.turnNumber ||
        (left.sequence ?? 0) - (right.sequence ?? 0),
    );
    const cycles = decisionCycles(run, agentID, records, turnsPerMinute);
    cachedCycles.push(...cycles);
    const actionCounts = countActions(records, turnsPerMinute);
    const opportunityCounts = countOpportunityCycles(cycles, baseline);
    const firsts = firstActionMinutes(cycles);
    const username = records.find((record) => record.username)?.username;
    const profile = records.find((record) => record.profile)?.profile ?? null;
    const summary: AgentHumanOpportunitySubjectSummary = {
      runID: run.runID,
      benchmarkRunIndex: run.benchmarkRunIndex ?? null,
      agentID,
      username: username ?? agentID,
      profile,
      won: run.won ?? null,
      survived: run.survived ?? null,
      tileShare: run.tileShare ?? null,
      turns: run.turns ?? null,
      decisionCount: records.length,
      decisionCycleCount: cycles.length,
      ...firsts,
      ...actionCounts,
      ...opportunityCounts,
      gaps: [],
    };
    summary.gaps = subjectGapIDs(summary, baseline);
    return summary;
  });
}

function decisionCycles(
  run: AgentHumanOpportunityRunInput,
  agentID: string,
  records: AgentDecisionRecordLike[],
  turnsPerMinute: number,
): DecisionCycle[] {
  const byTurn = new Map<number, AgentDecisionRecordLike[]>();
  for (const record of records) {
    const turnRecords = byTurn.get(record.turnNumber) ?? [];
    turnRecords.push(record);
    byTurn.set(record.turnNumber, turnRecords);
  }
  return Array.from(byTurn.entries())
    .sort(([left], [right]) => left - right)
    .map(([turnNumber, cycleRecords]) => ({
      run,
      agentID,
      username:
        cycleRecords.find((record) => record.username)?.username ?? agentID,
      profile: cycleRecords.find((record) => record.profile)?.profile ?? null,
      turnNumber,
      minute: round2(turnNumber / turnsPerMinute),
      records: cycleRecords,
    }));
}

function countActions(
  records: AgentDecisionRecordLike[],
  turnsPerMinute: number,
) {
  let neutralExpansionFirstTwoMinutes = 0;
  let neutralExpansionFirstFiveMinutes = 0;
  let playerAttacksFirstFiveMinutes = 0;
  let boatsFirstFiveMinutes = 0;
  let buildsFirstFiveMinutes = 0;
  let socialActionsFirstFiveMinutes = 0;
  let holdActionsFirstFiveMinutes = 0;
  for (const record of records) {
    const minute = record.turnNumber / turnsPerMinute;
    if (minute > 5) {
      continue;
    }
    if (isNeutralExpansionRecord(record)) {
      neutralExpansionFirstFiveMinutes += 1;
      if (minute <= 2) {
        neutralExpansionFirstTwoMinutes += 1;
      }
    }
    if (isPlayerAttackRecord(record)) {
      playerAttacksFirstFiveMinutes += 1;
    }
    if (isBoatRecord(record)) {
      boatsFirstFiveMinutes += 1;
    }
    if (isBuildRecord(record)) {
      buildsFirstFiveMinutes += 1;
    }
    if (isSocialRecord(record)) {
      socialActionsFirstFiveMinutes += 1;
    }
    if (selectedActionKind(record) === "hold") {
      holdActionsFirstFiveMinutes += 1;
    }
  }
  return {
    neutralExpansionFirstTwoMinutes,
    neutralExpansionFirstFiveMinutes,
    playerAttacksFirstFiveMinutes,
    boatsFirstFiveMinutes,
    buildsFirstFiveMinutes,
    socialActionsFirstFiveMinutes,
    holdActionsFirstFiveMinutes,
  };
}

function countOpportunityCycles(
  cycles: DecisionCycle[],
  baseline: AgentHumanOpportunityBaseline,
) {
  let legalNeutralLandCyclesFirstTwoMinutes = 0;
  let missedNeutralLandCyclesFirstTwoMinutes = 0;
  let legalNeutralBoatCyclesFirstFiveMinutes = 0;
  let missedNeutralBoatCyclesFirstFiveMinutes = 0;
  let legalEconomyBuildCyclesFirstThreeMinutes = 0;
  let missedEconomyBuildCyclesFirstThreeMinutes = 0;
  let legalPressureCyclesFirstThreeMinutes = 0;
  let missedPressureCyclesFirstThreeMinutes = 0;
  let conversionRecommendedCycles = 0;
  let missedConversionCycles = 0;
  let bankingRecommendedCycles = 0;
  let missedBankingCycles = 0;
  let repeatedProbeCycles = 0;
  let missedRepeatedProbeCycles = 0;
  let repeatedProbeEscalationOpportunityCycles = 0;
  let repeatedProbeBankingAlternativeCycles = 0;
  let repeatedProbeGrowthAlternativeCycles = 0;
  let repeatedProbeBuyingTimeCycles = 0;
  let repeatedProbeNoClearAlternativeCycles = 0;
  let attackSafetyOpportunityCycles = 0;
  let attackSafetyNeutralGrowthOpportunityCycles = 0;
  let unsafeUrgentDefenseAttackCycles = 0;
  const pressureStart = baseline.firstPlayerAttackMinute ?? 1.3;

  for (let index = 0; index < cycles.length; index += 1) {
    const cycle = cycles[index]!;
    if (cycle.minute <= 2 && neutralLandOptions(cycle) > 0) {
      legalNeutralLandCyclesFirstTwoMinutes += 1;
      if (!cycle.records.some(isNeutralLandExpansionRecord)) {
        missedNeutralLandCyclesFirstTwoMinutes += 1;
      }
    }
    if (cycle.minute <= 5 && clearNeutralBoatOpportunity(cycle)) {
      legalNeutralBoatCyclesFirstFiveMinutes += 1;
      if (!cycle.records.some(isNeutralBoatRecord)) {
        missedNeutralBoatCyclesFirstFiveMinutes += 1;
      }
    }
    if (cycle.minute <= 3 && economyBuildOptions(cycle) > 0) {
      legalEconomyBuildCyclesFirstThreeMinutes += 1;
      if (!cycle.records.some(isEconomyBuildRecord)) {
        missedEconomyBuildCyclesFirstThreeMinutes += 1;
      }
    }
    if (
      cycle.minute >= pressureStart &&
      cycle.minute <= 3 &&
      hostileAttackOptions(cycle) > 0
    ) {
      legalPressureCyclesFirstThreeMinutes += 1;
      if (!cycle.records.some(isPlayerAttackRecord)) {
        missedPressureCyclesFirstThreeMinutes += 1;
      }
    }
    if (conversionRecommended(cycle)) {
      conversionRecommendedCycles += 1;
      if (
        !cycle.records.some((record) => selectedConversionAttack(cycle, record))
      ) {
        missedConversionCycles += 1;
      }
    }
    if (bankingRecommended(cycle)) {
      bankingRecommendedCycles += 1;
      if (
        !cycle.records.some(isBoatRecord) &&
        !cycle.records.some(isDecisiveBankingConversionAttackRecord) &&
        !acceptableBankingSpacingCycle(cycles, index)
      ) {
        missedBankingCycles += 1;
      }
    }
    if (repeatedProbeCycle(cycle)) {
      repeatedProbeCycles += 1;
      if (cycle.records.some(isLowCommitmentPlayerAttackRecord)) {
        const probeClass = repeatedProbeClass(cycle);
        if (probeClass === "decisive_escalation_available") {
          repeatedProbeEscalationOpportunityCycles += 1;
          missedRepeatedProbeCycles += 1;
        } else if (probeClass === "banking_alternative") {
          repeatedProbeBankingAlternativeCycles += 1;
          missedRepeatedProbeCycles += 1;
        } else if (probeClass === "growth_or_economy_alternative") {
          repeatedProbeGrowthAlternativeCycles += 1;
          missedRepeatedProbeCycles += 1;
        } else if (probeClass === "buying_time_pressure") {
          repeatedProbeBuyingTimeCycles += 1;
        } else if (probeClass === "stale_no_clear_alternative") {
          repeatedProbeNoClearAlternativeCycles += 1;
        }
      }
    }
    if (attackSafetyOpportunity(cycle)) {
      attackSafetyOpportunityCycles += 1;
      if (attackSafetyNeutralGrowthOpportunity(cycle)) {
        attackSafetyNeutralGrowthOpportunityCycles += 1;
      }
    }
    if (unsafeUrgentDefenseAttackCycle(cycle)) {
      unsafeUrgentDefenseAttackCycles += 1;
    }
  }

  return {
    legalNeutralLandCyclesFirstTwoMinutes,
    missedNeutralLandCyclesFirstTwoMinutes,
    legalNeutralBoatCyclesFirstFiveMinutes,
    missedNeutralBoatCyclesFirstFiveMinutes,
    legalEconomyBuildCyclesFirstThreeMinutes,
    missedEconomyBuildCyclesFirstThreeMinutes,
    legalPressureCyclesFirstThreeMinutes,
    missedPressureCyclesFirstThreeMinutes,
    conversionRecommendedCycles,
    missedConversionCycles,
    bankingRecommendedCycles,
    missedBankingCycles,
    repeatedProbeCycles,
    missedRepeatedProbeCycles,
    repeatedProbeEscalationOpportunityCycles,
    repeatedProbeBankingAlternativeCycles,
    repeatedProbeGrowthAlternativeCycles,
    repeatedProbeBuyingTimeCycles,
    repeatedProbeNoClearAlternativeCycles,
    attackSafetyOpportunityCycles,
    attackSafetyNeutralGrowthOpportunityCycles,
    unsafeUrgentDefenseAttackCycles,
  };
}

function acceptableBankingSpacingCycle(
  cycles: DecisionCycle[],
  index: number,
): boolean {
  const cycle = cycles[index];
  if (cycle === undefined) {
    return false;
  }
  if (!cycle.records.some(isNeutralLandExpansionRecord)) {
    return false;
  }
  const recentCycles = cycles.slice(Math.max(0, index - 2), index);
  return recentCycles.some(
    (recent) =>
      recent.agentID === cycle.agentID && recent.records.some(isBoatRecord),
  );
}

function firstActionMinutes(cycles: DecisionCycle[]) {
  return {
    firstSpawnMinute: firstCycleMinute(cycles, (cycle) =>
      cycle.records.some((record) => selectedActionKind(record) === "spawn"),
    ),
    firstNeutralExpansionMinute: firstCycleMinute(cycles, (cycle) =>
      cycle.records.some(isNeutralExpansionRecord),
    ),
    firstPlayerAttackMinute: firstCycleMinute(cycles, (cycle) =>
      cycle.records.some(isPlayerAttackRecord),
    ),
    firstBoatMinute: firstCycleMinute(cycles, (cycle) =>
      cycle.records.some(isBoatRecord),
    ),
    firstBuildMinute: firstCycleMinute(cycles, (cycle) =>
      cycle.records.some(isBuildRecord),
    ),
  };
}

function firstCycleMinute(
  cycles: DecisionCycle[],
  predicate: (cycle: DecisionCycle) => boolean,
): number | null {
  return cycles.find(predicate)?.minute ?? null;
}

function subjectGapIDs(
  subject: AgentHumanOpportunitySubjectSummary,
  baseline: AgentHumanOpportunityBaseline,
): string[] {
  const gaps: string[] = [];
  const neutralTarget = baseline.neutralAttacksFirstTwoMinutes ?? 9;
  if (
    subject.firstNeutralExpansionMinute === null ||
    subject.firstNeutralExpansionMinute >
      (baseline.firstNeutralAttackMinute ?? 0.52) + 0.25 ||
    subject.neutralExpansionFirstTwoMinutes < Math.ceil(neutralTarget * 0.75)
  ) {
    gaps.push("opening_neutral_saturation");
  }
  if (
    subject.legalNeutralBoatCyclesFirstFiveMinutes > 0 &&
    (subject.missedNeutralBoatCyclesFirstFiveMinutes > 0 ||
      subject.firstBoatMinute === null ||
      subject.firstBoatMinute > (baseline.firstBoatMinute ?? 1.1) + 0.75)
  ) {
    gaps.push("early_neutral_boats");
  }
  if (
    subject.legalEconomyBuildCyclesFirstThreeMinutes > 0 &&
    (subject.firstBuildMinute === null ||
      subject.firstBuildMinute > (baseline.firstBuildMinute ?? 1.9) + 0.75)
  ) {
    gaps.push("economy_timing");
  }
  if (
    subject.legalPressureCyclesFirstThreeMinutes > 0 &&
    (subject.firstPlayerAttackMinute === null ||
      subject.firstPlayerAttackMinute >
        (baseline.firstPlayerAttackMinute ?? 1.3) + 0.75)
  ) {
    gaps.push("pressure_handoff");
  }
  if (subject.missedConversionCycles > 0) {
    gaps.push("weak_rival_conversion");
  }
  if (subject.missedBankingCycles > 0) {
    gaps.push("transport_troop_banking");
  }
  if (subject.missedRepeatedProbeCycles > 0) {
    gaps.push("repeated_probe_discipline");
  }
  if (subject.attackSafetyOpportunityCycles > 0) {
    gaps.push("attack_safety_opportunity");
  }
  if (subject.unsafeUrgentDefenseAttackCycles > 0) {
    gaps.push("unsafe_urgent_defense_attack");
  }
  return gaps;
}

function buildGaps(
  subjects: AgentHumanOpportunitySubjectSummary[],
  baseline: AgentHumanOpportunityBaseline,
): AgentHumanOpportunityGap[] {
  const gaps: Array<Omit<AgentHumanOpportunityGap, "severity">> = [
    {
      gapID: "opening_neutral_saturation",
      title: "Opening Neutral Saturation",
      affectedSubjectCount: affectedCount(
        subjects,
        "opening_neutral_saturation",
      ),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "opening_neutral_saturation",
        subjects.map(
          (subject) => subject.missedNeutralLandCyclesFirstTwoMinutes,
        ),
      ),
      evidence: `Human winners median ${formatNumber(
        baseline.neutralAttacksFirstTwoMinutes,
      )} neutral attacks in 0-2m; agents median ${formatNumber(
        median(
          subjects.map((subject) => subject.neutralExpansionFirstTwoMinutes),
        ),
      )}.`,
      examples: gapExamples(
        "opening_neutral_saturation",
        subjects,
        (cycle) => cycle.minute <= 2 && neutralLandOptions(cycle) > 0,
        (cycle) => !cycle.records.some(isNeutralLandExpansionRecord),
      ),
      nextExperiment:
        "Prioritize neutral land LegalAction ids while the opening baseline is behind and home danger is low.",
    },
    {
      gapID: "early_neutral_boats",
      title: "Early Neutral Boats",
      affectedSubjectCount: affectedCount(subjects, "early_neutral_boats"),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "early_neutral_boats",
        subjects.map(
          (subject) => subject.missedNeutralBoatCyclesFirstFiveMinutes,
        ),
      ),
      evidence: `Human winners median first boat ${formatMinute(
        baseline.firstBoatMinute,
      )}; agents median ${formatMinute(
        median(subjects.map((subject) => subject.firstBoatMinute)),
      )}.`,
      examples: gapExamples(
        "early_neutral_boats",
        subjects,
        (cycle) => cycle.minute <= 5 && neutralBoatOptions(cycle) > 0,
        (cycle) => !cycle.records.some(isNeutralBoatRecord),
      ),
      nextExperiment:
        "Treat neutral boat LegalAction ids as expansion tempo once direct neutral land thins out.",
    },
    {
      gapID: "economy_timing",
      title: "Economy Timing",
      affectedSubjectCount: affectedCount(subjects, "economy_timing"),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "economy_timing",
        subjects.map(
          (subject) => subject.missedEconomyBuildCyclesFirstThreeMinutes,
        ),
      ),
      evidence: `Human winners median first build ${formatMinute(
        baseline.firstBuildMinute,
      )}; agents median ${formatMinute(
        median(subjects.map((subject) => subject.firstBuildMinute)),
      )}.`,
      examples: gapExamples(
        "economy_timing",
        subjects,
        (cycle) => cycle.minute <= 3 && economyBuildOptions(cycle) > 0,
        (cycle) => !cycle.records.some(isEconomyBuildRecord),
      ),
      nextExperiment:
        "Keep City, Factory, and Port LegalAction ids eligible during expansion and pressure objectives.",
    },
    {
      gapID: "pressure_handoff",
      title: "Pressure Handoff",
      affectedSubjectCount: affectedCount(subjects, "pressure_handoff"),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "pressure_handoff",
        subjects.map(
          (subject) => subject.missedPressureCyclesFirstThreeMinutes,
        ),
      ),
      evidence: `Human winners median first player attack ${formatMinute(
        baseline.firstPlayerAttackMinute,
      )}; agents median ${formatMinute(
        median(subjects.map((subject) => subject.firstPlayerAttackMinute)),
      )}.`,
      examples: gapExamples(
        "pressure_handoff",
        subjects,
        (cycle) =>
          cycle.minute >= (baseline.firstPlayerAttackMinute ?? 1.3) &&
          cycle.minute <= 3 &&
          hostileAttackOptions(cycle) > 0,
        (cycle) => !cycle.records.some(isPlayerAttackRecord),
      ),
      nextExperiment:
        "After the neutral burst, prefer weak reachable rival attack ids when reserve and frontier blockers permit it.",
    },
    {
      gapID: "weak_rival_conversion",
      title: "Weak-Rival Conversion",
      affectedSubjectCount: affectedCount(subjects, "weak_rival_conversion"),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "weak_rival_conversion",
        subjects.map((subject) => subject.missedConversionCycles),
      ),
      evidence: `Agents missed ${sum(
        subjects.map((subject) => subject.missedConversionCycles),
      )} executor-ready conversion cycle(s) while favorable weak-rival attacks were visible.`,
      examples: gapExamples(
        "weak_rival_conversion",
        subjects,
        conversionRecommended,
        (cycle) =>
          !cycle.records.some((record) =>
            selectedConversionAttack(cycle, record),
          ),
      ),
      nextExperiment:
        "Promote executor-ready frontier conversion attacks above neutral growth, holds, and social actions when safety blockers are clear.",
    },
    {
      gapID: "transport_troop_banking",
      title: "Transport Troop Banking",
      affectedSubjectCount: affectedCount(subjects, "transport_troop_banking"),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "transport_troop_banking",
        subjects.map((subject) => subject.missedBankingCycles),
      ),
      evidence: `Agents missed ${sum(
        subjects.map((subject) => subject.missedBankingCycles),
      )} recommended troop-banking boat cycle(s) while near cap.`,
      examples: gapExamples(
        "transport_troop_banking",
        subjects,
        bankingRecommended,
        (cycle) => !cycle.records.some(isBoatRecord),
      ),
      nextExperiment:
        "Allow safe near-cap banking boats to override tiny hostile probes and passive holds, but keep high-danger and repeated-transport blockers.",
    },
    {
      gapID: "repeated_probe_discipline",
      title: "Repeated Probe Discipline",
      affectedSubjectCount: affectedCount(
        subjects,
        "repeated_probe_discipline",
      ),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "repeated_probe_discipline",
        subjects.map((subject) => subject.missedRepeatedProbeCycles),
      ),
      evidence: `Agents repeated ${sum(
        subjects.map((subject) => subject.missedRepeatedProbeCycles),
      )} actionable low-commitment hostile probe cycle(s): ${sum(
        subjects.map(
          (subject) => subject.repeatedProbeEscalationOpportunityCycles,
        ),
      )} had a decisive escalation, ${sum(
        subjects.map(
          (subject) =>
            subject.repeatedProbeBankingAlternativeCycles +
            subject.repeatedProbeGrowthAlternativeCycles,
        ),
      )} had banking/growth/economy alternatives, and ${sum(
        subjects.map((subject) => subject.repeatedProbeBuyingTimeCycles),
      )} looked like buy-time pressure.`,
      examples: gapExamples(
        "repeated_probe_discipline",
        subjects,
        repeatedProbeCycle,
        (cycle) => actionableRepeatedProbeClass(repeatedProbeClass(cycle)),
      ),
      nextExperiment:
        "Escalate repeated weak probes only when a decisive attack is visible; otherwise rotate to clear banking, neutral growth, or economy alternatives instead of probing again.",
    },
    {
      gapID: "attack_safety_opportunity",
      title: "Attack-Safety Opportunity Holds",
      affectedSubjectCount: affectedCount(
        subjects,
        "attack_safety_opportunity",
      ),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "attack_safety_opportunity",
        subjects.map((subject) => subject.attackSafetyOpportunityCycles),
      ),
      evidence: `Agents logged ${sum(
        subjects.map((subject) => subject.attackSafetyOpportunityCycles),
      )} attack-safety hold cycle(s) while hostile or conversion attacks were visible; ${sum(
        subjects.map(
          (subject) => subject.attackSafetyNeutralGrowthOpportunityCycles,
        ),
      )} also had neutral growth available.`,
      examples: gapExamples(
        "attack_safety_opportunity",
        subjects,
        attackSafetyOpportunity,
        () => true,
      ),
      nextExperiment:
        "Keep reserve discipline, take neutral growth instead of holding when hostile attacks are blocked and no immediate survival action is available, and only loosen attack thresholds when the missed attack was favorable.",
    },
    {
      gapID: "unsafe_urgent_defense_attack",
      title: "Unsafe Urgent-Defense Attacks",
      affectedSubjectCount: affectedCount(
        subjects,
        "unsafe_urgent_defense_attack",
      ),
      missedDecisionCycleCount: sumAffected(
        subjects,
        "unsafe_urgent_defense_attack",
        subjects.map((subject) => subject.unsafeUrgentDefenseAttackCycles),
      ),
      evidence: `Agents selected ${sum(
        subjects.map((subject) => subject.unsafeUrgentDefenseAttackCycles),
      )} attack cycle(s) while the executor itself marked urgent defense, stronger-rival, or reserve blockers.`,
      examples: gapExamples(
        "unsafe_urgent_defense_attack",
        subjects,
        unsafeUrgentDefenseAttackCycle,
        () => true,
      ),
      nextExperiment:
        "Treat urgent-defense unsafe attack penalties as hard blockers unless the action is an emergency counterattack, finish, or true conquest exception.",
    },
  ];
  return gaps.map((gap) => ({
    ...gap,
    severity: severityForGap(gap.affectedSubjectCount, subjects.length),
    examples: gap.examples.slice(0, 8),
  }));
}

function gapExamples(
  gapID: string,
  subjects: AgentHumanOpportunitySubjectSummary[],
  available: (cycle: DecisionCycle) => boolean,
  missed: (cycle: DecisionCycle) => boolean,
): AgentHumanOpportunityGapExample[] {
  const examples: AgentHumanOpportunityGapExample[] = [];
  const subjectKeys = new Set(
    subjects
      .filter((subject) => subject.gaps.includes(gapID))
      .map((subject) =>
        [subject.runID, subject.agentID, subject.benchmarkRunIndex ?? ""].join(
          ":",
        ),
      ),
  );
  for (const cycle of cachedCycles) {
    const key = [
      cycle.run.runID,
      cycle.agentID,
      cycle.run.benchmarkRunIndex ?? "",
    ].join(":");
    if (!subjectKeys.has(key) || !available(cycle) || !missed(cycle)) {
      continue;
    }
    examples.push(cycleExample(cycle));
  }
  return examples.sort((left, right) => left.minute - right.minute);
}

const cachedCycles: DecisionCycle[] = [];

function aggregateSubjects(
  subjects: AgentHumanOpportunitySubjectSummary[],
): AgentHumanOpportunityAggregate {
  return {
    firstNeutralExpansionMinute: median(
      subjects.map((subject) => subject.firstNeutralExpansionMinute),
    ),
    firstPlayerAttackMinute: median(
      subjects.map((subject) => subject.firstPlayerAttackMinute),
    ),
    firstBoatMinute: median(subjects.map((subject) => subject.firstBoatMinute)),
    firstBuildMinute: median(
      subjects.map((subject) => subject.firstBuildMinute),
    ),
    neutralExpansionFirstTwoMinutes: median(
      subjects.map((subject) => subject.neutralExpansionFirstTwoMinutes),
    ),
    neutralExpansionFirstFiveMinutes: median(
      subjects.map((subject) => subject.neutralExpansionFirstFiveMinutes),
    ),
    playerAttacksFirstFiveMinutes: median(
      subjects.map((subject) => subject.playerAttacksFirstFiveMinutes),
    ),
    boatsFirstFiveMinutes: median(
      subjects.map((subject) => subject.boatsFirstFiveMinutes),
    ),
    buildsFirstFiveMinutes: median(
      subjects.map((subject) => subject.buildsFirstFiveMinutes),
    ),
    socialActionsFirstFiveMinutes: median(
      subjects.map((subject) => subject.socialActionsFirstFiveMinutes),
    ),
    holdActionsFirstFiveMinutes: median(
      subjects.map((subject) => subject.holdActionsFirstFiveMinutes),
    ),
    missedNeutralLandCyclesFirstTwoMinutes: sum(
      subjects.map((subject) => subject.missedNeutralLandCyclesFirstTwoMinutes),
    ),
    missedNeutralBoatCyclesFirstFiveMinutes: sum(
      subjects.map(
        (subject) => subject.missedNeutralBoatCyclesFirstFiveMinutes,
      ),
    ),
    missedEconomyBuildCyclesFirstThreeMinutes: sum(
      subjects.map(
        (subject) => subject.missedEconomyBuildCyclesFirstThreeMinutes,
      ),
    ),
    missedPressureCyclesFirstThreeMinutes: sum(
      subjects.map((subject) => subject.missedPressureCyclesFirstThreeMinutes),
    ),
    missedConversionCycles: sum(
      subjects.map((subject) => subject.missedConversionCycles),
    ),
    missedBankingCycles: sum(
      subjects.map((subject) => subject.missedBankingCycles),
    ),
    missedRepeatedProbeCycles: sum(
      subjects.map((subject) => subject.missedRepeatedProbeCycles),
    ),
    repeatedProbeEscalationOpportunityCycles: sum(
      subjects.map(
        (subject) => subject.repeatedProbeEscalationOpportunityCycles,
      ),
    ),
    repeatedProbeBankingAlternativeCycles: sum(
      subjects.map((subject) => subject.repeatedProbeBankingAlternativeCycles),
    ),
    repeatedProbeGrowthAlternativeCycles: sum(
      subjects.map((subject) => subject.repeatedProbeGrowthAlternativeCycles),
    ),
    repeatedProbeBuyingTimeCycles: sum(
      subjects.map((subject) => subject.repeatedProbeBuyingTimeCycles),
    ),
    repeatedProbeNoClearAlternativeCycles: sum(
      subjects.map((subject) => subject.repeatedProbeNoClearAlternativeCycles),
    ),
    attackSafetyOpportunityCycles: sum(
      subjects.map((subject) => subject.attackSafetyOpportunityCycles),
    ),
    attackSafetyNeutralGrowthOpportunityCycles: sum(
      subjects.map(
        (subject) => subject.attackSafetyNeutralGrowthOpportunityCycles,
      ),
    ),
    unsafeUrgentDefenseAttackCycles: sum(
      subjects.map((subject) => subject.unsafeUrgentDefenseAttackCycles),
    ),
  };
}

function isNeutralExpansionRecord(record: AgentDecisionRecordLike): boolean {
  return isNeutralLandExpansionRecord(record) || isNeutralBoatRecord(record);
}

function isNeutralLandExpansionRecord(
  record: AgentDecisionRecordLike,
): boolean {
  const metadata = selectedActionMetadata(record);
  return (
    selectedActionIds(record).some((id) =>
      id.startsWith("expand:terra-nullius"),
    ) ||
    (selectedActionKind(record) === "attack" && metadata.expansion === true)
  );
}

function isNeutralBoatRecord(record: AgentDecisionRecordLike): boolean {
  const metadata = selectedActionMetadata(record);
  return (
    selectedActionKind(record) === "boat" &&
    metadata.expansion === true &&
    (metadata.targetID === null ||
      metadata.targetID === undefined ||
      metadata.targetName === "Terra Nullius")
  );
}

function isPlayerAttackRecord(record: AgentDecisionRecordLike): boolean {
  return (
    selectedActionKind(record) === "attack" &&
    !isNeutralLandExpansionRecord(record)
  );
}

function isBoatRecord(record: AgentDecisionRecordLike): boolean {
  return selectedActionKind(record) === "boat";
}

function isBuildRecord(record: AgentDecisionRecordLike): boolean {
  return selectedActionKind(record) === "build";
}

function isEconomyBuildRecord(record: AgentDecisionRecordLike): boolean {
  if (selectedActionKind(record) !== "build") {
    return false;
  }
  const unit = String(selectedActionMetadata(record).unit ?? "");
  return ["City", "Factory", "Port"].includes(unit);
}

function isSocialRecord(record: AgentDecisionRecordLike): boolean {
  return [
    "alliance_request",
    "quick_chat",
    "emoji",
    "target_player",
    "embargo",
    "embargo_all",
  ].includes(selectedActionKind(record));
}

function neutralLandOptions(cycle: DecisionCycle): number {
  return max(
    cycle.records.map(
      (record) =>
        record.tacticalAffordances?.openingExpansionTempo
          ?.neutralLandExpansionActionCount ??
        countLegalIDs(record, (id) => id.startsWith("expand:terra-nullius")),
    ),
  );
}

function neutralBoatOptions(cycle: DecisionCycle): number {
  return max(
    cycle.records.map(
      (record) =>
        record.tacticalAffordances?.openingExpansionTempo
          ?.neutralBoatExpansionActionCount ?? 0,
    ),
  );
}

function clearNeutralBoatOpportunity(cycle: DecisionCycle): boolean {
  return cycle.records.some((record) => {
    const opening = record.tacticalAffordances?.openingExpansionTempo;
    if (opening === undefined) {
      return neutralBoatOptions(cycle) > 0 && neutralLandOptions(cycle) <= 1;
    }
    return (
      opening.neutralBoatExpansionActionCount > 0 &&
      opening.neutralLandExpansionActionCount <= 1 &&
      opening.homeDanger !== "high"
    );
  });
}

function economyBuildOptions(cycle: DecisionCycle): number {
  return max(
    cycle.records.map((record) =>
      countLegalIDs(
        record,
        (id) =>
          id.startsWith("build:City") ||
          id.startsWith("build:Factory") ||
          id.startsWith("build:Port"),
        "build",
      ),
    ),
  );
}

function hostileAttackOptions(cycle: DecisionCycle): number {
  return max(
    cycle.records.map((record) =>
      countLegalIDs(
        record,
        (id) => id.startsWith("attack:") && !id.includes("terra-nullius"),
        "attack",
      ),
    ),
  );
}

function conversionReadyOptions(cycle: DecisionCycle): number {
  return max(
    cycle.records.map((record) => {
      const conversion = record.tacticalAffordances?.frontierConversionTiming;
      if (
        conversion?.recommended !== true ||
        !conversion.executorReady ||
        !clearConversionOpportunity(record)
      ) {
        return 0;
      }
      return (
        conversion.executorReadyHostileAttackActionCount ||
        conversion.favorableHostileAttackActionCount ||
        0
      );
    }),
  );
}

function conversionRecommended(cycle: DecisionCycle): boolean {
  return conversionReadyOptions(cycle) > 0;
}

function clearConversionOpportunity(record: AgentDecisionRecordLike): boolean {
  const conversion = record.tacticalAffordances?.frontierConversionTiming;
  if (conversion === undefined) {
    return false;
  }
  const blockedHostileAttackSummary = String(
    record.decisionMetadata?.blockedHostileAttackSummary ?? "",
  );
  if (
    /active pressure makes new wars unsafe|urgent defense state makes non-leader attacks too risky|blocking policy penalty|troop ratio is below attack trigger|attack lacks a clear troop edge|early multi-front hard-nation trades need a decisive edge/i.test(
      blockedHostileAttackSummary,
    )
  ) {
    return false;
  }
  if (conversion.homeDanger !== "low") {
    return false;
  }
  if (
    conversion.neutralExpansionAvailable === true &&
    (conversion.bestExecutorReadyRelativeTroopRatio ?? 0) < 1.45
  ) {
    return false;
  }
  return true;
}

function selectedConversionAttack(
  cycle: DecisionCycle,
  record: AgentDecisionRecordLike,
): boolean {
  if (!isPlayerAttackRecord(record)) {
    return false;
  }
  const targetID = selectedActionTargetID(record);
  if (targetID === null) {
    return true;
  }
  return cycle.records.some(
    (candidate) =>
      candidate.tacticalAffordances?.frontierConversionTiming
        ?.bestExecutorReadyTargetID === targetID,
  );
}

function bankingBoatOptions(cycle: DecisionCycle): number {
  return max(
    cycle.records.map((record) => {
      const banking = record.tacticalAffordances?.transportTroopBanking;
      if (
        banking?.recommended !== true ||
        banking.homeDanger === "high" ||
        (banking.activeBankRatio ?? 0) >= 0.2 ||
        banking.activeTransportCount >= 2 ||
        banking.availableBoatLaunchActionCount <= 0
      ) {
        return 0;
      }
      return banking.availableBoatLaunchActionCount;
    }),
  );
}

function bankingRecommended(cycle: DecisionCycle): boolean {
  return bankingBoatOptions(cycle) > 0;
}

function repeatedProbeCycle(cycle: DecisionCycle): boolean {
  return cycle.records.some(
    (record) =>
      record.tacticalAffordances?.frontierFinishPressure
        ?.repeatedLowCommitmentProbe === true ||
      /repeated low-commitment|repeated probes/i.test(record.reason ?? ""),
  );
}

function repeatedProbeClass(cycle: DecisionCycle): AgentRepeatedProbeClass {
  if (
    !repeatedProbeCycle(cycle) ||
    !cycle.records.some(isLowCommitmentPlayerAttackRecord)
  ) {
    return "none";
  }
  if (
    cycle.records.some((record) => {
      const finish = record.tacticalAffordances?.frontierFinishPressure;
      return (
        finish?.recommended === true &&
        finish.homeDanger !== "high" &&
        finish.decisiveAttackActionCount > 0
      );
    })
  ) {
    return "decisive_escalation_available";
  }
  if (bankingRecommended(cycle)) {
    return "banking_alternative";
  }
  if (safeGrowthOrEconomyAlternative(cycle)) {
    return "growth_or_economy_alternative";
  }
  if (buyingTimeProbe(cycle)) {
    return "buying_time_pressure";
  }
  return "stale_no_clear_alternative";
}

function actionableRepeatedProbeClass(
  probeClass: AgentRepeatedProbeClass,
): boolean {
  return (
    probeClass === "decisive_escalation_available" ||
    probeClass === "banking_alternative" ||
    probeClass === "growth_or_economy_alternative"
  );
}

function safeGrowthOrEconomyAlternative(cycle: DecisionCycle): boolean {
  if (homeDanger(cycle) === "high" || highDefenseState(cycle)) {
    return false;
  }
  return (
    neutralLandOptions(cycle) > 0 ||
    clearNeutralBoatOpportunity(cycle) ||
    economyBuildOptions(cycle) > 0
  );
}

function buyingTimeProbe(cycle: DecisionCycle): boolean {
  return (
    homeDanger(cycle) === "high" ||
    highDefenseState(cycle) ||
    cycle.records.some((record) =>
      /active pressure makes new wars unsafe|urgent defense state makes non-leader attacks too risky|counterpressure probe is too small to stop an invasion/i.test(
        record.reason ?? "",
      ),
    )
  );
}

function highDefenseState(cycle: DecisionCycle): boolean {
  return cycle.records.some(
    (record) =>
      record.strategicPriority === "build_defense" &&
      record.strategicUrgency === "high",
  );
}

function attackSafetyOpportunity(cycle: DecisionCycle): boolean {
  return (
    cycle.records.some(
      (record) =>
        selectedActionKind(record) === "hold" &&
        /attack-safety/i.test(record.reason ?? ""),
    ) &&
    (conversionReadyOptions(cycle) > 0 || hostileAttackOptions(cycle) > 0)
  );
}

function attackSafetyNeutralGrowthOpportunity(cycle: DecisionCycle): boolean {
  return (
    attackSafetyOpportunity(cycle) &&
    neutralLandOptions(cycle) > 0 &&
    !cycle.records.some(isNeutralLandExpansionRecord)
  );
}

function unsafeUrgentDefenseAttackCycle(cycle: DecisionCycle): boolean {
  return cycle.records.some(isUnsafeUrgentDefenseAttackRecord);
}

function isUnsafeUrgentDefenseAttackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  return (
    isPlayerAttackRecord(record) &&
    !selectedTrueConquestAttackRecord(record) &&
    !selectedEmergencyCounterattackRecord(record) &&
    unsafeUrgentDefenseReason(record.reason ?? "")
  );
}

function selectedTrueConquestAttackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  return (
    selectedCleanConversionAttackRecord(record) ||
    selectedDecisiveFinishAttackRecord(record)
  );
}

function selectedCleanConversionAttackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  const conversion = record.tacticalAffordances?.frontierConversionTiming;
  if (
    conversion?.recommended !== true ||
    conversion.executorReady !== true ||
    conversion.homeDanger === "high"
  ) {
    return false;
  }
  const targetID = selectedActionTargetID(record);
  if (
    targetID === null ||
    targetID !== conversion.bestExecutorReadyTargetID
  ) {
    return false;
  }
  const metadata = selectedActionMetadata(record);
  const selectedRelativeTroopRatio = Number(metadata.relativeTroopRatio ?? 0);
  const relativeTroopRatio =
    selectedRelativeTroopRatio > 0
      ? selectedRelativeTroopRatio
      : (conversion.bestExecutorReadyRelativeTroopRatio ?? 0);
  const incomingThreatRatio = conversion.incomingThreatRatio ?? 0;
  return relativeTroopRatio >= 1.45 && incomingThreatRatio <= 0.35;
}

function selectedDecisiveFinishAttackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  const finish = record.tacticalAffordances?.frontierFinishPressure;
  if (
    finish?.recommended !== true ||
    finish.homeDanger === "high" ||
    finish.decisiveAttackActionCount <= 0
  ) {
    return false;
  }
  const targetID = selectedActionTargetID(record);
  return targetID !== null && targetID === finish.bestTargetID;
}

function selectedEmergencyCounterattackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  const metadata = selectedActionMetadata(record);
  if (metadata.incomingAttack !== true) {
    return false;
  }
  const relativeTroopRatio = Number(metadata.relativeTroopRatio ?? 0);
  const percent = selectedTroopPercent(record);
  return percent > 0 && percent <= 28 && relativeTroopRatio >= 0.55;
}

function unsafeUrgentDefenseReason(reason: string): boolean {
  if (
    !/urgent defense state makes non-leader attacks too risky|active pressure makes new wars unsafe|attacking a stronger rival feeds them troops|troop ratio is below attack trigger|attack would deplete the reserve below competitive defense/i.test(
      reason,
    )
  ) {
    return false;
  }
  return !/critical border collapse counterattack|last-stand hard-nation counterattack|medium counterattack blunts incoming hard-nation leader pressure|medium counterattack contests a boxed hard-nation border|hard-nation side conquest converts weaker frontier|hard-nation race finish converts side rival/i.test(
    reason,
  );
}

function cycleExample(cycle: DecisionCycle): AgentHumanOpportunityGapExample {
  const first = cycle.records[0];
  return {
    runID: cycle.run.runID,
    benchmarkRunIndex: cycle.run.benchmarkRunIndex ?? null,
    agentID: cycle.agentID,
    username: cycle.username,
    turnNumber: cycle.turnNumber,
    minute: cycle.minute,
    selectedActionIds: Array.from(
      new Set(cycle.records.flatMap(selectedActionIds)),
    ),
    selectedActionKinds: Array.from(
      new Set(cycle.records.map(selectedActionKind)),
    ),
    neutralLandOptions: neutralLandOptions(cycle),
    neutralBoatOptions: neutralBoatOptions(cycle),
    economyBuildOptions: economyBuildOptions(cycle),
    hostileAttackOptions: hostileAttackOptions(cycle),
    conversionReadyOptions: conversionReadyOptions(cycle),
    bankingBoatOptions: bankingBoatOptions(cycle),
    repeatedLowProbe: repeatedProbeCycle(cycle),
    repeatedProbeClass: repeatedProbeClass(cycle),
    attackSafetyHold: attackSafetyOpportunity(cycle),
    attackSafetyNeutralGrowthOpportunity:
      attackSafetyNeutralGrowthOpportunity(cycle),
    unsafeUrgentDefenseAttack: unsafeUrgentDefenseAttackCycle(cycle),
    homeDanger: homeDanger(cycle),
    reason: first.reason ?? null,
  };
}

function selectedActionKind(record: AgentDecisionRecordLike): string {
  return String(record.chosenActionKind ?? record.selectedActionKind ?? "hold");
}

function selectedActionId(record: AgentDecisionRecordLike): string {
  return String(
    record.chosenActionID ?? record.selectedLegalActionId ?? "hold",
  );
}

function selectedActionIds(record: AgentDecisionRecordLike): string[] {
  return record.batchActionIDs?.length
    ? record.batchActionIDs
    : [selectedActionId(record)];
}

function selectedActionMetadata(
  record: AgentDecisionRecordLike,
): Record<string, string | number | boolean | null | undefined> {
  return record.chosenActionMetadata ?? record.selectedActionMetadata ?? {};
}

function selectedActionTargetID(
  record: AgentDecisionRecordLike,
): string | null {
  const metadataTarget = selectedActionMetadata(record).targetID;
  if (typeof metadataTarget === "string" && metadataTarget.length > 0) {
    return metadataTarget;
  }
  const match = /^attack:([^:]+):/.exec(selectedActionId(record));
  return match?.[1] ?? null;
}

function selectedTroopPercent(record: AgentDecisionRecordLike): number {
  const metadata = selectedActionMetadata(record);
  const metadataPercent = Number(
    metadata.troopPercentage ?? metadata.troopPercent ?? 0,
  );
  const actionPercent = troopPercentFromActionID(selectedActionId(record));
  const rawPercent = metadataPercent > 0 ? metadataPercent : actionPercent;
  return rawPercent > 0 && rawPercent <= 1 ? rawPercent * 100 : rawPercent;
}

function isLowCommitmentPlayerAttackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  if (!isPlayerAttackRecord(record)) {
    return false;
  }
  const percent = selectedTroopPercent(record);
  return percent > 0 && percent <= 12;
}

function isDecisiveBankingConversionAttackRecord(
  record: AgentDecisionRecordLike,
): boolean {
  if (!isPlayerAttackRecord(record)) {
    return false;
  }
  const metadata = selectedActionMetadata(record);
  const percent = selectedTroopPercent(record);
  const relativeTroopRatio = Number(metadata.relativeTroopRatio ?? 0);
  return percent >= 18 && percent <= 32 && relativeTroopRatio >= 1.8;
}

function countLegalIDs(
  record: AgentDecisionRecordLike,
  predicate: (id: string) => boolean,
  kind?: string,
): number {
  const ids: string[] =
    kind === undefined
      ? Object.values(record.legalActionIDsByKind ?? {})
          .flat()
          .filter((id): id is string => typeof id === "string")
      : (record.legalActionIDsByKind?.[kind] ?? []);
  return ids.filter(predicate).length;
}

function troopPercentFromActionID(id: string): number {
  const parts = id.split(":");
  const raw = parts[parts.length - 1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function homeDanger(cycle: DecisionCycle): AgentHomeDangerLevel | "unknown" {
  for (const record of cycle.records) {
    const opening = record.tacticalAffordances?.openingExpansionTempo;
    if (opening?.homeDanger !== undefined) {
      return opening.homeDanger;
    }
    const banking = record.tacticalAffordances?.transportTroopBanking;
    if (banking?.homeDanger !== undefined) {
      return banking.homeDanger;
    }
  }
  return "unknown";
}

function affectedCount(
  subjects: AgentHumanOpportunitySubjectSummary[],
  gapID: string,
): number {
  return subjects.filter((subject) => subject.gaps.includes(gapID)).length;
}

function sumAffected(
  subjects: AgentHumanOpportunitySubjectSummary[],
  gapID: string,
  values: number[],
): number {
  return values.reduce(
    (total, value, index) =>
      subjects[index]?.gaps.includes(gapID) ? total + value : total,
    0,
  );
}

function severityForGap(
  affectedSubjectCount: number,
  subjectCount: number,
): "high" | "medium" | "low" | "none" {
  if (affectedSubjectCount === 0 || subjectCount === 0) {
    return "none";
  }
  const ratio = affectedSubjectCount / subjectCount;
  if (ratio >= 0.5) {
    return "high";
  }
  if (ratio >= 0.25) {
    return "medium";
  }
  return "low";
}

function median(values: Array<number | null>): number | null {
  const finite = values
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    )
    .sort((left, right) => left - right);
  if (finite.length === 0) {
    return null;
  }
  const midpoint = Math.floor(finite.length / 2);
  return round2(
    finite.length % 2 === 1
      ? finite[midpoint]
      : (finite[midpoint - 1] + finite[midpoint]) / 2,
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMinute(value: number | null): string {
  return value === null ? "n/a" : `${value}m`;
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function numberField(
  record: Record<string, unknown>,
  field: string,
): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
