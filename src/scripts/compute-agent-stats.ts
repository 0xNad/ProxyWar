import fs from "node:fs/promises";
import path from "node:path";
import {
  aggregateAgentStats,
  computeMatchAgentMetrics,
  type RawMatchAgentMetrics,
} from "../server/agents/AgentStatsPipeline";
import {
  type AgentStatsArtifact,
  type PlayerAgentStats,
} from "../server/agents/AgentStatsArtifact";
import { getMapLandTilesBySize } from "../server/agents/MapLandTilesBySize";
import { loadIdentityRegistrySnapshot } from "../server/identity/IdentityRegistry";
import type { SpectatorTelemetry } from "../server/agents/AgentSpectatorTelemetry";

/**
 * Product overhaul spec Stage 6: computes strategic fingerprint + social
 * record stats for every agent across every RETAINED run directory (full
 * `spectator-telemetry.json`, not the slim public mirror `data.json` —
 * career/multi-episode aggregation needs per-episode event data the mirror
 * deliberately never carries). Writes the cached `AgentStatsArtifact` (see
 * `AgentStatsArtifact.ts`) both `ProxyWarPublicReadModel.ts` (bulk
 * `/agent/:slug` view) and `LeaguePlayerProfile.ts` (`/api/players/:name`)
 * read from — "one computation source, two views, never divergent
 * numbers" (spec item 6) is enforced by construction: both consumers
 * parse the SAME file, neither recomputes.
 *
 * Run as a periodic batch job (same operational shape as
 * `coworld-league-mirror.ts`'s sync loop) — this is deliberately NOT a
 * per-request computation; scanning every retained run's telemetry is too
 * expensive to redo per HTTP request.
 */

interface RunDirEntry {
  runDir: string;
  telemetry: SpectatorTelemetry;
  map: string;
  mapSize: string;
  completedAt: string | null;
  /** Per-agentID decision reliability for this episode; empty when `decisions.jsonl` wasn't retained for it (older/foreign runs) — never fabricated. */
  decisionReliability: ReadonlyMap<
    string,
    { decisionCount: number; fallbackCount: number }
  >;
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reliability's real per-seat denominator (spec Stage 6 item 2's fifth
 * fingerprint dimension). `decisions.jsonl` is JSONL (one decision record
 * per line), NOT a JSON array — this is the only reader in this file
 * that isn't a single `JSON.parse`. Malformed/unparseable lines are
 * skipped individually rather than discarding the whole episode's
 * reliability data over one bad line.
 */
async function readDecisionReliability(
  runDir: string,
): Promise<ReadonlyMap<string, { decisionCount: number; fallbackCount: number }>> {
  const counts = new Map<string, { decisionCount: number; fallbackCount: number }>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(runDir, "decisions.jsonl"), "utf8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record) || typeof record.agentID !== "string") continue;
    const entry = counts.get(record.agentID) ?? {
      decisionCount: 0,
      fallbackCount: 0,
    };
    entry.decisionCount += 1;
    if (record.fallbackUsed === true) entry.fallbackCount += 1;
    counts.set(record.agentID, entry);
  }
  return counts;
}

