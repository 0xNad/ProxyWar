import { describe, expect, it } from "vitest";
import {
  buildAgentMatchRecap,
  type AgentMatchRecapBeat,
} from "../../src/server/agents/AgentMatchRecap";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import type { AgentDecisionRecord, LegalActionKind } from "../../src/server/agents/AgentTypes";
import type { AgentRunFinalState } from "../../src/server/agents/AgentDecisionLogWriter";

// Same synthetic-record/finalState convention `DirectorCutPlan.test.ts`
// already established — `buildAgentSpectatorTelemetry` is the real,
// unmocked producer of the `SpectatorEvent[]` `buildAgentMatchRecap`
// consumes, so these fixtures exercise the actual event-derivation pipeline,
// not a hand-rolled telemetry stub.

function record(
  sequence: number,
  turnNumber: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null> = {},
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "MATCH-RECAP",
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
    result: { accepted: true, reason: "ok", submittedIntent: null },
    fallbackUsed: false,
  } as AgentDecisionRecord;
}

const ROSTER = [
  { agentID: "a1", username: "Atlas", profile: "diplomatic" as const, clientID: "c1", brainType: "planner-executor" as const },
  { agentID: "a2", username: "Blitz", profile: "aggressive" as const, clientID: "c2", brainType: "planner-executor" as const },
  { agentID: "a3", username: "Cinder", profile: "opportunistic" as const, clientID: "c3", brainType: "planner-executor" as const },
];

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

/** Alliance, a first strike, a repeat attack on the same pair (must NOT re-trigger first strike), a betrayal, a late-match repeat attack inside the endgame window (the final confrontation candidate), and an elimination at match end. */
function dramaticRecords(totalTurns: number): AgentDecisionRecord[] {
  return [
    record(1, 500, "a1", "Atlas", "p-a1", "alliance_request", {
      recipientID: "p-a2",
      recipientName: "Blitz",
    }),
    record(2, 501, "a2", "Blitz", "p-a2", "alliance_request", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }),
    record(3, 2000, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(4, 2100, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(5, 5000, "a2", "Blitz", "p-a2", "break_alliance", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }),
    record(6, totalTurns - 100, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
  ];
}

describe("buildAgentMatchRecap", () => {
  it("curates the War Room vocabulary: alliance, first strike (once per pair), betrayal, final confrontation, and elimination", () => {
    const totalTurns = 10_000;
    const records = dramaticRecords(totalTurns);
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-1",
      records,
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: false },
      ]),
    });
    const recap = buildAgentMatchRecap({
      runID: "run-1",
      telemetry,
      finalTurnCount: totalTurns,
    });
    expect(recap).not.toBeNull();
    const kinds = recap?.beats.map((beat) => beat.kind);
    expect(kinds).toEqual([
      "alliance",
      "first_strike",
      "betrayal",
      "final_confrontation",
      "elimination",
    ]);
    const turns = recap?.beats.map((beat) => beat.turnNumber);
    expect(turns).toEqual([501, 2000, 5000, totalTurns - 100, totalTurns]);
    expect(recap?.beats[1].message).toBe("Blitz strikes first against Cinder.");
    expect(recap?.beats[3].message).toContain("Final clash:");
    expect(recap?.beats[4].message).toBe("Cinder is eliminated.");
    expect(recap?.summary.length).toBeGreaterThan(0);
    // Never a second first-strike beat for the repeat a2->a3 attack at turn 2100.
    const firstStrikeCount = recap?.beats.filter(
      (beat: AgentMatchRecapBeat) => beat.kind === "first_strike",
    ).length;
    expect(firstStrikeCount).toBe(1);
  });

  it("returns null — never a padded placeholder — for a match with no story-worthy events", () => {
    const totalTurns = 1000;
    const records = [
      record(1, 1, "a1", "Atlas", "p-a1", "spawn"),
      record(2, 2, "a2", "Blitz", "p-a2", "spawn"),
      record(3, 50, "a1", "Atlas", "p-a1", "hold"),
      record(4, 60, "a2", "Blitz", "p-a2", "attack", { expansion: true }),
    ];
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-quiet",
      records,
      roster: ROSTER.slice(0, 2),
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
      ]),
    });
    const recap = buildAgentMatchRecap({
      runID: "run-quiet",
      telemetry,
      finalTurnCount: totalTurns,
    });
    expect(recap).toBeNull();
  });

  it("is deterministic — identical input produces identical beats/summary", () => {
    const totalTurns = 10_000;
    const records = dramaticRecords(totalTurns);
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-det",
      records,
      roster: ROSTER,
      finalState: finalState(totalTurns, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
        { agentID: "a3", username: "Cinder", isAlive: false },
      ]),
    });
    const input = { runID: "run-det", telemetry, finalTurnCount: totalTurns };
    const first = buildAgentMatchRecap(input);
    const second = buildAgentMatchRecap(input);
    expect(first?.beats).toEqual(second?.beats);
    expect(first?.summary).toEqual(second?.summary);
  });

  it("falls back to the telemetry's own max event turn when finalTurnCount is null", () => {
    const records = [
      record(1, 100, "a1", "Atlas", "p-a1", "alliance_request", {
        recipientID: "p-a2",
        recipientName: "Blitz",
      }),
      record(2, 101, "a2", "Blitz", "p-a2", "alliance_request", {
        recipientID: "p-a1",
        recipientName: "Atlas",
      }),
    ];
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "run-degraded",
      records,
      roster: ROSTER.slice(0, 2),
      // finalState IS supplied so target-agent resolution works (playerID
      // needs a source — see AgentSpectatorTelemetry.ts's
      // `playerIDFromRecords` fallback, which this fixture's records don't
      // populate via `audit`); the point of this test is `finalTurnCount:
      // null` below overriding buildAgentMatchRecap's OWN fallback, not
      // whatever turnCount `finalState` happens to carry.
      finalState: finalState(9999, [
        { agentID: "a1", username: "Atlas", isAlive: true },
        { agentID: "a2", username: "Blitz", isAlive: true },
      ]),
    });
    const recap = buildAgentMatchRecap({
      runID: "run-degraded",
      telemetry,
      finalTurnCount: null,
    });
    expect(recap).not.toBeNull();
    expect(recap?.beats).toEqual([
      {
        turnNumber: 101,
        kind: "alliance",
        message: "Blitz and Atlas form an alliance.",
      },
    ]);
  });
});
