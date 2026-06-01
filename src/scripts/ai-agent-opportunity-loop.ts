import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { AgentLearningReport } from "../server/agents/AgentLearningArtifacts";
import {
  buildAgentLearningComparison,
  type AgentLearningComparisonReport,
  type FrontierBenchmarkSummaryRun,
  type FrontierBenchmarkSummaryForComparison,
  writeAgentLearningComparison,
} from "../server/agents/AgentLearningComparison";
import {
  buildAgentOpportunityPromotionGate,
  type AgentOpportunityPromotionBenchmarkRun,
  type AgentOpportunityPromotionBenchmarkSummary,
  type AgentOpportunityPromotionGap,
  type AgentOpportunityPromotionGate,
} from "../server/agents/AgentOpportunityPromotionGate";
import type { AgentCollapseWindowReport } from "../server/agents/AgentCollapseWindowMiner";

interface OpportunityLoopConfig {
  iterationID: string;
  benchmarkID: string;
  baselineID: string | null;
  comparisonID: string;
  outputDir: string;
  runs: number;
  requireWins: number;
  minimumPromotionRuns: number;
  nations: number;
  bots: number;
  difficulty: string;
  map: string;
  mapSize: string;
  maxTurns: number;
  brain: string;
  profile: string;
  researcher: "prompt" | "llm" | "off";
}

interface OpportunityLoopBenchmarkRun
  extends AgentOpportunityPromotionBenchmarkRun,
    FrontierBenchmarkSummaryRun {
  index: number;
  replayUrl?: string;
  replayRunID?: string | null;
}

type OpportunityLoopBenchmarkSummary = Omit<
  AgentOpportunityPromotionBenchmarkSummary,
  "config" | "runs"
> &
  Omit<FrontierBenchmarkSummaryForComparison, "config" | "runs"> & {
    config?: AgentOpportunityPromotionBenchmarkSummary["config"] &
      FrontierBenchmarkSummaryForComparison["config"];
    runs?: OpportunityLoopBenchmarkRun[];
  };

interface BaselineComparisonArtifacts {
  report: AgentLearningComparisonReport;
  markdownPath: string;
  jsonPath: string;
}

async function run() {
  const config = configFromArgs(process.argv.slice(2));
  await fs.mkdir(config.outputDir, { recursive: true });

  await runTsx("src/scripts/ai-agent-frontier-benchmark.ts", [
    `--brain=${config.brain}`,
    "--full-match",
    `--runs=${config.runs}`,
    `--require-wins=${config.requireWins}`,
    `--nations=${config.nations}`,
    `--bots=${config.bots}`,
    `--difficulty=${config.difficulty}`,
    `--map=${config.map}`,
    `--map-size=${config.mapSize}`,
    `--max-turns=${config.maxTurns}`,
    `--profile=${config.profile}`,
    "--opening-expansion-tempo=true",
    "--transport-troop-banking=true",
    "--write-replay",
    `--run-id=${config.benchmarkID}`,
  ]);

  await runTsx("src/scripts/ai-agent-learning-loop.ts", [
    `--benchmark-id=${config.benchmarkID}`,
    `--out-dir=${config.outputDir}`,
  ]);

  await runTsx("src/scripts/ai-agent-human-opportunity-miner.ts", [
    `--benchmark-id=${config.benchmarkID}`,
    `--out-dir=${config.outputDir}`,
  ]);

  await runTsx("src/scripts/ai-agent-collapse-window-miner.ts", [
    `--benchmark-id=${config.benchmarkID}`,
    `--out-dir=${config.outputDir}`,
  ]);

  if (config.researcher !== "off") {
    await runTsx("src/scripts/ai-agent-post-match-researcher.ts", [
      `--benchmark-id=${config.benchmarkID}`,
      `--out-id=${config.iterationID}`,
      `--out-dir=${path.join(config.outputDir, "researcher")}`,
      ...(config.researcher === "prompt" ? ["--dry-run"] : []),
    ]);
  }

  const summaryPath = await writeIterationSummary(config);
  const summaryJson = await readOptionalJson<{
    promotionGate?: AgentOpportunityPromotionGate;
    baselineComparison?: AgentLearningComparisonReport | null;
  }>(path.join(config.outputDir, "iteration-summary.json"));
  console.log("Agent opportunity loop complete", {
    iterationID: config.iterationID,
    benchmarkID: config.benchmarkID,
    promotionStatus: summaryJson?.promotionGate?.status ?? "unknown",
    comparisonStatus:
      summaryJson?.baselineComparison?.verdict.status ?? "not-run",
    outputDir: config.outputDir,
    summary: summaryPath,
  });
}

