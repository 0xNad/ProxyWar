import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildAgentLearningReport,
  writeAgentLearningArtifacts,
} from "../../src/server/agents/AgentLearningArtifacts";
import {
  AgentDecisionRecord,
  AgentStrategyProfile,
} from "../../src/server/agents/AgentTypes";

describe("AgentLearningArtifacts", () => {
  it("summarizes transport troop-banking misses and acted-on opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-1",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "win-run",
          benchmarkRunIndex: 1,
          won: true,
          records: [recordWithBanking(1, "boat", "boat:444:25")],
        },
        {
          runID: "loss-run",
          benchmarkRunIndex: 2,
          won: false,
          records: [recordWithBanking(2, "attack", "attack:rival:20")],
        },
      ],
    });

    expect(report.tactics.transportTroopBanking).toMatchObject({
      observedDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
      winActRate: 1,
      lossActRate: 0,
    });
    expect(report.tactics.transportTroopBanking.examples[0]).toMatchObject({
      runID: "loss-run",
      actedOn: false,
      selectedLegalActionId: "attack:rival:20",
    });
    expect(report.llmReviewPacket.constraints.join(" ")).toContain(
      "LegalAction.id",
    );
  });

  it("counts batched same-turn actions as one tactic opportunity", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-batch",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "batched-run",
          benchmarkRunIndex: 1,
          won: true,
          records: [
            recordWithBanking(1, "attack", "attack:rival:20", 250),
            recordWithBanking(2, "boat", "boat:444:25", 250),
          ],
        },
      ],
    });

    expect(report.tactics.transportTroopBanking).toMatchObject({
      observedDecisionCount: 1,
      recommendedDecisionCount: 1,
      actedOnDecisionCount: 1,
      missedDecisionCount: 0,
      recommendationActRate: 1,
      winActRate: 1,
    });
    expect(report.tactics.transportTroopBanking.examples[0]).toMatchObject({
      runID: "batched-run",
      actedOn: true,
      selectedLegalActionId: "boat:444:25",
    });
  });

  it("summarizes missed and acted-on opening expansion tempo opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-opening",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "opening-loss",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithOpeningTempo(1, "build", "build:City:10")],
        },
        {
          runID: "opening-win",
          benchmarkRunIndex: 2,
          won: true,
          records: [
            recordWithOpeningTempo(2, "attack", "attack:Terra Nullius:15"),
          ],
        },
      ],
    });

    expect(report.tactics.openingExpansionTempo).toMatchObject({
      observedDecisionCount: 2,
      openingWindowDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
    });
    expect(report.tactics.openingExpansionTempo.examples[0]).toMatchObject({
      runID: "opening-loss",
      actedOn: false,
      selectedLegalActionId: "build:City:10",
    });
  });

  it("summarizes frontier conversion timing opportunities per decision cycle", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-conversion",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "conversion-run",
          benchmarkRunIndex: 1,
          won: false,
          records: [
            recordWithConversion(1, "build", "build:Factory:10", 500),
            recordWithConversion(2, "attack", "attack:rival-1:10", 500),
          ],
        },
      ],
    });

    expect(report.tactics.frontierConversionTiming).toMatchObject({
      observedDecisionCount: 1,
      strategicWindowDecisionCount: 1,
      executorReadyDecisionCount: 1,
      recommendedDecisionCount: 1,
      actedOnDecisionCount: 1,
      missedDecisionCount: 0,
      recommendationActRate: 1,
    });
    expect(report.tactics.frontierConversionTiming.examples[0]).toMatchObject({
      runID: "conversion-run",
      actedOn: true,
      selectedLegalActionId: "attack:rival-1:10",
      bestTargetName: "Weak Rival",
      bestExecutorReadyTargetName: "Weak Rival",
    });
  });

  it("summarizes frontier finish-pressure opportunities per decision cycle", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-finish-pressure",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "finish-miss",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithFinishPressure(1, "hold", "hold")],
        },
        {
          runID: "finish-hit",
          benchmarkRunIndex: 2,
          won: true,
          records: [recordWithFinishPressure(2, "attack", "attack:rival-1:25")],
        },
      ],
    });

    expect(report.tactics.frontierFinishPressure).toMatchObject({
      observedDecisionCount: 2,
      repeatedProbeDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
    });
    expect(report.tactics.frontierFinishPressure.examples[0]).toMatchObject({
      runID: "finish-miss",
      actedOn: false,
      selectedLegalActionId: "hold",
      bestTargetName: "Weak Rival",
      bestTargetRelativeTroopRatio: 1.65,
    });
  });

  it("summarizes missed and acted-on economy cadence opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-economy",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "economy-miss",
          benchmarkRunIndex: 1,
          won: false,
          records: [
            recordWithEconomyCadence(1, "attack", "expand:terra-nullius:20"),
          ],
        },
        {
          runID: "economy-hit",
          benchmarkRunIndex: 2,
          won: true,
          records: [recordWithEconomyCadence(2, "build", "build:Factory:10")],
        },
      ],
    });

    expect(report.tactics.economyCadence).toMatchObject({
      observedDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
    });
    expect(report.tactics.economyCadence.examples[0]).toMatchObject({
      runID: "economy-miss",
      actedOn: false,
      selectedLegalActionId: "expand:terra-nullius:20",
      bestBuildID: "build:Factory:10",
      bestBuildUnit: "Factory",
    });
  });

  it("summarizes missed and acted-on naval control opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-naval",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "naval-miss",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithNavalControl(1, "hold", "hold")],
        },
        {
          runID: "naval-hit",
          benchmarkRunIndex: 2,
          won: true,
          records: [recordWithNavalControl(2, "warship", "warship:Port:777")],
        },
      ],
    });

    expect(report.tactics.navalControl).toMatchObject({
      observedDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
      averageRecommendedActiveTransportCount: 1,
      averageRecommendedSafeNavalActions: 2,
    });
    expect(report.tactics.navalControl?.examples[0]).toMatchObject({
      runID: "naval-miss",
      actedOn: false,
      selectedLegalActionId: "hold",
      bestNavalActionID: "warship:Port:777",
      bestNavalActionKind: "warship",
    });
  });

  it("summarizes missed and acted-on late-game strike targeting opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-strike",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "strike-miss",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithLateGameStrike(1, "hold", "hold")],
        },
        {
          runID: "strike-hit",
          benchmarkRunIndex: 2,
          won: true,
          records: [
            recordWithLateGameStrike(
              2,
              "nuke",
              "nuke:Hydrogen Bomb:leader-1:777",
            ),
          ],
        },
      ],
    });

    expect(report.tactics.lateGameStrikeTargeting).toMatchObject({
      observedDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
      averageRecommendedBestStrikeScore: 210,
      averageRecommendedHighValueStrikes: 1,
    });
    expect(report.tactics.lateGameStrikeTargeting?.examples[0]).toMatchObject({
      runID: "strike-miss",
      actedOn: false,
      selectedLegalActionId: "hold",
      bestStrikeActionID: "nuke:Hydrogen Bomb:leader-1:777",
      bestStrikeTargetStructureUnit: "Missile Silo",
    });
  });

  it("summarizes missed and acted-on personality diplomacy pressure opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-personality",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "personality-miss",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithPersonalityPressure(1, "hold", "hold")],
        },
        {
          runID: "personality-hit",
          benchmarkRunIndex: 2,
          won: true,
          records: [
            recordWithPersonalityPressure(2, "target_player", "target:rival-1"),
          ],
        },
      ],
    });

    expect(report.tactics.personalityDiplomacyPressure).toMatchObject({
      observedDecisionCount: 2,
      recommendedDecisionCount: 2,
      actedOnDecisionCount: 1,
      missedDecisionCount: 1,
      recommendationActRate: 0.5,
      averageRecommendedSocialActions: 2,
      averageRecommendedBestSocialScore: 112,
    });
    expect(
      report.tactics.personalityDiplomacyPressure?.examples[0],
    ).toMatchObject({
      runID: "personality-miss",
      actedOn: false,
      selectedLegalActionId: "hold",
      bestSocialActionID: "target:rival-1",
      personalityMode: "aggressive_pressure",
    });
  });

  it("captures missed frontier conversion timing opportunities", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-conversion-miss",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "conversion-miss",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithConversion(1, "hold", "hold")],
        },
      ],
    });

    expect(report.tactics.frontierConversionTiming).toMatchObject({
      recommendedDecisionCount: 1,
      actedOnDecisionCount: 0,
      missedDecisionCount: 1,
      recommendationActRate: 0,
    });
    expect(report.tactics.frontierConversionTiming.examples[0]).toMatchObject({
      actedOn: false,
      selectedLegalActionId: "hold",
    });
  });

  it("mines profile-repair examples from collapsed profile sweeps", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-profile-repair",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "profile-aggressive",
          benchmarkRunIndex: 1,
          won: false,
          records: profileStoryRecords("aggressive", 1),
        },
        {
          runID: "profile-defensive",
          benchmarkRunIndex: 2,
          won: false,
          records: profileStoryRecords("defensive", 10),
        },
        {
          runID: "profile-diplomatic",
          benchmarkRunIndex: 3,
          won: false,
          records: profileStoryRecords("diplomatic", 20),
        },
        {
          runID: "profile-opportunistic",
          benchmarkRunIndex: 4,
          won: false,
          records: profileStoryRecords("opportunistic", 30),
        },
      ],
    });

    const profileRepair = report.profileRepair;
    expect(profileRepair).toBeDefined();
    if (profileRepair === undefined) {
      throw new Error("expected profile repair report");
    }
    expect(profileRepair).toMatchObject({
      profileCount: 4,
      evaluatedProfileCount: 4,
      benchmarkDistinctEnough: false,
      averageProfileDistance: 0,
      neutralExpansionConvergenceRunCount: 4,
      collapsedSignatureCount: 3,
    });
    expect(profileRepair.examples.map((example) => example.issueType)).toEqual(
      expect.arrayContaining([
        "collapsed_signature",
        "neutral_expansion_convergence",
        "missing_profile_expression",
      ]),
    );
    expect(profileRepair.hypotheses.join(" ")).toContain("Neutral expansion");
    expect(profileRepair.nextExperiments.join(" ")).toContain(
      "profile-differentiation",
    );
    expect(report.llmReviewPacket.focusTactics).toContain(
      "profile_repair_mining",
    );
    expect(report.llmReviewPacket.focusTactics).toContain(
      "profile_repair_rerank",
    );
  });

  it("aggregates profile repair re-rank telemetry from decision metadata", () => {
    const report = buildAgentLearningReport({
      benchmarkID: "bench-profile-rerank",
      generatedAt: Date.UTC(2026, 0, 1),
      runs: [
        {
          runID: "profile-rerank",
          benchmarkRunIndex: 1,
          won: false,
          records: Array.from({ length: 25 }, (_, index) =>
            recordWithProfileRepairRerank(
              "aggressive",
              index + 1,
              index === 0
                ? "expand:terra-nullius:20"
                : "attack:rival-1:25",
              index !== 0,
            ),
          ),
        },
      ],
    });

    expect(report.profileRepair).toMatchObject({
      rerankOpportunityCount: 25,
      rerankActedOnCount: 24,
      rerankMissedCount: 1,
      rerankActRate: 0.96,
    });
    expect(report.profileRepair?.rerankExamples).toHaveLength(20);
    expect(report.profileRepair?.rerankExamples[0]).toMatchObject({
      family: "weak_hostile_attack",
      selectedLegalActionId: "expand:terra-nullius:20",
      suggestedActionID: "attack:rival-1:25",
      actedOn: false,
    });
    expect(report.profileRepair?.rerankFamilySummaries[0]).toMatchObject({
      family: "weak_hostile_attack",
      opportunityCount: 25,
      actedOnCount: 24,
      missedCount: 1,
      actRate: 0.96,
      profiles: ["aggressive"],
    });
    expect(
      report.profileRepair?.rerankFamilySummaries[0]?.topSuggestedActionIDs,
    ).toContain("attack:rival-1:25(25)");
    expect(report.profileRepair?.hypotheses.join(" ")).toContain(
      "Profile repair re-rank surfaced 25 legal repair windows",
    );
    expect(report.profileRepair?.hypotheses.join(" ")).toContain(
      "most common missed repair family is weak_hostile_attack",
    );
  });

  it("writes compact learning JSON and Markdown artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "learning-"));
    const paths = await writeAgentLearningArtifacts({
      benchmarkID: "bench-2",
      directory,
      runs: [
        {
          runID: "run-1",
          benchmarkRunIndex: 1,
          won: false,
          records: [recordWithBanking(1, "hold", "hold")],
        },
      ],
    });

    const json = JSON.parse(await fs.readFile(paths.jsonPath, "utf8"));
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    expect(json.tactics.transportTroopBanking.missedDecisionCount).toBe(1);
    expect(json.tactics.economyCadence.observedDecisionCount).toBe(0);
    expect(json.tactics.navalControl.observedDecisionCount).toBe(0);
    expect(json.tactics.lateGameStrikeTargeting.observedDecisionCount).toBe(0);
    expect(markdown).toContain("Transport Troop Banking");
    expect(markdown).toContain("Frontier Finish Pressure");
    expect(markdown).toContain("Economy Cadence");
    expect(markdown).toContain("Naval Control");
    expect(markdown).toContain("Late-Game Strike Targeting");
    expect(markdown).toContain("Profile Repair Mining");
    expect(markdown).toContain("Profile Repair Re-rank Families");
    expect(markdown).toContain("Profile Repair Re-rank Examples");
    expect(markdown).toContain("LLM Review Packet");
  });
});

