import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
  PREMIERE_SUPPRESSION_STALE_MS,
  buildPremiereSiteBlock,
  classifyEpisodeSuppression,
  filterSuppressedEpisodeRows,
  loadPremiereSuppressionContract,
  parsePremiereSuppressionContract,
  premiereSuppressionContractPath,
  type PremiereSuppressionContract,
  type PremiereSuppressionState,
} from "../../../src/server/agents/CoworldLeaguePremiereSuppression";
import {
  PREMIERE_ID_PATTERN,
  isPremiereId,
} from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
  PREMIERE_LOOP_ACTIVATION_VERIFY_MS,
  PREMIERE_LOOP_HOLD_WINDOW_MS,
  PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS,
  PREMIERE_LOOP_MAX_REACTIVATION_ATTEMPTS,
  PREMIERE_LOOP_SCHEDULE_LEAD_MS,
  PREMIERE_LOOP_SEAL_WINDOW_MS,
  PREMIERE_LOOP_TURN_STARTUP_BUDGET,
  buildLoopEligibilityInput,
  buildLoopPremiereDefinition,
  buildLoopSuppressionContract,
  ceilToMinuteIso,
  checkpointSequencesForTurnCount,
  decideActivationVerification,
  decideLoopClaim,
  deriveCheckpointId,
  derivePremiereId,
  foldLoopJournal,
  holdExpiresAtForScheduled,
  isActivationBackoffActive,
  isCompletedTooOldToSeal,
  isHoldExpired,
  isManagedPublicRunKey,
  isTurnCountWithinStartupBudget,
  loopSideEffectPlan,
  mapLabelFromVariantName,
  normalizeLoopHoldState,
  orderEpisodesForClaim,
  parseLoopReplayRows,
  parseLoopRounds,
  playbackRateForTurnCount,
  publicRunKeyForSourceRunId,
  scheduledAtForClaim,
  type LoopHoldState,
  type LoopJournalRecord,
  type LoopReplayRow,
  type LoopRound,
} from "../../../src/server/replay-premiere/ReplayPremiereLoopCore";

const NOW = new Date("2026-07-22T12:00:30.000Z");

function round(overrides: Partial<LoopRound> = {}): LoopRound {
  return {
    id: `round_${overrides.roundNumber ?? 1}`,
    roundNumber: 1,
    status: "completed",
    completedAt: "2026-07-22T11:59:00.000Z",
    ...overrides,
  };
}

