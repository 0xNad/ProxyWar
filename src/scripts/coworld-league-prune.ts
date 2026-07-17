import { promises as fs } from "node:fs";
import path from "node:path";
import {
  pruneCoworldLeagueMirrorArtifacts,
  readCoworldLeagueRetentionPins,
  requireSafeCoworldLeagueRetentionLayout,
  retentionReferencesFromEpisodes,
} from "../server/agents/CoworldLeagueArtifactRetention";
import { withCoworldLeagueMirrorOperationLock } from "../server/agents/CoworldLeagueMirrorOperationLock";
import type { CoworldLeagueMirrorData } from "../server/agents/CoworldLeagueSiteWriter";

interface PruneOptions {
  siteDir: string;
  cacheDir: string;
  runsRootDir: string;
  summaryArchiveDir: string;
  retentionPinManifestPath: string;
  maxRetainedCacheFiles: number;
  maxRetainedRunDirectories: number;
  dryRun: boolean;
}

function parseOptions(argv: string[]): PruneOptions {
  const options: PruneOptions = {
    siteDir: path.join("artifacts", "ai-league-runs", "league"),
    cacheDir: path.join("artifacts", "coworld-league-mirror", "replays"),
    runsRootDir: path.join("artifacts", "ai-league-runs"),
    summaryArchiveDir:
      process.env.PROXYWAR_LEAGUE_SUMMARY_ARCHIVE_DIR ??
      path.join("artifacts", "coworld-league-mirror", "summaries"),
    retentionPinManifestPath:
      process.env.PROXYWAR_LEAGUE_RETENTION_PINS ??
      path.join("deploy", "coworld-league-retention-pins.json"),
    maxRetainedCacheFiles: Number(
      process.env.PROXYWAR_LEAGUE_RETAIN_RAW_REPLAYS ?? "24",
    ),
    maxRetainedRunDirectories: Number(
      process.env.PROXYWAR_LEAGUE_RETAIN_RUN_BUNDLES ?? "96",
    ),
    dryRun: true,
  };
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
      case "--site-dir":
        options.siteDir = next();
        break;
      case "--cache-dir":
        options.cacheDir = next();
        break;
      case "--runs-root":
        options.runsRootDir = next();
        break;
      case "--summary-archive":
        options.summaryArchiveDir = next();
        break;
      case "--pin-manifest":
        options.retentionPinManifestPath = next();
        break;
      case "--retain-raw":
        options.maxRetainedCacheFiles = Number(next());
        break;
      case "--retain-bundles":
        options.maxRetainedRunDirectories = Number(next());
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
  if (
    !Number.isInteger(options.maxRetainedCacheFiles) ||
    options.maxRetainedCacheFiles < 1
  ) {
    throw new Error("--retain-raw must be a positive integer");
  }
  if (
    !Number.isInteger(options.maxRetainedRunDirectories) ||
    options.maxRetainedRunDirectories < 1
  ) {
    throw new Error("--retain-bundles must be a positive integer");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  requireSafeCoworldLeagueRetentionLayout(
    options.siteDir,
    options.runsRootDir,
    options.cacheDir,
    options.summaryArchiveDir,
  );
  const report = await withCoworldLeagueMirrorOperationLock(
    options.siteDir,
    async () => {
      const data = JSON.parse(
        await fs.readFile(path.join(options.siteDir, "data.json"), "utf8"),
      ) as CoworldLeagueMirrorData;
      if (!Array.isArray(data.episodes)) {
        throw new Error("Coworld league data.json has no episode list");
      }
      const publishedReferences = retentionReferencesFromEpisodes(
        data.episodes,
      );
      const pinnedReferences = await readCoworldLeagueRetentionPins(
        options.retentionPinManifestPath,
      );
      const result = await pruneCoworldLeagueMirrorArtifacts({
        cacheDir: options.cacheDir,
        runsRootDir: options.runsRootDir,
        summaryArchiveDir: options.summaryArchiveDir,
        protectedEpisodeRequestIds: new Set([
          ...publishedReferences.episodeRequestIds,
          ...pinnedReferences.episodeRequestIds,
        ]),
        protectedPublicRunKeys: new Set([
          ...publishedReferences.publicRunKeys,
          ...pinnedReferences.publicRunKeys,
        ]),
        maxRetainedCacheFiles: options.maxRetainedCacheFiles,
        maxRetainedRunDirectories: options.maxRetainedRunDirectories,
        dryRun: options.dryRun,
      });
      return {
        dryRun: options.dryRun,
        protectedEpisodes: new Set([
          ...publishedReferences.episodeRequestIds,
          ...pinnedReferences.episodeRequestIds,
        ]).size,
        protectedRuns: new Set([
          ...publishedReferences.publicRunKeys,
          ...pinnedReferences.publicRunKeys,
        ]).size,
        ...result,
      };
    },
  );
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
