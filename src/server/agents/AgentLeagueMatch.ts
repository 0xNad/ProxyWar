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
import {
  validateAgentDealDecision,
  validateAgentDecision,
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
} from "./AgentObservationBuilder";
import { AgentRunner } from "./AgentRunner";
import {
  assignSpawnSlots,
  validateSpawnSlotLegality,
  validateSpawnSlotUniqueness,
} from "./AgentSpawnAssignment";
import { buildAgentTacticalAffordances } from "./AgentTacticalAffordances";
import { economyEventsEnabled, structuredDealsEnabled } from "./AgentTunables";
import { MAX_WIRE_ACTIONS_PER_DECISION } from "./AgentWireProtocol";
import {
  AgentActionResult,
  AgentBrain,
  AgentCommunicationIntent,
  AgentCommunicationSignal,
  AgentDealSlotEvidence,
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
  buildSpawnLegalAction,
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
  /**
   * Zero-based ordinal for this episode among repeated episodes reusing the
   * SAME map/candidate pool, used by `runSpawnPhase` to rotate which
   * fairness-assigned spawn slot each roster participant lands on
   * (`slots[(rosterIndex + episodeIndex) % N]`) so N same-map episodes cycle
   * every agent through every slot exactly once. No single existing
   * "episode ordinal" field exists elsewhere in this codebase (the closest
   * is a season's `eventSlots` array position) - callers running a sequence
   * of episodes on one map should pass their own zero-based position (e.g.
   * a loop counter, or an `eventSlots` index). Default 0 (single-episode /
   * non-rotating callers).
   */
  episodeIndex?: number;
  /**
   * Minimum acceptable `localLandScore` (see AgentSpawnAssignment.ts) a
   * `runSpawnPhase` slot candidate must clear before it is eligible for
   * maximin slot selection. Default `DEFAULT_SPAWN_QUALITY_FLOOR`.
   */
  spawnQualityFloor?: number;
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
  private readonly records: AgentDecisionRecord[] = [];
  private readonly retainTacticalAffordances: boolean;
  private readonly observationBuilder: AgentObservationBuilder;
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
   * turns: submits the SAME deterministic fairness assignment `runSpawnPhase`
   * uses (`assignSpawnSlots`), validated for uniqueness (there is no live
   * game snapshot available here to also re-check authoritative legality
   * against - `runSpawnPhase`, which DOES have mirror access, does that
   * additional check; this trusts the terrain-level validation
   * `buildSpawnCandidates` already performed at candidate-generation time).
   * `maxDecisionMs` is accepted only for call-site source compatibility and
   * is unused: no brain is ever consulted for a spawn decision here or
   * anywhere else in this runner.
   */
  async runOpeningTurn(
    turnNumber = 0,
    _options: Pick<RunAgentDecisionTurnOptions, "maxDecisionMs"> = {},
  ): Promise<AgentDecisionRecord[]> {
    const startingRecordCount = this.records.length;
    const agentIDs = this.options.participants.map(
      (participant) => participant.runner.agentID,
    );
    const assignment = assignSpawnSlots({
      candidates: this.options.spawnCandidates,
      participantCount: this.options.participants.length,
      episodeIndex: this.options.episodeIndex ?? 0,
      qualityFloor: this.options.spawnQualityFloor,
    });
    validateSpawnSlotUniqueness(assignment, agentIDs);
    for (let i = 0; i < this.options.participants.length; i += 1) {
      this.submitAndRecordAssignedSpawn(
        this.options.participants[i],
        assignment[i],
        turnNumber,
      );
    }
    return this.records.slice(startingRecordCount);
  }

  /**
   * Place every participant at its fairness-assigned spawn slot and advance
   * turns until the phase ends. NO agent/brain choice is involved: exactly
   * `participants.length` well-spaced, quality-floored slots are selected
   * once (via `assignSpawnSlots` - deterministic maximin spacing over the
   * authoritative `buildSpawnCandidates` pool) and roster index `i` is
   * assigned `slots[(i + episodeIndex) % N]`, so repeated episodes on the
   * same map/candidate pool rotate every agent through every slot. The
   * assignment is computed and validated (`validateSpawnSlotUniqueness` +
   * `validateSpawnSlotLegality` against the LIVE game state, re-checking the
   * exact same authoritative predicates `buildSpawnCandidates` used at
   * generation time - never merely trusted) on the first tick a live game
   * snapshot is available, then every participant's tile is submitted
   * exactly once, immediately - there is no negotiation, no relocation, no
   * retry, and the assignment is final for the life of this match. A
   * rejected submission is an invariant failure (see
   * `submitAndRecordAssignedSpawn`) - it throws rather than ever falling
   * back to a different or engine-default spawn.
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
    let submitted = false;

    for (let tick = 0; tick <= maxSpawnTicks; tick += 1) {
      await options.mirror.ingest(options.messages());
      const gameState = options.mirror.gameState();
      if (gameState !== null && !gameState.inSpawnPhase()) {
        if (!submitted) {
          throw new Error(
            "runSpawnPhase: left the spawn phase before the fairness " +
              "assignment could be submitted",
          );
        }
        return this.records.slice(startingRecordCount);
      }
      if (!submitted && gameState !== null) {
        const agentIDs = this.options.participants.map(
          (participant) => participant.runner.agentID,
        );
        const assignment = assignSpawnSlots({
          candidates: this.options.spawnCandidates,
          participantCount: this.options.participants.length,
          episodeIndex: this.options.episodeIndex ?? 0,
          qualityFloor: this.options.spawnQualityFloor,
        });
        validateSpawnSlotUniqueness(assignment, agentIDs);
        validateSpawnSlotLegality(assignment, agentIDs, gameState);
        for (let i = 0; i < this.options.participants.length; i += 1) {
          this.submitAndRecordAssignedSpawn(
            this.options.participants[i],
            assignment[i],
            gameState.ticks(),
          );
        }
        submitted = true;
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
      const initialObservation =
        this.observationBuilder.build(observationInput);
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

    const sameTurnDiplomacyParticipants = new Set<string>();
    const sameTurnAllianceRequests = new Set<string>();
    const sameTurnBuildTiles: number[] = [];

    for (const input of decisions) {
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
      const { participant, observation, decision, decisionLatencyMs } = input;
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

      // Did the ACTION slot already play a deal meta-action this decision?
      // If so the deal slot is refused outright — not just for the same id.
      // Two deal actions in one decision would collide on the SAME record
      // stamp keys (dealAction/dealID/dealPublicText/dealStatedReason), so
      // the second silently overwrites the first: the record would name an
      // action that never happened and the overwritten deal's story beat
      // (e.g. the pact's deal_accepted, tone pact) would never reach
      // spectator telemetry while the pact itself was live. One deal action
      // per decision — the contract the player protocol states.
      const actionSlotPlayedDeal = selectedActions.some(
        (entry) => entry.action !== null && isDealActionKind(entry.action.kind),
      );

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
            droppedByCapActionIDs,
            validationFallbackUsed: validationFallbackUsed && batchIndex === 0,
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
                statedReason: decision.reason,
              })
            : null;
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
        // Diplomacy slot: the OPTIONAL second selection, applied exactly once
        // per decision (at batch index 0, i.e. immediately after the FIRST of
        // this agent's submitted actions — batched `actionIDs` submit their
        // remaining actions afterwards) and always within this agent's turn in
        // the participant-ordered pass, so the "earlier submission wins"
        // conflict rule between agents is unchanged and a deal never costs the
        // agent its move. Flag OFF (or no dealActionID): null, leaving records
        // byte-identical.
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
        const complianceStamp =
          this.dealManager?.takePendingComplianceStamp(
            participant.runner.agentID,
          ) ?? null;
        const dealMetadata: AgentDecision["metadata"] = {
          ...(dealOutcome?.stamps ?? {}),
          ...(dealSlotApplication?.stamps ?? {}),
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

  /**
   * Submits a participant's fairness-assigned spawn slot exactly once. A
   * synthetic, deterministic (non-LLM, non-brain) decision: the metadata
   * flags keep it OUT of the LLM-aliveness count (rawProviderOutputPresent:
   * false) and the external-brain-cleanliness external-call count
   * (externalPlannerCall/externalActionCall:false). The assigned tile
   * already passed `validateSpawnSlotUniqueness` + `validateSpawnSlotLegality`
   * before this is ever called, so the submit is expected to be accepted -
   * a rejection here is an INVARIANT failure (the fairness assignment
   * itself is broken, or core state moved out from under an
   * already-validated tile), never something to paper over: the truthful
   * (rejected) record is retained first, then this throws immediately
   * naming the agent/tile/reason, so the engine's own fallback/default
   * spawn can never silently contradict the assigned slot.
   */
  private submitAndRecordAssignedSpawn(
    participant: AgentParticipant,
    candidate: SpawnCandidate,
    turnNumber: number,
  ): void {
    const observation = this.observationBuilder.build({
      agentID: participant.runner.agentID,
      clientID: participant.runner.clientID(),
      username: participant.spec.username,
      profile: participant.spec.profile,
      gameID: this.options.game.id,
      turnNumber,
      phaseOverride: "spawn",
      objective: this.objectiveManager.currentObjective(
        participant.runner.agentID,
      ),
      recentDecisions: this.recentDecisionsFor(participant),
    });
    const spawnAction = buildSpawnLegalAction(candidate);
    const decision: AgentDecision = {
      actionID: spawnAction.id,
      reason: "deterministic fairness-assigned spawn slot",
      metadata: {
        brain: "deterministic-spawn",
        actionSelectionSource: "deterministic-spawn",
        externalPlannerCall: false,
        externalActionCall: false,
        rawProviderOutputPresent: false,
        spawnAssignment: true,
      },
    };
    const result = this.submitLegalAction(participant.runner, spawnAction);
    this.recordDecision({
      participant,
      turnNumber: observation.turnNumber,
      observationSummary: this.observationBuilder.summarize(observation),
      observation,
      legalActions: [spawnAction],
      chosenAction: spawnAction,
      decision,
      decisionLatencyMs: 0,
      reason: decision.reason,
      result,
    });
    if (!result.accepted) {
      throw new Error(
        `runSpawnPhase: fairness-assigned spawn was rejected for agent ` +
          `${participant.runner.agentID} at tile ${candidate.tile}: ` +
          `${result.reason}. A rejection here means the assignment or the ` +
          "live game state is broken - never falls back silently.",
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
            player.clientID === record.clientID ||
            player.name === record.username,
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
    const isLlmBrain = LLM_DEGRADABLE_BRAIN_TYPES.has(
      input.brain.brainType ?? "",
    );
    const fallbackDecision = await new RuleAgentBrain(
      input.fallbackProfile,
    ).decide({
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
  }

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
