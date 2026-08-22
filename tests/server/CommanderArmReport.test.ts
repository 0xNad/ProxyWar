import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnitType } from "../../src/core/game/Game";
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
  commanderArmOrderForReplica,
  commanderConfirmatoryAnalysisSpecification,
} from "../../src/server/agents/CommanderExperimentProtocol";
import {
  advanceCommanderPlan,
  commanderPlanRejectionCodes,
  commanderRequestIdentity,
  commanderResponseDispositions,
  type CommanderPlanMaterial,
  type CommanderPlanRequest,
} from "../../src/server/agents/CommanderPlanLifecycle";
import { parseCommanderResponse } from "../../src/server/agents/CommanderResponseParser";
import {
  selectDeterministicStrategicOption,
  strategicOptionSelectionFailureKinds,
} from "../../src/server/agents/StrategicOptionSelectors";
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
  const targetPlayerID = selected.startsWith("pressure_rival:")
    ? selected.slice("pressure_rival:".length)
    : null;
  const action: {
    id: string;
    kind: AgentDecisionRecord["chosenActionKind"];
    intent: AgentDecisionRecord["intent"];
    metadata: Record<string, string | number | boolean | null>;
  } =
    fidelity === "hold_plan_blocked"
      ? {
          id: "hold",
          kind: "hold" as const,
          intent: null,
          metadata: {},
        }
      : selected === "develop_economy"
        ? {
            id: "build:City:100",
            kind: "build" as const,
            intent: {
              type: "build_unit" as const,
              unit: UnitType.City,
              tile: 100,
            },
            metadata: { unit: UnitType.City, role: "economic" },
          }
        : selected === "survive"
          ? {
              id: "retreat:attack-1",
              kind: "retreat" as const,
              intent: { type: "cancel_attack" as const, attackID: "attack-1" },
              metadata: { attackID: "attack-1" },
            }
          : targetPlayerID !== null
            ? {
                id: `attack:${targetPlayerID}:25`,
                kind: "attack" as const,
                intent: {
                  type: "attack" as const,
                  targetID: targetPlayerID,
                  troops: 100,
                },
                metadata: {
                  targetID: targetPlayerID,
                  expansion: false,
                },
              }
            : {
                id: "attack:neutral",
                kind: "attack" as const,
                intent: {
                  type: "attack" as const,
                  targetID: null,
                  troops: 100,
                },
                metadata: { targetID: null, expansion: true },
              };
  const record = fabricatedRecord({
    sequence: input.sequence,
    agentID: "SUBJECT",
    playerID: "P1",
    username: "Subject",
    turnNumber: 10 + input.sequence,
    actionID: action.id,
    kind: action.kind,
    auditStatus:
      fidelity === "hold_plan_blocked" ? "not_applicable" : "confirmed",
  });
  record.brainType = "strategic-commander";
  record.legalActionIDs = [record.chosenActionID];
  record.chosenActionMetadata = action.metadata;
  if (record.chosenActionKind !== "hold") {
    record.intent = action.intent;
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
    commanderResponseDisposition: "applied",
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
    batchIndex: 0,
    batchSize: 1,
    batchActionIDs: record.chosenActionID,
  };
  return record;
}

function commanderBoatRecord(input: {
  sequence: number;
  arm: "B" | "C";
  planID?: string;
  planInstalled?: boolean;
}): AgentDecisionRecord {
  const record = commanderRecord({
    sequence: input.sequence,
    arm: input.arm,
    planID: input.planID,
    planInstalled: input.planInstalled,
    replanReason: input.planInstalled ? "no_active_plan" : "within_horizon",
    selected: "expand",
  });
  const intent = { type: "boat" as const, troops: 100, dst: 100 };
  record.chosenActionID = "boat:100:8";
  record.chosenActionKind = "boat";
  record.chosenActionMetadata = {
    targetID: null,
    targetTile: 100,
    navalInvasion: false,
    expansion: true,
  };
  record.legalActionIDs = [record.chosenActionID];
  record.legalActionIDsByKind = { boat: [record.chosenActionID] };
  record.intent = intent;
  record.result = {
    accepted: true,
    reason: "submitted",
    submittedIntent: intent,
  };
  record.decisionMetadata!.batchIndex = 0;
  record.decisionMetadata!.batchSize = 1;
  record.decisionMetadata!.batchActionIDs = record.chosenActionID;
  record.audit!.auditStatus = "unknown";
  record.audit!.auditReason =
    "boat was accepted, but transport launch was not visible yet";
  for (const snapshot of [record.audit!.before, record.audit!.after]) {
    if (snapshot !== null && snapshot !== undefined) {
      snapshot.troops = 10_000;
      snapshot.unitCounts[UnitType.TransportShip] = 0;
    }
  }
  return record;
}

function showTransport(record: AgentDecisionRecord, count: number): void {
  for (const snapshot of [record.audit?.before, record.audit?.after]) {
    if (snapshot !== null && snapshot !== undefined) {
      snapshot.troops = 10_000;
      snapshot.unitCounts[UnitType.TransportShip] = count;
    }
  }
}

function showUnrelatedTroopLossWithoutTransport(
  record: AgentDecisionRecord,
  troops: number,
): void {
  for (const snapshot of [record.audit?.before, record.audit?.after]) {
    if (snapshot !== null && snapshot !== undefined) {
      snapshot.troops = troops;
      snapshot.unitCounts[UnitType.TransportShip] = 0;
    }
  }
}

