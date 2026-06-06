import { randomUUID } from "crypto";
import { Logger } from "winston";
import { Game } from "../../core/game/Game";
import { GameServer } from "../GameServer";
import { validateAgentDecision } from "./AgentDecisionValidator";
import {
  actionAlignsWithObjective,
  AgentObjectiveManager,
} from "./AgentObjectiveManager";
import {
  AgentObservationBuilder,
  BuildAgentObservationInput,
} from "./AgentObservationBuilder";
import { AgentRunner } from "./AgentRunner";
import { buildAgentTacticalAffordances } from "./AgentTacticalAffordances";
import {
  AgentActionResult,
  AgentBrain,
  AgentCommunicationIntent,
  AgentCommunicationSignal,
  AgentDecision,
  AgentDecisionRecord,
  AgentObservation,
  AgentStrategyProfile,
  agentStrategyProfiles,
  LegalAction,
  LegalActionKind,
  RecentAgentDecision,
} from "./AgentTypes";
import {
  buildSpawnCandidates,
  LegalActionBuilder,
  SpawnCandidate,
} from "./LegalActionBuilder";
import { RuleAgentBrain } from "./RuleAgentBrain";

export { buildAttackScenarioSpawnPlan } from "./AgentAttackScenario";
export { agentStrategyProfiles, buildSpawnCandidates };
export type { AgentDecisionRecord, AgentStrategyProfile, SpawnCandidate };

export interface AgentSpec {
  username: string;
  profile: AgentStrategyProfile;
  clientID?: string;
  persistentID?: string;
}

export interface AgentParticipant {
  runner: AgentRunner;
  spec: AgentSpec;
  brain: AgentBrain;
}

export interface CreateAgentParticipantsOptions {
  brainFactory?: (spec: AgentSpec, index: number) => AgentBrain;
}

export interface AgentLeagueMatchOptions {
  game: GameServer;
  participants: AgentParticipant[];
  spawnCandidates: SpawnCandidate[];
  log: Logger;
  minSpawnDistance?: number;
  observationBuilder?: AgentObservationBuilder;
  legalActionBuilder?: LegalActionBuilder;
  decisionValidator?: typeof validateAgentDecision;
  disabledActionKinds?: LegalActionKind[];
}

export interface RunAgentDecisionTurnOptions {
  turnNumber?: number;
  gameState?: Game;
  phaseOverride?: BuildAgentObservationInput["phaseOverride"];
  spawnCandidates?: SpawnCandidate[];
  maxDecisionMs?: number;
}

export function createDefaultAgentSpecs(count = 4): AgentSpec[] {
  if (count < 1 || count > 8) {
    throw new Error("AI Nations League local matches support 1 to 8 agents");
  }

  return Array.from({ length: count }, (_, index) => {
    const profile = agentStrategyProfiles[index % agentStrategyProfiles.length];
    return {
      username: `${capitalize(profile)} Agent ${index + 1}`,
      profile,
      persistentID: randomUUID(),
    };
  });
}

export function createAgentParticipants(
  specs: AgentSpec[],
  log: Logger,
  options: CreateAgentParticipantsOptions = {},
): AgentParticipant[] {
  return specs.map((spec, index) => ({
    spec,
    brain:
      options.brainFactory?.(spec, index) ?? new RuleAgentBrain(spec.profile),
    runner: new AgentRunner({
      agentID: `${spec.profile}-agent-${index + 1}`,
      clientID: spec.clientID,
      username: spec.username,
      persistentID: spec.persistentID,
      log,
    }),
  }));
}

export class AgentLeagueMatchRunner {
  private readonly log: Logger;
  private readonly minSpawnDistance: number;
  private readonly records: AgentDecisionRecord[] = [];
  private readonly observationBuilder: AgentObservationBuilder;
  private readonly legalActionBuilder: LegalActionBuilder;
  private readonly objectiveManager = new AgentObjectiveManager();
  private readonly decisionValidator: typeof validateAgentDecision;
  private readonly disabledActionKinds: Set<LegalActionKind>;

  constructor(private readonly options: AgentLeagueMatchOptions) {
    this.log = options.log.child({ comp: "agent_league_match" });
    this.minSpawnDistance =
      options.minSpawnDistance ??
      defaultMinSpawnDistance(
        options.spawnCandidates,
        options.participants.length,
      );
    this.observationBuilder =
      options.observationBuilder ?? new AgentObservationBuilder();
    this.legalActionBuilder =
      options.legalActionBuilder ?? new LegalActionBuilder();
    this.decisionValidator = options.decisionValidator ?? validateAgentDecision;
    this.disabledActionKinds = new Set(options.disabledActionKinds ?? []);
  }

  attachAgents(): void {
    for (const participant of this.options.participants) {
      const join = participant.runner.attachToGame(this.options.game);
      this.log.info("league agent attach result", {
        agentID: participant.runner.agentID,
        username: participant.spec.username,
        profile: participant.spec.profile,
        join,
      });
    }
  }

