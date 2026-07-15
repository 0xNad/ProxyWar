import type {
  AgentBrainInput,
  AgentVisiblePlayer,
  LegalActionKind,
} from "../../../src/server/agents/AgentTypes";

import { classifyKeystoneActions } from "./action-facts";
import type {
  KeystoneBalanceOfPowerFacts,
  KeystoneCommanderContext,
  KeystoneOwnFacts,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "./types";

export interface BuildKeystoneWorldModelOptions {
  forbiddenActionKinds?: readonly LegalActionKind[];
  planAlignedActionIDs?: readonly string[];
  commander?: KeystoneCommanderContext;
  /** Default-off Council-native runaway-leader treatment. */
  balanceOfPowerEnabled?: boolean;
}

const MIN_BALANCE_ALIVE_POWERS = 4;
const MIN_BALANCE_LEADER_SHARE_BP = 3_200;
const BALANCE_LEADER_RATIO_NUMERATOR = 135;
const BALANCE_LEADER_RATIO_DENOMINATOR = 100;

const EMPTY_COMMANDER_CONTEXT: KeystoneCommanderContext = Object.freeze({
  planID: "",
  binding: null,
});

/**
 * Builds the shared, immutable view consumed by every expert. It intentionally
 * contains action facts and observed state, never raw intents or mutable maps.
 */
export function buildKeystoneWorldModel(
  input: AgentBrainInput,
  options: BuildKeystoneWorldModelOptions = {},
): KeystoneWorldModel {
  const own = ownFacts(input);
  const players = Object.freeze(
    input.observation.visiblePlayers
      .map((player) => playerFacts(player, own?.team ?? null))
      .sort((a, b) => compareText(a.playerID, b.playerID)),
  );
  const incomingAggressorIDs = Object.freeze(
    Array.from(
      new Set([
        ...input.observation.combat.incomingAttackPlayerIDs,
        ...input.observation.visiblePlayers
          .filter((player) => player.incomingAttack)
          .map((player) => player.playerID),
      ]),
    ).sort(compareText),
  );
  const classification = classifyKeystoneActions({
    legalActions: input.legalActions,
    visiblePlayers: input.observation.visiblePlayers,
    ownPlayerID: own?.playerID ?? null,
    ownTeam: own?.team ?? null,
    forbiddenActionKinds: options.forbiddenActionKinds ?? [],
    planAlignedActionIDs: options.planAlignedActionIDs ?? [],
    incomingAggressorIDs,
  });

  return Object.freeze({
    gameID: input.observation.gameID,
    phase: input.observation.phase,
    turnNumber: input.observation.turnNumber,
    commander: options.commander ?? EMPTY_COMMANDER_CONTEXT,
    own,
    players,
    incomingAggressorIDs,
    canExpandIntoNeutral: input.observation.combat.canExpandIntoNeutral,
    ...(options.balanceOfPowerEnabled === true
      ? { balanceOfPower: balanceOfPowerFacts(input, own, players) }
      : {}),
    recommendedBackstabTargetID: recommendedBackstabTargetID(input),
    actions: classification.actions,
    ambiguousOfferedActionIDs: classification.ambiguousOfferedActionIDs,
  });
}

function balanceOfPowerFacts(
  input: AgentBrainInput,
  own: KeystoneOwnFacts | null,
  players: readonly KeystonePlayerFacts[],
): KeystoneBalanceOfPowerFacts | null {
  const observedOwn = input.observation.ownState;
  if (
    input.observation.phase !== "active" ||
    input.observation.gameMode !== "FFA" ||
    own === null ||
    observedOwn === null ||
    !observedOwn.isAlive ||
    !observedOwn.hasSpawned ||
    own.playerID.trim().length === 0 ||
    own.team !== null
  ) {
    return null;
  }

  const ownShareBP = strictShareBasisPoints(observedOwn.tileShare);
  if (ownShareBP === null) {
    return null;
  }

  const seenPlayerIDs = new Set<string>([own.playerID]);
  const playerFactsByID = new Map(
    players.map((player) => [player.playerID, player]),
  );
  const powers: Array<{
    readonly playerID: string;
    readonly tileShareBP: number;
    readonly isOwn: boolean;
  }> = [
    Object.freeze({
      playerID: own.playerID,
      tileShareBP: ownShareBP,
      isOwn: true,
    }),
  ];

  for (const observed of input.observation.visiblePlayers) {
    if (
      observed.playerID.trim().length === 0 ||
      seenPlayerIDs.has(observed.playerID)
    ) {
      return null;
    }
    seenPlayerIDs.add(observed.playerID);
    if (!observed.isAlive) {
      continue;
    }
    const facts = playerFactsByID.get(observed.playerID);
    const shareBP = strictShareBasisPoints(observed.tileShare);
    if (
      facts === undefined ||
      shareBP === null ||
      observed.isTeammate === true ||
      (observed.team !== null && observed.team !== undefined)
    ) {
      return null;
    }
    powers.push(
      Object.freeze({
        playerID: observed.playerID,
        tileShareBP: shareBP,
        isOwn: false,
      }),
    );
  }

  if (powers.length < MIN_BALANCE_ALIVE_POWERS) {
    return null;
  }
  powers.sort(
    (a, b) =>
      b.tileShareBP - a.tileShareBP || compareText(a.playerID, b.playerID),
  );
  const leader = powers[0]!;
  const runnerUp = powers[1]!;
  if (
    leader.isOwn ||
    leader.tileShareBP === runnerUp.tileShareBP ||
    leader.tileShareBP < MIN_BALANCE_LEADER_SHARE_BP ||
    leader.tileShareBP * BALANCE_LEADER_RATIO_DENOMINATOR <
      runnerUp.tileShareBP * BALANCE_LEADER_RATIO_NUMERATOR
  ) {
    return null;
  }

  const reportedLeaderID = input.observation.endgame?.leaderID ?? null;
  if (reportedLeaderID !== null && reportedLeaderID !== leader.playerID) {
    return null;
  }

  const otherNonLeaders = powers.filter(
    (power) => !power.isOwn && power.playerID !== leader.playerID,
  );
  const strongestOther = otherNonLeaders[0] ?? null;
  const strongestOtherIsUnique =
    strongestOther !== null &&
    (otherNonLeaders[1] === undefined ||
      strongestOther.tileShareBP !== otherNonLeaders[1]!.tileShareBP);

  return Object.freeze({
    leaderPlayerID: leader.playerID,
    leaderTileShareBP: leader.tileShareBP,
    runnerUpPlayerID: runnerUp.playerID,
    runnerUpTileShareBP: runnerUp.tileShareBP,
    strongestOtherNonLeaderPlayerID: strongestOtherIsUnique
      ? strongestOther!.playerID
      : null,
    strongestOtherNonLeaderTileShareBP: strongestOtherIsUnique
      ? strongestOther!.tileShareBP
      : null,
    ownTileShareBP: ownShareBP,
    leaderOwnGapBP: leader.tileShareBP - ownShareBP,
    leaderFieldGapBP: leader.tileShareBP - runnerUp.tileShareBP,
    alivePowerCount: powers.length,
  });
}

function recommendedBackstabTargetID(input: AgentBrainInput): string | null {
  const affordance = input.observation.tacticalAffordances?.backstabAlly;
  const targetID = affordance?.backstabTargetID;
  return affordance?.recommended === true &&
    typeof targetID === "string" &&
    targetID.trim().length > 0
    ? targetID
    : null;
}

function ownFacts(input: AgentBrainInput): KeystoneOwnFacts | null {
  const own = input.observation.ownState;
  if (own === null) {
    return null;
  }
  return Object.freeze({
    playerID: own.playerID,
    team: own.team ?? null,
    troops: own.troops,
    maxTroops: own.maxTroops ?? null,
    troopRatioBP: ratioBasisPoints(own.troopRatio),
    tileShareBP: shareBasisPoints(own.tileShare),
    tilesOwned: own.tilesOwned,
  });
}

function playerFacts(
  player: AgentVisiblePlayer,
  ownTeam: string | null,
): KeystonePlayerFacts {
  const sameTeam =
    ownTeam !== null && player.team !== null && player.team === ownTeam;
  const isTeammate = player.isTeammate === true || sameTeam;
  return Object.freeze({
    playerID: player.playerID,
    isAlive: player.isAlive,
    isAllied: player.isAllied,
    isFriendly: player.isFriendly,
    isTeammate,
    sameTeam,
    friendlyOrTeam:
      player.isAllied || player.isFriendly || isTeammate || sameTeam,
    sharesBorder: player.sharesBorder,
    incomingAttack: player.incomingAttack,
    hasOutgoingAllianceRequest: player.hasOutgoingAllianceRequest === true,
    hasIncomingAllianceRequest: player.hasIncomingAllianceRequest === true,
    hasEmbargoAgainst: player.hasEmbargoAgainst === true,
    canExtendAlliance: player.canExtendAlliance === true,
    allianceInExtensionWindow: player.allianceInExtensionWindow === true,
    troops: player.troops,
    troopRatioBP: ratioBasisPoints(player.troopRatio),
    tileShareBP: shareBasisPoints(player.tileShare),
    relativeTroopRatioBP: ratioBasisPoints(player.relativeTroopRatio),
  });
}

function shareBasisPoints(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000);
}

function strictShareBasisPoints(value: number | undefined): number | null {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return null;
  }
  return Math.round(value * 10_000);
}

function ratioBasisPoints(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.max(0, value) * 10_000);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
