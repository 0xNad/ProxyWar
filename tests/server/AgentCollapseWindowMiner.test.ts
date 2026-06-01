import { describe, expect, it } from "vitest";
import {
  agentCollapseWindowReportMarkdown,
  buildAgentCollapseWindowReport,
} from "../../src/server/agents/AgentCollapseWindowMiner";
import type { AgentDecisionRecordLike } from "../../src/server/agents/AgentHumanOpportunityMiner";

describe("AgentCollapseWindowMiner", () => {
  it("isolates ignored retreat and safety holds during an elimination collapse", () => {
    const records = Array.from({ length: 30 }, (_, index) =>
      record(index + 1, index * 100, "attack", {
        chosenActionID: `attack:rival:${index}`,
      }),
    );
    records[13] = record(14, 1300, "hold", {
      legalRetreats: ["retreat:incoming-1"],
      reason:
        "attack-safety hold: hostile attacks offered but blocked by safety policy",
      conversionRecommended: true,
    });
    records[14] = record(15, 1400, "attack", {
      chosenActionID: "attack:rival:10",
      targetID: "rival",
      troopPercent: 10,
    });
    records[15] = record(16, 1500, "hold", {
      legalRetreats: ["retreat:incoming-2"],
      reason:
        "attack-safety hold: hostile attacks offered but blocked by safety policy",
      conversionRecommended: true,
    });
    records[16] = record(17, 1600, "hold", {
      legalRetreats: ["retreat:incoming-3"],
      reason:
        "attack-safety hold: hostile attacks offered but blocked by safety policy",
    });

    const report = buildAgentCollapseWindowReport({
      reportID: "collapse-test",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      runs: [
        {
          runID: "run-1",
          benchmarkRunIndex: 1,
          won: false,
          survived: false,
          records,
          snapshots: [
            snapshot(0, 100, 120),
            snapshot(1000, 10_000, 9_000),
            snapshot(1600, 6_500, 12_000),
            snapshot(2500, 0, 20_000, false),
          ],
        },
      ],
    });

    expect(report.aggregate.eliminatedRunCount).toBe(1);
    expect(report.runs[0]).toMatchObject({
      outcome: "eliminated",
      peakTiles: 10_000,
      collapseStartTurn: 1600,
      legalRetreatMisses: 3,
      conversionMisses: 2,
      attackSafetyHolds: 3,
    });
    expect(report.topFindings.map((finding) => finding.findingID)).toContain(
      "retreat_ignored",
    );
  });

  it("flags boxed-out losses where the collapse window is mostly safety holds", () => {
    const records = Array.from({ length: 24 }, (_, index) =>
      record(index + 1, index * 100, index < 12 ? "attack" : "hold", {
        reason:
          index < 12
            ? "pressure rival"
            : "hostile attacks offered but blocked by safety policy",
        legalBoats: ["boat:neutral:25"],
      }),
    );

    const report = buildAgentCollapseWindowReport({
      reportID: "boxed-test",
      generatedAt: Date.UTC(2026, 0, 1),
      source: "test",
      runs: [
        {
          runID: "run-1",
          benchmarkRunIndex: 1,
          won: false,
          survived: true,
          records,
          snapshots: [
            snapshot(0, 100, 120),
            snapshot(1200, 40_000, 35_000),
            snapshot(2400, 3_000, 50_000),
          ],
        },
      ],
    });

    expect(report.runs[0]).toMatchObject({
      outcome: "boxed_out",
      attackSafetyHolds: 12,
      legalBoatMisses: 20,
    });
    expect(report.topFindings[0]).toMatchObject({
      findingID: "safety_hold_wall",
      severity: "high",
    });
    expect(agentCollapseWindowReportMarkdown(report)).toContain(
      "Collapse Window Report",
    );
  });
});

function record(
  sequence: number,
  turnNumber: number,
  chosenActionKind: string,
  options: {
    chosenActionID?: string;
    legalRetreats?: string[];
    legalBoats?: string[];
    reason?: string;
    conversionRecommended?: boolean;
    bankingRecommended?: boolean;
    targetID?: string | null;
    troopPercent?: number;
  } = {},
): AgentDecisionRecordLike {
  return {
    sequence,
    turnNumber,
    agentID: "agent-1",
    username: "Agent",
    chosenActionKind,
    chosenActionID: options.chosenActionID ?? chosenActionKind,
    chosenActionMetadata: {
      targetID: options.targetID ?? (chosenActionKind === "attack" ? "rival" : null),
      troopPercent: options.troopPercent ?? null,
      expansion: false,
    },
    legalActionIDsByKind: {
      retreat: options.legalRetreats ?? [],
      boat: options.legalBoats ?? [],
    },
    tacticalAffordances: {
      transportTroopBanking: {
        recommended: options.bankingRecommended === true,
      },
      frontierConversionTiming: {
        recommended: options.conversionRecommended === true,
        executorReady: options.conversionRecommended === true,
      },
      openingExpansionTempo: {
        neutralExpansionAvailable: false,
        neutralLandExpansionActionCount: 0,
      },
    } as any,
    reason: options.reason ?? "test",
  };
}

function snapshot(
  turnNumber: number,
  ownTiles: number,
  leaderTiles: number,
  alive = true,
) {
  return {
    turnNumber,
    players: [
      {
        agentID: "agent-1",
        username: "Agent",
        isAlive: alive,
        tilesOwned: ownTiles,
        troops: 100_000,
      },
      {
        agentID: null,
        username: "Leader",
        isAlive: true,
        tilesOwned: leaderTiles,
        troops: 200_000,
      },
    ],
  };
}
