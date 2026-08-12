/**
 * SimRollout — harness-side forward-simulation world model (P3.5 lever).
 *
 * The deterministic core can roll candidate commitments forward locally (free,
 * no LLM quota) and hand the Commander grounded forecasts instead of vibes. This
 * module is the verdict-independent ENGINE only: it snapshots a game, clones it,
 * rolls the deterministic sim forward N decision-steps with the agent acting under
 * a candidate commitment, and returns a compact forecast. Wiring these forecasts
 * into the Commander prompt is a separate, later step (see the note at the bottom).
 *
 * Design constraints honored here:
 *  - NOT a core change. This is a pure server-side wrapper that only IMPORTS from
 *    `src/core` (the deterministic sim) and the existing agent layer. It never
 *    mutates the caller's live game.
 *  - One action schema / one executor. Rival-agent behavior is approximated by the
 *    EXISTING deterministic executor policy (`FrontierPolicyExecutor` driven by
 *    `RuleAgentPlanner` inside `PlannerExecutorAgentBrain`) and every action is an
 *    offered `LegalAction.id` chosen through `LegalActionBuilder` +
 *    `validateAgentDecision`. No game logic is reimplemented.
 *  - Exactly reproducible. The core is deterministic + seeded and the clone is
 *    rebuilt by replaying the canonical `{ gameStartInfo, turns }` log (the same
 *    mechanism the whole replay system uses), so two rollouts of the same snapshot
 *    + commitment are byte-for-byte identical.
 *
 * Snapshotting note: `src/core` exposes NO `clone()`/`serialize()` on `Game`
 * (verified), and editing core is out of scope. The only deterministic way to
 * reconstruct an in-progress game state from outside core is to replay its turn
 * log into a fresh `GameRunner`. That log — `{ gameStartInfo, turns }` — is exactly
 * what the harness already produces (it is the shape of `GameRecord`), so this
 * module takes that as its snapshot input.
 */

import { Logger } from "winston";
import { Game, Player, TerraNullius } from "../../core/game/Game";
import { GameMapLoader } from "../../core/game/GameMapLoader";
import { createGameRunner, GameRunner } from "../../core/GameRunner";
import {
  ClientID,
  GameStartInfo,
  Intent,
  StampedIntent,
  Turn,
} from "../../core/Schemas";
import { validateAgentDecision } from "./AgentDecisionValidator";
import {
  interleaveLayers,
  MAX_WIRE_ACTIONS_PER_DECISION,
} from "./AgentWireProtocol";
import {
  AgentObservationBuilder,
  BuildAgentObservationInput,
} from "./AgentObservationBuilder";
import {
  AgentPlanCommitment,
  AgentPlanDecision,
  AgentPlanner,
  FrontierPolicyExecutor,
  PlannerExecutorAgentBrain,
  RuleAgentPlanner,
  StrategicPlan,
} from "./AgentPlannerExecutor";
import { LegalActionBuilder } from "./LegalActionBuilder";
import {
  AgentBrainInput,
  AgentObjectiveKind,
  AgentStrategyProfile,
} from "./AgentTypes";

/**
 * The canonical forward-simulatable snapshot of an in-progress game: the start
 * info plus the ordered turn log. Replaying this into a fresh `GameRunner`
 * deterministically reconstructs the exact game state. This is the shape the
 * harness already holds (`GameRecord` = `{ info, turns }`).
 */
export interface GameSnapshot {
  gameStartInfo: GameStartInfo;
  turns: Turn[];
}

/**
 * One agent-controlled seat in the rollout, identified by its stable clientID
 * (the same id that appears in `gameStartInfo.players[].clientID`). The agent
 * under test gets the candidate commitment; every other listed agent is driven
 * by the deterministic executor policy as a behavior approximation.
 */
export interface RolloutAgentSeat {
  clientID: ClientID;
  profile: AgentStrategyProfile;
}

/**
 * A candidate "commitment"/directive in the existing planner directive shape:
 * objective + target + troop ratio + a horizon. Mirrors the Commander's
 * Strategic Directive (`AgentPlanCommitment` carries the binding target + ratio;
 * `objective` is the `AgentObjectiveKind` the directive sets).
 */
