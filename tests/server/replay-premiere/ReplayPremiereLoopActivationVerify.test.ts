import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  activateHold,
  assertForeignPremiereGateUnchanged,
  compactJournalIfNeeded,
  createJournalWriter,
  foreignRegisteredPremiereGate,
  persistRetainedAdmissionTransaction,
  progressHold,
  runLoopReplayPremiereAdmission,
  trackHold,
  type IngestMaterials,
  type JournalWriter,
  type LoopConfig,
  type RetainedAdmissionTransaction,
} from "../../../src/scripts/replay-premiere-loop";
import type { ReplayPremiereAdmissionRecordV1 } from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
import type { ReplayPremiereStartupSelectionReceiptV1 } from "../../../src/server/replay-premiere/ReplayPremiereCoordination";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import {
  PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
  PREMIERE_LOOP_ACTIVATION_VERIFY_MS,
  PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS,
  PREMIERE_LOOP_HOLD_WINDOW_MS,
  PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS,
  derivePremiereId,
  foldLoopJournal,
  holdExpiresAtForScheduled,
  type LoopHoldState,
  type LoopJournalRecord,
  type LoopReleaseOutcome,
  type LoopRoundRef,
  type LoopSkipReason,
} from "../../../src/server/replay-premiere/ReplayPremiereLoopCore";

/**
 * The activation-zombie fix (2026-07-22, round 644 / prem_105c…): a controlled
 * restart that exits 0 only proves a fresh server process accepted traffic.
 * New admissions now carry the precomputed projection artifact, but a legacy
 * artifact or another startup refusal can still leave `/premiere/<id>` 404.
 * These tests drive the real `trackHold` with a
 * stubbed loopback origin and an injected restart to prove:
 *   - a registered premiere behaves exactly as before (no restart calls);
 *   - an unregistered activated premiere waits only a bounded window;
 *   - then re-activates exactly once;
 *   - then releases terminally as `activation_lost` (fail-open, journaled)
 *     instead of zombie-tracking to holdExpiresAt.
 */

const NOW = new Date("2026-07-22T12:00:30.000Z");
const execFileAsync = promisify(execFile);

let stateDir: string;

interface JournalCapture {
  writer: JournalWriter;
  holdUpdates: LoopHoldState[];
  released: {
    hold: LoopHoldState;
    outcome: LoopReleaseOutcome;
    terminal: boolean;
  }[];
}

function captureJournal(): JournalCapture {
  const holdUpdates: LoopHoldState[] = [];
  const released: JournalCapture["released"] = [];
  const writer: JournalWriter = {
    async appendHoldUpdate(hold: LoopHoldState) {
      holdUpdates.push(hold);
    },
    async appendHoldReleased(
      hold: LoopHoldState,
      outcome: LoopReleaseOutcome,
      terminal: boolean,
    ) {
      released.push({ hold, outcome, terminal });
    },
    async appendRoundSkipped(_ref: LoopRoundRef, _reason: LoopSkipReason) {},
    async appendDecision(_decision: Record<string, unknown>) {},
  };
  return { writer, holdUpdates, released };
}

function config(): LoopConfig {
  return {
    loopbackBaseUrl: "http://127.0.0.1:9",
    contractPath: path.join(stateDir, "premiere-suppression", "contract.json"),
    pinManifestPath: path.join(stateDir, "retention-pins.json"),
    loopStateDir: stateDir,
    journalPath: path.join(stateDir, "journal.jsonl"),
    decisionsPath: path.join(stateDir, "decisions.jsonl"),
    ingestScratchDir: path.join(stateDir, "ingest-scratch"),
    nonceDir: path.join(stateDir, "admit-nonce"),
    privateStateRoot: path.join(stateDir, "private"),
    servedRoots: [path.join(stateDir, "served")],
    deploymentOrigin: "https://beta.proxywar.xyz",
    minimumFreeBytes: 0,
  } as unknown as LoopConfig;
}

