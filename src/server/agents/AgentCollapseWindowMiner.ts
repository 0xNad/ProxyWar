import type { AgentDecisionRecordLike } from "./AgentHumanOpportunityMiner";

export interface AgentCollapseWindowReportInput {
  reportID: string;
  generatedAt?: number;
  source: string;
  runs: AgentCollapseWindowRunInput[];
}

export interface AgentCollapseWindowRunInput {
  runID: string;
  benchmarkRunIndex?: number | null;
  won?: boolean | null;
  survived?: boolean | null;
  tileShare?: number | null;
  turns?: number | null;
  records: AgentDecisionRecordLike[];
  snapshots?: AgentCollapseSnapshotInput[];
}

export interface AgentCollapseSnapshotInput {
  turnNumber: number;
  tick?: number | null;
  players: AgentCollapseSnapshotPlayer[];
}

export interface AgentCollapseSnapshotPlayer {
  agentID?: string | null;
  username?: string | null;
  isAlive?: boolean | null;
  tilesOwned?: number | null;
  troops?: number | null;
}

export type AgentCollapseOutcome =
  | "won"
  | "eliminated"
  | "boxed_out"
  | "outscaled"
  | "inconclusive";

export interface AgentCollapseWindowReport {
  schemaVersion: 1;
  reportID: string;
  generatedAt: string;
  source: string;
  runCount: number;
  aggregate: AgentCollapseWindowAggregate;
  runs: AgentCollapseWindowRunSummary[];
  topFindings: AgentCollapseFinding[];
  llmReviewPacket: {
    role: "collapse_window_researcher";
    constraints: string[];
    requestedOutput: string[];
  };
}

export interface AgentCollapseWindowAggregate {
  lostRunCount: number;
  eliminatedRunCount: number;
  boxedOutRunCount: number;
  outscaledRunCount: number;
  averagePeakTiles: number | null;
  averageEndTiles: number | null;
  averageCollapseLossRatio: number | null;
  conversionMisses: number;
  bankingMisses: number;
  attackSafetyHolds: number;
  legalRetreatMisses: number;
  legalBoatMisses: number;
  highDefenseBuildMisses: number;
  lowCommitmentAttacks: number;
  socialActions: number;
}

export interface AgentCollapseWindowRunSummary {
  runID: string;
  benchmarkRunIndex: number | null;
  agentID: string | null;
  username: string | null;
  won: boolean | null;
  survived: boolean | null;
  outcome: AgentCollapseOutcome;
  peakTurn: number | null;
  peakTiles: number | null;
  endTurn: number | null;
  endTiles: number | null;
  endLeaderName: string | null;
  endLeaderTiles: number | null;
  collapseStartTurn: number | null;
  collapseStartTiles: number | null;
  collapseLossRatio: number | null;
  windowStartTurn: number | null;
  windowEndTurn: number | null;
  windowDecisionCount: number;
  actionCounts: Record<string, number>;
  objectiveCounts: Record<string, number>;
  priorityCounts: Record<string, number>;
  conversionMisses: number;
  bankingMisses: number;
  attackSafetyHolds: number;
  legalRetreatMisses: number;
  legalBoatMisses: number;
  highDefenseBuildMisses: number;
  lowCommitmentAttacks: number;
  neutralGrowthMisses: number;
  socialActions: number;
  topBlockers: string[];
  findings: AgentCollapseFinding[];
  examples: AgentCollapseDecisionExample[];
}

export interface AgentCollapseDecisionExample {
  turnNumber: number;
  actionID: string | null;
  actionKind: string | null;
  objectiveKind: string | null;
  strategicPriority: string | null;
  strategicUrgency: string | null;
  reason: string | null;
}

export interface AgentCollapseFinding {
  findingID:
    | "retreat_ignored"
    | "conversion_missed"
    | "banking_missed"
    | "safety_hold_wall"
    | "low_probe_collapse"
    | "defense_build_missed"
    | "boat_rebase_missed"
    | "social_during_collapse"
    | "collapse_unclassified";
  title: string;
  severity: "high" | "medium" | "low";
  affectedRunCount: number;
  evidence: string;
  nextExperiment: string;
  examples: AgentCollapseDecisionExample[];
}

