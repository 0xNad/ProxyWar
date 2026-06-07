import { describe, expect, it } from "vitest";
import { buildAgentDramaReport } from "../../src/server/agents/AgentDramaReport";
import {
  AgentDecisionRecord,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

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
];

describe("AgentDramaReport", () => {
  it("scores alliance + betrayal + attack as a dramatic, outcome-anchored match", () => {
    const report = buildAgentDramaReport({
      runID: "drama-run",
      matchID: "m1",
      scenario: "self-play",
      brainMode: "planner-executor",
      roster: ROSTER,
      records: [
        record(1, "a1", "Atlas", "p1", "alliance_request", {
          recipientID: "p2",
          recipientName: "Blitz",
        }),
        record(2, "a2", "Blitz", "p2", "alliance_request", {
          recipientID: "p1",
          recipientName: "Atlas",
        }),
        record(3, "a2", "Blitz", "p2", "break_alliance", {
          recipientID: "p1",
          recipientName: "Atlas",
        }),
        record(4, "a2", "Blitz", "p2", "attack", {
          targetID: "p1",
          targetName: "Atlas",
        }),
        record(5, "a1", "Atlas", "p1", "attack", {
          targetID: "p2",
          targetName: "Blitz",
        }),
      ],
      finalState: {
        phase: "finished",
        tick: 50,
        turnCount: 500,
        players: [
          {
            agentID: "a1",
            username: "Atlas",
            profile: "diplomatic",
            playerID: "p1",
            isAlive: false,
            tilesOwned: 0,
            troops: 0,
            gold: "0",
          },
          {
            agentID: "a2",
            username: "Blitz",
            profile: "aggressive",
            playerID: "p2",
            isAlive: true,
            tilesOwned: 100,
            troops: 2000,
            gold: "500",
          },
        ],
      },
    });

    expect(report.politicalActorCount).toBe(2);
    expect(report.allianceFormedCount).toBeGreaterThanOrEqual(1);
    expect(report.allianceBrokenCount).toBeGreaterThanOrEqual(1);
    expect(report.betrayalCount).toBe(report.allianceBrokenCount);
    expect(report.eliminationCount).toBeGreaterThanOrEqual(1);
    expect(report.mutualWarCount).toBeGreaterThanOrEqual(1);
    // Blitz betrayed Atlas and ended alive with more tiles -> betrayal paid off.
    expect(report.betrayalsPaidOff).toBeGreaterThanOrEqual(1);
    expect(report.dramaScore).toBeGreaterThan(0);
    expect(report.dramaGrade).not.toBe("flat");

    const blitz = report.agents.find((agent) => agent.agentID === "a2");
    const atlas = report.agents.find((agent) => agent.agentID === "a1");
    expect(blitz?.alliancesBroken).toBeGreaterThanOrEqual(1);
    expect(atlas?.betrayalsSuffered).toBeGreaterThanOrEqual(1);
  });

  it("reports a flat, ~0 drama score for a single-agent match and explains why", () => {
    const report = buildAgentDramaReport({
      runID: "solo-run",
      matchID: "m2",
      scenario: "agent-vs-nations",
      brainMode: "planner-executor",
      roster: [ROSTER[0]!],
      records: [
        record(1, "a1", "Atlas", "p1", "attack", {
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
        }),
      ],
    });

    expect(report.politicalActorCount).toBe(1);
    expect(report.dramaScore).toBe(0);
    expect(report.dramaGrade).toBe("flat");
    expect(report.notes.join(" ")).toContain("self-play");
  });
});

function record(
  sequence: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null>,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "DRAMA",
    agentID,
    clientID: `client-${agentID}`,
    username,
    profile: agentID === "a1" ? "diplomatic" : "aggressive",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
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
  };
}
