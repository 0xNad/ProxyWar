import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import {
  loadCommanderArmRunFromArtifacts,
  writeCommanderArmInputArtifacts,
  writeCommanderArmReport,
} from "../../src/server/agents/CommanderArmArtifacts";
import {
  buildCommanderArmReport,
  commanderArmReportJson,
  commanderArmReportMarkdown,
  fingerprintCommanderExperimentValue,
  type CommanderArmReport,
  type CommanderArmRunInput,
  type CommanderComponentHashes,
  type CommanderExperimentArm,
  type CommanderMatchedGameConfiguration,
} from "../../src/server/agents/CommanderArmReport";
import {
  COMMANDER_GAME_ID_DERIVATION_VERSION,
  commanderGameIDFromSeed,
} from "../../src/server/agents/CommanderExperimentIdentity";
import {
  advanceCommanderPlan,
  commanderRequestIdentity,
  type CommanderPlanMaterial,
  type CommanderPlanRequest,
} from "../../src/server/agents/CommanderPlanLifecycle";
import { parseCommanderResponse } from "../../src/server/agents/CommanderResponseParser";
import { selectDeterministicStrategicOption } from "../../src/server/agents/StrategicOptionSelectors";
import { fabricatedRecord } from "./DealTestHarness";
import { makeCommanderStage2Fixture } from "./StrategicCommanderStage2TestHarness";

const COMPONENT_HASHES: CommanderComponentHashes = {
  sharedArchitecture: "1".repeat(64),
  optionBuilder: "2".repeat(64),
  stateBuilder: "3".repeat(64),
  lifecycle: "4".repeat(64),
  executorAndFidelity: "5".repeat(64),
};

function testGameConfiguration(): CommanderMatchedGameConfiguration {
  return {
    schemaVersion: 1,
    scenario: "commander-artifact-e2e",
    runnerMode: "step-locked",
    agents: 1,
    opponentBrainMode: "starter-bot",
    planEveryDecisionSteps: 3,
    runner: {
      turnsPerDecisionStep: 25,
      turnsPerDecisionSchedule: null,
      maxDecisionMs: 5_000,
      maxSteps: 20,
      maxSpawnAdvanceTurns: 2_000,
      requireWinner: false,
      waitForMirrorCatchup: true,
      autopilotEndgameSteps: 0,
      replayTailTurns: 0,
      matchedOfferedOrderSpawnBallot: true,
      variedSpawns: false,
    },
    selectedGameConfig: {
      gameMap: "Asia",
      difficulty: "Medium",
      donateGold: false,
      donateTroops: false,
      gameType: "Private",
      gameMode: "Free For All",
      rankedType: null,
      gameMapSize: "Compact",
      publicGameModifiers: null,
      nations: "disabled",
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      disableNavMesh: null,
      disableAlliances: null,
      waterNukes: null,
      randomSpawn: false,
      maxPlayers: 4,
      maxTimerValue: null,
      spawnImmunityDuration: null,
      disabledUnits: [],
      playerTeams: null,
      goldMultiplier: null,
      startingGold: null,
      hostCheats: null,
    },
    disabledActionKinds: [],
    rosterPolicy: "subject-seat-0-vs-starter-bot",
  };
}

function firstTriplet(report: CommanderArmReport) {
  return report.triplets[0]!;
}

function tripletInvalidations(report: CommanderArmReport) {
  return firstTriplet(report).integrity.invalidationReasons;
}

function commanderRecord(input: {
  sequence: number;
  arm: "B" | "C";
  fidelity?: "aligned_primary" | "hold_plan_blocked";
  planID?: string;
  planInstalled?: boolean;
  fallback?: boolean;
  selected?: string;
  deterministic?: string;
  preferredAbsent?: boolean;
  previousPlanID?: string | null;
  replanReason?: string;
  failureKind?: string | null;
}): AgentDecisionRecord {
  const planID = input.planID ?? `${input.arm}-plan-1`;
  const selected = input.selected ?? "expand";
  const deterministic = input.deterministic ?? "expand";
  const fidelity = input.fidelity ?? "aligned_primary";
  const record = fabricatedRecord({
    sequence: input.sequence,
    agentID: "SUBJECT",
    playerID: "P1",
    username: "Subject",
    turnNumber: 10 + input.sequence,
    actionID: fidelity === "hold_plan_blocked" ? "hold" : "attack:neutral",
    kind: fidelity === "hold_plan_blocked" ? "hold" : "attack",
    auditStatus:
      fidelity === "hold_plan_blocked" ? "not_applicable" : "confirmed",
  });
  record.brainType = "strategic-commander";
  record.legalActionIDs = [record.chosenActionID];
  if (record.chosenActionKind !== "hold") {
    record.intent = { type: "attack", targetID: null, troops: 100 };
    record.result = {
      accepted: true,
      reason: "submitted",
      submittedIntent: record.intent,
    };
  }
  record.decisionMetadata = {
    runtimeMode: "commander-v0-selector",
    planID,
    planObjective: selected,
    planFollowed: fidelity === "aligned_primary",
    plannerFallbackUsed: input.fallback ?? false,
    externalPlannerCall: input.arm === "C" && input.planInstalled === true,
    plannerLatencyMs: input.arm === "C" ? 7 : 0,
    commanderPromptCharacters: input.arm === "C" ? 100 : 0,
    commanderSelectorSource:
      input.fallback === true
        ? "fallback-deterministic"
        : input.arm === "C"
          ? "llm"
          : "deterministic",
    commanderPrimarySelectorSource: input.arm === "C" ? "llm" : "deterministic",
    commanderFingerprint: "options:state",
    commanderEligibleOptionIds:
      "expand,develop_economy,pressure_rival:P7,pressure_rival:P9,survive,pressure_rival:P10",
    commanderExposedOptionIds:
      "expand,develop_economy,pressure_rival:P7,pressure_rival:P9,survive",
    commanderOmittedOptions: "pressure_rival:P10:pressure_target_cap",
    commanderFidelity: fidelity,
    commanderReplanReason: input.replanReason ?? "within_horizon",
    commanderPreviousPlanID: input.previousPlanID ?? null,
    commanderPlanInstalled: input.planInstalled ?? false,
    commanderHorizonDecisions: 3,
    commanderPlanAgeDecisions: input.sequence - 1,
    commanderDeterministicPreferredOptionId: deterministic,
    commanderDeterministicPreferredOptionAbsent: input.preferredAbsent ?? false,
    commanderSelectionFailureKind: input.failureKind ?? null,
    commanderSelectorProvider: input.arm === "C" ? "test" : null,
    commanderSelectorModel: input.arm === "C" ? "test-model" : null,
    commanderPromptVersion: input.arm === "C" ? "stage2" : null,
    commanderExperimentProvider: input.arm === "C" ? "test" : null,
    commanderExperimentModel: input.arm === "C" ? "test-model" : null,
    commanderExperimentPromptVersion: input.arm === "C" ? "stage2" : null,
    commanderSelfTiles: 100 + input.sequence,
    commanderSelfTroops: 1_000 + input.sequence * 10,
  };
  return record;
}

