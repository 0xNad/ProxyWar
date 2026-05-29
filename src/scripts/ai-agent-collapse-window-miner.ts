import fs from "fs/promises";
import path from "path";
import {
  agentCollapseWindowReportMarkdown,
  AgentCollapseSnapshotInput,
  AgentCollapseWindowRunInput,
  buildAgentCollapseWindowReport,
} from "../server/agents/AgentCollapseWindowMiner";
import type { AgentDecisionRecordLike } from "../server/agents/AgentHumanOpportunityMiner";

interface FrontierSummaryRun {
  index: number;
  won?: boolean;
  survived?: boolean;
  tileShare?: number;
  turns?: number;
  replayRunID?: string | null;
}

interface SpectatorReplayLike {
  snapshots?: AgentCollapseSnapshotInput[];
}

async function run() {
  const args = process.argv.slice(2);
  const benchmarkID = stringArg(args, "--benchmark-id=");
  const runID = stringArg(args, "--run-id=");
  const input =
    benchmarkID !== null
      ? await loadBenchmarkInput(benchmarkID)
      : await loadRunInput(runID ?? (await latestRunID()));
  const reportID =
    stringArg(args, "--out-id=") ?? `${input.subjectID}-collapse-window-report`;
  const outputDir = path.resolve(
    process.cwd(),
    stringArg(args, "--out-dir=") ?? input.directory,
  );
  await fs.mkdir(outputDir, { recursive: true });
  const report = buildAgentCollapseWindowReport({
    reportID,
    source: input.source,
    runs: input.runs,
  });
  const jsonPath = path.join(outputDir, "collapse-window-report.json");
  const markdownPath = path.join(outputDir, "collapse-window-report.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, agentCollapseWindowReportMarkdown(report)),
  ]);
  console.log("Agent collapse window report complete", {
    reportID,
    runs: report.runCount,
    topFindings: report.topFindings.map((finding) => finding.title),
    report: markdownPath,
    json: jsonPath,
  });
}

async function loadBenchmarkInput(benchmarkID: string): Promise<{
  subjectID: string;
  source: string;
  directory: string;
  runs: AgentCollapseWindowRunInput[];
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
          summaryRuns.map(async (summaryRun) => {
            const replayRunID =
              summaryRun.replayRunID ?? `${benchmarkID}-run-${summaryRun.index}`;
            return {
              runID: replayRunID,
              benchmarkRunIndex: summaryRun.index,
              won: summaryRun.won ?? null,
              survived: summaryRun.survived ?? null,
              tileShare: summaryRun.tileShare ?? null,
              turns: summaryRun.turns ?? null,
              records: await readJson<AgentDecisionRecordLike[]>(
                path.join(directory, `run-${summaryRun.index}.records.json`),
              ),
              snapshots: await snapshotsForRun(replayRunID),
            };
          }),
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
): Promise<AgentCollapseWindowRunInput[]> {
  const filenames = (await fs.readdir(directory))
    .filter((filename) => /^run-\d+\.records\.json$/.test(filename))
    .sort((left, right) => runIndex(left) - runIndex(right));
  return Promise.all(
    filenames.map(async (filename) => {
      const index = runIndex(filename);
      const replayRunID = `${benchmarkID}-run-${index}`;
      return {
        runID: replayRunID,
        benchmarkRunIndex: index,
        won: null,
        survived: null,
        tileShare: null,
        turns: null,
        records: await readJson<AgentDecisionRecordLike[]>(
          path.join(directory, filename),
        ),
        snapshots: await snapshotsForRun(replayRunID),
      };
    }),
  );
}

async function loadRunInput(runID: string | null): Promise<{
  subjectID: string;
  source: string;
  directory: string;
  runs: AgentCollapseWindowRunInput[];
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
        records: await readJsonl<AgentDecisionRecordLike>(
          path.join(directory, "decisions.jsonl"),
        ),
        snapshots: await snapshotsForRun(runID),
      },
    ],
  };
}

async function snapshotsForRun(
  replayRunID: string,
): Promise<AgentCollapseSnapshotInput[]> {
  const replay = await readOptionalJson<SpectatorReplayLike>(
    path.resolve(
      process.cwd(),
      "artifacts",
      "ai-league-runs",
      replayRunID,
      "spectator-replay.json",
    ),
  );
  return replay?.snapshots ?? [];
}

async function latestRunID(): Promise<string | null> {
  const root = path.resolve(process.cwd(), "artifacts", "ai-league-runs");
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
      const directory = path.join(root, entry);
      try {
        const stat = await fs.stat(directory);
        return stat.isDirectory()
          ? { directory, name: entry, mtimeMs: stat.mtimeMs }
          : null;
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
        (candidate): candidate is {
          directory: string;
          name: string;
          mtimeMs: number;
        } => candidate !== null,
      )
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.name ?? null
  );
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
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

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\n+/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function runIndex(filename: string): number {
  return Number(/^run-(\d+)\.records\.json$/.exec(filename)?.[1] ?? 0);
}

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
