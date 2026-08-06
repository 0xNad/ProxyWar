import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileFeaturedMatchStore } from "../../src/server/agents/FeaturedMatchReconcile";
import {
  readFeaturedMatchStore,
  writeFeaturedMatchStore,
  type FeaturedMatch,
  type FeaturedMatchStoreFile,
} from "../../src/server/agents/FeaturedMatch";
import {
  latestPremierePointerPath,
  writeLatestPremierePointer,
  LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
} from "../../src/server/agents/CoworldLeaguePremiereSuppression";
import { ReplayPremiereArchiveStore } from "../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { readCoworldLeagueRetentionPinManifest } from "../../src/server/agents/CoworldLeagueArtifactRetention";
import { sha256Hex } from "../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { derivePremiereId } from "../../src/server/replay-premiere/ReplayPremiereLoopCore";
import {
  buildPremiereResultSummary,
  type PremiereResultSummaryV1,
} from "../../src/server/replay-premiere/ReplayPremiereResultSummary";
import { upsertRecord } from "../../src/scripts/premiere-schedule-lib";

let featuredMatchRoot: string;
let storageStateDir: string;
let replayPremierePrivateStateRoot: string;
let artifactsRoot: string;
let pinManifestPath: string;

beforeEach(async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "featured-match-reconcile-"),
  );
  featuredMatchRoot = path.join(scratch, "featured-matches");
  storageStateDir = path.join(scratch, "storage");
  replayPremierePrivateStateRoot = path.join(scratch, "replay-premiere");
  // Isolated from the real repo's own artifacts/ and
  // deploy/coworld-league-retention-pins.json — the reconcile pass now
  // also attempts a retention-pin "extend" sync, and this test root must
  // never read or write anything under the actual checkout.
  artifactsRoot = path.join(scratch, "artifacts");
  pinManifestPath = path.join(scratch, "retention-pins.json");
  await fs.mkdir(featuredMatchRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(featuredMatchRoot), {
    recursive: true,
    force: true,
  });
});

function baseMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: overrides.matchId ?? `feat_${"a".repeat(20)}`,
    lane: "premiere",
    episodeRequestId: "ereq_reconcile_test",
    queueItemName: "item1",
    title: "Reconcile Test Match",
    description: "",
    participants: [
      { playerName: "Alpha", agentId: "agt_alpha", agentVersionId: null, builderId: null },
      { playerName: "Beta", agentId: "agt_beta", agentVersionId: null, builderId: null },
    ],
    map: "map1",
    format: "1v1",
    provenance: {
      source: "premiere-queue",
      sourceRef: "item1",
      capturedAt: "2026-07-31T00:00:00.000Z",
    },
    state: "published",
    category: null,
    scheduledAt: "2026-07-31T00:00:00.000Z",
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: null,
      decisionCount: null,
      degradedCount: null,
      seatCount: null,
      replayComplete: false,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

async function seedStore(matches: FeaturedMatch[]): Promise<void> {
  const file: FeaturedMatchStoreFile = { schemaVersion: 1, matches };
  await writeFeaturedMatchStore(featuredMatchRoot, file);
}

async function writePointer(premiereId: string, revealedAt: string): Promise<void> {
  await fs.mkdir(path.join(storageStateDir, "premiere-suppression"), {
    recursive: true,
  });
  await writeLatestPremierePointer(latestPremierePointerPath(storageStateDir), {
    schemaVersion: LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
    premiereId,
    roundNumber: 1,
    mapLabel: "map1",
    revealedAt,
  });
}

function summaryFor(
  premiereId: string,
  overrides: Partial<Parameters<typeof buildPremiereResultSummary>[0]> = {},
): PremiereResultSummaryV1 {
  return buildPremiereResultSummary({
    premiereId,
    sourceRunId: "reconcile-run-001",
    sourceKind: "rated_coworld",
    publicationCommitmentHash: sha256Hex(premiereId),
    terminalState: "revealed",
    revealedAt: "2026-07-31T00:10:00.000Z",
    reclaimedAt: "2026-07-31T00:40:00.000Z",
    outcome: {
      winner: { category: "player", groupLabel: null, seatIds: ["seat-alpha"] },
      turnCount: 100,
      completedAt: "2026-07-31T00:10:00.000Z",
      standings: [
        { seatId: "seat-alpha", displayName: "Alpha", won: true },
        { seatId: "seat-beta", displayName: "Beta", won: false },
      ],
    },
    predictions: [],
    markers: [],
    ...overrides,
  });
}

