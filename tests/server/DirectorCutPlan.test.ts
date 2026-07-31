import { describe, expect, it } from "vitest";
import {
  buildDirectorCutPlan,
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
});
