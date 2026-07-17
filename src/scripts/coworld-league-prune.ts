import { promises as fs } from "node:fs";
import path from "node:path";
import {
  pruneCoworldLeagueMirrorArtifacts,
  requireSafeCoworldLeagueRetentionLayout,
  retentionReferencesFromEpisodes,
} from "../server/agents/CoworldLeagueArtifactRetention";
import { withCoworldLeagueMirrorOperationLock } from "../server/agents/CoworldLeagueMirrorOperationLock";
import type { CoworldLeagueMirrorData } from "../server/agents/CoworldLeagueSiteWriter";

interface PruneOptions {
  siteDir: string;
  cacheDir: string;
  runsRootDir: string;
  maxRetainedArtifacts: number;
  minimumRetentionAgeMs: number;
  dryRun: boolean;
}

function parseOptions(argv: string[]): PruneOptions {
  const options: PruneOptions = {
    siteDir: path.join("artifacts", "ai-league-runs", "league"),
    cacheDir: path.join("artifacts", "coworld-league-mirror", "replays"),
    runsRootDir: path.join("artifacts", "ai-league-runs"),
    maxRetainedArtifacts: Number(
      process.env.PROXYWAR_LEAGUE_RETAIN_REPLAYS ?? "48",
    ),
    minimumRetentionAgeMs:
      Number(process.env.PROXYWAR_LEAGUE_RETAIN_HOURS ?? "6") * 60 * 60 * 1000,
    dryRun: false,
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
      case "--retain-replays":
        options.maxRetainedArtifacts = Number(next());
        break;
      case "--retain-hours":
        options.minimumRetentionAgeMs = Number(next()) * 60 * 60 * 1000;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (
    !Number.isInteger(options.maxRetainedArtifacts) ||
    options.maxRetainedArtifacts < 1
  ) {
    throw new Error("--retain-replays must be a positive integer");
  }
  if (
    !Number.isFinite(options.minimumRetentionAgeMs) ||
    options.minimumRetentionAgeMs < 0
  ) {
    throw new Error("--retain-hours must be a non-negative number");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  requireSafeCoworldLeagueRetentionLayout(options.siteDir, options.runsRootDir);
  const report = await withCoworldLeagueMirrorOperationLock(
    options.siteDir,
    async () => {
      const data = JSON.parse(
        await fs.readFile(path.join(options.siteDir, "data.json"), "utf8"),
      ) as CoworldLeagueMirrorData;
      if (!Array.isArray(data.episodes)) {
        throw new Error("Coworld league data.json has no episode list");
      }
      const references = retentionReferencesFromEpisodes(data.episodes);
      const result = await pruneCoworldLeagueMirrorArtifacts({
        cacheDir: options.cacheDir,
        runsRootDir: options.runsRootDir,
        protectedEpisodeRequestIds: references.episodeRequestIds,
        protectedPublicRunKeys: references.publicRunKeys,
        maxRetainedArtifacts: options.maxRetainedArtifacts,
        minimumRetentionAgeMs: options.minimumRetentionAgeMs,
        dryRun: options.dryRun,
      });
      return {
        dryRun: options.dryRun,
        protectedEpisodes: references.episodeRequestIds.size,
        protectedRuns: references.publicRunKeys.size,
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