  startGame(): void {
    // Manual-tick mode: this runner drives turns via advanceTurnsForTesting and
    // has no real network clients. Disable the server's real-time clock so the
    // simulation is deterministic (no wall-clock endTurn interval, no wall-clock
    // disconnect detection injecting mark_disconnected intents at load-dependent
    // turns). Without this, same-seed benchmark/league runs diverge.
    this.options.game.start({ realtimeClock: false });
    this.log.info("league game started", {
      gameID: this.options.game.id,
      agents: this.options.participants.length,
    });
  }

  async runOpeningTurn(
    turnNumber = 0,
    options: Pick<RunAgentDecisionTurnOptions, "maxDecisionMs"> = {},
  ): Promise<AgentDecisionRecord[]> {
    return this.runDecisionTurn({
      turnNumber,
      phaseOverride: "spawn",
      spawnCandidates: this.options.spawnCandidates,
      maxDecisionMs: options.maxDecisionMs,
    });
  }

  async runDecisionTurn(
    options: RunAgentDecisionTurnOptions = {},
  ): Promise<AgentDecisionRecord[]> {
    if (options.phaseOverride === "spawn") {
      return this.runDecisionTurnSerial(options);
    }

    const turnSpawnCandidates = [
      ...(options.spawnCandidates ?? this.options.spawnCandidates),
    ];
    const startingRecordCount = this.records.length;
    const decisionInputs = this.options.participants.map((participant) => {
      const observationInput: BuildAgentObservationInput = {
        agentID: participant.runner.agentID,
        clientID: participant.runner.clientID(),
        username: participant.spec.username,
        profile: participant.spec.profile,
        gameID: this.options.game.id,
        turnNumber: options.turnNumber ?? 0,
        gameState: options.gameState,
        phaseOverride: options.phaseOverride,
        objective: this.objectiveManager.currentObjective(
          participant.runner.agentID,
        ),
        recentDecisions: this.recentDecisionsFor(participant),
      };
      const initialObservation = this.observationBuilder.build(observationInput);
      const recentCommunications = this.recentCommunicationSignalsFor(
        participant,
        initialObservation,
      );
      const baseObservation =
        recentCommunications.length === 0
          ? initialObservation
          : this.observationBuilder.build({
              ...observationInput,
              recentCommunications,
            });
      const legalActions = this.filterDisabledActionKinds(
        this.legalActionBuilder.build({
          observation: baseObservation,
          spawnCandidates: turnSpawnCandidates,
        }),
      );
      const objective = this.objectiveManager.objectiveFor({
        agentID: participant.runner.agentID,
        profile: participant.spec.profile,
        observation: baseObservation,
        legalActions,
        turnNumber: baseObservation.turnNumber,
      });
      const observation: AgentObservation = {
        ...baseObservation,
        objective,
      };
      return {
        participant,
        observation,
        observationSummary: this.observationBuilder.summarize(observation),
        legalActions,
      };
    });

    const decisions = await Promise.all(
      decisionInputs.map(async (input) => {
        const decisionStartedAt = Date.now();
        const decision = await decideWithSafetyFallback({
          brain: input.participant.brain,
          fallbackProfile: input.participant.spec.profile,
          observation: input.observation,
          legalActions: input.legalActions,
          maxDecisionMs: options.maxDecisionMs,
        });
        return {
          ...input,
          decision,
          decisionLatencyMs: Date.now() - decisionStartedAt,
        };
      }),
    );

    let availableCandidates = [...turnSpawnCandidates];
    const sameTurnDiplomacyParticipants = new Set<string>();
    const sameTurnAllianceRequests = new Set<string>();
    const sameTurnBuildTiles: number[] = [];

    for (const input of decisions) {
      const submissionLegalActions = this.filterDisabledActionKinds(
        this.filterSameTurnBuildActions(
          this.filterSameTurnDiplomacyActions(
            this.filterSameTurnSpawnActions(
              input.legalActions,
              availableCandidates,
            ),
            input.observation,
            sameTurnDiplomacyParticipants,
            sameTurnAllianceRequests,
          ),
          options.gameState,
          sameTurnBuildTiles,
        ),
      );
      const { participant, observation, decision, decisionLatencyMs } = input;
      const requestedActionIDs = requestedDecisionActionIDs(decision);
      const rejectedActionIDs: string[] = [];
      const selectedActions: Array<{
        action: LegalAction | null;
        requestedActionID: string;
        reason: string;
      }> = [];

      for (const actionID of requestedActionIDs) {
        const actionDecision: AgentDecision = { ...decision, actionID };
        const validation = this.decisionValidator(
          actionDecision,
          submissionLegalActions,
        );
        if (validation.ok) {
          selectedActions.push({
            action: validation.action,
            requestedActionID: actionID,
            reason: decision.reason,
          });
        } else {
          rejectedActionIDs.push(actionID);
        }
      }

      if (selectedActions.length === 0) {
        const validation = this.decisionValidator(
          decision,
          submissionLegalActions,
        );
        const action = actionFromValidation(validation);
        selectedActions.push({
          action,
          requestedActionID: decision.actionID,
          reason: decisionReason(decision, validation, action),
        });
      }

      selectedActions.forEach((selected, batchIndex) => {
        const batchDecision: AgentDecision = {
          ...decision,
          actionID: selected.requestedActionID,
          metadata: batchDecisionMetadata({
            metadata: decision.metadata,
            batchIndex,
            batchSize: selectedActions.length,
            requestedActionIDs,
            rejectedActionIDs,
          }),
        };
        const result = selected.action
          ? this.submitLegalAction(participant.runner, selected.action)
          : {
              accepted: false,
              reason: "no legal fallback action available",
              submittedIntent: null,
            };
        const record = this.recordDecision({
          participant,
          turnNumber: observation.turnNumber,
          observationSummary: input.observationSummary,
          observation,
          legalActions: submissionLegalActions,
          chosenAction: selected.action,
          decision: batchDecision,
          decisionLatencyMs,
          reason: selected.reason,
          result,
        });

        if (selected.action?.kind === "spawn") {
          availableCandidates = this.removeNearbySpawnCandidates(
            availableCandidates,
            selected.action,
          );
        }
        this.reserveSameTurnDiplomacy(
          selected.action,
          observation,
          sameTurnDiplomacyParticipants,
          sameTurnAllianceRequests,
        );
        this.reserveSameTurnBuild(selected.action, sameTurnBuildTiles);

        this.log.info("league agent decision recorded", {
          sequence: record.sequence,
          agentID: record.agentID,
          profile: record.profile,
          observationSummary: record.observationSummary,
          objectiveKind: record.objectiveKind,
          objectiveAligned: record.objectiveAligned,
          legalActionIDs: record.legalActionIDs,
          legalActionIDsByKind: record.legalActionIDsByKind,
          chosenActionID: record.chosenActionID,
          chosenActionKind: record.chosenActionKind,
          chosenActionMetadata: record.chosenActionMetadata,
          runtimeMode: record.decisionMetadata?.runtimeMode,
          plannerSource: record.decisionMetadata?.plannerSource,
          executorSource: record.decisionMetadata?.executorSource,
          actionSelectionSource: record.decisionMetadata?.actionSelectionSource,
          externalPlannerCall: record.decisionMetadata?.externalPlannerCall,
          externalActionCall: record.decisionMetadata?.externalActionCall,
          rawProviderOutputPresent:
            record.decisionMetadata?.rawProviderOutputPresent,
          attackActionIDs: record.attackActionIDs,
          decisionMetadata: compactDecisionMetadata(record.decisionMetadata),
          decisionLatencyMs: record.decisionLatencyMs,
          intent: record.intent,
          accepted: result.accepted,
          reason: record.reason,
          fallbackUsed: record.decisionMetadata?.fallbackUsed ?? false,
        });
      });
    }

    return this.records.slice(startingRecordCount);
  }