export interface CandidateCommitment {
  /** Stable label for ranking output / debugging. */
  id: string;
  objective: AgentObjectiveKind;
  /**
   * The rival this directive is aimed at, by player id (the `PlayerID` used in
   * the observation/`AgentPlanCommitment`), or null for non-targeted objectives
   * (e.g. expand into neutral, fortify).
   */
  targetPlayerId: string | null;
  /**
   * Minimum attack commitment ratio (0..1), matching
   * `AgentPlanCommitment.minAttackRatio`. Only meaningful for attacking
   * objectives; ignored when `targetPlayerId` is null.
   */
  troopRatio?: number;
  /** Free-text rationale carried into the synthesized plan (not scored). */
  rationale?: string;
}

export interface RolloutConfig {
  /** How many decision steps to simulate forward. Default 3. */
  horizonSteps: number;
  /** Core ticks per decision step (the step-locked cadence). Default 25. */
  turnsPerStep: number;
}

const DEFAULT_ROLLOUT_CONFIG: RolloutConfig = {
  horizonSteps: 3,
  turnsPerStep: 25,
};

/** A compact, prompt-sized forecast for the agent under one commitment. */
export interface CommitmentForecast {
  commitmentId: string;
  objective: AgentObjectiveKind;
  targetPlayerId: string | null;
  horizonSteps: number;
  /** Owned-tile change over the horizon (after - before). */
  tileDelta: number;
  /** Owned-troop change over the horizon. */
  troopDelta: number;
  /** Tile-share change over the horizon, in [-1, 1]. */
  tileShareDelta: number;
  /** Whether the agent is still alive at the horizon. */
  survivesHorizon: boolean;
  /**
   * Change in the agent's contested-front size (border tiles adjacent to a
   * hostile player's territory). Negative = fewer contested fronts (consolidation);
   * positive = more exposure / more active fighting frontage.
   */
  contestedFrontDelta: number;
  /** Whether the agent reached an outright game win within the horizon. */
  achievesWin: boolean;
  /**
   * A single scalar outcome score for ranking. Higher is better for the agent.
   * Dominated by territory/share gain, with survival and win bonuses and a small
   * penalty for runaway contested-front exposure. Verdict-independent: it scores
   * the rollout outcome, it does not decide whether the Commander should commit.
   */
  outcomeScore: number;
}

interface PlayerMetrics {
  alive: boolean;
  tiles: number;
  troops: number;
  tileShare: number;
  contestedFront: number;
  isWinner: boolean;
}

/**
 * A deterministic state fingerprint over the PUBLIC `Game` interface. Used by
 * callers/tests to prove a rollout never mutated the live game: capture before,
 * capture after, assert equal. `GameImpl.hash()` is private to core and not on
 * the `Game` interface, so this reads only public accessors (and covers troops,
 * gold and unit counts that the internal hash also folds in).
 */
export function fingerprintGameState(game: Game): string {
  const parts: string[] = [`t=${game.ticks()}`, `spawn=${game.inSpawnPhase()}`];
  const winner = game.getWinner();
  parts.push(`winner=${winner === null ? "none" : winnerKey(winner)}`);
  // Players are iterated in the engine's stable order; include every field that
  // a forward step could move.
  for (const player of game.players()) {
    parts.push(
      [
        player.id(),
        player.type(),
        player.isAlive() ? 1 : 0,
        player.numTilesOwned(),
        Math.round(player.troops()),
        player.gold().toString(),
        player.units().length,
        player.isTraitor() ? 1 : 0,
      ].join(":"),
    );
  }
  parts.push(`fallout=${game.numTilesWithFallout()}`);
  return parts.join("|");
}

function winnerKey(winner: NonNullable<ReturnType<Game["getWinner"]>>): string {
  // Player has id(); Team has a string id.
  if (typeof (winner as { id?: unknown }).id === "function") {
    return `player:${(winner as { id(): string }).id()}`;
  }
  return `team:${String((winner as { id: unknown }).id)}`;
}

/**
 * Rebuild a fresh, independent `GameRunner` from a snapshot by replaying its turn
 * log. This is the "clone": because the core is deterministic, the reconstructed
 * game is identical to the snapshotted state, and it shares NO mutable state with
 * the caller's live game.
 */
