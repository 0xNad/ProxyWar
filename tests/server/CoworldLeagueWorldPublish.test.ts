import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  markCoworldLeagueSiteStale,
  writeCoworldLeagueSite,
  type CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";
import { isProxyWarPublicLeagueArtifact } from "../../src/server/agents/ProxyWarPublicArtifacts";

/**
 * `/world` publication through the real league site writer: the ledger and
 * `world.json` are written beside `data.json` under the same lock, merge
 * idempotently across publishes, and a broken ledger can never fail a
 * league publish or overwrite recoverable history.
 */

function episode(
  episodeRequestId: string,
  map: string,
  winnerName: string | null,
  completedAt: string,
): CoworldLeagueMirrorData["episodes"][number] {
  return {
    episodeRequestId,
    shortId: episodeRequestId.slice(5, 13),
    roundNumber: 2352,
    completedAt,
    map,
    mapSize: "Normal",
    turnCount: 12000,
    decisionCount: 1200,
    degradedCount: 0,
    winnerName,
    players: [
      {
        slot: 1,
        name: winnerName ?? "Nobody",
        tilesOwned: 1000,
        isAlive: true,
        isWinner: winnerName !== null,
        color: "#ef4444",
      },
    ],
    watchHref: null,
    fullRenderHref: null,
  };
}

function data(
  episodes: CoworldLeagueMirrorData["episodes"],
): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-09-29T22:05:00.000Z",
    lastGoodSyncAt: "2026-09-29T22:05:00.000Z",
    stale: false,
    league: {
      id: "league_test",
      name: "Proxywar",
      description: null,
      divisionName: "Competition",
      roundIntervalMinutes: 40,
      episodesPerRound: 25,
      currentRoundNumber: 2353,
      currentRoundStatus: "pending",
      scoreLabel: "Score",
    },
    standings: [
      {
        rank: 1,
        playerName: "Matt Van",
        ratingPolicyLabel: "mattvan-bot:v16",
        activeChampionPolicyLabel: "mattvan-bot:v16",
        policyLabel: "mattvan-bot:v16",
        score: 1593.7,
        roundsPlayed: 801,
        isHouse: false,
      },
    ],
    rounds: [],
    episodes,
    links: {
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
      platformLabel: "Softmax Coworld",
    },
  };
}

describe("world map publication", () => {
  let siteDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (siteDir !== null) await rm(siteDir, { recursive: true, force: true });
    siteDir = null;
  });

  test("publishes world.json from a persisted ledger and merges later publishes idempotently", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-world-"));
    const first = data([
      episode("ereq_world0001", "Oceania", "Matt Van", "2026-09-29T20:00:00Z"),
      episode("ereq_world0002", "Pangaea", "relh", "2026-09-29T20:30:00Z"),
    ]);
    const paths = await writeCoworldLeagueSite(siteDir, first);

    const ledger = JSON.parse(await readFile(paths.worldLedgerPath, "utf8"));
    expect(
      ledger.battles.map(
        (battle: { episodeRequestId: string }) => battle.episodeRequestId,
      ),
    ).toEqual(["ereq_world0001", "ereq_world0002"]);
    const world = JSON.parse(await readFile(paths.worldPath, "utf8"));
    expect(world.schemaVersion).toBe(1);
    expect(world.battleCount).toBe(2);
    const holders = Object.fromEntries(
      world.theatres.map((theatre: { id: string; holder: string | null }) => [
        theatre.id,
        theatre.holder,
      ]),
    );
    expect(holders.oceania).toBe("Matt Van");
    expect(holders.crown).toBe("relh");
    expect(holders.asia).toBeNull();
    expect(
      world.agents.find((agent: { name: string }) => agent.name === "Matt Van"),
    ).toMatchObject({ theatres: ["oceania"] });

    // The next cycle sees one old battle again plus one new one.
    const ledgerBefore = await readFile(paths.worldLedgerPath, "utf8");
    await writeCoworldLeagueSite(
      siteDir,
      data([
        episode("ereq_world0002", "Pangaea", "relh", "2026-09-29T20:30:00Z"),
        episode("ereq_world0003", "Oceania", "Alpha", "2026-09-29T21:00:00Z"),
      ]),
    );
    const merged = JSON.parse(await readFile(paths.worldLedgerPath, "utf8"));
    expect(merged.battles).toHaveLength(3);
    expect(await readFile(paths.worldLedgerPath, "utf8")).not.toBe(
      ledgerBefore,
    );

    // A republish with nothing new leaves the ledger byte-identical.
    const ledgerAfter = await readFile(paths.worldLedgerPath, "utf8");
    await writeCoworldLeagueSite(
      siteDir,
      data([
        episode("ereq_world0003", "Oceania", "Alpha", "2026-09-29T21:00:00Z"),
      ]),
    );
    expect(await readFile(paths.worldLedgerPath, "utf8")).toBe(ledgerAfter);
  });

  test("a stale republish records no battles but marks the world feed stale", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-world-"));
    const paths = await writeCoworldLeagueSite(
      siteDir,
      data([
        episode("ereq_world0001", "Asia", "Matt Van", "2026-09-29T20:00:00Z"),
      ]),
    );
    const ledgerBefore = await readFile(paths.worldLedgerPath, "utf8");
    await markCoworldLeagueSiteStale(siteDir, "2026-09-29T23:00:00.000Z");
    expect(await readFile(paths.worldLedgerPath, "utf8")).toBe(ledgerBefore);
    const world = JSON.parse(await readFile(paths.worldPath, "utf8"));
    expect(world.feed.stale).toBe(true);
    expect(world.battleCount).toBe(1);
  });

  test("a corrupt ledger is left untouched and never fails the league publish", async () => {
    siteDir = await mkdtemp(path.join(tmpdir(), "league-world-"));
    const paths = await writeCoworldLeagueSite(
      siteDir,
      data([
        episode("ereq_world0001", "Asia", "Matt Van", "2026-09-29T20:00:00Z"),
      ]),
    );
    const worldBefore = await readFile(paths.worldPath, "utf8");
    await writeFile(paths.worldLedgerPath, "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const again = await writeCoworldLeagueSite(
      siteDir,
      data([
        episode("ereq_world0002", "Asia", "Alpha", "2026-09-29T21:00:00Z"),
      ]),
    );

    expect(await readFile(again.worldLedgerPath, "utf8")).toBe("{ not json");
    expect(await readFile(again.worldPath, "utf8")).toBe(worldBefore);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("world-ledger.json is corrupt"),
      ),
    ).toBe(true);
    // The rest of the league still published.
    expect(
      JSON.parse(await readFile(again.dataPath, "utf8")).episodes[0]
        .episodeRequestId,
    ).toBe("ereq_world0002");
  });

  test("world.json is a public league artifact; the ledger is not", () => {
    expect(isProxyWarPublicLeagueArtifact("world.json")).toBe(true);
    expect(isProxyWarPublicLeagueArtifact("world-ledger.json")).toBe(false);
  });
});
