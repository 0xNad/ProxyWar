/**
 * Builds a `CoworldLeagueEpisodeRow` JSON file from a completed local match
 * run directory (as produced by `ai-agent-league-smoke.ts`) — the bridge
 * between a REAL, engine-produced match (real alliance/first-strike/
 * betrayal/elimination events live in that run's own `decisions.jsonl`/
 * `drama-report.json`) and `proxywar-fixture-league-data.ts`'s
 * `--drama-episode-file=` input. Reads real data only; never invents an
 * event the match didn't actually produce.
 *
 * Usage:
 *   tsx src/scripts/proxywar-fixture-episode-from-run.ts \
 *     --run-dir=<path> --run-id=<id> --out=<episode-row.json path>
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CoworldLeagueEpisodeRow } from "../server/agents/CoworldLeagueSiteWriter";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const runDir = argValue("run-dir");
  const runID = argValue("run-id");
  const out = argValue("out");
  if (runDir === undefined || runID === undefined || out === undefined) {
    throw new Error("--run-dir=, --run-id=, and --out= are all required");
  }

  const gameRecord = JSON.parse(
    await fs.readFile(path.join(runDir, "game-record.json"), "utf8"),
  ) as {
    info: { num_turns: number; end?: string | null };
  };
  const matchSummary = JSON.parse(
    await fs.readFile(path.join(runDir, "match-summary.json"), "utf8"),
  ) as { decisionCount: number; fallbackCount: number; completedAt: string };
  const dramaReport = JSON.parse(
    await fs.readFile(path.join(runDir, "drama-report.json"), "utf8"),
  ) as {
    agents: Array<{
      username: string;
      finalTilesOwned: number;
      isAlive: boolean;
    }>;
  };

  const palette = [
    "#e06666",
    "#6fa8dc",
    "#93c47d",
    "#f6b26b",
    "#8e7cc3",
    "#76a5af",
    "#c27ba0",
    "#a4c2f4",
    "#ffd966",
    "#b6d7a8",
  ];
  const ranked = [...dramaReport.agents].sort(
    (a, b) => b.finalTilesOwned - a.finalTilesOwned,
  );
  const winner = ranked[0];

  const episode: CoworldLeagueEpisodeRow = {
    episodeRequestId: `ereq_${runID}`,
    shortId: runID.replace(/[^a-z0-9]/gi, "").slice(0, 16),
    roundNumber: 500,
    completedAt: matchSummary.completedAt,
    map: "Asia",
    mapSize: "Compact",
    turnCount: gameRecord.info.num_turns,
    decisionCount: matchSummary.decisionCount,
    degradedCount: matchSummary.fallbackCount,
    winnerName: winner?.username ?? null,
    players: dramaReport.agents.map((agent, index) => ({
      slot: index,
      name: agent.username,
      tilesOwned: agent.finalTilesOwned,
      isAlive: agent.isAlive,
      isWinner: agent.username === winner?.username,
      color: palette[index % palette.length],
    })),
    watchHref: `/ai-league-replay/${runID}`,
    fullRenderHref: `/ai-league-replay/${runID}`,
  };

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(episode, null, 2));
  console.log(`fixture drama episode row written: ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
