import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runFeatureCandidatesCli } from "../../src/scripts/feature-candidates";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "../../src/server/agents/AgentMatchRecap";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
  CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";

let artifactsRoot: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  artifactsRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "feature-candidates-cli-")),
  );
  stdout = [];
  stderr = [];
});

afterEach(async () => {
  await fs.rm(artifactsRoot, { recursive: true, force: true });
});

const io = () => ({
  stdout: (line: string) => stdout.push(line),
  stderr: (line: string) => stderr.push(line),
});

function player(
  overrides: Partial<CoworldLeagueEpisodePlayerRow>,
): CoworldLeagueEpisodePlayerRow {
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

function episode(
  overrides: Partial<CoworldLeagueEpisodeRow>,
): CoworldLeagueEpisodeRow {
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

async function writeMirrorData(
  episodes: CoworldLeagueEpisodeRow[],
): Promise<void> {
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
    links: {
      enterTheLeagueUrl: "https://example.test",
      platformLabel: "Coworld",
    },
  };
  await fs.writeFile(path.join(siteDir, "data.json"), JSON.stringify(data));
}

async function writeRunArtifact(
  runKey: string,
  fileName: string,
  content: unknown,
): Promise<void> {
  const runDir = path.join(artifactsRoot, "ai-league-runs", runKey);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, fileName), JSON.stringify(content));
}