async function seedArchive(
  premiereId: string,
  summaryOverrides: Partial<Parameters<typeof buildPremiereResultSummary>[0]> = {},
): Promise<void> {
  const store = await ReplayPremiereArchiveStore.open({
    privateStateRoot: replayPremierePrivateStateRoot,
  });
  await store.recordReclaimed(
    summaryFor(premiereId, summaryOverrides),
    sha256Hex("reconcile-source-bundle"),
  );
}

const options = () => ({
  storageStateDir,
  replayPremierePrivateStateRoot,
  artifactsRoot,
  pinManifestPath,
});

describe("reconcileFeaturedMatchStore", () => {
  it("flips published -> revealed via the latest-premiere pointer (no archive entry yet, no result populated)", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "published" })]);
    await writePointer(premiereId, "2026-07-31T00:10:00.000Z");

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("revealed");
    expect(result.matches[0].result).toBeNull();
  });

  it("flips revealed -> archived and populates the winner once the archive summary exists", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "revealed" })]);
    await seedArchive(premiereId, { terminalState: "archived" });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("archived");
    expect(result.matches[0].result).toEqual({
      winnerAgentId: "agt_alpha",
      placements: [],
    });
  });

  it("flips published straight to revealed with a populated result when the archive already has a 'revealed' pointer (archive takes precedence over the pointer file)", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "published" })]);
    // A stale/irrelevant pointer for a DIFFERENT premiere — must be ignored
    // once the archive has its own definitive answer.
    await writePointer("prem_unrelated00000000000", "2026-07-31T00:10:00.000Z");
    await seedArchive(premiereId, { terminalState: "revealed" });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("revealed");
    expect(result.matches[0].result?.winnerAgentId).toBe("agt_alpha");
  });

  it("flips to cancelled when the underlying premiere's runtime terminal state is 'failed'", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "published" })]);
    await seedArchive(premiereId, {
      terminalState: "failed",
      revealedAt: null,
      outcome: null,
    });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("cancelled");
    expect(result.matches[0].result).toBeNull();
  });

  it("flips to cancelled when the runtime terminal state is 'cancelled'", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "revealed" })]);
    await seedArchive(premiereId, {
      terminalState: "cancelled",
      revealedAt: null,
      outcome: null,
    });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("cancelled");
  });

  it("a void match (winner: null) resolves to winnerAgentId: null, placements: [] — never fabricated", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "revealed" })]);
    await seedArchive(premiereId, {
      terminalState: "archived",
      outcome: {
        winner: null,
        turnCount: 50,
        completedAt: "2026-07-31T00:10:00.000Z",
        standings: [],
      },
    });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].result).toEqual({
      winnerAgentId: null,
      placements: [],
    });
  });

  it("an unresolvable winner (displayName matches no participant playerName) resolves to winnerAgentId: null rather than throwing", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "revealed" })]);
    await seedArchive(premiereId, {
      terminalState: "archived",
      outcome: {
        winner: { category: "player", groupLabel: null, seatIds: ["seat-x"] },
        turnCount: 50,
        completedAt: "2026-07-31T00:10:00.000Z",
        standings: [{ seatId: "seat-x", displayName: "SomeoneNotInRoster", won: true }],
      },
    });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].result).toEqual({
      winnerAgentId: null,
      placements: [],
    });
  });

  it("is a true no-op (no file write) when nothing changed", async () => {
    await seedStore([baseMatch({ state: "published" })]);
    // No pointer, no archive entry at all — nothing to reconcile.
    const storeFile = path.join(featuredMatchRoot, "featured-matches.json");
    const before = await fs.readFile(storeFile, "utf8");

    await reconcileFeaturedMatchStore(featuredMatchRoot, options());
    const after = await fs.readFile(storeFile, "utf8");
    expect(after).toBe(before);
  });

  it("leaves an archive-lane record untouched even if its episodeRequestId happens to derive a matching premiere id", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([
      baseMatch({
        lane: "archive",
        state: "published",
        queueItemName: null,
        scheduledAt: null,
        revealAt: null,
      }),
    ]);
    await seedArchive(premiereId, { terminalState: "archived" });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("published");
    expect(result.matches[0].result).toBeNull();
  });

  it("leaves a 'scheduled' (not yet published) record untouched even when its premiere has already revealed", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "scheduled" })]);
    await seedArchive(premiereId, { terminalState: "revealed" });

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("scheduled");
  });

  it("does not throw when the external state roots don't exist yet (cold start) — record stays unchanged", async () => {
    await seedStore([baseMatch({ state: "published" })]);
    const coldStorageDir = path.join(
      path.dirname(featuredMatchRoot),
      "never-created-storage",
    );
    const coldReplayPremiereRoot = path.join(
      path.dirname(featuredMatchRoot),
      "never-created-replay-premiere",
    );
    const result = await reconcileFeaturedMatchStore(featuredMatchRoot, {
      storageStateDir: coldStorageDir,
      replayPremierePrivateStateRoot: coldReplayPremiereRoot,
      artifactsRoot: path.join(
        path.dirname(featuredMatchRoot),
        "never-created-artifacts",
      ),
      pinManifestPath: path.join(
        path.dirname(featuredMatchRoot),
        "never-created-pins.json",
      ),
    });
    expect(result.matches[0].state).toBe("published");
  });

  it("skips a premiere-lane record whose episodeRequestId is null (pre-episode-id-tracking record) without crashing", async () => {
    await seedStore([
      baseMatch({ state: "published", episodeRequestId: null }),
    ]);
    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("published");
  });

  it("only reconciles the matching record among several, leaving unrelated ones untouched", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([
      baseMatch({ matchId: `feat_${"a".repeat(20)}`, state: "published" }),
      baseMatch({
        matchId: `feat_${"b".repeat(20)}`,
        episodeRequestId: "ereq_other_unrelated",
        state: "published",
      }),
    ]);
    await writePointer(premiereId, "2026-07-31T00:10:00.000Z");

    const result = await reconcileFeaturedMatchStore(
      featuredMatchRoot,
      options(),
    );
    expect(result.matches[0].state).toBe("revealed");
    expect(result.matches[1].state).toBe("published");
  });

  it("persists the reconciled state — a second independent read sees the flip without needing to reconcile again", async () => {
    const premiereId = derivePremiereId("ereq_reconcile_test");
    await seedStore([baseMatch({ state: "published" })]);
    await writePointer(premiereId, "2026-07-31T00:10:00.000Z");
    await reconcileFeaturedMatchStore(featuredMatchRoot, options());

    const plain = await readFeaturedMatchStore(featuredMatchRoot);
    expect(plain.matches[0].state).toBe("revealed");
  });

  it("full-replay-retention fix (2026-08-06): an ARCHIVE-lane record self-heals its missing retention pin through reconcile via the durable archive fallback — never through the state-transition machine, which stays premiere-only", async () => {
    const episodeRequestId = "ereq_archive_self_heal";
    const matchId = `feat_${"c".repeat(20)}`;
    await seedStore([
      baseMatch({
        matchId,
        lane: "archive",
        episodeRequestId,
        state: "published",
        scheduledAt: null,
        queueItemName: null,
      }),
    ]);
    // No live mirror episode at all — this record's episode has either
    // never reached the live window or has already rotated out of it;
    // reconcileFeaturedMatchStore cannot and needn't distinguish the two,
    // only the durable archive is seeded here.
    const summariesDir = path.join(
      artifactsRoot,
      "coworld-league-mirror",
      "summaries",
    );
    await fs.mkdir(summariesDir, { recursive: true });
    await fs.writeFile(
      path.join(summariesDir, `${episodeRequestId}.replay-summary.json.gz`),
      gzipSync(
        JSON.stringify({
          episodeRequestId,
          runID: "coworld-archive-self-heal",
        }),
      ),
    );

    const result = await reconcileFeaturedMatchStore(featuredMatchRoot, options());
    // Archive-lane records never transition state through this pass (the
    // refactor's premiere-only state machine is unaffected).
    expect(result.matches[0].state).toBe("published");
    expect(result.matches[0].lane).toBe("archive");

    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toContainEqual({
      episodeRequestId,
      publicRunKey: "league-coworld-archive-self-heal",
      reason: `featured-match:${matchId}`,
    });
  });

  it("full-replay-retention fix: candidate and cancelled records are excluded from pin reconciliation even with durable archive evidence available", async () => {
    const candidateEpisode = "ereq_pin_excluded_candidate";
    const cancelledEpisode = "ereq_pin_excluded_cancelled";
    await seedStore([
      baseMatch({
        matchId: `feat_${"d".repeat(20)}`,
        lane: "archive",
        episodeRequestId: candidateEpisode,
        state: "candidate",
        scheduledAt: null,
        queueItemName: null,
      }),
      baseMatch({
        matchId: `feat_${"e".repeat(20)}`,
        episodeRequestId: cancelledEpisode,
        state: "cancelled",
      }),
    ]);
    const summariesDir = path.join(
      artifactsRoot,
      "coworld-league-mirror",
      "summaries",
    );
    await fs.mkdir(summariesDir, { recursive: true });
    for (const [episodeRequestId, runID] of [
      [candidateEpisode, "coworld-excluded-candidate"],
      [cancelledEpisode, "coworld-excluded-cancelled"],
    ] as const) {
      await fs.writeFile(
        path.join(summariesDir, `${episodeRequestId}.replay-summary.json.gz`),
        gzipSync(JSON.stringify({ episodeRequestId, runID })),
      );
    }

    await reconcileFeaturedMatchStore(featuredMatchRoot, options());
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });
});