export async function cloneFromSnapshot(
  snapshot: GameSnapshot,
  mapLoader: GameMapLoader,
): Promise<GameRunner> {
  const runner = await createGameRunner(
    snapshot.gameStartInfo,
    undefined,
    mapLoader,
    () => undefined,
  );
  for (const turn of snapshot.turns) {
    runner.addTurn(turn);
  }
  drainPendingTurns(runner);
  return runner;
}

function drainPendingTurns(runner: GameRunner, maxTicks = 1_000_000): void {
  let ticks = 0;
  while (runner.pendingTurns() > 0 && ticks < maxTicks) {
    runner.executeNextTick(runner.pendingTurns());
    ticks++;
  }
  if (runner.pendingTurns() > 0) {
    throw new Error(
      `SimRollout could not drain snapshot turns; ${runner.pendingTurns()} still pending after ${maxTicks} ticks`,
    );
  }
}

/**
 * A planner that pins the agent under test to a single candidate directive. It
 * delegates to the real `RuleAgentPlanner` to synthesize a complete, valid
 * `StrategicPlan` (so all the private plan-synthesis machinery — preferred /
 * forbidden action kinds, enabled modules, success criteria — is reused, not
 * reimplemented) and then overrides only the directive-controlled fields:
 * objective, target, and the binding commitment. This is exactly how a real
 * Commander directive flows into the executor.
 */
class FixedCommitmentPlanner implements AgentPlanner {
  readonly plannerType = "mock-llm" as const;
  private readonly base: RuleAgentPlanner;

  constructor(
    profile: AgentStrategyProfile,
    private readonly commitment: CandidateCommitment,
  ) {
    this.base = new RuleAgentPlanner(profile);
  }

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    const baseDecision = await this.base.plan(input, previousPlan);
    const planCommitment = this.resolveCommitment(input);
    const plan: StrategicPlan = {
      ...baseDecision.plan,
      objective: this.commitment.objective,
      targetPlayerId: this.commitment.targetPlayerId,
      rationale:
        this.commitment.rationale ??
        `sim-rollout candidate ${this.commitment.id}: ${this.commitment.objective}`,
      plannerSource: "mock-llm",
      // The commitment must stay executable; if the objective forbids attacks the
      // base plan would forbid them too, so re-derive forbidden kinds the way the
      // real plan builder does for committed plans (attack/boat never forbidden).
      forbiddenActionKinds:
        planCommitment !== undefined
          ? baseDecision.plan.forbiddenActionKinds.filter(
              (kind) => kind !== "attack" && kind !== "boat",
            )
          : baseDecision.plan.forbiddenActionKinds,
      ...(planCommitment !== undefined
        ? { commitment: planCommitment }
        : { commitment: undefined }),
    };
    return {
      plan,
      reason: plan.rationale,
      latencyMs: 0,
      fallbackUsed: false,
    };
  }

  /**
   * Build the binding `AgentPlanCommitment` from the candidate, but only if the
   * target actually exists in this observation (a commitment against a dead /
   * unseen rival would be unexecutable). Returns undefined for non-targeted
   * objectives or stale targets, so the plan simply runs without a hard commit.
   */
  private resolveCommitment(
    input: AgentBrainInput,
  ): AgentPlanCommitment | undefined {
    if (this.commitment.targetPlayerId === null) {
      return undefined;
    }
    const targetVisible = input.observation.visiblePlayers.some(
      (player) => player.playerID === this.commitment.targetPlayerId,
    );
    if (!targetVisible) {
      return undefined;
    }
    const ratio = clamp01(this.commitment.troopRatio ?? 0.25);
    return {
      targetPlayerId: this.commitment.targetPlayerId,
      minAttackRatio: ratio,
    };
  }
}

interface RolloutSeatRuntime {
  clientID: ClientID;
  agentID: string;
  profile: AgentStrategyProfile;
  brain: PlannerExecutorAgentBrain;
}

/**
 * Roll the deterministic sim forward under one candidate commitment and return a
 * compact forecast for the agent under test. The caller's live game is never
 * touched: a fresh clone is built from the snapshot for every rollout.
 */
