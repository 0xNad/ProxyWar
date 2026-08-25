import {
  BuildableAttacks,
  Game,
  Nukes,
  Player,
  PlayerType,
  Structures,
  TerraNullius,
  Unit,
  UnitType,
} from "../../core/game/Game";
import { flattenedEmojiTable } from "../../core/Util";
import { buildEconomyObservationExtension } from "./AgentEconomyNetwork";
import { AgentMemoryBuilder } from "./AgentMemoryBuilder";
import { nuclearTargetStructurePriority } from "./AgentNuclearPolicy";
import {
  AgentSpatialSnapshot,
  buildSpatialMapInfo,
  buildSpatialObservationExtension,
  createAgentSpatialSnapshot,
  SpatialObservationExtension,
} from "./AgentSpatialObservation";
import { AgentStrategicStateBuilder } from "./AgentStrategicStateBuilder";
import { buildAgentTacticalAffordances } from "./AgentTacticalAffordances";
import {
  spatialMinimapEnabled,
  spatialObservationEnabled,
} from "./AgentTunables";
import {
  AgentAllianceOption,
  AgentBoatOption,
  AgentBuildOption,
  AgentCombatState,
  AgentCommunicationSignal,
  AgentDeleteUnitOption,
  AgentEmbargoOption,
  AgentEmojiOption,
  AgentGamePhase,
  AgentNonCombatState,
  AgentObjectiveState,
  AgentObservation,
  AgentOwnState,
  AgentQuickChatOption,
  AgentStrategyProfile,
  AgentTargetOption,
  AgentTransportState,
  AgentUpgradeOption,
  AgentVisiblePlayer,
  AgentWarshipMoveOption,
  RecentAgentDecision,
} from "./AgentTypes";

interface BuildTargetCandidate {
  targetTile: number;
  buildTile: number;
  usedCachedSpawn: boolean;
  placement: BuildPlacementAnalysis;
}

interface BuildPlacementAnalysis {
  isBorderBuild: boolean;
  borderDistance: number;
  hostileBorderDistance: number | null;
  nearbyEnemyCount: number;
  nearbyAllyCount: number;
  nearbyIncomingAttack: boolean;
  ownedNeighborCount: number;
  frontierValue: number;
  economicValue: number;
  defensiveValue: number;
  buildPlacementReason: string;
  nukeTargetID?: string | null;
  nukeTargetName?: string | null;
  nukeTargetTiles?: number | null;
  nukeTargetTileShare?: number | null;
  nukeTargetStructureUnit?: string | null;
  nukeTargetStructureLevel?: number | null;
  nukeTargetStructurePriority?: number | null;
  nukeTargetStructureDensity?: number | null;
  nukeTargetSamCoverage?: number | null;
  nukeTargetPriority?: number | null;
}

interface NukeTargetAnalysis {
  targetID: string | null;
  targetName: string | null;
  targetTiles: number | null;
  targetTileShare: number | null;
  structureUnit: string | null;
  structureLevel: number | null;
  structurePriority: number;
  structureDensity: number | null;
  samCoverage: number;
  priority: number;
}

interface BuildSearchContext {
  sortedOwnedTiles?: readonly number[];
  borderTileSet?: ReadonlySet<number>;
  borderTiles?: readonly number[];
  hostileFrontTiles?: readonly number[];
  incomingFrontTiles?: readonly number[];
  nukeTargetTiles?: readonly number[];
  landStructureSpawnByTarget: Map<number, number | false>;
}

const DEFENSE_POST_EFFECTIVE_RANGE = 30;
const DEFENSE_POST_FRONTIER_SEARCH_RANGE = 75;
const NEUTRAL_ISLAND_SHORE_SAMPLE_LIMIT = 48;
export const BOAT_OPTION_LIMIT = 6;
const BOAT_TARGET_TILE_LIMIT = 16;
export const NEUTRAL_ISLAND_TRANSPORT_SCAN_LIMIT = 80;
export const WARSHIP_MOVE_OPTION_LIMIT = 6;
const WARSHIP_DEPLOY_PORT_LIMIT = 3;
const WARSHIP_DEPLOY_SEARCH_RADIUS = 12;
const WARSHIP_DEPLOY_TILES_PER_PORT = 8;
const WARSHIP_DEPLOY_TILE_LIMIT = 24;
const WARSHIP_PATROL_MIN_REPOSITION_DIST = 8;
export const BUILD_OPTION_CANDIDATES = [
  { unit: UnitType.DefensePost, role: "defensive" },
  { unit: UnitType.City, role: "economic" },
  { unit: UnitType.Port, role: "economic" },
  { unit: UnitType.Warship, role: "defensive" },
  { unit: UnitType.Factory, role: "economic" },
  { unit: UnitType.SAMLauncher, role: "defensive" },
  { unit: UnitType.MissileSilo, role: "infrastructure" },
  { unit: UnitType.AtomBomb, role: "infrastructure" },
  { unit: UnitType.HydrogenBomb, role: "infrastructure" },
  { unit: UnitType.MIRV, role: "infrastructure" },
] as const satisfies readonly Pick<AgentBuildOption, "unit" | "role">[];

type BuildOptionUnit = (typeof BUILD_OPTION_CANDIDATES)[number]["unit"];

// These types share PlayerImpl's landBasedStructureSpawn path after eligibility checks.
export const SHARED_LAND_STRUCTURE_BUILD_TYPES = [
  UnitType.DefensePost,
  UnitType.City,
  UnitType.Factory,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
] as const satisfies readonly UnitType[];
const SHARED_LAND_STRUCTURE_BUILD_TYPE_SET: ReadonlySet<UnitType> = new Set(
  SHARED_LAND_STRUCTURE_BUILD_TYPES,
);

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface ObservationBuilderLike {
  build(input: BuildAgentObservationInput): AgentObservation;
  summarize(observation: AgentObservation): string;
  withObservationBatch<T>(
    gameState: Game | undefined,
    callback: () => SynchronousResult<T>,
  ): T;
}

export interface BuildAgentObservationInput {
  agentID: string;
  clientID: string | null;
  username: string;
  profile: AgentStrategyProfile;
  gameID: string;
  turnNumber: number;
  gameState?: Game;
  phaseOverride?: AgentGamePhase;
  objective?: AgentObjectiveState | null;
  recentDecisions?: RecentAgentDecision[];
  recentCommunications?: AgentCommunicationSignal[];
}

export class AgentObservationBuilder {
  private neutralIslandTransportTileCache: {
    gameState: Game;
    tick: number;
    tiles: readonly number[] | null;
  } | null = null;
  private spatialObservationBatchCache: {
    gameState: Game;
    snapshot: AgentSpatialSnapshot | null;
  } | null = null;

