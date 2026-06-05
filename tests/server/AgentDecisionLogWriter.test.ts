import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { UnitType } from "../../src/core/game/Game";
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("AgentDecisionLogWriter", () => {
  it("writes JSONL decisions, match summary, Markdown report, and visual report", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    const intent = {
      type: "build_unit" as const,
      unit: UnitType.DefensePost,
      tile: 10,
    };
    const record: AgentDecisionRecord = {
      sequence: 1,
      gameID: "AGENTLOG",
      agentID: "agent-1",
      clientID: "CLIENT01",
      username: "Builder Agent",
      profile: "defensive",
      brainType: "mock-llm",
      turnNumber: 4,
      decidedAt: Date.UTC(2026, 0, 1),
      decisionLatencyMs: 123,
      observationSummary: "defensive Builder Agent: builds=1",
      strategicPriority: "build_defense",
      strategicUrgency: "medium",
      strategicSummary:
        "priority=build_defense, urgency=medium, expand=0, economy=0, offense=0, defense=0.85, threat=0.75",
      memorySummary:
        "recent=attack,attack; expansions=2; builds=0; repeat=attackx2",
      objectiveKind: "fortify_border",
      objectiveSummary:
        "Fortify border (active); recentAligned=0/2; consecutive=0; legalAligned=1",
      objectiveAligned: true,
      legalActionIDs: ["build:Defense Post:10", "hold"],
      legalActionIDsByKind: {
        build: ["build:Defense Post:10"],
        hold: ["hold"],
      },
      attackActionIDs: [],
      chosenActionID: "build:Defense Post:10",
      chosenActionKind: "build",
      reason: "Selected a defensive structure.",
      decisionMetadata: {
        brain: "llm",
        brainType: "mock-llm",
        llmPrompt: "prompt text",
        llmRawOutput:
          '{"selectedLegalActionId":"build:Defense Post:10","reason":"Build."}',
        llmParseOk: true,
        llmConfidence: 0.8,
        fallbackUsed: false,
        planObjective: "fortify_border",
        planRationale: "Border needs a defense post.",
        planPlannerSource: "mock-llm",
        planFollowed: true,
        plannerRan: true,
        plannerLatencyMs: 5,
        plannerFallbackUsed: false,
        plannerRawOutput:
          '{"objective":"fortify_border","rationale":"Border needs a defense post.","maxDecisionCycles":3,"preferredActionKinds":["build"]}',
        plannerParseOk: true,
        selectedSkill: "defense_building",
        selectedSkillScore: 94,
        skillSummary: "build:Defense Post:10:94/defense_building",
        alternativesConsidered: "build:Defense Post:10:94,hold:20",
      },
      chosenActionMetadata: {
        unit: UnitType.DefensePost,
        buildTile: 10,
      },
      intent,
      result: {
        accepted: true,
        reason: "accepted",
        submittedIntent: intent,
      },
      audit: {
        auditStatus: "confirmed",
        auditReason:
          "build_unit accepted and after-state contains Defense Post at tile 10",
        before: {
          tick: 1,
          playerID: "PLAYER1",
          isAlive: true,
          hasSpawned: true,
          tilesOwned: 100,
          troops: 500,
          gold: "1000",
          unitCounts: { [UnitType.DefensePost]: 0 },
          outgoingAttackTargetIDs: [],
          outgoingAllianceRequestRecipientIDs: [],
          outgoingEmbargoTargetIDs: [],
        },
        after: {
          tick: 2,
          playerID: "PLAYER1",
          isAlive: true,
          hasSpawned: true,
          tilesOwned: 100,
          troops: 500,
          gold: "900",
          unitCounts: { [UnitType.DefensePost]: 1 },
          outgoingAttackTargetIDs: [],
          outgoingAllianceRequestRecipientIDs: [],
          outgoingEmbargoTargetIDs: [],
        },
      },
    };

    try {
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "run-1",
        matchID: "AGENTLOG",
        scenario: "actions",
        brainMode: "mock-llm",
        runnerMode: "step-locked",
        runnerConfig: {
          turnsPerDecisionStep: 25,
          maxDecisionMs: 1_000,
          maxSteps: 1,
          stepsCompleted: 1,
          mirrorCatchupSucceeded: true,
          onlyHoldReason: null,
        },
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        records: [record],
        roster: [
          {
            agentID: "agent-1",
            username: "Builder Agent",
            profile: "defensive",
            clientID: "CLIENT01",
            brainType: "mock-llm",
          },
        ],
        spectatorReplay: {
          schemaVersion: 1,
          runID: "run-1",
          matchID: "AGENTLOG",
          scenario: "actions",
          brainMode: "mock-llm",
          runnerMode: "step-locked",
          readOnly: true,
          spectatorOccupiesPlayerSlot: false,
          replayKind: "artifact-snapshot-replay",
          map: {
            width: 20,
            height: 10,
            gameMap: "Asia",
            gameMapSize: "Compact",
          },
          roster: [
            {
              agentID: "agent-1",
              username: "Builder Agent",
              profile: "defensive",
              clientID: "CLIENT01",
              brainType: "mock-llm",
            },
          ],
          snapshots: [],
          notes: ["test spectator replay"],
        },
        finalState: {
          phase: "active",
          tick: 10,
          turnCount: 4,
          players: [],
        },
      });

      const decisions = await fs.readFile(paths.decisionsPath, "utf8");
      const firstDecision = JSON.parse(decisions.trim());
      expect(firstDecision).toMatchObject({
        runID: "run-1",
        matchID: "AGENTLOG",
        brainType: "mock-llm",
        selectedLegalActionId: "build:Defense Post:10",
        objectiveKind: "fortify_border",
        objectiveAligned: true,
        rawLlmPrompt: "prompt text",
        parseSuccess: true,
        fallbackUsed: false,
        plannerParseSuccess: true,
        result: { accepted: true },
        auditStatus: "confirmed",
        auditReason: expect.stringContaining("build_unit accepted"),
      });

      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary).toMatchObject({
        runID: "run-1",
        decisionCount: 1,
        acceptedCount: 1,
        actionCounts: { build: 1 },
        strategicPriorityCounts: { build_defense: 1 },
        objectiveCounts: { fortify_border: 1 },
        objectiveAlignedDecisionCount: 1,
        objectiveAlignmentRate: 1,
        objectiveScore: expect.any(Number),
        objectiveScoreGrade: expect.any(String),
        plannerRunCount: 1,
        planFollowedCount: 1,
        plannerFallbackCount: 0,
        runnerMode: "step-locked",
        postSpawnNonHoldActionCount: 1,
        confirmedEffectCount: 1,
        failedEffectCount: 0,
        externalAgentFeedbackPath: "external-agent-feedback.json",
        externalAgentFeedbackMarkdownPath: "external-agent-feedback.md",
        externalAgentCount: 0,
        matchStoryPath: "match-story.json",
        matchStoryMarkdownPath: "match-story.md",
        matchPackagePath: "match-package.json",
        matchPackageMarkdownPath: "match-package.md",
        matchPackageHtmlPath: "match-package.html",
        spectatorTelemetryPath: "spectator-telemetry.json",
        spectatorTelemetry: {
          agentCount: 1,
          relationshipCount: 0,
          eventCount: 1,
          communicationThreadCount: 0,
          timelineBucketCount: 1,
          majorEventCount: 0,
        },
        matchStory: {
          entertainmentScore: expect.any(Number),
          grade: expect.any(String),
        },
        averageDecisionLatencyMs: 123,
        spectator: {
          readOnly: true,
          spectatorOccupiesPlayerSlot: false,
          snapshotCount: 0,
          spectatorTelemetryPath: "spectator-telemetry.json",
        },
      });

      const report = await fs.readFile(paths.reportPath, "utf8");
      expect(report).toContain("# Proxy War Run run-1");
      expect(report).toContain("Builder Agent");
      expect(report).toContain("build:Defense Post:10");
      expect(report).toContain("build_defense/medium");
      expect(report).toContain("repeat=attackx2");
      expect(report).toContain("Fortify border");
      expect(report).toContain("Objective alignment: 1/1");
      expect(report).toContain("Objective Scorecard");
      expect(report).toContain("objective-scorecard.json");
      expect(report).toContain("External Agent Feedback");
      expect(report).toContain("external-agent-feedback.json");
      expect(report).toContain("Match Story");
      expect(report).toContain("match-story.json");
      expect(report).toContain("fortify_border/mock-llm");
      expect(report).toContain("defense_building 94");

      const visualReport = await fs.readFile(paths.visualReportPath, "utf8");
      expect(visualReport).toContain("<!doctype html>");
      expect(visualReport).toContain("Builder Agent");
      expect(visualReport).toContain("build:Defense Post:10");
      expect(visualReport).toContain("Product Timeline");
      expect(visualReport).toContain("Strategic priorities");
      expect(visualReport).toContain("Objectives");
      expect(visualReport).toContain("build_defense/medium");
      expect(visualReport).toContain("repeat=attackx2");
      expect(visualReport).toContain("Fortify border");
      expect(visualReport).toContain("Objective aligned");
      expect(visualReport).toContain("Objective Scorecard");
      expect(visualReport).toContain("External Agent Feedback");
      expect(visualReport).toContain("Match Story");
      expect(visualReport).toContain("Skill");
      expect(visualReport).toContain("defense_building 94");
      expect(visualReport).toContain("objective-scorecard.md");
      expect(visualReport).toContain("external-agent-feedback.md");
      expect(visualReport).toContain("match-story.md");
      expect(visualReport).toContain("match-package.html");
      expect(visualReport).toContain("match-package.md");
      expect(visualReport).toContain("spectator-telemetry.json");
      expect(visualReport).toContain("Open spectator replay");
      expect(visualReport).toContain("Open real Proxy War replay renderer");
      expect(visualReport).toContain("Post-spawn cycle 1");
      expect(visualReport).toContain("audit confirmed");
      expect(visualReport).toContain("decisions.jsonl");
      expect(paths.spectatorPath).not.toBeNull();
      expect(paths.spectatorReplayPath).not.toBeNull();
      const spectatorHtml = await fs.readFile(paths.spectatorPath!, "utf8");
      expect(spectatorHtml).toContain("No replay snapshots were captured");
      await expect(
        fs.readFile(paths.scorecardJsonPath, "utf8"),
      ).resolves.toContain('"aggregate"');
      await expect(
        fs.readFile(paths.scorecardMarkdownPath, "utf8"),
      ).resolves.toContain("Objective Scorecard");
      await expect(
        fs.readFile(paths.externalAgentFeedbackJsonPath, "utf8"),
      ).resolves.toContain('"externalAgentCount": 0');
      await expect(
        fs.readFile(paths.externalAgentFeedbackMarkdownPath, "utf8"),
      ).resolves.toContain("External Agent Feedback");
      await expect(
        fs.readFile(paths.matchStoryJsonPath, "utf8"),
      ).resolves.toContain('"entertainmentScore"');
      await expect(
        fs.readFile(paths.matchStoryMarkdownPath, "utf8"),
      ).resolves.toContain("Match Story");
      await expect(
        fs.readFile(paths.matchPackageJsonPath, "utf8"),
      ).resolves.toContain('"packageKind": "proxywar-match-package"');
      await expect(
        fs.readFile(paths.matchPackageMarkdownPath, "utf8"),
      ).resolves.toContain("Protocol Boundary");
      await expect(
        fs.readFile(paths.matchPackageHtmlPath, "utf8"),
      ).resolves.toContain("Proxy War Match Package");
      await expect(
        fs.readFile(paths.spectatorTelemetryPath, "utf8"),
      ).resolves.toContain('"events"');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("summarizes transport banking per same-turn decision cycle", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    try {
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "transport-batch-run",
        matchID: "AGENTLOG",
        scenario: "transport-banking",
        brainMode: "planner-executor",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        records: [
          transportBankingRecord(1, "attack", "attack:rival:20", 80),
          transportBankingRecord(2, "boat", "boat:444:25", 80),
        ],
        roster: [],
      });

      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary.tacticalAffordances.transportTroopBanking).toMatchObject({
        observedDecisionCount: 1,
        recommendedDecisionCount: 1,
        actedOnDecisionCount: 1,
        missedDecisionCount: 0,
      });
      const report = await fs.readFile(paths.reportPath, "utf8");
      expect(report).toContain(
        "Transport banking: 1/1 recommended opportunities acted on",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("summarizes frontier finish pressure per same-turn decision cycle", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    try {
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "finish-pressure-run",
        matchID: "AGENTLOG",
        scenario: "finish-pressure",
        brainMode: "planner-executor",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        records: [
          finishPressureRecord(1, "hold", "hold", 120),
          finishPressureRecord(2, "attack", "attack:rival-1:25", 120),
        ],
        roster: [],
      });

      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary.tacticalAffordances.frontierFinishPressure).toMatchObject({
        observedDecisionCount: 1,
        repeatedProbeDecisionCount: 1,
        recommendedDecisionCount: 1,
        actedOnDecisionCount: 1,
        missedDecisionCount: 0,
      });
      const report = await fs.readFile(paths.reportPath, "utf8");
      expect(report).toContain(
        "Frontier finish pressure: 1/1 recommended opportunities acted on",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("summarizes naval control per same-turn decision cycle", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    try {
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "naval-control-run",
        matchID: "AGENTLOG",
        scenario: "naval-control",
        brainMode: "planner-executor",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        records: [
          navalControlRecord(1, "hold", "hold", 140),
          navalControlRecord(2, "warship", "warship:Port:777", 140),
        ],
        roster: [],
      });

      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary.tacticalAffordances.navalControl).toMatchObject({
        observedDecisionCount: 1,
        recommendedDecisionCount: 1,
        actedOnDecisionCount: 1,
        missedDecisionCount: 0,
        averageRecommendedActiveTransportCount: 1,
        averageRecommendedSafeNavalActions: 2,
      });
      const report = await fs.readFile(paths.reportPath, "utf8");
      expect(report).toContain(
        "Naval control: 1/1 recommended opportunities acted on",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("summarizes late-game strike targeting per same-turn decision cycle", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    try {
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "strike-targeting-run",
        matchID: "AGENTLOG",
        scenario: "late-game-strike-targeting",
        brainMode: "planner-executor",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        records: [
          lateGameStrikeRecord(1, "hold", "hold", 2_200),
          lateGameStrikeRecord(
            2,
            "nuke",
            "nuke:Hydrogen Bomb:leader-1:777",
            2_200,
          ),
        ],
        roster: [],
      });

      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary.tacticalAffordances.lateGameStrikeTargeting).toMatchObject(
        {
          observedDecisionCount: 1,
          recommendedDecisionCount: 1,
          actedOnDecisionCount: 1,
          missedDecisionCount: 0,
          averageRecommendedBestStrikeScore: 210,
          averageRecommendedHighValueStrikes: 1,
        },
      );
      const report = await fs.readFile(paths.reportPath, "utf8");
      expect(report).toContain(
        "Late-game strike targeting: 1/1 recommended opportunities acted on",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects artifact ids that would escape the run directory", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    try {
      await expect(
        writeAgentLeagueRunArtifacts({
          rootDir,
          runID: "..",
          matchID: "AGENTLOG",
          scenario: "actions",
          brainMode: "mock-llm",
          startedAt: Date.UTC(2026, 0, 1),
          completedAt: Date.UTC(2026, 0, 1),
          records: [],
          roster: [],
        }),
      ).rejects.toThrow(/Invalid AI league artifact id/);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("records parser failure and fallback details in artifacts", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-league-"));
    const record: AgentDecisionRecord = {
      sequence: 1,
      gameID: "AGENTLOG",
      agentID: "agent-1",
      clientID: "CLIENT01",
      username: "Fallback Agent",
      profile: "opportunistic",
      brainType: "mock-llm",
      turnNumber: 3,
      decidedAt: Date.UTC(2026, 0, 1),
      decisionLatencyMs: 7,
      observationSummary: "opportunistic Fallback Agent: no valid model id",
      legalActionIDs: ["hold"],
      legalActionIDsByKind: { hold: ["hold"] },
      attackActionIDs: [],
      chosenActionID: "hold",
      chosenActionKind: "hold",
      reason: "LLM decision rejected; fallback: hold.",
      decisionMetadata: {
        brain: "llm",
        brainType: "mock-llm",
        llmRawOutput: '{"selectedLegalActionId":"missing"}',
        llmParseOk: false,
        llmParseFailureReason: "unknown selectedLegalActionId: missing",
        fallbackUsed: true,
        fallbackActionID: "hold",
      },
      intent: null,
      result: {
        accepted: true,
        reason: "hold action selected; no OpenFront intent submitted",
        submittedIntent: null,
      },
    };

    try {
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "fallback-run",
        matchID: "AGENTLOG",
        scenario: "normal",
        brainMode: "mock-llm",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1),
        records: [record],
        roster: [],
      });

      const decision = JSON.parse(
        (await fs.readFile(paths.decisionsPath, "utf8")).trim(),
      );
      expect(decision).toMatchObject({
        parseSuccess: false,
        parseFailureReason: "unknown selectedLegalActionId: missing",
        fallbackUsed: true,
        fallbackActionID: "hold",
        auditStatus: "not_applicable",
      });
      const summary = JSON.parse(await fs.readFile(paths.summaryPath, "utf8"));
      expect(summary).toMatchObject({
        fallbackCount: 1,
        parseFailureCount: 1,
      });
      const visual = await fs.readFile(paths.visualReportPath, "utf8");
      expect(visual).toContain("Fallback Agent");
      expect(visual).toContain("failed");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function transportBankingRecord(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
  turnNumber: number,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "AGENTLOG",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 5,
    observationSummary: "near cap with legal transport",
    strategicPriority: "naval",
    strategicUrgency: "medium",
    legalActionIDs: [chosenActionID, "boat:444:25", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      boat: ["boat:444:25"],
      hold: ["hold"],
    },
    attackActionIDs: chosenActionKind === "attack" ? [chosenActionID] : [],
    chosenActionID,
    chosenActionKind,
    reason: "test transport banking batch",
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

function navalControlRecord(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
  turnNumber: number,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "AGENTLOG",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Frontier",
    profile: "opportunistic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 5,
    observationSummary: "naval control window",
    strategicPriority: "naval",
    strategicUrgency: "medium",
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
    reason: "test naval control batch",
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
        turnNumber,
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

function lateGameStrikeRecord(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
  turnNumber: number,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "AGENTLOG",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Frontier",
    profile: "aggressive",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 5,
    observationSummary: "late-game strike window",
    strategicPriority: "nuclear",
    strategicUrgency: "high",
    legalActionIDs: [chosenActionID, "nuke:Hydrogen Bomb:leader-1:777", "hold"],
    legalActionIDsByKind: {
      [chosenActionKind]: [chosenActionID],
      nuke: ["nuke:Hydrogen Bomb:leader-1:777"],
      hold: ["hold"],
    },
    attackActionIDs: [],
    chosenActionID,
    chosenActionKind,
    reason: "test late-game strike batch",
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
        turnNumber,
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

function finishPressureRecord(
  sequence: number,
  chosenActionKind: AgentDecisionRecord["chosenActionKind"],
  chosenActionID: string,
  turnNumber: number,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "AGENTLOG",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Frontier",
    profile: "aggressive",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 5,
    observationSummary: "finish pressure window",
    strategicPriority: "attack",
    strategicUrgency: "high",
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
    reason: "test finish pressure batch",
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
        turnNumber,
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