interface SnapshotPoint {
  turnNumber: number;
  ownTiles: number;
  ownTroops: number | null;
  ownAlive: boolean | null;
  leaderName: string | null;
  leaderTiles: number | null;
}

interface WindowMetrics {
  actionCounts: Record<string, number>;
  objectiveCounts: Record<string, number>;
  priorityCounts: Record<string, number>;
  conversionMisses: number;
  bankingMisses: number;
  attackSafetyHolds: number;
  legalRetreatMisses: number;
  legalBoatMisses: number;
  highDefenseBuildMisses: number;
  lowCommitmentAttacks: number;
  neutralGrowthMisses: number;
  socialActions: number;
  topBlockers: string[];
  examples: AgentCollapseDecisionExample[];
}

export function buildAgentCollapseWindowReport(
  input: AgentCollapseWindowReportInput,
): AgentCollapseWindowReport {
  const runs = input.runs.map((run) => summarizeRun(run));
  const topFindings = summarizeFindings(runs);
  return {
    schemaVersion: 1,
    reportID: input.reportID,
    generatedAt: new Date(input.generatedAt ?? Date.now()).toISOString(),
    source: input.source,
    runCount: runs.length,
    aggregate: aggregateRuns(runs),
    runs,
    topFindings,
    llmReviewPacket: {
      role: "collapse_window_researcher",
      constraints: [
        "Use the report to choose one behavior patch with a measurable benchmark gate.",
        "Do not propose raw game intents or a second action schema.",
        "Final live actions must remain existing LegalAction.id selections.",
      ],
      requestedOutput: [
        "Name the first collapse-window blocker to patch.",
        "Explain which canonical planner/executor module should own the patch.",
        "State the benchmark gate that would promote or reject the patch.",
      ],
    },
  };
}

