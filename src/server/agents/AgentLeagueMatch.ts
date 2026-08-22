import { Logger } from "winston";
import { Game } from "../../core/game/Game";
import {
  GAME_ID_REGEX,
  isValidGameID,
  ServerMessage,
} from "../../core/Schemas";
import { GameServer } from "../GameServer";
import {
  AgentDealManager,
  isDealActionKind,
  type AgentDealLedgerSnapshot,
} from "./AgentDealManager";
import { withDeferredDecisionTimeout } from "./AgentDecisionTimeout";
import {
  validateAgentDealDecision,
  validateAgentDecision,
  validateAgentMessageDecision,
} from "./AgentDecisionValidator";
import { economyRecordFacts } from "./AgentEconomyNetwork";
import { AgentLocalGameMirror } from "./AgentLocalGameMirror";
import {
  actionAlignsWithObjective,
  AgentObjectiveManager,
} from "./AgentObjectiveManager";
import {
  AgentObservationBuilder,
  BuildAgentObservationInput,
  ObservationBuilderLike,
} from "./AgentObservationBuilder";
import { AgentRunner } from "./AgentRunner";
import {
  selectSpawnSlots,
  validateSpawnSlotLegality,
  validateSpawnSlotUniqueness,
} from "./AgentSpawnAssignment";
import {
  AGENT_SPAWN_SELECTION_ALGORITHM_VERSION,
  AgentSpawnBallotInput,
  buildAgentSpawnPriority,
  resolveAgentSpawnSelection,
} from "./AgentSpawnSelection";
import { buildAgentTacticalAffordances } from "./AgentTacticalAffordances";
import {
  economyEventsEnabled,
  FREETEXT_INBOX_MAX_MESSAGES,
  FREETEXT_INBOX_MAX_PER_RIVAL,
  freeTextMessagesEnabled,
  structuredDealsEnabled,
} from "./AgentTunables";
import {
  AgentActionResult,
  AgentBrain,
  AgentCommunicationIntent,
  AgentCommunicationSignal,
  AgentDealSlotEvidence,
  AgentDecision,
  AgentDecisionRecord,
  AgentInboundMessage,
  AgentObservation,
  AgentSpawnSelectionEvidence,
  AgentStrategyProfile,
  agentStrategyProfiles,
  LegalAction,
  LegalActionKind,
  RecentAgentDecision,
  type AgentSpawnSelectionDefaultReason,
} from "./AgentTypes";
import {
  asPlayerReportedDegradationCause,
  MAX_WIRE_ACTIONS_PER_DECISION,
  type AgentDegradationCause,
} from "./AgentWireProtocol";
import {
  buildSpawnCandidates,
  buildSpawnLegalAction,
  LegalActionBuilder,
  SpawnCandidate,
} from "./LegalActionBuilder";
import { RuleAgentBrain } from "./RuleAgentBrain";
import {
  commanderFidelityClasses,
  type CommanderFidelityClass,
} from "./StrategicOptionExecutor";

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
  /**
   * Zero-based ordinal for this episode among repeated episodes, used by the
   * sealed spawn allocator to rotate the report-independent priority computed
   * exclusively from immutable persistent identities. No single existing
   * "episode ordinal" field exists elsewhere in this codebase (the closest
   * is a season's `eventSlots` array position) - callers running a sequence
   * of episodes on one map should pass their own zero-based position (e.g.
   * a loop counter, or an `eventSlots` index). Default 0 (single-episode /
   * non-rotating callers).
   */
  episodeIndex?: number;
  /**
   * Minimum acceptable `localLandScore` a candidate must clear before it is
   * eligible for the exact N-slot maximin menu. Default
   * `DEFAULT_SPAWN_QUALITY_FLOOR`.
   */
  spawnQualityFloor?: number;
  observationBuilder?: ObservationBuilderLike;
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
  maxDecisionMs?: number;
}

/**
 * Hard caps on the agent-controlled text the diplomacy slot may write into a
 * decision record. `dealActionID` arrives from an external seat's websocket
 * frame (the Coworld adapter caps it too, on its own side) and is stamped
 * twice — as `dealSlotRequestedID` and inside `dealSlotRejected` — so both
 * are bounded here as well: decisions.jsonl is retained for the whole
 * episode, and unbounded per-decision text is the long-episode memory class
 * the 0.1.19 work closed.
 */
const MAX_STAMPED_DEAL_ACTION_ID_LENGTH = 120;
const MAX_STAMPED_DEAL_REJECTION_LENGTH = 200;
const RECENT_COMMUNICATION_RECORD_LIMIT = 18;

interface DealSlotApplicationEvidence {
  stamps: NonNullable<AgentDecision["metadata"]>;
  evidence: AgentDealSlotEvidence;
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
      // Local/default agents also need an immutable identity: random UUIDs made
      // priority nondeterministic across repeated episodes after display names
      // stopped being an ordering key.
      persistentID: localAgentPersistentID(index),
    };
  });
}

export function createAgentParticipants(
  specs: AgentSpec[],
  log: Logger,
  options: CreateAgentParticipantsOptions = {},
): AgentParticipant[] {
  return specs.map((spec, index) => {
    // Rated/hosted callers must supply their immutable cross-episode identity.
    // Local fixtures historically omitted it; give those callers a stable,
    // name-independent seat identity instead of AgentRunner's random fallback
    // so paired deterministic simulations remain comparable.
    const persistentID = spec.persistentID ?? localAgentPersistentID(index);
    const participantSpec =
      spec.persistentID === undefined ? { ...spec, persistentID } : spec;
    return {
      spec: participantSpec,
      brain:
        options.brainFactory?.(participantSpec, index) ??
        new RuleAgentBrain(participantSpec.profile),
      runner: new AgentRunner({
        agentID: `${participantSpec.profile}-agent-${index + 1}`,
        clientID: participantSpec.clientID,
        username: participantSpec.username,
        persistentID,
        log,
        ...(options.retainTurnMessagesPrimaryOnly === true
          ? { retainTurnMessages: index === 0 }
          : {}),
      }),
    };
  });
}

