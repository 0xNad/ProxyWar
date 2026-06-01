import fs from "fs/promises";
import path from "path";
import {
  HumanReplayRecord,
  writeHumanReplayAnalysisArtifacts,
} from "../server/agents/HumanReplayAnalysis";

interface AnalyzerConfig {
  gameID: string | null;
  inputPath: string | null;
  outputDir: string | null;
  apiBaseUrl: string;
  refresh: boolean;
  topCandidateCount: number;
}

async function run() {
  const config = configFromArgs(process.argv.slice(2));
  const { record, source, rawPath } = await loadReplayRecord(config);
  const outputDir =
    config.outputDir ??
    path.resolve(
      process.cwd(),
      "artifacts",
      "human-replays",
      safePathSegment(record.info.gameID),
    );
  const paths = await writeHumanReplayAnalysisArtifacts({
    record,
    source,
    directory: outputDir,
    topCandidateCount: config.topCandidateCount,
  });

  console.log("Human replay analysis complete", {
    gameID: record.info.gameID,
    source,
    rawReplay: rawPath,
    report: paths.markdownPath,
    json: paths.jsonPath,
  });
}

async function loadReplayRecord(config: AnalyzerConfig): Promise<{
  record: HumanReplayRecord;
  source: string;
  rawPath: string | null;
}> {
  if (config.inputPath !== null) {
    const absoluteInputPath = path.resolve(process.cwd(), config.inputPath);
    return {
      record: JSON.parse(
        await fs.readFile(absoluteInputPath, "utf8"),
      ) as HumanReplayRecord,
      source: absoluteInputPath,
      rawPath: absoluteInputPath,
    };
  }
  if (config.gameID === null) {
    throw new Error("Pass --game-id=<id> or --input=<path>");
  }

  const directory = path.resolve(
    process.cwd(),
    "artifacts",
    "human-replays",
    safePathSegment(config.gameID),
  );
  const rawPath = path.join(directory, "game-record.json");
  if (!config.refresh && (await exists(rawPath))) {
    return {
      record: JSON.parse(
        await fs.readFile(rawPath, "utf8"),
      ) as HumanReplayRecord,
      source: rawPath,
      rawPath,
    };
  }

  await fs.mkdir(directory, { recursive: true });
  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/public/game/${encodeURIComponent(
    config.gameID,
  )}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ProxyWar replay ${config.gameID}: ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  await fs.writeFile(rawPath, text);
  return {
    record: JSON.parse(text) as HumanReplayRecord,
    source: url,
    rawPath,
  };
}

function configFromArgs(args: string[]): AnalyzerConfig {
  return {
    gameID: stringArg(args, "--game-id="),
    inputPath: stringArg(args, "--input="),
    outputDir: stringArg(args, "--out-dir="),
    apiBaseUrl:
      stringArg(args, "--api-base-url=") ?? "https://api.openfront.io",
    refresh: args.includes("--refresh"),
    topCandidateCount: positiveIntegerArg(args, "--top=", 5),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  fallback: number,
): number {
  const value = stringArg(args, prefix);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prefix}${value} must be a positive integer`);
  }
  return parsed;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