describe("feature:candidates CLI", () => {
  test("rejects an unknown argument", async () => {
    expect(await runFeatureCandidatesCli(["--bogus"], io())).toBe(1);
    expect(stderr).toEqual([
      "feature_candidates_cli_unknown_argument: --bogus",
    ]);
  });

  test("emits an empty table when the mirror has never synced (no data.json)", async () => {
    expect(
      await runFeatureCandidatesCli(
        [`--artifacts-root=${artifactsRoot}`],
        io(),
      ),
    ).toBe(0);
    expect(stdout).toEqual([
      "feature:candidates — no completed, published league episodes found.",
    ]);
  });

  test("filters out episodes that never completed", async () => {
    await writeMirrorData([
      episode({ episodeRequestId: "ereq_incomplete", completedAt: null }),
    ]);
    expect(
      await runFeatureCandidatesCli(
        [`--artifacts-root=${artifactsRoot}`, "--json"],
        io(),
      ),
    ).toBe(0);
    const output = JSON.parse(stdout.join("\n")) as {
      candidates: unknown[];
      totalEpisodes: number;
    };
    expect(output.totalEpisodes).toBe(0);
    expect(output.candidates).toEqual([]);
  });

  test(
    "ranks an evidence-backed high-drama match above an undifferentiated match with no artifacts, " +
      "and never ranks a severely degraded match first even with the highest raw score",
    async () => {
      // A: clean, real drama-report.json + match-story.json on disk.
      await writeRunArtifact("league-coworld-epa", "drama-report.json", {
        dramaScore: 90,
        dramaGrade: "dramatic",
      });
      await writeRunArtifact("league-coworld-epa", "match-story.json", {
        entertainmentScore: 80,
        grade: "lively",
      });
      // B: clean, no artifact files at all (undifferentiated).
      // C: severely degraded (300/400 = 75% >> 15% threshold) but claims the
      // single highest raw drama score of the three — must still rank last.
      await writeRunArtifact("league-coworld-epc", "drama-report.json", {
        dramaScore: 99,
        dramaGrade: "dramatic",
      });

      await writeMirrorData([
        episode({
          episodeRequestId: "ereq_a",
          map: "Pangaea",
          turnCount: 4000,
          decisionCount: 500,
          degradedCount: 2,
          winnerName: "Alpha",
          watchHref: "/ai-league-runs/league-coworld-epa/spectator.html",
          fullRenderHref: "/ai-league-replay/league-coworld-epa",
          players: [
            player({
              slot: 0,
              name: "Alpha",
              tilesOwned: 900,
              isAlive: true,
              isWinner: true,
            }),
            player({ slot: 1, name: "Bravo", tilesOwned: 100, isAlive: false }),
          ],
        }),
        episode({
          episodeRequestId: "ereq_b",
          map: "Europe",
          turnCount: 3500,
          decisionCount: 480,
          degradedCount: 5,
          winnerName: "Charlie",
          watchHref: "/ai-league-runs/league-coworld-epb/spectator.html",
          fullRenderHref: "/ai-league-replay/league-coworld-epb",
          players: [
            player({
              slot: 0,
              name: "Charlie",
              tilesOwned: 800,
              isAlive: true,
              isWinner: true,
            }),
            player({ slot: 1, name: "Delta", tilesOwned: 200, isAlive: false }),
          ],
        }),
        episode({
          episodeRequestId: "ereq_c",
          map: "Asia",
          turnCount: 4200,
          decisionCount: 400,
          degradedCount: 300,
          winnerName: "Echo",
          watchHref: "/ai-league-runs/league-coworld-epc/spectator.html",
          fullRenderHref: "/ai-league-replay/league-coworld-epc",
          players: [
            player({
              slot: 0,
              name: "Echo",
              tilesOwned: 600,
              isAlive: true,
              isWinner: true,
            }),
            player({
              slot: 1,
              name: "Foxtrot",
              tilesOwned: 400,
              isAlive: false,
            }),
          ],
        }),
      ]);

      expect(
        await runFeatureCandidatesCli(
          [`--artifacts-root=${artifactsRoot}`, "--json"],
          io(),
        ),
      ).toBe(0);
      const output = JSON.parse(stdout.join("\n")) as {
        candidates: Array<{
          rank: number;
          compositeScore: number | null;
          severelyDegraded: boolean;
          dramaArtifactFound: boolean;
          matchStoryArtifactFound: boolean;
          match: {
            episodeRequestId: string | null;
            evidence: {
              dramaScore: number | null;
              entertainmentScore: number | null;
              notes: string[];
            };
          };
        }>;
      };
      const ranked = output.candidates.map((c) => c.match.episodeRequestId);

      // Acceptance: evidence-backed high-drama (A) beats undifferentiated (B),
      // and the severely-degraded highest-raw-score candidate (C) is last.
      expect(ranked).toEqual(["ereq_a", "ereq_b", "ereq_c"]);

      const a = output.candidates[0]!;
      const b = output.candidates[1]!;
      const c = output.candidates[2]!;

      expect(a.rank).toBe(1);
      expect(a.severelyDegraded).toBe(false);
      expect(a.compositeScore).toBe(85); // (90 + 80) / 2
      expect(a.dramaArtifactFound).toBe(true);
      expect(a.matchStoryArtifactFound).toBe(true);
      expect(a.match.evidence.dramaScore).toBe(90);
      expect(a.match.evidence.entertainmentScore).toBe(80);

      expect(b.rank).toBe(2);
      expect(b.severelyDegraded).toBe(false);
      expect(b.compositeScore).toBeNull();

      expect(c.rank).toBe(3);
      expect(c.severelyDegraded).toBe(true);
      expect(c.compositeScore).toBe(99); // raw score is the highest of all three
    },
  );

  test("is honest about missing evidence: never fabricates a score, and says why in notes", async () => {
    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_no_artifacts",
        watchHref: "/ai-league-runs/league-coworld-noart/spectator.html",
        fullRenderHref: "/ai-league-replay/league-coworld-noart",
        players: [
          player({
            slot: 0,
            name: "Solo",
            isWinner: true,
            tilesOwned: 500,
            isAlive: true,
          }),
        ],
      }),
    ]);
    // Deliberately no drama-report.json / match-story.json written for this run key.

    expect(
      await runFeatureCandidatesCli(
        [`--artifacts-root=${artifactsRoot}`, "--json"],
        io(),
      ),
    ).toBe(0);
    const output = JSON.parse(stdout.join("\n")) as {
      candidates: Array<{
        dramaArtifactFound: boolean;
        matchStoryArtifactFound: boolean;
        match: {
          evidence: {
            dramaScore: number | null;
            dramaGrade: string | null;
            entertainmentScore: number | null;
            storyGrade: string | null;
            notes: string[];
          };
        };
      }>;
    };
    const evidence = output.candidates[0]!.match.evidence;

    expect(output.candidates[0]!.dramaArtifactFound).toBe(false);
    expect(output.candidates[0]!.matchStoryArtifactFound).toBe(false);
    // Never a fabricated zero — genuinely null.
    expect(evidence.dramaScore).toBeNull();
    expect(evidence.dramaGrade).toBeNull();
    expect(evidence.entertainmentScore).toBeNull();
    expect(evidence.storyGrade).toBeNull();
    expect(
      evidence.notes.some((note) =>
        note.includes("drama-report.json not found"),
      ),
    ).toBe(true);
    expect(
      evidence.notes.some((note) =>
        note.includes("match-story.json not found"),
      ),
    ).toBe(true);
  });

  test("prefers match-recap.json's curated drama score over drama-report.json's legacy composite, and falls back honestly with the distinction visible when no recap exists", async () => {
    // A: both drama-report.json (legacy, high raw score) AND a CURRENT
    // match-recap.json (curated, lower deduped score) -- curated wins.
    await writeRunArtifact("league-coworld-both", "drama-report.json", {
      dramaScore: 97,
      dramaGrade: "dramatic",
    });
    await writeRunArtifact("league-coworld-both", "match-recap.json", {
      schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
      runID: "league-coworld-both",
      generatedAt: "2026-08-01T00:00:00.000Z",
      summary: "This match featured 1 alliance.",
      beats: [{ turnNumber: 5, kind: "alliance", message: "x and y form an alliance." }],
      curatedDramaScore: 22,
      curatedDramaScoreMethodology: "betrayal beats x20 ...",
    });
    // B: ONLY drama-report.json (legacy) -- honest fallback, distinction visible.
    await writeRunArtifact("league-coworld-legacy-only", "drama-report.json", {
      dramaScore: 55,
      dramaGrade: "lively",
    });
    // C: a STALE (pre-fix schema) match-recap.json alongside drama-report.json
    // -- treated exactly like "no recap", never trusted at a stale formula.
    await writeRunArtifact("league-coworld-stale-recap", "drama-report.json", {
      dramaScore: 61,
      dramaGrade: "lively",
    });
    await writeRunArtifact("league-coworld-stale-recap", "match-recap.json", {
      schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION - 1,
      runID: "league-coworld-stale-recap",
      generatedAt: "2026-01-01T00:00:00.000Z",
      summary: "stale pre-fix summary",
      beats: [{ turnNumber: 1, kind: "alliance", message: "stale" }],
    });

    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_both",
        watchHref: "/ai-league-runs/league-coworld-both/spectator.html",
        fullRenderHref: "/ai-league-replay/league-coworld-both",
        players: [player({ slot: 0, name: "Solo", isWinner: true, isAlive: true })],
      }),
      episode({
        episodeRequestId: "ereq_legacy_only",
        watchHref: "/ai-league-runs/league-coworld-legacy-only/spectator.html",
        fullRenderHref: "/ai-league-replay/league-coworld-legacy-only",
        players: [player({ slot: 0, name: "Solo", isWinner: true, isAlive: true })],
      }),
      episode({
        episodeRequestId: "ereq_stale_recap",
        watchHref: "/ai-league-runs/league-coworld-stale-recap/spectator.html",
        fullRenderHref: "/ai-league-replay/league-coworld-stale-recap",
        players: [player({ slot: 0, name: "Solo", isWinner: true, isAlive: true })],
      }),
    ]);

    expect(
      await runFeatureCandidatesCli(
        [`--artifacts-root=${artifactsRoot}`, "--json"],
        io(),
      ),
    ).toBe(0);
    const output = JSON.parse(stdout.join("\n")) as {
      candidates: Array<{
        dramaScoreSource: "curated" | "legacy" | null;
        match: {
          episodeRequestId: string | null;
          evidence: { dramaScore: number | null; dramaGrade: string | null; notes: string[] };
        };
      }>;
    };
    const byId = new Map(
      output.candidates.map((c) => [c.match.episodeRequestId, c]),
    );

    const both = byId.get("ereq_both")!;
    expect(both.dramaScoreSource).toBe("curated");
    expect(both.match.evidence.dramaScore).toBe(22); // curated, NOT the legacy 97
    expect(
      both.match.evidence.notes.some((note) =>
        note.includes("CURATED") && note.includes("match-recap.json"),
      ),
    ).toBe(true);

    const legacyOnly = byId.get("ereq_legacy_only")!;
    expect(legacyOnly.dramaScoreSource).toBe("legacy");
    expect(legacyOnly.match.evidence.dramaScore).toBe(55);
    expect(
      legacyOnly.match.evidence.notes.some((note) =>
        note.includes("LEGACY") && note.includes("curated score is unavailable"),
      ),
    ).toBe(true);

    const staleRecap = byId.get("ereq_stale_recap")!;
    // A pre-fix-schema recap must never be trusted as curated -- honest
    // fallback to legacy, same as no recap existing at all.
    expect(staleRecap.dramaScoreSource).toBe("legacy");
    expect(staleRecap.match.evidence.dramaScore).toBe(61);
  });

  test("never populates queueItemName/scheduledAt/revealAt for an archive-lane record", async () => {
    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_schema_check",
        players: [
          player({
            slot: 0,
            name: "Solo",
            isWinner: true,
            tilesOwned: 100,
            isAlive: true,
          }),
        ],
      }),
    ]);
    expect(
      await runFeatureCandidatesCli(
        [`--artifacts-root=${artifactsRoot}`, "--json"],
        io(),
      ),
    ).toBe(0);
    const output = JSON.parse(stdout.join("\n")) as {
      candidates: Array<{ match: Record<string, unknown> }>;
    };
    const match = output.candidates[0]!.match;
    expect(match.lane).toBe("archive");
    expect(match.state).toBe("published");
    expect(match.queueItemName).toBeNull();
    expect(match.scheduledAt).toBeNull();
    expect(match.revealAt).toBeNull();
    expect(match.episodeRequestId).toBe("ereq_schema_check");
  });

  test("--table is the default output and prints a header row", async () => {
    await writeMirrorData([
      episode({
        episodeRequestId: "ereq_table",
        players: [
          player({
            slot: 0,
            name: "Solo",
            isWinner: true,
            tilesOwned: 100,
            isAlive: true,
          }),
        ],
      }),
    ]);
    expect(
      await runFeatureCandidatesCli(
        [`--artifacts-root=${artifactsRoot}`],
        io(),
      ),
    ).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("rank");
    expect(stdout[0]).toContain("episodeRequestId");
    expect(stdout[0]).toContain("ereq_table");
  });
});