  private async runDecisionTurnSerial(
    options: RunAgentDecisionTurnOptions = {},
  ): Promise<AgentDecisionRecord[]> {
    let availableCandidates = [
      ...(options.spawnCandidates ?? this.options.spawnCandidates),
    ];
    const startingRecordCount = this.records.length;
    const sameTurnDiplomacyParticipants = new Set<string>();
    const sameTurnAllianceRequests = new Set<string>();
    const sameTurnBuildTiles: number[] = [];

    for (const participant of this.options.participants) {
      const observationInput: BuildAgentObservationInput = {
        agentID: participant.runner.agentID,
        clientID: participant.runner.clientID(),
        username: participant.spec.username,
        profile: participant.spec.profile,
        gameID: this.options.game.id,
        turnNumber: options.turnNumber ?? 0,
        gameState: options.gameState,
        phaseOverride: options.phaseOverride,
        objective: this.objectiveManager.currentObjective(
          participant.runner.agentID,
        ),
        recentDecisions: this.recentDecisionsFor(participant),
      };
      const initialObservation = this.observationBuilder.build(observationInput);
      const recentCommunications = this.recentCommunicationSignalsFor(
        participant,
        initialObservation,
      );
      const baseObservation =
        recentCommunications.length === 0
          ? initialObservation
          : this.observationBuilder.build({
              ...observationInput,
              recentCommunications,
            });
      const legalActions = this.filterDisabledActionKinds(
        this.filterSameTurnBuildActions(
          this.filterSameTurnDiplomacyActions(
            this.legalActionBuilder.build({
              observation: baseObservation,
              spawnCandidates: availableCandidates,
            }),
            baseObservation,
            sameTurnDiplomacyParticipants,
            sameTurnAllianceRequests,
          ),
          options.gameState,
          sameTurnBuildTiles,
        ),
      );
      const objective = this.objectiveManager.objectiveFor({
        agentID: participant.runner.agentID,
        profile: participant.spec.profile,
        observation: baseObservation,
        legalActions,
        turnNumber: baseObservation.turnNumber,
      });
      const observation: AgentObservation = {
        ...baseObservation,
        objective,
      };
      const decisionStartedAt = Date.now();
      const decision = await decideWithSafetyFallback({
        brain: participant.brain,
        fallbackProfile: participant.spec.profile,
        observation,
        legalActions,
        maxDecisionMs: options.maxDecisionMs,
      });
      const decisionLatencyMs = Date.now() - decisionStartedAt;
      availableCandidates = this.applyDecision({
        participant,
        observation,
        observationSummary: this.observationBuilder.summarize(observation),
        legalActions,
        decision,
        decisionLatencyMs,
        availableCandidates,
        sameTurnDiplomacyParticipants,
        sameTurnAllianceRequests,
        sameTurnBuildTiles,
      });
    }

    return this.records.slice(startingRecordCount);
  }

