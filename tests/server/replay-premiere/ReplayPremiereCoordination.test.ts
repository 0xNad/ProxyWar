import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  backfillReplayPremiereTerminalTombstones,
  createReplayPremiereServerStartupIdentity,
  garbageCollectReplayPremiereTerminalTombstone,
  readActiveReplayPremiereStartupSelection,
  reconcileReplayPremiereTerminalTombstones,
  shouldRetireReplayPremiereRelease,
  writeReplayPremiereStartupSelection,
} from "../../../src/server/replay-premiere/ReplayPremiereCoordination";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import { AMPLE_DISK } from "./ReplayPremiereFixtures";

const PREMIERE_ID = "prem_0123456789abcdef";
const RECORD_HASH = "a".repeat(64);

describe("Replay Premiere private coordination", () => {
  let root: string;
  let servedRoot: string;
  const stores: ReplayPremiereEventStore[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "premiere-coordination-"),
    );
    servedRoot = await fs.mkdtemp(
      path.join(
        await fs.realpath(os.tmpdir()),
        "premiere-coordination-served-",
      ),
    );
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(servedRoot, { recursive: true, force: true });
  });

  test("binds ready selection to the exact live event-store writer and startup", async () => {
    const store = await openStore();
    const server = await createReplayPremiereServerStartupIdentity({
      privateStateRoot: root,
    });
    const selected = [
      {
        premiereId: PREMIERE_ID,
        admissionRecordHash: RECORD_HASH,
        projectionState: "playing" as const,
      },
    ];
    await writeReplayPremiereStartupSelection({
      privateStateRoot: root,
      phase: "assembling",
      server,
      selected,
      registeredPremiereIds: [],
    });
    await expectOperatorCode(
      readActiveReplayPremiereStartupSelection(root),
      "coordination_selection_not_ready",
    );

    await expectOperatorCode(
      writeReplayPremiereStartupSelection({
        privateStateRoot: root,
        phase: "ready",
        server,
        selected,
        registeredPremiereIds: [],
      }),
      "coordination_registered_selection_mismatch",
    );

    const terminalReady = await writeReplayPremiereStartupSelection({
      privateStateRoot: root,
      phase: "ready",
      server,
      selected: [{ ...selected[0], projectionState: "revealed" }],
      registeredPremiereIds: [],
    });
    expect(terminalReady.registeredPremiereIds).toEqual([]);

    const ready = await writeReplayPremiereStartupSelection({
      privateStateRoot: root,
      phase: "ready",
      server,
      selected,
      registeredPremiereIds: [PREMIERE_ID],
    });
    expect(await readActiveReplayPremiereStartupSelection(root)).toEqual(ready);

    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const replacement = await openStore();
    expect(replacement).toBeDefined();
    await expectOperatorCode(
      readActiveReplayPremiereStartupSelection(root),
      "coordination_selection_stale",
    );
  });

  test("rejects malformed, over-bounded, and symlinked coordination state", async () => {
    await openStore();
    const server = await createReplayPremiereServerStartupIdentity({
      privateStateRoot: root,
    });
    await expectOperatorCode(
      writeReplayPremiereStartupSelection({
        privateStateRoot: root,
        phase: "ready",
        server,
        selected: Array.from({ length: 257 }, (_, index) => ({
          premiereId: `prem_${index.toString(16).padStart(16, "0")}`,
          admissionRecordHash: RECORD_HASH,
          projectionState: "draft" as const,
        })),
        registeredPremiereIds: [],
      }),
      "coordination_selection_contract_invalid",
    );

    const coordinationRoot = path.join(root, "coordination-v1");
    const tombstoneRoot = path.join(coordinationRoot, "terminal-tombstones");
    await fs.rm(tombstoneRoot, { recursive: true });
    const outside = path.join(root, "outside-tombstones");
    await fs.mkdir(outside);
    await fs.symlink(outside, tombstoneRoot);
    await expectOperatorCode(
      reconcileReplayPremiereTerminalTombstones({
        privateStateRoot: root,
        admissionRecords: [],
        archivePointerFor: () => null,
      }),
      "coordination_directory_invalid",
    );
  });

  test("never follows a late destination substitution to chmod an unrelated file", async () => {
    await openStore();
    const server = await createReplayPremiereServerStartupIdentity({
      privateStateRoot: root,
    });
    const outside = path.join(servedRoot, "outside.json");
    await fs.writeFile(outside, "outside\n", { mode: 0o644 });
    await fs.chmod(outside, 0o644);
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(
      async (source, destination) => {
        await realRename(source, destination);
        await fs.unlink(destination);
        await fs.symlink(outside, destination);
      },
    );

    await writeReplayPremiereStartupSelection({
      privateStateRoot: root,
      phase: "ready",
      server,
      selected: [],
      registeredPremiereIds: [],
    });

    expect((await fs.stat(outside)).mode & 0o777).toBe(0o644);
    await expect(
      readActiveReplayPremiereStartupSelection(root),
    ).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("retires every terminal admitted-or-later non-public release and no others", () => {
    for (const phase of ["admitted", "activated", "live"] as const) {
      for (const outcome of [
        "expired",
        "leak_audit_refused",
        "activation_refused",
        "activation_lost",
        "ingest_failed",
        "admit_failed",
        "projection_over_budget",
      ] as const) {
        expect(
          shouldRetireReplayPremiereRelease({
            phase,
            outcome,
            terminal: true,
          }),
        ).toBe(true);
      }
    }
    for (const candidate of [
      { phase: "claimed", outcome: "activation_lost", terminal: true },
      { phase: "live", outcome: "revealed", terminal: true },
      { phase: "live", outcome: "failed_or_cancelled", terminal: true },
      { phase: "live", outcome: "expired", terminal: false },
    ]) {
      expect(shouldRetireReplayPremiereRelease(candidate)).toBe(false);
    }
  });

  test("GC refuses a valid tombstone whose embedded identity differs from its filename and pointer", async () => {
    const tombstoneRoot = path.join(
      root,
      "coordination-v1",
      "terminal-tombstones",
    );
    await fs.mkdir(tombstoneRoot, { recursive: true });
    await fs.writeFile(
      path.join(tombstoneRoot, `${PREMIERE_ID}.terminal.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "replay_premiere_terminal_tombstone_v1",
        premiereId: "prem_fedcba9876543210",
        admissionRecordHash: RECORD_HASH,
        episodeRequestId: "ereq_00000000-0000-4000-8000-000000000001",
        roundId: "round_1",
        releasePhase: "activated",
        releaseOutcome: "activation_lost",
        releasedAt: "2026-08-22T07:00:00.000Z",
      })}\n`,
    );
    await expectOperatorCode(
      garbageCollectReplayPremiereTerminalTombstone({
        privateStateRoot: root,
        premiereId: PREMIERE_ID,
        archivePointer: {
          schemaVersion: 1,
          premiereId: PREMIERE_ID,
          sourceRunId: "source_run_1",
          sourceKind: "rated_coworld",
          terminalState: "cancelled",
          revealedAt: null,
          publicationCommitmentHash: "b".repeat(64),
          sourceReplaySha256: "c".repeat(64),
          summaryHash: "d".repeat(64),
          summaryRelPath: `summaries/${PREMIERE_ID}.summary.json`,
          reclaimedAt: "2026-08-22T07:01:00.000Z",
        },
      }),
      "coordination_tombstone_gc_identity_mismatch",
    );
    await expect(
      fs.stat(path.join(tombstoneRoot, `${PREMIERE_ID}.terminal.json`)),
    ).resolves.toBeDefined();
  });

  test("strict historical backfill rejects ambiguous release schemas and identity", async () => {
    const release = {
      kind: "hold_released",
      ts: "2026-08-22T07:00:00.000Z",
      episodeRequestId: "ereq_00000000-0000-4000-8000-000000000001",
      premiereId: PREMIERE_ID,
      roundId: "round_1",
      outcome: "activation_lost",
      terminal: true,
    };
    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstones({
        privateStateRoot: root,
        records: [{ ...release, ambiguous: true }],
      }),
      "coordination_object_keys_invalid",
    );
    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstones({
        privateStateRoot: root,
        records: [release],
      }),
      "coordination_journal_release_phase_missing",
    );
    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstones({
        privateStateRoot: root,
        records: [
          {
            kind: "hold_update",
            ts: "2026-08-22T06:59:00.000Z",
            hold: {
              episodeRequestId: release.episodeRequestId,
              premiereId: "prem_fedcba9876543210",
              roundId: release.roundId,
              phase: "activated",
            },
          },
          release,
        ],
      }),
      "coordination_journal_release_identity_mismatch",
    );
    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstones({
        privateStateRoot: root,
        records: [
          {
            kind: "hold_update",
            ts: "2026-08-22T06:59:00.000Z",
            hold: {
              episodeRequestId: release.episodeRequestId,
              premiereId: release.premiereId,
              roundId: release.roundId,
              phase: "activated",
            },
            ambiguous: true,
          },
          release,
        ],
      }),
      "coordination_object_keys_invalid",
    );
    await expectOperatorCode(
      backfillReplayPremiereTerminalTombstones({
        privateStateRoot: root,
        records: [
          {
            kind: "hold_update",
            ts: "2026-08-22T06:58:00.000Z",
            hold: {
              episodeRequestId: release.episodeRequestId,
              premiereId: release.premiereId,
              roundId: release.roundId,
              phase: "live",
            },
          },
          { ...release, outcome: "revealed" },
          release,
        ],
      }),
      "coordination_journal_release_phase_missing",
    );
  });

  async function openStore(): Promise<ReplayPremiereEventStore> {
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: root,
      servedRoots: [servedRoot],
      limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
      statfs: AMPLE_DISK,
    });
    stores.push(store);
    return store;
  }
});

async function expectOperatorCode(
  operation: Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`expected ${expected}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayPremiereError);
    expect((error as ReplayPremiereError).operatorCode).toBe(expected);
  }
}
