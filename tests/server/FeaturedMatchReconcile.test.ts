import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { sha256Hex } from "../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { derivePremiereId } from "../../src/server/replay-premiere/ReplayPremiereLoopCore";
import {
  buildPremiereResultSummary,
  type PremiereResultSummaryV1,
} from "../../src/server/replay-premiere/ReplayPremiereResultSummary";

let featuredMatchRoot: string;
let storageStateDir: string;
let replayPremierePrivateStateRoot: string;

beforeEach(async () => {
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "featured-match-reconcile-"),
  );
  featuredMatchRoot = path.join(scratch, "featured-matches");
  storageStateDir = path.join(scratch, "storage");
  replayPremierePrivateStateRoot = path.join(scratch, "replay-premiere");
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
});
