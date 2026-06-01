import { describe, expect, it } from "vitest";
import { buildAgentOpportunityPromotionGate } from "../../src/server/agents/AgentOpportunityPromotionGate";

describe("AgentOpportunityPromotionGate", () => {
  it("promotes a policy that passes a stable benchmark gate", () => {
    const gate = buildAgentOpportunityPromotionGate({
      benchmarkID: "candidate",
      benchmarkSummary: {
        pass: true,
        wins: 3,
        requiredWins: 3,
        runs: [
          { won: true, survived: true, tileShare: 0.72, turns: 12_000 },
          { won: true, survived: true, tileShare: 0.69, turns: 11_000 },
          { won: true, survived: true, tileShare: 0.74, turns: 10_500 },
        ],
      },
    });

    expect(gate.status).toBe("promote");
    expect(gate.metrics).toMatchObject({
      runCount: 3,
      winCount: 3,
      winRate: 1,
      averageTileShare: 0.717,
    });
  });

  it("keeps a one-game pass inconclusive instead of promoting it", () => {
    const gate = buildAgentOpportunityPromotionGate({
      benchmarkID: "sanity",
      benchmarkSummary: {
        pass: true,
        wins: 1,
        requiredWins: 1,
        runs: [{ won: true, survived: true, tileShare: 0.65 }],
      },
    });

    expect(gate.status).toBe("inconclusive");
    expect(gate.reasons).toContain("sample size is too small for promotion");
  });

  it("discards a zero-win candidate that collapses on map share", () => {
    const gate = buildAgentOpportunityPromotionGate({
      benchmarkID: "bad-candidate",
      benchmarkSummary: {
        pass: false,
        wins: 0,
        requiredWins: 3,
        runs: [
          { won: false, survived: true, tileShare: 0.004 },
          { won: false, survived: false, tileShare: 0 },
          { won: false, survived: true, tileShare: 0.009 },
        ],
      },
      topGaps: [
        {
          title: "Attack-safety holds with neutral growth available",
          severity: "high",
          missedDecisionCycleCount: 120,
          nextExperiment:
            "Only replace attack-safety holds when no hard-nation front is collapsing.",
        },
      ],
    });

    expect(gate.status).toBe("discard");
    expect(gate.metrics.topGap).toBe(
      "Attack-safety holds with neutral growth available",
    );
    expect(gate.nextMilestone).toBe(
      "Only replace attack-safety holds when no hard-nation front is collapsing.",
    );
  });

  it("revises a stable but losing candidate around its top opportunity gap", () => {
    const gate = buildAgentOpportunityPromotionGate({
      benchmarkID: "near-miss",
      benchmarkSummary: {
        pass: false,
        wins: 2,
        requiredWins: 3,
        runs: [
          { won: true, survived: true, tileShare: 0.62 },
          { won: false, survived: true, tileShare: 0.29 },
          { won: true, survived: true, tileShare: 0.68 },
        ],
      },
      topGaps: [
        {
          title: "Missed weak-rival conversion",
          severity: "medium",
          missedDecisionCycleCount: 24,
          nextExperiment: "Tighten conversion handoff blockers.",
        },
      ],
    });

    expect(gate.status).toBe("revise");
    expect(gate.nextMilestone).toBe("Tighten conversion handoff blockers.");
  });
});