async function scanRetainedRuns(runsRootDir: string): Promise<RunDirEntry[]> {
  const entries: RunDirEntry[] = [];
  let dirNames: string[];
  try {
    dirNames = (await fs.readdir(runsRootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "league")
      .map((entry) => entry.name);
  } catch {
    return entries;
  }
  for (const name of dirNames) {
    const runDir = path.join(runsRootDir, name);
    const telemetryRaw = await readJsonIfExists(
      path.join(runDir, "spectator-telemetry.json"),
    );
    if (!isRecord(telemetryRaw) || !Array.isArray(telemetryRaw.agents)) {
      continue;
    }
    const summaryRaw = await readJsonIfExists(
      path.join(runDir, "match-summary.json"),
    );
    const runnerConfig =
      isRecord(summaryRaw) && isRecord(summaryRaw.runnerConfig)
        ? summaryRaw.runnerConfig
        : {};
    const map = typeof runnerConfig.map === "string" ? runnerConfig.map : "";
    const mapSize =
      typeof runnerConfig.mapSize === "string" ? runnerConfig.mapSize : "Normal";
    const completedAt =
      isRecord(summaryRaw) && typeof summaryRaw.completedAt === "string"
        ? summaryRaw.completedAt
        : null;
    const decisionReliability = await readDecisionReliability(runDir);
    entries.push({
      runDir,
      telemetry: telemetryRaw as unknown as SpectatorTelemetry,
      map,
      mapSize,
      completedAt,
      decisionReliability,
    });
  }
  return entries;
}

interface AttributedMatch {
  playerName: string;
  completedAt: string | null;
  raw: RawMatchAgentMetrics;
}

async function collectRawMatchesByPlayer(
  runs: readonly RunDirEntry[],
): Promise<Map<string, AttributedMatch[]>> {
  const byPlayer = new Map<string, AttributedMatch[]>();
  const landTileCache = new Map<string, number | null>();
  for (const run of runs) {
    const cacheKey = `${run.map}|${run.mapSize}`;
    let landTiles = landTileCache.get(cacheKey);
    if (landTiles === undefined) {
      landTiles =
        run.map.length > 0
          ? await getMapLandTilesBySize(run.map, run.mapSize)
          : null;
      landTileCache.set(cacheKey, landTiles);
    }
    for (const agent of run.telemetry.agents) {
      const raw = computeMatchAgentMetrics(
        run.telemetry,
        agent.agentID,
        landTiles,
        run.decisionReliability,
      );
      if (raw === null) continue;
      const list = byPlayer.get(agent.username) ?? [];
      list.push({ playerName: agent.username, completedAt: run.completedAt, raw });
      byPlayer.set(agent.username, list);
    }
  }
  return byPlayer;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runsRootDirIndex = args.indexOf("--runs-root");
  const runsRootDir =
    runsRootDirIndex >= 0
      ? args[runsRootDirIndex + 1]
      : path.resolve(process.cwd(), "artifacts/ai-league-runs");
  const outPathIndex = args.indexOf("--out");
  const outPath =
    outPathIndex >= 0
      ? args[outPathIndex + 1]
      : path.join(runsRootDir, "league", "agent-stats.json");

  const [runs, identity] = await Promise.all([
    scanRetainedRuns(runsRootDir),
    loadIdentityRegistrySnapshot().catch(() => null),
  ]);
  const byPlayer = await collectRawMatchesByPlayer(runs);

  // Current-version boundary per playerName, from the identity registry —
  // see PlayerAgentStats.currentVersion's own doc. `releaseDate` (a
  // builder's own disclosure) is authoritative when present;
  // `firstObservedAt` (the mirror's own observation — see
  // sync-version-registry.ts) is the honest fallback. Before
  // sync-version-registry.ts existed, `releaseDate` was the ONLY source
  // and stayed null for every real agent (no builder had disclosed one
  // yet), so currentVersion was permanently null for everyone — this
  // fallback is what actually unblocks the split for the common case.
  const currentVersionByPlayerName = new Map<
    string,
    { boundary: string; versionLabel: string }
  >();
  if (identity !== null) {
    for (const agentProfile of identity.agents) {
      const versionsForAgent = identity.versions
        .filter(
          (v) =>
            v.agentId === agentProfile.id &&
            (v.releaseDate !== null || v.firstObservedAt !== null),
        )
        .map((v) => ({
          boundary: (v.releaseDate ?? v.firstObservedAt) as string,
          versionLabel: v.publicVersionLabel,
        }))
        .sort((a, b) => b.boundary.localeCompare(a.boundary));
      const newest = versionsForAgent[0];
      if (newest !== undefined) {
        currentVersionByPlayerName.set(
          agentProfile.policyMatchRule.playerName,
          newest,
        );
      }
    }
  }

  const players: PlayerAgentStats[] = [];
  for (const [playerName, matches] of byPlayer) {
    const career = aggregateAgentStats(matches.map((m) => m.raw));
    const versionInfo = currentVersionByPlayerName.get(playerName);
    let currentVersion: PlayerAgentStats["currentVersion"] = null;
    if (versionInfo !== undefined) {
      const qualifying = matches.filter(
        (m) => m.completedAt !== null && m.completedAt >= versionInfo.boundary,
      );
      if (qualifying.length > 0) {
        currentVersion = {
          ...aggregateAgentStats(qualifying.map((m) => m.raw)),
          versionLabel: versionInfo.versionLabel,
        };
      }
    }
    players.push({ playerName, career, currentVersion });
  }
  players.sort((a, b) => a.playerName.localeCompare(b.playerName));

  const artifact: AgentStatsArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    episodesScanned: runs.length,
    players,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `agent-stats: scanned ${runs.length} retained run(s), computed stats for ${players.length} player(s) -> ${outPath}`,
  );
}

void main();
