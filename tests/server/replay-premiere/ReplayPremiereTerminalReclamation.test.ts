import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { encodePremiereAuthoritativeResult } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { ReplayPremiereHttpTarget } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { replayPremiereInteractionAggregateId } from "../../../src/server/replay-premiere/ReplayPremiereInteractionRecovery";
import { reclaimUnreferencedPremiereSources } from "../../../src/server/replay-premiere/ReplayPremiereJournalCompaction";
import {
  loadReplayPremiereReclamationExclusions,
  ReplayPremiereTerminalReclaimer,
} from "../../../src/server/replay-premiere/ReplayPremiereTerminalReclamation";
import {
  authoritativeResultBytes,
  eligibilityFixture,
  seatFixtures,
} from "./ReplayPremiereFixtures";

const PREMIERE_ID = "prem_reclaimtarget001";
const SOURCE_SHA = sha256Hex("source-bundle");
const COMMITMENT = sha256Hex("commitment");
const REVEALED_AT = "2026-07-20T18:00:00.000Z";
const GRACE_MS = 30 * 60 * 1000;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-reclaim-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function target(premiereId = PREMIERE_ID): ReplayPremiereHttpTarget {
  return {
    runtime: {
      premiereId,
      readLifecycleState: () => "revealed",
      readBootstrap: () => ({
        premiereId,
        publicationCommitmentHash: COMMITMENT,
        provenance: {
          sourceKind: "controlled_exhibition",
          sourceRunId: "controlled-run-001",
          sourceReplaySha256: SOURCE_SHA,
          seats: seatFixtures(),
        },
      }),
      readReveal: () => ({
        premiereId,
        revealedAt: REVEALED_AT,
        eligibilityRecord: eligibilityFixture(),
        authoritativeResult: encodePremiereAuthoritativeResult(
          authoritativeResultBytes(),
        ),
      }),
    },
    interactions: {
      readCheckpoints: () => [],
      readState: () => ({ reactions: [] }),
    },
  } as unknown as ReplayPremiereHttpTarget;
}

const admissionPath = (premiereId: string): string =>
  path.join(root, "catalog-v1", "entries", `${premiereId}.admission.json`);
const sourcePath = (): string =>
  path.join(
    root,
    "sources",
    "sha256",
    SOURCE_SHA.slice(0, 2),
    `${SOURCE_SHA}.replay`,
  );
const runtimeSnapshotPath = (premiereId: string): string =>
  path.join(root, "event-store-v1", "snapshots", `${premiereId}.snapshot.json`);
const interactionSnapshotPath = (premiereId: string): string =>
  path.join(
    root,
    "event-store-v1",
    "snapshots",
    `${replayPremiereInteractionAggregateId(premiereId)}.snapshot.json`,
  );

async function writeBulk(premiereId = PREMIERE_ID): Promise<void> {
  await fs.mkdir(path.dirname(admissionPath(premiereId)), { recursive: true });
  await fs.writeFile(
    admissionPath(premiereId),
    JSON.stringify({
      premiereId,
      stagedSource: { sourceReplaySha256: SOURCE_SHA },
    }),
  );
  await fs.mkdir(path.dirname(sourcePath()), { recursive: true });
  await fs.writeFile(sourcePath(), "private replay bytes");
  await fs.mkdir(path.dirname(runtimeSnapshotPath(premiereId)), {
    recursive: true,
  });
  await fs.writeFile(runtimeSnapshotPath(premiereId), "{}");
  await fs.writeFile(interactionSnapshotPath(premiereId), "{}");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function reclaimerWith(nowIso: string): Promise<{
  reclaimer: ReplayPremiereTerminalReclaimer;
  store: ReplayPremiereArchiveStore;
}> {
  const store = await ReplayPremiereArchiveStore.open({
    privateStateRoot: root,
  });
  return {
    store,
    reclaimer: new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date(nowIso),
    }),
  };
}

