import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  trackHold,
  type JournalWriter,
  type LoopConfig,
} from "../../../src/scripts/replay-premiere-loop";
import {
  LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
  parseLatestPremierePointer,
} from "../../../src/server/agents/CoworldLeaguePremiereSuppression";
import {
  PREMIERE_LOOP_ACTIVATION_VERIFY_MS,
  derivePremiereId,
  holdExpiresAtForScheduled,
  type LoopHoldState,
  type LoopReleaseOutcome,
  type LoopRoundRef,
  type LoopSkipReason,
} from "../../../src/server/replay-premiere/ReplayPremiereLoopCore";

/**
 * Latest-revealed-premiere pointer (the between-premieres league card source).
 * These tests drive the real `trackHold` with a stubbed loopback origin to
 * prove the pointer contract at the release site itself:
 *   - ONLY a `revealed` release writes the pointer (atomically, reveal-public
 *     fields only, no temp residue);
 *   - every other release outcome leaves the previous pointer byte-identical;
 *   - a pointer write failure never fails the release (the release is what
 *     un-suppresses the league feed and must always complete).
 * Shadow mode is covered structurally: releaseHold is reachable only from the
 * live iteration, and `loopSideEffectPlan(true).writeLatestPremierePointer`
 * is false (asserted in ReplayPremiereLoopCore.test.ts and re-checked by the
 * shadow iteration's own defense-in-depth gate).
 */

const NOW = new Date("2026-07-22T12:00:30.000Z");
const EPISODE_REQUEST_ID = "ereq_00000000-0000-0000-0000-000000000651";
const PREMIERE_ID = derivePremiereId(EPISODE_REQUEST_ID);

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

function config(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    loopbackBaseUrl: "http://127.0.0.1:9",
    contractPath: path.join(
      stateDir,
      "premiere-suppression",
      "contract-v1.json",
    ),
    latestPremierePointerPath: path.join(
      stateDir,
      "premiere-suppression",
      "latest-premiere.json",
    ),
    pinManifestPath: path.join(stateDir, "retention-pins.json"),
    ...overrides,
  } as unknown as LoopConfig;
}

function hold(overrides: Partial<LoopHoldState> = {}): LoopHoldState {
  const scheduledAt = "2026-07-22T11:40:00.000Z";
  return {
    episodeRequestId: EPISODE_REQUEST_ID,
    premiereId: PREMIERE_ID,
    roundId: "round_651",
    roundNumber: 651,
    scheduledAt,
    holdExpiresAt: holdExpiresAtForScheduled(scheduledAt),
    premierePageLive: true,
    mapLabel: "Pangaea",
    publicRunKey: "league-coworld-2026-07-22T11-02-14-282Z-46b0441a",
    replayUrl: "https://example.invalid/r.replay",
    variantName: "Tournament 12P - Pangaea",
    seatCount: 12,
    turnCount: 20600,
    playbackRate: 2,
    phase: "live",
    activationAttempts: 0,
    activationBackoffUntil: null,
    activatedAt: NOW.toISOString(),
    reactivationAttempts: 0,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function stubPremiereState(state: string | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (state === null) {
        return { status: 404, ok: false, body: null } as unknown as Response;
      }
      return {
        status: 200,
        ok: true,
        body: null,
        json: async () => ({ state }),
      } as unknown as Response;
    }),
  );
}

async function readPointerRaw(loopConfig: LoopConfig): Promise<string> {
  return readFile(loopConfig.latestPremierePointerPath, "utf8");
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "premiere-latest-pointer-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(stateDir, { recursive: true, force: true });
});

