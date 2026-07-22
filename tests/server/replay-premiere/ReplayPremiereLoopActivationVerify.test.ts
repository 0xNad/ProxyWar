import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  activateHold,
  trackHold,
  type JournalWriter,
  type LoopConfig,
} from "../../../src/scripts/replay-premiere-loop";
import {
  PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
  PREMIERE_LOOP_ACTIVATION_VERIFY_MS,
  PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS,
  derivePremiereId,
  holdExpiresAtForScheduled,
  type LoopHoldState,
  type LoopReleaseOutcome,
  type LoopRoundRef,
  type LoopSkipReason,
} from "../../../src/server/replay-premiere/ReplayPremiereLoopCore";

/**
 * The activation-zombie fix (2026-07-22, round 644 / prem_105c…): a controlled
 * restart that exits 0 only proves a fresh server process accepted traffic —
 * the server's startup recovery can still reject the freshly admitted
 * premiere on its own total budget (`startup_deadline_exceeded`), leaving
 * `/premiere/<id>` 404 while the loop tracked "phase activated" for the whole
 * 40-minute hold window. These tests drive the real `trackHold` with a
 * stubbed loopback origin and an injected restart to prove:
 *   - a registered premiere behaves exactly as before (no restart calls);
 *   - an unregistered activated premiere waits only a bounded window;
 *   - then re-activates exactly once;
 *   - then releases terminally as `activation_lost` (fail-open, journaled)
 *     instead of zombie-tracking to holdExpiresAt.
 */

const NOW = new Date("2026-07-22T12:00:30.000Z");

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
  vi.unstubAllGlobals();
  await rm(stateDir, { recursive: true, force: true });
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
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("released");
    expect(journal.released).toHaveLength(1);
    expect(journal.released[0].outcome).toBe("activation_refused");
    expect(journal.released[0].terminal).toBe(true);
  });
});