  private applyDecision(input: {
    participant: AgentParticipant;
    observation: AgentObservation;
    observationSummary: string;
    legalActions: LegalAction[];
    decision: AgentDecision;
    decisionLatencyMs: number;
    availableCandidates: SpawnCandidate[];
    sameTurnDiplomacyParticipants: Set<string>;
    sameTurnAllianceRequests: Set<string>;
    sameTurnBuildTiles: number[];
  }): SpawnCandidate[] {
    const requestedActionIDs = requestedDecisionActionIDs(input.decision);
    const rejectedActionIDs: string[] = [];
    const selectedActions: Array<{
      action: LegalAction | null;
      requestedActionID: string;
      reason: string;
    }> = [];

    for (const actionID of requestedActionIDs) {
      const actionDecision: AgentDecision = { ...input.decision, actionID };
      const validation = this.decisionValidator(actionDecision, input.legalActions);
      if (validation.ok) {
        selectedActions.push({
          action: validation.action,
          requestedActionID: actionID,
          reason: input.decision.reason,
        });
      } else {
        rejectedActionIDs.push(actionID);
      }
    }

    if (selectedActions.length === 0) {
      const validation = this.decisionValidator(input.decision, input.legalActions);
      const action = actionFromValidation(validation);
      selectedActions.push({
        action,
        requestedActionID: input.decision.actionID,
        reason: decisionReason(input.decision, validation, action),
      });
    }

    let availableCandidates = input.availableCandidates;
    selectedActions.forEach((selected, batchIndex) => {
      const batchDecision: AgentDecision = {
        ...input.decision,
        actionID: selected.requestedActionID,
        metadata: batchDecisionMetadata({
          metadata: input.decision.metadata,
          batchIndex,
          batchSize: selectedActions.length,
          requestedActionIDs,
          rejectedActionIDs,
        }),
      };
      const result = selected.action
        ? this.submitLegalAction(input.participant.runner, selected.action)
        : {
            accepted: false,
            reason: "no legal fallback action available",
            submittedIntent: null,
          };
      const record = this.recordDecision({
        participant: input.participant,
        turnNumber: input.observation.turnNumber,
        observationSummary: input.observationSummary,
        observation: input.observation,
        legalActions: input.legalActions,
        chosenAction: selected.action,
        decision: batchDecision,
        decisionLatencyMs: input.decisionLatencyMs,
        reason: selected.reason,
        result,
      });

      if (selected.action?.kind === "spawn") {
        availableCandidates = this.removeNearbySpawnCandidates(
          availableCandidates,
          selected.action,
        );
      }
      this.reserveSameTurnDiplomacy(
        selected.action,
        input.observation,
        input.sameTurnDiplomacyParticipants,
        input.sameTurnAllianceRequests,
      );
      this.reserveSameTurnBuild(selected.action, input.sameTurnBuildTiles);

      this.log.info("league agent decision recorded", {
        sequence: record.sequence,
        agentID: record.agentID,
        profile: record.profile,
        observationSummary: record.observationSummary,
        objectiveKind: record.objectiveKind,
        objectiveAligned: record.objectiveAligned,
        legalActionIDs: record.legalActionIDs,
        legalActionIDsByKind: record.legalActionIDsByKind,
        chosenActionID: record.chosenActionID,
        chosenActionKind: record.chosenActionKind,
        chosenActionMetadata: record.chosenActionMetadata,
        runtimeMode: record.decisionMetadata?.runtimeMode,
        plannerSource: record.decisionMetadata?.plannerSource,
        executorSource: record.decisionMetadata?.executorSource,
        actionSelectionSource: record.decisionMetadata?.actionSelectionSource,
        externalPlannerCall: record.decisionMetadata?.externalPlannerCall,
        externalActionCall: record.decisionMetadata?.externalActionCall,
        rawProviderOutputPresent:
          record.decisionMetadata?.rawProviderOutputPresent,
        attackActionIDs: record.attackActionIDs,
        decisionMetadata: compactDecisionMetadata(record.decisionMetadata),
        decisionLatencyMs: record.decisionLatencyMs,
        intent: record.intent,
        accepted: result.accepted,
        reason: record.reason,
        fallbackUsed: record.decisionMetadata?.fallbackUsed ?? false,
      });
    });

    return availableCandidates;
  }

