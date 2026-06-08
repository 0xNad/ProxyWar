import { describe, expect, it } from "vitest";
import { Relation } from "../../src/core/game/Game";
import { AgentOpponentModelEntry } from "../../src/server/agents/AgentTypes";
import { scoreToMAccuracy } from "../../src/server/agents/AgentToMAccuracy";

function entry(
  over: Partial<AgentOpponentModelEntry> & { playerID: string },
): AgentOpponentModelEntry {
  return {
    name: over.playerID,
    tileShare: 0.1,
    relation: Relation.Neutral,
    isAllied: false,
    momentum: "flat",
    attacksOnMe: 0,
    betrayedMe: false,
    isLeader: false,
    lastSignal: null,
    threat: "low",
    trust: 0.5,
    predictedNextAction: "stable",
    ...over,
  };
}

describe("scoreToMAccuracy", () => {
  it("scores territory predictions against the next snapshot", () => {
    const report = scoreToMAccuracy([
      [
        entry({ playerID: "A", predictedNextAction: "expanding", tileShare: 0.1 }),
        entry({ playerID: "B", predictedNextAction: "losing_ground", tileShare: 0.2 }),
      ],
      [
        entry({ playerID: "A", tileShare: 0.15 }), // grew -> "expanding" correct
        entry({ playerID: "B", tileShare: 0.25 }), // grew -> "losing_ground" wrong
      ],
    ]);
    expect(report.verifiablePredictions).toBe(2);
    expect(report.correct).toBe(1);
    expect(report.accuracy).toBe(0.5);
    expect(report.byType["expanding"]).toMatchObject({ verifiable: 1, correct: 1 });
    expect(report.byType["losing_ground"]).toMatchObject({ verifiable: 1, correct: 0 });
  });

  it("verifies attack, alliance and betrayal predictions", () => {
    const report = scoreToMAccuracy([
      [
        entry({ playerID: "A", predictedNextAction: "may_attack_me", attacksOnMe: 0 }),
        entry({ playerID: "B", predictedNextAction: "wants_alliance_with_me" }),
        entry({ playerID: "C", predictedNextAction: "alliance_expiring", isAllied: true }),
        entry({
          playerID: "D",
          predictedNextAction: "strong_ally_betrayal_risk",
          isAllied: true,
        }),
      ],
      [
        entry({ playerID: "A", attacksOnMe: 1 }), // attacked -> correct
        entry({ playerID: "B", isAllied: true }), // allied -> correct
        entry({ playerID: "C", isAllied: false }), // alliance ended -> correct
        entry({ playerID: "D", betrayedMe: true }), // betrayed -> correct
      ],
    ]);
    expect(report.verifiablePredictions).toBe(4);
    expect(report.correct).toBe(4);
    expect(report.accuracy).toBe(1);
  });

  it("marks predictions about vanished rivals as unverifiable", () => {
    const report = scoreToMAccuracy([
      [entry({ playerID: "A", predictedNextAction: "expanding" })],
      [], // A eliminated / out of view
    ]);
    expect(report.totalPredictions).toBe(1);
    expect(report.verifiablePredictions).toBe(0);
    expect(report.accuracy).toBe(0);
    expect(report.outcomes[0]).toMatchObject({ verifiable: false, correct: null });
  });

  it("returns zeroed accuracy for a single snapshot (no transitions)", () => {
    const report = scoreToMAccuracy([
      [entry({ playerID: "A", predictedNextAction: "expanding" })],
    ]);
    expect(report.totalPredictions).toBe(0);
    expect(report.accuracy).toBe(0);
  });

  it("scores the 'stable' prediction (no growth, no new attack)", () => {
    const report = scoreToMAccuracy([
      [entry({ playerID: "A", predictedNextAction: "stable", tileShare: 0.1, attacksOnMe: 0 })],
      [entry({ playerID: "A", tileShare: 0.1, attacksOnMe: 0 })],
    ]);
    expect(report.byType["stable"]).toMatchObject({ verifiable: 1, correct: 1 });
  });
});