async function writeIterationSummary(
  config: OpportunityLoopConfig,
): Promise<string> {
  const benchmarkDir = path.resolve(
    process.cwd(),
    "artifacts",
    "ai-league-benchmarks",
    config.benchmarkID,
  );
  const benchmarkSummary =
    await readOptionalJson<OpportunityLoopBenchmarkSummary>(
      path.join(benchmarkDir, "frontier-summary.json"),
    );
  const humanReport = await readOptionalJson<{
    gaps?: AgentOpportunityPromotionGap[];
  }>(path.join(config.outputDir, "human-opportunity-report.json"));
  const collapseReport = await readOptionalJson<AgentCollapseWindowReport>(
    path.join(config.outputDir, "collapse-window-report.json"),
  );
  const topGaps = (humanReport?.gaps ?? [])
    .filter((gap) => gap.severity !== "none")
    .sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        right.missedDecisionCycleCount - left.missedDecisionCycleCount,
    )
    .slice(0, 5);
  const promotionGate = buildAgentOpportunityPromotionGate({
    benchmarkID: config.benchmarkID,
    benchmarkSummary,
    topGaps,
    minimumPromotionRuns: config.minimumPromotionRuns,
  });
  const baselineComparison = await maybeWriteBaselineComparison({
    config,
    benchmarkDir,
    benchmarkSummary,
  });
  const runs = benchmarkSummary?.runs ?? [];
  const replayLines = runs
    .map(
      (summary) =>
        `- Run ${summary.index}: ${replayUrlForRun(summary, config)} (${summary.won ? "win" : "loss"})`,
    )
    .filter((line) => !line.includes(": null "));
  const researcherArtifactLines =
    config.researcher === "off"
      ? []
      : [
          `- Researcher packet: ${path.join(config.outputDir, "researcher", config.researcher === "llm" ? "research-proposal.md" : "researcher-prompt.md")}`,
        ];
  const lines = [
    `# Opportunity Learning Iteration: ${config.iterationID}`,
    "",
    `Benchmark: ${config.benchmarkID}`,
    `Result: ${benchmarkSummary?.wins ?? 0}/${config.runs} wins (target ${benchmarkSummary?.requiredWins ?? config.requireWins})`,
    `Pass: ${benchmarkSummary?.pass === true ? "yes" : "no"}`,
    `Promotion status: ${promotionGate.status}`,
    "",
    "## Artifacts",
    "",
    `- Benchmark report: ${path.join(benchmarkDir, "benchmark-report.md")}`,
    `- Learning report: ${path.join(config.outputDir, "learning-report.md")}`,
    `- Human opportunity report: ${path.join(config.outputDir, "human-opportunity-report.md")}`,
    `- Collapse window report: ${path.join(config.outputDir, "collapse-window-report.md")}`,
    ...researcherArtifactLines,
    ...(baselineComparison === null
      ? []
      : [
          `- A/B comparison: ${baselineComparison.markdownPath}`,
          `- A/B comparison JSON: ${baselineComparison.jsonPath}`,
        ]),
    "",
    "## Promotion Gate",
    "",
    `Status: **${promotionGate.status}**`,
    "",
    markdownTable(
      ["Runs", "Wins", "Required", "Win Rate", "Survival", "Avg Tile Share"],
      [
        [
          String(promotionGate.metrics.runCount),
          String(promotionGate.metrics.winCount),
          String(promotionGate.metrics.requiredWins),
          formatNullable(promotionGate.metrics.winRate),
          formatNullable(promotionGate.metrics.survivalRate),
          formatNullable(promotionGate.metrics.averageTileShare),
        ],
      ],
    ),
    "",
    ...promotionGate.reasons.map((reason) => `- ${reason}`),
    "",
    `Next milestone: ${promotionGate.nextMilestone}`,
    ...(baselineComparison === null
      ? []
      : [
          "",
          `A/B verdict against ${config.baselineID}: **${baselineComparison.report.verdict.status}**`,
          ...baselineComparison.report.verdict.reasons.map(
            (reason) => `- ${reason}`,
          ),
        ]),
    "",
    "## Top Opportunity Gaps",
    "",
    topGaps.length === 0
      ? "No non-none opportunity gaps were reported."
      : markdownTable(
          ["Gap", "Severity", "Missed", "Evidence", "Next Experiment"],
          topGaps.map((gap) => [
            gap.title,
            gap.severity,
            String(gap.missedDecisionCycleCount),
            gap.evidence ?? "",
            gap.nextExperiment ?? "",
          ]),
        ),
    "",
    "## Collapse Window Findings",
    "",
    collapseReport === null || collapseReport.topFindings.length === 0
      ? "No collapse-window findings were reported."
      : markdownTable(
          ["Finding", "Severity", "Runs", "Evidence", "Next Experiment"],
          collapseReport.topFindings.map((finding) => [
            finding.title,
            finding.severity,
            String(finding.affectedRunCount),
            finding.evidence,
            finding.nextExperiment,
          ]),
        ),
    "",
    "## Replays",
    "",
    replayLines.length === 0
      ? "No replay links found."
      : replayLines.join("\n"),
    "",
  ];
  const summaryPath = path.join(config.outputDir, "iteration-summary.md");
  await fs.writeFile(summaryPath, lines.join("\n"));
  await fs.writeFile(
    path.join(config.outputDir, "iteration-summary.json"),
    `${JSON.stringify(
      {
        config,
        benchmarkSummary,
        topGaps,
        collapseReport,
        promotionGate,
        baselineComparison: baselineComparison?.report ?? null,
      },
      null,
      2,
    )}\n`,
  );
  return summaryPath;
}