  decisionRecords(): AgentDecisionRecord[] {
    return [...this.records];
  }

  private submitLegalAction(
    runner: AgentRunner,
    action: LegalAction,
  ): AgentActionResult {
    if (action.intent === null) {
      return {
        accepted: true,
        reason: "hold action selected; no game intent submitted",
        submittedIntent: null,
      };
    }

    const result = runner.submitLegalAction(action);
    return {
      accepted: result.accepted,
      reason: result.reason,
      submittedIntent: result.intent,
    };
  }

  private recordDecision(input: {
    participant: AgentParticipant;
    turnNumber: number;
    observationSummary: string;
    observation: AgentObservation;
    legalActions: LegalAction[];
    chosenAction: LegalAction | null;
    decision: AgentDecision;
    decisionLatencyMs: number;
    reason: string;
    result: AgentActionResult;
  }): AgentDecisionRecord {
    const record: AgentDecisionRecord = {
      sequence: this.records.length + 1,
      gameID: this.options.game.id,
      agentID: input.participant.runner.agentID,
      clientID: input.participant.runner.clientID(),
      username: input.participant.spec.username,
      profile: input.participant.spec.profile,
      brainType: input.participant.brain.brainType ?? "rule",
      turnNumber: input.turnNumber,
      decidedAt: Date.now(),
      decisionLatencyMs: input.decisionLatencyMs,
      observationSummary: input.observationSummary,
      strategicPriority: input.observation.strategic.priority,
      strategicUrgency: input.observation.strategic.urgency,
      strategicSummary: input.observation.strategic.summary,
      memorySummary: input.observation.memory.summary,
      ...(input.observation.objective
        ? {
            objectiveKind: input.observation.objective.kind,
            objectiveSummary: input.observation.objective.summary,
            objectiveAligned: actionAlignsWithObjective(
              input.observation.objective,
              input.chosenAction,
            ),
          }
        : {}),
      legalActionIDs: input.legalActions.map((action) => action.id),
      legalActionIDsByKind: groupLegalActionsByKind(input.legalActions),
      attackActionIDs: input.legalActions
        .filter((action) => action.kind === "attack")
        .map((action) => action.id),
      chosenActionID: input.chosenAction?.id ?? input.decision.actionID,
      chosenActionKind: input.chosenAction?.kind ?? "hold",
      reason: input.reason,
      decisionMetadata: input.decision.metadata,
      chosenActionMetadata: input.chosenAction?.metadata,
      tacticalAffordances: buildAgentTacticalAffordances({
        observation: input.observation,
        legalActions: input.legalActions,
      }),
      intent: input.chosenAction?.intent ?? null,
      result: input.result,
    };
    this.records.push(record);
    return record;
  }

  private recentDecisionsFor(
    participant: AgentParticipant,
  ): RecentAgentDecision[] {
    return this.records
      .filter((record) => record.agentID === participant.runner.agentID)
      .slice(-8)
      .map((record) => {
        const metadata = record.chosenActionMetadata ?? {};
        const targetID = metadata.targetID ?? metadata.recipientID;
        const targetName = metadata.targetName ?? metadata.recipientName;
        const unit = metadata.unit;
        const expansion = metadata.expansion;
        const ownState = ownStateFromObservationSummary(
          record.observationSummary,
        );
        const spawnPressureScore = numberMetadata(metadata.pressureScore);
        const spawnSafetyScore = numberMetadata(metadata.safetyScore);
        const spawnOpportunityScore = numberMetadata(metadata.opportunityScore);
        const spawnLocalLandScore = numberMetadata(metadata.localLandScore);

        return {
          sequence: record.sequence,
          actionID: record.chosenActionID,
          actionKind: record.chosenActionKind,
          reason: record.reason,
          accepted: record.result.accepted,
          ...ownState,
          ...(spawnPressureScore !== null ? { spawnPressureScore } : {}),
          ...(spawnSafetyScore !== null ? { spawnSafetyScore } : {}),
          ...(spawnOpportunityScore !== null ? { spawnOpportunityScore } : {}),
          ...(spawnLocalLandScore !== null ? { spawnLocalLandScore } : {}),
          ...(typeof targetID === "string" || targetID === null
            ? { targetID }
            : {}),
          ...(typeof targetName === "string" ? { targetName } : {}),
          ...(typeof unit === "string" ? { unit } : {}),
          ...(typeof expansion === "boolean" ? { expansion } : {}),
        };
      });
  }