export async function forecastCommitment(input: {
  snapshot: GameSnapshot;
  mapLoader: GameMapLoader;
  /** The clientID of the agent under test (must be one of `agents`). */
  agentClientID: ClientID;
  commitment: CandidateCommitment;
  /** All agent-controlled seats (under-test + rivals approximated by policy). */
  agents: RolloutAgentSeat[];
  config?: Partial<RolloutConfig>;
  log?: Logger;
}): Promise<CommitmentForecast> {
  const config = { ...DEFAULT_ROLLOUT_CONFIG, ...input.config };
  const runner = await cloneFromSnapshot(input.snapshot, input.mapLoader);
  const game = runner.game;

  const seats = buildSeatRuntimes(input.agents, input.commitment, {
    agentClientID: input.agentClientID,
  });
  const underTest = seats.find((seat) => seat.clientID === input.agentClientID);
  if (underTest === undefined) {
    throw new Error(
      `forecastCommitment: agentClientID ${input.agentClientID} is not in the provided agents list`,
    );
  }

  const before = metricsForClient(game, input.agentClientID);

  for (let step = 0; step < config.horizonSteps; step++) {
    if (game.getWinner() !== null) {
      break;
    }
    await runDecisionStep({ runner, seats });
    advanceTicks(runner, config.turnsPerStep);
  }

  const after = metricsForClient(game, input.agentClientID);
  return summarizeForecast(input.commitment, config, before, after);
}

/**
 * Evaluate the top-K candidate commitments against the same snapshot and return
 * forecasts ranked best-first by `outcomeScore`. Ties break by commitment id for
 * a stable, reproducible order.
 */
export async function evaluateCommitments(input: {
  snapshot: GameSnapshot;
  mapLoader: GameMapLoader;
  agentClientID: ClientID;
  commitments: CandidateCommitment[];
  agents: RolloutAgentSeat[];
  config?: Partial<RolloutConfig>;
  log?: Logger;
}): Promise<CommitmentForecast[]> {
  const forecasts: CommitmentForecast[] = [];
  for (const commitment of input.commitments) {
    forecasts.push(
      await forecastCommitment({
        snapshot: input.snapshot,
        mapLoader: input.mapLoader,
        agentClientID: input.agentClientID,
        commitment,
        agents: input.agents,
        config: input.config,
        log: input.log,
      }),
    );
  }
  return forecasts.sort(
    (a, b) =>
      b.outcomeScore - a.outcomeScore ||
      a.commitmentId.localeCompare(b.commitmentId),
  );
}

function buildSeatRuntimes(
  agents: RolloutAgentSeat[],
  commitment: CandidateCommitment,
  opts: { agentClientID: ClientID },
): RolloutSeatRuntime[] {
  return agents.map((seat) => {
    const isUnderTest = seat.clientID === opts.agentClientID;
    const planner: AgentPlanner = isUnderTest
      ? new FixedCommitmentPlanner(seat.profile, commitment)
      : new RuleAgentPlanner(seat.profile);
    const brain = new PlannerExecutorAgentBrain({
      profile: seat.profile,
      planner,
      executor: new FrontierPolicyExecutor(seat.profile, {
        seed: `sim-rollout:${seat.clientID}`,
      }),
      // Re-affirm the directive every decision step so the binding commitment
      // stays in force across the (short) rollout horizon rather than decaying.
      planEveryDecisionSteps: 1,
      brainType: "planner-executor",
    });
    return {
      clientID: seat.clientID,
      agentID: `sim-${seat.clientID}`,
      profile: seat.profile,
      brain,
    };
  });
}

/**
 * One decision step: every alive agent seat builds its observation + legal
 * actions from the current clone, the brain picks an action (under-test seat
 * under its commitment, rivals under the executor policy), and the chosen intents
 * are bundled into a single core turn and executed. This mirrors the step-locked
 * cadence (all decisions for a step land in one turn).
 */