describe("reconcileFeaturedMatchStore — concurrency", () => {
  async function seedMirrorEpisode(
    episodeRequestId: string,
    publicRunKey: string,
  ): Promise<void> {
    const dir = path.join(artifactsRoot, "ai-league-runs", "league");
    await fs.mkdir(dir, { recursive: true });
    let existing: { episodes: unknown[] } = { episodes: [] };
    try {
      existing = JSON.parse(
        await fs.readFile(path.join(dir, "data.json"), "utf8"),
      ) as { episodes: unknown[] };
    } catch {
      // cold start — no existing mirror file yet
    }
    existing.episodes.push({
      episodeRequestId,
      shortId: episodeRequestId.slice(-8),
      roundNumber: 1,
      completedAt: "2026-07-17T10:00:00Z",
      map: "Pangaea",
      mapSize: "Compact",
      turnCount: 400,
      decisionCount: 10,
      degradedCount: 0,
      winnerName: "Auri",
      players: [],
      watchHref: `/ai-league-runs/${publicRunKey}/spectator.html`,
      fullRenderHref: `/ai-league-replay/${publicRunKey}`,
    });
    await fs.writeFile(
      path.join(dir, "data.json"),
      JSON.stringify(existing),
      "utf8",
    );
  }

  it("two concurrent reconcile calls against a store with multiple pending transitions produce a consistent store — no lost transitions", async () => {
    const premiereIdA = derivePremiereId("ereq_concurrent_a");
    await seedStore([
      baseMatch({
        matchId: `feat_${"a".repeat(20)}`,
        episodeRequestId: "ereq_concurrent_a",
        state: "published",
      }),
      baseMatch({
        matchId: `feat_${"b".repeat(20)}`,
        episodeRequestId: "ereq_concurrent_b",
        state: "revealed",
      }),
    ]);
    await writePointer(premiereIdA, "2026-07-31T00:10:00.000Z");
    await seedArchive(derivePremiereId("ereq_concurrent_b"), {
      terminalState: "archived",
    });

    const [resultA, resultB] = await Promise.all([
      reconcileFeaturedMatchStore(featuredMatchRoot, options()),
      reconcileFeaturedMatchStore(featuredMatchRoot, options()),
    ]);

    // Both calls must observe (eventually, once serialized) the SAME
    // fully-reconciled outcome — neither transition is lost to the other
    // call's write.
    for (const result of [resultA, resultB]) {
      const a = result.matches.find((m) => m.matchId === `feat_${"a".repeat(20)}`);
      const b = result.matches.find((m) => m.matchId === `feat_${"b".repeat(20)}`);
      expect(a?.state).toBe("revealed");
      expect(b?.state).toBe("archived");
      expect(b?.result?.winnerAgentId).toBe("agt_alpha");
    }

    const finalRead = await readFeaturedMatchStore(featuredMatchRoot);
    const finalA = finalRead.matches.find((m) => m.matchId === `feat_${"a".repeat(20)}`);
    const finalB = finalRead.matches.find((m) => m.matchId === `feat_${"b".repeat(20)}`);
    expect(finalA?.state).toBe("revealed");
    expect(finalB?.state).toBe("archived");
  });

  it("many concurrent reconcile calls against the same store never corrupt it or throw", async () => {
    const premiereId = derivePremiereId("ereq_concurrent_many");
    await seedStore([baseMatch({ episodeRequestId: "ereq_concurrent_many", state: "published" })]);
    await writePointer(premiereId, "2026-07-31T00:10:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        reconcileFeaturedMatchStore(featuredMatchRoot, options()),
      ),
    );
    for (const result of results) {
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].state).toBe("revealed");
    }
    const finalRead = await readFeaturedMatchStore(featuredMatchRoot);
    expect(finalRead.matches).toHaveLength(1);
    expect(finalRead.matches[0].state).toBe("revealed");
  });

  it("a reconcile pass with N records each needing a NEW pin performs them atomically — the manifest ends with exactly N owner entries, none lost to interleaving", async () => {
    const records = Array.from({ length: 5 }, (_, index) => {
      const episodeRequestId = `ereq_batch_pin_${index}`;
      return baseMatch({
        matchId: `feat_${String(index).padStart(20, "0")}`,
        episodeRequestId,
        state: "published",
      });
    });
    await seedStore(records);
    for (let index = 0; index < records.length; index++) {
      await seedMirrorEpisode(
        `ereq_batch_pin_${index}`,
        `league-coworld-batchpin${index}`,
      );
    }

    await reconcileFeaturedMatchStore(featuredMatchRoot, options());

    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toHaveLength(5);
    for (let index = 0; index < records.length; index++) {
      const pin = manifest.pins.find(
        (candidate) => candidate.episodeRequestId === `ereq_batch_pin_${index}`,
      );
      expect(pin).toBeDefined();
      expect(pin?.reason).toBe(`featured-match:feat_${String(index).padStart(20, "0")}`);
    }
  });

  it("a CLI-style upsertRecord (premiere-schedule-lib.ts's write path — separate-process shape) racing a server reconcile pass: final store contains BOTH effects, no silent lost update (review finding — store-layer locking)", async () => {
    const matchIdA = `feat_${"a".repeat(20)}`;
    const matchIdB = `feat_${"b".repeat(20)}`;
    const premiereIdA = derivePremiereId("ereq_cli_race_a");
    const recordB = baseMatch({
      matchId: matchIdB,
      episodeRequestId: "ereq_cli_race_b",
      state: "scheduled",
    });
    await seedStore([
      baseMatch({
        matchId: matchIdA,
        episodeRequestId: "ereq_cli_race_a",
        state: "published",
      }),
      recordB,
    ]);
    await writePointer(premiereIdA, "2026-07-31T00:10:00.000Z");

    // Two independent lock holders racing the SAME real cross-process file
    // lock (`FileMutex.ts`, keyed on `featuredMatchRoot`) — exactly the
    // shape of a `premiere:cancel` CLI invocation (a separate OS process in
    // production) racing the demo server's reconcile-on-read pass. Before
    // the fix, `upsertRecord` did its own unlocked read-modify-write:
    // whichever of these two finished last would silently overwrite the
    // OTHER'S change with its own stale pre-race snapshot of the store.
    const [reconcileResult, cliResult] = await Promise.all([
      reconcileFeaturedMatchStore(featuredMatchRoot, options()),
      upsertRecord(featuredMatchRoot, {
        ...recordB,
        state: "cancelled",
        scheduledAt: null,
        updatedAt: "2026-07-31T00:05:00.000Z",
      }),
    ]);

    // Each call's OWN return value must show the transition IT computed
    // (guaranteed regardless of which lock holder ran first or second).
    expect(
      reconcileResult.matches.find((m) => m.matchId === matchIdA)?.state,
    ).toBe("revealed");
    expect(
      cliResult.matches.find((m) => m.matchId === matchIdB)?.state,
    ).toBe("cancelled");

    // The real "no lost update" proof: a FINAL independent read after both
    // calls have completed must show BOTH effects together — whichever
    // call ran second read FRESH data (under the same lock) reflecting the
    // first call's write, rather than a stale pre-race snapshot that would
    // have silently reverted it.
    const finalRead = await readFeaturedMatchStore(featuredMatchRoot);
    const finalA = finalRead.matches.find((m) => m.matchId === matchIdA);
    const finalB = finalRead.matches.find((m) => m.matchId === matchIdB);
    expect(finalA?.state).toBe("revealed");
    expect(finalB?.state).toBe("cancelled");
  });
});