function commanderPressureCycle(input: {
  sequence: number;
  arm: "B" | "C";
  planID: string;
  targetPlayerID?: string;
  supportTargetPlayerID?: string;
  previousPlanID?: string | null;
  replanReason?: string;
}): AgentDecisionRecord[] {
  const target = input.targetPlayerID ?? "P7";
  const supportTarget = input.supportTargetPlayerID ?? target;
  const objective = `pressure_rival:${target}`;
  const primary = commanderRecord({
    sequence: input.sequence,
    arm: input.arm,
    planID: input.planID,
    planInstalled: true,
    selected: objective,
    previousPlanID: input.previousPlanID,
    replanReason: input.replanReason ?? "no_active_plan",
  });
  const support = commanderRecord({
    sequence: input.sequence + 1,
    arm: input.arm,
    planID: input.planID,
    selected: objective,
  });
  support.chosenActionID = `embargo:${supportTarget}:start`;
  support.chosenActionKind = "embargo";
  support.chosenActionMetadata = {
    targetID: supportTarget,
    action: "start",
  };
  support.intent = {
    type: "embargo",
    targetID: supportTarget,
    action: "start",
  };
  support.result = {
    accepted: true,
    reason: "submitted",
    submittedIntent: support.intent,
  };
  support.audit!.auditStatus = "confirmed";
  support.decisionMetadata!.commanderFidelity = "aligned_support";
  support.decisionMetadata!.commanderPlanAgeDecisions = 0;
  const actionIDs = [primary.chosenActionID, support.chosenActionID];
  for (const [index, record] of [primary, support].entries()) {
    record.legalActionIDs = [...actionIDs];
    record.legalActionIDsByKind = {
      attack: [primary.chosenActionID],
      embargo: [support.chosenActionID],
    };
    record.decisionMetadata!.batchIndex = index;
    record.decisionMetadata!.batchSize = 2;
    record.decisionMetadata!.batchActionIDs = actionIDs.join(",");
  }
  return [primary, support];
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
    protocol: "plumbing",
    replicaIndex: 0,
    subjectSeatIndex: 0,
    episodeIndex: 0,
    armOrder: ["A", "B", "C"],
    armExecutionIndex: arm === "A" ? 0 : arm === "B" ? 1 : 2,
    sourceSha: "a".repeat(40),
    sourceTreeDirty: false,
    runtimeIdentitySha256: "9".repeat(64),
    preRegistrationManifestSha256: null,
    seed: "matched-seed",
    runID: "matched-run",
    selectorSource:
      arm === "A" ? "current-planner" : arm === "B" ? "deterministic" : "llm",
    provider: arm === "C" ? "test" : null,
    model: arm === "C" ? "test-model" : null,
    promptVersion: arm === "C" ? "stage2" : null,
    analysisSpecification: null,
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
  replicaIndex: number;
}): CommanderArmRunInput {
  const run = input.run;
  run.tripletID = input.tripletID;
  run.runID = input.tripletID;
  run.seed = input.seed;
  run.protocol = "confirmatory";
  run.replicaIndex = input.replicaIndex;
  run.subjectSeatIndex = input.replicaIndex % 4;
  run.episodeIndex = Math.floor(input.replicaIndex / 4) % 4;
  installPerformanceRoster(run, run.subjectSeatIndex);
  run.analysisSpecification = commanderConfirmatoryAnalysisSpecification();
  run.preRegistrationManifestSha256 = "8".repeat(64);
  run.armOrder = commanderArmOrderForReplica(input.replicaIndex);
  run.armExecutionIndex = run.armOrder.indexOf(run.arm);
  run.localSmoke = false;
  run.requireWinner = true;
  run.completed = true;
  run.experimentFlags.localSmoke = false;
  run.experimentFlags.requireWinner = true;
  run.finalState = { ...run.finalState!, phase: "finished" };
  run.winner = ["player", input.subjectWon ? "CLIENT-1" : "OPPONENT-CLIENT"];
  const runner = run.gameConfiguration.runner as Record<string, unknown>;
  runner.requireWinner = true;
  runner.maxSteps = 60;
  runner.turnsPerDecisionStep = 100;
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

function installPerformanceRoster(
  run: CommanderArmRunInput,
  subjectSeatIndex: number,
): void {
  const subject = run.roster.find(
    (entry) => entry.agentID === run.subjectAgentID,
  )!;
  const opponents = Array.from({ length: 3 }, (_unused, index) => ({
    agentID: `PERFORMANCE-OPPONENT-${index + 1}`,
    username: `Performance Opponent ${index + 1}`,
    profile: "opportunistic" as const,
    clientID: `PERFORMANCE-CLIENT-${index + 1}`,
    brainType: "planner-executor" as const,
  }));
  const roster: CommanderArmRunInput["roster"] = [...opponents];
  roster.splice(subjectSeatIndex, 0, subject);
  run.roster = roster;
  const priorityParticipantIDs = roster.map((entry) => entry.agentID);
  const priorityOrder = roster.map((entry) => entry.username);
  for (const [index, opponent] of opponents.entries()) {
    const actionID = `spawn:${200 + index * 100}`;
    const record = fabricatedRecord({
      sequence: -3 + index,
      agentID: opponent.agentID,
      playerID: `P${index + 2}`,
      username: opponent.username,
      turnNumber: 0,
      actionID,
      kind: "spawn",
    });
    record.profile = opponent.profile;
    record.brainType = opponent.brainType;
    record.legalActionIDs = [actionID];
    record.intent = { type: "spawn", tile: 200 + index * 100 };
    record.result = {
      accepted: true,
      reason: "submitted",
      submittedIntent: record.intent,
    };
    record.audit = { auditStatus: "confirmed", auditReason: "spawn applied" };
    record.spawnSelectionEvidence = {
      algorithmVersion: "sealed-ranked-v1",
      offeredActionIDs: [actionID],
      ballotSource: "explicit-ranked",
      submittedBallotActionIDs: [actionID],
      submittedBallotEntryTypes: ["string"],
      submittedBallotCount: 1,
      submittedBallotTruncated: false,
      submittedReason: "matched performance fixture",
      normalizedBallotActionIDs: [actionID],
      ballotValid: true,
      ballotInvalidReason: null,
      defaultReason: null,
      participantID: opponent.agentID,
      priorityParticipantIDs,
      priorityOrder,
      priorityRank:
        roster.findIndex((entry) => entry.agentID === opponent.agentID) + 1,
      assignedActionID: actionID,
      assignedPreferenceRank: 1,
      assignedSubmittedPreferenceRank: 1,
      stageLatencyMs: 0,
      stageFallbackUsed: false,
      stageDegradationReason: null,
    };
    run.records.unshift(record);
  }
  run.gameConfiguration.agents = 4;
}

function performanceTriplet(input: {
  tripletID: string;
  seed: string;
  subjectWins: Partial<Record<CommanderExperimentArm, boolean>>;
}): CommanderArmRunInput[] {
  const suffix = /([0-9]+)$/.exec(input.tripletID)?.[1];
  const replicaIndex =
    suffix === undefined ? 0 : Math.max(0, Number(suffix) - 1);
  return (["A", "B", "C"] as const).map((arm) =>
    promoteToPerformanceRun({
      run: armRun(arm),
      tripletID: input.tripletID,
      seed: input.seed,
      subjectWon: input.subjectWins[arm] ?? false,
      replicaIndex,
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
    eligibleOptionIDs: fixture.strategicOptions.record.eligibleOptionIds,
    eligibleFamilies: [
      ...new Set(
        fixture.strategicOptions.candidates.map(
          (candidate) => candidate.family,
        ),
      ),
    ],
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
  it("invalidates a triplet whose sealed runtime treatment identities differ", () => {
    const c = armRun("C");
    c.runtimeIdentitySha256 = "8".repeat(64);

    const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);

    expect(report.integrity.valid).toBe(false);
    expect(report.integrity.invalidationReasons).toContain(
      "triplet-1: runtime treatment identity differs across arms",
    );
    expect(report.performanceEligibility.reasons).toContain(
      "replicated triplets do not share one valid runtime treatment identity",
    );
  });

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
    expect(report.status).toBe("mechanically-valid");
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
      "Arm B Commander fidelity stamp disagrees with recomputation",
    );
  });

  it("keeps canonical boat submission separate from unsupported causal effect claims", () => {
    const planID = "B-boat-plan";
    const firstBoat = commanderBoatRecord({
      sequence: 1,
      arm: "B",
      planID,
      planInstalled: true,
    });
    const secondBoat = commanderBoatRecord({
      sequence: 2,
      arm: "B",
      planID,
    });
    const final = commanderRecord({ sequence: 3, arm: "B", planID });
    showTransport(final, 1);
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B", [firstBoat, secondBoat, final]),
      armRun("C"),
    ]);
    expect(firstTriplet(report).arms.B.metrics.canonicalPathViolations).toBe(0);
    expect(firstTriplet(report).arms.B.metrics.effectAudit).toEqual({
      causalInferenceSupported: false,
      explicitFailures: 0,
    });
    expect(firstTriplet(report).integrity.valid).toBe(true);
  });

  it("does not infer a boat effect from unrelated later troop loss", () => {
    const planID = "B-boat-plan";
    const pendingBoat = commanderBoatRecord({
      sequence: 1,
      arm: "B",
      planID,
      planInstalled: true,
    });
    const unrelatedAttack = commanderRecord({
      sequence: 2,
      arm: "B",
      planID,
    });
    showUnrelatedTroopLossWithoutTransport(unrelatedAttack, 9_000);
    const pending = buildCommanderArmReport([
      armRun("A"),
      armRun("B", [pendingBoat, unrelatedAttack]),
      armRun("C"),
    ]);
    expect(firstTriplet(pending).arms.B.metrics.effectAudit).toEqual({
      causalInferenceSupported: false,
      explicitFailures: 0,
    });

    const secondUnrelatedAttack = commanderRecord({
      sequence: 3,
      arm: "B",
      planID,
    });
    showUnrelatedTroopLossWithoutTransport(secondUnrelatedAttack, 8_000);
    const expired = buildCommanderArmReport([
      armRun("A"),
      armRun("B", [pendingBoat, unrelatedAttack, secondUnrelatedAttack]),
      armRun("C"),
    ]);
    expect(firstTriplet(expired).arms.B.metrics.effectAudit).toEqual({
      causalInferenceSupported: false,
      explicitFailures: 0,
    });
  });

  it("still rejects a rejected, mutated-intent, or explicitly failed delayed boat", () => {
    const variants = [
      {
        label: "rejected",
        mutate: (record: AgentDecisionRecord) => {
          record.result.accepted = false;
        },
        reason:
          "Arm B failed offered-id, acceptance, or submitted-intent proof",
      },
      {
        label: "mutated intent",
        mutate: (record: AgentDecisionRecord) => {
          record.result.submittedIntent = {
            type: "boat",
            troops: 100,
            dst: 999,
          };
        },
        reason:
          "Arm B failed offered-id, acceptance, or submitted-intent proof",
      },
      {
        label: "failed effect",
        mutate: (record: AgentDecisionRecord) => {
          record.audit!.auditStatus = "failed";
        },
        reason: "Arm B contains an explicit action-effect audit failure",
      },
    ];
    for (const variant of variants) {
      const boat = commanderBoatRecord({
        sequence: 1,
        arm: "B",
        planID: "B-boat-plan",
        planInstalled: true,
      });
      variant.mutate(boat);
      const report = buildCommanderArmReport([
        armRun("A"),
        armRun("B", [
          boat,
          commanderRecord({
            sequence: 2,
            arm: "B",
            planID: "B-boat-plan",
          }),
          commanderRecord({
            sequence: 3,
            arm: "B",
            planID: "B-boat-plan",
          }),
        ]),
        armRun("C"),
      ]);
      expect(tripletInvalidations(report), variant.label).toContain(
        variant.reason,
      );
    }
  });

  it("invalidates forged aligned metadata for every off-family or off-target action shape", () => {
    const cases = [
      { label: "off-target pressure", objective: "pressure_rival:P7" },
      { label: "economy hostility", objective: "develop_economy" },
      { label: "expand hostility", objective: "expand" },
      { label: "survive hostility", objective: "survive" },
    ];
    for (const entry of cases) {
      const record = commanderRecord({
        sequence: 1,
        arm: "B",
        planInstalled: true,
        replanReason: "no_active_plan",
        selected: entry.objective,
      });
      record.chosenActionID = "attack:P3:25";
      record.chosenActionKind = "attack";
      record.chosenActionMetadata = {
        targetID: "P3",
        expansion: false,
      };
      record.intent = { type: "attack", targetID: "P3", troops: 100 };
      record.result.submittedIntent = record.intent;
      record.legalActionIDs = [record.chosenActionID];
      record.legalActionIDsByKind = { attack: [record.chosenActionID] };
      record.decisionMetadata!.batchActionIDs = record.chosenActionID;
      const report = buildCommanderArmReport([
        armRun("A"),
        armRun("B", [record]),
        armRun("C"),
      ]);
      expect(
        firstTriplet(report).arms.B.metrics.offFamilyActionViolations,
        entry.label,
      ).toBe(1);
      expect(
        firstTriplet(report).arms.B.metrics.zeroPrimaryDecisionCycles,
        entry.label,
      ).toBe(1);
      expect(tripletInvalidations(report), entry.label).toContain(
        "Arm B executed an action incompatible with its Commander plan",
      );
      expect(
        firstTriplet(report).terminalPerformanceEligibility
          .ineligibilityReasons,
        entry.label,
      ).toContain(
        "triplet integrity is invalid; per-protocol terminal outcomes require structurally valid evidence",
      );
      expect(report.aggregate.includedTripletIDs, entry.label).toEqual([]);
      expect(report.aggregate.excludedTripletIDs, entry.label).toEqual([
        "triplet-1",
      ]);
    }

    const unrelatedSupport = commanderPressureCycle({
      sequence: 1,
      arm: "B",
      planID: "B-pressure-plan",
      supportTargetPlayerID: "P3",
    });
    const unrelatedReport = buildCommanderArmReport([
      armRun("A"),
      armRun("B", unrelatedSupport),
      armRun("C"),
    ]);
    expect(
      firstTriplet(unrelatedReport).arms.B.metrics.laterLayerActionViolations,
    ).toBe(1);
    expect(
      firstTriplet(unrelatedReport).arms.B.metrics.supportActionCount,
    ).toBe(0);
    expect(tripletInvalidations(unrelatedReport)).toContain(
      "Arm B executed an invalid later-layer Commander action",
    );
  });

  it("uses cycle-level fidelity so support cannot dilute blocked cycles above five percent", () => {
    const records: AgentDecisionRecord[] = [];
    let sequence = 1;
    let previousPlanID: string | null = null;
    for (let index = 0; index < 37; index++) {
      const planID = `B-pressure-${index}`;
      records.push(
        ...commanderPressureCycle({
          sequence,
          arm: "B",
          planID,
          previousPlanID,
          replanReason: index === 0 ? "no_active_plan" : "horizon_expiry",
        }),
      );
      sequence += 2;
      previousPlanID = planID;
    }
    for (let index = 0; index < 2; index++) {
      const planID = `B-blocked-${index}`;
      records.push(
        commanderRecord({
          sequence: sequence++,
          arm: "B",
          planID,
          planInstalled: true,
          selected: "pressure_rival:P7",
          fidelity: "hold_plan_blocked",
          previousPlanID,
          replanReason: "horizon_expiry",
        }),
      );
      previousPlanID = planID;
    }
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B", records),
      armRun("C"),
    ]);
    const metrics = firstTriplet(report).arms.B.metrics;
    expect(metrics.supportActionCount).toBe(37);
    expect(metrics.blockedDecisionCycles).toEqual({
      count: 2,
      opportunities: 39,
      rate: 2 / 39,
    });
    expect(metrics.strategicFidelity).toBe(37 / 39);
    expect(report.performanceEligibility.reasons).toContain(
      "triplet-1: Arm B blocked Commander cycles exceed 5 percent",
    );
  });

  it("applies the 50 percent option_not_executable dominance falsifier", () => {
    const optionNotExecutableBatch = commanderPressureCycle({
      sequence: 2,
      arm: "B",
      planID: "B-plan-2",
      previousPlanID: "B-plan-1",
      replanReason: "option_not_executable",
    });
    optionNotExecutableBatch[1]!.decisionMetadata!.commanderReplanReason =
      "option_not_executable";
    const records = [
      commanderRecord({
        sequence: 1,
        arm: "B",
        planID: "B-plan-1",
        planInstalled: true,
        replanReason: "no_active_plan",
      }),
      ...optionNotExecutableBatch,
      commanderRecord({
        sequence: 4,
        arm: "B",
        planID: "B-plan-3",
        planInstalled: true,
        previousPlanID: "B-plan-2",
        replanReason: "horizon_expiry",
      }),
    ];
    const report = buildCommanderArmReport([
      armRun("A"),
      armRun("B", records),
      armRun("C"),
    ]);
    expect(
      firstTriplet(report).arms.B.metrics.optionNotExecutableReplans,
    ).toEqual({ count: 1, opportunities: 2, rate: 0.5, dominates: true });
    expect(report.performanceEligibility.reasons).toContain(
      "triplet-1: Arm B option_not_executable reaches the preregistered 50 percent non-bootstrap replan threshold",
    );
  });

  it("reloads canonical persisted arm artifacts before writing the report", async () => {
    const comparisonDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "commander-comparison-"),
    );
    try {
      const runs = [armRun("A"), armRun("B"), armRun("C")];
      const durableBoat = commanderBoatRecord({
        sequence: 1,
        arm: "B",
        planID: "B-durable-boat-plan",
        planInstalled: true,
      });
      const durableBoatConfirmation = commanderRecord({
        sequence: 2,
        arm: "B",
        planID: "B-durable-boat-plan",
      });
      showTransport(durableBoatConfirmation, 1);
      runs[1] = armRun("B", [
        durableBoat,
        durableBoatConfirmation,
        commanderRecord({
          sequence: 3,
          arm: "B",
          planID: "B-durable-boat-plan",
        }),
      ]);
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
                subjectSeatIndex: run.subjectSeatIndex,
                episodeIndex: run.episodeIndex,
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
      expect(parsed.integrity).toEqual({
        valid: true,
        invalidationReasons: [],
      });
      expect(parsed.triplets[0]!.arms.B.metrics.effectAudit).toEqual({
        causalInferenceSupported: false,
        explicitFailures: 0,
      });
      const reloadedArmB = await loadCommanderArmRunFromArtifacts(
        manifestPaths[1]!,
        comparisonDirectory,
      );
      const reloadedBoat = reloadedArmB.records.find(
        (record) => record.chosenActionKind === "boat",
      );
      expect(reloadedBoat?.audit?.before).toEqual(durableBoat.audit?.before);
      expect(reloadedBoat?.audit?.after).toEqual(durableBoat.audit?.after);
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
      const linkedInputPath = path.join(comparisonDirectory, "linked-input");
      await fs.symlink(path.dirname(manifestPaths[0]!), linkedInputPath);
      await expect(
        loadCommanderArmRunFromArtifacts(
          path.join(linkedInputPath, "commander-arm-manifest.json"),
          comparisonDirectory,
        ),
      ).rejects.toThrow(/artifact path contains a symlink/);
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

      const bManifestPath = manifestPaths[1]!;
      const originalBManifestText = await fs.readFile(bManifestPath, "utf8");
      const bManifest = JSON.parse(originalBManifestText) as {
        artifacts: { decisionsPath: string; decisionsSha256: string };
      };
      const bDecisionsPath = path.resolve(
        path.dirname(bManifestPath),
        bManifest.artifacts.decisionsPath,
      );
      const originalBDecisionsText = await fs.readFile(bDecisionsPath, "utf8");
      const originalBEntries = originalBDecisionsText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const spawnEntries = originalBEntries.filter(
        (entry) => entry.selectedActionKind === "spawn",
      );
      const activeTemplate = originalBEntries.find(selectActive)!;
      const good = Array.from({ length: 20 }, (_unused, index) => ({
        ...structuredClone(activeTemplate),
        sequence: index + 1,
        turnNumber: 10 + index,
        commanderPlanInstalled: index === 0,
        commanderReplanReason:
          index === 0 ? "no_active_plan" : "within_horizon",
        commanderPlanAgeDecisions: index,
        batchIndex: 0,
      }));
      const planless: Record<string, unknown> = {
        ...structuredClone(activeTemplate),
        sequence: 21,
        turnNumber: 31,
        commanderPlanInstalled: false,
        commanderReplanReason: "within_horizon",
        commanderPlanAgeDecisions: 20,
        batchIndex: 0,
      };
      delete planless.planID;
      delete planless.planObjective;
      delete planless.commanderFidelity;
      const planlessCorpusText = `${[...spawnEntries, ...good, planless]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
      await fs.writeFile(bDecisionsPath, planlessCorpusText, "utf8");
      bManifest.artifacts.decisionsSha256 = createHash("sha256")
        .update(planlessCorpusText)
        .digest("hex");
      await fs.writeFile(
        bManifestPath,
        `${JSON.stringify(bManifest, null, 2)}\n`,
        "utf8",
      );
      const planlessRuns = await Promise.all(
        manifestPaths.map((manifestPath) =>
          loadCommanderArmRunFromArtifacts(manifestPath, comparisonDirectory),
        ),
      );
      const planlessReport = buildCommanderArmReport(planlessRuns);
      expect(planlessReport.triplets[0]!.arms.B.metrics.fidelity).toEqual({
        rate: 20 / 21,
        interpretable: false,
        unknownDecisions: 1,
        unattributedDecisions: 1,
      });
      expect(planlessReport.integrity.valid).toBe(false);
      expect(planlessReport.integrity.invalidationReasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "Arm B has unknown or unattributed Commander fidelity decisions",
          ),
        ]),
      );
      await Promise.all([
        fs.writeFile(bDecisionsPath, originalBDecisionsText, "utf8"),
        fs.writeFile(bManifestPath, originalBManifestText, "utf8"),
      ]);
      const restoreUnknownAuditField = await mutatePersistedDecision(
        manifestPaths[1]!,
        (entry) => entry.selectedActionKind === "boat",
        (entry) => {
          const snapshot = entry.auditAfter as Record<string, unknown>;
          snapshot.privateCanary = "must-not-project";
        },
      );
      await expect(
        loadCommanderArmRunFromArtifacts(
          manifestPaths[1]!,
          comparisonDirectory,
        ),
      ).rejects.toThrow("auditAfter has unknown fields");
      await restoreUnknownAuditField();
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
          "Arm B failed offered-id, acceptance, or submitted-intent proof",
          "Arm C failed offered-id, acceptance, or submitted-intent proof",
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
        ).toBe(mutation.label === "unknown audit" ? 0 : 1);
        expect(
          mutatedReport.triplets[0]!.arms.A.metrics.effectAudit
            .explicitFailures,
          mutation.label,
        ).toBe(0);
        if (mutation.label === "unknown audit") {
          expect(mutatedReport.triplets[0]!.integrity.valid).toBe(true);
        } else {
          expect(
            mutatedReport.triplets[0]!.integrity.invalidationReasons,
            mutation.label,
          ).toContain(
            "Arm A failed offered-id, acceptance, or submitted-intent proof",
          );
        }
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

  it("keeps two replicated completed artifact-backed triplets below confirmatory performance", () => {
    const report = buildCommanderArmReport([
      ...performanceTriplet({
        tripletID: "replica-1",
        seed: "seed-1",
        subjectWins: { C: true },
      }).map((run) => ({
        ...run,
        protocol: "plumbing" as const,
        analysisSpecification: null,
      })),
      ...performanceTriplet({
        tripletID: "replica-2",
        seed: "seed-2",
        subjectWins: { B: true, C: true },
      }).map((run) => ({
        ...run,
        protocol: "plumbing" as const,
        analysisSpecification: null,
      })),
    ]);

    expect(report.status).toBe("mechanically-valid");
    expect(report.performanceEligibility.eligible).toBe(false);
    expect(report.performanceEligibility.reasons).toContain(
      "fewer than 48 uncontaminated per-protocol matched triplets",
    );
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

  it("separates the exact four-triplet technical canary from confirmatory claims", () => {
    const runs = Array.from({ length: 4 }, (_unused, index) =>
      performanceTriplet({
        tripletID: `replica-${index + 1}`,
        seed: `seed-${index + 1}`,
        subjectWins: { C: true },
      }).map((run) => ({
        ...run,
        protocol: "technical-canary" as const,
        episodeIndex: index,
        analysisSpecification: null,
      })),
    ).flat();
    const report = buildCommanderArmReport(runs);
    expect(report.integrity.valid).toBe(true);
    expect(report.status).toBe("technical-canary-passed");
    expect(report.technicalCanaryEligibility).toEqual({
      eligible: true,
      reasons: [],
    });
    expect(report.performanceClaimsAllowed).toBe(false);
    expect(report.performanceEligibility.reasons).toEqual(
      expect.arrayContaining([
        "fewer than 48 uncontaminated per-protocol matched triplets",
        "confirmatory protocol was not preregistered for every arm",
      ]),
    );
  });

  it("requires all 48 paired, counterbalanced, winner-determined triplets and preregistered floors", () => {
    const runs = Array.from({ length: 48 }, (_unused, index) => {
      const triplet = performanceTriplet({
        tripletID: `replica-${index + 1}`,
        seed: `seed-${index + 1}`,
        subjectWins: { B: index % 3 === 0, C: index % 2 === 0 },
      });
      if (index < 12) {
        const c = triplet.find((run) => run.arm === "C")!;
        const active = c.records.find(
          (record) => record.chosenActionKind !== "spawn",
        )!;
        active.decisionMetadata!.commanderDeterministicPreferredOptionId =
          "survive";
        active.decisionMetadata!.commanderDeterministicPreferredOptionAbsent = false;
      }
      return triplet;
    }).flat();
    const report = buildCommanderArmReport(runs);
    expect(report.integrity.valid).toBe(true);
    expect(report.status).toBe("confirmatory-performance-eligible");
    expect(report.performanceEligibility).toEqual({
      eligible: true,
      reasons: [],
    });
    expect(report.performanceClaimsAllowed).toBe(true);
    expect(report.aggregate.pairedAnalysis).toMatchObject({
      ready: true,
      completePairs: 48,
    });
    expect(report.aggregate.pairedAnalysis.B_vs_C).toHaveLength(48);
    expect(report.aggregate.confirmatoryAnalysis).toMatchObject({
      status: "complete",
      completePairs: 48,
      requiredPairs: 48,
      missingPairs: 0,
      missingnessPolicy: "no-missing-pairs",
      specificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(report.aggregate.confirmatoryAnalysis.results).toHaveLength(5);
    expect(
      report.aggregate.confirmatoryAnalysis.results.map((entry) => [
        entry.metric,
        entry.pValueMethod,
      ]),
    ).toEqual([
      ["win", "exact-two-sided-mcnemar"],
      ["survival", "exact-two-sided-mcnemar"],
      ["normalized-final-territory", "seeded-paired-sign-randomization"],
      ["turns-survived", "seeded-paired-sign-randomization"],
      ["final-rank", "seeded-paired-sign-randomization"],
    ]);
    expect(
      buildCommanderArmReport(structuredClone(runs)).aggregate
        .confirmatoryAnalysis,
    ).toEqual(report.aggregate.confirmatoryAnalysis);
    expect(
      report.triplets.reduce(
        (total, triplet) =>
          total + triplet.arms.C.metrics.selectorDisagreement.count,
        0,
      ),
    ).toBe(12);

    const analysisReadyRuns = structuredClone(runs);
    for (const run of analysisReadyRuns) run.analysisSpecification = null;
    const analysisReady = buildCommanderArmReport(analysisReadyRuns);
    expect(analysisReady.integrity.valid).toBe(true);
    expect(analysisReady.status).toBe("confirmatory-analysis-ready");
    expect(analysisReady.aggregate.confirmatoryAnalysis).toMatchObject({
      status: "analysis-ready",
      results: [],
    });
    expect(analysisReady.performanceClaimsAllowed).toBe(false);

    const noWinnerRuns = structuredClone(runs);
    const noWinner = noWinnerRuns.find(
      (run) => run.tripletID === "replica-48" && run.arm === "C",
    )!;
    noWinner.winner = undefined;
    noWinner.finalState = { ...noWinner.finalState!, phase: "active" };
    noWinner.completed = false;
    const noWinnerReport = buildCommanderArmReport(noWinnerRuns);
    expect(noWinnerReport.performanceClaimsAllowed).toBe(false);
    expect(noWinnerReport.performanceEligibility.reasons).toContain(
      "one or more arms lack a completed winner-determined match",
    );
  });

  it("excludes an entire triplet for one early C fallback even below the old ten-percent rate", () => {
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
    const c = first.find((run) => run.arm === "C")!;
    const spawnRows = c.records.filter(
      (record) => record.chosenActionKind === "spawn",
    );
    const records: AgentDecisionRecord[] = [];
    let previousPlanID: string | null = null;
    for (let index = 0; index < 11; index++) {
      const planID = `C-plan-${index}`;
      records.push(
        commanderRecord({
          sequence: index + 1,
          arm: "C",
          planID,
          planInstalled: true,
          fallback: index === 0,
          failureKind: index === 0 ? "timeout" : null,
          previousPlanID,
          replanReason: index === 0 ? "no_active_plan" : "horizon_expiry",
        }),
      );
      previousPlanID = planID;
    }
    for (const record of records) {
      record.decisionMetadata!.commanderSelectorProvider = c.provider;
      record.decisionMetadata!.commanderSelectorModel = c.model;
      record.decisionMetadata!.commanderPromptVersion = c.promptVersion;
      record.decisionMetadata!.commanderExperimentProvider = c.provider;
      record.decisionMetadata!.commanderExperimentModel = c.model;
      record.decisionMetadata!.commanderExperimentPromptVersion =
        c.promptVersion;
    }
    c.records = [...spawnRows, ...records];

    const report = buildCommanderArmReport([...first, ...second]);
    const triplet = report.triplets.find(
      (candidate) => candidate.tripletID === "replica-1",
    )!;
    expect(triplet.arms.C.metrics.fallbackAuthoredPlans).toBe(1);
    expect(
      triplet.arms.C.metrics.fallbackAuthoredPlans /
        triplet.arms.C.metrics.planCount,
    ).toBeLessThan(0.1);
    expect(triplet.terminalPerformanceEligibility).toEqual({
      estimand: "per-protocol",
      eligible: false,
      ineligibilityReasons: expect.arrayContaining([
        "Arm C contains a fallback-authored plan; per-protocol terminal outcomes require zero",
        "Arm C contains a selector timeout; per-protocol terminal outcomes require zero",
      ]),
    });
    expect(report.aggregate.includedTripletIDs).toEqual(["replica-2"]);
    expect(report.aggregate.excludedTripletIDs).toEqual(["replica-1"]);
    expect(report.performanceClaimsAllowed).toBe(false);
  });

  it("rejects reused replica indices and any broken confirmatory seat-by-episode crossing", () => {
    const runs = Array.from({ length: 48 }, (_unused, index) =>
      performanceTriplet({
        tripletID: `replica-${index + 1}`,
        seed: `seed-${index + 1}`,
        subjectWins: { C: true },
      }),
    ).flat();
    const reused = structuredClone(runs);
    for (const run of reused) {
      const index = run.replicaIndex % 6;
      run.replicaIndex = index;
      run.armOrder = commanderArmOrderForReplica(index);
      run.armExecutionIndex = run.armOrder.indexOf(run.arm);
      run.subjectSeatIndex = index % 4;
      run.episodeIndex = Math.floor(index / 4) % 4;
    }
    expect(
      buildCommanderArmReport(reused).integrity.invalidationReasons,
    ).toEqual(
      expect.arrayContaining([
        "replicated triplets reuse a replica index",
        "confirmatory evidence requires exact contiguous replica indices 0-47",
      ]),
    );

    const brokenCrossing = structuredClone(runs);
    for (const run of brokenCrossing.filter(
      (candidate) => candidate.replicaIndex === 0,
    )) {
      run.subjectSeatIndex = 1;
    }
    expect(
      buildCommanderArmReport(brokenCrossing).integrity.invalidationReasons,
    ).toEqual(
      expect.arrayContaining([
        "confirmatory evidence does not prove the preregistered seat and episode rotation",
        "confirmatory evidence does not cover each seat-by-episode cell exactly three times",
      ]),
    );
  });

  it("keeps relabeled mock, partial, single-triplet, and autopilot outcomes ineligible", () => {
    const single = performanceTriplet({
      tripletID: "replica-1",
      seed: "seed-1",
      subjectWins: { C: true },
    });
    single[2]!.provider = "mock-provider";
    single[2]!.model = "scripted-mock-model";
    const singleCActive = single[2]!.records.find(
      (record) => record.chosenActionKind !== "spawn",
    )!;
    singleCActive.decisionMetadata!.commanderSelectorProvider = "mock-provider";
    singleCActive.decisionMetadata!.commanderSelectorModel =
      "scripted-mock-model";
    singleCActive.decisionMetadata!.commanderExperimentProvider =
      "mock-provider";
    singleCActive.decisionMetadata!.commanderExperimentModel =
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
        "fewer than 48 uncontaminated per-protocol matched triplets",
        "one or more arms lack a completed winner-determined match",
        "one or more final outcomes were contaminated by autopilot",
        "provider/model provenance is missing, mock, or scripted",
      ]),
    );
  });

  it("fails closed on every rejection-code/disposition mismatch and contaminates every rejected attempt", () => {
    for (const disposition of commanderResponseDispositions) {
      const c = armRun("C");
      const active = c.records.find(
        (record) => record.chosenActionKind !== "spawn",
      )!;
      active.decisionMetadata!.commanderResponseDisposition = disposition;
      active.decisionMetadata!.commanderRejectionCode =
        disposition === "rejected" ? "response_invalid" : null;
      const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);
      expect(
        firstTriplet(report).arms.C.metrics.responseEvidenceViolations,
        disposition,
      ).toBe(0);
    }

    for (const code of commanderPlanRejectionCodes) {
      const c = armRun("C");
      const active = c.records.find(
        (record) => record.chosenActionKind !== "spawn",
      )!;
      active.decisionMetadata!.commanderResponseDisposition = "rejected";
      active.decisionMetadata!.commanderRejectionCode = code;
      const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);
      expect(
        firstTriplet(report).arms.C.metrics.responseEvidenceViolations,
        code,
      ).toBe(0);
      expect(firstTriplet(report).arms.C.metrics.rejectedOrFailedAttempts).toBe(
        1,
      );
    }

    for (const failureKind of strategicOptionSelectionFailureKinds) {
      const c = armRun("C");
      const active = c.records.find(
        (record) => record.chosenActionKind !== "spawn",
      )!;
      active.decisionMetadata!.commanderResponseDisposition = "rejected";
      active.decisionMetadata!.commanderRejectionCode = null;
      active.decisionMetadata!.commanderSelectionFailureKind = failureKind;
      const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);
      expect(
        firstTriplet(report).arms.C.metrics.responseEvidenceViolations,
        failureKind,
      ).toBe(0);
      expect(firstTriplet(report).arms.C.metrics.rejectedOrFailedAttempts).toBe(
        1,
      );
    }

    for (const disposition of [
      undefined,
      null,
      "unknown-disposition",
    ] as const) {
      const c = armRun("C");
      const active = c.records.find(
        (record) => record.chosenActionKind !== "spawn",
      )!;
      if (disposition === undefined) {
        delete active.decisionMetadata!.commanderResponseDisposition;
      } else {
        active.decisionMetadata!.commanderResponseDisposition = disposition;
      }
      const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);
      expect(
        firstTriplet(report).arms.C.metrics.responseEvidenceViolations,
        String(disposition),
      ).toBeGreaterThan(0);
      expect(firstTriplet(report).arms.C.metrics.rejectedOrFailedAttempts).toBe(
        1,
      );
      expect(report.integrity.valid).toBe(false);
      expect(firstTriplet(report).terminalPerformanceEligibility.eligible).toBe(
        false,
      );
    }

    for (const code of commanderPlanRejectionCodes) {
      for (const disposition of commanderResponseDispositions.filter(
        (entry) => entry !== "rejected",
      )) {
        const c = armRun("C");
        const active = c.records.find(
          (record) => record.chosenActionKind !== "spawn",
        )!;
        active.decisionMetadata!.commanderPlanInstalled = false;
        active.decisionMetadata!.commanderRejectionCode = code;
        active.decisionMetadata!.commanderResponseDisposition = disposition;
        const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);
        expect(
          firstTriplet(report).arms.C.metrics.responseEvidenceViolations,
          `${code}/${disposition}`,
        ).toBeGreaterThan(0);
        expect(report.integrity.valid, `${code}/${disposition}`).toBe(false);
      }
    }

    const rejected = armRun("C");
    const rejectedActive = rejected.records.find(
      (record) => record.chosenActionKind !== "spawn",
    )!;
    rejectedActive.decisionMetadata!.commanderPlanInstalled = false;
    rejectedActive.decisionMetadata!.commanderResponseDisposition = "rejected";
    rejectedActive.decisionMetadata!.commanderRejectionCode =
      "response_invalid";
    const rejectedReport = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      rejected,
    ]);
    expect(
      firstTriplet(rejectedReport).arms.C.metrics.responseEvidenceViolations,
    ).toBe(0);
    expect(
      firstTriplet(rejectedReport).arms.C.metrics.rejectedOrFailedAttempts,
    ).toBe(1);
    expect(
      firstTriplet(rejectedReport).terminalPerformanceEligibility.eligible,
    ).toBe(false);

    for (const mutate of [
      (record: AgentDecisionRecord) => {
        record.decisionMetadata!.commanderResponseDisposition = "rejected";
        record.decisionMetadata!.commanderRejectionCode = null;
        record.decisionMetadata!.commanderSelectionFailureKind = null;
      },
      (record: AgentDecisionRecord) => {
        record.decisionMetadata!.commanderResponseDisposition = "rejected";
        record.decisionMetadata!.commanderRejectionCode = "unknown-code";
      },
    ]) {
      const c = armRun("C");
      mutate(c.records.find((record) => record.chosenActionKind !== "spawn")!);
      const report = buildCommanderArmReport([armRun("A"), armRun("B"), c]);
      expect(
        firstTriplet(report).arms.C.metrics.responseEvidenceViolations,
      ).toBeGreaterThan(0);
      expect(report.integrity.valid).toBe(false);
    }
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
    expect(firstTriplet(report).arms.C.metrics.fidelityStampViolations).toBe(2);
    expect(tripletInvalidations(report)).toEqual(
      expect.arrayContaining([
        "Arm B used a forbidden V0 emergency action",
        "Arm B option accounting is invalid",
        "Arm C Commander fidelity stamp disagrees with recomputation",
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

  it("treats target_dead as a replan reason, never a termination reason", () => {
    const replanned = armRun("B", [
      commanderRecord({
        sequence: 1,
        arm: "B",
        planID: "B-plan-1",
        planInstalled: true,
        replanReason: "no_active_plan",
      }),
      commanderRecord({
        sequence: 2,
        arm: "B",
        planID: "B-plan-2",
        planInstalled: true,
        previousPlanID: "B-plan-1",
        replanReason: "target_dead",
      }),
    ]);
    const replannedReport = buildCommanderArmReport([
      armRun("A"),
      replanned,
      armRun("C"),
    ]);
    expect(
      firstTriplet(replannedReport).arms.B.metrics.planTransitions,
    ).toEqual({
      count: 2,
      proven: 2,
      violations: 0,
    });

    const terminatedRecord = commanderRecord({
      sequence: 2,
      arm: "B",
      planID: "B-plan-2",
      planInstalled: false,
      previousPlanID: "B-plan-1",
      replanReason: "target_dead",
    });
    terminatedRecord.decisionMetadata!.planID = null;
    const terminated = armRun("B", [replanned.records[1]!, terminatedRecord]);
    const terminatedReport = buildCommanderArmReport([
      armRun("A"),
      terminated,
      armRun("C"),
    ]);
    expect(
      firstTriplet(terminatedReport).arms.B.metrics.planTransitions,
    ).toEqual({ count: 2, proven: 1, violations: 1 });
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

    const continuingAppliedStale = commanderRecord({
      sequence: 2,
      arm: "C",
      planID: "C-live",
      replanReason: "within_horizon",
    });
    continuingAppliedStale.decisionMetadata!.commanderResponseDisposition =
      "applied";
    continuingAppliedStale.decisionMetadata!.commanderRejectionCode =
      "decision_sequence_stale";
    const continuingInvalid = buildCommanderArmReport([
      armRun("A"),
      armRun("B"),
      armRun("C", [live, continuingAppliedStale]),
    ]);
    const continuingTriplet = firstTriplet(continuingInvalid);
    expect(continuingTriplet.arms.C.metrics.fallbackAuthoredPlans).toBe(0);
    expect(continuingTriplet.arms.C.metrics.staleRejectedAttempts).toBe(0);
    expect(continuingTriplet.arms.C.metrics.staleAuthorityViolations).toBe(1);
    expect(continuingTriplet.integrity.valid).toBe(false);
    expect(continuingTriplet.terminalPerformanceEligibility).toEqual({
      estimand: "per-protocol",
      eligible: false,
      ineligibilityReasons: expect.arrayContaining([
        "triplet integrity is invalid; per-protocol terminal outcomes require structurally valid evidence",
        "Arm C applied or retained stale selector authority; per-protocol terminal outcomes require zero",
      ]),
    });
    expect(continuingInvalid.aggregate.includedTripletIDs).toEqual([]);
    expect(continuingInvalid.aggregate.excludedTripletIDs).toEqual([
      "triplet-1",
    ]);
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
    expect(
      firstTriplet(report).terminalPerformanceEligibility.ineligibilityReasons,
    ).toEqual(
      expect.arrayContaining([
        "Arm C contains a fallback-authored plan; per-protocol terminal outcomes require zero",
        "Arm C contains a stale selector attempt; per-protocol terminal outcomes require zero",
      ]),
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

  it("independently excludes timeout, parse, and transport fallback plans when both fallback stamps are forged off", () => {
    for (const [failureKind, degradedCause, terminalReason] of [
      [
        "timeout",
        "plan-timeout",
        "Arm C contains a selector timeout; per-protocol terminal outcomes require zero",
      ],
      [
        "parse",
        "plan-parse",
        "Arm C contains a selector parse failure; per-protocol terminal outcomes require zero",
      ],
      [
        "transport",
        "plan-transport",
        "Arm C contains a selector transport failure; per-protocol terminal outcomes require zero",
      ],
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
      expect(
        firstTriplet(report).terminalPerformanceEligibility
          .ineligibilityReasons,
        failureKind,
      ).toContain(terminalReason);
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
        "Arm B failed offered-id, acceptance, or submitted-intent proof",
        "Arm C failed offered-id, acceptance, or submitted-intent proof",
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