  private recentCommunicationSignalsFor(
    participant: AgentParticipant,
    observation: AgentObservation,
  ): AgentCommunicationSignal[] {
    const ownPlayerID = observation.ownState?.playerID ?? null;
    return this.records
      .filter(
        (record) =>
          record.agentID !== participant.runner.agentID &&
          record.result.accepted &&
          isCommunicationRecord(record),
      )
      .slice(-18)
      .map((record) => {
        const metadata = record.chosenActionMetadata ?? {};
        const sender = observation.visiblePlayers.find(
          (player) =>
            player.clientID === record.clientID || player.name === record.username,
        );
        const recipientID = stringOrNull(metadata.recipientID);
        const recipientName = stringOrNull(metadata.recipientName);
        const targetID = stringOrNull(metadata.targetID);
        const targetName = stringOrNull(metadata.targetName);
        return {
          sequence: record.sequence,
          turnNumber: record.turnNumber,
          senderAgentID: record.agentID,
          senderPlayerID: sender?.playerID ?? null,
          senderName: record.username,
          senderProfile: record.profile,
          actionKind: record.chosenActionKind as AgentCommunicationSignal["actionKind"],
          intent: communicationIntent(record),
          recipientID,
          recipientName,
          targetID,
          targetName,
          quickChatKey: stringOrNull(metadata.quickChatKey),
          message: stringOrNull(metadata.message),
          emoji: numberMetadata(metadata.emoji),
          emojiText: stringOrNull(metadata.emojiText),
          directToAgent:
            ownPlayerID !== null &&
            (recipientID === ownPlayerID || targetID === ownPlayerID),
        };
      })
      .filter((signal) => {
        if (ownPlayerID === null) {
          return true;
        }
        return (
          signal.directToAgent ||
          signal.actionKind === "target_player" ||
          (signal.intent === "coordinate_attack" &&
            signal.targetID !== ownPlayerID)
        );
      })
      .slice(-8);
  }

  private removeNearbySpawnCandidates(
    candidates: SpawnCandidate[],
    action: LegalAction,
  ): SpawnCandidate[] {
    const tile = action.metadata?.tile;
    if (typeof tile !== "number") {
      return candidates;
    }
    const chosen = candidates.find((candidate) => candidate.tile === tile);
    if (chosen === undefined) {
      return candidates;
    }
    return candidates.filter(
      (candidate) =>
        distanceBetweenCandidates(candidate, chosen) >= this.minSpawnDistance,
    );
  }

  private filterSameTurnSpawnActions(
    legalActions: LegalAction[],
    availableCandidates: SpawnCandidate[],
  ): LegalAction[] {
    if (!legalActions.some((action) => action.kind === "spawn")) {
      return legalActions;
    }
    const availableTiles = new Set(
      availableCandidates.map((candidate) => candidate.tile),
    );
    return legalActions.filter((action) => {
      if (action.kind !== "spawn") {
        return true;
      }
      const tile = action.metadata?.tile;
      return typeof tile === "number" && availableTiles.has(tile);
    });
  }

  private filterSameTurnDiplomacyActions(
    legalActions: LegalAction[],
    observation: AgentObservation,
    reservedPlayerIDs: Set<string>,
    sameTurnAllianceRequests: Set<string>,
  ): LegalAction[] {
    if (reservedPlayerIDs.size === 0) {
      return legalActions;
    }

    const requestorID = observation.ownState?.playerID ?? null;
    return legalActions.filter((action) => {
      if (!isDiplomacyAction(action)) {
        return true;
      }
      const recipientID = diplomacyTargetID(action);
      if (
        action.kind === "alliance_request" &&
        requestorID !== null &&
        recipientID !== null &&
        sameTurnAllianceRequests.has(alliancePairKey(recipientID, requestorID))
      ) {
        return true;
      }
      return (
        (!requestorID || !reservedPlayerIDs.has(requestorID)) &&
        (!recipientID || !reservedPlayerIDs.has(recipientID))
      );
    });
  }

  private filterSameTurnBuildActions(
    legalActions: LegalAction[],
    gameState: Game | undefined,
    reservedBuildTiles: number[],
  ): LegalAction[] {
    if (reservedBuildTiles.length === 0) {
      return legalActions;
    }

    const minDistanceSquared =
      gameState?.config().structureMinDist() === undefined
        ? 0
        : gameState.config().structureMinDist() ** 2;
    return legalActions.filter((action) => {
      if (action.kind !== "build") {
        return true;
      }
      const buildTile = buildTileForAction(action);
      if (buildTile === null) {
        return true;
      }
      return reservedBuildTiles.every((reserved) => {
        if (gameState === undefined || minDistanceSquared <= 0) {
          return reserved !== buildTile;
        }
        return (
          gameState.euclideanDistSquared(reserved, buildTile) >=
          minDistanceSquared
        );
      });
    });
  }

  private filterDisabledActionKinds(
    legalActions: LegalAction[],
  ): LegalAction[] {
    if (this.disabledActionKinds.size === 0) {
      return legalActions;
    }
    return legalActions.filter(
      (action) =>
        action.kind === "hold" || !this.disabledActionKinds.has(action.kind),
    );
  }

