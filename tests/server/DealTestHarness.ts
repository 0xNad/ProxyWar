import { Logger } from "winston";
import { PlayerType, Relation } from "../../src/core/game/Game";
import type { AgentParticipant } from "../../src/server/agents/AgentLeagueMatch";
import { AgentLeagueMatchRunner } from "../../src/server/agents/AgentLeagueMatch";
import type { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { AgentRunner } from "../../src/server/agents/AgentRunner";
import type {
  AgentBrain,
  AgentBrainInput,
  AgentBrainType,
  AgentDecisionRecord,
  AgentEconomyObservation,
  AgentObservation,
  AgentVisiblePlayer,
} from "../../src/server/agents/AgentTypes";
import type { GameServer } from "../../src/server/GameServer";

/**
 * Shared harness for the structured-deal (Phase B) suites: stub observations
 * with real playerIDs, a stub observation builder, scripted brains, and a
 * league factory that drives AgentLeagueMatchRunner.runDecisionTurn without a
 * live game (deal meta-actions are intent:null, so no game submission path is
 * exercised). Not a test file — vitest ignores it.
 */

export const DEALS_FLAG = "PROXYWAR_TUNE_STRUCTURED_DEALS";

export function makeStubLogger(): Logger {
  const logger = {
    child: () => logger,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as Logger;
}

export interface StubSeat {
  agentID: string;
  playerID: string;
  username: string;
}

export function stubVisiblePlayer(
  seat: StubSeat,
  overrides: Partial<AgentVisiblePlayer> = {},
): AgentVisiblePlayer {
  return {
    playerID: seat.playerID,
    clientID: `CLNT_${seat.playerID}`,
    smallID: 1,
    name: seat.username,
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 10_000,
    gold: "100000",
    tilesOwned: 100,
    tileShare: 0.1,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: true,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    ...overrides,
  };
}

export function stubObservation(input: {
  seat: StubSeat;
  others: AgentVisiblePlayer[];
  turnNumber: number;
  gameID?: string;
  /** Optional flag-gated economy block (external-seat integration tests). */
  economy?: AgentEconomyObservation;
}): AgentObservation {
  return {
    agentID: input.seat.agentID,
    clientID: `CLNT_${input.seat.playerID}`,
    username: input.seat.username,
    profile: "diplomatic",
    gameID: input.gameID ?? "DEAL_TEST",
    phase: "active",
    turnNumber: input.turnNumber,
    tick: input.turnNumber,
    ownState: {
      playerID: input.seat.playerID,
      clientID: `CLNT_${input.seat.playerID}`,
      smallID: 1,
      name: input.seat.username,
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 10_000,
      gold: "100000",
      tilesOwned: 100,
      borderTiles: 20,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    visiblePlayers: input.others,
    combat: {
      ownTroops: 10_000,
      borderedPlayerIDs: input.others.map((other) => other.playerID),
      attackablePlayerIDs: input.others
        .filter((other) => other.canAttack)
        .map((other) => other.playerID),
      canExpandIntoNeutral: true,
      neutralExpansionLegalReason: "test neutral expansion",
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: [],
      weakestAttackableTargetID: null,
      strongestAttackableTargetID: null,
      blockerNotes: [],
    },
    nonCombat: {
      buildOptions: [],
      supportOptions: [],
      embargoOptions: [],
      blockerNotes: [],
    },
    strategic: {
      priority: "hold",
      urgency: "low",
      summary: "stub strategic state",
      scores: {
        expansion: 0,
        economy: 0,
        defense: 0,
        offense: 0,
        diplomacy: 0,
        threat: 0,
        idleTroops: 0,
      },
      recommendedActionKinds: [],
      targetPlayerIDs: [],
      notes: [],
    },
    memory: {
      recentActions: [],
      recentActionCountsByKind: {},
      recentNonHoldCount: 0,
      recentExpansionCount: 0,
      recentBuildCount: 0,
      repeatedActionKind: null,
      repeatedActionCount: 0,
      avoidActionIDs: [],
      summary: "stub memory",
      notes: [],
    },
    objective: null,
    recentDecisions: [],
    ...(input.economy !== undefined ? { economy: input.economy } : {}),
    notes: [],
  };
}

/**
 * A scripted decision. A bare string (or null) is the original shape — the
 * game action id, null selecting hold. The object form additionally scripts
 * the optional diplomacy slot (`dealActionID`) and an explicit stated reason
 * (`null` = the brain stated none).
 */
export interface ScriptedPick {
  actionID?: string | null;
  dealActionID?: string | null;
  reason?: string | null;
}

/** Picks the next decision; null (or exhaustion) selects hold. */
export type ScriptedPicker = (
  input: AgentBrainInput,
) => string | ScriptedPick | null;

export interface ScriptedBrainHandle {
  brain: AgentBrain;
  inputs: AgentBrainInput[];
}

export function scriptedBrain(
  pickers: ScriptedPicker[],
  brainType: AgentBrainType = "rule",
): ScriptedBrainHandle {
  const inputs: AgentBrainInput[] = [];
  let index = 0;
  return {
    inputs,
    brain: {
      brainType,
      decide: (input: AgentBrainInput) => {
        inputs.push(input);
        const picker = pickers[index];
        index += 1;
        const picked = picker?.(input) ?? null;
        const pick: ScriptedPick =
          typeof picked === "string" ? { actionID: picked } : (picked ?? {});
        const actionID = pick.actionID ?? null;
        return {
          actionID: actionID ?? "hold",
          reason:
            pick.reason !== undefined
              ? pick.reason
              : actionID === null
                ? "scripted hold"
                : `scripted ${actionID}`,
          ...(pick.dealActionID !== undefined
            ? { dealActionID: pick.dealActionID }
            : {}),
        };
      },
    },
  };
}

export function pickByKind(kind: string): ScriptedPicker {
  return (input) =>
    input.legalActions.find((action) => action.kind === kind)?.id ?? null;
}

export function pickByID(actionID: string): ScriptedPicker {
  return (input) =>
    input.legalActions.some((action) => action.id === actionID)
      ? actionID
      : null;
}

/** Scripts the game action AND the optional diplomacy slot in one decision. */
export function pickWithDeal(
  actionID: string | null,
  dealActionID: string | null,
  reason?: string | null,
): ScriptedPicker {
  return () => ({
    actionID,
    dealActionID,
    ...(reason !== undefined ? { reason } : {}),
  });
}

export interface DealLeagueHarness {
  league: AgentLeagueMatchRunner;
  seats: StubSeat[];
  handles: ScriptedBrainHandle[];
  records: () => AgentDecisionRecord[];
}

/**
 * League over stub observations: every seat sees every other seat as a
 * bordered, attackable rival. The stub observation builder keys on the
 * requesting agentID; the runner injects the deals block itself.
 */
export function dealLeagueHarness(input: {
  seats: StubSeat[];
  scripts: ScriptedPicker[][];
  gameID?: string;
  /** Brain type stamped on every scripted seat (default "rule"); use
   *  "external-http" to exercise the hosted external-seat record path. */
  brainType?: AgentBrainType;
  /** Optional economy block injected into every seat's stub observation. */
  economy?: AgentEconomyObservation;
}): DealLeagueHarness {
  const log = makeStubLogger();
  const handles = input.scripts.map((pickers) =>
    scriptedBrain(pickers, input.brainType ?? "rule"),
  );
  const participants: AgentParticipant[] = input.seats.map((seat, index) => ({
    spec: { username: seat.username, profile: "diplomatic" },
    brain: handles[index].brain,
    runner: new AgentRunner({
      agentID: seat.agentID,
      username: seat.username,
      log,
    }),
  }));
  const observationBuilder = {
    build: (builderInput: { agentID: string; turnNumber: number }) => {
      const seat = input.seats.find(
        (candidate) => candidate.agentID === builderInput.agentID,
      );
      if (seat === undefined) {
        throw new Error(`unknown stub seat: ${builderInput.agentID}`);
      }
      return stubObservation({
        seat,
        others: input.seats
          .filter((candidate) => candidate.agentID !== seat.agentID)
          .map((candidate) => stubVisiblePlayer(candidate)),
        turnNumber: builderInput.turnNumber,
        gameID: input.gameID,
        economy: input.economy,
      });
    },
    summarize: () => "stub observation",
  } as unknown as AgentObservationBuilder;
  const league = new AgentLeagueMatchRunner({
    game: { id: input.gameID ?? "DEAL_TEST" } as unknown as GameServer,
    participants,
    spawnCandidates: [],
    log,
    observationBuilder,
  });
  return {
    league,
    seats: input.seats,
    handles,
    records: () => league.decisionRecords(),
  };
}

/** Fabricated decision record for direct manager/compliance/telemetry tests. */
export function fabricatedRecord(input: {
  sequence: number;
  agentID: string;
  playerID: string;
  username: string;
  turnNumber: number;
  kind?: AgentDecisionRecord["chosenActionKind"];
  actionID?: string;
  accepted?: boolean;
  /** The deciding brain's own stated reason; null = none stated. */
  reason?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  auditStatus?: NonNullable<AgentDecisionRecord["audit"]>["auditStatus"];
  attackTargetsBefore?: string[];
  attackTargetsAfter?: string[];
  embargoTargetsBefore?: string[];
  embargoTargetsAfter?: string[];
  confirmedDonation?: NonNullable<
    AgentDecisionRecord["audit"]
  >["confirmedDonation"];
}): AgentDecisionRecord {
  const kind = input.kind ?? "hold";
  const snapshot = (attackTargets: string[], embargoTargets: string[]) => ({
    tick: input.turnNumber,
    playerID: input.playerID,
    isAlive: true,
    hasSpawned: true,
    tilesOwned: 100,
    troops: 10_000,
    gold: "100000",
    unitCounts: {},
    outgoingAttackTargetIDs: attackTargets,
    outgoingAllianceRequestRecipientIDs: [],
    outgoingEmbargoTargetIDs: embargoTargets,
  });
  return {
    sequence: input.sequence,
    gameID: "DEAL_TEST",
    agentID: input.agentID,
    clientID: `CLNT_${input.playerID}`,
    username: input.username,
    profile: "diplomatic",
    brainType: "rule",
    turnNumber: input.turnNumber,
    decidedAt: 0,
    decisionLatencyMs: 0,
    observationSummary: "fabricated",
    legalActionIDs: [input.actionID ?? kind],
    legalActionIDsByKind: { [kind]: [input.actionID ?? kind] },
    attackActionIDs: [],
    chosenActionID: input.actionID ?? kind,
    chosenActionKind: kind,
    reason: input.reason === undefined ? "fabricated" : input.reason,
    chosenActionMetadata: input.metadata ?? {},
    intent: null,
    result: {
      accepted: input.accepted ?? true,
      reason: "fabricated",
      submittedIntent: null,
    },
    audit: {
      auditStatus: input.auditStatus ?? "not_applicable",
      auditReason: "fabricated audit",
      before: snapshot(
        input.attackTargetsBefore ?? [],
        input.embargoTargetsBefore ?? [],
      ),
      after: snapshot(
        input.attackTargetsAfter ?? [],
        input.embargoTargetsAfter ?? [],
      ),
      ...(input.confirmedDonation !== undefined
        ? { confirmedDonation: input.confirmedDonation }
        : {}),
    },
  };
}
