import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { PublicAgent } from "../server/ProxyWarPublicReadModel";
import {
  publishCoworldLeagueWorldUnlocked,
  withCoworldLeagueSiteWriteLock,
  type CoworldLeagueMirrorData,
} from "../server/agents/CoworldLeagueSiteWriter";
import {
  battleFromArchivedReplaySummary,
  type WorldLedgerBattle,
} from "../server/agents/CoworldLeagueWorld";

/**
 * Backfills the `/world` battle ledger from the league mirror's durable
 * compact archive (`ereq_<id>.replay-summary.json.gz`, one per mirrored
 * battle since mid-July), then republishes `world.json`.
 *
 * Without it the world would start empty on deploy and take days of live
 * battles to fill in; with it, every front opens with the holder its real
 * history earned. Re-runnable and idempotent: battles merge by
 * `episodeRequestId`, an already-recorded winner is never rewritten, and the
 * write happens under the same site write lock the mirror publishes with, so
 * it is safe while the mirror is running.
 *
 *   npm run league:world-backfill -- \
 *     --site-dir <artifacts>/ai-league-runs/league \
 *     --archive <artifacts>/coworld-league-mirror/summaries [--dry-run]
 *
 * Defaults follow the mirror's own: `PROXYWAR_ARTIFACTS_ROOT` (else
 * `artifacts`) for the site directory and `PROXYWAR_LEAGUE_SUMMARY_ARCHIVE_DIR`
 * for the archive.
 */

interface BackfillOptions {
  siteDir: string;
  archiveDir: string;
  dryRun: boolean;
}

const SUMMARY_SUFFIX = ".replay-summary.json.gz";
const READ_CONCURRENCY = 24;

function parseArgs(argv: readonly string[]): BackfillOptions {
  const artifactsRoot = process.env.PROXYWAR_ARTIFACTS_ROOT ?? "artifacts";
  const options: BackfillOptions = {
    siteDir: path.join(artifactsRoot, "ai-league-runs", "league"),
    archiveDir:
      process.env.PROXYWAR_LEAGUE_SUMMARY_ARCHIVE_DIR ??
      path.join("artifacts", "coworld-league-mirror", "summaries"),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--site-dir") options.siteDir = next();
    else if (arg === "--archive") options.archiveDir = next();
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.siteDir = path.resolve(options.siteDir);
  options.archiveDir = path.resolve(options.archiveDir);
  return options;
}

async function readArchivedBattles(archiveDir: string): Promise<{
  battles: WorldLedgerBattle[];
  scanned: number;
  unreadable: number;
  skipped: number;
}> {
  const files = (await fs.readdir(archiveDir)).filter((name) =>
    name.endsWith(SUMMARY_SUFFIX),
  );
  const battles: WorldLedgerBattle[] = [];
  let unreadable = 0;
  let skipped = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      try {
        const raw = await fs.readFile(path.join(archiveDir, file));
        const battle = battleFromArchivedReplaySummary(
          JSON.parse(gunzipSync(raw).toString("utf8")) as unknown,
        );
        if (battle === null) skipped += 1;
        else battles.push(battle);
      } catch {
        unreadable += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker),
  );
  return { battles, scanned: files.length, unreadable, skipped };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const archived = await readArchivedBattles(options.archiveDir);
  console.log(
    `world-backfill: read ${archived.battles.length} battle(s) from ${archived.scanned} archived summaries (${archived.skipped} without a map/winner record, ${archived.unreadable} unreadable) in ${Date.now() - started} ms`,
  );
  if (options.dryRun) {
    console.log("world-backfill: dry run, nothing written");
    return;
  }
  const data = await readJson<CoworldLeagueMirrorData>(
    path.join(options.siteDir, "data.json"),
  );
  const readModel = await readJson<{ agents?: PublicAgent[] }>(
    path.join(options.siteDir, "read-model.json"),
  );
  const result = await withCoworldLeagueSiteWriteLock(options.siteDir, () =>
    publishCoworldLeagueWorldUnlocked({
      siteDir: options.siteDir,
      data,
      readModelAgents: readModel.agents ?? [],
      extraBattles: archived.battles,
    }),
  );
  if (!result.published) {
    throw new Error(
      `world ledger was not written (see the warning above): ${result.worldLedgerPath}`,
    );
  }
  console.log(
    `world-backfill: ledger +${result.battlesAdded} battle(s) → ${result.worldLedgerPath}; published ${result.worldPath}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `world-backfill failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