async function runDecisionStep(input: {
  runner: GameRunner;
  seats: RolloutSeatRuntime[];
}): Promise<void> {
  const game = input.runner.game;
  const observationBuilder = new AgentObservationBuilder();
  const legalActionBuilder = new LegalActionBuilder();
  // Per-seat validated intent lists, staged then interleaved layer
  // round-robin (A1,B1,…,A2,B2,…) to match the league runner's submission
  // order — the core executor consumes a turn's intents in array order, so
  // seat-major staging would let one seat's whole batch preempt the next
  // seat's first action.
  const seatIntentLayers: StampedIntent[][] = [];

  for (const seat of input.seats) {
    const player = game.playerByClientID(seat.clientID);
    if (player === null || !player.isAlive()) {
      continue;
    }
    const observationInput: BuildAgentObservationInput = {
      agentID: seat.agentID,
      clientID: seat.clientID,
      username: player.name(),
      profile: seat.profile,
      // gameID is a label only (it does not affect the deterministic sim); a
      // stable per-rollout string keeps observations well-formed.
      gameID: `sim-rollout:${game.config().gameConfig().gameMap}`,
      turnNumber: game.ticks(),
      gameState: game,
    };
    const observation = observationBuilder.build(observationInput);
    const legalActions = legalActionBuilder.build({ observation });
    if (legalActions.length === 0) {
      continue;
    }
    const decision = await seat.brain.decide({ observation, legalActions });
    const actionIDs = (
      decision.actionIDs !== undefined && decision.actionIDs.length > 0
        ? decision.actionIDs
        : [decision.actionID]
    ).slice(0, MAX_WIRE_ACTIONS_PER_DECISION);
    const seatIntents: StampedIntent[] = [];
    for (const actionID of actionIDs) {
      const validation = validateAgentDecision(
        { ...decision, actionID },
        legalActions,
      );
      if (!validation.ok || validation.action.intent === null) {
        continue;
      }
      seatIntents.push(stampIntent(validation.action.intent, seat.clientID));
    }
    if (seatIntents.length > 0) {
      seatIntentLayers.push(seatIntents);
    }
  }

  // Interleave: one intent per seat per layer, fixed seat order within each
  // layer, until every seat's batch is exhausted.
  const stampedIntents = interleaveLayers(seatIntentLayers);

  // The decision turn carries every seat's intents; subsequent ticks in the step
  // run with empty turns (pure simulation), exactly like the live cadence.
  input.runner.addTurn(makeTurn(input.runner, stampedIntents));
  input.runner.executeNextTick();
}

function advanceTicks(runner: GameRunner, turnsPerStep: number): void {
  // One tick was already consumed by the decision turn; advance the remainder
  // with empty turns so the step spans `turnsPerStep` ticks total.
  for (let i = 1; i < turnsPerStep; i++) {
    runner.addTurn(makeTurn(runner, []));
    if (!runner.executeNextTick()) {
      break;
    }
  }
}

function makeTurn(runner: GameRunner, intents: StampedIntent[]): Turn {
  return {
    turnNumber: turnNumberFor(runner),
    intents,
  };
}

// GameRunner does not expose its internal turn counter, but turnNumber is not
// load-bearing for execution (the executor maps intents by clientID, not turn
// index). A monotonic counter per runner keeps turns well-formed.
const turnCounters = new WeakMap<GameRunner, number>();
function turnNumberFor(runner: GameRunner): number {
  const next = (turnCounters.get(runner) ?? 0) + 1;
  turnCounters.set(runner, next);
  return next;
}

function stampIntent(intent: Intent, clientID: ClientID): StampedIntent {
  return { ...intent, clientID } as StampedIntent;
}

function metricsForClient(game: Game, clientID: ClientID): PlayerMetrics {
  const player = game.playerByClientID(clientID);
  if (player === null) {
    return {
      alive: false,
      tiles: 0,
      troops: 0,
      tileShare: 0,
      contestedFront: 0,
      isWinner: false,
    };
  }
  const totalLand = Math.max(1, game.map().numLandTiles());
  const tiles = player.numTilesOwned();
  const winner = game.getWinner();
  return {
    alive: player.isAlive(),
    tiles,
    troops: player.troops(),
    tileShare: tiles / totalLand,
    contestedFront: contestedFrontSize(game, clientID),
    isWinner:
      winner !== null &&
      typeof (winner as { id?: unknown }).id === "function" &&
      (winner as { id(): string }).id() === player.id(),
  };
}

/**
 * Count the agent's border tiles that are adjacent to a HOSTILE player's
 * territory (a player it is not allied with / not on the same team). This is a
 * cheap proxy for "active fighting frontage": growth into neutral land does not
 * raise it, but pressing on a rival or being pressed does.
 */