function armRun(
  arm: CommanderExperimentArm,
  records?: AgentDecisionRecord[],
): CommanderArmRunInput {
  const isA = arm === "A";
  const gameConfiguration = testGameConfiguration();
  const defaultRecords = isA
    ? [
        (() => {
          const record = fabricatedRecord({
            sequence: 1,
            agentID: "SUBJECT",
            playerID: "P1",
            username: "Subject",
            turnNumber: 11,
            actionID: "hold",
            kind: "hold",
          });
          record.brainType = "planner-executor";
          record.legalActionIDs = ["hold"];
          record.decisionMetadata = {
            plannerRan: true,
            planID: "A-plan-1",
          };
          return record;
        })(),
      ]
    : [
        commanderRecord({
          sequence: 1,
          arm,
          planInstalled: true,
          replanReason: "no_active_plan",
        }),
      ];
  const spawn = fabricatedRecord({
    sequence: 0,
    agentID: "SUBJECT",
    playerID: "P1",
    username: "Subject",
    turnNumber: 0,
    actionID: "spawn:100",
    kind: "spawn",
  });
  spawn.brainType = isA ? "planner-executor" : "strategic-commander";
  spawn.legalActionIDs = ["spawn:100"];
  spawn.intent = { type: "spawn", tile: 100 };
  spawn.result = {
    accepted: true,
    reason: "submitted",
    submittedIntent: spawn.intent,
  };
  spawn.audit = {
    auditStatus: "confirmed",
    auditReason: "spawn applied",
  };
  spawn.spawnSelectionEvidence = {
    algorithmVersion: "sealed-ranked-v1",
    offeredActionIDs: ["spawn:100"],
    ballotSource: "explicit-ranked",
    submittedBallotActionIDs: ["spawn:100"],
    submittedBallotEntryTypes: ["string"],
    submittedBallotCount: 1,
    submittedBallotTruncated: false,
    submittedReason: "matched test",
    normalizedBallotActionIDs: ["spawn:100"],
    ballotValid: true,
    ballotInvalidReason: null,
    defaultReason: null,
    participantID: "SUBJECT",
    priorityParticipantIDs: ["SUBJECT"],
    priorityOrder: ["Subject"],
    priorityRank: 1,
    assignedActionID: "spawn:100",
    assignedPreferenceRank: 1,
    assignedSubmittedPreferenceRank: 1,
    stageLatencyMs: 0,
    stageFallbackUsed: false,
    stageDegradationReason: null,
  };
  return {
    tripletID: "triplet-1",
    arm,
    sourceSha: "a".repeat(40),
    sourceTreeDirty: false,
    seed: "matched-seed",
    runID: "matched-run",
    selectorSource:
      arm === "A" ? "current-planner" : arm === "B" ? "deterministic" : "llm",
    provider: arm === "C" ? "test" : null,
    model: arm === "C" ? "test-model" : null,
    promptVersion: arm === "C" ? "stage2" : null,
    componentHashes: { ...COMPONENT_HASHES },
    artifactProvenance: null,
    experimentFlags: {
      localSmoke: true,
      requireWinner: false,
      structuredDeals: false,
      freeTextMessages: false,
      optionExposureUsesDeterministicPreference: false,
      matchedOfferedOrderSpawnBallot: true,
      autopilotEndgameSteps: 0,
    },
    gameConfiguration,
    gameConfigurationFingerprint:
      fingerprintCommanderExperimentValue(gameConfiguration),
    roster: [
      {
        agentID: "SUBJECT",
        username: "Subject",
        profile: "aggressive",
        clientID: "CLIENT-1",
        brainType: isA ? "planner-executor" : "strategic-commander",
      },
    ],
    subjectAgentID: "SUBJECT",
    records: [spawn, ...(records ?? defaultRecords)],
    finalState: {
      phase: "active",
      tick: 10,
      turnCount: 20,
      players: [
        {
          agentID: "SUBJECT",
          username: "Subject",
          profile: "aggressive",
          playerID: "P1",
          isAlive: true,
          tilesOwned: 40,
          troops: 1_000,
          gold: "100",
        },
      ],
      opponents: [
        {
          agentID: "OPPONENT",
          username: "Opponent",
          profile: "opportunistic",
          playerID: "P2",
          isAlive: true,
          tilesOwned: 60,
          troops: 1_100,
          gold: "100",
        },
      ],
    },
    winner: undefined,
    turnCount: 20,
    localSmoke: true,
    requireWinner: false,
    completed: false,
    autopilotEngagedAtStep: null,
  };
}

function addOpponentSpawn(
  run: CommanderArmRunInput,
  actionID = "spawn:200",
): CommanderArmRunInput {
  const opponent = {
    agentID: "OPPONENT",
    username: "Opponent",
    profile: "opportunistic" as const,
    clientID: "OPPONENT-CLIENT",
    brainType: "planner-executor" as const,
  };
  const spawn = fabricatedRecord({
    sequence: -1,
    agentID: opponent.agentID,
    playerID: "P2",
    username: opponent.username,
    turnNumber: 0,
    actionID,
    kind: "spawn",
  });
  spawn.profile = opponent.profile;
  spawn.brainType = opponent.brainType;
  spawn.legalActionIDs = [actionID];
  const tile = Number(actionID.slice("spawn:".length));
  spawn.intent = { type: "spawn", tile };
  spawn.result = {
    accepted: true,
    reason: "submitted",
    submittedIntent: spawn.intent,
  };
  spawn.audit = { auditStatus: "confirmed", auditReason: "spawn applied" };
  spawn.spawnSelectionEvidence = {
    algorithmVersion: "sealed-ranked-v1",
    offeredActionIDs: [actionID],
    ballotSource: "explicit-ranked",
    submittedBallotActionIDs: [actionID],
    submittedBallotEntryTypes: ["string"],
    submittedBallotCount: 1,
    submittedBallotTruncated: false,
    submittedReason: "matched test",
    normalizedBallotActionIDs: [actionID],
    ballotValid: true,
    ballotInvalidReason: null,
    defaultReason: null,
    participantID: "OPPONENT-PERSISTENT",
    priorityParticipantIDs: ["SUBJECT", "OPPONENT-PERSISTENT"],
    priorityOrder: ["Subject", "Opponent"],
    priorityRank: 2,
    assignedActionID: actionID,
    assignedPreferenceRank: 1,
    assignedSubmittedPreferenceRank: 1,
    stageLatencyMs: 0,
    stageFallbackUsed: false,
    stageDegradationReason: null,
  };
  run.roster.push(opponent);
  run.records.push(spawn);
  run.gameConfiguration.agents = run.roster.length;
  run.gameConfigurationFingerprint = fingerprintCommanderExperimentValue(
    run.gameConfiguration,
  );
  return run;
}

function promoteToPerformanceRun(input: {
  run: CommanderArmRunInput;
  tripletID: string;
  seed: string;
  subjectWon: boolean;
}): CommanderArmRunInput {
  const run = input.run;
  run.tripletID = input.tripletID;
  run.runID = input.tripletID;
  run.seed = input.seed;
  run.localSmoke = false;
  run.requireWinner = true;
  run.completed = true;
  run.experimentFlags.localSmoke = false;
  run.experimentFlags.requireWinner = true;
  run.finalState = { ...run.finalState!, phase: "finished" };
  run.winner = ["player", input.subjectWon ? "CLIENT-1" : "OPPONENT-CLIENT"];
  const runner = run.gameConfiguration.runner as Record<string, unknown>;
  runner.requireWinner = true;
  run.gameConfigurationFingerprint = fingerprintCommanderExperimentValue(
    run.gameConfiguration,
  );
  const hash = (kind: string) =>
    createHash("sha256")
      .update(`${input.tripletID}:${run.arm}:${kind}`)
      .digest("hex");
  run.artifactProvenance = {
    writer: "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts",
    manifestPath: `inputs/${input.tripletID}/${run.arm}/manifest.json`,
    decisionsPath: `inputs/${input.tripletID}/${run.arm}/decisions.jsonl`,
    decisionsSha256: hash("decisions"),
    summaryPath: `inputs/${input.tripletID}/${run.arm}/match-summary.json`,
    summarySha256: hash("summary"),
    executedRunID: input.tripletID,
    executedMatchID: commanderGameIDFromSeed(input.seed),
    executedSeed: input.seed,
    stepsCompleted: 20,
  };
  const active = run.records.find(
    (record) => record.chosenActionKind !== "spawn",
  )!;
  if (run.arm === "A" || run.arm === "C") {
    run.provider = "claude-cli";
    run.model = "claude-opus-4-8";
    run.promptVersion =
      run.arm === "A" ? "planner-current-v0" : "commander-stage2-v0";
    if (run.arm === "A") {
      active.decisionMetadata!.commanderRuntimeProvider = run.provider;
      active.decisionMetadata!.commanderRuntimeModel = run.model;
      active.decisionMetadata!.commanderRuntimePromptVersion =
        run.promptVersion;
    } else {
      active.decisionMetadata!.commanderSelectorProvider = run.provider;
      active.decisionMetadata!.commanderSelectorModel = run.model;
      active.decisionMetadata!.commanderPromptVersion = run.promptVersion;
    }
    active.decisionMetadata!.commanderExperimentProvider = run.provider;
    active.decisionMetadata!.commanderExperimentModel = run.model;
    active.decisionMetadata!.commanderExperimentPromptVersion =
      run.promptVersion;
  }
  return run;
}