describe("ReplayPremiereTerminalReclaimer", () => {
  it("waits out the grace window before touching anything", async () => {
    await writeBulk();
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:10:00.000Z", // 10 minutes after reveal < 30 min grace
    );
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(false);
    expect(result.reason).toBe("within_grace");
    expect(store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(sourcePath())).toBe(true);
  });

  it("never reclaims an excluded premiere, even past grace", async () => {
    await writeBulk();
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:45:00.000Z"), // well past grace
      excludedPremiereIds: [PREMIERE_ID],
    });
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(false);
    expect(result.reason).toBe("excluded");
    // Nothing was touched: no pointer, and every bulk artifact is intact so the
    // premiere stays fully served.
    expect(store.lookup(PREMIERE_ID)).toBeNull();
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);
    expect(await exists(sourcePath())).toBe(true);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(true);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(true);
  });

  it("writes the summary + pointer, then deletes the bulk, keeping the summary", async () => {
    await writeBulk();
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z", // 45 minutes after reveal > grace
    );
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(result.reason).toBe("reclaimed");

    // Durable summary + pointer were committed BEFORE deletion.
    expect(store.lookup(PREMIERE_ID)).not.toBeNull();
    const summary = await store.loadSummary(PREMIERE_ID);
    expect(summary?.terminalState).toBe("revealed");
    expect(
      await exists(
        path.join(
          root,
          "archive-v1",
          "summaries",
          `${PREMIERE_ID}.summary.json`,
        ),
      ),
    ).toBe(true);

    // Per-premiere-private bulk is gone: admission + both snapshots. The SHARED,
    // content-addressed source survives the concurrent live sweep and is
    // reclaimed only at startup (no live writer) — see the startup-GC test below.
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await exists(sourcePath())).toBe(true);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(false);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(false);
  });

  it("defers shared-source deletion to the startup GC (unreferenced only)", async () => {
    await writeBulk();
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    await reclaimer.reclaimIfEligible(target());
    // The live sweep never deletes the shared source.
    expect(await exists(sourcePath())).toBe(true);

    // Startup GC keeps a source a surviving admission still references...
    const kept = await reclaimUnreferencedPremiereSources({
      privateStateRoot: root,
      reclaimedSources: store.reclaimedSources(),
      presentSourceShas: [SOURCE_SHA],
    });
    expect(kept.removed).toEqual([]);
    expect(await exists(sourcePath())).toBe(true);

    // ...and deletes it once no admission references it.
    const removed = await reclaimUnreferencedPremiereSources({
      privateStateRoot: root,
      reclaimedSources: store.reclaimedSources(),
      presentSourceShas: [],
    });
    expect(removed.removed).toEqual([SOURCE_SHA]);
    expect(await exists(sourcePath())).toBe(false);
  });

  it("is idempotent and finishes deletion after a crash between pointer and delete", async () => {
    await writeBulk();
    const { store } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    // Simulate a crash right after the pointer was committed but before the bulk
    // was deleted: the pointer exists, the admission is still on disk.
    const summary = (
      await import("../../../src/server/replay-premiere/ReplayPremiereResultSummary")
    ).buildPremiereResultSummaryFromTarget({
      target: target(),
      terminalState: "revealed",
      reclaimedAt: "2026-07-20T18:45:00.000Z",
    });
    await store.recordReclaimed(summary, SOURCE_SHA);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(true);

    // A restart re-assembles the (still-admitted) premiere; the sweep re-runs.
    const reopened = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store: reopened,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:46:00.000Z"),
    });
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(result.reason).toBe("already_reclaimed");
    // Deletion completed on the retry; the summary is preserved throughout.
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await reopened.loadSummary(PREMIERE_ID)).toEqual(summary);
  });
});

