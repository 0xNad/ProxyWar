import type {
  AgentBrainInput,
  AgentVisiblePlayer,
  LegalActionKind,
} from "../../../src/server/agents/AgentTypes";

import { classifyKeystoneActions } from "./action-facts";
import type {
  KeystoneOwnFacts,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "./types";

export interface BuildKeystoneWorldModelOptions {
  forbiddenActionKinds?: readonly LegalActionKind[];
  planAlignedActionIDs?: readonly string[];
}

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
    own,
    players,
    incomingAggressorIDs,
    canExpandIntoNeutral: input.observation.combat.canExpandIntoNeutral,
    actions: classification.actions,
    ambiguousOfferedActionIDs: classification.ambiguousOfferedActionIDs,
  });
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

function ratioBasisPoints(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.max(0, value) * 10_000);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