function performanceTriplet(input: {
  tripletID: string;
  seed: string;
  subjectWins: Partial<Record<CommanderExperimentArm, boolean>>;
}): CommanderArmRunInput[] {
  return (["A", "B", "C"] as const).map((arm) =>
    promoteToPerformanceRun({
      run: armRun(arm),
      tripletID: input.tripletID,
      seed: input.seed,
      subjectWon: input.subjectWins[arm] ?? false,
    }),
  );
}

function lifecycleRequest(decisionSequence: number): CommanderPlanRequest {
  const fixture = makeCommanderStage2Fixture({ decisionSequence });
  return {
    gameID: fixture.observation.gameID,
    agentID: "SUBJECT",
    decisionSequence,
    turnNumber: fixture.observation.turnNumber,
    tick: fixture.observation.tick,
    exposedOptions: fixture.builtState.state.options,
    exposedOptionSetFingerprint:
      fixture.builtState.fingerprints.exposedOptionSet,
    materialStateFingerprint: fixture.builtState.fingerprints.materialState,
  };
}

function lifecycleMaterial(): CommanderPlanMaterial {
  return {
    tilesOwned: 300,
    troops: 20_000,
    incomingAttackerIDs: ["P5", "P6"],
    alivePlayerIDs: ["SELF", "P1", "P4", "P5", "P6", "P7", "P8"],
  };
}