async function maybeWriteBaselineComparison(input: {
  config: OpportunityLoopConfig;
  benchmarkDir: string;
  benchmarkSummary: OpportunityLoopBenchmarkSummary | null;
}): Promise<BaselineComparisonArtifacts | null> {
  if (input.config.baselineID === null || input.benchmarkSummary === null) {
    return null;
  }
  const benchmarkRoot = path.resolve(
    process.cwd(),
    "artifacts",
    "ai-league-benchmarks",
  );
  const baselineDir = path.join(benchmarkRoot, input.config.baselineID);
  const baselineSummary =
    await readOptionalJson<FrontierBenchmarkSummaryForComparison>(
      path.join(baselineDir, "frontier-summary.json"),
    );
  if (baselineSummary === null) {
    return null;
  }
  const comparisonInput = {
    comparisonID: input.config.comparisonID,
    baseline: {
      label: "baseline",
      benchmarkID: input.config.baselineID,
      frontierSummary: baselineSummary,
      learningReport: await readOptionalJson<AgentLearningReport>(
        path.join(baselineDir, "learning-report.json"),
      ),
    },
    candidate: {
      label: "candidate",
      benchmarkID: input.config.benchmarkID,
      frontierSummary: input.benchmarkSummary,
      learningReport: await readOptionalJson<AgentLearningReport>(
        path.join(input.benchmarkDir, "learning-report.json"),
      ),
    },
  };
  const report = buildAgentLearningComparison(comparisonInput);
  const paths = await writeAgentLearningComparison({
    ...comparisonInput,
    directory: path.join(input.config.outputDir, "comparison"),
  });
  return { report, markdownPath: paths.markdownPath, jsonPath: paths.jsonPath };
}

function configFromArgs(args: string[]): OpportunityLoopConfig {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const iterationID = stringArg(
    args,
    "--iteration-id=",
    `opportunity-loop-${timestamp}`,
  );
  const runs = positiveIntegerArg(args, "--runs=", 1);
  return {
    iterationID,
    benchmarkID: stringArg(args, "--benchmark-id=", `${iterationID}-benchmark`),
    baselineID: nullableStringArg(args, "--baseline-id="),
    comparisonID: stringArg(args, "--comparison-id=", `${iterationID}-ab-gate`),
    outputDir: path.resolve(
      process.cwd(),
      stringArg(
        args,
        "--out-dir=",
        path.join("artifacts", "opportunity-learning-loop", iterationID),
      ),
    ),
    runs,
    requireWins: positiveIntegerArg(args, "--require-wins=", runs),
    minimumPromotionRuns: positiveIntegerArg(
      args,
      "--minimum-promotion-runs=",
      3,
    ),
    nations: positiveIntegerArg(args, "--nations=", 5),
    bots: nonNegativeIntegerArg(args, "--bots=", 0),
    difficulty: stringArg(args, "--difficulty=", "Hard"),
    map: stringArg(args, "--map=", "Pangaea"),
    mapSize: stringArg(args, "--map-size=", "Compact"),
    maxTurns: positiveIntegerArg(args, "--max-turns=", 12_000),
    brain: stringArg(args, "--brain=", "planner"),
    profile: stringArg(args, "--profile=", "aggressive"),
    researcher: researcherArg(args),
  };
}

async function runTsx(script: string, args: string[]): Promise<void> {
  console.log(`Running ${script}`, args);
  await runCommand(npxCommand(), ["tsx", script, ...args], {
    ...process.env,
    GAME_ENV: process.env.GAME_ENV ?? "dev",
  });
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`,
        ),
      );
    });
  });
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function researcherArg(args: string[]): OpportunityLoopConfig["researcher"] {
  const value = stringArg(args, "--researcher=", "prompt");
  if (value === "prompt" || value === "llm" || value === "off") {
    return value;
  }
  throw new Error("--researcher must be prompt, llm, or off");
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

function replayUrlForRun(
  summary: {
    index: number;
    replayUrl?: string;
    replayRunID?: string | null;
  },
  config: OpportunityLoopConfig,
): string | null {
  if (summary.replayUrl !== undefined) {
    return summary.replayUrl;
  }
  const replayRunID =
    summary.replayRunID ??
    (config.runs === 1
      ? config.benchmarkID
      : `${config.benchmarkID}-run-${summary.index}`);
  return `http://127.0.0.1:9000/ai-league-replay/${replayRunID}`;
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

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function stringArg(
  args: string[],
  prefix: string,
  defaultValue: string,
): string {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ??
    defaultValue
  );
}

function nullableStringArg(args: string[], prefix: string): string | null {
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return value === undefined || value.trim() === "" ? null : value;
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${prefix}${raw} must be a non-negative integer`);
  }
  return value;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
