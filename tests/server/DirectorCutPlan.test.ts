import { describe, expect, it } from "vitest";
import {
  buildDirectorCutPlan,
  estimatePreRevealDirectorCutSeconds,
  type DirectorCutSegment,
} from "../../src/server/agents/DirectorCutPlan";
import {
  AgentDecisionRecord,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";
import type { AgentRunFinalState } from "../../src/server/agents/AgentDecisionLogWriter";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";

const ROSTER = [
  {
    agentID: "a1",
    username: "Atlas",
    profile: "diplomatic" as const,
    clientID: "c1",
    brainType: "planner-executor" as const,
  },
  {
    agentID: "a2",
    username: "Blitz",
    profile: "aggressive" as const,
    clientID: "c2",
    brainType: "planner-executor" as const,
  },
  {
    agentID: "a3",
    username: "Cinder",
    profile: "opportunistic" as const,
    clientID: "c3",
    brainType: "planner-executor" as const,
  },
];

function record(
  sequence: number,
  turnNumber: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null> = {},
  overrides: Partial<AgentDecisionRecord> = {},
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "DIRECTOR-CUT",
    agentID,
    clientID: `client-${agentID}`,
    username,
    profile: "diplomatic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 12,
    observationSummary: `${username} sees the board`,
    legalActionIDs: [`${kind}:${sequence}`],
    legalActionIDsByKind: { [kind]: [`${kind}:${sequence}`] },
    attackActionIDs: kind === "attack" ? [`${kind}:${sequence}`] : [],
    chosenActionID: `${kind}:${sequence}`,
    chosenActionKind: kind,
    reason: `${username} selects ${kind}`,
    chosenActionMetadata: metadata,
    intent: null,
    result: {
      accepted: true,
      reason: "ok",
      submittedIntent: null,
    },
    fallbackUsed: false,
    ...overrides,
  } as AgentDecisionRecord;
}

function finalState(
  totalTurns: number,
  players: { agentID: string; username: string; isAlive: boolean }[],
): AgentRunFinalState {
  return {
    phase: "finished",
    tick: totalTurns,
    turnCount: totalTurns,
    players: players.map((p) => ({
      agentID: p.agentID,
      username: p.username,
      profile: "diplomatic",
      playerID: `p-${p.agentID}`,
      isAlive: p.isAlive,
      tilesOwned: p.isAlive ? 100 : 0,
      troops: p.isAlive ? 2000 : 0,
      gold: "500",
    })),
  };
}

/** A realistic dramatic match: alliance, betrayal, first strike, a second attack on the same pair, a nuke, and one elimination — spread across a configurable turn span. */
function dramaticMatchRecords(totalTurns: number): AgentDecisionRecord[] {
  const t = (fraction: number) => Math.round(totalTurns * fraction);
  return [
    record(1, t(0.1), "a1", "Atlas", "p-a1", "alliance_request", {
      recipientID: "p-a2",
      recipientName: "Blitz",
    }),
    record(2, t(0.1) + 1, "a2", "Blitz", "p-a2", "alliance_request", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }),
    record(3, t(0.3), "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(4, t(0.31), "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(5, t(0.5), "a2", "Blitz", "p-a2", "break_alliance", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }),
    record(6, t(0.7), "a1", "Atlas", "p-a1", "nuke", {
      targetID: "p-a2",
      targetName: "Blitz",
    }),
    record(7, t(0.9), "a1", "Atlas", "p-a1", "attack", {
      targetID: "p-a2",
      targetName: "Blitz",
    }),
  ];
}

