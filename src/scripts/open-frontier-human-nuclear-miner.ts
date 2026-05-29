import fs from "fs/promises";
import path from "path";
import type { HumanReplayRecord } from "../server/agents/HumanReplayAnalysis";
import { writeHumanReplayNuclearArtifacts } from "../server/agents/HumanReplayNuclearAnalysis";

interface NuclearMinerConfig {
  inputDir: string;
  outputID: string;
  maxReplays: number | null;
}

async function run() {
  const config = configFromArgs(process.argv.slice(2));
  const files = (await findReplayRecords(config.inputDir)).slice(
    0,
    config.maxReplays ?? undefined,
  );
  if (files.length === 0) {
    throw new Error(`No game-record.json files found under ${config.inputDir}`);
  }
  const records: HumanReplayRecord[] = [];
  for (const file of files) {
    records.push(
      JSON.parse(await fs.readFile(file, "utf8")) as HumanReplayRecord,
    );
  }
  const outputDir = path.resolve(
    process.cwd(),
    "artifacts",
    "human-replays",
    "batches",
    safePathSegment(config.outputID),
  );
  const paths = await writeHumanReplayNuclearArtifacts({
    records,
    directory: outputDir,
    source: `${files.length} local replay records under ${config.inputDir}`,
  });
  console.log("Human nuclear replay mining complete", {
    outputID: config.outputID,
    records: records.length,
    report: paths.markdownPath,
    json: paths.jsonPath,
  });
}

async function findReplayRecords(root: string): Promise<string[]> {
  const absoluteRoot = path.resolve(process.cwd(), root);
  const result: string[] = [];
  async function walk(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.name === "game-record.json") {
        result.push(filePath);
      }
    }
  }
  await walk(absoluteRoot);
  return result.sort();
}

function configFromArgs(args: string[]): NuclearMinerConfig {
  return {
    inputDir: stringArg(args, "--input-dir=") ?? "artifacts/human-replays",
    outputID:
      stringArg(args, "--out-id=") ??
      `human-nuclear-${new Date().toISOString().slice(0, 10)}`,
    maxReplays: positiveIntegerArg(args, "--max-replays="),
  };
}

function stringArg(args: string[], prefix: string): string | null {
  const match = args.find((arg) => arg.startsWith(prefix));
  return match === undefined ? null : match.slice(prefix.length);
}

function positiveIntegerArg(args: string[], prefix: string): number | null {
  const raw = stringArg(args, prefix);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix} must be a positive integer`);
  }
  return value;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