function contestedFrontSize(game: Game, clientID: ClientID): number {
  const player = game.playerByClientID(clientID);
  if (player === null) {
    return 0;
  }
  let contested = 0;
  for (const tile of player.borderTiles()) {
    let isContested = false;
    game.forEachNeighbor(tile, (neighbor) => {
      if (isContested) {
        return;
      }
      const owner = game.owner(neighbor);
      if (isHostileOwner(owner, player)) {
        isContested = true;
      }
    });
    if (isContested) {
      contested++;
    }
  }
  return contested;
}

function isHostileOwner(
  owner: ReturnType<Game["owner"]>,
  self: Player,
): boolean {
  if (!ownerIsPlayer(owner)) {
    return false;
  }
  if (owner.id() === self.id()) {
    return false;
  }
  if (owner.isOnSameTeam(self)) {
    return false;
  }
  if (owner.isAlliedWith(self)) {
    return false;
  }
  return true;
}

function ownerIsPlayer(owner: Player | TerraNullius): owner is Player {
  return owner.isPlayer();
}

function summarizeForecast(
  commitment: CandidateCommitment,
  config: RolloutConfig,
  before: PlayerMetrics,
  after: PlayerMetrics,
): CommitmentForecast {
  const tileDelta = after.tiles - before.tiles;
  const troopDelta = after.troops - before.troops;
  const tileShareDelta = after.tileShare - before.tileShare;
  const contestedFrontDelta = after.contestedFront - before.contestedFront;
  const survivesHorizon = after.alive;
  const achievesWin = after.isWinner;

  // Single scalar, higher = better for the agent. Territory share dominates
  // (the OpenFront win proxy), troop economy is a smaller signal, survival and
  // outright win are large bonuses, and runaway exposure is lightly penalized.
  let outcomeScore = 0;
  outcomeScore += tileShareDelta * 1000;
  outcomeScore += Math.sign(troopDelta) * Math.log1p(Math.abs(troopDelta)) * 5;
  if (!survivesHorizon) {
    outcomeScore -= 1000;
  }
  if (achievesWin) {
    outcomeScore += 1000;
  }
  // Mild penalty for net-new contested frontage that did not convert to tiles;
  // expansion that also opens fronts is fine, pure over-extension is not.
  if (tileDelta <= 0 && contestedFrontDelta > 0) {
    outcomeScore -= Math.min(50, contestedFrontDelta);
  }

  return {
    commitmentId: commitment.id,
    objective: commitment.objective,
    targetPlayerId: commitment.targetPlayerId,
    horizonSteps: config.horizonSteps,
    tileDelta,
    troopDelta: Math.round(troopDelta),
    tileShareDelta: round4(tileShareDelta),
    survivesHorizon,
    contestedFrontDelta,
    achievesWin,
    outcomeScore: round4(outcomeScore),
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/*
 * ---------------------------------------------------------------------------
 * FUTURE Commander integration (separate plan-mode job — NOT wired here).
 *
 * This module is an isolated engine; nothing imports it yet. When the Commander
 * integration is built, the hook point is in `AgentPlannerExecutor.ts`, inside
 * the LLM planner path (`LlmAgentPlanner.plan(...)`), BEFORE the prompt is built:
 *
 *   1. The harness owns a live `{ gameStartInfo, turns }` log (the league/mirror
 *      already records it). Pass that as the `GameSnapshot`.
 *   2. Enumerate the top-K candidate directives the Commander is weighing (e.g.
 *      pressure each bordering rival at a few troop ratios + a fortify option) as
 *      `CandidateCommitment[]`.
 *   3. Call `evaluateCommitments({ snapshot, mapLoader, agentClientID, commitments,
 *      agents })` (agent rivals approximated by the executor policy) and inject the
 *      ranked `CommitmentForecast[]` into the planner prompt as grounded
 *      "if you commit to X for N steps, the sim forecasts +tiles / survival / ..."
 *      evidence — replacing vibes with search.
 *
 * It stays a pure read-side input to the model: the Commander still chooses, the
 * runner/validator/schema path is untouched, and the forecast never mutates the
 * live game. The integration only adds a prompt section + a snapshot handle; this
 * engine does not change.
 * ---------------------------------------------------------------------------
 */
