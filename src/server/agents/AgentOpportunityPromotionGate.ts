export type AgentOpportunityPromotionStatus =
  | "promote"
  | "revise"
  | "discard"
  | "inconclusive";

export interface AgentOpportunityPromotionBenchmarkRun {
  won?: boolean;
  survived?: boolean;
  tileShare?: number;
  turns?: number;
  termination?: string;
}

export interface AgentOpportunityPromotionBenchmarkSummary {
  pass?: boolean;
  wins?: number;
  requiredWins?: number;
  runs?: AgentOpportunityPromotionBenchmarkRun[];
  config?: {
    runs?: number;
    runID?: string;
    difficulty?: string;
    nations?: number;
    bots?: number;
    map?: string;
    mapSize?: string;
  };
}

export interface AgentOpportunityPromotionGap {
  title: string;
  severity: string;
  missedDecisionCycleCount: number;
  evidence?: string;
  nextExperiment?: string;
}

export interface BuildAgentOpportunityPromotionGateInput {
  benchmarkID: string;
  benchmarkSummary: AgentOpportunityPromotionBenchmarkSummary | null;
  topGaps?: AgentOpportunityPromotionGap[];
  minimumPromotionRuns?: number;
}

export interface AgentOpportunityPromotionGate {
  status: AgentOpportunityPromotionStatus;
  reasons: string[];
  nextMilestone: string;
  metrics: {
    benchmarkID: string;
    runCount: number;
    winCount: number;
    requiredWins: number;
    winRate: number | null;
    survivalRate: number | null;
    averageTileShare: number | null;
    averageTurns: number | null;
    topGap: string | null;
  };
}

export function buildAgentOpportunityPromotionGate(
  input: BuildAgentOpportunityPromotionGateInput,
): AgentOpportunityPromotionGate {
  const summary = input.benchmarkSummary;
  const runs = summary?.runs ?? [];
  const runCount = runs.length || summary?.config?.runs || 0;
  const winCount =
    summary?.wins ?? runs.filter((run) => run.won === true).length;
  const requiredWins = summary?.requiredWins ?? runCount;
  const minimumPromotionRuns = input.minimumPromotionRuns ?? 3;
  const survivalRate = rate(
    runs.filter((run) => run.survived === true).length,
    runs.length,
  );
  const averageTileShare = average(runs.map((run) => run.tileShare));
  const averageTurns = average(runs.map((run) => run.turns));
  const topGap = topActionableGap(input.topGaps ?? []);
  const metrics = {
    benchmarkID: input.benchmarkID,
    runCount,
    winCount,
    requiredWins,
    winRate: rate(winCount, runCount),
    survivalRate,
    averageTileShare,
    averageTurns,
    topGap: topGap?.title ?? null,
  };

  if (summary === null || runCount === 0) {
    return {
      status: "inconclusive",
      reasons: ["benchmark summary is missing or has no completed runs"],
      nextMilestone:
        "Run a completed Hard-nation benchmark before judging this iteration.",
      metrics,
    };
  }

  const reasons = promotionReasons({
    pass: summary.pass === true,
    winCount,
    requiredWins,
    runCount,
    minimumPromotionRuns,
    survivalRate,
    averageTileShare,
    topGap,
  });

  if (summary.pass === true && runCount >= minimumPromotionRuns) {
    return {
      status: "promote",
      reasons,
      nextMilestone:
        requiredWins >= 10 && winCount >= 10
          ? "Promote this policy and render the best winning replay for review."
          : "Promote this policy into the wider 10/10 Hard-nation gate.",
      metrics,
    };
  }

  if (summary.pass === true) {
    return {
      status: "inconclusive",
      reasons,
      nextMilestone:
        "Run at least 3 fixed-seed Hard-nation matches before promoting the policy.",
      metrics,
    };
  }

  if (shouldDiscard({ winCount, survivalRate, averageTileShare })) {
    return {
      status: "discard",
      reasons,
      nextMilestone:
        topGap?.nextExperiment ??
        "Reject the candidate trigger and mine the collapse window before another behavior patch.",
      metrics,
    };
  }

  if (runCount < minimumPromotionRuns) {
    return {
      status: "inconclusive",
      reasons,
      nextMilestone:
        topGap?.nextExperiment ??
        "Run at least 3 fixed-seed Hard-nation matches before choosing the next behavior patch.",
      metrics,
    };
  }

  return {
    status: "revise",
    reasons,
    nextMilestone:
      topGap?.nextExperiment ??
      "Revise the highest-severity missed opportunity, then rerun the same gate.",
    metrics,
  };
}

function promotionReasons(input: {
  pass: boolean;
  winCount: number;
  requiredWins: number;
  runCount: number;
  minimumPromotionRuns: number;
  survivalRate: number | null;
  averageTileShare: number | null;
  topGap: AgentOpportunityPromotionGap | null;
}): string[] {
  const reasons: string[] = [];
  if (input.pass) {
    reasons.push(
      `benchmark target passed with ${input.winCount}/${input.requiredWins} wins`,
    );
  } else {
    reasons.push(
      `benchmark target missed with ${input.winCount}/${input.requiredWins} wins`,
    );
  }
  if (input.runCount < input.minimumPromotionRuns) {
    reasons.push("sample size is too small for promotion");
  }
  if (input.survivalRate !== null && input.survivalRate < 0.5) {
    reasons.push("agent usually failed to survive the match");
  }
  if (input.averageTileShare !== null && input.averageTileShare < 0.02) {
    reasons.push("agent ended with less than 2% average tile share");
  }
  if (input.topGap !== null) {
    reasons.push(
      `top opportunity gap: ${input.topGap.title} (${input.topGap.missedDecisionCycleCount} cycles)`,
    );
  }
  return reasons;
}

function shouldDiscard(input: {
  winCount: number;
  survivalRate: number | null;
  averageTileShare: number | null;
}): boolean {
  if (input.winCount > 0) {
    return false;
  }
  return (
    (input.survivalRate !== null && input.survivalRate < 0.5) ||
    (input.averageTileShare !== null && input.averageTileShare < 0.02)
  );
}

function topActionableGap(
  gaps: AgentOpportunityPromotionGap[],
): AgentOpportunityPromotionGap | null {
  const actionable = gaps
    .filter((gap) => gap.severity !== "none")
    .sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        right.missedDecisionCycleCount - left.missedDecisionCycleCount,
    );
  return actionable[0] ?? null;
}

function severityRank(severity: string): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return round(numerator / denominator);
}

function average(values: Array<number | undefined>): number | null {
  const finite = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (finite.length === 0) {
    return null;
  }
  return round(finite.reduce((total, value) => total + value, 0) / finite.length);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