describe("CommanderArmReport Stage 5 arithmetic and invalidation", () => {
  it("keeps the exact 95 percent fidelity boundary valid", () => {
    const b = Array.from({ length: 20 }, (_unused, index) =>
      commanderRecord({
        sequence: index + 1,
        arm: "B",
        planInstalled: index === 0,
        replanReason: index === 0 ? "no_active_plan" : "within_horizon",
        fidelity: index === 19 ? "hold_plan_blocked" : "aligned_primary",
      }),
    );
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B", b),
      armRun("C"),
    ]);

    expect(firstTriplet(report).arms.B.metrics.strategicFidelity).toBe(0.95);
    expect(firstTriplet(report).arms.B.metrics.normalizedFinalTerritory).toBe(
      0.4,
    );
    expect(firstTriplet(report).arms.B.metrics.omittedReasons).toEqual({
      pressure_target_cap: 20,
    });
    expect(report.integrity.valid).toBe(true);
    expect(report.status).toBe("plumbing-only");
    expect(report.performanceClaimsAllowed).toBe(false);
  });

  it("invalidates below-threshold fidelity and any silent abandonment", () => {
    const b = Array.from({ length: 20 }, (_unused, index) =>
      commanderRecord({
        sequence: index + 1,
        arm: "B",
        planInstalled: index === 0,
        fidelity: index >= 18 ? "hold_plan_blocked" : "aligned_primary",
        previousPlanID: index === 10 ? "B-plan-old" : null,
        replanReason: index === 10 ? "within_horizon" : "horizon_expiry",
      }),
    );
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B", b),
      armRun("C"),
    ]);

    expect(report.integrity.valid).toBe(false);
    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "Arm B strategic fidelity is below 95 percent",
        "Arm B silently abandoned a plan",
      ]),
    );
  });

  it("excludes fallback-authored plans from LLM selection and contribution counts", () => {
    const c = [
      commanderRecord({
        sequence: 1,
        arm: "C",
        planID: "C-llm",
        planInstalled: true,
        selected: "expand",
        deterministic: "survive",
        replanReason: "no_active_plan",
      }),
      commanderRecord({
        sequence: 2,
        arm: "C",
        planID: "C-fallback",
        planInstalled: true,
        fallback: true,
        selected: "develop_economy",
        deterministic: "develop_economy",
        previousPlanID: "C-llm",
        replanReason: "horizon_expiry",
      }),
    ];
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", c),
    ]);

    expect(firstTriplet(report).arms.C.metrics.fallbackAuthoredPlans).toBe(1);
    expect(
      firstTriplet(report).arms.C.metrics.excludedFromLlmContribution,
    ).toMatchObject({
      fallbackDecisionCycles: 1,
    });
    expect(
      firstTriplet(report).arms.C.metrics.selectedOptionDistribution,
    ).toEqual({
      expand: 1,
    });
    expect(firstTriplet(report).arms.C.metrics.selectorDisagreement).toEqual({
      count: 1,
      opportunities: 1,
      rate: 1,
    });
  });

  it("invalidates preferred-option absence and emits pure JSON and markdown", () => {
    const c = [
      commanderRecord({
        sequence: 1,
        arm: "C",
        planInstalled: true,
        deterministic: "pressure_rival:P10",
        preferredAbsent: true,
        replanReason: "no_active_plan",
      }),
    ];
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", c),
    ]);

    expect(tripletInvalidations(report)).toContain(
      "Arm C deterministic preferred option absence exceeds 5 percent",
    );
    const json = commanderArmReportJson(report);
    expect(JSON.parse(json)).toEqual(report);
    expect(json).not.toContain("legalActionIDs");
    expect(json).not.toContain("observationSummary");
    expect(json).not.toContain("plannerRawOutput");
    expect(commanderArmReportMarkdown(report)).toContain(
      "not evidence of strategic performance or LLM value",
    );
  });

  it("invalidates mismatched seed, config, spawn, and stale-response provenance", () => {
    const stale = commanderRecord({
      sequence: 1,
      arm: "C",
      planInstalled: true,
      replanReason: "no_active_plan",
    });
    stale.decisionMetadata!.commanderRejectionCode = "decision_sequence_stale";
    stale.decisionMetadata!.commanderResponseDisposition = "applied";
    const c = armRun("C", [stale]);
    c.seed = "different-seed";
    c.gameConfigurationFingerprint = "different-config";
    c.records[0]!.spawnSelectionEvidence!.assignedActionID = "spawn:999";
    const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);

    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "seed differs across arms",
        "matched game configuration differs across arms",
        "actual spawn assignments differ across arms",
        "Arm C applied or retained stale-response evidence",
      ]),
    );
    expect(firstTriplet(report).arms.C).toMatchObject({
      sourceSha: "a".repeat(40),
      selectorSource: "llm",
      provider: "test",
      model: "test-model",
      promptVersion: "stage2",
    });
  });

  it("recomputes matching and selector gates from captured evidence instead of trusting labels", () => {
    const c = armRun("C");
    c.gameConfiguration.selectedGameConfig.gameMap = "Europe";
    delete c.records[0]!.spawnSelectionEvidence;
    c.experimentFlags.optionExposureUsesDeterministicPreference = true;
    c.experimentFlags.freeTextMessages = true;
    c.records[1]!.decisionMetadata!.commanderPrimarySelectorSource =
      "deterministic";

    const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);

    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "experiment flags differ across arms",
        "option exposure preference-independence is not proven",
        "excluded social experiment flags are not proven off",
        "matched game configuration differs across arms",
        "recorded game configuration fingerprint does not match its configuration",
        "actual spawn assignments differ across arms",
        "Arm C actual spawn assignments are incomplete",
        "Arm C run labels disagree with plan-start telemetry",
        "Arm B/C plan starts do not prove selector authority",
      ]),
    );
  });

  it("rejects unknown run and experiment-flag keys without projecting private canaries", () => {
    const runCanary = "PRIVATE_IN_MEMORY_RUN_CANARY";
    const unknownRun = armRun("C") as CommanderArmRunInput &
      Record<string, unknown>;
    unknownRun[runCanary] = "private transport body";
    let runError = "";
    try {
      buildCommanderArmReport([armRun("A"), armRun("B"), unknownRun]);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    }
    expect(runError).toBe("Commander run has unknown or missing fields");
    expect(runError).not.toContain(runCanary);

    const flagCanary = "PRIVATE_IN_MEMORY_FLAG_CANARY";
    const unknownFlag = armRun("C");
    (unknownFlag.experimentFlags as unknown as Record<string, unknown>)[
      flagCanary
    ] = "private transport body";
    let flagError = "";
    try {
      buildCommanderArmReport([armRun("A"), armRun("B"), unknownFlag]);
    } catch (error) {
      flagError = error instanceof Error ? error.message : String(error);
    }
    expect(flagError).toBe(
      "Commander experiment flags have unknown or missing fields",
    );
    expect(flagError).not.toContain(flagCanary);

    const publicText = `${commanderArmReportJson(
      buildCommanderArmReport([armRun("A"), armRun("B"), armRun("C")]),
    )}${commanderArmReportMarkdown(
      buildCommanderArmReport([armRun("A"), armRun("B"), armRun("C")]),
    )}`;
    expect(publicText).not.toContain(runCanary);
    expect(publicText).not.toContain(flagCanary);
  });

  it("invalidates an unclassified Commander action even when classified rows are perfect", () => {
    const bRecords = [
      commanderRecord({
        sequence: 1,
        arm: "B",
        planInstalled: true,
        replanReason: "no_active_plan",
      }),
      commanderRecord({ sequence: 2, arm: "B" }),
    ];
    delete bRecords[1]!.decisionMetadata!.commanderFidelity;

    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B", bRecords),
      armRun("C"),
    ]);

    expect(firstTriplet(report).arms.B.metrics.strategicFidelity).toBe(1);
    expect(tripletInvalidations(report)).toContain(
      "Arm B fidelity accounting is incomplete",
    );
  });

  it("reloads canonical persisted arm artifacts before writing the report", async () => {
    const comparisonDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "commander-comparison-"),
    );
    try {
      const runs = [armRun("A"), armRun("B"), armRun("C")];
      const matchID = commanderGameIDFromSeed(runs[0]!.seed);
      const manifestPaths = await Promise.all(
        runs.map((run) =>
          writeCommanderArmInputArtifacts({
            comparisonDirectory,
            run,
            artifactInput: {
              runID: run.runID,
              matchID,
              scenario: "commander-artifact-e2e",
              brainMode: run.roster[0]!.brainType,
              runnerMode: "step-locked",
              runnerConfig: {
                executionConfigSchemaVersion: 1,
                turnsPerDecisionStep: 25,
                turnsPerDecisionSchedule: null,
                maxDecisionMs: 5_000,
                maxSteps: 20,
                stepsCompleted: 1,
                planEveryDecisionSteps: 3,
                maxSpawnAdvanceTurns: 2_000,
                waitForMirrorCatchup: true,
                requireWinner: run.requireWinner,
                autopilotEndgameSteps: 0,
                autopilotEngagedAtStep: run.autopilotEngagedAtStep,
                replayTailTurns: 0,
                agents: 1,
                bots: 0,
                nations: "disabled",
                map: "Asia",
                mapSize: "Compact",
                difficulty: "Medium",
                variedSpawns: false,
                matchedOfferedOrderSpawnBallot: true,
                disabledActionKinds: [],
                opponentBrainMode: "starter-bot",
                rosterPolicy: "subject-seat-0-vs-starter-bot",
                executionSeed: run.seed,
                executionGameID: matchID,
                executionGameIDDerivation: COMMANDER_GAME_ID_DERIVATION_VERSION,
                selectedGameConfig: run.gameConfiguration.selectedGameConfig,
                structuredDealsEnabled: false,
                freeTextMessagesEnabled: false,
              },
              startedAt: 0,
              completedAt: 1,
              records: run.records,
              roster: run.roster,
              finalState: run.finalState,
              winner: run.winner,
            },
          }),
        ),
      );
      const persisted = await writeCommanderArmReport({
        comparisonDirectory,
        manifestPaths,
      });
      const parsed = JSON.parse(
        await fs.readFile(persisted.jsonPath, "utf8"),
      ) as CommanderArmReport;

      expect(parsed).toEqual(persisted.report);
      expect(parsed.integrity.valid).toBe(true);
      expect(parsed.triplets[0]!.arms.C.artifactProvenance).toMatchObject({
        writer: "AgentDecisionLogWriter.writeAgentLeagueRunArtifacts",
        decisionsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        summarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        executedRunID: "matched-run",
        executedMatchID: matchID,
        executedSeed: "matched-seed",
        stepsCompleted: 1,
      });
      await expect(
        fs.readFile(persisted.markdownPath, "utf8"),
      ).resolves.toContain("plumbing evidence only");
      await expect(fs.readFile(manifestPaths[0]!, "utf8")).resolves.toContain(
        '"decisionsPath"',
      );
      const mutatePersistedDecision = async (
        manifestPath: string,
        select: (entry: Record<string, unknown>) => boolean,
        mutate: (entry: Record<string, unknown>) => void,
      ) => {
        const originalManifestText = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(originalManifestText) as {
          artifacts: {
            decisionsPath: string;
            decisionsSha256: string;
          };
        };
        const decisionsPath = path.resolve(
          path.dirname(manifestPath),
          manifest.artifacts.decisionsPath,
        );
        const originalDecisionsText = await fs.readFile(decisionsPath, "utf8");
        const entries = originalDecisionsText
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const selected = entries.find(select);
        expect(selected).toBeDefined();
        mutate(selected!);
        const decisionsText = `${entries
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`;
        await fs.writeFile(decisionsPath, decisionsText, "utf8");
        manifest.artifacts.decisionsSha256 = createHash("sha256")
          .update(decisionsText)
          .digest("hex");
        await fs.writeFile(
          manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        return async () => {
          await Promise.all([
            fs.writeFile(decisionsPath, originalDecisionsText, "utf8"),
            fs.writeFile(manifestPath, originalManifestText, "utf8"),
          ]);
        };
      };
      const selectActive = (entry: Record<string, unknown>) =>
        entry.selectedActionKind !== "spawn";
      const restoreRejectedActive = await mutatePersistedDecision(
        manifestPaths[1]!,
        selectActive,
        (entry) => {
          (entry.result as Record<string, unknown>).accepted = false;
        },
      );
      const restoreNullActive = await mutatePersistedDecision(
        manifestPaths[2]!,
        selectActive,
        (entry) => {
          (entry.result as Record<string, unknown>).submittedIntent = null;
        },
      );
      const forgedArtifactRuns = await Promise.all(
        manifestPaths.map((manifestPath) =>
          loadCommanderArmRunFromArtifacts(manifestPath, comparisonDirectory),
        ),
      );
      const forgedArtifactReport = buildCommanderArmReport(forgedArtifactRuns);
      expect(
        forgedArtifactReport.triplets[0]!.arms.B.metrics
          .canonicalPathViolations,
      ).toBe(1);
      expect(
        forgedArtifactReport.triplets[0]!.arms.C.metrics
          .canonicalPathViolations,
      ).toBe(1);
      expect(
        forgedArtifactReport.triplets[0]!.integrity.invalidationReasons,
      ).toEqual(
        expect.arrayContaining([
          "Arm B failed offered-id, acceptance, submitted-intent, or step-locked audit proof",
          "Arm C failed offered-id, acceptance, submitted-intent, or step-locked audit proof",
        ]),
      );
      await Promise.all([restoreRejectedActive(), restoreNullActive()]);

      const spawnMutations: Array<{
        label: string;
        mutate: (entry: Record<string, unknown>) => void;
      }> = [
        {
          label: "rejected result",
          mutate: (entry) => {
            (entry.result as Record<string, unknown>).accepted = false;
          },
        },
        {
          label: "null submitted intent",
          mutate: (entry) => {
            (entry.result as Record<string, unknown>).submittedIntent = null;
          },
        },
        {
          label: "mismatched submitted intent",
          mutate: (entry) => {
            (entry.result as Record<string, unknown>).submittedIntent = {
              type: "spawn",
              tile: 999_999,
            };
          },
        },
        {
          label: "unoffered chosen ID",
          mutate: (entry) => {
            entry.selectedLegalActionId = "spawn:999999";
          },
        },
        {
          label: "unknown audit",
          mutate: (entry) => {
            entry.auditStatus = "unknown";
          },
        },
      ];
      for (const mutation of spawnMutations) {
        const restore = await mutatePersistedDecision(
          manifestPaths[0]!,
          (entry) => entry.selectedActionKind === "spawn",
          mutation.mutate,
        );
        const mutatedRuns = await Promise.all(
          manifestPaths.map((manifestPath) =>
            loadCommanderArmRunFromArtifacts(manifestPath, comparisonDirectory),
          ),
        );
        const mutatedReport = buildCommanderArmReport(mutatedRuns);
        expect(
          mutatedReport.triplets[0]!.arms.A.metrics.canonicalPathViolations,
          mutation.label,
        ).toBe(1);
        expect(
          mutatedReport.triplets[0]!.integrity.invalidationReasons,
          mutation.label,
        ).toContain(
          "Arm A failed offered-id, acceptance, submitted-intent, or step-locked audit proof",
        );
        await restore();
      }
      const manifestText = await fs.readFile(manifestPaths[0]!, "utf8");
      const manifest = JSON.parse(manifestText) as {
        run: Record<string, unknown> & {
          experimentFlags: Record<string, unknown>;
          seed: string;
        };
        artifacts: {
          decisionsPath: string;
          summaryPath: string;
          summarySha256: string;
        };
      };
      const summaryPath = path.resolve(
        path.dirname(manifestPaths[0]!),
        manifest.artifacts.summaryPath,
      );
      const summaryText = await fs.readFile(summaryPath, "utf8");
      const rejectionText = async (promise: Promise<unknown>) => {
        try {
          await promise;
          throw new Error("expected Commander artifact rejection");
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const persistedPublicText = `${await fs.readFile(
        persisted.jsonPath,
        "utf8",
      )}\n${await fs.readFile(persisted.markdownPath, "utf8")}`;
      const runCanary = "PRIVATE_UNKNOWN_RUN_CANARY";
      const runCanaryManifest = JSON.parse(manifestText) as typeof manifest;
      runCanaryManifest.run[runCanary] = "private transport body";
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(runCanaryManifest, null, 2)}\n`,
        "utf8",
      );
      const runCanaryError = await rejectionText(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      );
      expect(runCanaryError).toBe(
        "Commander arm manifest run has unknown or missing fields",
      );
      expect(runCanaryError).not.toContain(runCanary);
      await expect(
        writeCommanderArmReport({ comparisonDirectory, manifestPaths }),
      ).rejects.toThrow(
        "Commander arm manifest run has unknown or missing fields",
      );
      expect(persistedPublicText).not.toContain(runCanary);
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");

      const flagCanary = "PRIVATE_UNKNOWN_FLAG_CANARY";
      const flagCanaryManifest = JSON.parse(manifestText) as typeof manifest;
      flagCanaryManifest.run.experimentFlags[flagCanary] =
        "private transport body";
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(flagCanaryManifest, null, 2)}\n`,
        "utf8",
      );
      const flagCanaryError = await rejectionText(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      );
      expect(flagCanaryError).toBe(
        "Commander experiment flags have unknown or missing fields",
      );
      expect(flagCanaryError).not.toContain(flagCanary);
      await expect(
        writeCommanderArmReport({ comparisonDirectory, manifestPaths }),
      ).rejects.toThrow(
        "Commander experiment flags have unknown or missing fields",
      );
      expect(persistedPublicText).not.toContain(flagCanary);
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");

      const rosterCanary = "PRIVATE_ROSTER_ROW_CANARY";
      const rosterCanarySummary = JSON.parse(summaryText) as {
        roster: Array<Record<string, unknown>>;
      };
      rosterCanarySummary.roster[0]![rosterCanary] = "private transport body";
      const rosterCanarySummaryText = `${JSON.stringify(
        rosterCanarySummary,
        null,
        2,
      )}\n`;
      const rosterCanaryManifest = JSON.parse(manifestText) as typeof manifest;
      rosterCanaryManifest.artifacts.summarySha256 = createHash("sha256")
        .update(rosterCanarySummaryText)
        .digest("hex");
      await fs.writeFile(summaryPath, rosterCanarySummaryText, "utf8");
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(rosterCanaryManifest, null, 2)}\n`,
        "utf8",
      );
      const rosterCanaryError = await rejectionText(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      );
      expect(rosterCanaryError).toBe(
        "Commander roster row has unknown or missing fields",
      );
      expect(rosterCanaryError).not.toContain(rosterCanary);
      expect(persistedPublicText).not.toContain(rosterCanary);
      await fs.writeFile(summaryPath, summaryText, "utf8");
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");

      const mismatchedSummary = JSON.parse(summaryText) as {
        runnerConfig: Record<string, unknown>;
      };
      mismatchedSummary.runnerConfig.map = "Europe";
      mismatchedSummary.runnerConfig.planEveryDecisionSteps = 7;
      const mismatchedSummaryText = `${JSON.stringify(
        mismatchedSummary,
        null,
        2,
      )}\n`;
      await fs.writeFile(summaryPath, mismatchedSummaryText, "utf8");
      manifest.artifacts.summarySha256 = createHash("sha256")
        .update(mismatchedSummaryText)
        .digest("hex");
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await expect(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      ).rejects.toThrow(
        "Commander selected game configuration disagrees with runner summary",
      );

      await fs.writeFile(summaryPath, summaryText, "utf8");
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");
      const materialConfigSummary = JSON.parse(summaryText) as {
        runnerConfig: {
          selectedGameConfig: Record<string, unknown>;
        };
      };
      materialConfigSummary.runnerConfig.selectedGameConfig.startingGold = 123_456;
      const materialConfigSummaryText = `${JSON.stringify(
        materialConfigSummary,
        null,
        2,
      )}\n`;
      const materialConfigManifest = JSON.parse(
        manifestText,
      ) as typeof manifest;
      materialConfigManifest.artifacts.summarySha256 = createHash("sha256")
        .update(materialConfigSummaryText)
        .digest("hex");
      await fs.writeFile(summaryPath, materialConfigSummaryText, "utf8");
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(materialConfigManifest, null, 2)}\n`,
        "utf8",
      );
      await expect(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      ).rejects.toThrow(
        "Commander game configuration disagrees with canonical match summary",
      );

      await fs.writeFile(summaryPath, summaryText, "utf8");
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");
      const seedMismatchedSummary = JSON.parse(summaryText) as {
        runnerConfig: Record<string, unknown>;
      };
      seedMismatchedSummary.runnerConfig.executionSeed = "forged-seed";
      const seedMismatchedText = `${JSON.stringify(
        seedMismatchedSummary,
        null,
        2,
      )}\n`;
      await fs.writeFile(summaryPath, seedMismatchedText, "utf8");
      const seedManifest = JSON.parse(manifestText) as typeof manifest;
      seedManifest.artifacts.summarySha256 = createHash("sha256")
        .update(seedMismatchedText)
        .digest("hex");
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(seedManifest, null, 2)}\n`,
        "utf8",
      );
      await expect(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      ).rejects.toThrow("Commander execution seed disagrees with manifest");

      await fs.writeFile(summaryPath, summaryText, "utf8");
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");
      const relabeledSeed = "consistent-relabel-seed";
      const relabeledSummary = JSON.parse(summaryText) as {
        matchID: string;
        runnerConfig: Record<string, unknown>;
      };
      relabeledSummary.matchID = "CMffffff";
      relabeledSummary.runnerConfig.executionSeed = relabeledSeed;
      relabeledSummary.runnerConfig.executionGameID = "CMffffff";
      const relabeledSummaryText = `${JSON.stringify(
        relabeledSummary,
        null,
        2,
      )}\n`;
      const relabeledManifest = JSON.parse(manifestText) as typeof manifest;
      relabeledManifest.run.seed = relabeledSeed;
      relabeledManifest.artifacts.summarySha256 = createHash("sha256")
        .update(relabeledSummaryText)
        .digest("hex");
      await fs.writeFile(summaryPath, relabeledSummaryText, "utf8");
      await fs.writeFile(
        manifestPaths[0]!,
        `${JSON.stringify(relabeledManifest, null, 2)}\n`,
        "utf8",
      );
      await expect(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      ).rejects.toThrow(
        "Commander execution game identity disagrees with match summary",
      );

      await fs.writeFile(summaryPath, summaryText, "utf8");
      await fs.writeFile(manifestPaths[0]!, manifestText, "utf8");
      const decisionsPath = path.resolve(
        path.dirname(manifestPaths[0]!),
        manifest.artifacts.decisionsPath,
      );
      await fs.appendFile(decisionsPath, "\n", "utf8");
      await expect(
        loadCommanderArmRunFromArtifacts(manifestPaths[0]!),
      ).rejects.toThrow("Commander decisions artifact hash mismatch");
    } finally {
      await fs.rm(comparisonDirectory, { recursive: true, force: true });
    }
  });

  it("permits performance interpretation only for replicated completed artifact-backed triplets", () => {
    const report = buildCommanderArmReport([
      ...performanceTriplet({
        tripletID: "replica-1",
        seed: "seed-1",
        subjectWins: { C: true },
      }),
      ...performanceTriplet({
        tripletID: "replica-2",
        seed: "seed-2",
        subjectWins: { B: true, C: true },
      }),
    ]);

    expect(report.status).toBe("eligible-for-performance-interpretation");
    expect(report.performanceEligibility).toEqual({
      eligible: true,
      reasons: [],
    });
    expect(report.aggregate.arms.A.wins).toEqual({
      count: 0,
      opportunities: 2,
      rate: 0,
    });
    expect(report.aggregate.arms.B.wins).toEqual({
      count: 1,
      opportunities: 2,
      rate: 0.5,
    });
    expect(report.aggregate.arms.C.wins).toEqual({
      count: 2,
      opportunities: 2,
      rate: 1,
    });
  });

  it("keeps relabeled mock, partial, single-triplet, and autopilot outcomes ineligible", () => {
    const single = performanceTriplet({
      tripletID: "replica-1",
      seed: "seed-1",
      subjectWins: { C: true },
    });
    single[2]!.provider = "mock-provider";
    single[2]!.model = "scripted-mock-model";
    single[2]!.records[1]!.decisionMetadata!.commanderSelectorProvider =
      "mock-provider";
    single[2]!.records[1]!.decisionMetadata!.commanderSelectorModel =
      "scripted-mock-model";
    single[2]!.records[1]!.decisionMetadata!.commanderExperimentProvider =
      "mock-provider";
    single[2]!.records[1]!.decisionMetadata!.commanderExperimentModel =
      "scripted-mock-model";
    single[1]!.completed = false;
    single[1]!.winner = undefined;
    single[1]!.finalState = { ...single[1]!.finalState!, phase: "active" };
    single[0]!.autopilotEngagedAtStep = 3;

    const report = buildCommanderArmReport(single);

    expect(report.status).toBe("invalid");
    expect(tripletInvalidations(report)).toContain(
      "local-smoke label disagrees with mock provider/model provenance",
    );
    expect(report.performanceEligibility.reasons).toEqual(
      expect.arrayContaining([
        "fewer than 2 replicated matched triplets",
        "one or more arms lack a completed winner-determined match",
        "one or more final outcomes were contaminated by autopilot",
        "provider/model provenance is missing, mock, or scripted",
      ]),
    );
  });

  it("invalidates adversarial option accounting, emergencies, and action-plan shape", () => {
    const b = armRun("B");
    const bActive = b.records[1]!;
    bActive.decisionMetadata!.commanderEligibleOptionIds =
      "expand,expand,pressure_rival:P7,survive";
    bActive.decisionMetadata!.commanderExposedOptionIds =
      "expand,pressure_rival:P7,pressure_rival:P8,pressure_rival:P9,survive";
    bActive.decisionMetadata!.commanderOmittedOptions =
      "develop_economy:not_permitted";
    bActive.decisionMetadata!.commanderFidelity = "hard_emergency_override";
    const c = armRun("C", [
      commanderRecord({
        sequence: 1,
        arm: "C",
        planInstalled: true,
        replanReason: "no_active_plan",
        fidelity: "hold_plan_blocked",
      }),
      commanderRecord({
        sequence: 2,
        arm: "C",
        fidelity: "aligned_primary",
      }),
    ]);
    c.records[1]!.decisionMetadata!.commanderFidelity = "aligned_support";
    c.records[2]!.decisionMetadata!.commanderFidelity = "aligned_support";

    const report = buildCommanderArmReport([armRun("A"), b, c]);

    expect(
      firstTriplet(report).arms.B.metrics.optionAccountingViolations,
    ).toBeGreaterThan(0);
    expect(firstTriplet(report).arms.B.metrics.fidelityCounts.emergency).toBe(
      1,
    );
    expect(
      firstTriplet(report).arms.C.metrics.planPrimaryActionViolations,
    ).toBe(1);
    expect(
      firstTriplet(report).arms.C.metrics.planSupportActionViolations,
    ).toBe(1);
    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "Arm B used a forbidden V0 emergency action",
        "Arm B option accounting is invalid",
        "Arm C has a plan without a primary action",
        "Arm C has more than one support action in a plan",
      ]),
    );
  });

  it("recomputes exact adjacent plan-transition provenance", () => {
    const b = armRun("B", [
      commanderRecord({
        sequence: 1,
        arm: "B",
        planID: "B-plan-1",
        planInstalled: true,
        previousPlanID: "forged-prior",
        replanReason: "no_active_plan",
      }),
      commanderRecord({
        sequence: 2,
        arm: "B",
        planID: "B-plan-2",
        planInstalled: true,
        previousPlanID: "wrong-plan",
        replanReason: "within_horizon",
      }),
    ]);
    const report = buildCommanderArmReport([armRun("A"), b, armRun("C")]);

    expect(firstTriplet(report).arms.B.metrics.planTransitions).toEqual({
      count: 2,
      proven: 0,
      violations: 2,
    });
    expect(tripletInvalidations(report)).toContain(
      "Arm B silently abandoned a plan",
    );
  });

  it("excludes rejected stale attempts but invalidates stale authority", () => {
    const staleAttempt = () => {
      const record = commanderRecord({
        sequence: 2,
        arm: "C",
        planID: "C-fallback",
        planInstalled: true,
        fallback: true,
        previousPlanID: "C-live",
        replanReason: "horizon_expiry",
      });
      record.decisionMetadata!.commanderResponseDisposition = "rejected";
      record.decisionMetadata!.commanderRejectionCode =
        "decision_sequence_stale";
      record.decisionMetadata!.degradedCause = "plan-stale";
      return record;
    };
    const live = commanderRecord({
      sequence: 1,
      arm: "C",
      planID: "C-live",
      planInstalled: true,
      replanReason: "no_active_plan",
    });
    const rejected = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", [live, staleAttempt()]),
    ]);

    expect(firstTriplet(rejected).arms.C.metrics.staleRejectedAttempts).toBe(1);
    expect(firstTriplet(rejected).arms.C.metrics.staleAuthorityViolations).toBe(
      0,
    );
    expect(tripletInvalidations(rejected)).not.toContain(
      "Arm C applied or retained stale-response evidence",
    );

    const applied = staleAttempt();
    applied.decisionMetadata!.commanderResponseDisposition = "applied";
    const invalid = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", [live, applied]),
    ]);
    expect(firstTriplet(invalid).arms.C.metrics.staleAuthorityViolations).toBe(
      1,
    );
    expect(tripletInvalidations(invalid)).toContain(
      "Arm C applied or retained stale-response evidence",
    );
  });

  it("classifies a real stale fallback lifecycle continuation as fallback, not retained stale authority", () => {
    const request = lifecycleRequest(7);
    const staleIdentity = {
      ...commanderRequestIdentity(request),
      decisionSequence: 6,
    };
    const parsed = parseCommanderResponse(
      JSON.stringify({
        selectedStrategicOptionId: request.exposedOptions[0]!.id,
        horizonDecisions: 3,
        intent: "stale response must not retain authority",
        replanTriggers: [],
      }),
      staleIdentity.exposedOptionIDs,
    );
    const deterministicFallback = selectDeterministicStrategicOption(
      makeCommanderStage2Fixture().builtState.state,
      request.exposedOptions,
    );
    const first = advanceCommanderPlan({
      active: null,
      request,
      material: lifecycleMaterial(),
      response: { identity: staleIdentity, parsed },
      fallbackSelection: deterministicFallback,
    });
    expect(first).toMatchObject({
      responseDisposition: "rejected",
      rejection: { code: "decision_sequence_stale" },
      selector: "fallback",
      planPreserved: false,
    });
    const continued = advanceCommanderPlan({
      active: first.plan,
      request: {
        ...request,
        decisionSequence: 8,
        turnNumber: request.turnNumber + 1,
        tick: (request.tick ?? 0) + 1,
      },
      material: lifecycleMaterial(),
      response: null,
      fallbackSelection: deterministicFallback,
    });
    expect(continued).toMatchObject({
      responseDisposition: "absent",
      rejection: null,
      selector: "fallback",
      planPreserved: true,
    });

    const records = [first, continued].map((cycle, index) => {
      const plan = cycle.plan!;
      const record = commanderRecord({
        sequence: index + 1,
        arm: "C",
        planID: plan.planID,
        planInstalled: !cycle.planPreserved,
        fallback: true,
        selected: plan.selectedStrategicOptionId,
        replanReason: cycle.evaluation.reason,
      });
      Object.assign(record.decisionMetadata!, {
        commanderResponseDisposition: cycle.responseDisposition,
        commanderRejectionCode: cycle.rejection?.code ?? null,
        commanderPreviousPlanID: null,
        commanderPlanAgeDecisions: cycle.evaluation.ageDecisions,
        degradedCause: plan.fallbackDegradationCause,
      });
      return record;
    });
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", records),
    ]);
    const metrics = firstTriplet(report).arms.C.metrics;

    expect(metrics.staleRejectedAttempts).toBe(1);
    expect(metrics.staleAuthorityViolations).toBe(0);
    expect(metrics.fallbackAuthoredPlans).toBe(1);
    expect(metrics.excludedFromLlmContribution).toMatchObject({
      fallbackDecisionCycles: 2,
      fallbackActionRecords: 2,
      staleDecisionCycles: 1,
    });
    expect(tripletInvalidations(report)).not.toContain(
      "Arm C applied or retained stale-response evidence",
    );

    for (const record of records) {
      record.decisionMetadata!.plannerFallbackUsed = false;
      record.decisionMetadata!.commanderSelectorSource = "llm";
    }
    const doubleStampCorrupted = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", records),
    ]);
    expect(
      firstTriplet(doubleStampCorrupted).arms.C.metrics.fallbackAuthoredPlans,
    ).toBe(1);
    expect(
      firstTriplet(doubleStampCorrupted).arms.C.metrics
        .excludedFromLlmContribution,
    ).toMatchObject({
      fallbackDecisionCycles: 2,
      fallbackActionRecords: 2,
    });
    expect(
      firstTriplet(doubleStampCorrupted).arms.C.metrics.fallbackStampViolations,
    ).toBeGreaterThan(0);
    expect(tripletInvalidations(doubleStampCorrupted)).toContain(
      "Arm C fallback plan provenance is inconsistent",
    );
  });

  it("independently excludes timeout and parse fallback plans when both fallback stamps are forged off", () => {
    for (const [failureKind, degradedCause] of [
      ["timeout", "plan-timeout"],
      ["parse", "plan-parse"],
    ] as const) {
      const record = commanderRecord({
        sequence: 1,
        arm: "C",
        planID: `C-${failureKind}-fallback`,
        planInstalled: true,
        fallback: false,
        failureKind,
        replanReason: "no_active_plan",
      });
      record.decisionMetadata!.degradedCause = degradedCause;
      record.decisionMetadata!.commanderSelectorSource = "llm";
      record.decisionMetadata!.plannerFallbackUsed = false;
      const report = buildCommanderArmReport([
        armRun("A"),
        armRun("B"),
        armRun("C", [record]),
      ]);
      const metrics = firstTriplet(report).arms.C.metrics;

      expect(metrics.fallbackAuthoredPlans, failureKind).toBe(1);
      expect(metrics.excludedFromLlmContribution, failureKind).toMatchObject({
        fallbackDecisionCycles: 1,
        fallbackActionRecords: 1,
      });
      expect(metrics.fallbackStampViolations, failureKind).toBeGreaterThan(0);
      expect(tripletInvalidations(report), failureKind).toContain(
        "Arm C fallback plan provenance is inconsistent",
      );
    }
  });

  it("excludes an entire fallback-authored plan and invalidates a corrupted continuation stamp", () => {
    const fallbackRecords = [
      commanderRecord({
        sequence: 1,
        arm: "C",
        planID: "C-fallback-plan",
        planInstalled: true,
        fallback: true,
        replanReason: "no_active_plan",
      }),
      commanderRecord({
        sequence: 2,
        arm: "C",
        planID: "C-fallback-plan",
        fallback: true,
        replanReason: "within_horizon",
      }),
    ];
    for (const record of fallbackRecords) {
      record.decisionMetadata!.degradedCause = "plan-parse";
    }
    const valid = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", fallbackRecords),
    ]);
    expect(
      firstTriplet(valid).arms.C.metrics.excludedFromLlmContribution,
    ).toMatchObject({
      fallbackDecisionCycles: 2,
      fallbackActionRecords: 2,
    });
    expect(firstTriplet(valid).arms.C.metrics.fallbackStampViolations).toBe(0);

    fallbackRecords[1]!.decisionMetadata!.plannerFallbackUsed = false;
    fallbackRecords[1]!.decisionMetadata!.commanderSelectorSource = "llm";
    const corrupted = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", fallbackRecords),
    ]);
    expect(
      firstTriplet(corrupted).arms.C.metrics.fallbackStampViolations,
    ).toBeGreaterThan(0);
    expect(tripletInvalidations(corrupted)).toContain(
      "Arm C fallback plan provenance is inconsistent",
    );
  });

  it("recomputes deterministic-preference absence and rejects both forged boolean directions", () => {
    const b = armRun("B", [
      commanderRecord({
        sequence: 1,
        arm: "B",
        planInstalled: true,
        deterministic: "expand",
        preferredAbsent: true,
        replanReason: "no_active_plan",
      }),
    ]);
    const c = armRun("C", [
      commanderRecord({
        sequence: 1,
        arm: "C",
        planInstalled: true,
        deterministic: "pressure_rival:P10",
        preferredAbsent: false,
        replanReason: "no_active_plan",
      }),
    ]);
    const report = buildCommanderArmReport([armRun("A"), b, c]);

    expect(
      firstTriplet(report).arms.B.metrics.deterministicPreferredOptionAbsent,
    ).toEqual({ count: 0, opportunities: 1, rate: 0 });
    expect(
      firstTriplet(report).arms.C.metrics.deterministicPreferredOptionAbsent,
    ).toEqual({ count: 1, opportunities: 1, rate: 1 });
    expect(
      firstTriplet(report).arms.B.metrics
        .deterministicPreferredOptionStampViolations,
    ).toBe(1);
    expect(
      firstTriplet(report).arms.C.metrics
        .deterministicPreferredOptionStampViolations,
    ).toBe(1);
    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "Arm B deterministic preferred-option evidence is invalid",
        "Arm C deterministic preferred-option evidence is invalid",
      ]),
    );
  });

  it("rejects active canonical rows with a rejected result or null submitted intent", () => {
    const b = armRun("B");
    b.records[1]!.result.accepted = false;
    const c = armRun("C");
    c.records[1]!.result.submittedIntent = null;
    const report = buildCommanderArmReport([armRun("A"), b, c]);

    expect(firstTriplet(report).arms.B.metrics.canonicalPathViolations).toBe(1);
    expect(firstTriplet(report).arms.C.metrics.canonicalPathViolations).toBe(1);
    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "Arm B failed offered-id, acceptance, submitted-intent, or step-locked audit proof",
        "Arm C failed offered-id, acceptance, submitted-intent, or step-locked audit proof",
      ]),
    );
  });

  it("derives provider provenance from runtime telemetry so experiment relabeling cannot certify a mock corpus", () => {
    const runs = [
      ...performanceTriplet({
        tripletID: "replica-1",
        seed: "seed-1",
        subjectWins: {},
      }),
      ...performanceTriplet({
        tripletID: "replica-2",
        seed: "seed-2",
        subjectWins: {},
      }),
    ];
    for (const run of runs.filter((entry) => entry.arm === "C")) {
      const active = run.records.find(
        (record) => record.chosenActionKind !== "spawn",
      )!;
      active.decisionMetadata!.commanderSelectorProvider = "mock";
      active.decisionMetadata!.commanderSelectorModel = "scripted-relabel";
      // The manifest declarations and experiment assertions remain real-looking.
      expect(run.provider).toBe("claude-cli");
      expect(active.decisionMetadata!.commanderExperimentProvider).toBe(
        "claude-cli",
      );
    }
    const report = buildCommanderArmReport(runs);

    expect(report.status).toBe("invalid");
    expect(report.integrity.invalidationReasons).toEqual(
      expect.arrayContaining([
        "replica-1: Arm C run labels disagree with plan-start telemetry",
        "replica-1: Arm C experiment assertions disagree with runtime telemetry",
      ]),
    );
    expect(report.performanceEligibility.reasons).toContain(
      "provider/model provenance is missing, mock, or scripted",
    );
  });

  it("invalidates reused replica run identities, paths, and relabeled decision corpora", () => {
    const first = performanceTriplet({
      tripletID: "replica-1",
      seed: "seed-1",
      subjectWins: {},
    });
    const second = performanceTriplet({
      tripletID: "replica-2",
      seed: "seed-2",
      subjectWins: {},
    });
    for (const run of second) {
      run.runID = first[0]!.runID;
      run.artifactProvenance!.executedRunID = first[0]!.runID;
      run.artifactProvenance!.executedMatchID =
        first[0]!.artifactProvenance!.executedMatchID;
    }
    second[0]!.artifactProvenance!.decisionsSha256 =
      first[0]!.artifactProvenance!.decisionsSha256;
    second[1]!.artifactProvenance!.manifestPath =
      first[1]!.artifactProvenance!.manifestPath;
    Object.assign(second[2]!.artifactProvenance!, {
      decisionsPath: first[2]!.artifactProvenance!.decisionsPath,
      decisionsSha256: first[2]!.artifactProvenance!.decisionsSha256,
      summaryPath: first[2]!.artifactProvenance!.summaryPath,
      summarySha256: first[2]!.artifactProvenance!.summarySha256,
    });
    const report = buildCommanderArmReport([...first, ...second]);

    expect(report.status).toBe("invalid");
    expect(report.integrity.invalidationReasons).toEqual(
      expect.arrayContaining([
        "replicated triplets reuse an executed run identity",
        "replicated triplets reuse an executed game identity",
        "replicated arms reuse an artifact path",
        "replicated arms reuse a decisions corpus",
        "replicated arms reuse an artifact path/hash identity",
      ]),
    );
    expect(report.performanceEligibility.reasons).toEqual(
      expect.arrayContaining([
        "replicated triplets reuse an executed run identity",
        "replicated triplets reuse an executed game identity",
        "replicated arms reuse a decisions corpus",
      ]),
    );
  });

  it("invalidates forged component, selector, and spawn provenance while scoping surfaces to the subject", () => {
    const c = armRun("C");
    c.componentHashes.lifecycle = "f".repeat(64);
    c.records[0]!.spawnSelectionEvidence!.participantID = "FORGED";
    c.records[1]!.decisionMetadata!.commanderExperimentModel = "forged-model";
    const rogue = commanderRecord({
      sequence: -10,
      arm: "C",
      planInstalled: true,
      replanReason: "no_active_plan",
    });
    rogue.agentID = "ROGUE";
    rogue.decisionMetadata!.commanderExposedOptionIds = "survive";
    c.records.push(rogue);

    const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);

    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "Arm B/C lifecycle content hash differs",
        "Arm C spawn-selection evidence is invalid",
        "Arm C experiment assertions disagree with runtime telemetry",
      ]),
    );
    expect(tripletInvalidations(report)).not.toContain(
      "Arm B/C initial exposed option surfaces differ",
    );
  });

  it("derives the full roster spawn map and invalidates an opponent assignment or evidence mutation", () => {
    const baselineRuns = (["A", "B", "C"] as const).map((arm) =>
      addOpponentSpawn(armRun(arm)),
    );
    const baseline = buildCommanderArmReport(baselineRuns);
    expect(firstTriplet(baseline).integrity.valid).toBe(true);
    expect(firstTriplet(baseline).arms.C.spawnAssignments).toEqual({
      SUBJECT: "spawn:100",
      OPPONENT: "spawn:200",
    });

    const evidenceRuns = (["A", "B", "C"] as const).map((arm) =>
      addOpponentSpawn(armRun(arm)),
    );
    const cOpponentEvidence = evidenceRuns[2]!.records.find(
      (record) =>
        record.agentID === "OPPONENT" && record.chosenActionKind === "spawn",
    )!;
    cOpponentEvidence.spawnSelectionEvidence!.assignedActionID = "spawn:999";
    const evidenceReport = buildCommanderArmReport(evidenceRuns);
    expect(tripletInvalidations(evidenceReport)).toEqual(
      expect.arrayContaining([
        "actual spawn assignments differ across arms",
        "Arm C actual spawn assignments are incomplete",
        "Arm C spawn-selection evidence is invalid",
      ]),
    );

    const assignmentRuns = (["A", "B", "C"] as const).map((arm) =>
      addOpponentSpawn(armRun(arm)),
    );
    const cOpponent = assignmentRuns[2]!.records.find(
      (record) =>
        record.agentID === "OPPONENT" && record.chosenActionKind === "spawn",
    )!;
    cOpponent.chosenActionID = "spawn:201";
    cOpponent.legalActionIDs = ["spawn:201"];
    cOpponent.legalActionIDsByKind.spawn = ["spawn:201"];
    cOpponent.intent = { type: "spawn", tile: 201 };
    cOpponent.result.submittedIntent = cOpponent.intent;
    Object.assign(cOpponent.spawnSelectionEvidence!, {
      offeredActionIDs: ["spawn:201"],
      submittedBallotActionIDs: ["spawn:201"],
      normalizedBallotActionIDs: ["spawn:201"],
      assignedActionID: "spawn:201",
    });
    const assignmentReport = buildCommanderArmReport(assignmentRuns);
    expect(tripletInvalidations(assignmentReport)).toContain(
      "actual spawn assignments differ across arms",
    );
    expect(tripletInvalidations(assignmentReport)).not.toContain(
      "Arm C spawn-selection evidence is invalid",
    );
  });
});
