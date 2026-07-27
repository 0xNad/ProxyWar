import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CITATION_EXTENSIONS,
  DEFAULT_CITATION_ROOTS,
  DEFAULT_MAX_BYTES_PER_RUN,
  DEFAULT_MAX_DIRS_PER_RUN,
  DEFAULT_RETAIN_NEWEST,
  DEFAULT_TTL_DAYS,
  runAiLeagueRunsRetention,
} from "../server/agents/AiLeagueRunsRetention";
import {
  parseCoworldLeagueRetentionPins,
  type CoworldLeagueRetentionReferences,
} from "../server/agents/CoworldLeagueArtifactRetention";

interface RetentionCliOptions {
  runsRootDir: string;
  citationRoots: string[];
  pinManifestPath: string;
  stateDir: string;
  retainNewest: number;
  ttlDays: number;
  maxDirs: number;
  maxBytes: number;
  archiveToDir: string | null;
  dryRun: boolean;
}

function defaultStateDir(): string {
  return (
    process.env.PROXYWAR_STORAGE_STATE_DIR ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ProxyWar",
      "storage",
    )
  );
}

function parseOptions(argv: string[]): RetentionCliOptions {
  const options: RetentionCliOptions = {
    runsRootDir: path.join("artifacts", "ai-league-runs"),
    citationRoots: [...DEFAULT_CITATION_ROOTS],
    pinManifestPath:
      process.env.PROXYWAR_LEAGUE_RETENTION_PINS ??
      path.join("deploy", "coworld-league-retention-pins.json"),
    stateDir: defaultStateDir(),
    retainNewest: numberFromEnv(
      process.env.PROXYWAR_RUNS_RETAIN_NEWEST,
      DEFAULT_RETAIN_NEWEST,
    ),
    ttlDays: numberFromEnv(
      process.env.PROXYWAR_RUNS_RETAIN_TTL_DAYS,
      DEFAULT_TTL_DAYS,
    ),
    maxDirs: numberFromEnv(
      process.env.PROXYWAR_RUNS_RETENTION_MAX_DIRS,
      DEFAULT_MAX_DIRS_PER_RUN,
    ),
    maxBytes: numberFromEnv(
      process.env.PROXYWAR_RUNS_RETENTION_MAX_BYTES,
      DEFAULT_MAX_BYTES_PER_RUN,
    ),
    archiveToDir: null,
    dryRun: true,
  };
  let sawCitationRoot = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    switch (arg) {
      case "--runs-root":
        options.runsRootDir = next();
        break;
      case "--docs-dir":
        if (!sawCitationRoot) {
          options.citationRoots = [];
          sawCitationRoot = true;
        }
        options.citationRoots.push(next());
        break;
      case "--pin-manifest":
        options.pinManifestPath = next();
        break;
      case "--state-dir":
        options.stateDir = next();
        break;
      case "--retain-newest":
        options.retainNewest = Number(next());
        break;
      case "--ttl-days":
        options.ttlDays = Number(next());
        break;
      case "--max-dirs":
        options.maxDirs = Number(next());
        break;
      case "--max-bytes":
        options.maxBytes = Number(next());
        break;
      case "--archive-to":
        options.archiveToDir = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--apply":
        options.dryRun = false;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return options;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

async function readPinnedRunNames(
  pinManifestPath: string,
): Promise<Set<string>> {
  let contents: string;
  try {
    contents = await fs.readFile(pinManifestPath, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return new Set();
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Retention pin manifest is not valid JSON: ${pinManifestPath}`,
      {
        cause: error,
      },
    );
  }
  const references: CoworldLeagueRetentionReferences =
    parseCoworldLeagueRetentionPins(value, pinManifestPath);
  return new Set(references.publicRunKeys);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const pinnedRunNames = await readPinnedRunNames(options.pinManifestPath);
  const report = await runAiLeagueRunsRetention({
    runsRootDir: options.runsRootDir,
    citationRoots: options.citationRoots,
    citationExtensions: [...DEFAULT_CITATION_EXTENSIONS],
    pinnedRunNames,
    stateDir: options.stateDir,
    retainNewest: options.retainNewest,
    ttlDays: options.ttlDays,
    maxDirs: options.maxDirs,
    maxBytes: options.maxBytes,
    archiveToDir: options.archiveToDir,
    dryRun: options.dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.dryRun) {
    console.error(
      `[dry-run] Would ${report.mode === "archive" ? "archive" : "remove"} ` +
        `${report.plan.selectedCount} run(s) (${(
          report.plan.selectedBytes /
          1024 ** 3
        ).toFixed(
          2,
        )} GiB); ${report.plan.deferred} more eligible beyond caps. ` +
        `Re-run with --apply to act.`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