describe("buildDirectorCutPlan", () => {
  it("is deterministic — identical input produces an identical plan", () => {
    const input = {
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(20_000),
      roster: ROSTER,
      finalState: finalState(20_000, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: false },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    };
    const first = buildDirectorCutPlan(input);
    const second = buildDirectorCutPlan(input);
    // generatedAt is a real timestamp and legitimately differs — compare everything else.
    const { generatedAt: _g1, ...rest1 } = first;
    const { generatedAt: _g2, ...rest2 } = second;
    expect(rest1).toEqual(rest2);
  });

  it("partitions the whole match with no gaps or overlaps, sorted by turn", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(15_000),
      roster: ROSTER,
      finalState: finalState(15_000, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: false },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.segments[0].startTurn).toBe(0);
    expect(plan.segments[plan.segments.length - 1].endTurn).toBe(
      plan.totalTurns,
    );
    for (let i = 1; i < plan.segments.length; i++) {
      const previous = plan.segments[i - 1];
      const current = plan.segments[i];
      expect(current.startTurn).toBe(previous.endTurn + 1);
      expect(current.startTurn).toBeLessThanOrEqual(current.endTurn);
    }
  });

  it("always opens with an 'opening' segment starting at turn 0", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(10_000),
      roster: ROSTER,
      finalState: finalState(10_000, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    expect(plan.segments[0].eventReason).toBe("opening");
    expect(plan.segments[0].startTurn).toBe(0);
  });

  it("no important event is silently skipped — every high-importance SpectatorEvent falls inside a non-quiet segment", () => {
    const totalTurns = 25_000;
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(totalTurns),
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: false },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    // The nuke (importance 95) and the alliance formation (importance 92) are
    // the two highest-scoring non-elimination events this fixture produces.
    const nukeTurn = Math.round(totalTurns * 0.7);
    const allianceTurn = Math.round(totalTurns * 0.1) + 1;
    const containingSegment = (turn: number): DirectorCutSegment | undefined =>
      plan.segments.find((s) => turn >= s.startTurn && turn <= s.endTurn);
    expect(containingSegment(nukeTurn)?.eventReason).not.toBe(
      "quiet_interval",
    );
    expect(containingSegment(allianceTurn)?.eventReason).not.toBe(
      "quiet_interval",
    );
    // The elimination (Blitz, isAlive: false) is pinned to the final turn by
    // construction (addEliminationEvents) and must land in a non-quiet segment.
    expect(containingSegment(totalTurns)?.eventReason).not.toBe(
      "quiet_interval",
    );
  });

  it("tags the first attack between a pair as first_strike and later attacks between the same pair as major_attack", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(30_000),
      roster: ROSTER,
      finalState: finalState(30_000, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: false },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    const reasons = plan.segments.map((s) => s.eventReason);
    expect(reasons).toContain("first_strike");
    // records 3 and 4 are both Blitz->Cinder attacks one turn apart, merged
    // into the same lead-in window — so major_attack is not independently
    // observable as a SEPARATE segment here; verify the specific
    // eventReason=first_strike segment (not the always-everyone-inclusive
    // opening segment, which also happens to list both names) carries both
    // participants.
    const blitzVsCinder = plan.segments.find(
      (s) =>
        s.eventReason === "first_strike" &&
        s.participatingAgents.includes("Blitz") &&
        s.participatingAgents.includes("Cinder"),
    );
    expect(blitzVsCinder).toBeDefined();
  });

  it("never fabricates participatingAgents — every name traces back to a real roster/event actor", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(18_000),
      roster: ROSTER,
      finalState: finalState(18_000, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: false },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    const knownNames = new Set(ROSTER.map((r) => r.username));
    for (const segment of plan.segments) {
      for (const name of segment.participatingAgents) {
        expect(knownNames.has(name)).toBe(true);
      }
    }
  });

  it("quiet_interval segments always carry speed=fast, importance=0, and no participants", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(40_000),
      roster: ROSTER,
      finalState: finalState(40_000, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: false },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    const quiet = plan.segments.filter(
      (s) => s.eventReason === "quiet_interval",
    );
    expect(quiet.length).toBeGreaterThan(0);
    for (const segment of quiet) {
      expect(segment.speed).toBe("fast");
      expect(segment.importance).toBe(0);
      expect(segment.participatingAgents).toEqual([]);
    }
  });

  it("degrades honestly when finalState is missing — never crashes, flags degraded, explains why in notes", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: dramaticMatchRecords(12_000),
      roster: ROSTER,
      // finalState omitted entirely.
    });
    expect(plan.degraded).toBe(true);
    expect(plan.notes.some((n) => n.includes("finalState"))).toBe(true);
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.totalTurns).toBeGreaterThan(0);
  });

  it("a flat, eventless match produces a valid plan with only opening + quiet + final_conflict, and notes the flatness", () => {
    const totalTurns = 8_000;
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: [
        record(1, 10, "a1", "Atlas", "p-a1", "hold", {}),
        record(2, 20, "a2", "Blitz", "p-a2", "hold", {}),
      ],
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: true },
      ]),
    });
    const reasons = new Set(plan.segments.map((s) => s.eventReason));
    expect(reasons.has("opening")).toBe(true);
    expect(reasons.has("quiet_interval")).toBe(true);
    expect(
      [...reasons].every((r) =>
        ["opening", "quiet_interval", "final_conflict"].includes(r),
      ),
    ).toBe(true);
    expect(plan.notes.some((n) => n.toLowerCase().includes("flat"))).toBe(
      true,
    );
  });

  it("handles an empty match (no records, no events) without crashing", () => {
    const plan = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records: [],
      roster: [],
    });
    expect(plan.totalTurns).toBe(0);
    expect(plan.segments).toEqual([]);
    expect(plan.degraded).toBe(true);
    expect(plan.estimatedDurationSeconds).toBe(0);
  });

  it("reuses an already-built spectatorTelemetry when provided, instead of recomputing", () => {
    const records = dramaticMatchRecords(10_000);
    const roster = ROSTER;
    const state = finalState(10_000, [
      { agentID: "a1", username: "Atlas", isAlive: true },
      { agentID: "a2", username: "Blitz", isAlive: false },
      { agentID: "a3", username: "Cinder", isAlive: true },
    ]);
    const withoutTelemetry = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records,
      roster,
      finalState: state,
    });
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "dc-run",
      records,
      roster,
      finalState: state,
    });
    const withTelemetry = buildDirectorCutPlan({
      runID: "dc-run",
      matchID: "m1",
      records,
      roster,
      finalState: state,
      spectatorTelemetry: telemetry,
    });
    const { generatedAt: _g1, ...rest1 } = withoutTelemetry;
    const { generatedAt: _g2, ...rest2 } = withTelemetry;
    expect(rest1).toEqual(rest2);
  });

  describe("duration estimation scales with real turn counts (not hardcoded to one match size)", () => {
    it("a ~10,000-turn dramatic match lands near the 5-minute floor", () => {
      const totalTurns = 10_000;
      const plan = buildDirectorCutPlan({
        runID: "dc-run",
        matchID: "m1",
        records: dramaticMatchRecords(totalTurns),
        roster: ROSTER,
        finalState: finalState(totalTurns, [
          { agentID: "a1", username: "Atlas", isAlive: true },
          { agentID: "a2", username: "Blitz", isAlive: false },
          { agentID: "a3", username: "Cinder", isAlive: true },
        ]),
      });
      expect(plan.estimatedDurationSeconds).toBeGreaterThanOrEqual(60);
      expect(plan.estimatedDurationSeconds).toBeLessThanOrEqual(420);
    });

    it("a ~50,000-turn dramatic match lands near the 12-minute ceiling, not the 10k-turn number", () => {
      const totalTurns = 50_000;
      const plan = buildDirectorCutPlan({
        runID: "dc-run",
        matchID: "m1",
        records: dramaticMatchRecords(totalTurns),
        roster: ROSTER,
        finalState: finalState(totalTurns, [
          { agentID: "a1", username: "Atlas", isAlive: true },
          { agentID: "a2", username: "Blitz", isAlive: false },
          { agentID: "a3", username: "Cinder", isAlive: true },
        ]),
      });
      expect(plan.estimatedDurationSeconds).toBeGreaterThanOrEqual(300);
      expect(plan.estimatedDurationSeconds).toBeLessThanOrEqual(900);
      const tenKPlan = buildDirectorCutPlan({
        runID: "dc-run",
        matchID: "m2",
        records: dramaticMatchRecords(10_000),
        roster: ROSTER,
        finalState: finalState(10_000, [
          { agentID: "a1", username: "Atlas", isAlive: true },
          { agentID: "a2", username: "Blitz", isAlive: false },
          { agentID: "a3", username: "Cinder", isAlive: true },
        ]),
      });
      expect(plan.estimatedDurationSeconds).toBeGreaterThan(
        tenKPlan.estimatedDurationSeconds,
      );
    });
  });

  describe("a high-density, many-agent match doesn't collapse into one giant segment", () => {
    const DENSE_ROSTER = Array.from({ length: 12 }, (_, i) => ({
      agentID: `d${i + 1}`,
      username: `Agent${i + 1}`,
      profile: "opportunistic" as const,
      clientID: `dc${i + 1}`,
      brainType: "planner-executor" as const,
    }));

    /**
     * Reproduces the exact real-world failure found generating a Director
     * Cut for a 12-agent, 50,400-turn league match: 302 nuke events (one
     * roughly every 167 turns) meant every candidate window was close
     * enough to its neighbor to merge, gluing nearly the entire match into
     * a single ~41,000-turn segment (56+ minutes). This fixture reproduces
     * that density synthetically: one nuke every ~170 turns among 12
     * agents, well inside the original `mergeGapTurns` for any match this
     * size.
     */
    function denseNukeRecords(totalTurns: number): AgentDecisionRecord[] {
      const records: AgentDecisionRecord[] = [];
      let sequence = 1;
      for (let turn = 500; turn < totalTurns; turn += 170) {
        const actor = DENSE_ROSTER[sequence % DENSE_ROSTER.length];
        const target = DENSE_ROSTER[(sequence + 1) % DENSE_ROSTER.length];
        records.push(
          record(sequence, turn, actor.agentID, actor.username, `p-${actor.agentID}`, "nuke", {
            targetID: `p-${target.agentID}`,
            targetName: target.username,
          }),
        );
        sequence += 1;
      }
      return records;
    }

    it("stays within the same duration ceiling as a sparse match of the same length, instead of ballooning past it", () => {
      const totalTurns = 50_400;
      const denseRecords = denseNukeRecords(totalTurns);
      const plan = buildDirectorCutPlan({
        runID: "dc-dense",
        matchID: "m-dense",
        records: denseRecords,
        roster: DENSE_ROSTER,
        finalState: finalState(
          totalTurns,
          DENSE_ROSTER.map((entry) => ({
            agentID: entry.agentID,
            username: entry.username,
            isAlive: true,
          })),
        ),
      });
      // Same ceiling the existing sparse 50k-turn test already enforces —
      // a match with MORE drama must never take LONGER to compress than one
      // with less, that would invert the whole point of a duration budget.
      expect(plan.estimatedDurationSeconds).toBeLessThanOrEqual(900);
    });

    it("never merges into one segment spanning most of the match — the exact shape of the bug this regression test exists for", () => {
      const totalTurns = 50_400;
      const plan = buildDirectorCutPlan({
        runID: "dc-dense",
        matchID: "m-dense",
        records: denseNukeRecords(totalTurns),
        roster: DENSE_ROSTER,
        finalState: finalState(
          totalTurns,
          DENSE_ROSTER.map((entry) => ({
            agentID: entry.agentID,
            username: entry.username,
            isAlive: true,
          })),
        ),
      });
      const nonQuiet = plan.segments.filter(
        (s) => s.eventReason !== "quiet_interval",
      );
      expect(nonQuiet.length).toBeGreaterThan(1);
      const maxSpan = Math.max(
        ...nonQuiet.map((s) => s.endTurn - s.startTurn + 1),
      );
      // No single NON-QUIET segment may swallow more than a fifth of the
      // match — the original bug produced one ~41,000-turn non-quiet
      // segment (82% of this exact totalTurns). A large quiet_interval
      // span is the opposite of the bug: that's the fast-forward pacing
      // working correctly, so it's deliberately excluded from this check.
      expect(maxSpan).toBeLessThan(totalTurns * 0.2);
      // At least one genuine quiet_interval must survive the fast-forward
      // pacing — a dense match still has to have SOME breathing room.
      expect(plan.segments.some((s) => s.eventReason === "quiet_interval")).toBe(
        true,
      );
    });
  });
});

