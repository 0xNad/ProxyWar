import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  rankPremiereCandidates,
  resolveDefaultArtifactsRoot,
  resolveDefaultQueueReadyDir,
} from "../../src/scripts/premiere-candidates";

interface MetaJsonFixture {
  schemaVersion: number;
  kind: string;
  runId: string;
  sourceFile: string;
  sha256: string;
  turnCount: number;
  seatCount: number;
  map: string;
  checkpointTurns: number[];
  turnIntervalMs: number;
  coworldId: string;
  variantId: string;
  episodeId: string | null;
  experienceRequestId: string | null;
  generatedAt: string;
}

function sampleMeta(overrides: Partial<MetaJsonFixture> = {}): MetaJsonFixture {
  return {
    schemaVersion: 1,
    kind: "real-league",
    runId: "run_abc123",
    sourceFile: "bundle.source.json",
    sha256: "a".repeat(64),
    turnCount: 420,
    seatCount: 8,
    map: "pangaea",
    checkpointTurns: [140, 280],
    turnIntervalMs: 250,
    coworldId: "coworld_1",
    variantId: "variant_1",
    episodeId: "ep_1",
    experienceRequestId: "ereq_1",
    generatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

async function writeQueueItem(
  queueReadyDir: string,
  itemName: string,
  meta: MetaJsonFixture | string,
): Promise<void> {
  const itemDir = path.join(queueReadyDir, itemName);
  await mkdir(itemDir, { recursive: true });
  const contents =
    typeof meta === "string" ? meta : JSON.stringify(meta, null, 2);
  await writeFile(path.join(itemDir, "meta.json"), contents, "utf8");
  await writeFile(
    path.join(itemDir, "bundle.source.json"),
    JSON.stringify({ schemaVersion: 1 }),
    "utf8",
  );
}

async function writePublishedEpisodes(
  artifactsRoot: string,
  episodeRequestIds: string[],
): Promise<void> {
  const siteDir = path.join(artifactsRoot, "ai-league-runs", "league");
  await mkdir(siteDir, { recursive: true });
  await writeFile(
    path.join(siteDir, "data.json"),
    JSON.stringify({
      generatedAt: "2026-07-01T00:00:00.000Z",
      lastGoodSyncAt: "2026-07-01T00:00:00.000Z",
      stale: false,
      league: { id: "league_1" },
      standings: [],
      rounds: [],
      episodes: episodeRequestIds.map((episodeRequestId, index) => ({
        episodeRequestId,
        shortId: `ep${index}`,
        roundNumber: index,
        completedAt: "2026-06-30T00:00:00.000Z",
        map: "pangaea",
        mapSize: "Normal",
        turnCount: 500,
        decisionCount: 500,
        degradedCount: 0,
        winnerName: "someone",
        players: [],
        watchHref: null,
        fullRenderHref: null,
      })),
      links: { enterTheLeagueUrl: "https://example.com", platformLabel: "x" },
    }),
    "utf8",
  );
}

describe("premiere:candidates", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function setupFixture(): Promise<{
    root: string;
    queueReadyDir: string;
    artifactsRoot: string;
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "premiere-candidates-"));
    tmpDirs.push(root);
    const queueReadyDir = path.join(root, "queue", "ready");
    const artifactsRoot = path.join(root, "artifacts");
    await mkdir(queueReadyDir, { recursive: true });
    return { root, queueReadyDir, artifactsRoot };
  }

  test("a published league round in the queue is rejected with a named reason", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(
      queueReadyDir,
      "20260701T000000Z-run-published",
      sampleMeta({
        experienceRequestId: "ereq_published_1",
        episodeId: "ep_published_1",
      }),
    );
    await writeQueueItem(
      queueReadyDir,
      "20260701T000100Z-run-clean",
      sampleMeta({
        experienceRequestId: "ereq_clean_1",
        episodeId: "ep_clean_1",
      }),
    );
    await writePublishedEpisodes(artifactsRoot, ["ereq_published_1"]);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });

    expect(result.candidates.map((c) => c.queueItemName)).toEqual([
      "20260701T000100Z-run-clean",
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.queueItemName).toBe(
      "20260701T000000Z-run-published",
    );
    expect(result.rejected[0]!.reason).toBe(
      "already_published_on_league: episode ereq_published_1 appears in the live league mirror",
    );
  });

  test("falls back to episodeId for the named-rejection cross-reference when experienceRequestId is absent", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(
      queueReadyDir,
      "20260701T000000Z-run-exhibition",
      sampleMeta({ experienceRequestId: null, episodeId: "ep_only_id" }),
    );
    await writePublishedEpisodes(artifactsRoot, ["ep_only_id"]);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe(
      "already_published_on_league: episode ep_only_id appears in the live league mirror",
    );
  });

  test("a severely degraded (implausibly short) match never ranks above a clean one, even though it is older", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(
      queueReadyDir,
      "20260701T000000Z-run-short",
      sampleMeta({ turnCount: 9, seatCount: 8 }),
    );
    await writeQueueItem(
      queueReadyDir,
      "20260701T000100Z-run-healthy",
      sampleMeta({ turnCount: 600, seatCount: 8 }),
    );
    await writePublishedEpisodes(artifactsRoot, []);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });

    expect(result.candidates.map((c) => c.queueItemName)).toEqual([
      "20260701T000100Z-run-healthy",
      "20260701T000000Z-run-short",
    ]);
    expect(result.candidates[0]!.severelyDegraded).toBe(false);
    expect(result.candidates[1]!.severelyDegraded).toBe(true);
    expect(result.candidates[1]!.degradedReasons[0]).toContain("turnCount (9)");
  });

  test("a match with fewer than two seats is severely degraded and never ranks first", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(
      queueReadyDir,
      "20260701T000000Z-run-oneseat",
      sampleMeta({ turnCount: 900, seatCount: 1 }),
    );
    await writeQueueItem(
      queueReadyDir,
      "20260701T000100Z-run-healthy",
      sampleMeta({ turnCount: 300, seatCount: 4 }),
    );
    await writePublishedEpisodes(artifactsRoot, []);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });

    expect(result.candidates.map((c) => c.queueItemName)).toEqual([
      "20260701T000100Z-run-healthy",
      "20260701T000000Z-run-oneseat",
    ]);
  });

  test("never fabricates drama/story/decision evidence for this lane — always null with an honest note", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(queueReadyDir, "20260701T000000Z-run-1", sampleMeta());
    await writePublishedEpisodes(artifactsRoot, []);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });

    const evidence = result.candidates[0]!.featuredMatch.evidence;
    expect(evidence.dramaScore).toBeNull();
    expect(evidence.dramaGrade).toBeNull();
    expect(evidence.entertainmentScore).toBeNull();
    expect(evidence.storyGrade).toBeNull();
    expect(evidence.decisionCount).toBeNull();
    expect(evidence.degradedCount).toBeNull();
    expect(evidence.turnCount).toBe(420);
    expect(evidence.seatCount).toBe(8);
    expect(
      evidence.notes.some((note) =>
        note.includes("unavailable for the premiere-queue lane"),
      ),
    ).toBe(true);
  });

  test("builds a valid premiere-lane FeaturedMatch draft with no result and a matching provenance ref", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(
      queueReadyDir,
      "20260701T000000Z-run-1",
      sampleMeta({ experienceRequestId: "ereq_9", episodeId: "ep_9" }),
    );
    await writePublishedEpisodes(artifactsRoot, []);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });
    const match = result.candidates[0]!.featuredMatch;

    expect(match.lane).toBe("premiere");
    expect(match.state).toBe("candidate");
    expect(match.queueItemName).toBe("20260701T000000Z-run-1");
    expect(match.episodeRequestId).toBe("ereq_9");
    expect(match.provenance.source).toBe("premiere-queue");
    expect(match.provenance.sourceRef).toBe("20260701T000000Z-run-1");
    expect(match.result).toBeNull();
  });

  test("a queue item with unreadable meta.json is reported rejected, not silently dropped", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(
      queueReadyDir,
      "20260701T000000Z-run-bad",
      "{ not json",
    );
    await writePublishedEpisodes(artifactsRoot, []);

    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("meta_json_unreadable");
  });

  test("an empty or missing ready directory yields no candidates and no rejections, not a crash", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    const result = await rankPremiereCandidates({
      queueReadyDir: path.join(queueReadyDir, "does-not-exist"),
      artifactsRoot,
    });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  test("a missing or malformed league data.json is treated as no published episodes rather than throwing", async () => {
    const { queueReadyDir, artifactsRoot } = await setupFixture();
    await writeQueueItem(queueReadyDir, "20260701T000000Z-run-1", sampleMeta());
    // artifactsRoot/ai-league-runs/league/data.json intentionally not written.
    const result = await rankPremiereCandidates({
      queueReadyDir,
      artifactsRoot,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("resolveDefaultQueueReadyDir honors PROXYWAR_PREMIERE_QUEUE_DIR and falls back to the documented default", () => {
    expect(resolveDefaultQueueReadyDir({}, "/home/op")).toBe(
      path.join("/home/op", ".proxywar-deploy", "premiere-queue", "ready"),
    );
    expect(
      resolveDefaultQueueReadyDir(
        { PROXYWAR_PREMIERE_QUEUE_DIR: "/custom/queue" },
        "/home/op",
      ),
    ).toBe(path.join("/custom/queue", "ready"));
  });

  test("resolveDefaultArtifactsRoot honors PROXYWAR_ARTIFACTS_ROOT and falls back to cwd/artifacts", () => {
    expect(resolveDefaultArtifactsRoot({}, "/repo")).toBe(
      path.join("/repo", "artifacts"),
    );
    expect(
      resolveDefaultArtifactsRoot(
        { PROXYWAR_ARTIFACTS_ROOT: "/custom/artifacts" },
        "/repo",
      ),
    ).toBe(path.resolve("/custom/artifacts"));
  });
});
