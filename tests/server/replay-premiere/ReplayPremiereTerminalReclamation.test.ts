import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { encodePremiereAuthoritativeResult } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { ReplayPremiereHttpTarget } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { replayPremiereInteractionAggregateId } from "../../../src/server/replay-premiere/ReplayPremiereInteractionRecovery";
import { ReplayPremiereTerminalReclaimer } from "../../../src/server/replay-premiere/ReplayPremiereTerminalReclamation";
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

    // Bulk is gone: admission, staged source, both snapshots.
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await exists(sourcePath())).toBe(false);
    expect(await exists(runtimeSnapshotPath(PREMIERE_ID))).toBe(false);
    expect(await exists(interactionSnapshotPath(PREMIERE_ID))).toBe(false);
  });

  it("keeps a staged source that another live admission still references", async () => {
    await writeBulk();
    // A second, still-live premiere shares the same content-addressed source.
    const other = "prem_reclaimtargetsib1";
    await fs.writeFile(
      admissionPath(other),
      JSON.stringify({
        premiereId: other,
        stagedSource: { sourceReplaySha256: SOURCE_SHA },
      }),
    );
    const { reclaimer } = await reclaimerWith("2026-07-20T18:45:00.000Z");
    await reclaimer.reclaimIfEligible(target());
    // Our admission is gone, but the shared source survives for the sibling.
    expect(await exists(admissionPath(PREMIERE_ID))).toBe(false);
    expect(await exists(sourcePath())).toBe(true);
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
    await store.recordReclaimed(summary);
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
