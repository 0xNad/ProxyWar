import fs from "fs/promises";
import path from "path";
import {
  AgentDecisionRecordLike,
  AgentHumanOpportunityRunInput,
  buildAgentHumanOpportunityReport,
  humanBaselineFromOpportunityAtlas,
  humanOpportunityReportMarkdown,
} from "../server/agents/AgentHumanOpportunityMiner";

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
  const humanAtlasPath =
    stringArg(args, "--human-atlas=") ?? (await latestHumanAtlasPath());
  if (humanAtlasPath === null) {
    throw new Error(
      "No human opportunity atlas found. Run agent:learn:human-replay:mine first.",
    );
  }
  const humanAtlas = JSON.parse(await fs.readFile(humanAtlasPath, "utf8"));
  const humanBaseline = humanBaselineFromOpportunityAtlas(humanAtlas);
  const benchmarkID = stringArg(args, "--benchmark-id=");
  const runID = stringArg(args, "--run-id=");
  const input =
    benchmarkID !== null
      ? await loadBenchmarkInput(benchmarkID)
      : await loadRunInput(runID ?? (await latestRunID()));
  const reportID =
    stringArg(args, "--out-id=") ??
    `${input.subjectID}-human-opportunity-report`;
  const outputDir = path.resolve(
    process.cwd(),
    stringArg(args, "--out-dir=") ?? input.directory,
  );
  await fs.mkdir(outputDir, { recursive: true });
  const report = buildAgentHumanOpportunityReport({
    reportID,
    source: input.source,
    humanCorpusID:
      stringField(humanAtlas, "corpusID") ??
      path.basename(path.dirname(humanAtlasPath)),
    humanBaseline,
    turnsPerMinute: numberArg(args, "--turns-per-minute=", 600),
    runs: input.runs,
  });
  const jsonPath = path.join(outputDir, "human-opportunity-report.json");
  const markdownPath = path.join(outputDir, "human-opportunity-report.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, humanOpportunityReportMarkdown(report)),
  ]);
  console.log("Agent human opportunity report complete", {
    reportID,
    subjects: report.subjectCount,
    humanAtlas: humanAtlasPath,
    report: markdownPath,
    json: jsonPath,
  });
}

async function loadBenchmarkInput(benchmarkID: string): Promise<{
  subjectID: string;
  source: string;
  directory: string;
  runs: AgentHumanOpportunityRunInput[];
}> {
  const directory = path.resolve(
    process.cwd(),
    "artifacts",
    "ai-league-benchmarks",
    benchmarkID,
  );
  const summary = await readOptionalJson<{ runs?: FrontierSummaryRun[] }>(
    path.join(directory, "frontier-summary.json"),
  );
  const summaryRuns = summary?.runs ?? [];
  const runs =
    summaryRuns.length > 0
      ? await Promise.all(
          summaryRuns.map(async (summaryRun) => ({
            runID:
              summaryRun.replayRunID ??
              `${benchmarkID}-run-${summaryRun.index}`,
            benchmarkRunIndex: summaryRun.index,
            won: summaryRun.won ?? null,
            survived: summaryRun.survived ?? null,
            tileShare: summaryRun.tileShare ?? null,
            turns: summaryRun.turns ?? null,
            records: await readJson<AgentDecisionRecordLike[]>(
              path.join(directory, `run-${summaryRun.index}.records.json`),
            ),
          })),
        )
      : await runsFromBenchmarkRecordFiles(benchmarkID, directory);
  return {
    subjectID: benchmarkID,
    source: `benchmark:${benchmarkID}`,
    directory,
    runs,
  };
}

async function runsFromBenchmarkRecordFiles(
  benchmarkID: string,
  directory: string,
): Promise<AgentHumanOpportunityRunInput[]> {
  const filenames = (await fs.readdir(directory))
    .filter((filename) => /^run-\d+\.records\.json$/.test(filename))
    .sort((left, right) => runIndex(left) - runIndex(right));
  return Promise.all(
    filenames.map(async (filename) => {
      const index = runIndex(filename);
      return {
        runID: `${benchmarkID}-run-${index}`,
        benchmarkRunIndex: index,
        won: null,
        survived: null,
        tileShare: null,
        turns: null,
        records: await readJson<AgentDecisionRecordLike[]>(
          path.join(directory, filename),
        ),
      };
    }),
  );
}

async function loadRunInput(runID: string | null): Promise<{
  subjectID: string;
  source: string;
  directory: string;
  runs: AgentHumanOpportunityRunInput[];
}> {
  if (runID === null) {
    throw new Error("No AI league run artifacts found.");
  }
  const directory = path.resolve(
    process.cwd(),
    "artifacts",
    "ai-league-runs",
    runID,
  );
  const records = await readJsonl<AgentDecisionRecordLike>(
    path.join(directory, "decisions.jsonl"),
  );
  const summary = await readOptionalJson<{
    finalState?: { players?: Array<{ isAlive?: boolean | null }> };
  }>(path.join(directory, "match-summary.json"));
  return {
    subjectID: runID,
    source: `run:${runID}`,
    directory,
    runs: [
      {
        runID,
        benchmarkRunIndex: null,
        won: null,
        survived:
          summary?.finalState?.players?.some(
            (player) => player.isAlive === true,
          ) ?? null,
        tileShare: null,
        turns: null,
        records,
      },
    ],
  };
}

async function latestHumanAtlasPath(): Promise<string | null> {
  const root = path.resolve(
    process.cwd(),
    "artifacts",
    "human-replays",
    "batches",
  );
  return latestFile(root, "opportunity-atlas.json");
}

async function latestRunID(): Promise<string | null> {
  const root = path.resolve(process.cwd(), "artifacts", "ai-league-runs");
  return latestDirectoryName(root);
}

async function latestFile(
  root: string,
  filename: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(root, entry, filename);
      try {
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }),
  );
  return (
    candidates
      .filter(
        (candidate): candidate is { filePath: string; mtimeMs: number } =>
          candidate !== null,
      )
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath ?? null
  );
}

async function latestDirectoryName(root: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry);
      const stat = await fs.stat(entryPath);
      return { entry, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
    }),
  );
  return (
    candidates
      .filter((candidate) => candidate.isDirectory)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.entry ?? null
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  return (await fs.readFile(filePath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function numberArg(args: string[], prefix: string, fallback: number): number {
  const raw = stringArg(args, prefix);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${prefix}${raw} must be a positive number`);
  }
  return parsed;
}

function runIndex(filename: string): number {
  return Number(/^run-(\d+)\.records\.json$/.exec(filename)?.[1] ?? 0);
}

function stringField(record: unknown, field: string): string | null {
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