function localAgentPersistentID(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

export class AgentLeagueMatchRunner {
  private readonly log: Logger;
  private readonly records: AgentDecisionRecord[] = [];
  private readonly recentCommunicationRecordsByAgentID = new Map<
    string,
    AgentDecisionRecord[]
  >();
  private readonly retainTacticalAffordances: boolean;
  private readonly observationBuilder: ObservationBuilderLike;
  private readonly legalActionBuilder: LegalActionBuilder;
  private readonly objectiveManager = new AgentObjectiveManager();
  private readonly decisionValidator: typeof validateAgentDecision;
  private readonly disabledActionKinds: Set<LegalActionKind>;
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

  /**
   * A synchronous, no-tick-loop convenience for tests/scenarios that just
   * need every participant spawned once with no live game/mirror driving
   * turns. It runs the same single sealed ranked ballot as `runSpawnPhase`.
   * There is no live snapshot here for the additional authoritative legality
   * re-check; candidate generation still performed the terrain predicates.
   */
  async runOpeningTurn(
    turnNumber = 0,
    options: Pick<RunAgentDecisionTurnOptions, "maxDecisionMs"> = {},
  ): Promise<AgentDecisionRecord[]> {
    const startingRecordCount = this.records.length;
    await this.selectSubmitAndRecordSpawns({
      turnNumber,
      maxDecisionMs: options.maxDecisionMs,
    });
    return this.records.slice(startingRecordCount);
  }

  /**
   * Select exactly N quality-floored maximin slots, offer the same exact
   * spawn LegalActions to every brain in one sealed concurrent stage, resolve
   * ranked ballots by report-independent serial dictatorship, and submit one
   * final validated action per seat. There is no reaction/reveal round,
   * relocation, retry, arrival-order power, or RuleAgentBrain fallback.
   */
  async runSpawnPhase(options: {
    mirror: AgentLocalGameMirror;
    messages: () => ServerMessage[];
    turnsPerSpawnTick?: number;
    maxSpawnTicks?: number;
    maxDecisionMs?: number;
  }): Promise<AgentDecisionRecord[]> {
    const startingRecordCount = this.records.length;
    const turnsPerSpawnTick = Math.max(1, options.turnsPerSpawnTick ?? 10);
    // Bound the loop the way the step-locked league bounds spawn advance
    // (maxSpawnAdvanceTurns: 2000): a loud throw on overrun, never a silent hang.
    const maxSpawnTicks =
      options.maxSpawnTicks ?? Math.ceil(2_000 / turnsPerSpawnTick);
    let submitted = false;

    for (let tick = 0; tick <= maxSpawnTicks; tick += 1) {
      await options.mirror.ingest(options.messages());
      const gameState = options.mirror.gameState();
      if (gameState !== null && !gameState.inSpawnPhase()) {
        if (!submitted) {
          throw new Error(
            "runSpawnPhase: left the spawn phase before sealed spawn selection could be submitted",
          );
        }
        return this.records.slice(startingRecordCount);
      }
      if (!submitted && gameState !== null) {
        await this.selectSubmitAndRecordSpawns({
          turnNumber: gameState.ticks(),
          gameState,
          maxDecisionMs: options.maxDecisionMs,
        });
        submitted = true;
      }
      this.options.game.advanceTurnsForTesting(turnsPerSpawnTick);
    }

    // Diagnose before giving up. The generic "did not reach the active phase" is
    // technically true and practically useless: the overwhelmingly common cause is
    // that the game never produced start info at all, so the mirror never received a
    // `start` message and has no state to leave the spawn phase WITH. `GameServer`
    // logs that failure and returns, which is the right call in production - a
    // player-supplied field can fail that schema, and hanging one game beats throwing
    // through a worker that is serving others - but in a local harness it surfaces
    // here, ${maxSpawnTicks} ticks later, pointing at the wrong thing. It cost one
    // debugging session already (2026-08-17).
    if (options.mirror.gameState() === null) {
      const gameID = this.options.game.id;
      throw new Error(
        `runSpawnPhase: the mirror never received a \`start\` message, so no game state ` +
          `ever existed (after ${maxSpawnTicks} spawn ticks). The game did not produce ` +
          `start info.` +
          (isValidGameID(gameID)
            ? ` The game id ${JSON.stringify(gameID)} is valid, so look for another ` +
              `GameStartInfoSchema failure - GameServer.start() logs it as "Error parsing ` +
              `game start info".`
            : ` Its id ${JSON.stringify(gameID)} (${gameID.length} chars) fails ` +
              `GAME_ID_REGEX (${GAME_ID_REGEX.source}), which makes GameStartInfoSchema ` +
              `reject the start info and GameServer.start() return without sending a start ` +
              `message. Use an 8-character alphanumeric id.`),
      );
    }
    throw new Error(
      `runSpawnPhase did not reach the active phase after ${maxSpawnTicks} spawn ticks`,
    );
  }

  async runDecisionTurn(
    options: RunAgentDecisionTurnOptions = {},
  ): Promise<AgentDecisionRecord[]> {
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
    const buildDecisionInputs = () =>
      activeParticipants.map((participant) => {
        const recentCommunications = this.recentCommunicationSignalsFor(
          participant,
          options.gameState,
        );
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
          ...(recentCommunications.length > 0 ? { recentCommunications } : {}),
        };
        const builtObservation =
          this.observationBuilder.build(observationInput);
        // Free-text inbox (flag-gated; identity when off). Injected BEFORE the
        // menu is built so message recipients can be ranked by who just wrote
        // to this seat. Privacy: only messages addressed to THIS seat.
        const baseObservation = this.withInboundMessages(builtObservation);
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
        const observationSummary =
          this.observationBuilder.summarize(observation);
        // Resolve the primary-slot contract from the local brain implementation
        // and this server-built observation/menu BEFORE dispatch. Model JSON,
        // wire fields, decision metadata, and runtime attribution have no
        // authority over it. Brains without this capability retain the
        // documented legacy deal-primary contract.
        const primaryActionPolicy =
          participant.brain.primaryActionValidationPolicy?.({
            observation,
            legalActions,
          }) ?? "legacy-deal-compatible";
        // Dispatch only after this seat's complete observation and menu exist.
        // The batch remains synchronous even though its result carries Promises.
        assertInnerDecisionTimeoutBelowOuter(
          participant.brain,
          options.maxDecisionMs,
        );
        const decisionPromise = dispatchBrainDecision({
          brain: participant.brain,
          observation,
          legalActions,
        });
        return {
          participant,
          observation,
          observationSummary,
          legalActions,
          primaryActionPolicy,
          decisionPromise,
        };
      });
    const decisionInputs = this.observationBuilder.withObservationBatch(
      options.gameState,
      buildDecisionInputs,
    );

    const decisions = await Promise.all(
      decisionInputs.map(async (input) => {
        // Preserve the existing metric and timeout origin: both begin only
        // after every seat's observation has left the synchronous batch.
        const decisionStartedAt = Date.now();
        const decision = await decideWithSafetyFallback({
          brain: input.participant.brain,
          fallbackProfile: input.participant.spec.profile,
          observation: input.observation,
          legalActions: input.legalActions,
          decisionPromise: input.decisionPromise,
          maxDecisionMs: options.maxDecisionMs,
        });
        return {
          ...input,
          decision,
          decisionLatencyMs: Date.now() - decisionStartedAt,
        };
      }),
    );

    const sameTurnDiplomacyParticipants = new Set<string>();
    const sameTurnAllianceRequests = new Set<string>();
    const sameTurnBuildTiles: number[] = [];

    // Batch-layer round-robin submission (A1,B1,…,A2,B2,…): each participant's
    // batch is validated ONCE, at its layer-0 slot — the exact point the old
    // participant-major pass validated it, so all-scalar play stays
    // byte-identical — then one action per participant per layer submits in
    // fixed roster order. "Earlier submission wins" now holds within every
    // layer instead of one seat's whole batch preempting the next seat's
    // first action.
    interface ParticipantSubmission {
      input: (typeof decisions)[number];
      /**
       * The same-turn-filtered menu snapshotted at this participant's
       * layer-0 slot: the validation authority and the menu recorded on
       * every record of the batch. Layers >= 1 re-check ONLY the two
       * same-turn filters (the staleness gate below) so conflicts that arise
       * mid-batch surface as honest accepted:false records instead of
       * vanishing.
       */
      submissionLegalActions: LegalAction[];
      selected: Array<{
        action: LegalAction | null;
        requestedActionID: string;
        reason: string | null;
      }>;
      requestedActionIDs: string[];
      droppedByCapActionIDs: string[];
      rejectedActionIDs: string[];
      validationFallbackUsed: boolean;
      actionSlotPlayedDeal: boolean;
      commanderPrimaryID: string | null;
      commanderPrimaryAccepted: boolean | null;
    }

    const validateParticipantBatch = (
      input: (typeof decisions)[number],
    ): ParticipantSubmission => {
      const submissionLegalActions = this.filterDisabledActionKinds(
        this.filterSameTurnBuildActions(
          this.filterSameTurnDiplomacyActions(
            input.legalActions,
            input.observation,
            sameTurnDiplomacyParticipants,
            sameTurnAllianceRequests,
          ),
          options.gameState,
          sameTurnBuildTiles,
        ),
      );
      const { decision } = input;
      const { actionIDs: requestedActionIDs, droppedByCapActionIDs } =
        requestedDecisionActionIDs(decision);
      const rejectedActionIDs: string[] = [];
      const selectedActions: Array<{
        action: LegalAction | null;
        requestedActionID: string;
        reason: string | null;
      }> = [];

      for (const actionID of requestedActionIDs) {
        const actionDecision: AgentDecision = { ...decision, actionID };
        const validation = this.decisionValidator(
          actionDecision,
          submissionLegalActions,
          { primaryActionPolicy: input.primaryActionPolicy },
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

      const commanderFidelities = commanderBatchFidelities(decision.metadata);
      const commanderPrimary =
        typeof decision.actionID === "string" &&
        commanderFidelities.get(decision.actionID) === "aligned_primary"
          ? decision.actionID
          : null;
      if (
        commanderPrimary !== null &&
        !selectedActions.some(
          (entry) => entry.requestedActionID === commanderPrimary,
        )
      ) {
        // A support action has no independent authority. If the plan primary
        // failed exact-id validation, discard every otherwise-valid support
        // layer and route the whole Commander decision through the existing
        // validator hold fallback.
        for (const entry of selectedActions) {
          if (!rejectedActionIDs.includes(entry.requestedActionID)) {
            rejectedActionIDs.push(entry.requestedActionID);
          }
        }
        selectedActions.length = 0;
      }

      let validationFallbackUsed = false;
      if (selectedActions.length === 0) {
        const validation = this.decisionValidator(
          decision,
          submissionLegalActions,
          { primaryActionPolicy: input.primaryActionPolicy },
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

      // Did the ACTION slot already play a deal meta-action this decision?
      // If so the deal slot is refused outright — not just for the same id.
      // Two deal actions in one decision would collide on the SAME record
      // stamp keys (dealAction/dealID/dealPublicText/dealStatedReason), so
      // the second silently overwrites the first: the record would name an
      // action that never happened and the overwritten deal's story beat
      // (e.g. the pact's deal_accepted, tone pact) would never reach
      // spectator telemetry while the pact itself was live. One deal action
      // per decision — the contract the player protocol states. Computed over
      // the WHOLE validated batch upfront (a deal at any layer refuses the
      // slot); safe under the staleness gate because deal meta-actions pass
      // both same-turn filters by construction and always execute.
      const actionSlotPlayedDeal = selectedActions.some(
        (entry) => entry.action !== null && isDealActionKind(entry.action.kind),
      );

      return {
        input,
        submissionLegalActions,
        selected: selectedActions,
        requestedActionIDs,
        droppedByCapActionIDs,
        rejectedActionIDs,
        validationFallbackUsed,
        actionSlotPlayedDeal,
        commanderPrimaryID: commanderPrimary,
        commanderPrimaryAccepted: null,
      };
    };

    const submitBatchEntry = (
      submission: ParticipantSubmission,
      selected: ParticipantSubmission["selected"][number],
      batchIndex: number,
    ): void => {
      const { input } = submission;
      const { participant, observation, decision, decisionLatencyMs } = input;
      const {
        submissionLegalActions,
        requestedActionIDs,
        rejectedActionIDs,
        droppedByCapActionIDs,
        validationFallbackUsed,
        actionSlotPlayedDeal,
      } = submission;
      const batchDecision: AgentDecision = {
        ...decision,
        actionID: selected.requestedActionID,
        metadata: batchDecisionMetadata({
          metadata: decision.metadata,
          requestedActionID: selected.requestedActionID,
          batchIndex,
          batchSize: submission.selected.length,
          requestedActionIDs,
          rejectedActionIDs,
          droppedByCapActionIDs,
          validationFallbackUsed: validationFallbackUsed && batchIndex === 0,
        }),
      };
      // Staleness gate (layers >= 1 only): re-run the two same-turn filters
      // over just this action against the reservations accumulated since this
      // batch validated at layer 0 — including this participant's OWN earlier
      // layers, which closes the old self-batch double-build gap. At layer 0
      // the reservation state is identical to the validation state one step
      // earlier, so the gate is skipped and scalar play is untouched. A gated
      // entry records accepted:false with the conflict named and reserves
      // nothing (a phantom reservation would poison later layers).
      const selectedCommanderFidelity = commanderBatchFidelities(
        decision.metadata,
      ).get(selected.requestedActionID);
      let staleReason: string | null =
        selectedCommanderFidelity === "aligned_support" &&
        submission.commanderPrimaryAccepted !== true
          ? `commander support blocked: primary ${submission.commanderPrimaryID ?? "unknown"} was not accepted`
          : null;
      if (staleReason === null && batchIndex > 0 && selected.action !== null) {
        const action = selected.action;
        if (
          this.filterSameTurnDiplomacyActions(
            [action],
            observation,
            sameTurnDiplomacyParticipants,
            sameTurnAllianceRequests,
          ).length === 0
        ) {
          staleReason = `same-turn diplomacy conflict: a party to ${action.id} already engaged in diplomacy this decision step`;
        } else if (
          this.filterSameTurnBuildActions(
            [action],
            options.gameState,
            sameTurnBuildTiles,
          ).length === 0
        ) {
          staleReason = `same-turn build conflict: ${action.id} targets a tile within structure range of one reserved earlier this decision step`;
        }
      }
      // Structured-deal meta-actions are processed by the runner-scoped
      // deal manager during this same sequential submission pass (layer
      // round-robin — earlier participants win conflicts within each layer);
      // they submit no game intent. Pending referee/lifecycle events drain
      // onto this agent's next record as the dealComplianceEvent stamp. Flag
      // OFF: dealManager is null and this whole block is inert, leaving
      // records byte-identical. A stale-gated entry never reaches the deal
      // manager (uniformity guard — deal actions cannot actually go stale).
      const dealOutcome =
        staleReason === null &&
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
              statedReason: decision.reason,
            })
          : null;
      const result =
        staleReason !== null
          ? {
              accepted: false,
              reason: staleReason,
              submittedIntent: null,
            }
          : dealOutcome !== null
            ? dealOutcome.result
            : selected.action
              ? this.submitLegalAction(participant.runner, selected.action)
              : {
                  accepted: false,
                  reason: "no legal fallback action available",
                  submittedIntent: null,
                };
      if (selected.requestedActionID === submission.commanderPrimaryID) {
        submission.commanderPrimaryAccepted = result.accepted;
      }
      // Diplomacy slot: the OPTIONAL second selection, applied exactly once
      // per decision (at batch index 0, i.e. at this agent's layer-0 slot in
      // the round-robin — before any participant's layer-1 action) so the
      // "earlier submission wins" conflict rule between agents is unchanged
      // and a deal never costs the agent its move. Flag OFF (or no
      // dealActionID): null, leaving records byte-identical.
      const dealSlotApplication =
        batchIndex === 0
          ? this.applyDealSlotSelection({
              participant,
              observation,
              decision,
              legalActions: submissionLegalActions,
              actionSlotPlayedDeal,
            })
          : null;
      // Comms slot: applied on the same layer-0 pass as the diplomacy slot, so
      // talking costs neither the game action nor the deal action.
      const commsSlotStamps =
        batchIndex === 0
          ? this.applyCommsSlotSelection({
              participant,
              observation,
              decision,
              legalActions: submissionLegalActions,
            })
          : null;
      const complianceStamp =
        this.dealManager?.takePendingComplianceStamp(
          participant.runner.agentID,
        ) ?? null;
      const commanderResultMetadata = commanderPostResultMetadata({
        fidelity: selectedCommanderFidelity,
        accepted: result.accepted,
        supportBlocked:
          selectedCommanderFidelity === "aligned_support" &&
          staleReason?.startsWith("commander support blocked:") === true,
      });
      const dealMetadata: AgentDecision["metadata"] = {
        ...commanderResultMetadata,
        ...(dealOutcome?.stamps ?? {}),
        ...(dealSlotApplication?.stamps ?? {}),
        ...(commsSlotStamps ?? {}),
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
      const record = this.recordDecision({
        participant,
        turnNumber: observation.turnNumber,
        observationSummary: input.observationSummary,
        observation,
        legalActions: submissionLegalActions,
        chosenAction: selected.action,
        decision: recordedDecision,
        decisionLatencyMs,
        reason: selected.reason,
        result,
        dealSlotEvidence: dealSlotApplication?.evidence,
      });
      if (
        validationFallbackUsed &&
        batchIndex === 0 &&
        submission.commanderPrimaryID !== null
      ) {
        participant.brain.onActionResult?.({
          decision,
          requestedActionID: submission.commanderPrimaryID,
          result: {
            accepted: false,
            reason: "Commander primary rejected by exact-id validation",
            submittedIntent: null,
          },
        });
      } else if (selected.requestedActionID === submission.commanderPrimaryID) {
        participant.brain.onActionResult?.({
          decision,
          requestedActionID: selected.requestedActionID,
          result,
        });
      }

      // A gated action never executed — reserving it would poison later
      // layers with phantom reservations. Engine-rejected submissions still
      // reserve, exactly as before.
      if (staleReason === null) {
        this.reserveSameTurnDiplomacy(
          selected.action,
          observation,
          sameTurnDiplomacyParticipants,
          sameTurnAllianceRequests,
        );
        this.reserveSameTurnBuild(selected.action, sameTurnBuildTiles);
      }

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
    };

    // The round-robin driver. Layer 0 both validates (at the exact point the
    // old pass validated each participant) and submits; later layers submit
    // one action per participant until every batch is exhausted. All-scalar
    // decisions have one layer, so the driver degenerates to the old
    // participant-major order exactly.
    const submissions: ParticipantSubmission[] = [];
    let maxBatchSize = 1;
    for (let layer = 0; layer < maxBatchSize; layer += 1) {
      for (let index = 0; index < decisions.length; index += 1) {
        if (layer === 0) {
          submissions[index] = validateParticipantBatch(decisions[index]);
          maxBatchSize = Math.max(
            maxBatchSize,
            submissions[index].selected.length,
          );
        }
        const submission = submissions[index];
        const selected = submission.selected[layer];
        if (selected === undefined) {
          continue;
        }
        submitBatchEntry(submission, selected, layer);
      }
    }

    return this.records.slice(startingRecordCount);
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
   * Applies the decision's OPTIONAL second selection — `dealActionID`, the
   * diplomacy slot (PROXYWAR_TUNE_STRUCTURED_DEALS). Returns the metadata
   * stamps for this decision's record, or null when there is nothing to apply
   * (flag off, or no deal selection — the shipped path, byte-identical).
   *
   * SAFETY: `validateAgentDealDecision` is the only entry point. It requires
   * an exact id match against the SAME offered menu and a deal meta-action
   * kind, so no game intent can ever be submitted through this field, and no
   * agent gets a second game action per decision. A rejected selection is
   * logged as a warning AND stamped onto the record (`dealSlotRejected`) —
   * loud in the operator artifact, dropped everywhere else, with no fallback
   * substitution.
   */
  private applyDealSlotSelection(input: {
    participant: AgentParticipant;
    observation: AgentObservation;
    decision: AgentDecision;
    legalActions: LegalAction[];
    actionSlotPlayedDeal: boolean;
  }): DealSlotApplicationEvidence | null {
    const manager = this.dealManager;
    if (manager === null) {
      return null;
    }
    const validation = validateAgentDealDecision(
      input.decision,
      input.legalActions,
    );
    if (validation === null) {
      return null;
    }
    // The requested id is agent-controlled text that lands in decisions.jsonl
    // (once here, once inside the validator's reason). Both stamps are hard-
    // capped: an unbounded id from a hostile or buggy seat would otherwise
    // write up to one websocket frame per decision into the decision log —
    // the exact long-episode memory class 0.1.19 closed.
    const requestedID = `${input.decision.dealActionID}`.slice(
      0,
      MAX_STAMPED_DEAL_ACTION_ID_LENGTH,
    );
    const rejectedStamps = (
      reason: string,
    ): NonNullable<AgentDecision["metadata"]> => {
      const capped = reason.slice(0, MAX_STAMPED_DEAL_REJECTION_LENGTH);
      this.log.warn("league agent deal selection rejected", {
        agentID: input.participant.runner.agentID,
        username: input.participant.spec.username,
        dealActionID: requestedID,
        reason: capped,
      });
      return { dealSlotRequestedID: requestedID, dealSlotRejected: capped };
    };
    if (!validation.ok) {
      const reason = validation.reason.slice(
        0,
        MAX_STAMPED_DEAL_REJECTION_LENGTH,
      );
      return {
        stamps: rejectedStamps(reason),
        evidence: {
          requestedActionID: requestedID,
          validation: { accepted: false, reason },
          application: {
            attempted: false,
            reason: "not attempted because deal-slot validation failed",
          },
        },
      };
    }
    if (input.actionSlotPlayedDeal) {
      const reason =
        "a deal action was already played as this decision's game action";
      return {
        stamps: rejectedStamps(reason),
        evidence: {
          requestedActionID: requestedID,
          validation: {
            accepted: true,
            actionID: validation.action.id,
            actionKind: validation.action.kind as Extract<
              LegalActionKind,
              `deal_${string}`
            >,
          },
          application: { attempted: false, reason },
        },
      };
    }
    const outcome = manager.applyDealAction({
      agentID: input.participant.runner.agentID,
      playerID: input.observation.ownState?.playerID ?? null,
      playerName:
        input.observation.ownState?.name ?? input.participant.spec.username,
      action: validation.action,
      turnNumber: input.observation.turnNumber,
      statedReason: input.decision.reason,
    });
    this.log.info("league agent deal slot applied", {
      agentID: input.participant.runner.agentID,
      username: input.participant.spec.username,
      dealActionID: validation.action.id,
      dealActionKind: validation.action.kind,
      accepted: outcome.result.accepted,
      reason: outcome.result.reason,
    });
    return {
      stamps: {
        ...outcome.stamps,
        // Marks a deal applied through the diplomacy slot rather than the
        // action slot: the record's `result` then belongs to the GAME action,
        // so consumers must not read deal success from it.
        dealSeparateSlot: true,
        dealSlotResult: outcome.result.reason,
      },
      evidence: {
        requestedActionID: requestedID,
        validation: {
          accepted: true,
          actionID: validation.action.id,
          actionKind: validation.action.kind as Extract<
            LegalActionKind,
            `deal_${string}`
          >,
        },
        application: {
          attempted: true,
          accepted: outcome.result.accepted,
          reason: outcome.result.reason,
        },
      },
    };
  }

  /**
   * Applies the decision's OPTIONAL third selection — the comms slot
   * (PROXYWAR_TUNE_FREETEXT_MESSAGES). Returns metadata stamps, or null when
   * there is nothing to apply (flag off, or no message selection — the shipped
   * path, byte-identical).
   *
   * SAFETY: `validateAgentMessageDecision` is the only entry point. It requires
   * an exact id match against the SAME offered menu AND the `message` kind, so
   * no game intent can reach the game through this field. The text it returns
   * is already length-, blank-, and unsafe-character-validated; this
   * method never repairs text, and a rejected message is stamped onto the
   * record and dropped with no fallback substitution.
   *
   * Delivery is deliberately one-way and inert: the message goes to the game
   * for display (so spectators can watch the negotiation) and into the
   * recipient's inbox for their NEXT decision. It creates no obligation —
   * only the structured-deal actions bind.
   */
  private applyCommsSlotSelection(input: {
    participant: AgentParticipant;
    observation: AgentObservation;
    decision: AgentDecision;
    legalActions: LegalAction[];
  }): NonNullable<AgentDecision["metadata"]> | null {
    if (!freeTextMessagesEnabled()) {
      return null;
    }
    const validation = validateAgentMessageDecision(
      input.decision,
      input.legalActions,
    );
    if (validation === null) {
      return null;
    }
    const requestedID =
      typeof input.decision.messageActionID === "string"
        ? input.decision.messageActionID.slice(
            0,
            MAX_STAMPED_DEAL_ACTION_ID_LENGTH,
          )
        : undefined;
    if (!validation.ok) {
      const reason = validation.reason.slice(
        0,
        MAX_STAMPED_DEAL_REJECTION_LENGTH,
      );
      this.log.warn("league agent message selection rejected", {
        agentID: input.participant.runner.agentID,
        username: input.participant.spec.username,
        messageActionID: requestedID,
        reason,
      });
      return {
        ...(requestedID === undefined
          ? {}
          : { commsSlotRequestedID: requestedID }),
        commsSlotRejected: reason,
      };
    }
    const recipientID = validation.action.metadata?.recipientID;
    const senderID = input.observation.ownState?.playerID ?? null;
    if (typeof recipientID !== "string" || senderID === null) {
      return {
        ...(requestedID === undefined
          ? {}
          : { commsSlotRequestedID: requestedID }),
        commsSlotRejected: "message action carried no resolvable recipient",
      };
    }
    const result = input.participant.runner.submitAgentMessage({
      recipient: recipientID,
      text: validation.text,
    });
    if (result.accepted) {
      this.deliverMessage({
        recipientPlayerID: recipientID,
        message: {
          senderID,
          senderName:
            input.observation.ownState?.name ?? input.participant.spec.username,
          text: validation.text,
          turnNumber: input.observation.turnNumber,
        },
      });
    }
    return {
      commsSlotActionID: validation.action.id,
      commsSlotRecipientID: recipientID,
      // Stamped verbatim: the negotiation evidence rests on the exact wording,
      // and the validator already bounded the length.
      commsSlotText: validation.text,
      commsSlotAccepted: result.accepted,
      commsSlotResult: result.reason.slice(
        0,
        MAX_STAMPED_DEAL_REJECTION_LENGTH,
      ),
    };
  }

  /**
   * Per-match free-text mailbox, keyed by RECIPIENT playerID. Match-scoped by
   * construction: it lives and dies with this object, so nothing carries into
   * another match and no cross-match reputation can accrete from words.
   */
  private readonly messageInbox = new Map<string, AgentInboundMessage[]>();

  private deliverMessage(input: {
    recipientPlayerID: string;
    message: AgentInboundMessage;
  }): void {
    const existing = this.messageInbox.get(input.recipientPlayerID) ?? [];
    existing.push(input.message);
    // Bound retention at the source, PER SENDER. A global FIFO trim here would
    // silently defeat `selectInboxWindow`'s per-rival fairness: one seat
    // writing every decision would own the whole mailbox and evict every other
    // rival's message before the window ever ran. Keeping a couple of windows'
    // worth per sender means a quiet counterparty is still there to be read.
    const bySender = new Map<string, AgentInboundMessage[]>();
    for (const message of existing) {
      const bucket = bySender.get(message.senderID) ?? [];
      bucket.push(message);
      bySender.set(message.senderID, bucket);
    }
    const trimmed: AgentInboundMessage[] = [];
    for (const bucket of bySender.values()) {
      trimmed.push(...bucket.slice(-FREETEXT_INBOX_MAX_PER_RIVAL * 2));
    }
    trimmed.sort(
      (a, b) =>
        a.turnNumber - b.turnNumber || a.senderID.localeCompare(b.senderID),
    );
    this.messageInbox.set(input.recipientPlayerID, trimmed);
  }

  /**
   * Returns the observation with this seat's inbox attached, or the SAME
   * object when the flag is off or the mailbox is empty — so a flag-off match
   * is byte-identical to shipped behavior.
   */
  private withInboundMessages(observation: AgentObservation): AgentObservation {
    if (!freeTextMessagesEnabled()) {
      return observation;
    }
    const playerID = observation.ownState?.playerID;
    if (playerID === undefined || playerID === null) {
      return observation;
    }
    // Only THIS seat's mailbox is ever read: privacy is the keying, not a
    // filter that could be forgotten.
    const mailbox = this.messageInbox.get(playerID);
    if (mailbox === undefined || mailbox.length === 0) {
      return observation;
    }
    return {
      ...observation,
      nonCombat: {
        ...observation.nonCombat,
        inboundMessages: selectInboxWindow(mailbox),
      },
    };
  }

  /**
   * Force-resolve the structured-deal ledger at match end: judges the final
   * step's audited records, then drives every open proposal and pending
   * obligation to a terminal state (spec: every accepted obligation reaches a
   * terminal state by match end). No-op when the flag is off. Idempotent.
   */
  finalizeDeals(input: { gameState?: Game; turnNumber?: number } = {}): void {
    this.dealManager?.finalize({
      gameState: input.gameState,
      records: this.records,
      turnNumber: input.turnNumber,
    });
  }

  /** Full deal-ledger snapshot (operator/test surface); empty when flag off. */
  dealLedger(): AgentDealLedgerSnapshot {
    return (
      this.dealManager?.ledgerSnapshot() ?? {
        finalized: false,
        finalizedAtStep: null,
        finalizedAtTurn: null,
        decisionSteps: [],
        deals: [],
        events: [],
        actionEvidence: [],
      }
    );
  }

  /** Whether the flag-gated match owns a ledger artifact at all. */
  dealLedgerEnabled(): boolean {
    return this.dealManager !== null;
  }

  private async selectSubmitAndRecordSpawns(input: {
    turnNumber: number;
    gameState?: Game;
    maxDecisionMs?: number;
  }): Promise<void> {
    const participants = this.options.participants;
    const agentIDs = participants.map(
      (participant) => participant.runner.agentID,
    );
    const slots = selectSpawnSlots(
      this.options.spawnCandidates,
      participants.length,
      { qualityFloor: this.options.spawnQualityFloor },
    );
    validateSpawnSlotUniqueness(slots, agentIDs);
    if (input.gameState !== undefined) {
      validateSpawnSlotLegality(slots, agentIDs, input.gameState);
    }
    const offeredActions = immutableSpawnMenu(slots.map(buildSpawnLegalAction));

    // Priority is fixed before a single ballot is dispatched. Immutable
    // participant ids are the only ordering key; display usernames are evidence
    // labels only. Neither renaming, mutable participant array order, nor
    // provider arrival can change allocation power.
    const priorityOrder = buildAgentSpawnPriority(
      participants.map((participant) => ({
        participantID: participant.runner.persistentID,
        username: participant.spec.username,
      })),
      this.options.episodeIndex ?? 0,
    );

    const dispatched = this.observationBuilder.withObservationBatch(
      input.gameState,
      () =>
        participants.map((participant) => {
          const observation = this.observationBuilder.build({
            agentID: participant.runner.agentID,
            clientID: participant.runner.clientID(),
            username: participant.spec.username,
            profile: participant.spec.profile,
            gameID: this.options.game.id,
            turnNumber: input.turnNumber,
            gameState: input.gameState,
            phaseOverride: "spawn",
            objective: this.objectiveManager.currentObjective(
              participant.runner.agentID,
            ),
            recentDecisions: this.recentDecisionsFor(participant),
          });
          const observationSummary =
            this.observationBuilder.summarize(observation);
          const dispatchedAt = Date.now();
          const decisionPromise = dispatchBrainDecision({
            brain: participant.brain,
            observation,
            legalActions: offeredActions,
          });
          return {
            participant,
            observation,
            observationSummary,
            dispatchedAt,
            decisionPromise,
          };
        }),
    );

    // Every decide() call above has already returned its promise before any
    // await occurs here. Promise.all preserves input identity, while the
    // allocator below ignores completion/arrival order entirely.
    const settled = await Promise.all(
      dispatched.map(async (entry) => ({
        ...entry,
        settlement: await settleSpawnBallot({
          decisionPromise: entry.decisionPromise,
          dispatchedAt: entry.dispatchedAt,
          maxDecisionMs: input.maxDecisionMs,
        }),
      })),
    );
    const assignments = resolveAgentSpawnSelection({
      offeredActions,
      priorityOrder,
      ballots: settled.map<AgentSpawnBallotInput>((entry) => ({
        participantID: entry.participant.runner.persistentID,
        username: entry.participant.spec.username,
        decision: entry.settlement.decision,
        stageLatencyMs: entry.settlement.latencyMs,
        forcedDefaultReason: entry.settlement.forcedDefaultReason,
        stageDegradationReason: entry.settlement.degradationReason,
      })),
    });
    const settledByParticipantID = new Map(
      settled.map((entry) => [entry.participant.runner.persistentID, entry]),
    );

    // Submission and record sequence follow the precommitted priority order,
    // never the response arrival order. Each assigned action is an existing
    // member of the common offered menu and is still routed through the
    // configured existing decision validator before AgentRunner/GameServer.
    for (const assignment of assignments) {
      const entry = settledByParticipantID.get(assignment.participantID);
      if (entry === undefined) {
        throw new Error(
          `sealed spawn selection lost participant ${assignment.participantID}`,
        );
      }
      this.submitAndRecordSelectedSpawn({
        participant: entry.participant,
        observation: entry.observation,
        observationSummary: entry.observationSummary,
        offeredActions,
        assignedAction: assignment.action,
        submittedDecision: assignment.decision,
        evidence: assignment.evidence,
      });
    }
  }

  /**
   * Submit one atomic final spawn assignment. The selected slot already
   * passed maximin selection and (when live) authoritative legality checks.
   * A validator or GameServer rejection is an invariant failure: retain the
   * truthful rejected record when submission was attempted, then fail loud.
   */
  private submitAndRecordSelectedSpawn(input: {
    participant: AgentParticipant;
    observation: AgentObservation;
    observationSummary: string;
    offeredActions: LegalAction[];
    assignedAction: LegalAction;
    submittedDecision: AgentDecision | null;
    evidence: AgentSpawnSelectionEvidence;
  }): void {
    const originalMetadata = spawnRecordMetadata(
      input.submittedDecision?.metadata,
    );
    const fallbackUsed = input.evidence.stageFallbackUsed;
    const topSubmittedActionID = input.evidence.submittedBallotActionIDs[0];
    const preserveSubmittedReason =
      input.evidence.ballotValid &&
      input.evidence.defaultReason === null &&
      topSubmittedActionID === input.assignedAction.id;
    const decision: AgentDecision = {
      actionID: input.assignedAction.id,
      reason: preserveSubmittedReason ? input.evidence.submittedReason : null,
      metadata: {
        ...originalMetadata,
        actionSelectionSource: AGENT_SPAWN_SELECTION_ALGORITHM_VERSION,
        spawnAssignment: true,
        spawnSelectionAlgorithm: AGENT_SPAWN_SELECTION_ALGORITHM_VERSION,
        ...(fallbackUsed
          ? {
              fallbackUsed: true,
              fallbackActionID: input.assignedAction.id,
              spawnSelectionDegradationReason:
                input.evidence.stageDegradationReason ??
                input.evidence.defaultReason ??
                "spawn selection default",
            }
          : {}),
        ...(fallbackUsed &&
        LLM_DEGRADABLE_BRAIN_TYPES.has(input.participant.brain.brainType ?? "")
          ? { llmPlannerDegraded: true }
          : {}),
        // The spawn stage has had a cause taxonomy since it was built
        // (`forcedDefaultReason`), and this vocabulary was taken FROM it - but the
        // spawn record never carried it in the shared field, so a smoke test found
        // three uncaused turn-0 fallbacks in a real episode. Map the two
        // server-observed values across; `brain-fallback` means the seat reported
        // its own degradation, so its own cause (if it sent one) is the truthful
        // value, and `invalid-ballot` is a decision-quality fault rather than a
        // brain failure and deliberately maps to nothing.
        ...(fallbackUsed
          ? spawnDegradedCause(
              input.evidence.defaultReason,
              originalMetadata.degradedCause,
            )
          : {}),
      },
    };
    const validation = this.decisionValidator(decision, input.offeredActions);
    if (
      !validation.ok ||
      validation.action.kind !== "spawn" ||
      validation.action.id !== input.assignedAction.id
    ) {
      throw new Error(
        `sealed spawn assignment failed existing decision validation for ${input.participant.runner.agentID}: ${
          validation.ok
            ? `validator returned ${validation.action.kind}:${validation.action.id}`
            : validation.reason
        }`,
      );
    }

    const result = this.submitLegalAction(
      input.participant.runner,
      validation.action,
    );
    this.recordDecision({
      participant: input.participant,
      turnNumber: input.observation.turnNumber,
      observationSummary: input.observationSummary,
      observation: input.observation,
      legalActions: input.offeredActions,
      chosenAction: validation.action,
      decision,
      decisionLatencyMs: input.evidence.stageLatencyMs,
      reason: decision.reason,
      result,
      spawnSelectionEvidence: input.evidence,
    });
    if (!result.accepted) {
      const tile =
        validation.action.intent?.type === "spawn"
          ? validation.action.intent.tile
          : "unknown";
      throw new Error(
        `runSpawnPhase: sealed spawn assignment was rejected for agent ` +
          `${input.participant.runner.agentID} at tile ${tile}: ` +
          `${result.reason}. Never falls back silently.`,
      );
    }
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
    reason: string | null;
    result: AgentActionResult;
    dealSlotEvidence?: AgentDealSlotEvidence;
    spawnSelectionEvidence?: AgentSpawnSelectionEvidence;
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
      // Trim the heavy raw-LLM debug blobs (prompt + raw model/planner output)
      // BEFORE retaining the record in this.records[]. They are the dominant
      // turn-linear memory growth driving the long-game OOM (AGENT-01) and are
      // never read back as full strings — only the structured flags, sources,
      // scores, and lengths the report/replay/result exporters need are kept.
      decisionMetadata: compactDecisionMetadata(input.decision.metadata),
      chosenActionMetadata: input.chosenAction?.metadata,
      ...(input.dealSlotEvidence !== undefined
        ? { dealSlotEvidence: input.dealSlotEvidence }
        : {}),
      ...(input.spawnSelectionEvidence !== undefined
        ? { spawnSelectionEvidence: input.spawnSelectionEvidence }
        : {}),
      // tacticalAffordances is the single largest record field on World
      // (~8 KB, ~60% of the record). The Coworld path opts out (see
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
    this.rememberCommunicationRecord(record);
    return record;
  }

  private rememberCommunicationRecord(record: AgentDecisionRecord): void {
    if (!record.result.accepted || !isCommunicationRecord(record)) {
      return;
    }
    for (const participant of this.options.participants) {
      const agentID = participant.runner.agentID;
      if (agentID === record.agentID) {
        continue;
      }
      let recentRecords = this.recentCommunicationRecordsByAgentID.get(agentID);
      if (recentRecords === undefined) {
        recentRecords = [];
        this.recentCommunicationRecordsByAgentID.set(agentID, recentRecords);
      }
      recentRecords.push(record);
      if (recentRecords.length > RECENT_COMMUNICATION_RECORD_LIMIT) {
        recentRecords.shift();
      }
    }
  }

  private recentDecisionsFor(
    participant: AgentParticipant,
  ): RecentAgentDecision[] {
    const own = this.records.filter(
      (record) => record.agentID === participant.runner.agentID,
    );
    // Window by DECISION CYCLE (turnNumber — monotonic per step), not by raw
    // record count: a batched decision writes one record per action, and a
    // record-count window would let a single 5-action batch evict most of
    // the agent's own memory. All-scalar play has one record per cycle, so
    // the last 8 cycles are exactly the last 8 records — byte-identical to
    // the old slice(-8).
    const cycleTurns: number[] = [];
    for (let i = own.length - 1; i >= 0 && cycleTurns.length < 8; i -= 1) {
      const turn = own[i].turnNumber;
      if (cycleTurns[0] !== turn) {
        cycleTurns.unshift(turn);
      }
    }
    const windowStart = cycleTurns[0];
    return own
      .filter(
        (record) =>
          windowStart !== undefined && record.turnNumber >= windowStart,
      )
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
    gameState?: Game,
  ): AgentCommunicationSignal[] {
    const clientID = participant.runner.clientID();
    const player =
      clientID && gameState ? gameState.playerByClientID(clientID) : null;
    const ownPlayerID = player?.id() ?? null;
    const visiblePlayers =
      gameState && player
        ? gameState.players().filter((other) => other.id() !== player.id())
        : [];
    return (
      this.recentCommunicationRecordsByAgentID.get(
        participant.runner.agentID,
      ) ?? []
    )
      .map((record) => {
        const metadata = record.chosenActionMetadata ?? {};
        const sender = visiblePlayers.find(
          (player) =>
            player.clientID() === record.clientID ||
            player.name() === record.username,
        );
        const recipientID = stringOrNull(metadata.recipientID);
        const recipientName = stringOrNull(metadata.recipientName);
        const targetID = stringOrNull(metadata.targetID);
        const targetName = stringOrNull(metadata.targetName);
        return {
          sequence: record.sequence,
          turnNumber: record.turnNumber,
          senderAgentID: record.agentID,
          senderPlayerID: sender?.id() ?? null,
          senderName: record.username,
          senderProfile: record.profile,
          actionKind:
            record.chosenActionKind as AgentCommunicationSignal["actionKind"],
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

/**
 * Chooses which of a seat's inbound messages appear in one observation.
 *
 * Per-rival cap FIRST, then the global cap, oldest to newest. Order matters:
 * capping globally first would let one talkative counterparty fill the whole
 * window and hide everyone else, which is both a prompt-cost problem and a
 * cheap denial-of-attention attack on a rival's decision-making.
 *
 * Pure and deterministic — same mailbox in, same window out.
 */
export function selectInboxWindow(
  mailbox: readonly AgentInboundMessage[],
): AgentInboundMessage[] {
  const perRival = new Map<string, AgentInboundMessage[]>();
  for (const message of mailbox) {
    const bucket = perRival.get(message.senderID) ?? [];
    bucket.push(message);
    perRival.set(message.senderID, bucket);
  }
  const kept: AgentInboundMessage[] = [];
  for (const bucket of perRival.values()) {
    kept.push(...bucket.slice(-FREETEXT_INBOX_MAX_PER_RIVAL));
  }
  kept.sort(
    (a, b) =>
      a.turnNumber - b.turnNumber || a.senderID.localeCompare(b.senderID),
  );
  return kept.slice(-FREETEXT_INBOX_MAX_MESSAGES);
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
  "strategic-commander",
]);

function assertInnerDecisionTimeoutBelowOuter(
  brain: AgentBrain,
  outerTimeoutMs: number | undefined,
): void {
  const innerTimeoutMs = brain.internalDecisionTimeoutMs;
  if (
    outerTimeoutMs !== undefined &&
    innerTimeoutMs !== undefined &&
    innerTimeoutMs >= outerTimeoutMs
  ) {
    throw new Error(
      `Agent brain ${brain.brainType ?? "unknown"} internal timeout ${innerTimeoutMs}ms must be below outer timeout ${outerTimeoutMs}ms`,
    );
  }
}

class AgentSpawnBallotTimeoutError extends Error {}

/**
 * Distinct marker for a DECISION that never arrived, so the degradation cause can
 * say `brain-timeout` rather than lumping it with a brain that threw. Mirrors the
 * spawn-ballot path's existing timeout/error split.
 */
class AgentDecisionTimeoutError extends Error {}

interface SettledSpawnBallot {
  decision: AgentDecision | null;
  latencyMs: number;
  forcedDefaultReason:
    | "brain-timeout"
    | "brain-error"
    | "brain-fallback"
    | null;
  degradationReason: string | null;
}

async function settleSpawnBallot(input: {
  decisionPromise: Promise<AgentDecision>;
  dispatchedAt: number;
  maxDecisionMs?: number;
}): Promise<SettledSpawnBallot> {
  try {
    const resolved =
      input.maxDecisionMs === undefined
        ? await input.decisionPromise
        : await withDeferredDecisionTimeout(
            input.decisionPromise,
            input.maxDecisionMs,
            () =>
              new AgentSpawnBallotTimeoutError(
                `Agent brain timed out after ${input.maxDecisionMs}ms`,
              ),
          ).promise;
    const decision =
      typeof resolved === "object" && resolved !== null ? resolved : null;
    if (decision === null) {
      return {
        decision: null,
        latencyMs: Date.now() - input.dispatchedAt,
        forcedDefaultReason: "brain-error",
        degradationReason: "brain returned a non-object decision",
      };
    }
    const metadata = decisionMetadataObject(decision?.metadata);
    const reportedFallback =
      metadata.fallbackUsed === true || metadata.llmPlannerDegraded === true;
    return {
      decision,
      latencyMs: Date.now() - input.dispatchedAt,
      forcedDefaultReason: reportedFallback ? "brain-fallback" : null,
      degradationReason: reportedFallback
        ? (reportedSpawnDegradation(metadata) ??
          "brain reported fallback/degradation during spawn selection")
        : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      decision: null,
      latencyMs: Date.now() - input.dispatchedAt,
      forcedDefaultReason:
        error instanceof AgentSpawnBallotTimeoutError
          ? "brain-timeout"
          : "brain-error",
      degradationReason: reason,
    };
  }
}

function dispatchBrainDecision(input: {
  brain: AgentBrain;
  observation: AgentObservation;
  legalActions: LegalAction[];
}): Promise<AgentDecision> {
  let decisionPromise: Promise<AgentDecision>;
  try {
    decisionPromise = Promise.resolve(
      input.brain.decide({
        observation: input.observation,
        legalActions: input.legalActions,
      }),
    );
  } catch (error) {
    decisionPromise = Promise.reject(error);
  }

  // A later seat can still fail while its observation is being built. Attach
  // a rejection observer immediately so an already-dispatched request cannot
  // become unhandled before the batch exits; the original promise remains
  // rejected for the post-batch safety fallback below.
  void decisionPromise.catch(() => undefined);
  return decisionPromise;
}

function immutableSpawnMenu(actions: LegalAction[]): LegalAction[] {
  const frozen = actions.map((action) =>
    Object.freeze({
      ...action,
      intent:
        action.intent === null ? null : Object.freeze({ ...action.intent }),
      risk: Object.freeze({
        ...action.risk,
        ...(action.risk.notes !== undefined
          ? { notes: Object.freeze([...action.risk.notes]) }
          : {}),
      }),
      ...(action.metadata !== undefined
        ? { metadata: Object.freeze({ ...action.metadata }) }
        : {}),
    }),
  );
  return Object.freeze(frozen) as unknown as LegalAction[];
}

function decisionMetadataObject(
  metadata: AgentDecision["metadata"] | unknown,
): NonNullable<AgentDecision["metadata"]> {
  return typeof metadata === "object" && metadata !== null
    ? (metadata as NonNullable<AgentDecision["metadata"]>)
    : {};
}

function spawnRecordMetadata(
  metadata: AgentDecision["metadata"] | unknown,
): NonNullable<AgentDecision["metadata"]> {
  const retained = { ...decisionMetadataObject(metadata) };
  // A provider's internal RuleAgentBrain fallback ballot is deliberately
  // ignored by the spawn mechanism. Do not let its action/reason read as the
  // rationale for the server's report-independent offered-order default.
  delete retained.fallbackActionID;
  delete retained.fallbackReason;
  return retained;
}

/**
 * Maps the spawn stage's existing default-reason taxonomy onto the shared
 * `degradedCause` field. Returns a spreadable object so an unmappable reason adds
 * nothing at all rather than an invented value.
 */
function spawnDegradedCause(
  defaultReason: AgentSpawnSelectionDefaultReason | null,
  playerReportedCause: unknown,
): { degradedCause?: AgentDegradationCause } {
  if (defaultReason === "brain-timeout" || defaultReason === "brain-error") {
    return { degradedCause: defaultReason };
  }
  const reported = asPlayerReportedDegradationCause(playerReportedCause);
  return reported !== undefined ? { degradedCause: reported } : {};
}

function reportedSpawnDegradation(
  metadata: NonNullable<AgentDecision["metadata"]>,
): string | null {
  for (const key of [
    "brainErrorReason",
    "externalFailureReason",
    "llmPlannerFailureReason",
    "parseFailureReason",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

async function decideWithSafetyFallback(input: {
  brain: AgentBrain;
  fallbackProfile: AgentStrategyProfile;
  observation: AgentObservation;
  legalActions: LegalAction[];
  decisionPromise: Promise<AgentDecision>;
  maxDecisionMs?: number;
}): Promise<AgentDecision> {
  try {
    return await withOptionalTimeout(
      input.decisionPromise,
      input.maxDecisionMs,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const isLlmBrain = LLM_DEGRADABLE_BRAIN_TYPES.has(
      input.brain.brainType ?? "",
    );
    // `withOptionalTimeout` is the only thing on this path that rejects with the
    // timeout marker, so this distinguishes "never answered" from "answered with
    // an exception" without parsing arbitrary provider text.
    const isDecisionTimeout = error instanceof AgentDecisionTimeoutError;
    const failureCause = isDecisionTimeout ? "brain-timeout" : "brain-error";
    const fallbackDecision = input.brain.failClosed
      ? await input.brain.failClosed({
          observation: input.observation,
          legalActions: input.legalActions,
          cause: failureCause,
          detail: reason,
        })
      : await new RuleAgentBrain(input.fallbackProfile).decide({
          observation: input.observation,
          legalActions: input.legalActions,
        });
    // 2026-08-01 P0 fix (see LlmAgentBrain.ts's fallback() for the original
    // incident): this used to fold the brain-error text into `reason` —
    // `"Agent brain failed (${reason}); fallback: ${fallbackDecision.reason}"`
    // — the same anti-pattern the LLM-provider-error incident was caused by,
    // reachable here whenever ANY brain throws (a network error, a timeout,
    // an unexpected exception) rather than returning its own fallback
    // decision. No stated reason exists on this path; the error text
    // already has its own field (`brainErrorReason`, below), and the
    // substituted brain's own genuine reason gets `metadata.fallbackReason`
    // — same convention `LlmAgentBrain.fallback()` uses.
    return {
      actionID: fallbackDecision.actionID,
      reason: null,
      metadata: {
        ...fallbackDecision.metadata,
        brainType: input.brain.brainType ?? "rule",
        brainErrorReason: reason,
        // The server's OWN observation of why this seat did not answer. Only this
        // path may stamp a `brain-*` cause: the player wire rejects that family
        // outright (asPlayerReportedDegradationCause), so a policy can never claim
        // the server failed to hear from it. Note league seats are `external-http`,
        // which LLM_DEGRADABLE_BRAIN_TYPES deliberately excludes, so for them this
        // attributes a FALLBACK rather than a `degraded_count` entry.
        degradedCause: failureCause,
        fallbackUsed: true,
        // An LLM-backed brain that THREW degraded the LLM specifically — flag it
        // so auditors keyed on llmPlannerDegraded (Coworld result contract, the
        // behavior report) don't under-count it as a plain rule fallback.
        ...(isLlmBrain ? { llmPlannerDegraded: true } : {}),
        fallbackActionID: fallbackDecision.actionID,
        fallbackReason: fallbackDecision.reason,
      },
    };
  }
}

async function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }
  return withDeferredDecisionTimeout(
    promise,
    timeoutMs,
    () =>
      new AgentDecisionTimeoutError(
        `Agent brain timed out after ${timeoutMs}ms`,
      ),
  ).promise;
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

function requestedDecisionActionIDs(decision: AgentDecision): {
  actionIDs: string[];
  droppedByCapActionIDs: string[];
} {
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
  if (deduplicated.length === 0) {
    return { actionIDs: [decision.actionID], droppedByCapActionIDs: [] };
  }
  // Wire cap: dedupe first, then truncate, so duplicates never consume
  // capacity. The cut ids are surfaced to the caller and stamped as
  // batchDroppedActionIDs — never silently discarded (the keystone drop-note
  // discipline: records must not imply actions that never ran, and drops
  // must not be invisible).
  return {
    actionIDs: deduplicated.slice(0, MAX_WIRE_ACTIONS_PER_DECISION),
    droppedByCapActionIDs: deduplicated.slice(MAX_WIRE_ACTIONS_PER_DECISION),
  };
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
  requestedActionID: string;
  batchIndex: number;
  batchSize: number;
  requestedActionIDs: string[];
  rejectedActionIDs: string[];
  droppedByCapActionIDs?: string[];
  validationFallbackUsed?: boolean;
}): AgentDecision["metadata"] {
  const metadata: AgentDecision["metadata"] = {
    ...(input.metadata ?? {}),
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    batchActionIDs: input.requestedActionIDs.join(","),
    batchRejectedActionIDs: input.rejectedActionIDs.join(","),
  };

  const commanderFidelity = commanderBatchFidelities(input.metadata).get(
    input.requestedActionID,
  );
  if (commanderFidelity !== undefined) {
    metadata.commanderFidelity = commanderFidelity;
  }

  // Stamped ONLY when the wire cap actually cut ids, so every pre-cap record
  // stays byte-identical. Honest-drop discipline: the record must show what
  // the policy asked for that will not run.
  if (
    input.droppedByCapActionIDs !== undefined &&
    input.droppedByCapActionIDs.length > 0
  ) {
    metadata.batchDroppedActionIDs = input.droppedByCapActionIDs.join(",");
  }

  if (input.validationFallbackUsed) {
    // Every offered action the policy selected was invalid, so the validator
    // substituted a hold. Surface it as a fallback so fallback_count and the
    // Coworld result contract never read an unusable policy as a healthy hold.
    metadata.fallbackUsed = true;
    metadata.validationFallbackUsed = true;
    if (commanderFidelity !== undefined) {
      metadata.commanderFidelity = "hold_plan_blocked";
      metadata.commanderBlockedReason = "validator_fallback";
      metadata.commanderImmediateReplan = true;
      metadata.planFollowed = false;
    }
  }

  if (input.batchIndex > 0) {
    metadata.plannerRan = false;
    metadata.plannerLatencyMs = 0;
    // A fallback-authored Commander PLAN remains fallback-authored for every
    // action executed under it. Later batch layers did not make another
    // planner call, but clearing this marker would corrupt plan-level
    // provenance and let support actions leak into LLM-authored metrics.
    metadata.plannerFallbackUsed =
      metadata.commanderSelectorSource === "fallback-deterministic" &&
      metadata.plannerFallbackUsed === true;
    metadata.plannerPromptLength = 0;
    metadata.externalPlannerCall = false;
    metadata.rawProviderOutputPresent = false;
    if (typeof metadata.plannerRawOutput === "string") {
      metadata.plannerRawOutput = "[same planner decision as batch index 0]";
    }
  }
  return metadata;
}

function commanderPostResultMetadata(input: {
  fidelity: CommanderFidelityClass | undefined;
  accepted: boolean;
  supportBlocked: boolean;
}): AgentDecision["metadata"] {
  if (input.fidelity === undefined || input.accepted) return {};
  const immediateReplan =
    input.fidelity === "aligned_primary" || input.supportBlocked;
  return {
    planFollowed: false,
    commanderImmediateReplan: immediateReplan,
    commanderBlockedReason: input.supportBlocked
      ? "support_blocked"
      : "engine_rejected",
  };
}

function commanderBatchFidelities(
  metadata: AgentDecision["metadata"],
): ReadonlyMap<string, CommanderFidelityClass> {
  const raw = metadata?.commanderBatchFidelities;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) {
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return new Map();
    }
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 ||
      entries.length > 5 ||
      entries.some(
        ([actionID, fidelity]) =>
          actionID.length === 0 ||
          typeof fidelity !== "string" ||
          !commanderFidelityClasses.includes(
            fidelity as CommanderFidelityClass,
          ),
      )
    ) {
      return new Map();
    }
    return new Map(entries as Array<[string, CommanderFidelityClass]>);
  } catch {
    return new Map();
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
): string | null {
  if (validation.ok) {
    return decision.reason;
  }
  const fallbackText = action ? ` fallback=${action.id}` : " no fallback";
  // `decision.reason` is `null` on an upstream fallback/failure path (no
  // stated reason to report) — omit it rather than interpolating the
  // literal string "null" into a field consumers treat as a stated reason.
  return decision.reason === null
    ? `${validation.reason};${fallbackText}`
    : `${decision.reason}; ${validation.reason};${fallbackText}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
