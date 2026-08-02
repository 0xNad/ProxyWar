import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runFeaturePromoteCli } from "../../src/scripts/feature-promote";
import {
  readFeaturedMatchStore,
  writeFeaturedMatchStore,
  type FeaturedMatch,
} from "../../src/server/agents/FeaturedMatch";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
  CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";

/**
 * `feature:promote` — the sanctioned wrapper the ARCHIVE lane never had
 * (see the CLI's own module doc for the full "activation had to hand-roll
 * mutateFeaturedMatchStore" context). Reuses `feature-candidates.test.ts`'s
 * own mirror-fixture conventions since it shares `rankFeatureCandidates`
 * directly with that sibling.
 */

let artifactsRoot: string;
let stateRoot: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  artifactsRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "feature-promote-artifacts-")),
  );
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feature-promote-state-"));
  stdout = [];
  stderr = [];
});

afterEach(async () => {
  await Promise.all([
    fs.rm(artifactsRoot, { recursive: true, force: true }),
    fs.rm(stateRoot, { recursive: true, force: true }),
  ]);
});

const io = () => ({
  stdout: (line: string) => stdout.push(line),
  stderr: (line: string) => stderr.push(line),
});

function player(overrides: Partial<CoworldLeagueEpisodePlayerRow>): CoworldLeagueEpisodePlayerRow {
  return {
    slot: 0,
    name: "player",
    tilesOwned: 0,
    isAlive: false,
    isWinner: false,
    color: "#112233",
    ...overrides,
  };
}

function episode(overrides: Partial<CoworldLeagueEpisodeRow>): CoworldLeagueEpisodeRow {
  return {
    episodeRequestId: "ereq_default",
    shortId: "DEF",
    roundNumber: 1,
    completedAt: "2026-07-20T00:00:00.000Z",
    map: "Pangaea",
    mapSize: "Normal",
    turnCount: 1000,
    decisionCount: 500,
    degradedCount: 0,
    winnerName: null,
    players: [],
    watchHref: null,
    fullRenderHref: null,
    ...overrides,
  };
}

async function writeMirrorData(episodes: CoworldLeagueEpisodeRow[]): Promise<void> {
  const siteDir = path.join(artifactsRoot, "ai-league-runs", "league");
  await fs.mkdir(siteDir, { recursive: true });
  const data: CoworldLeagueMirrorData = {
    generatedAt: "2026-07-20T00:00:00.000Z",
    lastGoodSyncAt: "2026-07-20T00:00:00.000Z",
    stale: false,
    league: {
      id: "league_test",
      name: "Test League",
      description: null,
      divisionName: "Open",
      roundIntervalMinutes: null,
      episodesPerRound: null,
      currentRoundNumber: null,
      currentRoundStatus: null,
      scoreLabel: "Score",
    },
    standings: [],
    rounds: [],
    episodes,
    links: { enterTheLeagueUrl: "https://example.test", platformLabel: "Coworld" },
  };
  await fs.writeFile(path.join(siteDir, "data.json"), JSON.stringify(data));
}

describe("feature:promote CLI", () => {
  test("rejects with no --episode", async () => {
    expect(await runFeaturePromoteCli([], io())).toBe(1);
    expect(stderr[0]).toContain("usage:");
  });

  test("errors clearly when the episode is not among ranked archive-lane candidates", async () => {
    expect(
      await runFeaturePromoteCli(
        [`--episode=ereq_nonexistent`, `--artifacts-root=${artifactsRoot}`, `--state-root=${stateRoot}`],
        io(),
      ),
    ).toBe(1);
    expect(stderr[0]).toContain('could not promote "ereq_nonexistent"');
  });

  test("promotes a ranked candidate into the FeaturedMatch store as a fresh archive-lane record", async () => {
    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_promote1",
        winnerName: "Solo",
        players: [player({ slot: 0, name: "Solo", isWinner: true, tilesOwned: 100, isAlive: true })],
      }),
    ]);
    expect(
      await runFeaturePromoteCli(
        [`--episode=ereq_promote1`, `--artifacts-root=${artifactsRoot}`, `--state-root=${stateRoot}`],
        io(),
      ),
    ).toBe(0);
    expect(stdout[0]).toContain("promoted");

    const store = await readFeaturedMatchStore(stateRoot);
    expect(store.matches).toHaveLength(1);
    expect(store.matches[0]?.lane).toBe("archive");
    expect(store.matches[0]?.episodeRequestId).toBe("ereq_promote1");
    expect(store.matches[0]?.state).toBe("published");
  });

  test("is idempotent by episodeRequestId: re-promoting reuses the SAME matchId rather than creating a duplicate", async () => {
    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_promote2",
        winnerName: "Solo",
        players: [player({ slot: 0, name: "Solo", isWinner: true, tilesOwned: 100, isAlive: true })],
      }),
    ]);
    const args = [`--episode=ereq_promote2`, `--artifacts-root=${artifactsRoot}`, `--state-root=${stateRoot}`, "--json"];

    expect(await runFeaturePromoteCli(args, io())).toBe(0);
    const first = JSON.parse(stdout[0]!).promoted;
    expect(first.matchId).toBeTruthy();

    stdout = [];
    expect(await runFeaturePromoteCli(args, io())).toBe(0);
    const second = JSON.parse(stdout[0]!);
    expect(second.wasAlreadyPromoted).toBe(true);
    expect(second.promoted.matchId).toBe(first.matchId);
    expect(second.promoted.createdAt).toBe(first.createdAt);

    const store = await readFeaturedMatchStore(stateRoot);
    expect(store.matches).toHaveLength(1);
  });

  test("never collides with an existing PREMIERE-lane record for a different episode", async () => {
    const premiereRecord: FeaturedMatch = {
      schemaVersion: 1,
      matchId: `feat_${"a".repeat(20)}`,
      lane: "premiere",
      episodeRequestId: "ereq_other_premiere",
      queueItemName: "20260801T000000Z-run1",
      title: "Sealed",
      description: "",
      participants: [],
      map: "world",
      format: "2p duel",
      provenance: { source: "premiere-queue", sourceRef: "20260801T000000Z-run1", capturedAt: "2026-08-01T00:00:00.000Z" },
      state: "candidate",
      category: null,
      scheduledAt: null,
      revealAt: null,
      evidence: {
        dramaScore: null,
        dramaGrade: null,
        entertainmentScore: null,
        storyGrade: null,
        turnCount: 9000,
        decisionCount: null,
        degradedCount: null,
        seatCount: 2,
        replayComplete: true,
        notes: [],
      },
      postMatchSummary: null,
      result: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    await writeFeaturedMatchStore(stateRoot, { schemaVersion: 1, matches: [premiereRecord] });

    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_promote3",
        winnerName: "Solo",
        players: [player({ slot: 0, name: "Solo", isWinner: true, tilesOwned: 100, isAlive: true })],
      }),
    ]);
    expect(
      await runFeaturePromoteCli(
        [`--episode=ereq_promote3`, `--artifacts-root=${artifactsRoot}`, `--state-root=${stateRoot}`],
        io(),
      ),
    ).toBe(0);

    const store = await readFeaturedMatchStore(stateRoot);
    expect(store.matches).toHaveLength(2);
    expect(store.matches.find((m) => m.matchId === premiereRecord.matchId)).toBeDefined();
    expect(store.matches.find((m) => m.episodeRequestId === "ereq_promote3")?.lane).toBe("archive");
  });
});
