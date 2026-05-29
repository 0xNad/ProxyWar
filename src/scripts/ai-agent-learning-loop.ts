import fs from "fs/promises";
import path from "path";
import type { AgentLearningRunInput } from "../server/agents/AgentLearningArtifacts";
import { writeAgentLearningArtifacts } from "../server/agents/AgentLearningArtifacts";
import type { AgentDecisionRecord } from "../server/agents/AgentTypes";

interface FrontierSummaryRun {
  index: number;
  won?: boolean;
  survived?: boolean;
  tileShare?: number;
  turns?: number;
  replayRunID?: string | null;
}

async function run() {
  const args = process.argv.slice(2);
  const benchmarkRoot = path.resolve(
    process.cwd(),
    "artifacts/ai-league-benchmarks",
  );
  const benchmarkID =
    stringArg(args, "--benchmark-id=") ??
    (await latestBenchmarkID(benchmarkRoot));
  if (benchmarkID === null) {
    throw new Error(
      "No benchmark artifacts found under artifacts/ai-league-benchmarks",
    );
  }
  const benchmarkDir = path.join(benchmarkRoot, benchmarkID);
  const outputDir =
    stringArg(args, "--out-dir=") ??
    path.resolve(process.cwd(), "artifacts/ai-learning", benchmarkID);
  const runs = await learningRunsFromBenchmark(benchmarkID, benchmarkDir);
  const paths = await writeAgentLearningArtifacts({
    benchmarkID,
    runs,
    directory: outputDir,
  });
  console.log("Agent learning report complete", {
    benchmarkID,
    runs: runs.length,
    report: paths.markdownPath,
    json: paths.jsonPath,
  });
}

async function learningRunsFromBenchmark(
  benchmarkID: string,
  benchmarkDir: string,
): Promise<AgentLearningRunInput[]> {
  const summaryPath = path.join(benchmarkDir, "frontier-summary.json");
  const summary = await readJsonFile<{ runs?: FrontierSummaryRun[] }>(
    summaryPath,
  );
  const summaryRuns = summary.runs ?? [];
  if (summaryRuns.length === 0) {
    return learningRunsFromRecordFiles(benchmarkID, benchmarkDir);
  }
  const runs: AgentLearningRunInput[] = [];
  for (const summaryRun of summaryRuns) {
    const recordsPath = path.join(
      benchmarkDir,
      `run-${summaryRun.index}.records.json`,
    );
    const records = await readJsonFile<AgentDecisionRecord[]>(recordsPath);
    runs.push({
      runID: summaryRun.replayRunID ?? `${benchmarkID}-run-${summaryRun.index}`,
      benchmarkRunIndex: summaryRun.index,
      won: summaryRun.won ?? null,
      survived: summaryRun.survived ?? null,
      tileShare: summaryRun.tileShare ?? null,
      turns: summaryRun.turns ?? null,
      records,
    });
  }
  return runs;
}

async function learningRunsFromRecordFiles(
  benchmarkID: string,
  benchmarkDir: string,
): Promise<AgentLearningRunInput[]> {
  const filenames = (await fs.readdir(benchmarkDir))
    .filter((filename) => /^run-\d+\.records\.json$/.test(filename))
    .sort((a, b) => runIndexFromFilename(a) - runIndexFromFilename(b));
  return Promise.all(
    filenames.map(async (filename) => {
      const index = runIndexFromFilename(filename);
      return {
        runID: `${benchmarkID}-run-${index}`,
        benchmarkRunIndex: index,
        won: null,
        survived: null,
        tileShare: null,
        turns: null,
        records: await readJsonFile<AgentDecisionRecord[]>(
          path.join(benchmarkDir, filename),
        ),
      };
    }),
  );
}

async function latestBenchmarkID(rootDir: string): Promise<string | null> {
  let entries: Array<{ name: string; mtimeMs: number; isDirectory: boolean }>;
  try {
    entries = await Promise.all(
      (await fs.readdir(rootDir)).map(async (name) => {
        const stat = await fs.stat(path.join(rootDir, name));
        return { name, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return (
    entries
      .filter((entry) => entry.isDirectory)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name ?? null
  );
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function runIndexFromFilename(filename: string): number {
  const match = /^run-(\d+)\.records\.json$/.exec(filename);
  return match === null ? 0 : Number(match[1]);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
