import { randomUUID } from "crypto";
import { Logger } from "winston";
import { Game } from "../../core/game/Game";
import { ServerMessage } from "../../core/Schemas";
import { GameServer } from "../GameServer";
import {
  AgentDealManager,
  isDealActionKind,
  type AgentDealLedgerSnapshot,
} from "./AgentDealManager";
import { validateAgentDecision } from "./AgentDecisionValidator";
import { economyRecordFacts } from "./AgentEconomyNetwork";
import { AgentLocalGameMirror } from "./AgentLocalGameMirror";
import { selectSpawnTile } from "./AgentSpawnExplorer";
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
import { economyEventsEnabled, structuredDealsEnabled } from "./AgentTunables";
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
  /**
   * Retain type:"turn" server messages only on the primary (index 0) runner.
   * The mirror and spawn-phase driver read the turn stream from
   * participants[0] exclusively; every other seat's copy of the whole game's
   * turn history is dead weight that scales with seats x turns. Non-turn
   * messages (join/start/error) are always retained on every seat.
   */
  retainTurnMessagesPrimaryOnly?: boolean;
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
  /**
   * Whether to build and retain the per-decision `tacticalAffordances` summary.
   * Default: true (local eval / benchmark path — the behavior-quality report
   * and decision-log aggregates read it). The Coworld episode adapter sets this
   * false: `tacticalAffordances` is the single largest field of every decision
   * record on World (~8 KB, ~60-77% of the record) and is not part of the hosted
   * result/replay contract, so skipping it cuts per-record memory the same
   * amount at EVERY game depth — enough that the FULL decision log stays
   * affordable and never has to be truncated (which would hide fallback /
   * degradation telemetry). Skipping also avoids its per-decision build cost.
   * The field is already optional on AgentDecisionRecord and every reader uses
   * optional chaining, so omitting it is safe. Does not touch the simulation or
   * the agent decision — the record is built after the decision is made, and
   * the decision-feeding `observation.tacticalAffordances` is built separately.
   */
  retainTacticalAffordances?: boolean;
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
      ...(options.retainTurnMessagesPrimaryOnly === true
        ? { retainTurnMessages: index === 0 }
        : {}),
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
  private readonly retainTacticalAffordances: boolean;
  /**
   * Structured-deal ledger (PROXYWAR_TUNE_STRUCTURED_DEALS, default OFF —
   * null when the flag is off, leaving observations, menus, records, and
   * results byte-identical to shipped behavior). Runner-scoped meta-state
   * beside the communication-signal machinery; never touches core.
   */
  private readonly dealManager: AgentDealManager | null;
  // Log-once bookkeeping for seatEliminated. Liveness itself is recomputed
  // from the game snapshot every decision turn — never latched here.
  private readonly eliminatedSeatsAnnounced = new Set<string>();

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
    this.retainTacticalAffordances = options.retainTacticalAffordances ?? true;
    this.dealManager = structuredDealsEnabled() ? new AgentDealManager() : null;
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

  /**
   * Drive the spawn phase like a built-in nation: deterministically, with NO LLM call.
   * Built-in nations re-jitter their spawn near a region every spawn-phase tick and
   * settle (`NationExecution.randomSpawnLand`); this gives the agent the same behavior
   * by, each spawn tick, selecting an EXPLORING spawn tile (jump) via `selectSpawnTile`,
   * submitting + recording it (a synthetic non-LLM decision), then advancing the sim —
   * until the spawn phase ends. The LLM Commander (`brain.decide`) is bypassed here and
   * engages only in the active phase, so spawn costs zero model latency. Replaces the
   * single `runOpeningTurn()` at the eval entrypoints. Returns the spawn decision records.
   */
  async runSpawnPhase(options: {
    mirror: AgentLocalGameMirror;
    messages: () => ServerMessage[];
    turnsPerSpawnTick?: number;
    maxSpawnTicks?: number;
  }): Promise<AgentDecisionRecord[]> {
    const startingRecordCount = this.records.length;
    const turnsPerSpawnTick = Math.max(1, options.turnsPerSpawnTick ?? 10);
    // Bound the loop the way the step-locked league bounds spawn advance
    // (maxSpawnAdvanceTurns: 2000): a loud throw on overrun, never a silent hang.
    const maxSpawnTicks =
      options.maxSpawnTicks ?? Math.ceil(2_000 / turnsPerSpawnTick);
    // Each agent's CURRENT spawn stake: the candidate of its most recent ACCEPTED
    // spawn submission. Every tick each agent's pool is rebuilt from the full base
    // pool minus OTHER agents' current stakes (spawnCandidatesAvailableTo), so a
    // relocating agent RELEASES the neighborhood it vacated. The old cumulative
    // pruning removed every submission's minSpawnDistance neighborhood from one
    // shared pool forever — including the submitter's own previous picks — which
    // exhausted a ~500-candidate pool by ~turn 125-175 of a 300-turn spawn phase
    // (4 agents, run ab-ffa4p-spawnwatch-r1): relocation froze mid-phase and the
    // converge-to-anchor settle never ran on a live pool.
    const spawnStakes = new Map<string, SpawnCandidate>();

    for (let tick = 0; tick <= maxSpawnTicks; tick += 1) {
      await options.mirror.ingest(options.messages());
      const gameState = options.mirror.gameState();
      if (gameState !== null && !gameState.inSpawnPhase()) {
        return this.records.slice(startingRecordCount);
      }
      const spawnProgress =
        gameState !== null
          ? gameState.ticks() /
            Math.max(1, gameState.config().numSpawnPhaseTurns())
          : 0;
      // A spawn intent submitted now lands in the NEXT server turn, and its
      // SpawnExecution only applies while the spawn phase is still running
      // (execution tick <= numSpawnPhaseTurns). At the boundary tick
      // (ticks === numSpawnPhaseTurns) a submission would be recorded as
      // accepted but silently never execute — a dead record whose tile
      // contradicts the player's actual spawn in the replay. Keep advancing
      // to the phase end, but stop submitting intents that cannot execute,
      // so the last recorded spawn per agent IS the tile it spawned on.
      const spawnIntentCanStillExecute =
        gameState === null ||
        gameState.ticks() < gameState.config().numSpawnPhaseTurns();

      if (spawnIntentCanStillExecute) {
        for (const participant of this.options.participants) {
          const observation = this.observationBuilder.build({
            agentID: participant.runner.agentID,
            clientID: participant.runner.clientID(),
            username: participant.spec.username,
            profile: participant.spec.profile,
            gameID: this.options.game.id,
            turnNumber: gameState?.ticks() ?? 0,
            gameState: gameState ?? undefined,
            phaseOverride: "spawn",
            objective: this.objectiveManager.currentObjective(
              participant.runner.agentID,
            ),
            recentDecisions: this.recentDecisionsFor(participant),
          });
          const availableCandidates = this.spawnCandidatesAvailableTo(
            participant.runner.agentID,
            spawnStakes,
          );
          const legalActions = this.legalActionBuilder.build({
            observation,
            spawnCandidates: availableCandidates,
          });
          const spawnAction = selectSpawnTile({
            spawnActions: legalActions,
            profile: participant.spec.profile,
            gameID: this.options.game.id,
            agentID: participant.runner.agentID,
            tick,
            spawnProgress,
          });
          if (spawnAction === undefined) {
            continue;
          }
          this.submitAndRecordSpawn({
            participant,
            observation,
            legalActions,
            spawnAction,
            spawnStakes,
          });
        }
      }

      this.options.game.advanceTurnsForTesting(turnsPerSpawnTick);
    }

    throw new Error(
      `runSpawnPhase did not reach the active phase after ${maxSpawnTicks} spawn ticks`,
    );
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
    // Eliminated seats are not polled at all: no observation build, no brain
    // call, no decision record. Roster-shaped outputs (results.scores,
    // players[], the spectator roster) are built from the full participants
    // list elsewhere and stay full-length.
    const activeParticipants = this.options.participants.filter(
      (participant) => !this.seatEliminated(participant, options.gameState),
    );
    // Deal clock: advances the decision step, expires lapsed proposals, and
    // judges the previous step's audited records BEFORE observations are
    // built, so proposals made at step N become visible at N+1 and
    // acceptances at N+1 are judged from N+2 (same-step actions can never
    // retroactively fulfill or violate).
    this.dealManager?.beginDecisionStep({
      turnNumber: options.turnNumber ?? 0,
      gameState: options.gameState,
      records: this.records,
    });
    const decisionInputs = activeParticipants.map((participant) => {
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
      // Bilateral deals block (flag-gated; undefined leaves the observation
      // object untouched, byte-identical to shipped behavior). Privacy: the
      // manager returns only this seat's own proposals and deals.
      const dealsView = this.dealManager?.observationFor({
        agentID: participant.runner.agentID,
        observation: baseObservation,
      });
      const dealAwareObservation: AgentObservation =
        dealsView === undefined
          ? baseObservation
          : { ...baseObservation, deals: dealsView };
      const legalActions = this.filterDisabledActionKinds(
        this.legalActionBuilder.build({
          observation: dealAwareObservation,
          spawnCandidates: turnSpawnCandidates,
        }),
      );
      const objective = this.objectiveManager.objectiveFor({
        agentID: participant.runner.agentID,
        profile: participant.spec.profile,
        observation: dealAwareObservation,
        legalActions,
        turnNumber: dealAwareObservation.turnNumber,
      });
      const observation: AgentObservation = {
        ...dealAwareObservation,
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
      const { participant, observation } = input;
      const originalDecision = input.decision;
      const originalRequestedActionIDs =
        requestedDecisionActionIDs(originalDecision);
      const offeredActionIDs = new Set(
        input.legalActions.map((action) => action.id),
      );
      const submissionActionIDs = new Set(
        submissionLegalActions.map((action) => action.id),
      );
      const withdrawnRequestedActionIDs = originalRequestedActionIDs.filter(
        (actionID) =>
          offeredActionIDs.has(actionID) && !submissionActionIDs.has(actionID),
      );
      const submissionSetNarrowed = legalActionSetsDiffer(
        input.legalActions,
        submissionLegalActions,
      );

      let decision = originalDecision;
      let decisionLatencyMs = input.decisionLatencyMs;
      let offerRetryCount = 0;
      let offerRetryLatencyMs = 0;
      let selection = selectRequestedDecisionActions(
        decision,
        submissionLegalActions,
        this.decisionValidator,
      );

      // Brains are first called in parallel against a common per-seat offer.
      // Roster-order reservations can withdraw an action before that seat is
      // submitted. Only that offer/submit race earns one re-call. A genuinely
      // invented id was never offered and therefore never earns a retry.
      if (
        selection.selectedActions.length === 0 &&
        withdrawnRequestedActionIDs.length > 0
      ) {
        const retryStartedAt = Date.now();
        const firstAttemptTimedOut =
          originalDecision.metadata?.brainTimedOut === true;
        const retryDecision = firstAttemptTimedOut
          ? await decideWithTimeoutSafeLocalFallback({
              fallbackProfile: participant.spec.profile,
              observation,
              legalActions: submissionLegalActions,
            })
          : await decideWithSafetyFallback({
              brain: participant.brain,
              fallbackProfile: participant.spec.profile,
              observation,
              legalActions: submissionLegalActions,
              maxDecisionMs: options.maxDecisionMs,
            });
        offerRetryLatencyMs = Date.now() - retryStartedAt;
        decisionLatencyMs += offerRetryLatencyMs;
        offerRetryCount = 1;
        decision = mergeDecisionAttempts({
          firstDecision: originalDecision,
          retryDecision,
          retryMode: firstAttemptTimedOut
            ? "local-timeout-fallback"
            : "brain-retry",
        });
        selection = selectRequestedDecisionActions(
          decision,
          submissionLegalActions,
          this.decisionValidator,
        );
      }

      const { requestedActionIDs, rejectedActionIDs, selectedActions } =
        selection;

      let validationFallbackUsed = false;
      if (selectedActions.length === 0) {
        const validation = this.decisionValidator(
          decision,
          submissionLegalActions,
        );
        const action = actionFromValidation(validation);
        // The policy's requested action id(s) were all invalid; the validator
        // substituted a fallback (hold). Record it loudly (below) instead of
        // letting it read as a healthy hold.
        validationFallbackUsed = !validation.ok;
        selectedActions.push({
          action,
          requestedActionID: decision.actionID,
          reason: decisionReason(decision, validation, action),
        });
      }

      selectedActions.forEach((selected, batchIndex) => {
        const primaryBatchRecord = batchIndex === 0;
        const batchDecision: AgentDecision = {
          ...decision,
          actionID: selected.requestedActionID,
          metadata: batchDecisionMetadata({
            metadata: decision.metadata,
            batchIndex,
            batchSize: selectedActions.length,
            requestedActionIDs,
            rejectedActionIDs,
            validationFallbackUsed: validationFallbackUsed && batchIndex === 0,
            ...(submissionSetNarrowed
              ? {
                  originalRequestedActionIDs,
                  withdrawnRequestedActionIDs,
                  ...(primaryBatchRecord
                    ? { offerRetryCount, offerRetryLatencyMs }
                    : {}),
                }
              : {}),
          }),
        };
        // Structured-deal meta-actions are processed by the runner-scoped
        // deal manager during this same sequential submission pass
        // (participant order — earlier submissions win conflicts); they
        // submit no game intent. Pending referee/lifecycle events drain onto
        // this agent's next record as the dealComplianceEvent stamp. Flag
        // OFF: dealManager is null and this whole block is inert, leaving
        // records byte-identical.
        const dealOutcome =
          this.dealManager !== null &&
          selected.action !== null &&
          isDealActionKind(selected.action.kind)
            ? this.dealManager.applyDealAction({
                agentID: participant.runner.agentID,
                playerID: observation.ownState?.playerID ?? null,
                playerName:
                  observation.ownState?.name ?? participant.spec.username,
                action: selected.action,
                turnNumber: observation.turnNumber,
              })
            : null;
        const complianceStamp =
          this.dealManager?.takePendingComplianceStamp(
            participant.runner.agentID,
          ) ?? null;
        const dealMetadata: AgentDecision["metadata"] = {
          ...(dealOutcome?.stamps ?? {}),
          ...(complianceStamp !== null
            ? { dealComplianceEvent: complianceStamp }
            : {}),
        };
        const recordedDecision =
          Object.keys(dealMetadata).length === 0
            ? batchDecision
            : {
                ...batchDecision,
                metadata: { ...batchDecision.metadata, ...dealMetadata },
              };
        const result =
          dealOutcome !== null
            ? dealOutcome.result
            : selected.action
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
          legalActions: input.legalActions,
          ...(submissionSetNarrowed ? { submissionLegalActions } : {}),
          ...(submissionSetNarrowed
            ? {
                originalRequestedActionIDs,
                withdrawnRequestedActionIDs,
                ...(primaryBatchRecord
                  ? { offerRetryCount, offerRetryLatencyMs }
                  : {}),
              }
            : {}),
          chosenAction: selected.action,
          decision: recordedDecision,
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
          submissionLegalActionIDs: record.submissionLegalActionIDs,
          originalRequestedActionIDs: record.originalRequestedActionIDs,
          withdrawnRequestedActionIDs: record.withdrawnRequestedActionIDs,
          offerRetryCount: record.offerRetryCount,
          offerRetryLatencyMs: record.offerRetryLatencyMs,
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

    let validationFallbackUsed = false;
    if (selectedActions.length === 0) {
      const validation = this.decisionValidator(input.decision, input.legalActions);
      const action = actionFromValidation(validation);
      // The policy's requested action id(s) were all invalid; the validator
      // substituted a fallback (hold). Record it loudly (below).
      validationFallbackUsed = !validation.ok;
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
          validationFallbackUsed: validationFallbackUsed && batchIndex === 0,
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

  /**
   * A seat stops being polled once its core player is dead — isAlive() ===
   * false, i.e. zero owned tiles, the same rule the simulation itself uses
   * (PlayerImpl.isAlive). Hosted Coworld episodes previously polled every
   * seat every decision step regardless (12p ereq_f5ac00e9: two eliminated
   * keystone seats received 119/99 ghost "own=0 tiles" decision turns),
   * burning pod CPU and polluting decisions.jsonl. Liveness is recomputed
   * from the CURRENT snapshot every turn — never latched — so a tile-less
   * player whose transport boat is still en route resumes being polled if
   * the landing revives them. Deliberately conservative guards: no snapshot,
   * spawn phase, unresolvable player, or a NEVER-spawned player all keep the
   * seat polled — a seat that failed to enter the game should stay loud in
   * decisions.jsonl, not silently vanish.
   */
  private seatEliminated(
    participant: AgentParticipant,
    gameState: Game | undefined,
  ): boolean {
    if (gameState === undefined || gameState.inSpawnPhase()) {
      return false;
    }
    const clientID = participant.runner.clientID();
    if (clientID === null) {
      return false;
    }
    const player = gameState.playerByClientID(clientID);
    if (player === null || !player.hasSpawned()) {
      return false;
    }
    if (player.isAlive()) {
      if (this.eliminatedSeatsAnnounced.delete(participant.runner.agentID)) {
        this.log.info("league seat revived; decision polling resumed", {
          agentID: participant.runner.agentID,
          username: participant.spec.username,
          tick: gameState.ticks(),
        });
      }
      return false;
    }
    if (!this.eliminatedSeatsAnnounced.has(participant.runner.agentID)) {
      this.eliminatedSeatsAnnounced.add(participant.runner.agentID);
      this.log.info("league seat eliminated; decision polling stopped", {
        agentID: participant.runner.agentID,
        username: participant.spec.username,
        profile: participant.spec.profile,
        tick: gameState.ticks(),
      });
    }
    return true;
  }

  private submitLegalAction(
    runner: AgentRunner,
    action: LegalAction,
  ): AgentActionResult {
    if (action.intent === null) {
      // Meta-actions submit no game intent; the reason derives from the
      // action kind so any intent:null kind reports itself accurately. For
      // `hold` this is the exact historical string "hold action selected; no
      // game intent submitted" — byte-identical for existing consumers.
      // (Deal meta-actions never reach here: the submission pass routes them
      // through the deal manager, whose outcome reason names the deal.)
      return {
        accepted: true,
        reason: `${action.kind} action selected; no game intent submitted`,
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

  /**
   * Force-resolve the structured-deal ledger at match end: judges the final
   * step's audited records, then drives every open proposal and pending
   * obligation to a terminal state (spec: every accepted obligation reaches a
   * terminal state by match end). No-op when the flag is off. Idempotent.
   */
  finalizeDeals(input: { gameState?: Game } = {}): void {
    this.dealManager?.finalize({
      gameState: input.gameState,
      records: this.records,
    });
  }

  /** Full deal-ledger snapshot (operator/test surface); empty when flag off. */
  dealLedger(): AgentDealLedgerSnapshot {
    return this.dealManager?.ledgerSnapshot() ?? { deals: [], events: [] };
  }

  private submitAndRecordSpawn(input: {
    participant: AgentParticipant;
    observation: AgentObservation;
    legalActions: LegalAction[];
    spawnAction: LegalAction;
    spawnStakes: Map<string, SpawnCandidate>;
  }): void {
    // A synthetic, deterministic (non-LLM) spawn decision. The metadata flags keep it OUT
    // of the LLM-aliveness count (rawProviderOutputPresent:false) and the external-brain-
    // cleanliness external-call count (externalPlannerCall/externalActionCall:false); the
    // chosen tile is always a legal buildSpawnCandidates tile, so the submit is accepted
    // and rejectedIntents stays 0.
    const decision: AgentDecision = {
      actionID: input.spawnAction.id,
      reason: "deterministic built-in-style spawn exploration",
      metadata: {
        brain: "deterministic-spawn",
        actionSelectionSource: "deterministic-spawn",
        externalPlannerCall: false,
        externalActionCall: false,
        rawProviderOutputPresent: false,
        spawnExploration: true,
      },
    };
    const result = this.submitLegalAction(
      input.participant.runner,
      input.spawnAction,
    );
    this.recordDecision({
      participant: input.participant,
      turnNumber: input.observation.turnNumber,
      observationSummary: this.observationBuilder.summarize(input.observation),
      observation: input.observation,
      legalActions: input.legalActions,
      chosenAction: input.spawnAction,
      decision,
      decisionLatencyMs: 0,
      reason: decision.reason,
      result,
    });
    // Replace (never accumulate) this agent's stake: submitting a new spawn tile
    // means the agent vacated its previous pick, so that neighborhood is released
    // for everyone on the next spawnCandidatesAvailableTo rebuild. Only an ACCEPTED
    // submission moves the stake — a rejected intent leaves the player's actual
    // pending spawn tile unchanged.
    const tile = input.spawnAction.metadata?.tile;
    if (result.accepted && typeof tile === "number") {
      const staked = this.options.spawnCandidates.find(
        (candidate) => candidate.tile === tile,
      );
      if (staked !== undefined) {
        input.spawnStakes.set(input.participant.runner.agentID, staked);
      }
    }
  }

  private recordDecision(input: {
    participant: AgentParticipant;
    turnNumber: number;
    observationSummary: string;
    observation: AgentObservation;
    legalActions: LegalAction[];
    submissionLegalActions?: LegalAction[];
    originalRequestedActionIDs?: string[];
    withdrawnRequestedActionIDs?: string[];
    offerRetryCount?: number;
    offerRetryLatencyMs?: number;
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
      // This is deliberately the first-brain offer, not the later roster-order
      // submission subset. Without that distinction an offered-then-withdrawn
      // LegalAction.id looked like a brain hallucination in decisions.jsonl.
      legalActionIDs: input.legalActions.map((action) => action.id),
      legalActionIDsByKind: groupLegalActionsByKind(input.legalActions),
      ...(input.submissionLegalActions !== undefined
        ? {
            submissionLegalActionIDs: input.submissionLegalActions.map(
              (action) => action.id,
            ),
            submissionLegalActionIDsByKind: groupLegalActionsByKind(
              input.submissionLegalActions,
            ),
          }
        : {}),
      ...(input.originalRequestedActionIDs !== undefined
        ? {
            originalRequestedActionIDs: boundedTelemetryActionIDs(
              input.originalRequestedActionIDs,
            ),
            originalRequestedActionIDCount:
              input.originalRequestedActionIDs.length,
          }
        : {}),
      ...(input.withdrawnRequestedActionIDs !== undefined
        ? {
            withdrawnRequestedActionIDs: boundedTelemetryActionIDs(
              input.withdrawnRequestedActionIDs,
            ),
            withdrawnRequestedActionIDCount:
              input.withdrawnRequestedActionIDs.length,
          }
        : {}),
      ...(input.offerRetryCount !== undefined
        ? { offerRetryCount: input.offerRetryCount }
        : {}),
      ...(input.offerRetryLatencyMs !== undefined
        ? { offerRetryLatencyMs: input.offerRetryLatencyMs }
        : {}),
      attackActionIDs: input.legalActions
        .filter((action) => action.kind === "attack")
        .map((action) => action.id),
      chosenActionID: input.chosenAction?.id ?? input.decision.actionID,
      chosenActionKind: input.chosenAction?.kind ?? "hold",
      reason: input.reason,
      // Trim the heavy raw-LLM debug blobs (prompt + raw model/planner output)
      // BEFORE retaining the record in this.records[]. They are the dominant
      // turn-linear memory growth driving the long-game OOM (AGENT-01) and are
      // never read back as full strings — only the structured flags, sources,
      // scores, and lengths the report/replay/result exporters need are kept.
      decisionMetadata: compactDecisionMetadata(input.decision.metadata),
      chosenActionMetadata: input.chosenAction?.metadata,
      // tacticalAffordances is the single largest record field on World
      // (~8 KB, ~60-77% of the record). The Coworld path opts out (see
      // retainTacticalAffordances) to keep long-episode heap flat; local eval
      // keeps it for the behavior-quality report. Skipping also avoids the
      // per-decision build cost. It never feeds the decision, only the record.
      tacticalAffordances: this.retainTacticalAffordances
        ? buildAgentTacticalAffordances({
            observation: input.observation,
            legalActions: input.legalActions,
          })
        : undefined,
      // Compact economy facts at this decision boundary
      // (PROXYWAR_TUNE_ECONOMY_EVENTS, default OFF): the transition source for
      // spectator economy events. Tiny (counts + <=8 counterparties) so it
      // stays affordable even where tacticalAffordances is skipped; absent —
      // records byte-identical — when the flag is off or the observation
      // carries no economy snapshot.
      ...(economyEventsEnabled() && input.observation.economy !== undefined
        ? { economyFacts: economyRecordFacts(input.observation.economy) }
        : {}),
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

  /**
   * The effective minimum spawn-tile separation enforced between DIFFERENT agents'
   * current spawn stakes (the constructor override or the density-derived default).
   * Exposed so harnesses/tests can verify reservation semantics without duplicating
   * the default-derivation formula.
   */
  effectiveMinSpawnDistance(): number {
    return this.minSpawnDistance;
  }

  /**
   * The spawn pool the given agent may pick from THIS tick: the full base pool minus
   * the minSpawnDistance neighborhood of every OTHER agent's current stake (its most
   * recent accepted spawn tile). Rebuilt from current stakes on every call instead of
   * cumulatively pruned, so relocation releases the vacated neighborhood — only tiles
   * agents currently hold reserve space. The agent's OWN stake is deliberately not
   * excluded from its own pool: excluding it would re-prune the agent's anchor right
   * after it settles there, forcing an oscillation away from the anchor on every
   * converge tick.
   */
  private spawnCandidatesAvailableTo(
    agentID: string,
    spawnStakes: ReadonlyMap<string, SpawnCandidate>,
  ): SpawnCandidate[] {
    const rivalStakes: SpawnCandidate[] = [];
    for (const [stakeAgentID, stake] of spawnStakes) {
      if (stakeAgentID !== agentID) {
        rivalStakes.push(stake);
      }
    }
    if (rivalStakes.length === 0) {
      return [...this.options.spawnCandidates];
    }
    return this.options.spawnCandidates.filter((candidate) =>
      rivalStakes.every(
        (stake) =>
          distanceBetweenCandidates(candidate, stake) >= this.minSpawnDistance,
      ),
    );
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

// Brain types whose THROW means the LLM specifically degraded (not just a generic
// rule fallback). A claude-cli house brain surfaces as "real-llm" via the provider
// mapping; "claude-cli" is listed defensively. Used to set llmPlannerDegraded on
// the safety fallback so degradation auditors don't under-count.
const LLM_DEGRADABLE_BRAIN_TYPES = new Set<string>([
  "real-llm",
  "codex-cli",
  "claude-cli",
  "llm",
]);
const EXTERNAL_ACTION_BRAIN_TYPES = new Set<string>([
  "real-llm",
  "codex-cli",
  "claude-cli",
  "llm",
  "external-http",
  "external-relay",
]);

class AgentBrainDecisionTimeoutError extends Error {}

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
    const brainTimedOut = error instanceof AgentBrainDecisionTimeoutError;
    const isLlmBrain = LLM_DEGRADABLE_BRAIN_TYPES.has(
      input.brain.brainType ?? "",
    );
    const externalActionCall = EXTERNAL_ACTION_BRAIN_TYPES.has(
      input.brain.brainType ?? "",
    );
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
        safetyFallbackUsed: true,
        brainTimedOut,
        // Promise.race can stop waiting but cannot cancel an arbitrary brain
        // promise. Keep that residual overlap risk loud for later-turn audits.
        ...(brainTimedOut
          ? { timedOutBrainCallMayStillBeInFlight: true }
          : {}),
        externalActionCall,
        fallbackUsed: true,
        // An LLM-backed brain that THREW degraded the LLM specifically — flag it
        // so auditors keyed on llmPlannerDegraded (Coworld result contract, the
        // behavior report) don't under-count it as a plain rule fallback.
        ...(isLlmBrain ? { llmPlannerDegraded: true } : {}),
        fallbackActionID: fallbackDecision.actionID,
      },
    };
  }
}

async function decideWithTimeoutSafeLocalFallback(input: {
  fallbackProfile: AgentStrategyProfile;
  observation: AgentObservation;
  legalActions: LegalAction[];
}): Promise<AgentDecision> {
  const fallbackDecision = await new RuleAgentBrain(
    input.fallbackProfile,
  ).decide({
    observation: input.observation,
    legalActions: input.legalActions,
  });
  return {
    ...fallbackDecision,
    reason: `Timed-out brain not re-entered; narrowed local fallback: ${fallbackDecision.reason}`,
    metadata: {
      ...(fallbackDecision.metadata ?? {}),
      fallbackUsed: true,
      safetyFallbackUsed: true,
      localTimeoutFallbackUsed: true,
      brainTimedOut: false,
      externalPlannerCall: false,
      externalActionCall: false,
      rawProviderOutputPresent: false,
      fallbackActionID: fallbackDecision.actionID,
    },
  };
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
          () =>
            reject(
              new AgentBrainDecisionTimeoutError(
                `Agent brain timed out after ${timeoutMs}ms`,
              ),
            ),
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

// The LLM/planner brains attach large, unbounded raw debug strings to each
// decision's metadata: the ~95KB prompt (`llmPrompt`) plus the full, untruncated
// model responses (`llmRawOutput`, `plannerRawOutput`). Retaining those for every
// decision across a long game is the dominant turn-linear memory growth behind the
// long-game OOM (AGENT-01). This strips the heavy blobs to a sentinel + length while
// preserving every small structured field downstream report/replay/result consumers
// read (sources, parse flags, fallbackUsed / llmPlannerDegraded, scores, etc.). The
// on-disk artifact's rawLlmPrompt/rawLlmOutput/plannerRawOutput become the sentinel
// by design — the loudness flags and lengths still survive. Note `externalRawOutput`
// is deliberately NOT trimmed: its producers already truncate it to 1KB, so it is
// bounded and not an OOM driver.
const COMPACTED_RAW_SENTINEL = "[stored in artifact only]";

function compactDecisionMetadata(
  metadata: AgentDecisionRecord["decisionMetadata"],
): AgentDecisionRecord["decisionMetadata"] {
  if (metadata === undefined) {
    return metadata;
  }
  // Only act on fields still holding the heavy raw value, not an already-applied
  // sentinel, so the helper is idempotent (the live-log copies call it on records
  // that recordDecision already compacted) and the true *Length values survive.
  const needsTrim = (value: unknown): value is string =>
    typeof value === "string" && value !== COMPACTED_RAW_SENTINEL;
  const hasHeavyField =
    needsTrim(metadata.llmPrompt) ||
    needsTrim(metadata.llmRawOutput) ||
    needsTrim(metadata.plannerRawOutput);
  if (!hasHeavyField) {
    return metadata;
  }
  const compacted = { ...metadata };
  if (needsTrim(metadata.llmPrompt)) {
    compacted.llmPrompt = COMPACTED_RAW_SENTINEL;
    compacted.llmPromptLength = metadata.llmPrompt.length;
  }
  if (needsTrim(metadata.llmRawOutput)) {
    compacted.llmRawOutput = COMPACTED_RAW_SENTINEL;
    compacted.llmRawOutputLength = metadata.llmRawOutput.length;
  }
  if (needsTrim(metadata.plannerRawOutput)) {
    compacted.plannerRawOutput = COMPACTED_RAW_SENTINEL;
    compacted.plannerRawOutputLength = metadata.plannerRawOutput.length;
  }
  return compacted;
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

function selectRequestedDecisionActions(
  decision: AgentDecision,
  legalActions: LegalAction[],
  decisionValidator: typeof validateAgentDecision,
): {
  requestedActionIDs: string[];
  rejectedActionIDs: string[];
  selectedActions: Array<{
    action: LegalAction | null;
    requestedActionID: string;
    reason: string;
  }>;
} {
  const requestedActionIDs = requestedDecisionActionIDs(decision);
  const rejectedActionIDs: string[] = [];
  const selectedActions: Array<{
    action: LegalAction | null;
    requestedActionID: string;
    reason: string;
  }> = [];

  for (const actionID of requestedActionIDs) {
    const validation = decisionValidator(
      { ...decision, actionID },
      legalActions,
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

  return { requestedActionIDs, rejectedActionIDs, selectedActions };
}

type OfferRetryMode = "brain-retry" | "local-timeout-fallback";
type DecisionMetadata = NonNullable<AgentDecision["metadata"]>;

function mergeDecisionAttempts(input: {
  firstDecision: AgentDecision;
  retryDecision: AgentDecision;
  retryMode: OfferRetryMode;
}): AgentDecision {
  const first = input.firstDecision.metadata ?? {};
  const retry = input.retryDecision.metadata ?? {};
  const firstPlannerCalls = decisionAttemptCallCount(
    first,
    "externalPlannerCallCount",
    "externalPlannerCall",
  );
  const retryPlannerCalls = decisionAttemptCallCount(
    retry,
    "externalPlannerCallCount",
    "externalPlannerCall",
  );
  const firstActionCalls = decisionAttemptCallCount(
    first,
    "externalActionCallCount",
    "externalActionCall",
  );
  const retryActionCalls = decisionAttemptCallCount(
    retry,
    "externalActionCallCount",
    "externalActionCall",
  );
  const firstFallbackUsed = first.fallbackUsed === true;
  const retryFallbackUsed = retry.fallbackUsed === true;
  const firstPlannerFallbackUsed = first.plannerFallbackUsed === true;
  const retryPlannerFallbackUsed = retry.plannerFallbackUsed === true;
  const firstDegraded = first.llmPlannerDegraded === true;
  const retryDegraded = retry.llmPlannerDegraded === true;
  const firstTimedOut = first.brainTimedOut === true;
  const retryTimedOut = retry.brainTimedOut === true;
  const firstSafetyFallback = first.safetyFallbackUsed === true;
  const retrySafetyFallback = retry.safetyFallbackUsed === true;

  const metadata: DecisionMetadata = {
    ...retry,
    decisionAttemptCount: 2,
    externalPlannerCallCount: firstPlannerCalls + retryPlannerCalls,
    externalActionCallCount: firstActionCalls + retryActionCalls,
    fallbackAttemptCount:
      Number(firstFallbackUsed || firstPlannerFallbackUsed) +
      Number(retryFallbackUsed || retryPlannerFallbackUsed),
    llmPlannerDegradedAttemptCount:
      Number(firstDegraded) + Number(retryDegraded),
    timedOutAttemptCount: Number(firstTimedOut) + Number(retryTimedOut),
    offerRetryMode: input.retryMode,
    firstAttemptSelectedActionID:
      boundedTelemetryActionIDs([input.firstDecision.actionID])[0] ?? "",
    firstAttemptReason:
      boundedTelemetryText(input.firstDecision.reason) ?? "",
    firstAttemptFallbackUsed: firstFallbackUsed,
    firstAttemptPlannerFallbackUsed: firstPlannerFallbackUsed,
    firstAttemptLlmPlannerDegraded: firstDegraded,
    firstAttemptExternalPlannerCallCount: firstPlannerCalls,
    firstAttemptExternalActionCallCount: firstActionCalls,
    firstAttemptBrainTimedOut: firstTimedOut,
    firstAttemptSafetyFallbackUsed: firstSafetyFallback,
    retryAttemptFallbackUsed: retryFallbackUsed,
    retryAttemptPlannerFallbackUsed: retryPlannerFallbackUsed,
    retryAttemptLlmPlannerDegraded: retryDegraded,
    retryAttemptExternalPlannerCallCount: retryPlannerCalls,
    retryAttemptExternalActionCallCount: retryActionCalls,
    retryAttemptBrainTimedOut: retryTimedOut,
    retryAttemptSafetyFallbackUsed: retrySafetyFallback,
    retryAttemptSelectedActionID:
      boundedTelemetryActionIDs([input.retryDecision.actionID])[0] ?? "",
    retryAttemptReason:
      boundedTelemetryText(input.retryDecision.reason) ?? "",
    fallbackUsed: firstFallbackUsed || retryFallbackUsed,
    plannerFallbackUsed:
      firstPlannerFallbackUsed || retryPlannerFallbackUsed,
    llmPlannerDegraded: firstDegraded || retryDegraded,
    safetyFallbackUsed: firstSafetyFallback || retrySafetyFallback,
    brainTimedOut: firstTimedOut || retryTimedOut,
    ...(first.timedOutBrainCallMayStillBeInFlight === true ||
    retry.timedOutBrainCallMayStillBeInFlight === true
      ? { timedOutBrainCallMayStillBeInFlight: true }
      : {}),
    externalPlannerCall: firstPlannerCalls + retryPlannerCalls > 0,
    externalActionCall: firstActionCalls + retryActionCalls > 0,
    rawProviderOutputPresent:
      first.rawProviderOutputPresent === true ||
      retry.rawProviderOutputPresent === true,
    ...(first.localTimeoutFallbackUsed === true ||
    retry.localTimeoutFallbackUsed === true
      ? { localTimeoutFallbackUsed: true }
      : {}),
  };

  if (metadata.brainType === undefined && first.brainType !== undefined) {
    metadata.brainType = first.brainType;
  }

  preserveAttemptBooleans(first, retry, metadata);
  preserveAttemptFailureReasons(first, retry, metadata);
  return { ...input.retryDecision, metadata };
}

function decisionAttemptCallCount(
  metadata: DecisionMetadata,
  countKey: string,
  booleanKey: string,
): number {
  const count = metadata[countKey];
  if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
    return Math.floor(count);
  }
  return metadata[booleanKey] === true ? 1 : 0;
}

function preserveAttemptBooleans(
  first: DecisionMetadata,
  retry: DecisionMetadata,
  output: DecisionMetadata,
): void {
  for (const key of ["parseSuccess", "llmParseOk", "plannerParseOk"] as const) {
    const firstValue = first[key];
    const retryValue = retry[key];
    if (typeof firstValue === "boolean") {
      output[`firstAttempt${capitalizeMetadataKey(key)}`] = firstValue;
    }
    if (typeof retryValue === "boolean") {
      output[`retryAttempt${capitalizeMetadataKey(key)}`] = retryValue;
    }
    if (firstValue === false || retryValue === false) {
      output[key] = false;
    } else if (typeof retryValue === "boolean") {
      output[key] = retryValue;
    } else if (typeof firstValue === "boolean") {
      output[key] = firstValue;
    }
  }
}

function preserveAttemptFailureReasons(
  first: DecisionMetadata,
  retry: DecisionMetadata,
  output: DecisionMetadata,
): void {
  for (const key of [
    "brainErrorReason",
    "parseFailureReason",
    "llmParseFailureReason",
    "plannerParseFailureReason",
    "externalFailureReason",
  ] as const) {
    const firstValue = boundedTelemetryText(first[key]);
    const retryValue = boundedTelemetryText(retry[key]);
    if (firstValue !== null) {
      output[`firstAttempt${capitalizeMetadataKey(key)}`] = firstValue;
    }
    if (retryValue !== null) {
      output[`retryAttempt${capitalizeMetadataKey(key)}`] = retryValue;
    }
    if (firstValue !== null || retryValue !== null) {
      output[key] = firstValue ?? retryValue;
    }
  }
}

function capitalizeMetadataKey(key: string): string {
  return `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

const MAX_TELEMETRY_TEXT_LENGTH = 512;

function boundedTelemetryText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 32 && codePoint !== 127) {
      sanitized += character;
    }
    if (sanitized.length >= MAX_TELEMETRY_TEXT_LENGTH) {
      break;
    }
  }
  return sanitized.slice(0, MAX_TELEMETRY_TEXT_LENGTH);
}

function legalActionSetsDiffer(
  offeredActions: LegalAction[],
  submissionActions: LegalAction[],
): boolean {
  return (
    offeredActions.length !== submissionActions.length ||
    offeredActions.some(
      (action, index) => action.id !== submissionActions[index]?.id,
    )
  );
}

const MAX_TELEMETRY_ACTION_IDS = 32;
const MAX_TELEMETRY_ACTION_ID_LENGTH = 256;

function boundedTelemetryActionIDs(actionIDs: string[]): string[] {
  return actionIDs
    .slice(0, MAX_TELEMETRY_ACTION_IDS)
    .map(sanitizedTelemetryActionID);
}

function sanitizedTelemetryActionID(actionID: string): string {
  let sanitized = "";
  for (const character of actionID) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 32 && codePoint !== 127) {
      sanitized += character;
    }
    if (sanitized.length >= MAX_TELEMETRY_ACTION_ID_LENGTH) {
      break;
    }
  }
  return sanitized.slice(0, MAX_TELEMETRY_ACTION_ID_LENGTH);
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
  validationFallbackUsed?: boolean;
  originalRequestedActionIDs?: string[];
  withdrawnRequestedActionIDs?: string[];
  offerRetryCount?: number;
  offerRetryLatencyMs?: number;
}): AgentDecision["metadata"] {
  const metadata: AgentDecision["metadata"] = {
    ...(input.metadata ?? {}),
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    batchActionIDs: input.requestedActionIDs.join(","),
    batchRejectedActionIDs: input.rejectedActionIDs.join(","),
  };
  const isOfferRetryContinuation =
    input.batchIndex > 0 && metadata.decisionAttemptCount === 2;

  if (input.originalRequestedActionIDs !== undefined) {
    metadata.originalRequestedActionIDs = boundedTelemetryActionIDs(
      input.originalRequestedActionIDs,
    ).join(",");
  }
  if (input.withdrawnRequestedActionIDs !== undefined) {
    metadata.withdrawnRequestedActionIDs = boundedTelemetryActionIDs(
      input.withdrawnRequestedActionIDs,
    ).join(",");
  }
  if (input.offerRetryCount !== undefined) {
    metadata.offerRetryCount = input.offerRetryCount;
    metadata.offerRetryLatencyMs = input.offerRetryLatencyMs ?? 0;
  }

  if (input.validationFallbackUsed) {
    // Every offered action the policy selected was invalid, so the validator
    // substituted a hold. Surface it as a fallback so fallback_count and the
    // Coworld result contract never read an unusable policy as a healthy hold.
    metadata.fallbackUsed = true;
    metadata.validationFallbackUsed = true;
  }

  if (input.batchIndex > 0) {
    metadata.plannerRan = false;
    metadata.plannerLatencyMs = 0;
    metadata.plannerFallbackUsed = false;
    metadata.plannerPromptLength = 0;
    metadata.externalPlannerCall = false;
    metadata.externalActionCall = false;
    metadata.rawProviderOutputPresent = false;
    if (isOfferRetryContinuation) {
      projectOfferRetryContinuationHealth(metadata);
    }
    delete metadata.decisionAttemptCount;
    delete metadata.externalPlannerCallCount;
    delete metadata.externalActionCallCount;
    delete metadata.fallbackAttemptCount;
    delete metadata.llmPlannerDegradedAttemptCount;
    delete metadata.timedOutAttemptCount;
    delete metadata.offerRetryCount;
    delete metadata.offerRetryLatencyMs;
    delete metadata.offerRetryMode;
    if (typeof metadata.plannerRawOutput === "string") {
      metadata.plannerRawOutput = "[same planner decision as batch index 0]";
    }
  }
  return metadata;
}

function projectOfferRetryContinuationHealth(
  metadata: NonNullable<AgentDecision["metadata"]>,
): void {
  // The primary action record owns monotonic health for both attempts. A
  // continuation action must not inherit a failed first attempt after a healthy
  // retry, or Coworld's record-level fallback/degraded counts multiply it by the
  // retry batch size. Keep only the retry attempt's health on continuations.
  for (const [targetKey, retryKey] of [
    ["fallbackUsed", "retryAttemptFallbackUsed"],
    ["llmPlannerDegraded", "retryAttemptLlmPlannerDegraded"],
    ["safetyFallbackUsed", "retryAttemptSafetyFallbackUsed"],
    ["brainTimedOut", "retryAttemptBrainTimedOut"],
    ["parseSuccess", "retryAttemptParseSuccess"],
    ["llmParseOk", "retryAttemptLlmParseOk"],
    ["plannerParseOk", "retryAttemptPlannerParseOk"],
  ] as const) {
    const retryValue = metadata[retryKey];
    if (typeof retryValue === "boolean") {
      metadata[targetKey] = retryValue;
    } else {
      delete metadata[targetKey];
    }
  }

  for (const [targetKey, retryKey] of [
    ["brainErrorReason", "retryAttemptBrainErrorReason"],
    ["parseFailureReason", "retryAttemptParseFailureReason"],
    ["llmParseFailureReason", "retryAttemptLlmParseFailureReason"],
    ["plannerParseFailureReason", "retryAttemptPlannerParseFailureReason"],
    ["externalFailureReason", "retryAttemptExternalFailureReason"],
  ] as const) {
    const retryValue = metadata[retryKey];
    if (typeof retryValue === "string") {
      metadata[targetKey] = retryValue;
    } else {
      delete metadata[targetKey];
    }
  }

  if (metadata.retryAttemptBrainTimedOut === true) {
    metadata.timedOutBrainCallMayStillBeInFlight = true;
  } else {
    delete metadata.timedOutBrainCallMayStillBeInFlight;
  }
  if (metadata.offerRetryMode !== "local-timeout-fallback") {
    delete metadata.localTimeoutFallbackUsed;
  }
  if (metadata.retryAttemptFallbackUsed !== true) {
    delete metadata.fallbackActionID;
  }

  for (const key of Object.keys(metadata)) {
    if (key.startsWith("firstAttempt") || key.startsWith("retryAttempt")) {
      delete metadata[key];
    }
  }
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