export function agentCollapseWindowReportMarkdown(
  report: AgentCollapseWindowReport,
): string {
  const lines = [
    `# Collapse Window Report: ${report.reportID}`,
    "",
    `Source: ${report.source}`,
    `Runs: ${report.runCount}`,
    "",
    "## Aggregate",
    "",
    markdownTable(
      [
        "Lost",
        "Eliminated",
        "Boxed Out",
        "Outscaled",
        "Avg Peak",
        "Avg End",
        "Avg Loss",
      ],
      [
        [
          String(report.aggregate.lostRunCount),
          String(report.aggregate.eliminatedRunCount),
          String(report.aggregate.boxedOutRunCount),
          String(report.aggregate.outscaledRunCount),
          formatNullable(report.aggregate.averagePeakTiles),
          formatNullable(report.aggregate.averageEndTiles),
          formatNullable(report.aggregate.averageCollapseLossRatio),
        ],
      ],
    ),
    "",
    markdownTable(
      [
        "Conversion Miss",
        "Banking Miss",
        "Safety Holds",
        "Retreat Miss",
        "Boat Miss",
        "Defense Build Miss",
        "Low Probes",
        "Social",
      ],
      [
        [
          String(report.aggregate.conversionMisses),
          String(report.aggregate.bankingMisses),
          String(report.aggregate.attackSafetyHolds),
          String(report.aggregate.legalRetreatMisses),
          String(report.aggregate.legalBoatMisses),
          String(report.aggregate.highDefenseBuildMisses),
          String(report.aggregate.lowCommitmentAttacks),
          String(report.aggregate.socialActions),
        ],
      ],
    ),
    "",
    "## Runs",
    "",
    markdownTable(
      [
        "Run",
        "Outcome",
        "Peak",
        "End",
        "Leader End",
        "Collapse Turn",
        "Window",
        "Top Blockers",
      ],
      report.runs.map((run) => [
        run.benchmarkRunIndex === null
          ? run.runID
          : `#${run.benchmarkRunIndex}`,
        run.outcome,
        formatNullable(run.peakTiles),
        formatNullable(run.endTiles),
        run.endLeaderTiles === null
          ? "n/a"
          : `${run.endLeaderName ?? "leader"} ${run.endLeaderTiles}`,
        formatNullable(run.collapseStartTurn),
        run.windowStartTurn === null || run.windowEndTurn === null
          ? "n/a"
          : `${run.windowStartTurn}-${run.windowEndTurn}`,
        run.topBlockers.join("; "),
      ]),
    ),
    "",
    "## Top Findings",
    "",
    report.topFindings.length === 0
      ? "No collapse-window findings were detected."
      : markdownTable(
          ["Finding", "Severity", "Runs", "Evidence", "Next Experiment"],
          report.topFindings.map((finding) => [
            finding.title,
            finding.severity,
            String(finding.affectedRunCount),
            finding.evidence,
            finding.nextExperiment,
          ]),
        ),
    "",
    "## Examples",
    "",
    ...report.topFindings.flatMap((finding) => [
      `### ${finding.title}`,
      "",
      finding.examples.length === 0
        ? "No examples captured."
        : markdownTable(
            ["Turn", "Action", "Objective", "Priority", "Reason"],
            finding.examples.map((example) => [
              String(example.turnNumber),
              example.actionID ?? example.actionKind ?? "n/a",
              example.objectiveKind ?? "n/a",
              [example.strategicPriority, example.strategicUrgency]
                .filter(Boolean)
                .join("/") || "n/a",
              example.reason ?? "",
            ]),
          ),
      "",
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

function summarizeRun(
  run: AgentCollapseWindowRunInput,
): AgentCollapseWindowRunSummary {
  const firstRecord = run.records[0];
  const agentID = firstRecord?.agentID ?? null;
  const username = firstRecord?.username ?? null;
  const points = snapshotPoints(run, agentID, username);
  const peak = peakPoint(points);
  const end = points[points.length - 1] ?? null;
  const collapseStart = collapseStartPoint(points, peak, end);
  const windowRecords = collapseWindowRecords(run.records, collapseStart);
  const metrics = windowMetrics(windowRecords);
  const outcome = classifyOutcome(run, peak, end);
  const collapseLossRatio =
    peak !== null && peak.ownTiles > 0 && end !== null
      ? round((peak.ownTiles - end.ownTiles) / peak.ownTiles, 3)
      : null;
  const findings = findingsForRun({
    outcome,
    metrics,
    windowRecords,
  });
  return {
    runID: run.runID,
    benchmarkRunIndex: run.benchmarkRunIndex ?? null,
    agentID,
    username,
    won: run.won ?? null,
    survived: run.survived ?? null,
    outcome,
    peakTurn: peak?.turnNumber ?? null,
    peakTiles: peak?.ownTiles ?? null,
    endTurn: end?.turnNumber ?? lastTurn(run.records),
    endTiles: end?.ownTiles ?? null,
    endLeaderName: end?.leaderName ?? null,
    endLeaderTiles: end?.leaderTiles ?? null,
    collapseStartTurn: collapseStart?.turnNumber ?? null,
    collapseStartTiles: collapseStart?.ownTiles ?? null,
    collapseLossRatio,
    windowStartTurn: windowRecords[0]?.turnNumber ?? null,
    windowEndTurn: windowRecords[windowRecords.length - 1]?.turnNumber ?? null,
    windowDecisionCount: windowRecords.length,
    actionCounts: metrics.actionCounts,
    objectiveCounts: metrics.objectiveCounts,
    priorityCounts: metrics.priorityCounts,
    conversionMisses: metrics.conversionMisses,
    bankingMisses: metrics.bankingMisses,
    attackSafetyHolds: metrics.attackSafetyHolds,
    legalRetreatMisses: metrics.legalRetreatMisses,
    legalBoatMisses: metrics.legalBoatMisses,
    highDefenseBuildMisses: metrics.highDefenseBuildMisses,
    lowCommitmentAttacks: metrics.lowCommitmentAttacks,
    neutralGrowthMisses: metrics.neutralGrowthMisses,
    socialActions: metrics.socialActions,
    topBlockers: metrics.topBlockers,
    findings,
    examples: metrics.examples,
  };
}

function snapshotPoints(
  run: AgentCollapseWindowRunInput,
  agentID: string | null,
  username: string | null,
): SnapshotPoint[] {
  if ((run.snapshots ?? []).length > 0) {
    return (run.snapshots ?? [])
      .map((snapshot) => snapshotPoint(snapshot, agentID, username))
      .filter((point): point is SnapshotPoint => point !== null)
      .sort((left, right) => left.turnNumber - right.turnNumber);
  }
  return run.records
    .map((record) => pointFromRecord(record))
    .filter((point): point is SnapshotPoint => point !== null)
    .sort((left, right) => left.turnNumber - right.turnNumber);
}

function snapshotPoint(
  snapshot: AgentCollapseSnapshotInput,
  agentID: string | null,
  username: string | null,
): SnapshotPoint | null {
  const own =
    snapshot.players.find((player) => player.agentID === agentID) ??
    snapshot.players.find((player) => player.username === username) ??
    snapshot.players.find((player) => player.agentID !== null);
  if (own === undefined || own.tilesOwned === null || own.tilesOwned === undefined) {
    return null;
  }
  const rivals = snapshot.players.filter((player) => player !== own);
  const leader = rivals
    .filter((player) => player.isAlive !== false)
    .sort((left, right) => (right.tilesOwned ?? 0) - (left.tilesOwned ?? 0))[0];
  return {
    turnNumber: snapshot.turnNumber,
    ownTiles: own.tilesOwned,
    ownTroops: own.troops ?? null,
    ownAlive: own.isAlive ?? null,
    leaderName: leader?.username ?? null,
    leaderTiles: leader?.tilesOwned ?? null,
  };
}

function pointFromRecord(record: AgentDecisionRecordLike): SnapshotPoint | null {
  const ownTiles = tilesFromObservationSummary(
    (record as AgentDecisionRecordLike & { observationSummary?: string })
      .observationSummary,
  );
  if (ownTiles === null) {
    return null;
  }
  return {
    turnNumber: record.turnNumber,
    ownTiles,
    ownTroops: null,
    ownAlive: null,
    leaderName: null,
    leaderTiles: null,
  };
}

function tilesFromObservationSummary(summary: string | undefined): number | null {
  const match = /own=(\d+) tiles/.exec(summary ?? "");
  return match === null ? null : Number(match[1]);
}

function peakPoint(points: SnapshotPoint[]): SnapshotPoint | null {
  return (
    [...points].sort(
      (left, right) =>
        right.ownTiles - left.ownTiles || left.turnNumber - right.turnNumber,
    )[0] ?? null
  );
}

function collapseStartPoint(
  points: SnapshotPoint[],
  peak: SnapshotPoint | null,
  end: SnapshotPoint | null,
): SnapshotPoint | null {
  if (peak === null || end === null || peak.ownTiles <= 0) {
    return null;
  }
  const lostAtLeastHalf = end.ownTiles <= peak.ownTiles * 0.5;
  const eliminated = end.ownAlive === false || end.ownTiles <= 0;
  if (!lostAtLeastHalf && !eliminated) {
    return null;
  }
  return (
    points.find(
      (point) =>
        point.turnNumber >= peak.turnNumber &&
        point.ownTiles <= peak.ownTiles * 0.7,
    ) ?? null
  );
}

function collapseWindowRecords(
  records: AgentDecisionRecordLike[],
  collapseStart: SnapshotPoint | null,
): AgentDecisionRecordLike[] {
  if (records.length <= 20) {
    return records;
  }
  if (collapseStart === null) {
    return records.slice(-20);
  }
  const collapseIndex = records.findIndex(
    (record) => record.turnNumber >= collapseStart.turnNumber,
  );
  if (collapseIndex < 0) {
    return records.slice(-20);
  }
  const start = Math.max(0, collapseIndex - 12);
  const end = Math.min(records.length, collapseIndex + 9);
  return records.slice(start, end);
}

function windowMetrics(records: AgentDecisionRecordLike[]): WindowMetrics {
  const actionCounts: Record<string, number> = {};
  const objectiveCounts: Record<string, number> = {};
  const priorityCounts: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  const examples: AgentCollapseDecisionExample[] = [];
  let conversionMisses = 0;
  let bankingMisses = 0;
  let attackSafetyHolds = 0;
  let legalRetreatMisses = 0;
  let legalBoatMisses = 0;
  let highDefenseBuildMisses = 0;
  let lowCommitmentAttacks = 0;
  let neutralGrowthMisses = 0;
  let socialActions = 0;

  for (const record of records) {
    const actionKind = selectedActionKind(record);
    increment(actionCounts, actionKind ?? "unknown");
    increment(objectiveCounts, recordObjectiveKind(record) ?? "unknown");
    increment(priorityCounts, record.strategicPriority ?? "unknown");
    countBlockers(blockerCounts, record);
    if (examples.length < 8 && isInterestingExample(record)) {
      examples.push(exampleFromRecord(record));
    }
    if (conversionMissed(record)) {
      conversionMisses += 1;
    }
    if (bankingMissed(record)) {
      bankingMisses += 1;
    }
    if (isAttackSafetyHold(record)) {
      attackSafetyHolds += 1;
    }
    if (legalCount(record, "retreat") > 0 && actionKind !== "retreat") {
      legalRetreatMisses += 1;
    }
    if (legalCount(record, "boat") > 0 && actionKind !== "boat") {
      legalBoatMisses += 1;
    }
    if (
      legalCount(record, "build") > 0 &&
      actionKind !== "build" &&
      record.strategicPriority === "build_defense" &&
      record.strategicUrgency === "high"
    ) {
      highDefenseBuildMisses += 1;
    }
    if (isLowCommitmentHostileAttack(record)) {
      lowCommitmentAttacks += 1;
    }
    if (neutralGrowthMissed(record)) {
      neutralGrowthMisses += 1;
    }
    if (isSocialAction(actionKind)) {
      socialActions += 1;
    }
  }

  return {
    actionCounts,
    objectiveCounts,
    priorityCounts,
    conversionMisses,
    bankingMisses,
    attackSafetyHolds,
    legalRetreatMisses,
    legalBoatMisses,
    highDefenseBuildMisses,
    lowCommitmentAttacks,
    neutralGrowthMisses,
    socialActions,
    topBlockers: topCounts(blockerCounts, 4),
    examples,
  };
}

function classifyOutcome(
  run: AgentCollapseWindowRunInput,
  peak: SnapshotPoint | null,
  end: SnapshotPoint | null,
): AgentCollapseOutcome {
  if (run.won === true) {
    return "won";
  }
  if (run.survived === false || end?.ownAlive === false || end?.ownTiles === 0) {
    return "eliminated";
  }
  if (end !== null && end.leaderTiles !== null && end.leaderTiles > 0) {
    if (end.ownTiles <= end.leaderTiles * 0.15) {
      return "boxed_out";
    }
    return "outscaled";
  }
  if (
    peak !== null &&
    end !== null &&
    peak.ownTiles > 0 &&
    end.ownTiles <= peak.ownTiles * 0.5
  ) {
    return "boxed_out";
  }
  return run.won === false ? "outscaled" : "inconclusive";
}

function findingsForRun(input: {
  outcome: AgentCollapseOutcome;
  metrics: WindowMetrics;
  windowRecords: AgentDecisionRecordLike[];
}): AgentCollapseFinding[] {
  if (input.outcome === "won") {
    return [];
  }
  const findings: AgentCollapseFinding[] = [];
  const examples = input.metrics.examples;
  if (input.metrics.legalRetreatMisses >= 2) {
    findings.push({
      findingID: "retreat_ignored",
      title: "Retreat Options Ignored During Collapse",
      severity: "high",
      affectedRunCount: 1,
      evidence: `${input.metrics.legalRetreatMisses} collapse-window decision(s) had legal retreats that were not selected.`,
      nextExperiment:
        "Make emergency survival prefer safe retreat or transport-recall before attack-safety hold when own tiles are falling fast.",
      examples: examplesForFinding(
        input.windowRecords,
        (record) =>
          legalCount(record, "retreat") > 0 &&
          selectedActionKind(record) !== "retreat",
      ),
    });
  }
  if (input.metrics.conversionMisses >= 2) {
    findings.push({
      findingID: "conversion_missed",
      title: "Conversion Windows Missed At The Collapse Edge",
      severity: "high",
      affectedRunCount: 1,
      evidence: `${input.metrics.conversionMisses} recommended conversion window(s) were not converted into hostile attacks.`,
      nextExperiment:
        "Patch conversion handoff only for collapse-edge windows where executor-ready targets are safer than waiting.",
      examples: examplesForFinding(input.windowRecords, conversionMissed),
    });
  }
  if (input.metrics.attackSafetyHolds >= 4) {
    findings.push({
      findingID: "safety_hold_wall",
      title: "Safety Policy Turned Collapse Into Holds",
      severity: "high",
      affectedRunCount: 1,
      evidence: `${input.metrics.attackSafetyHolds} collapse-window hold(s) were caused by attack safety blockers.`,
      nextExperiment:
        "Add a collapse-pressure override that chooses retreat, rebase boat, or a best-loss-minimizing counterattack instead of repeated holds.",
      examples: examplesForFinding(input.windowRecords, isAttackSafetyHold),
    });
  }
  if (input.metrics.bankingMisses >= 2) {
    findings.push({
      findingID: "banking_missed",
      title: "Troop Banking Missed Before The Fall",
      severity: "medium",
      affectedRunCount: 1,
      evidence: `${input.metrics.bankingMisses} recommended banking launch(es) were skipped.`,
      nextExperiment:
        "Let banking boats fire before attack plans when near cap and collapse pressure has not reached home danger high.",
      examples: examplesForFinding(input.windowRecords, bankingMissed),
    });
  }
  if (input.metrics.legalBoatMisses >= 6) {
    findings.push({
      findingID: "boat_rebase_missed",
      title: "Boat/Rebase Options Stayed Unused",
      severity: "medium",
      affectedRunCount: 1,
      evidence: `${input.metrics.legalBoatMisses} collapse-window decision(s) had legal boats that were not selected.`,
      nextExperiment:
        "Mine whether these boats were neutral growth, banking, or rebase options, then prefer the best safe launch before holding.",
      examples: examplesForFinding(
        input.windowRecords,
        (record) =>
          legalCount(record, "boat") > 0 && selectedActionKind(record) !== "boat",
      ),
    });
  }
  if (input.metrics.lowCommitmentAttacks >= 4) {
    findings.push({
      findingID: "low_probe_collapse",
      title: "Low-Commitment Attacks Continued During Collapse",
      severity: "medium",
      affectedRunCount: 1,
      evidence: `${input.metrics.lowCommitmentAttacks} hostile attack(s) committed 10% or less in the collapse window.`,
      nextExperiment:
        "When the core is shrinking, either escalate the best safe attack or stop probing and rebuild/rebase.",
      examples: examplesForFinding(input.windowRecords, isLowCommitmentHostileAttack),
    });
  }
  if (input.metrics.highDefenseBuildMisses >= 2) {
    findings.push({
      findingID: "defense_build_missed",
      title: "High-Urgency Defense Builds Were Skipped",
      severity: "medium",
      affectedRunCount: 1,
      evidence: `${input.metrics.highDefenseBuildMisses} high-defense decision(s) had legal builds that were not selected.`,
      nextExperiment:
        "Audit defense-post placement scoring during high danger collapse windows.",
      examples: examplesForFinding(
        input.windowRecords,
        (record) =>
          legalCount(record, "build") > 0 &&
          selectedActionKind(record) !== "build" &&
          record.strategicPriority === "build_defense" &&
          record.strategicUrgency === "high",
      ),
    });
  }
  if (input.metrics.socialActions >= 3) {
    findings.push({
      findingID: "social_during_collapse",
      title: "Social Actions Consumed Collapse Turns",
      severity: "low",
      affectedRunCount: 1,
      evidence: `${input.metrics.socialActions} social action(s) were selected in the collapse window.`,
      nextExperiment:
        "Suppress nonbinding diplomacy while the nation is losing core tiles unless it enables an immediate tactical action.",
      examples: examplesForFinding(input.windowRecords, (record) =>
        isSocialAction(selectedActionKind(record)),
      ),
    });
  }
  if (findings.length === 0 && input.outcome !== "inconclusive") {
    findings.push({
      findingID: "collapse_unclassified",
      title: "Collapse Window Needs Richer Features",
      severity: "low",
      affectedRunCount: 1,
      evidence:
        "The run lost, but current collapse features did not isolate a dominant tactical miss.",
      nextExperiment:
        "Add frontier ownership delta, incoming attack size, and selected target strength to the decision log.",
      examples,
    });
  }
  return findings;
}

function examplesForFinding(
  records: AgentDecisionRecordLike[],
  predicate: (record: AgentDecisionRecordLike) => boolean,
): AgentCollapseDecisionExample[] {
  return records.filter(predicate).slice(0, 5).map(exampleFromRecord);
}

function summarizeFindings(
  runs: AgentCollapseWindowRunSummary[],
): AgentCollapseFinding[] {
  const groups = new Map<AgentCollapseFinding["findingID"], AgentCollapseFinding[]>();
  for (const run of runs) {
    for (const finding of run.findings) {
      const group = groups.get(finding.findingID) ?? [];
      group.push(finding);
      groups.set(finding.findingID, group);
    }
  }
  return [...groups.entries()]
    .map(([findingID, findings]) => {
      const first = findings[0]!;
      return {
        ...first,
        findingID,
        affectedRunCount: findings.length,
        evidence: findings.map((finding) => finding.evidence).join(" "),
        examples: findings.flatMap((finding) => finding.examples).slice(0, 5),
      };
    })
    .sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        right.affectedRunCount - left.affectedRunCount,
    )
    .slice(0, 6);
}

function aggregateRuns(
  runs: AgentCollapseWindowRunSummary[],
): AgentCollapseWindowAggregate {
  const lostRuns = runs.filter((run) => run.outcome !== "won");
  return {
    lostRunCount: lostRuns.length,
    eliminatedRunCount: runs.filter((run) => run.outcome === "eliminated").length,
    boxedOutRunCount: runs.filter((run) => run.outcome === "boxed_out").length,
    outscaledRunCount: runs.filter((run) => run.outcome === "outscaled").length,
    averagePeakTiles: average(runs.map((run) => run.peakTiles)),
    averageEndTiles: average(runs.map((run) => run.endTiles)),
    averageCollapseLossRatio: average(
      runs.map((run) => run.collapseLossRatio),
    ),
    conversionMisses: sum(runs.map((run) => run.conversionMisses)),
    bankingMisses: sum(runs.map((run) => run.bankingMisses)),
    attackSafetyHolds: sum(runs.map((run) => run.attackSafetyHolds)),
    legalRetreatMisses: sum(runs.map((run) => run.legalRetreatMisses)),
    legalBoatMisses: sum(runs.map((run) => run.legalBoatMisses)),
    highDefenseBuildMisses: sum(runs.map((run) => run.highDefenseBuildMisses)),
    lowCommitmentAttacks: sum(runs.map((run) => run.lowCommitmentAttacks)),
    socialActions: sum(runs.map((run) => run.socialActions)),
  };
}

function selectedActionKind(record: AgentDecisionRecordLike): string | null {
  return record.chosenActionKind ?? record.selectedActionKind ?? null;
}

function recordObjectiveKind(record: AgentDecisionRecordLike): string | null {
  return (
    (record as AgentDecisionRecordLike & { objectiveKind?: string | null })
      .objectiveKind ?? null
  );
}

function selectedActionID(record: AgentDecisionRecordLike): string | null {
  return record.chosenActionID ?? record.selectedLegalActionId ?? null;
}

function selectedMetadata(
  record: AgentDecisionRecordLike,
): Record<string, string | number | boolean | null> {
  return record.chosenActionMetadata ?? record.selectedActionMetadata ?? {};
}

function conversionMissed(record: AgentDecisionRecordLike): boolean {
  const conversion = record.tacticalAffordances?.frontierConversionTiming;
  if (conversion?.recommended !== true || conversion.executorReady !== true) {
    return false;
  }
  const actionKind = selectedActionKind(record);
  if (actionKind !== "attack") {
    return true;
  }
  return selectedMetadata(record).expansion === true;
}

function bankingMissed(record: AgentDecisionRecordLike): boolean {
  const banking = record.tacticalAffordances?.transportTroopBanking;
  return banking?.recommended === true && selectedActionKind(record) !== "boat";
}

function neutralGrowthMissed(record: AgentDecisionRecordLike): boolean {
  const opening = record.tacticalAffordances?.openingExpansionTempo;
  if (
    opening?.neutralExpansionAvailable !== true ||
    (opening.neutralLandExpansionActionCount ?? 0) <= 0
  ) {
    return false;
  }
  const metadata = selectedMetadata(record);
  return selectedActionKind(record) !== "attack" || metadata.expansion !== true;
}

function isAttackSafetyHold(record: AgentDecisionRecordLike): boolean {
  return (
    selectedActionKind(record) === "hold" &&
    /attack-safety|blocked by safety|hostile attacks offered but blocked/i.test(
      `${record.reason ?? ""} ${stringMetadata(record, "blockedHostileAttackSummary")}`,
    )
  );
}

function isLowCommitmentHostileAttack(record: AgentDecisionRecordLike): boolean {
  if (selectedActionKind(record) !== "attack") {
    return false;
  }
  const metadata = selectedMetadata(record);
  if (metadata.expansion === true || metadata.targetID === null) {
    return false;
  }
  const percent =
    numberValue(metadata.troopPercent) ??
    percentFromRatio(numberValue(metadata.troopPercentage));
  return percent !== null && percent <= 10;
}

function percentFromRatio(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return value <= 1 ? value * 100 : value;
}

function legalCount(record: AgentDecisionRecordLike, kind: string): number {
  return record.legalActionIDsByKind?.[kind]?.length ?? 0;
}

function isSocialAction(kind: string | null): boolean {
  return (
    kind === "quick_chat" ||
    kind === "emoji" ||
    kind === "alliance_request" ||
    kind === "target_player" ||
    kind === "embargo" ||
    kind === "embargo_all"
  );
}

function isInterestingExample(record: AgentDecisionRecordLike): boolean {
  return (
    conversionMissed(record) ||
    bankingMissed(record) ||
    isAttackSafetyHold(record) ||
    legalCount(record, "retreat") > 0 ||
    legalCount(record, "boat") > 0 ||
    isLowCommitmentHostileAttack(record) ||
    isSocialAction(selectedActionKind(record))
  );
}

function exampleFromRecord(
  record: AgentDecisionRecordLike,
): AgentCollapseDecisionExample {
  return {
    turnNumber: record.turnNumber,
    actionID: selectedActionID(record),
    actionKind: selectedActionKind(record),
    objectiveKind: recordObjectiveKind(record),
    strategicPriority: record.strategicPriority ?? null,
    strategicUrgency: record.strategicUrgency ?? null,
    reason: record.reason ?? null,
  };
}

function countBlockers(
  counts: Record<string, number>,
  record: AgentDecisionRecordLike,
): void {
  const text = `${record.reason ?? ""} ${stringMetadata(record, "blockedHostileAttackSummary")}`;
  const blockers: Array<[RegExp, string]> = [
    [/attacking a stronger rival feeds them troops/i, "stronger rival"],
    [/medium leader pressure needs parity/i, "leader parity"],
    [/hostile action does not match the active focus target/i, "focus mismatch"],
    [/hold while useful non-hold actions exist/i, "useful action hold"],
    [/reserve|troop conservation/i, "reserve conservation"],
    [/neutral|Terra Nullius/i, "neutral growth"],
    [/build_defense|Defense Post|defense/i, "defense"],
    [/transport|boat|naval/i, "transport"],
  ];
  for (const [pattern, label] of blockers) {
    if (pattern.test(text)) {
      increment(counts, label);
    }
  }
}

function stringMetadata(
  record: AgentDecisionRecordLike,
  key: string,
): string {
  const value = record.decisionMetadata?.[key];
  return typeof value === "string" ? value : "";
}

function topCounts(counts: Record<string, number>, limit: number): string[] {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, value]) => `${key} (${value})`);
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function numberValue(value: string | number | boolean | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function lastTurn(records: AgentDecisionRecordLike[]): number | null {
  return records[records.length - 1]?.turnNumber ?? null;
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }
  return round(sum(finite) / finite.length, 3);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function severityRank(severity: AgentCollapseFinding["severity"]): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
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

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}