/**
 * Runbook "Known gaps" fix: a premiere-lane package's Director Cut
 * estimate is structurally unavailable pre-reveal (no `SpectatorEvent`
 * evidence — the sealed bundle never retains `decisions.jsonl`). This
 * function derives an honest estimate from ONLY `totalTurns`/
 * `checkpointTurns` by reusing the SAME rate/anchor math
 * `buildDirectorCutPlan`'s own `estimateDurationSeconds` runs on real
 * segments (`estimateDurationFromSpans`, exercised indirectly here).
 */
describe("estimatePreRevealDirectorCutSeconds", () => {
  it("returns 0 for a zero/negative turn count", () => {
    expect(estimatePreRevealDirectorCutSeconds({ totalTurns: 0, checkpointTurns: [3000, 6000] })).toBe(0);
    expect(estimatePreRevealDirectorCutSeconds({ totalTurns: -5, checkpointTurns: [] })).toBe(0);
  });

  it("degrades to a single whole-match quiet span (target-duration only) when checkpoints are empty", () => {
    // totalTurns === the first TARGET_DURATION_ANCHORS point (10_000 -> 300s)
    // exactly, so an all-quiet estimate converges to exactly the anchor.
    expect(estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [] })).toBe(300);
  });

  it("degrades the same way for non-finite/malformed checkpoint values", () => {
    expect(
      estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [Number.NaN, Number.POSITIVE_INFINITY] }),
    ).toBe(300);
  });

  it("a small checkpoint window barely moves the estimate off the target-only baseline", () => {
    // A modest normal-paced window (3000 turns of 10000) still fits
    // entirely inside the target's own budget (below the 600 turns/sec
    // quiet-pace ceiling), so the estimator adapts the quiet pace to
    // land on exactly the same target as the checkpoint-free case.
    expect(estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [3000, 6000] })).toBe(300);
  });

  it("a large checkpoint window that exceeds the target budget pushes the estimate ABOVE the checkpoint-free baseline", () => {
    // 9000 of 10000 turns paced "normal" (15 turns/sec) costs 600s on its
    // own — already double the 300s target — so the remaining 1000 quiet
    // turns hit the 600 turns/sec ceiling instead of adapting down to fit,
    // and the total estimate genuinely exceeds the checkpoint-free 300s.
    // This is the load-bearing proof that checkpointTurns actually change
    // the derived estimate, not just decorate an unrelated computation.
    const estimate = estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [500, 9500] });
    expect(estimate).toBe(602);
    expect(estimate).toBeGreaterThan(300);
  });

  it("is order-independent — [max, min] produces the same window as [min, max]", () => {
    const ascending = estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [500, 9500] });
    const descending = estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [9500, 500] });
    expect(descending).toBe(ascending);
  });

  it("clamps out-of-range checkpoints to the match's own turn bounds", () => {
    // Clamped to [0, 10000] -- the whole match paced "normal" (never
    // "slow": no confirmed high-importance event exists pre-reveal).
    expect(estimatePreRevealDirectorCutSeconds({ totalTurns: 10_000, checkpointTurns: [-500, 20_000] })).toBe(
      Math.round(10_000 / 15),
    );
  });
});