function profileStoryRecords(
  profile: AgentStrategyProfile,
  firstSequence: number,
): AgentDecisionRecord[] {
  return [0, 1, 2].map((offset) =>
    recordWithProfileStory(
      profile,
      firstSequence + offset,
      `expand:${profile}:${offset}`,
    ),
  );
}

function recordWithProfileStory(
  profile: AgentStrategyProfile,
  sequence: number,
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: `agent-${profile}`,
    clientID: `client-${profile}`,
    username: `Frontier ${profile}`,
    profile,
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "profile sweep kept farming neutral land",
    strategicPriority: "expand",
    strategicUrgency: "medium",
    strategicSummary: "neutral expansion loop",
    memorySummary: "recent=expand,expand; repeat=attack",
    legalActionIDs: [chosenActionID, "build:Factory:10", "target:rival-1", "hold"],
    legalActionIDsByKind: {
      attack: [chosenActionID],
      build: ["build:Factory:10"],
      target_player: ["target:rival-1"],
      hold: ["hold"],
    },
    attackActionIDs: [chosenActionID],
    chosenActionID,
    chosenActionKind: "attack",
    reason: "test profile repair neutral expansion loop",
    chosenActionMetadata: {
      expansion: true,
      targetID: null,
    },
    tacticalAffordances: {
      notes: ["profile repair should flag profile convergence"],
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 80_000,
        maxTroops: 200_000,
        troopRatio: 0.4,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 200_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap in profile repair fixture"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithProfileRepairRerank(
  profile: AgentStrategyProfile,
  sequence: number,
  chosenActionID: string,
  actedOn: boolean,
): AgentDecisionRecord {
  const expansion = chosenActionID.startsWith("expand:");
  return {
    ...recordWithProfileStory(profile, sequence, chosenActionID),
    chosenActionMetadata: {
      expansion,
      targetID: expansion ? null : "rival-1",
      targetName: expansion ? "Terra Nullius" : "Weak Rival",
      relativeTroopRatio: expansion ? 0 : 1.8,
    },
    decisionMetadata: {
      profileRepairRerankOpportunity: true,
      profileRepairRerankSelected: actedOn,
      profileRepairRerankSuggestedActionID: "attack:rival-1:25",
      profileRepairRerankSuggestedActionKind: "attack",
      profileRepairRerankSuggestedModule: "combat",
      profileRepairRerankSelectedReason:
        "profile repair boosts aggressive weak-border pressure over collapsed neutral expansion",
      profileRepairRerankCandidates: "attack:rival-1:25:58,target:rival-1:34",
    },
  };
}

function recordWithBanking(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
  turnNumber = sequence * 100,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "near cap with legal transport",
    strategicPriority: "naval",
    strategicUrgency: "medium",
    strategicSummary: "naval pressure",
    memorySummary: "recent=attack; repeat=none",
    legalActionIDs: [chosenActionID, "boat:444:25", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      boat: ["boat:444:25"],
      hold: ["hold"],
    },
    attackActionIDs: chosenActionKind === "attack" ? [chosenActionID] : [],
    chosenActionID,
    chosenActionKind,
    reason: "test decision",
    chosenActionMetadata: {},
    tacticalAffordances: {
      notes: [
        "transport_troop_banking is available; evaluator should watch whether the agent converts capped troops into active transports",
      ],
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: true,
        recommended: true,
        ownTroops: 190_000,
        maxTroops: 200_000,
        troopRatio: 0.95,
        activeTransportCount: 1,
        activeTransportTroops: 60_000,
        largestActiveTransportTroops: 60_000,
        activeBankRatio: 0.3,
        continuationReady: true,
        availableBoatLaunchActionCount: 1,
        availableBoatLaunchTroops: [50_000],
        largestAvailableBoatLaunchTroops: 50_000,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 310_000,
        effectiveFutureTroopRatio: 1.55,
        reasons: [
          "recommended: bank a transport before capped growth is wasted",
        ],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithOpeningTempo(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "opening behind tile-share target",
    strategicPriority: "expand",
    strategicUrgency: "high",
    strategicSummary: "expand early",
    memorySummary: "recent=hold; repeat=none",
    legalActionIDs: [chosenActionID, "attack:Terra Nullius:15", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      attack: ["attack:Terra Nullius:15"],
      hold: ["hold"],
    },
    attackActionIDs:
      chosenActionKind === "attack"
        ? [chosenActionID]
        : ["attack:Terra Nullius:15"],
    chosenActionID,
    chosenActionKind,
    reason: "test opening tempo decision",
    chosenActionMetadata:
      chosenActionKind === "attack" ? { expansion: true } : {},
    tacticalAffordances: {
      notes: [
        "opening_expansion_tempo is behind target; evaluator should watch whether the agent spends early legal expansion",
      ],
      openingExpansionTempo: {
        tacticID: "opening_expansion_tempo",
        openingWindow: true,
        recommended: true,
        turnNumber: sequence * 100,
        ownTiles: 120,
        ownTileShare: 0.015,
        expectedTileShare: 0.045,
        leaderTileShare: 0.07,
        leaderTileShareGap: 0.055,
        neutralExpansionAvailable: true,
        neutralLandExpansionActionCount: 1,
        neutralBoatExpansionActionCount: 0,
        largestExpansionTroopPercent: 15,
        economicBuildActionCount: 1,
        incomingThreatRatio: 0,
        homeDanger: "low",
        behindExpectedTempo: true,
        leaderGapDanger: true,
        reasons: ["recommended: spend early expansion before the map closes"],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 80_000,
        maxTroops: 200_000,
        troopRatio: 0.4,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 200_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 40%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithConversion(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
  turnNumber = sequence * 100,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "conversion window open",
    strategicPriority: "attack",
    strategicUrgency: "medium",
    strategicSummary: "convert weak rival",
    memorySummary: "recent=attack; expansions=3; repeat=none",
    legalActionIDs: [chosenActionID, "attack:rival-1:10", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      attack: ["attack:rival-1:10"],
      hold: ["hold"],
    },
    attackActionIDs:
      chosenActionKind === "attack" ? [chosenActionID] : ["attack:rival-1:10"],
    chosenActionID,
    chosenActionKind,
    reason: "test conversion timing decision",
    chosenActionMetadata:
      chosenActionKind === "attack"
        ? { targetID: "rival-1", targetName: "Weak Rival" }
        : {},
    tacticalAffordances: {
      notes: [
        "frontier_conversion_timing is open; evaluator should watch whether the agent converts a favorable rival instead of farming neutral land",
      ],
      frontierConversionTiming: {
        tacticID: "frontier_conversion_timing",
        recommended: true,
        strategicWindow: true,
        executorReady: true,
        turnNumber,
        ownTiles: 12_000,
        ownTileShare: 0.09,
        troopRatio: 0.72,
        enoughLandBase: true,
        recentExpansionCount: 3,
        neutralExpansionAvailable: true,
        neutralExpansionActionCount: 2,
        hostileAttackActionCount: 1,
        favorableHostileAttackActionCount: 1,
        executorReadyHostileAttackActionCount: 1,
        bestTargetID: "rival-1",
        bestTargetName: "Weak Rival",
        bestTargetRelativeTroopRatio: 1.45,
        bestTargetTileShare: 0.06,
        bestAttackTroopPercent: 10,
        bestExecutorReadyTargetID: "rival-1",
        bestExecutorReadyTargetName: "Weak Rival",
        bestExecutorReadyRelativeTroopRatio: 1.45,
        bestExecutorReadyTileShare: 0.06,
        bestExecutorReadyAttackTroopPercent: 10,
        leaderTileShare: 0.13,
        leaderTileShareGap: 0.04,
        incomingThreatRatio: 0,
        homeDanger: "low",
        reasons: [
          "recommended: convert a favorable rival before neutral farming goes stale",
        ],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 160_000,
        maxTroops: 220_000,
        troopRatio: 0.73,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 220_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 73%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithEconomyCadence(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "economy cadence window open",
    strategicPriority: "build_economy",
    strategicUrgency: "medium",
    strategicSummary: "build first factory",
    memorySummary: "recent=attack,attack; expansions=2; builds=0",
    legalActionIDs: [chosenActionID, "build:Factory:10", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      build: ["build:Factory:10"],
      hold: ["hold"],
    },
    attackActionIDs: chosenActionKind === "attack" ? [chosenActionID] : [],
    chosenActionID,
    chosenActionKind,
    reason: "test economy cadence decision",
    chosenActionMetadata:
      chosenActionKind === "build"
        ? { role: "economic", unit: "Factory" }
        : { expansion: true },
    tacticalAffordances: {
      notes: [
        "economy_cadence is available; evaluator should watch whether the agent converts stable expansion into City, Factory, or Port infrastructure",
      ],
      economyCadence: {
        tacticID: "economy_cadence",
        recommended: true,
        turnNumber: sequence * 100,
        ownTiles: 9_000,
        ownTileShare: 0.09,
        troopRatio: 0.55,
        homeDanger: "low",
        recentExpansionCount: 2,
        recentBuildCount: 0,
        cityCount: 1,
        factoryCount: 0,
        portCount: 0,
        coreEconomyCount: 1,
        firstCityMissing: false,
        firstFactoryMissing: true,
        firstPortMissing: false,
        enoughLandBase: true,
        economyBuildActionCount: 1,
        safeEconomyBuildActionCount: 1,
        cityBuildActionCount: 0,
        factoryBuildActionCount: 1,
        portBuildActionCount: 0,
        bestBuildID: "build:Factory:10",
        bestBuildUnit: "Factory",
        bestBuildEconomicValue: 0.8,
        reasons: [
          "recommended: turn stable expansion into City, Factory, or Port infrastructure",
        ],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 160_000,
        maxTroops: 220_000,
        troopRatio: 0.73,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 220_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 73%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithNavalControl(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "naval control window open",
    strategicPriority: "naval",
    strategicUrgency: "medium",
    strategicSummary: "secure sea lane",
    memorySummary: "recent=attack,build; repeat=none",
    legalActionIDs: [chosenActionID, "warship:Port:777", "boat:444:25", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      warship: ["warship:Port:777"],
      boat: ["boat:444:25"],
      hold: ["hold"],
    },
    attackActionIDs: [],
    chosenActionID,
    chosenActionKind,
    reason: "test naval control decision",
    chosenActionMetadata:
      chosenActionKind === "warship"
        ? { unit: "Warship", sourceUnit: "Port" }
        : {},
    tacticalAffordances: {
      notes: [
        "naval_control is available; evaluator should watch whether the agent uses transports, warships, or patrol moves instead of stalling land loops",
      ],
      navalControl: {
        tacticID: "naval_control",
        recommended: true,
        turnNumber: sequence * 100,
        ownTileShare: 0.12,
        troopRatio: 0.8,
        homeDanger: "low",
        portCount: 1,
        warshipCount: 0,
        activeTransportCount: 1,
        activeTransportTroops: 40_000,
        boatLaunchActionCount: 1,
        neutralBoatActionCount: 1,
        navalInvasionActionCount: 0,
        warshipBuildActionCount: 1,
        warshipMoveActionCount: 0,
        safeNavalActionCount: 2,
        bestNavalActionID: "warship:Port:777",
        bestNavalActionKind: "warship",
        bestNavalTargetID: null,
        bestNavalTargetName: null,
        bestNavalTroopPercent: null,
        reasons: [
          "recommended: use the best transport, warship, or patrol action before naval options stall",
        ],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 160_000,
        maxTroops: 220_000,
        troopRatio: 0.73,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 220_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 73%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithLateGameStrike(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "aggressive",
    brainType: "planner-executor",
    turnNumber: sequence * 100 + 2_000,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "late-game strike window open",
    strategicPriority: "nuclear",
    strategicUrgency: "high",
    strategicSummary: "hit leader silo",
    memorySummary: "recent=attack,build; repeat=none",
    legalActionIDs: [chosenActionID, "nuke:Hydrogen Bomb:leader-1:777", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      nuke: ["nuke:Hydrogen Bomb:leader-1:777"],
      hold: ["hold"],
    },
    attackActionIDs: [],
    chosenActionID,
    chosenActionKind,
    reason: "test late-game strike decision",
    chosenActionMetadata:
      chosenActionKind === "nuke"
        ? {
            unit: "Hydrogen Bomb",
            targetID: "leader-1",
            targetName: "Hard Leader",
            targetStructureUnit: "Missile Silo",
          }
        : {},
    tacticalAffordances: {
      notes: [
        "late_game_strike_targeting is available; evaluator should watch whether the agent uses legal nukes against strategic targets instead of low-impact loops",
      ],
      lateGameStrikeTargeting: {
        tacticID: "late_game_strike_targeting",
        recommended: true,
        turnNumber: sequence * 100 + 2_000,
        ownTileShare: 0.24,
        troopRatio: 0.75,
        homeDanger: "low",
        legalStrikeActionCount: 1,
        highValueStrikeActionCount: 1,
        siloTargetActionCount: 1,
        samTargetActionCount: 0,
        economyTargetActionCount: 0,
        coveredNonSamTargetActionCount: 0,
        recentNukeCount: 0,
        bestStrikeActionID: "nuke:Hydrogen Bomb:leader-1:777",
        bestStrikeWeapon: "Hydrogen Bomb",
        bestStrikeTargetID: "leader-1",
        bestStrikeTargetName: "Hard Leader",
        bestStrikeTargetTileShare: 0.36,
        bestStrikeTargetStructureUnit: "Missile Silo",
        bestStrikeTargetStructurePriority: 120,
        bestStrikeTargetSamCoverage: 0,
        bestStrikeNuclearTargetPriority: 210,
        bestStrikeScore: 210,
        reasons: [
          "recommended: use the best legal nuke against a strategic target before late-game pressure stalls",
        ],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 160_000,
        maxTroops: 220_000,
        troopRatio: 0.73,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 220_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 73%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithPersonalityPressure(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "aggressive",
    brainType: "planner-executor",
    turnNumber: sequence * 100 + 1_000,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "personality pressure window open",
    strategicPriority: "pressure",
    strategicUrgency: "medium",
    strategicSummary: "mark weak rival",
    memorySummary: "recent=expand,expand; repeat=attack",
    legalActionIDs: [chosenActionID, "target:rival-1", "emoji:rival-1:41", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      target_player: ["target:rival-1"],
      emoji: ["emoji:rival-1:41"],
      hold: ["hold"],
    },
    attackActionIDs: [],
    chosenActionID,
    chosenActionKind,
    reason: "test personality pressure decision",
    chosenActionMetadata:
      chosenActionKind === "target_player"
        ? {
            targetID: "rival-1",
            targetName: "Weak Rival",
          }
        : {},
    tacticalAffordances: {
      notes: [
        "personality_diplomacy_pressure is available; evaluator should watch whether profile-specific social pressure, alliance, support, or communication creates visible match story beats",
      ],
      personalityDiplomacyPressure: {
        tacticID: "personality_diplomacy_pressure",
        recommended: true,
        turnNumber: sequence * 100 + 1_000,
        profile: "aggressive",
        homeDanger: "low",
        recentSocialActionCount: 0,
        recentPressureActionCount: 0,
        socialActionCount: 2,
        pressureActionCount: 1,
        allianceActionCount: 0,
        supportActionCount: 0,
        communicationActionCount: 1,
        targetActionCount: 1,
        embargoActionCount: 0,
        bestSocialActionID: "target:rival-1",
        bestSocialActionKind: "target_player",
        bestSocialTargetID: "rival-1",
        bestSocialTargetName: "Weak Rival",
        bestSocialScore: 112,
        personalityMode: "aggressive_pressure",
        reasons: [
          "recommended: use the best profile-specific social action to create pressure, alliance, support, or communication instead of a bland loop",
        ],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 160_000,
        maxTroops: 220_000,
        troopRatio: 0.73,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 220_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 73%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}

function recordWithFinishPressure(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "GAME01",
    agentID: "agent-1",
    clientID: "client-1",
    username: "Frontier",
    profile: "aggressive",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "finish pressure window open",
    strategicPriority: "attack",
    strategicUrgency: "high",
    strategicSummary: "finish weak rival",
    memorySummary: "recent=attack,attack,attack; repeat=attack",
    legalActionIDs: [chosenActionID, "attack:rival-1:25", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      attack: ["attack:rival-1:25"],
      hold: ["hold"],
    },
    attackActionIDs:
      chosenActionKind === "attack" ? [chosenActionID] : ["attack:rival-1:25"],
    chosenActionID,
    chosenActionKind,
    reason: "test finish pressure decision",
    chosenActionMetadata:
      chosenActionKind === "attack"
        ? { targetID: "rival-1", targetName: "Weak Rival", troopPercent: 25 }
        : {},
    tacticalAffordances: {
      notes: [
        "frontier_finish_pressure is open; evaluator should watch whether the agent escalates repeated probes into decisive finish attacks",
      ],
      frontierFinishPressure: {
        tacticID: "frontier_finish_pressure",
        recommended: true,
        turnNumber: sequence * 100,
        ownTileShare: 0.12,
        troopRatio: 0.68,
        homeDanger: "low",
        activeTargetID: "rival-1",
        activeTargetName: "Weak Rival",
        recentTargetAttackCount: 4,
        recentLowCommitmentAttackCount: 3,
        repeatedLowCommitmentProbe: true,
        finishingAttackActionCount: 1,
        decisiveAttackActionCount: 1,
        bestTargetID: "rival-1",
        bestTargetName: "Weak Rival",
        bestTargetRelativeTroopRatio: 1.65,
        bestTargetTileShare: 0.045,
        bestTargetTroops: 120_000,
        bestAttackTroopPercent: 25,
        bestAttackID: "attack:rival-1:25",
        reasons: [
          "recommended: escalate repeated probes into a decisive finish attack",
        ],
      },
      transportTroopBanking: {
        tacticID: "transport_troop_banking",
        nearCap: false,
        recommended: false,
        ownTroops: 180_000,
        maxTroops: 260_000,
        troopRatio: 0.69,
        activeTransportCount: 0,
        activeTransportTroops: 0,
        largestActiveTransportTroops: 0,
        activeBankRatio: 0,
        continuationReady: false,
        availableBoatLaunchActionCount: 0,
        availableBoatLaunchTroops: [],
        largestAvailableBoatLaunchTroops: 0,
        incomingThreatTroops: 0,
        incomingThreatRatio: 0,
        homeDanger: "low",
        effectiveFutureTroops: 260_000,
        effectiveFutureTroopRatio: 1,
        reasons: ["not near cap at 69%"],
      },
    },
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
  };
}