function hold(overrides: Partial<LoopHoldState> = {}): LoopHoldState {
  const scheduledAt = "2026-07-22T12:06:00.000Z";
  return {
    episodeRequestId: "ereq_00000000-0000-0000-0000-000000000644",
    premiereId: derivePremiereId("ereq_00000000-0000-0000-0000-000000000644"),
    roundId: "round_644",
    roundNumber: 644,
    scheduledAt,
    holdExpiresAt: holdExpiresAtForScheduled(scheduledAt),
    premierePageLive: false,
    mapLabel: "World",
    publicRunKey: "league-coworld-2026-07-22T09-02-14-282Z-46b0441a",
    replayUrl: "https://example.invalid/r.replay",
    variantName: "Tournament 12P - World",
    seatCount: 12,
    turnCount: 20600,
    playbackRate: 2,
    phase: "activated",
    activationAttempts: 0,
    activationBackoffUntil: null,
    activatedAt: NOW.toISOString(),
    reactivationAttempts: 0,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("foreign registered Premiere claim exclusion", () => {
  test("404 blocks without exact archive proof and clears only with it", async () => {
    const receipt = selectionReceipt();
    const readSelection = vi.fn(async () => receipt);
    await expect(
      foreignRegisteredPremiereGate(config(), {
        readSelection,
        readState: async () => null,
        readArchivePointer: async () => null,
      }),
    ).rejects.toThrow("absent without archive proof");

    const clear = await foreignRegisteredPremiereGate(config(), {
      readSelection,
      readState: async () => null,
      readAdmission: async () => null,
      readArchivePointer: async ({ premiereId }) => ({
        schemaVersion: 1,
        premiereId,
        sourceRunId: "source_run_1",
        sourceKind: "rated_coworld",
        terminalState: "cancelled",
        revealedAt: null,
        publicationCommitmentHash: "b".repeat(64),
        sourceReplaySha256: "c".repeat(64),
        summaryHash: "d".repeat(64),
        summaryRelPath: `summaries/${premiereId}.summary.json`,
        reclaimedAt: "2026-08-22T07:01:00.000Z",
      }),
    });
    expect(clear.busyPremiereIds).toEqual([]);
  });

  test("404 archive proof must bind the selected admission hash and source", async () => {
    const receipt = selectionReceipt();
    const pointer = {
      schemaVersion: 1 as const,
      premiereId: receipt.selected[0].premiereId,
      sourceRunId: "source_run_1",
      sourceKind: "rated_coworld" as const,
      terminalState: "cancelled" as const,
      revealedAt: null,
      publicationCommitmentHash: "b".repeat(64),
      sourceReplaySha256: "c".repeat(64),
      summaryHash: "d".repeat(64),
      summaryRelPath: `summaries/${receipt.selected[0].premiereId}.summary.json`,
      reclaimedAt: "2026-08-22T07:01:00.000Z",
    };
    const admission = {
      recordHash: receipt.selected[0].admissionRecordHash,
      eligibilityRecord: {
        sourceKind: "rated_coworld",
        sourceRunId: pointer.sourceRunId,
      },
      stagedSource: { sourceReplaySha256: pointer.sourceReplaySha256 },
    } as unknown as ReplayPremiereAdmissionRecordV1;
    const dependencies = {
      readSelection: async () => receipt,
      readState: async () => null,
      readArchivePointer: async () => pointer,
    };

    await expect(
      foreignRegisteredPremiereGate(config(), {
        ...dependencies,
        readAdmission: async () => ({
          ...admission,
          recordHash: "e".repeat(64),
        }),
      }),
    ).rejects.toThrow("does not bind selected admission");
    await expect(
      foreignRegisteredPremiereGate(config(), {
        ...dependencies,
        readAdmission: async () => admission,
      }),
    ).resolves.toMatchObject({ busyPremiereIds: [] });
  });

  test("nonterminal manifests block while terminal manifests clear", async () => {
    const receipt = selectionReceipt();
    const dependencies = { readSelection: async () => receipt };
    await expect(
      foreignRegisteredPremiereGate(config(), {
        ...dependencies,
        readState: async () => "playing",
      }),
    ).resolves.toMatchObject({
      busyPremiereIds: [receipt.selected[0].premiereId],
    });
    await expect(
      foreignRegisteredPremiereGate(config(), {
        ...dependencies,
        readState: async () => "revealed",
      }),
    ).resolves.toMatchObject({ busyPremiereIds: [] });
  });

  test("receipt replacement during probes or immediately before commit fails closed", async () => {
    const first = selectionReceipt();
    const replacement = selectionReceipt(
      "00000000-0000-4000-8000-000000000099",
    );
    let reads = 0;
    await expect(
      foreignRegisteredPremiereGate(config(), {
        readSelection: async () => (reads++ === 0 ? first : replacement),
        readState: async () => "revealed",
      }),
    ).rejects.toThrow("changed during manifest probes");

    const gate = await foreignRegisteredPremiereGate(config(), {
      readSelection: async () => first,
      readState: async () => "revealed",
    });
    await expect(
      assertForeignPremiereGateUnchanged(
        config(),
        gate,
        async () => replacement,
      ),
    ).rejects.toThrow("changed before claim commit");
  });

  test("selected nonterminal target missing from ready registration fails closed", async () => {
    const incomplete = {
      ...selectionReceipt(),
      registeredPremiereIds: [],
    };

    await expect(
      foreignRegisteredPremiereGate(config(), {
        readSelection: async () => incomplete,
        readState: async () => "playing",
      }),
    ).rejects.toThrow();
  });

  test("unregistered terminal fallback is receipt-proven and does not block a new claim", async () => {
    const terminal = {
      ...selectionReceipt(),
      selected: [
        {
          ...selectionReceipt().selected[0],
          projectionState: "revealed" as const,
        },
      ],
      registeredPremiereIds: [],
    };
    const readState = vi.fn();

    await expect(
      foreignRegisteredPremiereGate(config(), {
        readSelection: async () => terminal,
        readState,
      }),
    ).resolves.toMatchObject({ busyPremiereIds: [] });
    expect(readState).not.toHaveBeenCalled();
  });
});

function selectionReceipt(
  startupId = "00000000-0000-4000-8000-000000000002",
): ReplayPremiereStartupSelectionReceiptV1 {
  const premiereId = "prem_0123456789abcdef";
  return {
    schemaVersion: 1,
    kind: "replay_premiere_startup_selection_v1",
    phase: "ready",
    server: {
      pid: process.pid,
      writerId: "00000000-0000-4000-8000-000000000001",
      writerAcquiredAt: "2026-08-22T07:00:00.000Z",
      startupId,
      startupStartedAt: "2026-08-22T07:00:01.000Z",
    },
    selected: [
      {
        premiereId,
        admissionRecordHash: "a".repeat(64),
        projectionState: "playing",
      },
    ],
    registeredPremiereIds: [premiereId],
    writtenAt: "2026-08-22T07:00:02.000Z",
  };
}

async function retainedFileSnapshot(
  loopConfig: LoopConfig,
): Promise<Record<string, number>> {
  const snapshot: Record<string, number> = {};
  for (const root of [loopConfig.ingestScratchDir, loopConfig.nonceDir]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(root, entry);
      snapshot[`${path.basename(root)}/${entry}`] = (await stat(filePath)).size;
    }
  }
  return snapshot;
}

async function createRetainedTransaction(
  current: LoopHoldState,
  loopConfig: LoopConfig,
  prefix: string,
): Promise<RetainedAdmissionTransaction> {
  await Promise.all([
    mkdir(loopConfig.ingestScratchDir, { recursive: true }),
    mkdir(loopConfig.nonceDir, { recursive: true }),
  ]);
  const scratch = (name: string) =>
    path.join(loopConfig.ingestScratchDir, `${prefix}.${name}`);
  const transaction: RetainedAdmissionTransaction = {
    premiereId: current.premiereId,
    episodeRequestId: current.episodeRequestId,
    bundleSha256: "d".repeat(64),
    createdAt: NOW.toISOString(),
    rawReplayPath: scratch("replay"),
    divisionFile: scratch("divisions.json"),
    episodeFile: scratch("episode.json"),
    sourceFile: scratch("source.json"),
    eligibilityFile: scratch("eligibility.json"),
    definitionFile: scratch("definition.json"),
    nonceFile: path.join(loopConfig.nonceDir, `${prefix}.nonce.bin`),
    markerPath: path.join(
      loopConfig.ingestScratchDir,
      `${current.premiereId}.retained-admission.json`,
    ),
  };
  await Promise.all(
    [
      transaction.rawReplayPath,
      transaction.divisionFile,
      transaction.episodeFile,
      transaction.sourceFile,
      transaction.eligibilityFile,
      transaction.definitionFile,
      transaction.nonceFile,
    ].map((filePath, index) => writeFile(filePath, `evidence-${index}`)),
  );
  await persistRetainedAdmissionTransaction(transaction, loopConfig);
  return transaction;
}

function parseJournal(raw: string): LoopJournalRecord[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoopJournalRecord);
}

