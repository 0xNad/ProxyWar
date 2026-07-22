import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadPremiereSuppressionContract,
  parsePremiereSuppressionContract,
  premiereSuppressionContractPath,
} from "../../../src/server/agents/CoworldLeaguePremiereSuppression";
import {
  PREMIERE_ID_PATTERN,
  isPremiereId,
} from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  PREMIERE_LOOP_HOLD_WINDOW_MS,
  PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS,
  PREMIERE_LOOP_SCHEDULE_LEAD_MS,
  PREMIERE_LOOP_SEAL_WINDOW_MS,
  PREMIERE_LOOP_TURN_STARTUP_BUDGET,
  buildLoopEligibilityInput,
  buildLoopPremiereDefinition,
  buildLoopSuppressionContract,
  ceilToMinuteIso,
  checkpointSequencesForTurnCount,
  decideLoopClaim,
  deriveCheckpointId,
  derivePremiereId,
  foldLoopJournal,
  holdExpiresAtForScheduled,
  isCompletedTooOldToSeal,
  isHoldExpired,
  isManagedPublicRunKey,
  isTurnCountWithinStartupBudget,
  loopSideEffectPlan,
  mapLabelFromVariantName,
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
    expect(playbackRateForTurnCount(9_999)).toBe(1);
    expect(playbackRateForTurnCount(10_000)).toBe(2);
    expect(playbackRateForTurnCount(30_000)).toBe(2);
    expect(playbackRateForTurnCount(30_001)).toBe(4);
    expect(playbackRateForTurnCount(50_000)).toBe(4);
  });

  test("checkpoints at 0.35x/0.65x rounded", () => {
    expect(checkpointSequencesForTurnCount(1000)).toEqual([350, 650]);
    expect(checkpointSequencesForTurnCount(12_345)).toEqual([4321, 8024]);
  });
});

describe("startup budget bound", () => {
  test("accepts within budget, rejects over budget and non-positive", () => {
    expect(isTurnCountWithinStartupBudget(34_000)).toBe(true);
    expect(isTurnCountWithinStartupBudget(34_001)).toBe(false);
    expect(
      isTurnCountWithinStartupBudget(PREMIERE_LOOP_TURN_STARTUP_BUDGET),
    ).toBe(true);
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
});

describe("suppression contract construction (requirements #1 and #4)", () => {
  test("null for zero holds — never a blanket-quarantine contract", () => {
    expect(buildLoopSuppressionContract([], NOW)).toBeNull();
  });

  test("single-hold contract uses now as generatedAt (never future)", () => {
    const contract = buildLoopSuppressionContract([hold()], NOW);
    expect(contract).not.toBeNull();
    if (contract === null) return;
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
    if (contract === null) throw new Error("expected a contract");
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract),
      NOW,
    );
    expect(state.status).toBe("active");
    if (state.status !== "active") return;
    expect(state.contract.holds[0].premierePageLive).toBe(true);
    expect(state.contract.holds[0].mapLabel).toBe("Pangaea");
  });

  test("written contract is readable at the canonical path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "premiere-loop-contract-"));
    try {
      const contractPath = premiereSuppressionContractPath(dir);
      const contract = buildLoopSuppressionContract([hold()], NOW);
      if (contract === null) throw new Error("expected a contract");
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
    expect(definition.playbackRate).toBe(4);
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

describe("shadow-mode side-effect gate (safety proof)", () => {
  test("shadow permits ingest only; no suppress/pin/admit/restart", () => {
    expect(loopSideEffectPlan(true)).toEqual({
      ingest: true,
      writeSuppressionContract: false,
      pinArtifacts: false,
      admit: false,
      restart: false,
    });
  });

  test("live permits the full pipeline", () => {
    expect(loopSideEffectPlan(false)).toEqual({
      ingest: true,
      writeSuppressionContract: true,
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