function hold(overrides: Partial<LoopHoldState> = {}): LoopHoldState {
  const scheduledAt = "2026-07-22T12:06:00.000Z";
  return {
    episodeRequestId: "ereq_00000000-0000-0000-0000-000000000001",
    premiereId: derivePremiereId("ereq_00000000-0000-0000-0000-000000000001"),
    roundId: "round_1",
    roundNumber: 1,
    scheduledAt,
    holdExpiresAt: holdExpiresAtForScheduled(scheduledAt),
    premierePageLive: false,
    mapLabel: "Pangaea",
    publicRunKey: "league-coworld-2026-07-22T11-58-00-000Z-a1b2c3d4",
    replayUrl: "https://example.invalid/r.replay",
    variantName: "Tournament 12P - Pangaea",
    seatCount: 12,
    turnCount: 12000,
    playbackRate: 2,
    phase: "claimed",
    activationAttempts: 0,
    activationBackoffUntil: null,
    activatedAt: null,
    reactivationAttempts: 0,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("premiere id derivation and opacity (requirement #3)", () => {
  test("prem_ + 24 hex chars, matches the contract pattern", () => {
    const id = derivePremiereId("ereq_0066320d-0c4f-443e-a941-c971e5e52301");
    expect(id).toMatch(/^prem_[a-f0-9]{24}$/);
    expect(PREMIERE_ID_PATTERN.test(id)).toBe(true);
    expect(isPremiereId(id)).toBe(true);
  });

  test("is opaque — leaks no episode id, run id, player name, or outcome", () => {
    const episodeRequestId = "ereq_0066320d-0c4f-443e-a941-c971e5e52301";
    const id = derivePremiereId(episodeRequestId);
    // The opaque token must not embed any part of the source id.
    expect(id.includes("0066320d")).toBe(false);
    expect(id.includes(episodeRequestId)).toBe(false);
    expect(id.includes("ereq")).toBe(false);
    for (const spoiler of [
      "daveey",
      "odin",
      "auri",
      "winner",
      "won",
      "World",
    ]) {
      expect(id.toLowerCase().includes(spoiler.toLowerCase())).toBe(false);
    }
  });

  test("is deterministic and collision-distinct", () => {
    const a = "ereq_aaaaaaaa-0000-0000-0000-000000000000";
    const b = "ereq_bbbbbbbb-0000-0000-0000-000000000000";
    expect(derivePremiereId(a)).toBe(derivePremiereId(a));
    expect(derivePremiereId(a)).not.toBe(derivePremiereId(b));
  });

  test("checkpoint ids are opaque, stable, and distinct per index", () => {
    const eid = "ereq_0066320d-0c4f-443e-a941-c971e5e52301";
    expect(deriveCheckpointId(eid, 0)).toMatch(/^cp_[a-f0-9]{12}$/);
    expect(deriveCheckpointId(eid, 0)).toBe(deriveCheckpointId(eid, 0));
    expect(deriveCheckpointId(eid, 0)).not.toBe(deriveCheckpointId(eid, 1));
  });
});

describe("playback rate + checkpoint heuristics", () => {
  test("playback rate bands (admit accepts only 1/2/4)", () => {
    // 2026-07-22 retune: premieres are the live product surface — typical
    // rounds play at 1x (~8-18 min on air), only >32k-turn episodes at 2x.
    expect(playbackRateForTurnCount(9_999)).toBe(1);
    expect(playbackRateForTurnCount(17_000)).toBe(1);
    expect(playbackRateForTurnCount(32_000)).toBe(1);
    expect(playbackRateForTurnCount(32_001)).toBe(2);
    expect(playbackRateForTurnCount(50_400)).toBe(2);
    expect(playbackRateForTurnCount(60_000)).toBe(2);
  });

  test("checkpoints at 0.35x/0.65x rounded", () => {
    expect(checkpointSequencesForTurnCount(1000)).toEqual([350, 650]);
    expect(checkpointSequencesForTurnCount(12_345)).toEqual([4321, 8024]);
  });
});

describe("startup budget bound", () => {
  test("accepts within budget, rejects over budget and non-positive", () => {
    expect(
      isTurnCountWithinStartupBudget(PREMIERE_LOOP_TURN_STARTUP_BUDGET),
    ).toBe(true);
    expect(
      isTurnCountWithinStartupBudget(PREMIERE_LOOP_TURN_STARTUP_BUDGET + 1),
    ).toBe(false);
    // 2026-07-22: with the deferred 90 s assembly lane, the real league's
    // large World episodes (observed up to 50,400 turns) must be admitted —
    // the 8 s-boot-era 24k calibration no longer binds.
    expect(isTurnCountWithinStartupBudget(50_400)).toBe(true);
    expect(isTurnCountWithinStartupBudget(0)).toBe(false);
    expect(isTurnCountWithinStartupBudget(Number.NaN)).toBe(false);
  });
});

describe("hold arithmetic", () => {
  test("scheduledAt is ceil-to-minute of now + lead", () => {
    // 12:00:30 + 5min = 12:05:30 -> ceil to 12:06:00
    expect(scheduledAtForClaim(NOW)).toBe("2026-07-22T12:06:00.000Z");
    expect(scheduledAtForClaim(NOW)).toBe(
      ceilToMinuteIso(NOW.getTime() + PREMIERE_LOOP_SCHEDULE_LEAD_MS),
    );
  });

  test("holdExpiresAt is scheduledAt + 35min", () => {
    const scheduledAt = scheduledAtForClaim(NOW);
    expect(holdExpiresAtForScheduled(scheduledAt)).toBe(
      new Date(
        Date.parse(scheduledAt) + PREMIERE_LOOP_HOLD_WINDOW_MS,
      ).toISOString(),
    );
    // 35min window stays under the ~30min interval + max play time envelope.
    expect(PREMIERE_LOOP_HOLD_WINDOW_MS).toBe(35 * 60_000);
  });

  test("expiry valve trips only at/after holdExpiresAt", () => {
    const h = hold();
    const justBefore = new Date(Date.parse(h.holdExpiresAt) - 1);
    const atExpiry = new Date(Date.parse(h.holdExpiresAt));
    expect(isHoldExpired(h, justBefore)).toBe(false);
    expect(isHoldExpired(h, atExpiry)).toBe(true);
  });
});

describe("map label from variant name (game_config is null upstream)", () => {
  test("takes the segment after the last ' - '", () => {
    expect(mapLabelFromVariantName("Tournament 12P - Pangaea")).toBe("Pangaea");
    expect(mapLabelFromVariantName("Tournament 12P - World")).toBe("World");
  });
  test("falls back gracefully", () => {
    expect(mapLabelFromVariantName(null)).toBe("Unknown map");
    expect(mapLabelFromVariantName("   ")).toBe("Unknown map");
    expect(mapLabelFromVariantName("Solo")).toBe("Solo");
  });
});

describe("public run key + pin safety", () => {
  test("derives league-<sourceRunId> and validates the managed pattern", () => {
    const key = publicRunKeyForSourceRunId(
      "coworld-2026-07-22T11-58-00-000Z-a1b2c3d4",
    );
    expect(key).toBe("league-coworld-2026-07-22T11-58-00-000Z-a1b2c3d4");
    expect(isManagedPublicRunKey(key)).toBe(true);
  });
  test("rejects unsafe keys that would corrupt the pin manifest", () => {
    expect(isManagedPublicRunKey("league-not-coworld-x")).toBe(false);
    expect(isManagedPublicRunKey("league-coworld-../escape")).toBe(false);
    expect(isManagedPublicRunKey("coworld-missing-league-prefix")).toBe(false);
  });
});

describe("coworld read parsing (unwraps {entries} and bare arrays)", () => {
  test("rounds: bare array and {entries} both parse", () => {
    const bare = parseLoopRounds([
      {
        id: "round_9",
        round_number: 9,
        status: "completed",
        completed_at: "t",
      },
    ]);
    expect(bare).toEqual([
      { id: "round_9", roundNumber: 9, status: "completed", completedAt: "t" },
    ]);
    const wrapped = parseLoopRounds({
      entries: [{ id: "round_9", round_number: 9, status: "running" }],
    });
    expect(wrapped[0].status).toBe("running");
    expect(wrapped[0].completedAt).toBeNull();
  });

  test("replays: keeps variant_name, drops unsafe episode ids", () => {
    const rows = parseLoopReplayRows([
      {
        id: "ereq_0066320d-0c4f-443e-a941-c971e5e52301",
        status: "completed",
        round_id: "round_9",
        completed_at: "t2",
        replay_url: "https://x/r.replay",
        variant_name: "Tournament 12P - World",
        game_config: null,
      },
      { id: "../evil", status: "completed" },
      { id: "ereq_ok", status: "failed", round_id: "round_9" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].variantName).toBe("Tournament 12P - World");
    expect(rows[0].roundId).toBe("round_9");
  });
});

describe("episode selection order (newest-first, this round only)", () => {
  const rows: LoopReplayRow[] = [
    {
      episodeRequestId: "ereq_a",
      roundId: "round_9",
      status: "completed",
      completedAt: "2026-07-22T11:50:00.000Z",
      replayUrl: "https://x/a.replay",
      variantName: "Tournament 12P - World",
    },
    {
      episodeRequestId: "ereq_b",
      roundId: "round_9",
      status: "completed",
      completedAt: "2026-07-22T11:59:00.000Z",
      replayUrl: "https://x/b.replay",
      variantName: "Tournament 12P - World",
    },
    {
      episodeRequestId: "ereq_c",
      roundId: "round_9",
      status: "completed",
      completedAt: "2026-07-22T11:55:00.000Z",
      replayUrl: null, // no replay yet -> excluded
      variantName: null,
    },
    {
      episodeRequestId: "ereq_d",
      roundId: "round_8", // other round -> excluded
      status: "completed",
      completedAt: "2026-07-22T11:59:59.000Z",
      replayUrl: "https://x/d.replay",
      variantName: null,
    },
  ];

  test("orders this round's replayable completed episodes newest-first", () => {
    const ordered = orderEpisodesForClaim(round({ id: "round_9" }), rows);
    expect(ordered.map((row) => row.episodeRequestId)).toEqual([
      "ereq_b",
      "ereq_a",
    ]);
  });
});

describe("decideLoopClaim — ONLY-LATEST detection, supersede, busy-skip", () => {
  test("claims the newest completed unpremiered round, supersedes older", () => {
    const rounds = [
      round({ id: "round_7", roundNumber: 7, status: "completed" }),
      round({ id: "round_9", roundNumber: 9, status: "completed" }),
      round({ id: "round_8", roundNumber: 8, status: "completed" }),
      round({ id: "round_10", roundNumber: 10, status: "running" }),
    ];
    const decision = decideLoopClaim({
      rounds,
      folded: foldLoopJournal([]),
    });
    expect(decision.kind).toBe("claim");
    if (decision.kind !== "claim") return;
    expect(decision.round.id).toBe("round_9");
    expect(decision.supersededRoundIds.map((r) => r.id).sort()).toEqual([
      "round_7",
      "round_8",
    ]);
  });

  test("idle when no completed unpremiered round exists", () => {
    const decision = decideLoopClaim({
      rounds: [round({ id: "round_10", status: "running" })],
      folded: foldLoopJournal([]),
    });
    expect(decision.kind).toBe("idle");
  });

  test("busy: with an active hold, never claims and skips newer rounds", () => {
    const active = hold({ roundId: "round_9", roundNumber: 9 });
    const folded = foldLoopJournal([
      { kind: "hold_update", ts: NOW.toISOString(), hold: active },
    ]);
    const decision = decideLoopClaim({
      rounds: [
        round({ id: "round_9", roundNumber: 9, status: "completed" }),
        round({ id: "round_10", roundNumber: 10, status: "completed" }),
      ],
      folded,
    });
    expect(decision.kind).toBe("track");
    if (decision.kind !== "track") return;
    expect(decision.hold.episodeRequestId).toBe(active.episodeRequestId);
    expect(decision.busySkipRoundIds.map((r) => r.id).sort()).toEqual([
      "round_10",
      "round_9",
    ]);
  });

  test("terminal (premiered/skipped) rounds are never re-claimed", () => {
    const folded = foldLoopJournal([
      {
        kind: "round_skipped",
        ts: NOW.toISOString(),
        roundId: "round_9",
        roundNumber: 9,
        reason: "skipped_superseded",
      },
    ]);
    const decision = decideLoopClaim({
      rounds: [round({ id: "round_9", roundNumber: 9, status: "completed" })],
      folded,
    });
    expect(decision.kind).toBe("idle");
  });
});

describe("foldLoopJournal — hold lifecycle, retry ceiling, terminality", () => {
  test("hold_update sets the single active hold; release clears it", () => {
    const active = hold();
    const withHold = foldLoopJournal([
      { kind: "hold_update", ts: NOW.toISOString(), hold: active },
    ]);
    expect(withHold.activeHold?.episodeRequestId).toBe(active.episodeRequestId);

    const released = foldLoopJournal([
      { kind: "hold_update", ts: NOW.toISOString(), hold: active },
      {
        kind: "hold_released",
        ts: NOW.toISOString(),
        episodeRequestId: active.episodeRequestId,
        premiereId: active.premiereId,
        roundId: active.roundId,
        outcome: "revealed",
        terminal: true,
      },
    ]);
    expect(released.activeHold).toBeNull();
    expect(released.terminalRoundIds.has("round_1")).toBe(true);
  });

  test("retriable releases count attempts and go terminal at the ceiling", () => {
    const records: LoopJournalRecord[] = [];
    for (
      let attempt = 0;
      attempt < PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS;
      attempt++
    ) {
      records.push({
        kind: "hold_released",
        ts: NOW.toISOString(),
        episodeRequestId: `ereq_attempt_${attempt}`,
        premiereId: derivePremiereId(`ereq_attempt_${attempt}`),
        roundId: "round_9",
        outcome: "ingest_failed",
        terminal: false,
      });
    }
    const folded = foldLoopJournal(records);
    expect(folded.attemptsByRound.get("round_9")).toBe(
      PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS,
    );
    expect(folded.terminalRoundIds.has("round_9")).toBe(true);
  });

  test("one retriable release keeps the round claimable", () => {
    const folded = foldLoopJournal([
      {
        kind: "hold_released",
        ts: NOW.toISOString(),
        episodeRequestId: "ereq_x",
        premiereId: derivePremiereId("ereq_x"),
        roundId: "round_9",
        outcome: "admit_failed",
        terminal: false,
      },
    ]);
    expect(folded.terminalRoundIds.has("round_9")).toBe(false);
    expect(folded.attemptsByRound.get("round_9")).toBe(1);
  });

  test("leak_audit_refused is terminal (publish), not a retry", () => {
    const folded = foldLoopJournal([
      {
        kind: "hold_released",
        ts: NOW.toISOString(),
        episodeRequestId: "ereq_x",
        premiereId: derivePremiereId("ereq_x"),
        roundId: "round_9",
        outcome: "leak_audit_refused",
        terminal: true,
      },
    ]);
    expect(folded.terminalRoundIds.has("round_9")).toBe(true);
    expect(folded.attemptsByRound.get("round_9")).toBeUndefined();
  });

  test("activation_lost is terminal (publish at quarantine expiry), never a retry", () => {
    const active = hold({ phase: "activated" });
    const folded = foldLoopJournal([
      { kind: "hold_update", ts: NOW.toISOString(), hold: active },
      {
        kind: "hold_released",
        ts: NOW.toISOString(),
        episodeRequestId: active.episodeRequestId,
        premiereId: active.premiereId,
        roundId: active.roundId,
        outcome: "activation_lost",
        terminal: true,
      },
    ]);
    expect(folded.activeHold).toBeNull();
    expect(folded.terminalRoundIds.has("round_1")).toBe(true);
    expect(folded.attemptsByRound.get("round_1")).toBeUndefined();
  });

  test("pre-verification journal records fold with a normalized window state", () => {
    // Simulate a hold journaled by the pre-fix loop: the two verification
    // fields are absent entirely (old schema on disk).
    const legacy = hold({ phase: "activated" });
    const legacyShape = { ...legacy } as Record<string, unknown>;
    delete legacyShape.activatedAt;
    delete legacyShape.reactivationAttempts;
    const folded = foldLoopJournal([
      {
        kind: "hold_update",
        ts: NOW.toISOString(),
        hold: legacyShape as unknown as LoopHoldState,
      },
    ]);
    expect(folded.activeHold?.activatedAt).toBeNull();
    expect(folded.activeHold?.reactivationAttempts).toBe(0);
  });
});

describe("post-activation registration verification (activation-zombie fix, 2026-07-22 round 644)", () => {
  const activatedAt = "2026-07-22T12:00:00.000Z";

  test("any observable premiere state verifies registration", () => {
    for (const state of [
      "draft",
      "scheduled",
      "playing",
      "checkpoint",
      "revealed",
    ]) {
      expect(
        decideActivationVerification(
          hold({ phase: "activated", activatedAt }),
          state,
          NOW,
        ),
      ).toEqual({ kind: "registered" });
    }
  });

  test("verification only applies to the activated phase", () => {
    for (const phase of ["claimed", "admitted", "live"] as const) {
      expect(decideActivationVerification(hold({ phase }), null, NOW)).toEqual({
        kind: "not_applicable",
      });
    }
  });

  test("an unregistered activated hold without a window stamp starts the window", () => {
    expect(
      decideActivationVerification(
        hold({ phase: "activated", activatedAt: null }),
        null,
        NOW,
      ),
    ).toEqual({ kind: "start_window" });
  });

  test("waits strictly inside the bounded window", () => {
    const inside = new Date(
      Date.parse(activatedAt) + PREMIERE_LOOP_ACTIVATION_VERIFY_MS - 1,
    );
    expect(
      decideActivationVerification(
        hold({ phase: "activated", activatedAt }),
        null,
        inside,
      ),
    ).toEqual({ kind: "wait" });
  });

  test("re-activates exactly once when the window elapses", () => {
    const elapsed = new Date(
      Date.parse(activatedAt) + PREMIERE_LOOP_ACTIVATION_VERIFY_MS,
    );
    expect(
      decideActivationVerification(
        hold({ phase: "activated", activatedAt, reactivationAttempts: 0 }),
        null,
        elapsed,
      ),
    ).toEqual({ kind: "reactivate" });
    expect(
      decideActivationVerification(
        hold({
          phase: "activated",
          activatedAt,
          reactivationAttempts: PREMIERE_LOOP_MAX_REACTIVATION_ATTEMPTS,
        }),
        null,
        elapsed,
      ),
    ).toEqual({ kind: "activation_lost" });
  });

  test("normalizeLoopHoldState nulls invalid stamps and floors bad retry counters", () => {
    const garbage = normalizeLoopHoldState(
      hold({
        activatedAt: "not-a-timestamp",
        reactivationAttempts: -3 as number,
      }),
    );
    expect(garbage.activatedAt).toBeNull();
    expect(garbage.reactivationAttempts).toBe(0);
    const kept = normalizeLoopHoldState(
      hold({ activatedAt, reactivationAttempts: 1 }),
    );
    expect(kept.activatedAt).toBe(activatedAt);
    expect(kept.reactivationAttempts).toBe(1);
  });

  test("terminates: a permanently unregistered premiere reaches activation_lost in bounded ticks", () => {
    // Simulate the loop's 61s tick cadence against a premiere that never
    // registers. The sequence must reach activation_lost without ever
    // repeating a non-terminal state indefinitely (no new unbounded states).
    let current = hold({
      phase: "activated",
      activatedAt,
      reactivationAttempts: 0,
    });
    const transitions: string[] = [];
    let released = false;
    for (let tick = 1; tick <= 10 && !released; tick += 1) {
      const now = new Date(Date.parse(activatedAt) + tick * 61_000);
      const decision = decideActivationVerification(current, null, now);
      transitions.push(decision.kind);
      if (decision.kind === "reactivate") {
        current = {
          ...current,
          reactivationAttempts: current.reactivationAttempts + 1,
          activatedAt: now.toISOString(),
        };
      } else if (decision.kind === "activation_lost") {
        released = true;
      } else if (decision.kind !== "wait") {
        throw new Error(`unexpected transition: ${decision.kind}`);
      }
    }
    expect(released).toBe(true);
    expect(transitions.filter((kind) => kind === "reactivate")).toHaveLength(
      PREMIERE_LOOP_MAX_REACTIVATION_ATTEMPTS,
    );
    // wait, wait(reactivate at 122s), then a fresh window, then lost: the
    // whole verification story fits comfortably inside the hold window.
    expect(transitions.length).toBeLessThanOrEqual(6);
    expect(transitions.at(-1)).toBe("activation_lost");
  });

  test("shadow mode still forbids the restart side effect the retry uses", () => {
    expect(loopSideEffectPlan(true).restart).toBe(false);
  });
});

describe("suppression contract construction (requirement #1 + standing quarantine)", () => {
  test("zero holds now builds the STANDING quarantine contract (2026-07-22 operator reversal of requirement #4)", () => {
    const contract = buildLoopSuppressionContract([], NOW);
    expect(contract.holds).toEqual([]);
    expect(contract.quarantineMs).toBe(
      PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
    );
    expect(contract.generatedAt).toBe(NOW.toISOString());
  });

  test("single-hold contract uses now as generatedAt (never future)", () => {
    const contract = buildLoopSuppressionContract([hold()], NOW);
    expect(contract.generatedAt).toBe(NOW.toISOString());
    expect(Date.parse(contract.generatedAt)).toBeLessThanOrEqual(NOW.getTime());
    expect(contract.holds).toHaveLength(1);
    // Only the spoiler-safe subset reaches the mirror.
    expect(Object.keys(contract.holds[0]).sort()).toEqual([
      "episodeRequestId",
      "holdExpiresAt",
      "mapLabel",
      "premiereId",
      "premierePageLive",
      "roundId",
      "roundNumber",
      "scheduledAt",
    ]);
  });

  test("round-trips through the mirror's tolerant parser as active", () => {
    const contract = buildLoopSuppressionContract(
      [hold({ premierePageLive: true })],
      NOW,
    );
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract),
      NOW,
    );
    expect(state.status).toBe("active");
    if (state.status !== "active") return;
    expect(state.contract.holds[0].premierePageLive).toBe(true);
    expect(state.contract.holds[0].mapLabel).toBe("Pangaea");
  });

  test("the zero-hold standing contract round-trips as active: quarantines fresh, publishes old, shows no premiere card", () => {
    const state = parsePremiereSuppressionContract(
      JSON.stringify(buildLoopSuppressionContract([], NOW)),
      NOW,
    );
    expect(state.status).toBe("active");
    // Fresh (1 min old) is deferred; old (20 min) publishes.
    expect(
      classifyEpisodeSuppression(
        state,
        {
          episodeRequestId: "ereq_fresh",
          completedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        },
        NOW,
      ),
    ).toBe("quarantined");
    expect(
      classifyEpisodeSuppression(
        state,
        {
          episodeRequestId: "ereq_old",
          completedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        },
        NOW,
      ),
    ).toBe("publish");
    // Zero holds means no league-page premiere card.
    expect(buildPremiereSiteBlock(state, NOW)).toBeNull();
  });

  test("written contract is readable at the canonical path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "premiere-loop-contract-"));
    try {
      const contractPath = premiereSuppressionContractPath(dir);
      const contract = buildLoopSuppressionContract([hold()], NOW);
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(contractPath), { recursive: true });
      await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
      const state = await loadPremiereSuppressionContract(contractPath, NOW);
      expect(state.status).toBe("active");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("every round premieres — the standing-quarantine decision table (2026-07-22)", () => {
  // One timeline, exercised through the exact production path at every stage:
  // buildLoopSuppressionContract -> JSON -> parsePremiereSuppressionContract
  // (the mirror's tolerant parser) -> classify/filter (the mirror's gates).
  const COMPLETED_AT = "2026-07-22T12:00:00.000Z";
  const T0 = Date.parse(COMPLETED_AT);
  const EPISODE = {
    episodeRequestId: "ereq_00000000-0000-0000-0000-00000000dead",
    completedAt: COMPLETED_AT,
  };
  const at = (offsetMs: number) => new Date(T0 + offsetMs);
  const parsedAt = (
    contract: PremiereSuppressionContract,
    now: Date,
  ): PremiereSuppressionState =>
    parsePremiereSuppressionContract(JSON.stringify(contract), now);
  const heldFor = (scheduledAt: string) =>
    hold({
      episodeRequestId: EPISODE.episodeRequestId,
      premiereId: derivePremiereId(EPISODE.episodeRequestId),
      scheduledAt,
      holdExpiresAt: holdExpiresAtForScheduled(scheduledAt),
    });

  test("stage 1 — freshly completed, no hold yet: the standing contract quarantines it (loop wins the race)", () => {
    const tick = at(60_000); // first loop tick after completion
    const state = parsedAt(buildLoopSuppressionContract([], tick), tick);
    expect(classifyEpisodeSuppression(state, EPISODE, tick)).toBe(
      "quarantined",
    );
    // The mirror's final-defense filter drops it from the merged list too.
    expect(filterSuppressedEpisodeRows(state, [EPISODE], tick)).toEqual([]);
  });

  test("stage 2 — claimed: the specific hold takes over", () => {
    const tick = at(70_000);
    const scheduledAt = scheduledAtForClaim(tick);
    const state = parsedAt(
      buildLoopSuppressionContract([heldFor(scheduledAt)], tick),
      tick,
    );
    expect(classifyEpisodeSuppression(state, EPISODE, tick)).toBe("held");
  });

  test("stage 3 — a premiere running past the 12-minute quarantine is carried by the HOLD, never the window", () => {
    const scheduledAt = scheduledAtForClaim(at(70_000));
    const midPlay = at(20 * 60_000); // beyond quarantineMs, inside the hold
    expect(20 * 60_000).toBeGreaterThan(
      PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
    );
    const withHold = parsedAt(
      buildLoopSuppressionContract(
        [{ ...heldFor(scheduledAt), premierePageLive: true }],
        midPlay,
      ),
      midPlay,
    );
    expect(classifyEpisodeSuppression(withHold, EPISODE, midPlay)).toBe("held");
    // Counterfactual: the standing contract alone would already publish it —
    // proving the hold (not the quarantine window) shields a long premiere.
    const withoutHold = parsedAt(
      buildLoopSuppressionContract([], midPlay),
      midPlay,
    );
    expect(classifyEpisodeSuppression(withoutHold, EPISODE, midPlay)).toBe(
      "publish",
    );
  });

  test("stage 4 — revealed + released: back to the standing contract; publishes at quarantine expiry", () => {
    // Typical premiere: revealed ~9 minutes after completion. Release swaps the
    // hold contract for the zero-hold standing contract.
    const releaseTick = at(9 * 60_000);
    const released = parsedAt(
      buildLoopSuppressionContract([], releaseTick),
      releaseTick,
    );
    expect(classifyEpisodeSuppression(released, EPISODE, releaseTick)).toBe(
      "quarantined", // still inside its own 12-minute window
    );
    const afterQuarantine = at(
      PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS + 60_000,
    );
    const laterState = parsedAt(
      buildLoopSuppressionContract([], afterQuarantine),
      afterQuarantine,
    );
    expect(
      classifyEpisodeSuppression(laterState, EPISODE, afterQuarantine),
    ).toBe("publish");
    expect(
      filterSuppressedEpisodeRows(laterState, [EPISODE], afterQuarantine),
    ).toEqual([EPISODE]);
  });

  test("stage 4b — declined episode (over budget / ingest failure): no hold, publishes at quarantine expiry", () => {
    // The loop never claims it, so only the standing contract applies: deferred
    // inside the window, published after — pathological rounds still publish.
    const inside = at(5 * 60_000);
    expect(
      classifyEpisodeSuppression(
        parsedAt(buildLoopSuppressionContract([], inside), inside),
        EPISODE,
        inside,
      ),
    ).toBe("quarantined");
    const outside = at(PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS + 1_000);
    expect(
      classifyEpisodeSuppression(
        parsedAt(buildLoopSuppressionContract([], outside), outside),
        EPISODE,
        outside,
      ),
    ).toBe("publish");
  });

  test("stage 5 — dead loop: the heartbeat stops and EVERYTHING publishes within the stale bound (fail-open)", () => {
    const lastHeartbeat = at(70_000);
    const scheduledAt = scheduledAtForClaim(lastHeartbeat);
    const holdContract = buildLoopSuppressionContract(
      [heldFor(scheduledAt)],
      lastHeartbeat,
    );
    const standingContract = buildLoopSuppressionContract([], lastHeartbeat);
    const afterStale = new Date(
      lastHeartbeat.getTime() + PREMIERE_SUPPRESSION_STALE_MS,
    );
    for (const contract of [holdContract, standingContract]) {
      const state = parsedAt(contract, afterStale);
      expect(state.status).toBe("stale");
      // Even an episode completed seconds ago publishes: availability first.
      const justCompleted = {
        episodeRequestId: "ereq_justnow",
        completedAt: new Date(afterStale.getTime() - 1_000).toISOString(),
      };
      expect(classifyEpisodeSuppression(state, EPISODE, afterStale)).toBe(
        "publish",
      );
      expect(classifyEpisodeSuppression(state, justCompleted, afterStale)).toBe(
        "publish",
      );
      expect(
        filterSuppressedEpisodeRows(
          state,
          [EPISODE, justCompleted],
          afterStale,
        ),
      ).toEqual([EPISODE, justCompleted]);
    }
  });
});

describe("admission input builders (exact shapes the admit CLI validates)", () => {
  test("eligibility input is the rated-public spoiler-resistant shape", () => {
    expect(buildLoopEligibilityInput()).toEqual({
      schemaVersion: 1,
      eligibilityCheckVersion: "premiere-loop/v1",
      externalEmbargoEvidence: [],
      externalOutcomeMayBePublic: true,
      publicLabel: "spoiler_resistant_premiere",
    });
  });

  test("definition input carries no outcome and exactly two checkpoints", () => {
    const definition = buildLoopPremiereDefinition({
      episodeRequestId: "ereq_0066320d-0c4f-443e-a941-c971e5e52301",
      coworldName: "proxywar",
      mapLabel: "World",
      variantName: "Tournament 12P - World",
      seatCount: 12,
      turnCount: 40_000,
      scheduledAt: "2026-07-22T12:06:00.000Z",
    });
    expect(definition.checkpoints).toHaveLength(2);
    expect(definition.checkpoints[0].sequence).toBe(14_000);
    expect(definition.checkpoints[1].sequence).toBe(26_000);
    // 40k turns > the 32k 1x band -> 2x under the 2026-07-22 retune.
    expect(definition.playbackRate).toBe(2);
    expect(definition.matchFormat).toEqual({
      id: "ffa-12",
      label: "Tournament 12P - World",
      seatCount: 12,
    });
    expect(definition.map).toEqual({ id: "World", label: "World" });
    // Spoiler-neutral: no winner/outcome language.
    const serialized = JSON.stringify(definition).toLowerCase();
    for (const spoiler of ["winner", "won", "defeat", "eliminat"]) {
      expect(serialized.includes(spoiler)).toBe(false);
    }
  });
});

describe("helper-refusal activation backoff (2026-07-22 round-649 outage)", () => {
  const backoffUntil = new Date(
    NOW.getTime() + PREMIERE_LOOP_ACTIVATION_BACKOFF_MS,
  ).toISOString();

  test("an armed backoff holds activation until its stamp elapses", () => {
    const armed = hold({
      phase: "admitted",
      activationAttempts: 1,
      activationBackoffUntil: backoffUntil,
    });
    expect(isActivationBackoffActive(armed, NOW)).toBe(true);
    expect(
      isActivationBackoffActive(armed, new Date(Date.parse(backoffUntil))),
    ).toBe(false);
  });

  test("no stamp or an invalid stamp never blocks an attempt (fail-open)", () => {
    expect(
      isActivationBackoffActive(hold({ activationBackoffUntil: null }), NOW),
    ).toBe(false);
    expect(
      isActivationBackoffActive(
        hold({ activationBackoffUntil: "not-a-timestamp" }),
        NOW,
      ),
    ).toBe(false);
  });

  test("fold normalizes pre-backoff journal records to an unarmed state", () => {
    const legacy = hold({ phase: "admitted" });
    const legacyShape = { ...legacy } as Record<string, unknown>;
    delete legacyShape.activationBackoffUntil;
    const folded = foldLoopJournal([
      {
        kind: "hold_update",
        ts: NOW.toISOString(),
        hold: legacyShape as unknown as LoopHoldState,
      },
    ]);
    expect(folded.activeHold?.activationBackoffUntil).toBeNull();
    const garbage = normalizeLoopHoldState(
      hold({ activationBackoffUntil: "garbage" }),
    );
    expect(garbage.activationBackoffUntil).toBeNull();
  });
});

describe("shadow-mode side-effect gate (safety proof)", () => {
  test("shadow permits ingest only; no suppress/pin/admit/restart", () => {
    // `writeSuppressionContract: false` covers BOTH contract writers — the
    // per-hold refresh AND the zero-hold standing heartbeat added by the
    // 2026-07-22 every-round directive. A shadow run writes no contract at
    // all, so it can never quarantine the live league feed.
    expect(loopSideEffectPlan(true)).toEqual({
      ingest: true,
      writeSuppressionContract: false,
      writeLatestPremierePointer: false,
      pinArtifacts: false,
      admit: false,
      restart: false,
    });
  });

  test("live permits the full pipeline", () => {
    expect(loopSideEffectPlan(false)).toEqual({
      ingest: true,
      writeSuppressionContract: true,
      writeLatestPremierePointer: true,
      pinArtifacts: true,
      admit: true,
      restart: true,
    });
  });
});

describe("isCompletedTooOldToSeal — cold-start / already-public pre-admission gate", () => {
  test("a round completed longer ago than the seal window is too old to seal", () => {
    // The reported cold-start churn: round 633's episode had completed ~40 min
    // earlier (already published by the mirror) and must be skipped pre-claim.
    const completedAt = new Date(NOW.getTime() - 40 * 60_000).toISOString();
    expect(isCompletedTooOldToSeal(completedAt, NOW)).toBe(true);
  });

  test("a freshly-completed round is still sealable", () => {
    // The default `round()` helper completes 90s before NOW — well inside the
    // window — and must NOT be gated.
    expect(isCompletedTooOldToSeal(round().completedAt, NOW)).toBe(false);
    const justNow = new Date(NOW.getTime() - 30_000).toISOString();
    expect(isCompletedTooOldToSeal(justNow, NOW)).toBe(false);
  });

  test("fail-open: null or unparseable completion time stays claimable", () => {
    expect(isCompletedTooOldToSeal(null, NOW)).toBe(false);
    expect(isCompletedTooOldToSeal("not-a-date", NOW)).toBe(false);
  });

  test("the boundary is strict: exactly at the window is not yet too old", () => {
    const atWindow = new Date(
      NOW.getTime() - PREMIERE_LOOP_SEAL_WINDOW_MS,
    ).toISOString();
    const pastWindow = new Date(
      NOW.getTime() - PREMIERE_LOOP_SEAL_WINDOW_MS - 1,
    ).toISOString();
    expect(isCompletedTooOldToSeal(atWindow, NOW)).toBe(false);
    expect(isCompletedTooOldToSeal(pastWindow, NOW)).toBe(true);
  });

  test("future completion (clock skew) is never too old", () => {
    const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    expect(isCompletedTooOldToSeal(future, NOW)).toBe(false);
  });

  test("the seal window equals the hold window and honours a custom override", () => {
    expect(PREMIERE_LOOP_SEAL_WINDOW_MS).toBe(PREMIERE_LOOP_HOLD_WINDOW_MS);
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(isCompletedTooOldToSeal(tenMinAgo, NOW, 5 * 60_000)).toBe(true);
    expect(isCompletedTooOldToSeal(tenMinAgo, NOW, 15 * 60_000)).toBe(false);
  });

  test("the newest completed round is claim-decided, then gated pre-admission when too old", () => {
    // decideLoopClaim still selects the newest round; the loop then applies the
    // seal-window gate BEFORE downloading or admitting it. This composition is
    // exactly what runLiveIteration wires: claim -> too-old check -> skip.
    const staleCompletedAt = new Date(
      NOW.getTime() - 45 * 60_000,
    ).toISOString();
    const decision = decideLoopClaim({
      rounds: [
        round({
          id: "round_633",
          roundNumber: 633,
          status: "completed",
          completedAt: staleCompletedAt,
        }),
      ],
      folded: foldLoopJournal([]),
    });
    expect(decision.kind).toBe("claim");
    if (decision.kind !== "claim") return;
    // The gate the orchestrator applies to decision.round before claimRound.
    expect(isCompletedTooOldToSeal(decision.round.completedAt, NOW)).toBe(true);
  });
});