  /** Shares work while a synchronous, non-mutating callback builds one snapshot. */
  withObservationBatch<T>(
    gameState: Game | undefined,
    callback: () => SynchronousResult<T>,
  ): T {
    const previousCache = this.neutralIslandTransportTileCache;
    const previousSpatialCache = this.spatialObservationBatchCache;
    const cache =
      gameState === undefined
        ? null
        : { gameState, tick: gameState.ticks(), tiles: null };
    this.neutralIslandTransportTileCache = cache;
    this.spatialObservationBatchCache =
      gameState === undefined ? null : { gameState, snapshot: null };
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        throw new Error("observation batch callback must be synchronous");
      }
      if (cache !== null) {
        this.assertObservationBatchTick(cache);
      }
      return result as T;
    } finally {
      this.neutralIslandTransportTileCache = previousCache;
      this.spatialObservationBatchCache = previousSpatialCache;
    }
  }

  build(input: BuildAgentObservationInput): AgentObservation {
    const notes: string[] = [];
    const phase = input.phaseOverride ?? this.phaseFromGame(input.gameState);
    const tick = input.gameState?.ticks() ?? null;
    const player =
      input.clientID && input.gameState
        ? input.gameState.playerByClientID(input.clientID)
        : null;

    if (input.gameState === undefined) {
      notes.push("core game snapshot unavailable");
    }
    if (input.clientID === null) {
      notes.push("agent client id unavailable");
    }
    if (input.gameState !== undefined && player === null) {
      notes.push("agent player not found in core game snapshot");
    }

    const ownState =
      input.gameState && player ? this.ownState(input.gameState, player) : null;
    const visiblePlayers =
      input.gameState && player
        ? this.visiblePlayers(input.gameState, player)
        : [];
    const spatial =
      input.gameState && player
        ? this.spatialObservation(input.gameState, player, visiblePlayers)
        : undefined;
    const mapInfo =
      input.gameState !== undefined && spatialObservationEnabled()
        ? buildSpatialMapInfo(input.gameState)
        : undefined;
    if (spatial !== undefined) notes.push(...spatial.notes);
    const combat = this.combatState(
      input.gameState,
      player,
      ownState,
      visiblePlayers,
    );
    const nonCombat = this.nonCombatState(
      input.gameState,
      player,
      visiblePlayers,
    );
    const strategic = new AgentStrategicStateBuilder().build({
      profile: input.profile,
      phase,
      ownState,
      visiblePlayers,
      combat,
      nonCombat,
    });
    const memory = new AgentMemoryBuilder().build({
      recentDecisions: input.recentDecisions,
    });
    // Flag-gated economy block (PROXYWAR_TUNE_ECONOMY_OBSERVATION). NOT a
    // pure call: when the flag is on it also decorates the visiblePlayers
    // entries in place (rival unitCounts + isTraitor) before returning the
    // block. When the flag is off it returns undefined, mutates nothing, and
    // the observation is byte-identical to shipped behavior.
    const economy = buildEconomyObservationExtension({
      gameState: input.gameState,
      player,
      visiblePlayers,
    });
    const tacticalAffordances = buildAgentTacticalAffordances({
      observation: {
        agentID: input.agentID,
        clientID: input.clientID,
        username: input.username,
        profile: input.profile,
        gameID: input.gameID,
        phase,
        turnNumber: input.turnNumber,
        tick,
        ownState,
        visiblePlayers,
        ...(spatial !== undefined ? { spatial: spatial.spatial } : {}),
        ...(mapInfo !== undefined ? { mapInfo } : {}),
        combat,
        nonCombat,
        strategic,
        memory,
        objective: input.objective ?? null,
        recentDecisions: input.recentDecisions ?? [],
        recentCommunications: input.recentCommunications ?? [],
        ...(economy !== undefined ? { economy } : {}),
        endgame: this.endgameState(input.gameState, player),
        notes,
      },
    });

    return {
      agentID: input.agentID,
      clientID: input.clientID,
      username: input.username,
      profile: input.profile,
      gameID: input.gameID,
      gameMode: player !== null && player.team() !== null ? "Team" : "FFA",
      alivePlayerCount: input.gameState
        ? input.gameState.players().filter((candidate) => candidate.isAlive())
            .length
        : undefined,
      phase,
      turnNumber: input.turnNumber,
      tick,
      ownState,
      visiblePlayers,
      ...(spatial !== undefined ? { spatial: spatial.spatial } : {}),
      ...(mapInfo !== undefined ? { mapInfo } : {}),
      combat,
      nonCombat,
      strategic,
      memory,
      tacticalAffordances,
      objective: input.objective ?? null,
      recentDecisions: input.recentDecisions ?? [],
      recentCommunications: input.recentCommunications ?? [],
      ...(economy !== undefined ? { economy } : {}),
      endgame: this.endgameState(input.gameState, player),
      notes,
    };
  }

  private spatialObservation(
    gameState: Game,
    player: Player,
    visiblePlayers: AgentVisiblePlayer[],
  ): SpatialObservationExtension | undefined {
    if (!spatialObservationEnabled() || player.numTilesOwned() === 0) {
      return undefined;
    }
    const batch = this.spatialObservationBatchCache;
    if (batch === null || batch.gameState !== gameState) {
      return buildSpatialObservationExtension({
        gameState,
        player,
        visiblePlayers,
      });
    }
    batch.snapshot ??= createAgentSpatialSnapshot(
      gameState,
      spatialMinimapEnabled(),
    );
    return buildSpatialObservationExtension({
      gameState,
      player,
      visiblePlayers,
      snapshot: batch.snapshot,
    });
  }

  summarize(observation: AgentObservation): string {
    const own = observation.ownState;
    const ownText = own
      ? `${own.tilesOwned} tiles, ${own.troops} troops`
      : "own state unavailable";
    const objective = observation.objective
      ? `${observation.objective.kind}/${observation.objective.status}`
      : "none";
    const banking = observation.tacticalAffordances?.transportTroopBanking;
    const bankingText =
      banking &&
      (banking.recommended ||
        banking.activeTransportTroops > 0 ||
        banking.largestAvailableBoatLaunchTroops > 0)
        ? `, banking=${banking.recommended ? "recommended" : "watch"} active=${banking.activeTransportTroops} launch=${banking.largestAvailableBoatLaunchTroops}`
        : "";
    const economy = observation.tacticalAffordances?.economyCadence;
    const economyText =
      economy && (economy.recommended || economy.economyBuildActionCount > 0)
        ? `, economy=${economy.recommended ? "recommended" : "watch"} best=${economy.bestBuildUnit ?? "unknown"}`
        : "";
    const finish = observation.tacticalAffordances?.frontierFinishPressure;
    const finishText =
      finish && (finish.recommended || finish.repeatedLowCommitmentProbe)
        ? `, finish=${finish.recommended ? "recommended" : "watch"} target=${finish.bestTargetName ?? finish.activeTargetName ?? "unknown"}`
        : "";
    const naval = observation.tacticalAffordances?.navalControl;
    const navalText =
      naval && (naval.recommended || naval.safeNavalActionCount > 0)
        ? `, naval=${naval.recommended ? "recommended" : "watch"} best=${naval.bestNavalActionKind ?? "unknown"}`
        : "";
    const strike = observation.tacticalAffordances?.lateGameStrikeTargeting;
    const strikeText =
      strike && (strike.recommended || strike.legalStrikeActionCount > 0)
        ? `, strike=${strike.recommended ? "recommended" : "watch"} best=${strike.bestStrikeTargetStructureUnit ?? strike.bestStrikeWeapon ?? "unknown"}`
        : "";
    const personality =
      observation.tacticalAffordances?.personalityDiplomacyPressure;
    const personalityText =
      personality &&
      (personality.recommended || personality.socialActionCount > 0)
        ? `, personality=${personality.recommended ? "recommended" : "watch"} best=${personality.bestSocialActionKind ?? "unknown"}`
        : "";
    const communicationText =
      (observation.recentCommunications?.length ?? 0) > 0
        ? `, comms=${(observation.recentCommunications ?? [])
            .slice(-3)
            .map((signal) =>
              signal.targetName
                ? `${signal.senderName}->${signal.targetName}:${signal.intent}`
                : `${signal.senderName}:${signal.intent}`,
            )
            .join("|")}`
        : "";
    return `${observation.profile} ${observation.username}: phase=${observation.phase}, tick=${observation.tick ?? "unknown"}, own=${ownText}, visible=${observation.visiblePlayers.length}, attackable=${observation.combat.attackablePlayerIDs.length}, bordered=${observation.combat.borderedPlayerIDs.length}, builds=${observation.nonCombat.buildOptions.length}, upgrades=${observation.nonCombat.upgradeOptions?.length ?? 0}, boats=${observation.nonCombat.boatOptions?.length ?? 0}, support=${observation.nonCombat.supportOptions.length}, embargo=${observation.nonCombat.embargoOptions.length}, strategy=${observation.strategic.priority}/${observation.strategic.urgency}, memory=${observation.memory.summary}, objective=${objective}${bankingText}${economyText}${finishText}${navalText}${strikeText}${personalityText}${communicationText}`;
  }

  private phaseFromGame(gameState?: Game): AgentGamePhase {
    if (gameState === undefined) {
      return "unknown";
    }
    if (gameState.getWinner() !== null) {
      return "finished";
    }
    return gameState.inSpawnPhase() ? "spawn" : "active";
  }

  private ownState(gameState: Game, player: Player): AgentOwnState {
    const maxTroops = gameState.config().maxTroops(player);
    const tileShare = share(player.numTilesOwned(), gameState.numLandTiles());
    return {
      playerID: player.id(),
      clientID: player.clientID(),
      smallID: player.smallID(),
      name: player.name(),
      type: player.type(),
      isAlive: player.isAlive(),
      isDisconnected: player.isDisconnected(),
      isTraitor: player.isTraitor(),
      hasSpawned: player.hasSpawned(),
      team: player.team(),
      troops: player.troops(),
      maxTroops,
      troopRatio: roundRatio(player.troops() / Math.max(maxTroops, 1)),
      gold: player.gold().toString(),
      tilesOwned: player.numTilesOwned(),
      tileShare,
      borderTiles: player.borderTiles().size,
      outgoingAttacks: player.outgoingAttacks().length,
      incomingAttacks: player.incomingAttacks().length,
      outgoingAllianceRequests: player.outgoingAllianceRequests().length,
      incomingAllianceRequests: player.incomingAllianceRequests().length,
      unitCounts: ownUnitCounts(player),
      ...(player.spawnTile() !== undefined
        ? { spawnTile: player.spawnTile() }
        : {}),
    };
  }

  private visiblePlayers(
    gameState: Game,
    player: Player,
  ): AgentVisiblePlayer[] {
    return gameState
      .players()
      .filter((other) => other.id() !== player.id())
      .map((other) => {
        const sharesBorder = player.sharesBorderWith(other);
        const canAttack = sharesBorder && player.canAttackPlayer(other);
        const attackBlocker = canAttack
          ? undefined
          : this.attackBlocker(player, other, sharesBorder);
        const relativeTroopRatio =
          other.troops() > 0
            ? roundRatio(player.troops() / other.troops())
            : undefined;
        const maxTroops = gameState.config().maxTroops(other);
        const allianceInfo = player.allianceInfo(other);
        const hasIncomingAllianceRequest = player
          .incomingAllianceRequests()
          .some((request) => request.requestor() === other);
        const hasOutgoingAllianceRequest = player
          .outgoingAllianceRequests()
          .some((request) => request.recipient() === other);
        // Rival-rival coalition edge: who THIS rival is allied with, other than us.
        // Alliances are public game state, so this is observable for any pair; the agent
        // already learns its own alliance with `other` via isAllied below. Deterministic
        // (reads the ordered ally list only — no RNG/wall-clock).
        const alliedWithVisibleIds = other
          .allies()
          .filter(
            (ally) => ally.id() !== player.id() && ally.id() !== other.id(),
          )
          .map((ally) => ally.id());

        return {
          playerID: other.id(),
          clientID: other.clientID(),
          smallID: other.smallID(),
          name: other.name(),
          type: other.type(),
          isAlive: other.isAlive(),
          isDisconnected: other.isDisconnected(),
          hasSpawned: other.hasSpawned(),
          troops: other.troops(),
          maxTroops,
          troopRatio: roundRatio(other.troops() / Math.max(maxTroops, 1)),
          gold: other.gold().toString(),
          tilesOwned: other.numTilesOwned(),
          tileShare: share(other.numTilesOwned(), gameState.numLandTiles()),
          sharesBorder,
          isAllied: player.isAlliedWith(other),
          isFriendly: player.isFriendly(other),
          relation: player.relation(other),
          team: other.team(),
          isTeammate: player.isOnSameTeam(other),
          canAttack,
          ...(canAttack
            ? {
                attackLegalReason:
                  "shares border and core canAttackPlayer is true",
              }
            : {}),
          ...(attackBlocker ? { attackBlocker } : {}),
          canRequestAlliance: player.canSendAllianceRequest(other),
          canDonateGold: player.canDonateGold(other),
          canDonateTroops: player.canDonateTroops(other),
          canEmbargo:
            other.isAlive() &&
            !player.isFriendly(other) &&
            !player.hasEmbargoAgainst(other),
          canStopEmbargo: player.hasEmbargoAgainst(other),
          canTarget: player.canTarget(other),
          canBreakAlliance: player.allianceWith(other) !== null,
          canExtendAlliance: allianceInfo?.canExtend ?? false,
          canRejectAlliance: hasIncomingAllianceRequest,
          hasEmbargoAgainst: player.hasEmbargoAgainst(other),
          outgoingAttack: player
            .outgoingAttacks()
            .some((attack) => attack.target() === other),
          incomingAttack: player
            .incomingAttacks()
            .some((attack) => attack.attacker() === other),
          // Rival-under-siege signal (0.1.6): incomingAttack above is
          // AGENT-relative ("this rival is attacking ME"). underSiege is the
          // rival's own state — ANY live attack on them, from anyone — the
          // signal coalition support needs ("prop up the leader's victim")
          // that was previously underivable from the observation.
          ...(other.incomingAttacks().length > 0 ? { underSiege: true } : {}),
          hasOutgoingAllianceRequest,
          hasIncomingAllianceRequest,
          ...(allianceInfo !== null
            ? {
                allianceExpiresAt: allianceInfo.expiresAt,
                allianceInExtensionWindow: allianceInfo.inExtensionWindow,
                // Renewal is MUTUAL: the core extends only once both sides have
                // asked. Dropping these two left an agent unable to see that its
                // ally was already waiting on it, which is why 40 of 42 hosted
                // renewal attempts died one-sided.
                allianceSelfAgreedToExtend: allianceInfo.myPlayerAgreedToExtend,
                allianceOtherAgreedToExtend: allianceInfo.otherAgreedToExtend,
              }
            : {}),
          ...(relativeTroopRatio !== undefined ? { relativeTroopRatio } : {}),
          ...(alliedWithVisibleIds.length > 0 ? { alliedWithVisibleIds } : {}),
          ...this.spawnDistance(gameState, player, other),
        };
      });
  }

  private combatState(
    gameState: Game | undefined,
    player: Player | null,
    ownState: AgentOwnState | null,
    visiblePlayers: AgentVisiblePlayer[],
  ): AgentCombatState {
    const attackable = visiblePlayers.filter(
      (player) => player.canAttack && !player.isFriendly,
    );
    const bordered = visiblePlayers.filter((player) => player.sharesBorder);
    const canExpandIntoNeutral =
      player !== null &&
      player.isAlive() &&
      player.hasSpawned() &&
      player.nearby().some((neighbor) => !neighbor.isPlayer());
    const blockerNotes: string[] = [];

    if (ownState === null) {
      blockerNotes.push("own player state unavailable");
    }
    if (visiblePlayers.length > 0 && bordered.length === 0) {
      blockerNotes.push("no visible hostile borders in current snapshot");
    }
    if (bordered.length > 0 && attackable.length === 0) {
      blockerNotes.push(
        "bordered players exist but core canAttackPlayer returned false",
      );
    }
    if (player !== null && !canExpandIntoNeutral) {
      blockerNotes.push("no adjacent unowned land is currently visible");
    }

    const byTroops = [...attackable].sort((a, b) => a.troops - b.troops);

    return {
      ownTroops: ownState?.troops ?? null,
      maxTroops: ownState?.maxTroops ?? null,
      troopRatio: ownState?.troopRatio ?? null,
      borderedPlayerIDs: bordered.map((player) => player.playerID),
      attackablePlayerIDs: attackable.map((player) => player.playerID),
      canExpandIntoNeutral,
      neutralExpansionLegalReason: canExpandIntoNeutral
        ? "player is alive, spawned, and core nearby() includes Terra Nullius"
        : null,
      incomingAttackPlayerIDs: visiblePlayers
        .filter((player) => player.incomingAttack)
        .map((player) => player.playerID),
      outgoingAttackPlayerIDs: visiblePlayers
        .filter((player) => player.outgoingAttack)
        .map((player) => player.playerID),
      outgoingAttacks:
        gameState && player
          ? player.outgoingAttacks().map((attack) => ({
              attackID: attack.id(),
              targetID: attack.target().id(),
              targetName: targetName(attack.target()),
              troops: attack.troops(),
              retreating: attack.retreating(),
              sourceTile: attack.sourceTile(),
              borderSize: attack.borderSize(),
            }))
          : [],
      incomingAttacks:
        gameState && player
          ? player.incomingAttacks().map((attack) => ({
              attackID: attack.id(),
              targetID: attack.attacker().id(),
              targetName: attack.attacker().name(),
              troops: attack.troops(),
              retreating: attack.retreating(),
              sourceTile: attack.sourceTile(),
              borderSize: attack.borderSize(),
            }))
          : [],
      weakestAttackableTargetID: byTroops[0]?.playerID ?? null,
      strongestAttackableTargetID:
        byTroops[byTroops.length - 1]?.playerID ?? null,
      blockerNotes,
    };
  }

  private nonCombatState(
    gameState: Game | undefined,
    player: Player | null,
    visiblePlayers: AgentVisiblePlayer[],
  ): AgentNonCombatState {
    const buildOptions =
      gameState && player ? this.buildOptions(gameState, player) : [];
    const upgradeOptions =
      gameState && player ? this.upgradeOptions(gameState, player) : [];
    const deleteUnitOptions =
      gameState && player ? this.deleteUnitOptions(player) : [];
    const boatOptions =
      gameState && player ? this.boatOptions(gameState, player) : [];
    const warshipMoveOptions =
      gameState && player ? this.warshipMoveOptions(gameState, player) : [];
    const transportStates =
      gameState && player ? this.transportStates(gameState, player) : [];
    const maximumTransportCount = gameState?.config().boatMaxNumber() ?? 0;
    const launchSlotsRemaining = Math.max(
      0,
      maximumTransportCount - transportStates.length,
    );
    const transportLaunch =
      gameState && player
        ? {
            activeTransportCount: transportStates.length,
            maximumTransportCount,
            launchSlotsRemaining,
            blocker: gameState.config().isUnitDisabled(UnitType.TransportShip)
              ? ("transport_disabled" as const)
              : launchSlotsRemaining === 0
                ? ("transport_cap_reached" as const)
                : boatOptions.length === 0
                  ? ("no_reachable_target" as const)
                  : null,
          }
        : undefined;
    const allianceOptions = this.allianceOptions(visiblePlayers);
    const targetOptions = this.targetOptions(visiblePlayers);
    const emojiOptions = this.emojiOptions(visiblePlayers);
    const nuclearThreatReady =
      gameState !== undefined &&
      player !== null &&
      (player.units(UnitType.MissileSilo).length > 0 ||
        // Nukes only: a Warship build option is naval, not a nuclear threat.
        buildOptions.some((build) => Nukes.has(build.unit)));
    const quickChatOptions = this.quickChatOptions(visiblePlayers, {
      nuclearThreatReady,
    });
    const donateToNonFriendly =
      gameState?.config().donateToNonFriendly() === true;
    const supportOptions = visiblePlayers
      .filter((other) => other.canDonateGold || other.canDonateTroops)
      .map((other) => ({
        recipientID: other.playerID,
        recipientName: other.name,
        canDonateGold: other.canDonateGold,
        canDonateTroops: other.canDonateTroops,
        suggestedGold: suggestedGold(player, other.canDonateGold),
        suggestedTroops: suggestedTroops(player, other.canDonateTroops),
        legalReasons: [
          ...(other.canDonateGold
            ? [
                other.isFriendly
                  ? "core canDonateGold returned true"
                  : "core canDonateGold returned true because this game permits non-friendly donations",
              ]
            : []),
          ...(other.canDonateTroops
            ? [
                other.isFriendly
                  ? "core canDonateTroops returned true"
                  : "core canDonateTroops returned true because this game permits non-friendly donations",
              ]
            : []),
        ],
      }));
    const embargoOptions: AgentEmbargoOption[] = visiblePlayers
      .filter((other) => other.canEmbargo || other.canStopEmbargo)
      .map((other) => ({
        targetID: other.playerID,
        targetName: other.name,
        action: other.canStopEmbargo ? "stop" : ("start" as const),
        legalReason: other.canStopEmbargo
          ? "existing outgoing embargo can be stopped"
          : "target is alive, not friendly, and no existing embargo is active",
      }));
    const blockerNotes: string[] = [];

    if (player === null) {
      blockerNotes.push("own player state unavailable");
    }
    if (gameState === undefined) {
      blockerNotes.push("core game snapshot unavailable");
    }
    if (gameState && player && buildOptions.length === 0) {
      blockerNotes.push(
        "no City, Factory, or Defense Post build location is currently affordable and valid",
      );
    }
    if (visiblePlayers.length > 0 && supportOptions.length === 0) {
      blockerNotes.push(
        donateToNonFriendly
          ? "no other alive, connected player currently passes donation rules"
          : "no friendly/allied player currently passes donation rules",
      );
    }
    if (visiblePlayers.length > 0 && embargoOptions.length === 0) {
      blockerNotes.push(
        "no non-friendly player without an existing embargo is available",
      );
    }
    if (transportLaunch?.blocker === "transport_cap_reached") {
      blockerNotes.push(
        `${transportStates.length} active or returning transports occupy all ${maximumTransportCount} launch slots`,
      );
    } else if (transportLaunch?.blocker === "no_reachable_target") {
      blockerNotes.push(
        "no neutral or hostile coastline is currently reachable by transport",
      );
    }

    return {
      buildOptions,
      upgradeOptions,
      deleteUnitOptions,
      boatOptions,
      transportStates,
      transportLaunch,
      warshipMoveOptions,
      allianceOptions,
      targetOptions,
      emojiOptions,
      quickChatOptions,
      ...(donateToNonFriendly ? { donateToNonFriendly: true as const } : {}),
      supportOptions,
      embargoOptions,
      canEmbargoAll: player?.canEmbargoAll() ?? false,
      blockerNotes,
    };
  }

  private buildSearchContext(): BuildSearchContext {
    return { landStructureSpawnByTarget: new Map() };
  }

  private prepareOwnedBuildSearch(
    gameState: Game,
    player: Player,
    context: BuildSearchContext,
  ): BuildSearchContext {
    if (context.sortedOwnedTiles !== undefined) {
      return context;
    }
    const borderTileSet = player.borderTiles();
    context.sortedOwnedTiles = Array.from(player.tiles()).sort(
      buildSearchTileComparator(gameState, player.spawnTile()),
    );
    context.borderTileSet = borderTileSet;
    context.borderTiles = Array.from(borderTileSet);
    context.hostileFrontTiles = this.hostileFrontTiles(gameState, player);
    context.incomingFrontTiles = this.incomingAttackFrontTiles(
      gameState,
      player,
    );
    return context;
  }

  private buildOptions(gameState: Game, player: Player): AgentBuildOption[] {
    if (!player.isAlive()) {
      return [];
    }

    const config = gameState.config();
    const options: AgentBuildOption[] = [];
    let context: BuildSearchContext | undefined;

    for (const option of BUILD_OPTION_CANDIDATES) {
      if (config.isUnitDisabled(option.unit)) {
        continue;
      }
      const cost = config.unitInfo(option.unit).cost(gameState, player);
      if (player.gold() < cost) {
        continue;
      }
      context ??= this.buildSearchContext();
      const target = this.findBuildTarget(
        gameState,
        player,
        option.unit,
        context,
      );
      if (target === null) {
        continue;
      }
      options.push({
        unit: option.unit,
        role: option.role,
        targetTile: target.targetTile,
        buildTile: target.buildTile,
        cost: cost.toString(),
        legalReason: target.usedCachedSpawn
          ? `shared land-structure spawn check returned build tile ${target.buildTile}`
          : `core canBuild(${option.unit}) returned build tile ${target.buildTile}`,
        ...target.placement,
      });
    }

    return options;
  }

  private findBuildTarget(
    gameState: Game,
    player: Player,
    unit: BuildOptionUnit,
    context: BuildSearchContext,
  ): BuildTargetCandidate | null {
    let best: BuildTargetCandidate | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const cache = SHARED_LAND_STRUCTURE_BUILD_TYPE_SET.has(unit)
      ? context.landStructureSpawnByTarget
      : undefined;
    for (const tile of this.buildSearchTiles(
      gameState,
      player,
      unit,
      context,
    ).slice(0, buildCandidateLimit(unit))) {
      let buildTile = cache?.get(tile);
      const usedCachedSpawn = buildTile !== undefined;
      if (buildTile === undefined) {
        buildTile = player.canBuild(unit, tile);
        cache?.set(tile, buildTile);
      }
      if (buildTile !== false) {
        const placement = this.buildPlacementAnalysis(
          gameState,
          player,
          unit,
          tile,
          buildTile,
          context,
        );
        if (
          unit === UnitType.DefensePost &&
          !isUsefulDefensePostPlacement(placement)
        ) {
          continue;
        }
        const score = buildPlacementScore(unit, placement);
        if (score > bestScore) {
          best = { targetTile: tile, buildTile, usedCachedSpawn, placement };
          bestScore = score;
        }
      }
    }
    return best;
  }

  private buildSearchTiles(
    gameState: Game,
    player: Player,
    unit: BuildOptionUnit,
    context: BuildSearchContext,
  ): readonly number[] {
    // Warship is in core's BuildableAttacks group (it builds onto a target
    // tile), but its targets are own-sea patrol anchors, never nuke targets —
    // so it must branch before the nuke-target search below.
    if (unit === UnitType.Warship) {
      return this.warshipDeployTargetTiles(gameState, player);
    }
    if (BuildableAttacks.has(unit)) {
      context.nukeTargetTiles ??= this.nukeTargetTiles(gameState, player);
      return context.nukeTargetTiles;
    }
    this.prepareOwnedBuildSearch(gameState, player, context);
    const sortedOwnedTiles = context.sortedOwnedTiles!;
    if (unit === UnitType.DefensePost) {
      return sortedOwnedTiles.filter((tile) =>
        context.borderTileSet!.has(tile),
      );
    } else if (unit === UnitType.Port) {
      return sortedOwnedTiles.filter((tile) => gameState.isShore(tile));
    } else {
      return sortedOwnedTiles;
    }
  }

  /**
   * Water patrol-anchor candidates for building a new Warship. Core placement
   * (PlayerImpl.warshipSpawn) requires the TARGET tile to be water and an
   * active, finished own Port in the same water component; the hull spawns at
   * that Port while the target tile becomes the initial patrol anchor
   * (ConstructionExecution passes it as `patrolTile`). Candidates prefer the
   * outer edge of a bounded ring around each Port so a new warship patrols
   * the trade and landing lanes instead of hugging the dock. Every candidate
   * is re-validated through core `canBuild` in findBuildTarget.
   */
  private warshipDeployTargetTiles(
    gameState: Game,
    player: Player,
  ): readonly number[] {
    const ports = player
      .units(UnitType.Port)
      .filter((port) => port.isActive() && !port.isUnderConstruction())
      .sort((a, b) => a.id() - b.id())
      .slice(0, WARSHIP_DEPLOY_PORT_LIMIT);
    if (ports.length === 0) {
      return [];
    }
    const candidates: number[] = [];
    const seen = new Set<number>();
    for (const port of ports) {
      const portTile = port.tile();
      const reachable = gameState.bfs(
        portTile,
        (gm, tile) =>
          tile === portTile ||
          (gm.isWater(tile) &&
            gm.manhattanDist(portTile, tile) <= WARSHIP_DEPLOY_SEARCH_RADIUS),
      );
      const water = Array.from(reachable)
        .filter((tile) => tile !== portTile)
        .sort(
          (a, b) =>
            gameState.manhattanDist(portTile, b) -
              gameState.manhattanDist(portTile, a) || a - b,
        )
        .slice(0, WARSHIP_DEPLOY_TILES_PER_PORT);
      for (const tile of water) {
        if (!seen.has(tile)) {
          seen.add(tile);
          candidates.push(tile);
        }
      }
      if (candidates.length >= WARSHIP_DEPLOY_TILE_LIMIT) {
        break;
      }
    }
    return candidates.slice(0, WARSHIP_DEPLOY_TILE_LIMIT);
  }

  private buildPlacementAnalysis(
    gameState: Game,
    player: Player,
    unit: BuildOptionUnit,
    targetTile: number,
    buildTile: number,
    context: BuildSearchContext,
  ): BuildPlacementAnalysis {
    this.prepareOwnedBuildSearch(gameState, player, context);
    const borderDistance = nearestManhattanDistance(
      gameState,
      buildTile,
      context.borderTiles!,
    );
    const hostileBorderDistance = nearestManhattanDistanceOrNull(
      gameState,
      buildTile,
      context.hostileFrontTiles!,
    );
    const incomingFrontDistance = nearestManhattanDistanceOrNull(
      gameState,
      buildTile,
      context.incomingFrontTiles!,
    );
    const nearbyIncomingAttack =
      incomingFrontDistance !== null &&
      incomingFrontDistance <= DEFENSE_POST_FRONTIER_SEARCH_RANGE;
    const local = this.localOwnershipCounts(gameState, player, buildTile);
    const targetLocal =
      targetTile === buildTile
        ? local
        : this.localOwnershipCounts(gameState, player, targetTile);
    const nearbyEnemyCount = Math.max(
      local.nearbyEnemyCount,
      targetLocal.nearbyEnemyCount,
    );
    const nearbyAllyCount = Math.max(
      local.nearbyAllyCount,
      targetLocal.nearbyAllyCount,
    );
    const ownedNeighborCount = Math.max(
      local.ownedNeighborCount,
      targetLocal.ownedNeighborCount,
    );
    const hostileFrontierScore =
      hostileBorderDistance === null
        ? 0
        : clamp01(
            1 - hostileBorderDistance / DEFENSE_POST_FRONTIER_SEARCH_RANGE,
          );
    const incomingScore = nearbyIncomingAttack ? 0.35 : 0;
    const adjacentEnemyScore = Math.min(0.25, nearbyEnemyCount * 0.08);
    const defensiveValue = clamp01(
      hostileFrontierScore * 0.7 + incomingScore + adjacentEnemyScore,
    );
    const frontierValue = clamp01(
      hostileFrontierScore + (borderDistance <= 8 ? 0.15 : 0),
    );
    const safeInteriorScore = clamp01(borderDistance / 80);
    const economicValue = clamp01(
      safeInteriorScore * 0.45 +
        Math.min(0.3, ownedNeighborCount / 20) +
        (nearbyEnemyCount === 0 ? 0.25 : 0) +
        (unit === UnitType.City || unit === UnitType.Factory ? 0.05 : 0),
    );
    const isBorderBuild =
      hostileBorderDistance !== null &&
      hostileBorderDistance <= DEFENSE_POST_FRONTIER_SEARCH_RANGE;
    // Nukes only: Warship is in BuildableAttacks but has no nuke target.
    const nukeTarget = Nukes.has(unit)
      ? this.nukeTargetAnalysis(gameState, player, targetTile)
      : null;

    return {
      isBorderBuild,
      borderDistance,
      hostileBorderDistance,
      nearbyEnemyCount,
      nearbyAllyCount,
      nearbyIncomingAttack,
      ownedNeighborCount,
      frontierValue,
      economicValue,
      defensiveValue,
      buildPlacementReason: buildPlacementReason(unit, {
        isBorderBuild,
        borderDistance,
        hostileBorderDistance,
        nearbyIncomingAttack,
        nearbyEnemyCount,
        ownedNeighborCount,
        frontierValue,
        economicValue,
        defensiveValue,
      }),
      ...(nukeTarget === null
        ? {}
        : {
            nukeTargetID: nukeTarget.targetID,
            nukeTargetName: nukeTarget.targetName,
            nukeTargetTiles: nukeTarget.targetTiles,
            nukeTargetTileShare: nukeTarget.targetTileShare,
            nukeTargetStructureUnit: nukeTarget.structureUnit,
            nukeTargetStructureLevel: nukeTarget.structureLevel,
            nukeTargetStructurePriority: nukeTarget.structurePriority,
            nukeTargetStructureDensity: nukeTarget.structureDensity,
            nukeTargetSamCoverage: nukeTarget.samCoverage,
            nukeTargetPriority: nukeTarget.priority,
          }),
    };
  }

  private hostileFrontTiles(gameState: Game, player: Player): number[] {
    const result: number[] = [];
    outer: for (const borderTile of player.borderTiles()) {
      for (const neighbor of gameState.neighbors(borderTile)) {
        const owner = gameState.owner(neighbor);
        if (
          owner.isPlayer() &&
          owner !== player &&
          owner.isAlive() &&
          !player.isFriendly(owner)
        ) {
          result.push(borderTile);
          continue outer;
        }
      }
    }
    return result;
  }

  private incomingAttackFrontTiles(gameState: Game, player: Player): number[] {
    const attackers = new Set(
      player
        .incomingAttacks()
        .filter((attack) => attack.sourceTile() === null)
        .map((attack) => attack.attacker()),
    );
    if (attackers.size === 0) {
      return [];
    }
    const result: number[] = [];
    outer: for (const borderTile of player.borderTiles()) {
      for (const neighbor of gameState.neighbors(borderTile)) {
        const owner = gameState.owner(neighbor);
        if (owner.isPlayer() && attackers.has(owner)) {
          result.push(borderTile);
          continue outer;
        }
      }
    }
    return result;
  }

  private localOwnershipCounts(
    gameState: Game,
    player: Player,
    tile: number,
  ): {
    nearbyEnemyCount: number;
    nearbyAllyCount: number;
    ownedNeighborCount: number;
  } {
    let nearbyEnemyCount = 0;
    let nearbyAllyCount = 0;
    let ownedNeighborCount = 0;
    for (const neighbor of gameState.neighbors(tile)) {
      const owner = gameState.owner(neighbor);
      if (owner === player) {
        ownedNeighborCount += 1;
      } else if (owner.isPlayer() && owner.isAlive()) {
        if (player.isFriendly(owner)) {
          nearbyAllyCount += 1;
        } else {
          nearbyEnemyCount += 1;
        }
      }
    }
    return { nearbyEnemyCount, nearbyAllyCount, ownedNeighborCount };
  }

  private upgradeOptions(
    gameState: Game,
    player: Player,
  ): AgentUpgradeOption[] {
    return player
      .units(...Structures.types)
      .filter((unit) => player.canUpgradeUnit(unit))
      .sort((a, b) => a.level() - b.level() || a.id() - b.id())
      .slice(0, 8)
      .map((unit) => ({
        unitID: unit.id(),
        unit: unit.type(),
        tile: unit.tile(),
        level: unit.level(),
        cost: gameState
          .config()
          .unitInfo(unit.type())
          .cost(gameState, player)
          .toString(),
        legalReason: `core canUpgradeUnit(${unit.type()}#${unit.id()}) returned true`,
      }));
  }

  private deleteUnitOptions(player: Player): AgentDeleteUnitOption[] {
    if (!player.canDeleteUnit()) {
      return [];
    }
    return player
      .units(...Structures.types)
      .filter(
        (unit) =>
          unit.isActive() &&
          !unit.isMarkedForDeletion() &&
          !unit.isUnderConstruction(),
      )
      .sort((a, b) => a.level() - b.level() || a.id() - b.id())
      .slice(0, 5)
      .map((unit) => ({
        unitID: unit.id(),
        unit: unit.type(),
        tile: unit.tile(),
        level: unit.level(),
        legalReason:
          "core canDeleteUnit returned true and unit is owned/active",
      }));
  }

  private boatOptions(gameState: Game, player: Player): AgentBoatOption[] {
    if (
      gameState.config().isUnitDisabled(UnitType.TransportShip) ||
      player.unitCount(UnitType.TransportShip) >=
        gameState.config().boatMaxNumber()
    ) {
      return [];
    }
    const troops = Math.max(1, Math.floor(player.troops() * 0.08));
    const options: AgentBoatOption[] = [];
    // Per-call canBuild memo, same idiom as landStructureSpawnByTarget.
    const transportSpawnByTarget = new Map<number, number | false>();
    const targetTiles = this.boatTargetTiles(
      gameState,
      player,
      transportSpawnByTarget,
    );
    for (const targetTile of targetTiles) {
      const sourceTile =
        transportSpawnByTarget.get(targetTile) ??
        player.canBuild(UnitType.TransportShip, targetTile);
      if (sourceTile === false) {
        continue;
      }
      const owner = gameState.owner(targetTile);
      options.push({
        targetTile,
        sourceTile,
        targetID: owner.isPlayer() ? owner.id() : null,
        targetName: owner.isPlayer() ? owner.name() : "Terra Nullius",
        troops,
        legalReason: `core canBuild(Transport, ${targetTile}) returned source tile ${sourceTile}`,
      });
      if (options.length >= BOAT_OPTION_LIMIT) {
        break;
      }
    }
    return options;
  }

  private transportStates(
    gameState: Game,
    player: Player,
  ): AgentTransportState[] {
    return player
      .units(UnitType.TransportShip)
      .sort((a, b) => a.id() - b.id())
      .map((unit) => {
        const targetTile = unit.targetTile() ?? null;
        const target = targetTile === null ? null : gameState.owner(targetTile);
        return {
          unitID: unit.id(),
          status: unit.transportShipState().isRetreating
            ? ("returning" as const)
            : ("en_route" as const),
          tile: unit.tile(),
          targetTile,
          targetID: target?.isPlayer() ? target.id() : null,
          targetName: target === null ? null : targetName(target),
          troops: unit.troops(),
          remainingManhattanDistance:
            targetTile === null
              ? null
              : gameState.manhattanDist(unit.tile(), targetTile),
        };
      });
  }

  /**
   * Patrol repositioning for owned Warships. Mirrors what a human can do with
   * a selected warship — order it to any water tile — but offers a bounded,
   * deterministic target menu: own-port anchorages (guard trade), water off
   * the own hostile-facing shoreline (intercept landings), and water beside
   * rival ports (contest their lanes). Each option orders the single closest
   * reachable warship (same water component, like core targeting) and skips
   * near-no-op moves, capped at WARSHIP_MOVE_OPTION_LIMIT like the other
   * option lists. `move_warship` needs no gold and core MoveWarshipExecution
   * accepts any valid water tile for an owned active warship.
   */
  private warshipMoveOptions(
    gameState: Game,
    player: Player,
  ): AgentWarshipMoveOption[] {
    const warships = player
      .units(UnitType.Warship)
      .filter((unit) => unit.isActive())
      .sort((a, b) => a.id() - b.id());
    if (warships.length === 0) {
      return [];
    }
    const options: AgentWarshipMoveOption[] = [];
    const usedTargets = new Set<number>();
    const pushOption = (targetTile: number | null, purpose: string) => {
      if (
        targetTile === null ||
        usedTargets.has(targetTile) ||
        options.length >= WARSHIP_MOVE_OPTION_LIMIT
      ) {
        return;
      }
      const component = gameState.getWaterComponent(targetTile);
      if (component === null) {
        return;
      }
      let best: Unit | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const warship of warships) {
        if (!gameState.hasWaterComponent(warship.tile(), component)) {
          continue;
        }
        const patrolTile = warship.warshipState().patrolTile;
        if (
          patrolTile !== undefined &&
          gameState.manhattanDist(patrolTile, targetTile) <
            WARSHIP_PATROL_MIN_REPOSITION_DIST
        ) {
          // Already patrolling this water; a move order would be a no-op.
          continue;
        }
        const distance = gameState.manhattanDist(warship.tile(), targetTile);
        if (distance < bestDistance) {
          best = warship;
          bestDistance = distance;
        }
      }
      if (best === null) {
        return;
      }
      usedTargets.add(targetTile);
      options.push({
        unitIDs: [best.id()],
        targetTile,
        legalReason: `${purpose}; owned warship ${best.id()} is active in the same sea and core move_warship accepts any water tile`,
      });
    };

    // 1. Guard own trade: the anchorage beside each active own Port.
    const ownPorts = player
      .units(UnitType.Port)
      .filter((port) => port.isActive() && !port.isUnderConstruction())
      .sort((a, b) => a.id() - b.id());
    for (const port of ownPorts.slice(0, 2)) {
      pushOption(
        this.adjacentWaterTile(gameState, port.tile()),
        "guard own port trade lane",
      );
    }

    // 2. Intercept landings: water off the own shoreline facing hostiles.
    const hostileShores = this.hostileFrontTiles(gameState, player).filter(
      (tile) => gameState.isShore(tile),
    );
    for (const index of [0, Math.floor(hostileShores.length / 2)]) {
      const shore = hostileShores[index];
      if (shore !== undefined) {
        pushOption(
          this.adjacentWaterTile(gameState, shore),
          "cover own hostile-facing coastline",
        );
      }
    }

    // 3. Contest rival lanes: water beside the weakest rivals' ports.
    const rivals = gameState
      .players()
      .filter(
        (other) =>
          other !== player && other.isAlive() && !player.isFriendly(other),
      )
      .sort((a, b) => a.troops() - b.troops() || a.id().localeCompare(b.id()));
    outer: for (const rival of rivals) {
      const rivalPorts = rival
        .units(UnitType.Port)
        .sort((a, b) => a.id() - b.id());
      for (const port of rivalPorts) {
        const anchorage = this.adjacentWaterTile(gameState, port.tile());
        if (anchorage !== null) {
          // Rival names are untrusted display text; keep them out of
          // legalReason so prompts and metadata stay name-free.
          pushOption(anchorage, "contest a rival port's trade lane");
          if (options.length >= WARSHIP_MOVE_OPTION_LIMIT) {
            break outer;
          }
          break;
        }
      }
    }
    return options;
  }

  private adjacentWaterTile(gameState: Game, tile: number): number | null {
    if (gameState.isWater(tile)) {
      return tile;
    }
    for (const neighbor of gameState.neighbors(tile)) {
      if (gameState.isWater(neighbor)) {
        return neighbor;
      }
    }
    return null;
  }

  private allianceOptions(
    visiblePlayers: AgentVisiblePlayer[],
  ): AgentAllianceOption[] {
    return visiblePlayers.flatMap((player) => {
      const options: AgentAllianceOption[] = [];
      if (player.canRejectAlliance) {
        options.push({
          playerID: player.playerID,
          playerName: player.name,
          action: "reject",
          legalReason: "incoming alliance request is pending",
        });
      }
      if (player.canExtendAlliance) {
        options.push({
          playerID: player.playerID,
          playerName: player.name,
          action: "extend",
          // The pending-reply case is called out in the reason itself because
          // this string is the ONLY evidence path that survives to
          // decisions.jsonl without touching the decision-log metadata
          // allowlist: LegalActionBuilder copies it into the action's metadata
          // and chosenActionMetadata is written through whole.
          legalReason:
            player.allianceOtherAgreedToExtend === true
              ? "alliance is inside extension window and the ally has already asked to renew; this reply completes the renewal"
              : "alliance is inside extension window",
        });
      }
      if (player.canBreakAlliance) {
        options.push({
          playerID: player.playerID,
          playerName: player.name,
          action: "break",
          legalReason: "active alliance can be broken",
        });
      }
      return options;
    });
  }

  private targetOptions(
    visiblePlayers: AgentVisiblePlayer[],
  ): AgentTargetOption[] {
    return visiblePlayers
      .filter((player) => player.canTarget)
      .map((player) => ({
        targetID: player.playerID,
        targetName: player.name,
        legalReason: "core canTarget returned true",
      }));
  }

  private emojiOptions(
    visiblePlayers: AgentVisiblePlayer[],
  ): AgentEmojiOption[] {
    return visiblePlayers
      .filter((player) => player.isAlive)
      .sort(socialTargetSort)
      .slice(0, 6)
      .map((player) => {
        const reaction = emojiReactionForPlayer(player);
        return {
          recipientID: player.playerID,
          recipientName: player.name,
          emoji: reaction.emoji,
          emojiText: flattenedEmojiTable[reaction.emoji],
          emojiContext: reaction.context,
          legalReason: `${reaction.reason}; recipient is alive and emoji index ${reaction.emoji} is schema-valid`,
        };
      });
  }

  private quickChatOptions(
    visiblePlayers: AgentVisiblePlayer[],
    context: { nuclearThreatReady: boolean } = { nuclearThreatReady: false },
  ): AgentQuickChatOption[] {
    const options = [
      ...coordinationQuickChatOptions(visiblePlayers),
      ...visiblePlayers
        .filter((player) => player.isAlive)
        .sort(socialTargetSort)
        .map((player) => {
          const chat = quickChatForPlayer(player, context);
          return {
            recipientID: player.playerID,
            recipientName: player.name,
            quickChatKey: chat.key,
            message: chat.message,
            nuclearThreat: chat.nuclearThreat,
            ...(chat.requiresTarget
              ? { targetID: player.playerID, targetName: player.name }
              : {}),
            legalReason: `${chat.key} is from resources/QuickChat.json and recipient is alive`,
          };
        }),
    ];
    const seen = new Set<string>();
    return options
      .filter((option) => {
        const key = [
          option.recipientID,
          option.quickChatKey,
          option.targetID ?? "",
        ].join(":");
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }

  private nukeTargetTiles(gameState: Game, player: Player): number[] {
    const candidates: Array<{ tile: number; score: number }> = [];
    const enemies = gameState
      .players()
      .filter(
        (other) =>
          other !== player &&
          other.isAlive() &&
          !player.isFriendly(other) &&
          other.type() !== PlayerType.Bot,
      )
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());

    for (const enemy of enemies) {
      for (const unit of enemy.units(...Structures.types)) {
        const analysis = this.nukeTargetAnalysis(
          gameState,
          player,
          unit.tile(),
        );
        candidates.push({
          tile: unit.tile(),
          score: analysis?.priority ?? 0,
        });
      }
      const spawnTile = enemy.spawnTile();
      if (spawnTile !== undefined) {
        const threat = share(enemy.numTilesOwned(), gameState.numLandTiles());
        candidates.push({
          tile: spawnTile,
          score: 22 + threat * 120,
        });
      }
      for (const tile of enemy.borderTiles()) {
        const threat = share(enemy.numTilesOwned(), gameState.numLandTiles());
        candidates.push({
          tile,
          score: 12 + threat * 80,
        });
        break;
      }
    }
    const seen = new Set<number>();
    return candidates
      .sort((a, b) => b.score - a.score || a.tile - b.tile)
      .filter((candidate) => {
        if (seen.has(candidate.tile)) {
          return false;
        }
        seen.add(candidate.tile);
        return true;
      })
      .slice(0, 16)
      .map((candidate) => candidate.tile);
  }

  private nukeTargetAnalysis(
    gameState: Game,
    player: Player,
    tile: number,
  ): NukeTargetAnalysis | null {
    const owner = gameState.owner(tile);
    if (!owner.isPlayer() || owner === player || player.isFriendly(owner)) {
      return null;
    }
    const targetPlayer = owner;
    const targetTiles = targetPlayer.numTilesOwned();
    const targetTileShare = share(targetTiles, gameState.numLandTiles());
    const targetStructures = targetPlayer.units(...Structures.types);
    const structure = targetStructures.find((unit) => unit.tile() === tile);
    const structureUnit = structure?.type() ?? null;
    const structureLevel = structure?.level() ?? null;
    const structurePriority = nuclearTargetStructurePriority(structureUnit);
    const structureDensity =
      targetTiles > 0
        ? roundRatio(
            targetStructures.reduce((sum, unit) => sum + unit.level(), 0) /
              targetTiles,
          )
        : null;
    let samCoverage = 0;
    for (const sam of targetPlayer.units(UnitType.SAMLauncher)) {
      const range = gameState.config().samRange(sam.level());
      if (gameState.euclideanDistSquared(tile, sam.tile()) <= range * range) {
        samCoverage += sam.level();
      }
    }
    const isLeader = targetTiles >= maxPlayerTiles(gameState, player);
    const priority =
      structurePriority +
      targetTileShare * 140 +
      (isLeader ? 36 : 0) +
      Math.min(36, (structureDensity ?? 0) * 1_800) +
      (structureUnit === UnitType.SAMLauncher ? samCoverage * 8 : 0) -
      (samCoverage > 0 && structureUnit !== UnitType.SAMLauncher ? 10 : 0);
    return {
      targetID: targetPlayer.id(),
      targetName: targetPlayer.name(),
      targetTiles,
      targetTileShare,
      structureUnit,
      structureLevel,
      structurePriority,
      structureDensity,
      samCoverage,
      priority: Math.round(priority),
    };
  }

  private boatTargetTiles(
    gameState: Game,
    player: Player,
    transportSpawnByTarget: Map<number, number | false>,
  ): number[] {
    const reachableWaterComponents = new Set<number>();
    for (const tile of player.borderTiles()) {
      if (!gameState.isShore(tile)) {
        continue;
      }
      const component = gameState.getWaterComponent(tile);
      if (component !== null) {
        reachableWaterComponents.add(component);
      }
    }
    const neutralIslandTiles = this.neutralIslandTransportTiles(
      gameState,
      player,
      reachableWaterComponents,
      transportSpawnByTarget,
    );
    const enemyTiles: number[] = [];
    const enemies = gameState
      .players()
      .filter(
        (other) =>
          other !== player && other.isAlive() && player.canAttackPlayer(other),
      )
      .sort((a, b) => a.troops() - b.troops() || a.id().localeCompare(b.id()));

    for (const enemy of enemies) {
      let reachableShore: number | undefined;
      for (const tile of enemy.borderTiles()) {
        if (!gameState.isShore(tile)) {
          continue;
        }
        const component = gameState.getWaterComponent(tile);
        if (component !== null && reachableWaterComponents.has(component)) {
          reachableShore = tile;
          break;
        }
      }
      if (reachableShore !== undefined) {
        enemyTiles.push(reachableShore);
        // Interleave + slice can never consume entries past this bound.
        if (enemyTiles.length >= BOAT_TARGET_TILE_LIMIT) {
          break;
        }
      }
    }

    const interleavedTargets: number[] = [];
    const targetCount = Math.max(neutralIslandTiles.length, enemyTiles.length);
    for (let index = 0; index < targetCount; index += 1) {
      const enemyTile = enemyTiles[index];
      if (enemyTile !== undefined) {
        interleavedTargets.push(enemyTile);
      }
      const neutralTile = neutralIslandTiles[index];
      if (neutralTile !== undefined) {
        interleavedTargets.push(neutralTile);
      }
    }
    return [...new Set(interleavedTargets)].slice(0, BOAT_TARGET_TILE_LIMIT);
  }

  private neutralIslandTransportTiles(
    gameState: Game,
    player: Player,
    reachableWaterComponents: ReadonlySet<number>,
    transportSpawnByTarget: Map<number, number | false>,
  ): number[] {
    const shores = Array.from(player.borderTiles()).filter((tile) =>
      gameState.isShore(tile),
    );
    if (shores.length === 0) {
      return [];
    }
    const sampledShores = shores.slice(0, NEUTRAL_ISLAND_SHORE_SAMPLE_LIMIT);
    // Bounded insertion keeps the nearest SCAN_LIMIT tiles in (distance, tile)
    // order without allocating and sorting an entry per shore tile map-wide.
    const candidates: Array<{ tile: number; distance: number }> = [];
    for (const tile of this.unownedNonFalloutShoreTiles(gameState)) {
      if (this.touchesOwnedTerritory(gameState, player, tile)) {
        continue;
      }
      const distance = nearestManhattanDistance(gameState, tile, sampledShores);
      const worst = candidates[candidates.length - 1];
      if (
        candidates.length >= NEUTRAL_ISLAND_TRANSPORT_SCAN_LIMIT &&
        (distance > worst.distance ||
          (distance === worst.distance && tile > worst.tile))
      ) {
        continue;
      }
      let low = 0;
      let high = candidates.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        const entry = candidates[mid];
        if (
          entry.distance < distance ||
          (entry.distance === distance && entry.tile < tile)
        ) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      candidates.splice(low, 0, { tile, distance });
      if (candidates.length > NEUTRAL_ISLAND_TRANSPORT_SCAN_LIMIT) {
        candidates.pop();
      }
    }

    const targets: number[] = [];
    for (const candidate of candidates) {
      const component = gameState.getWaterComponent(candidate.tile);
      if (component === null || !reachableWaterComponents.has(component)) {
        // Exactly the condition canBuild's closestShoreByWater would reject
        // this candidate on, minus its radius-50 BFS and border-set copy.
        continue;
      }
      const sourceTile = player.canBuild(
        UnitType.TransportShip,
        candidate.tile,
      );
      transportSpawnByTarget.set(candidate.tile, sourceTile);
      if (sourceTile === false) {
        continue;
      }
      targets.push(candidate.tile);
      // boatOptions never rejects a validated neutral target, so successes
      // beyond BOAT_OPTION_LIMIT could never be consumed.
      if (targets.length >= BOAT_OPTION_LIMIT) {
        break;
      }
    }
    return targets;
  }

  private unownedNonFalloutShoreTiles(gameState: Game): readonly number[] {
    const cached = this.neutralIslandTransportTileCache;
    if (cached?.gameState !== gameState) {
      return this.scanUnownedNonFalloutShoreTiles(gameState);
    }
    this.assertObservationBatchTick(cached);
    return (cached.tiles ??= this.scanUnownedNonFalloutShoreTiles(gameState));
  }

  private assertObservationBatchTick(cache: {
    gameState: Game;
    tick: number;
  }): void {
    if (cache.gameState.ticks() !== cache.tick) {
      throw new Error("game tick changed during observation batch");
    }
  }

  private scanUnownedNonFalloutShoreTiles(gameState: Game): number[] {
    const tiles: number[] = [];
    gameState.forEachTile((tile) => {
      if (
        gameState.isShore(tile) &&
        !gameState.hasOwner(tile) &&
        !gameState.hasFallout(tile)
      ) {
        tiles.push(tile);
      }
    });
    return tiles;
  }

  private touchesOwnedTerritory(
    gameState: Game,
    player: Player,
    tile: number,
  ): boolean {
    // O(1) ownership lookup per neighbor (same pattern as the front-tile scans
    // above). player.tiles() allocates a full copy of the territory set per
    // call — doing that per neighbor inside neutralIslandTransportTiles's
    // whole-map scan was 77% of ALL CPU on shore-dense maps (10p Britannia:
    // profiled 250s of 321s; hosted games died at the episode deadline).
    for (const neighbor of gameState.neighbors(tile)) {
      if (gameState.owner(neighbor) === player) {
        return true;
      }
    }
    return false;
  }

  private endgameState(gameState: Game | undefined, player: Player | null) {
    if (gameState === undefined) {
      return {
        winner: null,
        leaderID: null,
        leaderName: null,
        leaderTileShare: 0,
        ownTileShare: 0,
        turnsToTimer: null,
      };
    }
    const leader = [...gameState.players()].sort(
      (a, b) => b.numTilesOwned() - a.numTilesOwned(),
    )[0];
    const winner = gameState.getWinner();
    const maxTimerValue = gameState.config().gameConfig().maxTimerValue;
    const turnsToTimer =
      maxTimerValue === undefined || maxTimerValue === null
        ? null
        : Math.max(
            0,
            maxTimerValue * 60 * 10 -
              (gameState.ticks() - gameState.config().numSpawnPhaseTurns()),
          );
    return {
      winner:
        winner === null
          ? null
          : typeof winner === "string"
            ? winner
            : winner.name(),
      leaderID: leader?.id() ?? null,
      leaderName: leader?.name() ?? null,
      leaderTileShare: leader
        ? share(leader.numTilesOwned(), gameState.numLandTiles())
        : 0,
      ownTileShare:
        player === null
          ? 0
          : share(player.numTilesOwned(), gameState.numLandTiles()),
      turnsToTimer,
    };
  }

  private attackBlocker(
    player: Player,
    other: Player,
    sharesBorder: boolean,
  ): string {
    if (!other.isAlive()) {
      return "target is not alive";
    }
    if (!other.hasSpawned()) {
      return "target has not spawned";
    }
    if (!sharesBorder) {
      return "no shared border";
    }
    if (player.isFriendly(other)) {
      return "target is friendly";
    }
    return "core canAttackPlayer returned false";
  }

  private spawnDistance(
    gameState: Game,
    player: Player,
    other: Player,
  ): { spawnDistance?: number } {
    const mySpawn = player.spawnTile();
    const otherSpawn = other.spawnTile();
    if (mySpawn === undefined || otherSpawn === undefined) {
      return {};
    }
    // Manhattan distance — |Δref| was |Δy·width + Δx|, garbage as a spatial
    // signal for the external agents and LLM prompts this serializes into.
    return { spawnDistance: gameState.manhattanDist(mySpawn, otherSpawn) };
  }
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

function ownUnitCounts(player: Player): Partial<Record<UnitType, number>> {
  return {
    [UnitType.City]: player.units(UnitType.City).length,
    [UnitType.Factory]: player.units(UnitType.Factory).length,
    [UnitType.DefensePost]: player.units(UnitType.DefensePost).length,
    [UnitType.Port]: player.units(UnitType.Port).length,
    [UnitType.MissileSilo]: player.units(UnitType.MissileSilo).length,
    [UnitType.SAMLauncher]: player.units(UnitType.SAMLauncher).length,
    [UnitType.Warship]: player.units(UnitType.Warship).length,
  };
}

function targetName(target: Player | TerraNullius): string {
  return target.isPlayer() ? target.name() : "Terra Nullius";
}

function share(value: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return roundRatio(value / total);
}

function maxPlayerTiles(gameState: Game, excluded: Player): number {
  return Math.max(
    0,
    ...gameState
      .players()
      .filter((player) => player !== excluded && player.isAlive())
      .map((player) => player.numTilesOwned()),
  );
}

function suggestedGold(
  player: Player | null,
  canDonateGold: boolean,
): number | null {
  if (!canDonateGold || player === null) {
    return null;
  }
  const available = Number(player.gold());
  if (!Number.isFinite(available) || available <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(Math.min(50_000, available / 4)));
}

function suggestedTroops(
  player: Player | null,
  canDonateTroops: boolean,
): number | null {
  if (!canDonateTroops || player === null || player.troops() <= 10) {
    return null;
  }
  return Math.max(1, Math.floor(player.troops() * 0.1));
}

function socialTargetSort(
  a: AgentVisiblePlayer,
  b: AgentVisiblePlayer,
): number {
  return (
    socialTargetScore(b) - socialTargetScore(a) || a.name.localeCompare(b.name)
  );
}

function socialTargetScore(player: AgentVisiblePlayer): number {
  let score = 0;
  if (player.canBreakAlliance) score += 86;
  if (player.incomingAttack) score += 80;
  if (player.canAttack) score += 60;
  if (player.sharesBorder) score += 24;
  if (player.isAllied || player.isFriendly) score += 20;
  if (player.canRequestAlliance) score += 16;
  if ((player.relativeTroopRatio ?? 0) >= 1.35) score += 8;
  return score;
}

export function emojiReactionForPlayer(player: AgentVisiblePlayer): {
  emoji: number;
  context: string;
  reason: string;
} {
  if (player.canBreakAlliance) {
    return {
      emoji: 10,
      context: "betrayal_signal",
      reason:
        "agent can break this alliance, so the evil emoji signals betrayal",
    };
  }
  if (player.incomingAttack) {
    return {
      emoji: 9,
      context: "anger_under_attack",
      reason:
        "player is attacking this agent, so the angry emoji signals retaliation",
    };
  }
  if (!player.isFriendly && !player.isAllied && player.canAttack) {
    if ((player.relativeTroopRatio ?? 0) >= 1.45) {
      return {
        emoji: 11,
        context: "mock_overextended_target",
        reason:
          "target looks weak or overextended, so the clown emoji taunts a bad position",
      };
    }
    return {
      emoji: 41,
      context: "pressure_target",
      reason:
        "target is legally attackable, so the target emoji signals pressure",
    };
  }
  if (player.canRequestAlliance || player.isFriendly || player.isAllied) {
    return {
      emoji: 25,
      context: "alliance_signal",
      reason:
        "player is friendly or alliance-worthy, so the handshake emoji signals cooperation",
    };
  }
  if (player.canEmbargo || player.hasEmbargoAgainst) {
    return {
      emoji: 21,
      context: "disapproval",
      reason:
        "player is a diplomacy-pressure candidate, so thumbs down signals disapproval",
    };
  }
  return {
    emoji: 15,
    context: "greeting",
    reason:
      "no stronger social context is available, so the wave emoji is a light signal",
  };
}

export function quickChatForPlayer(player: AgentVisiblePlayer): {
  key: string;
  message: string;
  requiresTarget: boolean;
  nuclearThreat?: boolean;
};
export function quickChatForPlayer(
  player: AgentVisiblePlayer,
  context: { nuclearThreatReady?: boolean },
): {
  key: string;
  message: string;
  requiresTarget: boolean;
  nuclearThreat?: boolean;
};
export function quickChatForPlayer(
  player: AgentVisiblePlayer,
  context: { nuclearThreatReady?: boolean } = {},
): {
  key: string;
  message: string;
  requiresTarget: boolean;
  nuclearThreat?: boolean;
} {
  if (player.canBreakAlliance) {
    return {
      key: "misc.team_up",
      message: `${player.name}, I can keep this pact or open your border. Convince me.`,
      requiresTarget: false,
    };
  }
  if (player.incomingAttack) {
    return {
      key: "defend.defend_from",
      message: `${player.name} hit me first. Everyone sees the knife now.`,
      requiresTarget: true,
    };
  }
  if (!player.isFriendly && !player.isAllied && player.canAttack) {
    if (
      context.nuclearThreatReady === true &&
      ((player.tileShare ?? 0) >= 0.2 ||
        (player.relativeTroopRatio ?? 1) < 0.85)
    ) {
      return {
        key: "attack.focus",
        message: `${player.name}, hit me and your silos, SAMs, and capital grid become the target list.`,
        requiresTarget: true,
        nuclearThreat: true,
      };
    }
    if ((player.relativeTroopRatio ?? 0) >= 1.45) {
      return {
        key: "attack.finish",
        message: `The table is open. Carve up ${player.name} before they recover.`,
        requiresTarget: true,
      };
    }
    return {
      key: "attack.focus",
      message: `Pressure ${player.name}; whoever joins gets my quiet border.`,
      requiresTarget: true,
    };
  }
  if (player.isFriendly || player.isAllied) {
    if (player.incomingAttack || player.canDonateTroops) {
      return {
        key: "help.troops",
        message: `${player.name}, hold the line. I need troops, not poetry.`,
        requiresTarget: false,
      };
    }
    return {
      key: "greet.good_job",
      message: `${player.name}, our border stays quiet while this is useful.`,
      requiresTarget: false,
    };
  }
  if (player.canRequestAlliance) {
    return {
      key: "misc.team_up",
      message: `${player.name}, sign early and I remember. Delay and I shop elsewhere.`,
      requiresTarget: false,
    };
  }
  return {
    key: "greet.hello",
    message: `${player.name}, open channel. Neighbor, shield, or future evidence?`,
    requiresTarget: false,
  };
}

function coordinationQuickChatOptions(
  visiblePlayers: AgentVisiblePlayer[],
): AgentQuickChatOption[] {
  const recipients = visiblePlayers
    .filter(
      (player) =>
        player.isAlive &&
        player.type === PlayerType.Human &&
        (player.isFriendly ||
          player.isAllied ||
          player.canRequestAlliance ||
          player.hasOutgoingAllianceRequest ||
          player.hasIncomingAllianceRequest),
    )
    .sort(socialTargetSort)
    .slice(0, 3);
  if (recipients.length === 0) {
    return [];
  }
  const focusTargets = visiblePlayers
    .filter(
      (player) =>
        player.isAlive &&
        !player.isFriendly &&
        !player.isAllied &&
        (player.canAttack ||
          player.canTarget ||
          player.sharesBorder ||
          player.type === PlayerType.Human),
    )
    .sort((a, b) => {
      const aWeakness = a.relativeTroopRatio ?? 0;
      const bWeakness = b.relativeTroopRatio ?? 0;
      return (
        b.tilesOwned - a.tilesOwned ||
        Number(b.canAttack) - Number(a.canAttack) ||
        bWeakness - aWeakness ||
        a.name.localeCompare(b.name)
      );
    });
  if (focusTargets.length === 0) {
    return [];
  }
  return recipients.flatMap((recipient) => {
    const focusTarget = focusTargets.find(
      (target) => target.playerID !== recipient.playerID,
    );
    if (focusTarget === undefined) {
      return [];
    }
    const key =
      (focusTarget.relativeTroopRatio ?? 0) >= 1.35
        ? "attack.finish"
        : "attack.focus";
    const verb = key === "attack.finish" ? "finish" : "contain";
    const message =
      key === "attack.finish"
        ? `${recipient.name}, ${focusTarget.name} is exposed. Take the slice before they beg for allies.`
        : `${recipient.name}, quiet pact: you ${verb} ${focusTarget.name}, I keep pressure off your border.`;
    return [
      {
        recipientID: recipient.playerID,
        recipientName: recipient.name,
        quickChatKey: key,
        message,
        targetID: focusTarget.playerID,
        targetName: focusTarget.name,
        legalReason: `${key} coordinates ${recipient.name} onto ${focusTarget.name}`,
      },
    ];
  });
}

function buildSearchTileComparator(
  gameState: Game,
  spawnTile: number | undefined,
): (a: number, b: number) => number {
  if (spawnTile === undefined) {
    return (a, b) => a - b;
  }
  // Manhattan distance, not |Δref|: linear tile-ref arithmetic treats a tile
  // one row down as ~a full map-width away, which row-biased candidate pools.
  return (a, b) =>
    gameState.manhattanDist(a, spawnTile) -
      gameState.manhattanDist(b, spawnTile) || a - b;
}

export function buildCandidateLimit(unit: UnitType): number {
  switch (unit) {
    case UnitType.DefensePost:
      return 400;
    case UnitType.City:
    case UnitType.Factory:
    case UnitType.SAMLauncher:
    case UnitType.MissileSilo:
      return 240;
    default:
      return 120;
  }
}

function isUsefulDefensePostPlacement(
  placement: BuildPlacementAnalysis,
): boolean {
  return (
    placement.nearbyIncomingAttack ||
    placement.nearbyEnemyCount > 0 ||
    placement.defensiveValue >= 0.28 ||
    (placement.hostileBorderDistance !== null &&
      placement.hostileBorderDistance <= DEFENSE_POST_EFFECTIVE_RANGE * 2)
  );
}

function buildPlacementScore(
  unit: AgentBuildOption["unit"],
  placement: BuildPlacementAnalysis,
): number {
  // Nukes only: Warship is in BuildableAttacks but scores as a generic
  // placement (its candidates are own-sea patrol anchors, not nuke targets).
  if (Nukes.has(unit)) {
    return (
      (placement.nukeTargetPriority ?? 0) * 10 +
      (placement.nukeTargetStructurePriority ?? 0) * 3 -
      (placement.nukeTargetSamCoverage ?? 0) * 4
    );
  }
  if (unit === UnitType.DefensePost) {
    return placement.defensiveValue * 100 + placement.frontierValue * 25;
  }
  if (unit === UnitType.City || unit === UnitType.Factory) {
    return (
      placement.economicValue * 100 -
      placement.defensiveValue * 20 +
      placement.borderDistance * 0.02
    );
  }
  if (unit === UnitType.SAMLauncher || unit === UnitType.MissileSilo) {
    return placement.economicValue * 55 + placement.borderDistance * 0.05;
  }
  return (
    placement.economicValue * 30 +
    placement.frontierValue * 10 +
    placement.ownedNeighborCount
  );
}

function buildPlacementReason(
  unit: AgentBuildOption["unit"],
  placement: Pick<
    BuildPlacementAnalysis,
    | "isBorderBuild"
    | "borderDistance"
    | "hostileBorderDistance"
    | "nearbyIncomingAttack"
    | "nearbyEnemyCount"
    | "ownedNeighborCount"
    | "frontierValue"
    | "economicValue"
    | "defensiveValue"
  >,
): string {
  if (unit === UnitType.DefensePost) {
    if (placement.nearbyIncomingAttack) {
      return "Defense Post covers an active land-attack frontier.";
    }
    if (placement.hostileBorderDistance !== null) {
      return `Defense Post is ${placement.hostileBorderDistance} tiles from a hostile border with defensiveValue=${placement.defensiveValue}.`;
    }
    return "Defense Post has no proven hostile frontier coverage.";
  }
  if (unit === UnitType.City || unit === UnitType.Factory) {
    return `${unit} favors safe economic placement: borderDistance=${placement.borderDistance}, ownedNeighbors=${placement.ownedNeighborCount}, economicValue=${placement.economicValue}.`;
  }
  return `${unit} placement metadata: borderDistance=${placement.borderDistance}, frontierValue=${placement.frontierValue}, economicValue=${placement.economicValue}.`;
}

function nearestManhattanDistance(
  gameState: Game,
  tile: number,
  candidates: readonly number[],
): number {
  return nearestManhattanDistanceOrNull(gameState, tile, candidates) ?? 9_999;
}

function nearestManhattanDistanceOrNull(
  gameState: Game,
  tile: number,
  candidates: readonly number[],
): number | null {
  let best: number | null = null;
  for (const candidate of candidates) {
    const distance = gameState.manhattanDist(tile, candidate);
    if (best === null || distance < best) {
      best = distance;
    }
  }
  return best;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