describe("durable archived-clip promotion", () => {
  const archivedClipPath = (premiereId: string): string =>
    path.join(root, "archive-v1", "clips", `${premiereId}.mp4`);
  const archivedClipManifestPath = (premiereId: string): string =>
    path.join(
      root,
      "archive-v1",
      "clips",
      `${premiereId}.render-manifest.json`,
    );

  async function writeCachedClip(
    premiereId: string,
    bucket: number,
    anchorTurn: number,
    bytes: Buffer,
  ): Promise<void> {
    const dir = path.join(root, "clips-v1", premiereId);
    await fs.mkdir(dir, { recursive: true });
    const clipPath = path.join(dir, `clip-v1-${bucket}.mp4`);
    await fs.writeFile(clipPath, bytes);
    await fs.writeFile(
      path.join(dir, `clip-v1-${bucket}.render-manifest.json`),
      JSON.stringify({
        premiereId,
        sourceReplaySha256: SOURCE_SHA,
        anchorTurn,
        clipVersion: 1,
        frameShape: "square",
        frameWidth: 1080,
        frameHeight: 1080,
        outSha256: sha256Hex(bytes),
        outBytes: bytes.length,
        generatedAt: "2026-07-20T18:00:01.000Z",
      }),
    );
  }

  it("promotes the highest-anchor cached clip into archive-v1/clips before deleting bulk", async () => {
    await writeBulk();
    const early = Buffer.alloc(90, 1);
    const late = Buffer.alloc(120, 2);
    await writeCachedClip(PREMIERE_ID, 3, 35, early);
    await writeCachedClip(PREMIERE_ID, 61, 615, late);
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(store.lookup(PREMIERE_ID)).not.toBeNull();

    // The durable clip is the reveal-payoff (highest anchor) render, with its
    // provenance sidecar, and the per-premiere bulk is still deleted.
    expect(await fs.readFile(archivedClipPath(PREMIERE_ID))).toEqual(late);
    expect(await exists(archivedClipManifestPath(PREMIERE_ID))).toBe(true);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
  });

  it("reclaims normally when the premiere has no cached clip", async () => {
    await writeBulk();
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(false);
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
  });

  it("never promotes a clip for a premiere that was not reveal-public", async () => {
    const failedId = "prem_failednoclip0001";
    await writeBulk(failedId);
    // Even a (hand-planted) cache entry must not surface for a failed
    // premiere: the durable clip is reveal-public-only, exactly like the
    // summary outcome.
    await writeCachedClip(failedId, 61, 615, Buffer.alloc(64, 3));
    const failedTarget = {
      runtime: {
        premiereId: failedId,
        readLifecycleState: () => "failed",
        readBootstrap: () => ({
          premiereId: failedId,
          publicationCommitmentHash: COMMITMENT,
          provenance: {
            sourceKind: "controlled_exhibition",
            sourceRunId: "controlled-run-002",
            sourceReplaySha256: SOURCE_SHA,
            seats: seatFixtures(),
          },
        }),
        readReveal: () => null,
      },
      interactions: {
        readCheckpoints: () => [],
        readState: () => ({ reactions: [] }),
      },
    } as unknown as ReplayPremiereHttpTarget;
    const { reclaimer, store } = await reclaimerWith(
      "2026-07-20T18:45:00.000Z",
    );
    const result = await reclaimer.reclaimIfEligible(failedTarget);
    expect(result.reclaimed).toBe(true);
    expect(store.lookup(failedId)?.terminalState).toBe("failed");
    expect(await exists(archivedClipPath(failedId))).toBe(false);
    expect(await exists(archivedClipManifestPath(failedId))).toBe(false);
  });

  it("adopts the first durable clip verbatim on the already-reclaimed retry", async () => {
    await writeBulk();
    const original = Buffer.alloc(80, 4);
    await writeCachedClip(PREMIERE_ID, 61, 615, original);
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    await reclaimer.reclaimIfEligible(target());
    expect(await fs.readFile(archivedClipPath(PREMIERE_ID))).toEqual(original);

    // A different cache clip appearing later must never replace the durable
    // artifact (first write wins, matching summary adoption semantics).
    await writeCachedClip(PREMIERE_ID, 70, 705, Buffer.alloc(70, 5));
    const again = await reclaimer.reclaimIfEligible(target());
    expect(again.reason).toBe("already_reclaimed");
    expect(await fs.readFile(archivedClipPath(PREMIERE_ID))).toEqual(original);
  });

  it("ignores cache artifacts whose sidecar is missing, foreign, or size-mismatched", async () => {
    await writeBulk();
    const dir = path.join(root, "clips-v1", PREMIERE_ID);
    await fs.mkdir(dir, { recursive: true });
    // No sidecar at all.
    await fs.writeFile(path.join(dir, "clip-v1-10.mp4"), Buffer.alloc(10, 6));
    // Sidecar bytes disagree with the file (torn write).
    const torn = Buffer.alloc(50, 7);
    await writeCachedClip(PREMIERE_ID, 20, 205, torn);
    await fs.writeFile(path.join(dir, "clip-v1-20.mp4"), Buffer.alloc(49, 7));
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    const result = await reclaimer.reclaimIfEligible(target());
    expect(result.reclaimed).toBe(true);
    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(false);
  });

  it("bounds durable clip storage by count with oldest-first eviction", async () => {
    const ids = [
      "prem_retention0000001",
      "prem_retention0000002",
      "prem_retention0000003",
    ] as const;
    const store = await ReplayPremiereArchiveStore.open({
      privateStateRoot: root,
    });
    const reclaimer = new ReplayPremiereTerminalReclaimer({
      privateStateRoot: root,
      store,
      graceMs: GRACE_MS,
      now: () => new Date("2026-07-20T18:45:00.000Z"),
      maxArchivedClips: 2,
    });
    for (const [index, premiereId] of ids.entries()) {
      await writeCachedClip(premiereId, 61, 615, Buffer.alloc(30 + index, 9));
      await reclaimer.reclaimIfEligible(target(premiereId));
      // Backdate so eviction ordering is deterministic even within one tick.
      const when = new Date(
        Date.parse("2026-07-01T00:00:00Z") + index * 60_000,
      );
      await fs.utimes(archivedClipPath(premiereId), when, when);
    }
    expect(await exists(archivedClipPath(ids[0]))).toBe(false);
    expect(await exists(archivedClipManifestPath(ids[0]))).toBe(false);
    expect(await exists(archivedClipPath(ids[1]))).toBe(true);
    expect(await exists(archivedClipPath(ids[2]))).toBe(true);
  });
});

describe("loadReplayPremiereReclamationExclusions", () => {
  it("merges the env var and the pin file, dropping malformed ids", async () => {
    await fs.writeFile(
      path.join(root, "reclaim-exclude.txt"),
      "# release-proof premieres\nprem_excludepin000001\n\nnot-a-premiere\n",
    );
    const excluded = await loadReplayPremiereReclamationExclusions({
      privateStateRoot: root,
      env: {
        PROXYWAR_PREMIERE_RECLAIM_EXCLUDE:
          "prem_excludeenv000001, prem_excludeenv000002 ,garbage",
      },
    });
    expect(excluded).toEqual(
      [
        "prem_excludeenv000001",
        "prem_excludeenv000002",
        "prem_excludepin000001",
      ].sort(),
    );
  });

  it("returns an empty set with no env and no pin file", async () => {
    expect(
      await loadReplayPremiereReclamationExclusions({
        privateStateRoot: root,
        env: {},
      }),
    ).toEqual([]);
  });
});