describe("releaseHold — latest-premiere pointer (via the real trackHold)", () => {
  test("a revealed release writes the pointer with reveal-public fields only", async () => {
    stubPremiereState("revealed");
    const journal = captureJournal();
    const loopConfig = config();
    await trackHold(hold(), loopConfig, journal.writer, NOW);
    expect(journal.released).toHaveLength(1);
    expect(journal.released[0].outcome).toBe("revealed");
    expect(journal.released[0].terminal).toBe(true);

    const raw = await readPointerRaw(loopConfig);
    expect(parseLatestPremierePointer(raw)).toEqual({
      schemaVersion: LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
      premiereId: PREMIERE_ID,
      roundNumber: 651,
      mapLabel: "Pangaea",
      revealedAt: NOW.toISOString(),
    });
    // Exact key set: no episode/run/outcome identifiers can ride along.
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      "mapLabel",
      "premiereId",
      "revealedAt",
      "roundNumber",
      "schemaVersion",
    ]);
    expect(raw).not.toContain(EPISODE_REQUEST_ID);
    expect(raw).not.toContain("league-coworld");

    // Atomic write path: rename left no temp residue beside the pointer.
    const residue = (
      await readdir(path.dirname(loopConfig.latestPremierePointerPath))
    ).filter((entry) => entry.includes(".tmp"));
    expect(residue).toEqual([]);

    // The release still rewrote the zero-hold standing contract.
    const contract = JSON.parse(
      await readFile(loopConfig.contractPath, "utf8"),
    ) as { holds: unknown[] };
    expect(contract.holds).toEqual([]);
  });

  test("an archived observation also releases as revealed and writes the pointer", async () => {
    stubPremiereState("archived");
    const journal = captureJournal();
    const loopConfig = config();
    await trackHold(hold(), loopConfig, journal.writer, NOW);
    expect(journal.released[0]?.outcome).toBe("revealed");
    expect(
      parseLatestPremierePointer(await readPointerRaw(loopConfig)),
    ).toMatchObject({ premiereId: PREMIERE_ID });
  });

  test("a revealed release overwrites the previous pointer (only-latest semantics)", async () => {
    stubPremiereState("revealed");
    const loopConfig = config();
    await writeFile(
      path.join(stateDir, "retention-pins.json"),
      JSON.stringify({ schemaVersion: 1, pins: [] }),
    );
    const previous = `${JSON.stringify(
      {
        schemaVersion: 1,
        premiereId: "prem_0579c9b1e839847e2a50f216",
        roundNumber: 642,
        mapLabel: "World",
        revealedAt: "2026-07-22T08:45:00.000Z",
      },
      null,
      2,
    )}\n`;
    await rm(loopConfig.latestPremierePointerPath, { force: true });
    await writeFile(loopConfig.latestPremierePointerPath, previous).catch(
      async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(loopConfig.latestPremierePointerPath), {
          recursive: true,
        });
        await writeFile(loopConfig.latestPremierePointerPath, previous);
      },
    );
    await trackHold(hold(), loopConfig, captureJournal().writer, NOW);
    expect(
      parseLatestPremierePointer(await readPointerRaw(loopConfig)),
    ).toMatchObject({ premiereId: PREMIERE_ID, roundNumber: 651 });
  });

  test("failed_or_cancelled never writes and leaves a previous pointer byte-identical", async () => {
    stubPremiereState("failed");
    const journal = captureJournal();
    const loopConfig = config();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(loopConfig.latestPremierePointerPath), {
      recursive: true,
    });
    const previous = `${JSON.stringify(
      {
        schemaVersion: 1,
        premiereId: "prem_0579c9b1e839847e2a50f216",
        roundNumber: 642,
        mapLabel: "World",
        revealedAt: "2026-07-22T08:45:00.000Z",
      },
      null,
      2,
    )}\n`;
    await writeFile(loopConfig.latestPremierePointerPath, previous);
    await trackHold(hold(), loopConfig, journal.writer, NOW);
    expect(journal.released[0]?.outcome).toBe("failed_or_cancelled");
    expect(await readPointerRaw(loopConfig)).toBe(previous);
  });

  test("failed_or_cancelled with no previous pointer creates none", async () => {
    stubPremiereState("cancelled");
    const journal = captureJournal();
    const loopConfig = config();
    await trackHold(hold(), loopConfig, journal.writer, NOW);
    expect(journal.released[0]?.outcome).toBe("failed_or_cancelled");
    await expect(readPointerRaw(loopConfig)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("activation_lost never touches the pointer", async () => {
    stubPremiereState(null);
    const journal = captureJournal();
    const loopConfig = config();
    const activatedAt = new Date(
      NOW.getTime() - PREMIERE_LOOP_ACTIVATION_VERIFY_MS - 1_000,
    ).toISOString();
    await trackHold(
      hold({
        phase: "activated",
        premierePageLive: false,
        activatedAt,
        reactivationAttempts: 1,
      }),
      loopConfig,
      journal.writer,
      NOW,
      async () => true,
      async () => null,
    );
    expect(journal.released[0]?.outcome).toBe("activation_lost");
    await expect(readPointerRaw(loopConfig)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("a pointer write failure is non-fatal: the revealed release still completes", async () => {
    stubPremiereState("revealed");
    const journal = captureJournal();
    // Parent of the pointer path is a regular FILE, so mkdir/rename must fail.
    const blocker = path.join(stateDir, "blocking-file");
    await writeFile(blocker, "not a directory");
    const loopConfig = config({
      latestPremierePointerPath: path.join(blocker, "latest-premiere.json"),
    } as Partial<LoopConfig>);
    await trackHold(hold(), loopConfig, journal.writer, NOW);
    expect(journal.released).toHaveLength(1);
    expect(journal.released[0].outcome).toBe("revealed");
    const contract = JSON.parse(
      await readFile(loopConfig.contractPath, "utf8"),
    ) as { holds: unknown[] };
    expect(contract.holds).toEqual([]);
  });
});