  private reserveSameTurnDiplomacy(
    action: LegalAction | null,
    observation: AgentObservation,
    reservedPlayerIDs: Set<string>,
    sameTurnAllianceRequests: Set<string>,
  ): void {
    if (!action || !isDiplomacyAction(action)) {
      return;
    }

    const requestorID = observation.ownState?.playerID;
    const recipientID = diplomacyTargetID(action);
    if (
      action.kind === "alliance_request" &&
      requestorID !== undefined &&
      recipientID !== null
    ) {
      sameTurnAllianceRequests.add(alliancePairKey(requestorID, recipientID));
    }
    if (requestorID) {
      reservedPlayerIDs.add(requestorID);
    }
    if (recipientID) {
      reservedPlayerIDs.add(recipientID);
    }
  }

  private reserveSameTurnBuild(
    action: LegalAction | null,
    reservedBuildTiles: number[],
  ): void {
    const buildTile = action === null ? null : buildTileForAction(action);
    if (buildTile !== null) {
      reservedBuildTiles.push(buildTile);
    }
  }
}

function alliancePairKey(requestorID: string, recipientID: string): string {
  return `${requestorID}->${recipientID}`;
}

function buildTileForAction(action: LegalAction): number | null {
  if (action.kind !== "build") {
    return null;
  }
  const intentTile =
    action.intent?.type === "build_unit" ? action.intent.tile : undefined;
  const buildTile = action.metadata?.buildTile ?? intentTile;
  return typeof buildTile === "number" ? buildTile : null;
}

function isDiplomacyAction(action: LegalAction): boolean {
  return (
    action.kind === "alliance_request" ||
    action.kind === "alliance_reject" ||
    action.kind === "alliance_extend" ||
    action.kind === "break_alliance" ||
    action.kind === "donate_gold" ||
    action.kind === "donate_troops" ||
    action.kind === "embargo" ||
    action.kind === "embargo_stop" ||
    action.kind === "embargo_all" ||
    action.kind === "target_player" ||
    action.kind === "quick_chat" ||
    action.kind === "emoji"
  );
}

function diplomacyTargetID(action: LegalAction): string | null {
  if (action.intent?.type === "allianceRequest") {
    return action.intent.recipient;
  }
  if (
    action.intent?.type === "allianceReject" ||
    action.intent?.type === "targetPlayer"
  ) {
    return action.intent.type === "allianceReject"
      ? action.intent.requestor
      : action.intent.target;
  }
  if (
    action.intent?.type === "allianceExtension" ||
    action.intent?.type === "breakAlliance" ||
    action.intent?.type === "donate_gold" ||
    action.intent?.type === "donate_troops" ||
    action.intent?.type === "quick_chat" ||
    action.intent?.type === "emoji"
  ) {
    return action.intent.recipient;
  }
  if (action.intent?.type === "embargo") {
    return action.intent.targetID;
  }
  const metadataTarget =
    action.metadata?.recipientID ?? action.metadata?.targetID;
  return typeof metadataTarget === "string" ? metadataTarget : null;
}