function compactionRecords(): LoopJournalRecord[] {
  const admitted = hold({
    phase: "admitted",
    activatedAt: null,
    premierePageLive: false,
  });
  return [
    {
      kind: "hold_update",
      ts: NOW.toISOString(),
      hold: admitted,
    },
    ...Array.from({ length: 5_001 }, (_value, index) => ({
      kind: "round_skipped" as const,
      ts: NOW.toISOString(),
      roundId: `round_compaction_${index}`,
      roundNumber: 1_000 + index,
      reason: "skipped_busy" as const,
    })),
  ];
}

function serializeJournal(records: readonly LoopJournalRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function compactionTemporaryNames(
  loopConfig: LoopConfig,
): Promise<string[]> {
  return (await readdir(path.dirname(loopConfig.journalPath))).filter(
    (entry) =>
      entry.startsWith(`${path.basename(loopConfig.journalPath)}.`) &&
      entry.endsWith(".tmp"),
  );
}

function stubPremiereState(state: string | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (state === null) {
      return { status: 404, ok: false, body: null } as unknown as Response;
    }
    return {
      status: 200,
      ok: true,
      body: null,
      json: async () => ({ state }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "premiere-verify-"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(stateDir, { recursive: true, force: true });
});

describe("private journal compaction durability", () => {
  test("publishes a mode-0600 compacted journal whose fold preserves the admitted hold", async () => {
    const loopConfig = config();
    const records = compactionRecords();
    await writeFile(loopConfig.journalPath, serializeJournal(records), {
      mode: 0o644,
    });
    await chmod(loopConfig.journalPath, 0o644);

    const compacted = await compactJournalIfNeeded(loopConfig, records);

    expect(compacted).toHaveLength(2_001);
    expect(foldLoopJournal(compacted).activeHold?.phase).toBe("admitted");
    const persisted = parseJournal(
      await readFile(loopConfig.journalPath, "utf8"),
    );
    expect(persisted).toEqual(compacted);
    expect(foldLoopJournal(persisted).activeHold?.phase).toBe("admitted");
    expect((await stat(loopConfig.journalPath)).mode & 0o777).toBe(0o600);
    const archivePath = path.join(
      loopConfig.loopStateDir,
      "journal.archive.jsonl",
    );
    expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
    expect(await compactionTemporaryNames(loopConfig)).toEqual([]);
  });

  test("never splits a terminal release from the exact hold phase required by strict backfill", async () => {
    const loopConfig = config();
    const activated = hold({ phase: "activated" });
    const skipped = (index: number): LoopJournalRecord => ({
      kind: "round_skipped",
      ts: NOW.toISOString(),
      roundId: `round_boundary_${index}`,
      roundNumber: index,
      reason: "skipped_busy",
    });
    const records: LoopJournalRecord[] = [
      ...Array.from({ length: 3_001 }, (_value, index) => skipped(index)),
      { kind: "hold_update", ts: NOW.toISOString(), hold: activated },
      {
        kind: "hold_released",
        ts: new Date(NOW.getTime() + 1_000).toISOString(),
        episodeRequestId: activated.episodeRequestId,
        premiereId: activated.premiereId,
        roundId: activated.roundId,
        outcome: "activation_lost",
        terminal: true,
      },
      ...Array.from({ length: 1_999 }, (_value, index) =>
        skipped(4_000 + index),
      ),
    ];
    await writeFile(loopConfig.journalPath, serializeJournal(records), {
      mode: 0o600,
    });

    const compacted = await compactJournalIfNeeded(loopConfig, records);

    expect(compacted.slice(0, 2)).toEqual([
      { kind: "hold_update", ts: NOW.toISOString(), hold: activated },
      expect.objectContaining({
        kind: "hold_released",
        episodeRequestId: activated.episodeRequestId,
        outcome: "activation_lost",
      }),
    ]);
    expect(compacted).toHaveLength(2_001);
  });

  test.each([
    "after_archive_sync",
    "after_temporary_write",
    "after_temporary_sync",
    "after_temporary_close",
  ] as const)(
    "keeps the original active journal and rejects a pre-rename fault at %s",
    async (failurePhase) => {
      const loopConfig = config();
      const records = compactionRecords();
      const original = serializeJournal(records);
      await writeFile(loopConfig.journalPath, original, { mode: 0o600 });

      await expect(
        compactJournalIfNeeded(loopConfig, records, (phase) => {
          if (phase === failurePhase) {
            throw new Error(`compaction fault at ${phase}`);
          }
        }),
      ).rejects.toThrow(`compaction fault at ${failurePhase}`);

      expect(await readFile(loopConfig.journalPath, "utf8")).toBe(original);
      expect(foldLoopJournal(parseJournal(original)).activeHold?.phase).toBe(
        "admitted",
      );
      expect(await compactionTemporaryNames(loopConfig)).toEqual([]);
    },
  );

  test.each([
    "after_rename",
    "before_directory_sync",
    "after_directory_sync",
  ] as const)(
    "rejects durability uncertainty at %s while both old and new folds preserve the admitted hold",
    async (failurePhase) => {
      const loopConfig = config();
      const records = compactionRecords();
      const original = serializeJournal(records);
      await writeFile(loopConfig.journalPath, original, { mode: 0o600 });

      await expect(
        compactJournalIfNeeded(loopConfig, records, (phase) => {
          if (phase === failurePhase) {
            throw new Error(`compaction fault at ${phase}`);
          }
        }),
      ).rejects.toThrow(`compaction fault at ${failurePhase}`);

      const persisted = parseJournal(
        await readFile(loopConfig.journalPath, "utf8"),
      );
      expect(foldLoopJournal(parseJournal(original)).activeHold?.phase).toBe(
        "admitted",
      );
      expect(foldLoopJournal(persisted).activeHold?.phase).toBe("admitted");
      expect(persisted).toHaveLength(2_001);
      expect((await stat(loopConfig.journalPath)).mode & 0o777).toBe(0o600);
      expect(await compactionTemporaryNames(loopConfig)).toEqual([]);
    },
  );

  test("cleans a pre-rename temporary and preserves the primary error when cleanup reporting also fails", async () => {
    const loopConfig = config();
    const records = compactionRecords();
    const original = serializeJournal(records);
    await writeFile(loopConfig.journalPath, original, { mode: 0o600 });
    let caught: unknown;

    try {
      await compactJournalIfNeeded(loopConfig, records, (phase) => {
        if (phase === "after_temporary_write") {
          throw new Error("primary compaction failure");
        }
        if (phase === "after_temporary_cleanup") {
          throw new Error("cleanup durability report failure");
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([
      "primary compaction failure",
      "cleanup durability report failure",
    ]);
    expect(await readFile(loopConfig.journalPath, "utf8")).toBe(original);
    expect(await compactionTemporaryNames(loopConfig)).toEqual([]);
  });
});

describe("admission projection deadline", () => {
  test("boots the supported loop package entrypoint in the bundled game environment", async () => {
    let failure: unknown;
    try {
      await execFileAsync(
        "npm",
        ["run", "--silent", "premiere:loop", "--", "--unsupported"],
        {
          cwd: process.cwd(),
          env: { ...process.env, GAME_ENV: "" },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "unknown premiere-loop argument(s): --unsupported",
      ),
    });
  });

  test("cannot be widened beyond the reviewed 90-second ceiling", async () => {
    const runAdmission = vi.fn();
    await expect(
      runLoopReplayPremiereAdmission({
        args: [],
        premiereId: hold().premiereId,
        bundleSha256: "a".repeat(64),
        environment: {},
        projectionTimeoutMs: PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS + 1,
        runAdmission,
      }),
    ).rejects.toThrow("invalid premiere admission projection timeout");
    expect(runAdmission).not.toHaveBeenCalled();
  });

  test("aborts at the fixed ceiling and maps the failure to a retriable admit release", async () => {
    vi.useFakeTimers();
    let projectionSignal: AbortSignal | undefined;
    const pending = runLoopReplayPremiereAdmission({
      args: [],
      premiereId: hold().premiereId,
      bundleSha256: "a".repeat(64),
      environment: {},
      runAdmission: async (_args, dependencies) => {
        projectionSignal = dependencies?.checkpointProjectionSignal;
        if (projectionSignal === undefined) {
          throw new Error("missing projection deadline signal");
        }
        return new Promise<never>((_resolve, reject) => {
          projectionSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new ReplayPremiereError(
                  "checkpoint_projection_aborted",
                  "PREMIERE_UNAVAILABLE",
                  503,
                  "checkpoint projection aborted",
                ),
              ),
            { once: true },
          );
        });
      },
    });

    expect(projectionSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(
      PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS - 1,
    );
    expect(projectionSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      kind: "release",
      outcome: "admit_failed",
      terminal: false,
    });
    expect(projectionSignal?.aborted).toBe(true);
  });

  test("timeout release refreshes the standing heartbeat, unpins once, and never activates", async () => {
    const current = hold({
      phase: "claimed",
      activatedAt: null,
      premierePageLive: false,
    });
    await writeFile(
      config().pinManifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pins: [
          {
            episodeRequestId: current.episodeRequestId,
            publicRunKey: current.publicRunKey,
            reason: `premiere-hold:${current.premiereId}`,
          },
        ],
      })}\n`,
      "utf8",
    );
    const journal = captureJournal();
    const timedOutAdmission = vi.fn(async () => ({
      kind: "release" as const,
      outcome: "admit_failed" as const,
      terminal: false,
    }));
    const activate = vi.fn();
    const track = vi.fn();
    const releasedAt = new Date(
      NOW.getTime() + PREMIERE_LOOP_ADMISSION_PROJECTION_TIMEOUT_MS,
    );
    const materials = {
      rawRow: {},
      rawReplayPath: path.join(stateDir, "unused.replay"),
      facts: {
        runId: "coworld-run",
        turnCount: current.turnCount,
        seatCount: current.seatCount,
        gameMap: "World",
        gameMapSize: "Large",
        difficulty: "Hard",
        coworldName: "proxywar",
      },
      divisionFile: path.join(stateDir, "unused-divisions.json"),
    } satisfies IngestMaterials;

    await progressHold(current, materials, config(), journal.writer, NOW, {
      ingestAndAdmit: timedOutAdmission,
      hasStorageFloor: async () => true,
      activateHold: activate,
      trackHold: track,
      now: () => releasedAt,
    });

    expect(timedOutAdmission).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(journal.holdUpdates).toEqual([]);
    expect(journal.released).toEqual([
      { hold: current, outcome: "admit_failed", terminal: false },
    ]);
    const contract = JSON.parse(
      await readFile(config().contractPath, "utf8"),
    ) as { generatedAt: string; holds: unknown[] };
    expect(contract.generatedAt).toBe(releasedAt.toISOString());
    expect(contract.holds).toEqual([]);
    const pins = JSON.parse(
      await readFile(config().pinManifestPath, "utf8"),
    ) as { pins: unknown[] };
    expect(pins.pins).toEqual([]);
  });

  test("an uncertain catalog commit preserves the hold and never enters release or activation", async () => {
    const current = hold({
      phase: "claimed",
      activatedAt: null,
      premierePageLive: false,
    });
    const journal = captureJournal();
    const holdRequiredAdmission = vi.fn(async () => ({
      kind: "hold" as const,
      reason: "admission_state_uncertain" as const,
    }));
    const activate = vi.fn();
    const track = vi.fn();
    const refreshedAt = new Date(NOW.getTime() + 45_000);
    const materials = {
      rawRow: {},
      rawReplayPath: path.join(stateDir, "retained.replay"),
      facts: {
        runId: "coworld-run",
        turnCount: current.turnCount,
        seatCount: current.seatCount,
        gameMap: "World",
        gameMapSize: "Large",
        difficulty: "Hard",
        coworldName: "proxywar",
      },
      divisionFile: path.join(stateDir, "retained-divisions.json"),
    } satisfies IngestMaterials;

    await progressHold(current, materials, config(), journal.writer, NOW, {
      ingestAndAdmit: holdRequiredAdmission,
      hasStorageFloor: async () => true,
      activateHold: activate,
      trackHold: track,
      now: () => refreshedAt,
    });

    expect(holdRequiredAdmission).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(journal.holdUpdates).toEqual([current]);
    expect(journal.released).toEqual([]);
    const contract = JSON.parse(
      await readFile(config().contractPath, "utf8"),
    ) as { generatedAt: string; holds: Array<{ premiereId: string }> };
    expect(contract.generatedAt).toBe(refreshedAt.toISOString());
    expect(contract.holds.map((entry) => entry.premiereId)).toEqual([
      current.premiereId,
    ]);
  });

  test("reuses one retained transaction across two ticks without download, ingest, or growth", async () => {
    const current = hold({
      phase: "claimed",
      activatedAt: null,
      premierePageLive: false,
    });
    const loopConfig = config();
    await Promise.all([
      mkdir(loopConfig.ingestScratchDir, { recursive: true }),
      mkdir(loopConfig.nonceDir, { recursive: true }),
    ]);
    const scratch = (name: string) =>
      path.join(loopConfig.ingestScratchDir, name);
    const transaction: RetainedAdmissionTransaction = {
      premiereId: current.premiereId,
      episodeRequestId: current.episodeRequestId,
      bundleSha256: "b".repeat(64),
      createdAt: NOW.toISOString(),
      rawReplayPath: scratch("retained.replay"),
      divisionFile: scratch("retained.divisions.json"),
      episodeFile: scratch("retained.episode.json"),
      sourceFile: scratch("retained.source.json"),
      eligibilityFile: scratch("retained.eligibility.json"),
      definitionFile: scratch("retained.definition.json"),
      nonceFile: path.join(loopConfig.nonceDir, "retained-nonce.bin"),
      markerPath: scratch(`${current.premiereId}.retained-admission.json`),
    };
    await Promise.all(
      [
        transaction.rawReplayPath,
        transaction.divisionFile,
        transaction.episodeFile,
        transaction.sourceFile,
        transaction.eligibilityFile,
        transaction.definitionFile,
        transaction.nonceFile,
      ].map((filePath, index) => writeFile(filePath, `evidence-${index}`)),
    );
    await persistRetainedAdmissionTransaction(transaction, loopConfig);
    const before = await retainedFileSnapshot(loopConfig);
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "hold" as const,
        reason: "admission_state_uncertain" as const,
      })
      .mockResolvedValueOnce({
        kind: "admitted" as const,
        bundleSha256: transaction.bundleSha256,
        retainedTransaction: transaction,
      });
    const ingest = vi.fn();
    const storageFloor = vi.fn(async () => true);
    const activate = vi.fn(async (admitted: LoopHoldState) => ({
      kind: "retry" as const,
      hold: admitted,
    }));
    const track = vi.fn();
    const download = vi.fn();
    vi.stubGlobal("fetch", download);
    const journal = captureJournal();

    await progressHold(current, null, loopConfig, journal.writer, NOW, {
      ingestAndAdmit: ingest,
      reconcileRetainedAdmission: reconcile,
      hasStorageFloor: storageFloor,
      activateHold: activate,
      trackHold: track,
      now: () => new Date(NOW.getTime() + 60_000),
    });

    expect(await retainedFileSnapshot(loopConfig)).toEqual(before);
    expect(journal.released).toEqual([]);
    expect(journal.holdUpdates).toHaveLength(1);
    const preserved = journal.holdUpdates[0];
    expect(preserved.phase).toBe("claimed");

    await progressHold(
      preserved,
      null,
      loopConfig,
      journal.writer,
      new Date(NOW.getTime() + 120_000),
      {
        ingestAndAdmit: ingest,
        reconcileRetainedAdmission: reconcile,
        hasStorageFloor: storageFloor,
        activateHold: activate,
        trackHold: track,
        now: () => new Date(NOW.getTime() + 120_000),
      },
    );

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(ingest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(storageFloor).toHaveBeenCalledTimes(2);
    expect(journal.released).toEqual([]);
    expect(journal.holdUpdates.at(-1)?.phase).toBe("admitted");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalled();
    expect(await retainedFileSnapshot(loopConfig)).toEqual({});
  });

  test.each([
    "after_write",
    "after_file_sync",
    "after_file_close",
    "after_directory_sync",
  ] as const)(
    "retains evidence across an admitted-journal crash at %s and restart-folds safely",
    async (failurePhase) => {
      const current = hold({
        phase: "claimed",
        activatedAt: null,
        premierePageLive: false,
      });
      const loopConfig = config();
      const transaction = await createRetainedTransaction(
        current,
        loopConfig,
        failurePhase,
      );
      const before = await retainedFileSnapshot(loopConfig);
      const durableWriter = createJournalWriter(loopConfig);
      await durableWriter.appendHoldUpdate(current);
      const durableClaimedJournal = await readFile(
        loopConfig.journalPath,
        "utf8",
      );
      const crashingWriter = createJournalWriter(
        loopConfig,
        (phase, record) => {
          if (
            phase === failurePhase &&
            record.kind === "hold_update" &&
            record.hold.phase === "admitted"
          ) {
            throw new Error(`simulated crash at ${phase}`);
          }
        },
      );
      const admitted = {
        kind: "admitted" as const,
        bundleSha256: transaction.bundleSha256,
        retainedTransaction: transaction,
      };

      await expect(
        progressHold(current, null, loopConfig, crashingWriter, NOW, {
          reconcileRetainedAdmission: async () => admitted,
          hasStorageFloor: async () => true,
          activateHold: async (admittedHold) => ({
            kind: "retry" as const,
            hold: admittedHold,
          }),
          now: () => new Date(NOW.getTime() + 60_000),
        }),
      ).rejects.toThrow(`simulated crash at ${failurePhase}`);
      expect(await retainedFileSnapshot(loopConfig)).toEqual(before);

      if (failurePhase === "after_write") {
        // The unsynced append is permitted to disappear in a real crash.
        await writeFile(loopConfig.journalPath, durableClaimedJournal, {
          mode: 0o600,
        });
      }
      const folded = foldLoopJournal(
        parseJournal(await readFile(loopConfig.journalPath, "utf8")),
      );
      expect(folded.activeHold?.phase).toBe(
        failurePhase === "after_write" ? "claimed" : "admitted",
      );
      if (folded.activeHold === null) {
        throw new Error("restart lost the active retained hold");
      }

      await progressHold(
        folded.activeHold,
        null,
        loopConfig,
        durableWriter,
        new Date(NOW.getTime() + 120_000),
        {
          reconcileRetainedAdmission: async () => admitted,
          hasStorageFloor: async () => true,
          activateHold: async (admittedHold) => ({
            kind: "retry" as const,
            hold: admittedHold,
          }),
          now: () => new Date(NOW.getTime() + 120_000),
        },
      );

      expect(await retainedFileSnapshot(loopConfig)).toEqual({});
      const restarted = foldLoopJournal(
        parseJournal(await readFile(loopConfig.journalPath, "utf8")),
      );
      expect(restarted.activeHold?.phase).toBe("admitted");
    },
  );

  test("checks the storage floor before an existing claimed hold downloads or ingests", async () => {
    const current = hold({
      phase: "claimed",
      activatedAt: null,
      premierePageLive: false,
    });
    const journal = captureJournal();
    const ingest = vi.fn();
    const download = vi.fn();
    vi.stubGlobal("fetch", download);

    await progressHold(current, null, config(), journal.writer, NOW, {
      ingestAndAdmit: ingest,
      hasStorageFloor: async () => false,
    });

    expect(ingest).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(journal.holdUpdates).toEqual([]);
    expect(journal.released).toEqual([]);
  });

  test("an expired claimed hold with a retained marker extends instead of releasing", async () => {
    const current = hold({
      phase: "claimed",
      activatedAt: null,
      premierePageLive: false,
      holdExpiresAt: new Date(NOW.getTime() - 1).toISOString(),
    });
    const loopConfig = config();
    await Promise.all([
      mkdir(loopConfig.ingestScratchDir, { recursive: true }),
      mkdir(loopConfig.nonceDir, { recursive: true }),
    ]);
    const scratch = (name: string) =>
      path.join(loopConfig.ingestScratchDir, name);
    const transaction: RetainedAdmissionTransaction = {
      premiereId: current.premiereId,
      episodeRequestId: current.episodeRequestId,
      bundleSha256: "c".repeat(64),
      createdAt: NOW.toISOString(),
      rawReplayPath: scratch("expired.replay"),
      divisionFile: scratch("expired.divisions.json"),
      episodeFile: scratch("expired.episode.json"),
      sourceFile: scratch("expired.source.json"),
      eligibilityFile: scratch("expired.eligibility.json"),
      definitionFile: scratch("expired.definition.json"),
      nonceFile: path.join(loopConfig.nonceDir, "expired-nonce.bin"),
      markerPath: scratch(`${current.premiereId}.retained-admission.json`),
    };
    await persistRetainedAdmissionTransaction(transaction, loopConfig);
    const journal = captureJournal();
    const reconcile = vi.fn();

    await progressHold(current, null, loopConfig, journal.writer, NOW, {
      reconcileRetainedAdmission: reconcile,
      hasStorageFloor: async () => true,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(journal.released).toEqual([]);
    expect(journal.holdUpdates).toHaveLength(1);
    expect(Date.parse(journal.holdUpdates[0].holdExpiresAt)).toBe(
      NOW.getTime() + PREMIERE_LOOP_HOLD_WINDOW_MS,
    );
  });

  test("maps an uncertain Catalog-to-CLI result to hold, never admit_failed", async () => {
    const result = await runLoopReplayPremiereAdmission({
      args: [],
      premiereId: hold().premiereId,
      bundleSha256: "a".repeat(64),
      environment: {},
      runAdmission: async () => {
        throw new ReplayPremiereError(
          "catalog_admission_commit_state_uncertain",
          "PREMIERE_UNAVAILABLE",
          500,
          "uncertain admission commit",
        );
      },
    });

    expect(result).toEqual({
      kind: "hold",
      reason: "admission_state_uncertain",
    });
  });
});

describe("trackHold — post-activation registration verification", () => {
  test("registered premiere flips the league card exactly as before; restart never fires", async () => {
    stubPremiereState("scheduled");
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    await trackHold(hold(), config(), journal.writer, NOW, restart);
    expect(restart).not.toHaveBeenCalled();
    expect(journal.released).toHaveLength(0);
    expect(journal.holdUpdates).toHaveLength(1);
    expect(journal.holdUpdates[0].phase).toBe("live");
    expect(journal.holdUpdates[0].premierePageLive).toBe(true);
  });

  test("unregistered inside the window: wait, keep the contract fresh, no restart, no release", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    const current = hold({ premierePageLive: true, phase: "activated" });
    await trackHold(current, config(), journal.writer, NOW, restart);
    expect(restart).not.toHaveBeenCalled();
    expect(journal.released).toHaveLength(0);
    expect(journal.holdUpdates).toHaveLength(0);
    const contract = JSON.parse(
      await readFile(config().contractPath, "utf8"),
    ) as { holds: unknown[] };
    expect(contract.holds).toHaveLength(1);
  });

  test("pre-fix activated hold without a stamp: starts the window (journaled), no restart", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    await trackHold(
      hold({ activatedAt: null }),
      config(),
      journal.writer,
      NOW,
      restart,
      async () => null,
    );
    expect(restart).not.toHaveBeenCalled();
    expect(journal.released).toHaveLength(0);
    expect(journal.holdUpdates).toHaveLength(1);
    expect(journal.holdUpdates[0].activatedAt).toBe(NOW.toISOString());
    expect(journal.holdUpdates[0].phase).toBe("activated");
  });

  test("window elapsed: exactly one re-activation restart, journaled with a fresh window", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    const activatedAt = new Date(
      NOW.getTime() - PREMIERE_LOOP_ACTIVATION_VERIFY_MS - 1_000,
    ).toISOString();
    await trackHold(
      hold({ activatedAt }),
      config(),
      journal.writer,
      NOW,
      restart,
      async () => null,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(journal.released).toHaveLength(0);
    expect(journal.holdUpdates).toHaveLength(1);
    expect(journal.holdUpdates[0].reactivationAttempts).toBe(1);
    expect(journal.holdUpdates[0].activatedAt).toBe(NOW.toISOString());
    expect(journal.holdUpdates[0].phase).toBe("activated");
  });

  test("retry restart refused: immediate terminal activation_lost release (fail-open)", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => false);
    const activatedAt = new Date(
      NOW.getTime() - PREMIERE_LOOP_ACTIVATION_VERIFY_MS - 1_000,
    ).toISOString();
    await trackHold(
      hold({ activatedAt }),
      config(),
      journal.writer,
      NOW,
      restart,
      async () => null,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(journal.released).toHaveLength(1);
    expect(journal.released[0].outcome).toBe("activation_lost");
    expect(journal.released[0].terminal).toBe(true);
    // Fail-open: the release rewrites the ZERO-HOLD standing contract so the
    // episode publishes at quarantine expiry — the card is never held longer.
    const contract = JSON.parse(
      await readFile(config().contractPath, "utf8"),
    ) as { holds: unknown[] };
    expect(contract.holds).toHaveLength(0);
  });

  test("still unregistered after the consumed retry: terminal activation_lost, restart NOT re-fired", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    const activatedAt = new Date(
      NOW.getTime() - PREMIERE_LOOP_ACTIVATION_VERIFY_MS - 1_000,
    ).toISOString();
    await trackHold(
      hold({ activatedAt, reactivationAttempts: 1 }),
      config(),
      journal.writer,
      NOW,
      restart,
      async () => null,
    );
    expect(restart).not.toHaveBeenCalled();
    expect(journal.released).toHaveLength(1);
    expect(journal.released[0].outcome).toBe("activation_lost");
    expect(journal.released[0].terminal).toBe(true);
    const contract = JSON.parse(
      await readFile(config().contractPath, "utf8"),
    ) as { holds: unknown[] };
    expect(contract.holds).toHaveLength(0);
  });

  test("live-phase hold that 404s stays out of verification (holdExpiresAt bounds it)", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    await trackHold(
      hold({ phase: "live", premierePageLive: true }),
      config(),
      journal.writer,
      NOW,
      restart,
      async () => null,
    );
    expect(restart).not.toHaveBeenCalled();
    expect(journal.released).toHaveLength(0);
    expect(journal.holdUpdates).toHaveLength(0);
  });
});

describe("activateHold — helper-refusal backoff (2026-07-22 round-649 outage)", () => {
  test("a refusal arms the backoff and consumes an attempt (journaled)", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => false);
    const result = await activateHold(
      hold({ phase: "admitted", activatedAt: null }),
      config(),
      journal.writer,
      NOW,
      restart,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("retry");
    expect(journal.holdUpdates).toHaveLength(1);
    expect(journal.holdUpdates[0].activationAttempts).toBe(1);
    expect(journal.holdUpdates[0].activationBackoffUntil).toBe(
      new Date(
        NOW.getTime() + PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
      ).toISOString(),
    );
  });

  test("while backing off, the helper is NOT re-fired (no per-tick restart hammering)", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    const armed = hold({
      phase: "admitted",
      activatedAt: null,
      activationAttempts: 1,
      activationBackoffUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const result = await activateHold(
      armed,
      config(),
      journal.writer,
      NOW,
      restart,
    );
    expect(restart).not.toHaveBeenCalled();
    expect(result.kind).toBe("retry");
    expect(journal.holdUpdates).toHaveLength(0);
  });

  test("after the backoff elapses the attempt fires again", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => true);
    const past = hold({
      phase: "admitted",
      activatedAt: null,
      activationAttempts: 1,
      activationBackoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
    });
    const result = await activateHold(
      past,
      config(),
      journal.writer,
      NOW,
      restart,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("activated");
    expect(journal.holdUpdates[0].phase).toBe("activated");
    expect(journal.holdUpdates[0].activatedAt).toBe(NOW.toISOString());
  });

  test("the attempt ceiling still releases activation_refused terminally", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => false);
    const nearCeiling = hold({
      phase: "admitted",
      activatedAt: null,
      activationAttempts: PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS - 1,
      activationBackoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
    });
    const result = await activateHold(
      nearCeiling,
      config(),
      journal.writer,
      NOW,
      restart,
      async () => null,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("released");
    expect(journal.released).toHaveLength(1);
    expect(journal.released[0].outcome).toBe("activation_refused");
    expect(journal.released[0].terminal).toBe(true);
  });

  test("terminal release aborts before journal release when tombstone persistence fails", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const restart = vi.fn(async () => false);
    const persistRetirement = vi.fn(async () => {
      throw new Error("injected tombstone durability failure");
    });
    const nearCeiling = hold({
      phase: "admitted",
      activatedAt: null,
      activationAttempts: PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS - 1,
      activationBackoffUntil: new Date(NOW.getTime() - 1_000).toISOString(),
    });

    await expect(
      activateHold(
        nearCeiling,
        config(),
        journal.writer,
        NOW,
        restart,
        persistRetirement,
      ),
    ).rejects.toThrow("injected tombstone durability failure");
    expect(persistRetirement).toHaveBeenCalledTimes(1);
    expect(journal.released).toEqual([]);
  });
});
