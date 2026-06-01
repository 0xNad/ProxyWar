import fs from "fs/promises";
import path from "path";
import type { AgentLearningReport } from "../server/agents/AgentLearningArtifacts";
import type {
  AgentLearningComparisonFocusTactic,
  FrontierBenchmarkSummaryForComparison,
} from "../server/agents/AgentLearningComparison";
import { writeAgentLearningComparison } from "../server/agents/AgentLearningComparison";

async function run() {
  const args = process.argv.slice(2);
  const baselineID = requiredStringArg(args, "--baseline-id=");
  const candidateID = requiredStringArg(args, "--candidate-id=");
  const comparisonID =
    stringArg(args, "--comparison-id=") ?? `${baselineID}-vs-${candidateID}`;
  const focusTactic = focusTacticArg(args);
  const benchmarkRoot = path.resolve(
    process.cwd(),
    "artifacts/ai-league-benchmarks",
  );
  const outputDir =
    stringArg(args, "--out-dir=") ??
    path.resolve(
      process.cwd(),
      "artifacts/ai-learning-comparisons",
      comparisonID,
    );

  const paths = await writeAgentLearningComparison({
    comparisonID,
    baseline: await loadSide({
      label: "baseline",
      benchmarkID: baselineID,
      benchmarkRoot,
    }),
    candidate: await loadSide({
      label: "candidate",
      benchmarkID: candidateID,
      benchmarkRoot,
    }),
    focusTactic,
    directory: outputDir,
  });

  console.log("Agent learning comparison complete", {
    comparisonID,
    report: paths.markdownPath,
    json: paths.jsonPath,
  });
}

async function loadSide(input: {
  label: string;
  benchmarkID: string;
  benchmarkRoot: string;
}) {
  const directory = path.join(input.benchmarkRoot, input.benchmarkID);
  return {
    label: input.label,
    benchmarkID: input.benchmarkID,
    frontierSummary: await readJsonFile<FrontierBenchmarkSummaryForComparison>(
      path.join(directory, "frontier-summary.json"),
    ),
    learningReport: await readOptionalJsonFile<AgentLearningReport>(
      path.join(directory, "learning-report.json"),
    ),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readOptionalJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function requiredStringArg(args: string[], prefix: string): string {
  const value = stringArg(args, prefix);
  if (value === null || value.trim() === "") {
    throw new Error(`Missing required ${prefix}<value>`);
  }
  return value;
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function focusTacticArg(
  args: string[],
): AgentLearningComparisonFocusTactic | null {
  const value = stringArg(args, "--tactic=");
  if (value === null) {
    return null;
  }
  if (
    value === "frontier-conversion" ||
    value === "frontier-finish-pressure" ||
    value === "opening-expansion-tempo" ||
    value === "economy-cadence" ||
    value === "naval-control" ||
    value === "late-game-strike-targeting" ||
    value === "personality-diplomacy-pressure" ||
    value === "profile-differentiation" ||
    value === "transport-banking"
  ) {
    return value;
  }
  throw new Error(
    `--tactic=${value} must be frontier-conversion, frontier-finish-pressure, opening-expansion-tempo, economy-cadence, naval-control, late-game-strike-targeting, personality-diplomacy-pressure, profile-differentiation, or transport-banking`,
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