async function decideWithSafetyFallback(input: {
  brain: AgentBrain;
  fallbackProfile: AgentStrategyProfile;
  observation: AgentObservation;
  legalActions: LegalAction[];
  maxDecisionMs?: number;
}): Promise<AgentDecision> {
  try {
    return await withOptionalTimeout(
      Promise.resolve(
        input.brain.decide({
          observation: input.observation,
          legalActions: input.legalActions,
        }),
      ),
      input.maxDecisionMs,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallbackDecision = await new RuleAgentBrain(
      input.fallbackProfile,
    ).decide({
      observation: input.observation,
      legalActions: input.legalActions,
    });
    return {
      actionID: fallbackDecision.actionID,
      reason: `Agent brain failed (${reason}); fallback: ${fallbackDecision.reason}`,
      metadata: {
        ...fallbackDecision.metadata,
        brainType: input.brain.brainType ?? "rule",
        brainErrorReason: reason,
        fallbackUsed: true,
        fallbackActionID: fallbackDecision.actionID,
      },
    };
  }
}

async function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return promise;
  }

  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutID = setTimeout(
          () => reject(new Error(`Agent brain timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutID !== undefined) {
      clearTimeout(timeoutID);
    }
  }
}

function groupLegalActionsByKind(
  legalActions: LegalAction[],
): AgentDecisionRecord["legalActionIDsByKind"] {
  return legalActions.reduce<AgentDecisionRecord["legalActionIDsByKind"]>(
    (grouped, action) => {
      grouped[action.kind] ??= [];
      grouped[action.kind]?.push(action.id);
      return grouped;
    },
    {},
  );
}

function compactDecisionMetadata(
  metadata: AgentDecisionRecord["decisionMetadata"],
): AgentDecisionRecord["decisionMetadata"] {
  if (metadata?.llmPrompt === undefined) {
    return metadata;
  }
  return {
    ...metadata,
    llmPrompt: "[stored in artifact only]",
    llmPromptLength:
      typeof metadata.llmPrompt === "string" ? metadata.llmPrompt.length : null,
  };
}

function requestedDecisionActionIDs(decision: AgentDecision): string[] {
  const ids =
    decision.actionIDs !== undefined && decision.actionIDs.length > 0
      ? decision.actionIDs
      : [decision.actionID];
  const deduplicated: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !deduplicated.includes(id)) {
      deduplicated.push(id);
    }
  }
  return deduplicated.length > 0 ? deduplicated : [decision.actionID];
}

function isCommunicationRecord(record: AgentDecisionRecord): boolean {
  return (
    record.chosenActionKind === "quick_chat" ||
    record.chosenActionKind === "emoji" ||
    record.chosenActionKind === "target_player" ||
    record.chosenActionKind === "alliance_request"
  );
}

function communicationIntent(
  record: AgentDecisionRecord,
): AgentCommunicationIntent {
  if (record.chosenActionKind === "target_player") {
    return "coordinate_attack";
  }
  if (record.chosenActionKind === "alliance_request") {
    return "propose_alliance";
  }
  const metadata = record.chosenActionMetadata ?? {};
  const quickChatKey = stringOrNull(metadata.quickChatKey) ?? "";
  if (quickChatKey.startsWith("attack.")) {
    return "coordinate_attack";
  }
  if (quickChatKey.startsWith("help.")) {
    return "request_support";
  }
  if (quickChatKey.startsWith("defend.")) {
    return "warn_threat";
  }
  if (quickChatKey === "misc.team_up") {
    return "propose_alliance";
  }
  if (quickChatKey.startsWith("greet.")) {
    return "acknowledge";
  }
  const emojiContext = stringOrNull(metadata.emojiContext);
  if (emojiContext === "alliance_signal") {
    return "acknowledge";
  }
  if (emojiContext === "retaliation" || emojiContext === "pressure_signal") {
    return "taunt";
  }
  return "unknown";
}

function ownStateFromObservationSummary(summary: string | undefined): {
  ownTiles?: number;
  ownTroops?: number;
} {
  const match = summary?.match(/own=(\d+) tiles, (\d+) troops/);
  if (match === undefined || match === null) {
    return {};
  }
  return {
    ownTiles: Number(match[1]),
    ownTroops: Number(match[2]),
  };
}

function numberMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function batchDecisionMetadata(input: {
  metadata: AgentDecision["metadata"];
  batchIndex: number;
  batchSize: number;
  requestedActionIDs: string[];
  rejectedActionIDs: string[];
}): AgentDecision["metadata"] {
  const metadata: AgentDecision["metadata"] = {
    ...(input.metadata ?? {}),
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    batchActionIDs: input.requestedActionIDs.join(","),
    batchRejectedActionIDs: input.rejectedActionIDs.join(","),
  };

  if (input.batchIndex > 0) {
    metadata.plannerRan = false;
    metadata.plannerLatencyMs = 0;
    metadata.plannerFallbackUsed = false;
    metadata.plannerPromptLength = 0;
    metadata.externalPlannerCall = false;
    metadata.rawProviderOutputPresent = false;
    if (typeof metadata.plannerRawOutput === "string") {
      metadata.plannerRawOutput = "[same planner decision as batch index 0]";
    }
  }
  return metadata;
}

function actionFromValidation(
  validation: ReturnType<typeof validateAgentDecision>,
): LegalAction | null {
  return validation.ok ? validation.action : validation.fallback;
}

function decisionReason(
  decision: AgentDecision,
  validation: ReturnType<typeof validateAgentDecision>,
  action: LegalAction | null,
): string {
  if (validation.ok) {
    return decision.reason;
  }
  const fallbackText = action ? ` fallback=${action.id}` : " no fallback";
  return `${decision.reason}; ${validation.reason};${fallbackText}`;
}

function distanceBetweenCandidates(
  a: SpawnCandidate,
  b: SpawnCandidate,
): number {
  if (
    a.x !== undefined &&
    a.y !== undefined &&
    b.x !== undefined &&
    b.y !== undefined
  ) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  return a.tile === b.tile ? 0 : Number.POSITIVE_INFINITY;
}

function defaultMinSpawnDistance(
  candidates: readonly SpawnCandidate[],
  participantCount: number,
): number {
  const coordinates = candidates.filter(
    (candidate) =>
      typeof candidate.x === "number" && typeof candidate.y === "number",
  );
  if (coordinates.length < 2) {
    return 12;
  }

  const xs = coordinates.map((candidate) => candidate.x!);
  const ys = coordinates.map((candidate) => candidate.y!);
  const span = Math.min(
    Math.max(...xs) - Math.min(...xs) + 1,
    Math.max(...ys) - Math.min(...ys) + 1,
  );
  const densityDivisor = Math.max(
    5.5,
    Math.sqrt(Math.max(1, participantCount)) * 2.8,
  );
  return Math.max(24, Math.min(72, Math.round(span / densityDivisor)));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
