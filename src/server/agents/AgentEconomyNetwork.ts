/**
 * AgentEconomyNetwork — pure, deterministic economy snapshot for observations
 * (economy+negotiation V1 Phase A, PROXYWAR_TUNE_ECONOMY_OBSERVATION).
 *
 * Given the core Game and one player, computes:
 * - cumulative income by the six verified GOLD_INDEX_* stats sources,
 * - rail clusters touching the player (derived cluster key = min stable
 *   TrainStation.id — clusters carry no stable identity in core),
 * - factory classification (operational | idle_no_destination |
 *   blocked_by_embargo) using the core trade-eligibility gate
 *   (TrainStation.tradeAvailable → Player.canTrade, embargo-only),
 * - per-counterparty structural dependency (incl. the verified
 *   ally-pays-more train payout implication),
 * - one primary bottleneck with server-authored evidence.
 *
 * Discipline (mirrors the scoring idea of core's
 * NationStructureBehavior.buildReachableStations without calling its private
 * methods): read-only over RailNetwork/StationManager/Cluster/Player/stats,
 * integer/bigint math only, no wall-clock, no RNG, no pathfinding, no
 * per-tile payloads. Same snapshot in ⇒ deep-equal block out, stable sort
 * orders throughout. O(stations + players·clusters) per call; computed once
 * per decision step by the observation builder.
 */
import { Game, Player, Unit, UnitType } from "../../core/game/Game";
import type { Cluster, TrainStation } from "../../core/game/TrainStation";
import {
  GOLD_INDEX_STEAL,
  GOLD_INDEX_TRADE,
  GOLD_INDEX_TRAIN_OTHER,
  GOLD_INDEX_TRAIN_SELF,
  GOLD_INDEX_WAR,
  GOLD_INDEX_WORK,
} from "../../core/StatsSchemas";
import { economyObservationEnabled } from "./AgentTunables";
import type {
  AgentEconomyBottleneck,
  AgentEconomyClusterSummary,
  AgentEconomyCounterpartySummary,
  AgentEconomyEmbargoBlock,
  AgentEconomyFactoryStatus,
  AgentEconomyFactorySummary,
  AgentEconomyNetworkAffordance,
  AgentEconomyObservation,
  AgentEconomyRecordFacts,
  AgentVisiblePlayer,
} from "./AgentTypes";

/** Hard reporting caps (counts stay exact even when lists are capped). */
export const ECONOMY_CLUSTER_CAP = 6;
export const ECONOMY_COUNTERPARTY_CAP = 8;
export const ECONOMY_FACTORY_CAP = 12;

const DEPENDENCY_BOTTLENECK_PCT = 50;
const POPULATION_CAPACITY_PCT = 95;
const EVIDENCE_NAME_CAP = 3;

/**
 * Observation-builder entry point. Returns the economy block and decorates the
 * already-built visible players with City/Factory/Port `unitCounts` and
 * `isTraitor` — or does nothing at all (returns undefined, mutates nothing)
 * when PROXYWAR_TUNE_ECONOMY_OBSERVATION is off or core state is unavailable,
 * keeping flag-off observations byte-identical to shipped behavior.
 */
export function buildEconomyObservationExtension(input: {
  gameState: Game | undefined;
  player: Player | null;
  visiblePlayers: AgentVisiblePlayer[];
}): AgentEconomyObservation | undefined {
  if (!economyObservationEnabled()) {
    return undefined;
  }
  if (input.gameState === undefined || input.player === null) {
    return undefined;
  }
  decorateEconomyVisiblePlayers(input.gameState, input.visiblePlayers);
  return buildAgentEconomySnapshot(input.gameState, input.player);
}

/**
 * Adds the flag-gated rival economy fields (City/Factory/Port counts and
 * traitor state — both public game state) to already-built visible players.
 */
export function decorateEconomyVisiblePlayers(
  gameState: Game,
  visiblePlayers: AgentVisiblePlayer[],
): void {
  const playersByID = new Map(
    gameState.players().map((player) => [player.id(), player] as const),
  );
  for (const visible of visiblePlayers) {
    const other = playersByID.get(visible.playerID);
    if (other === undefined) {
      continue;
    }
    visible.unitCounts = {
      [UnitType.City]: other.units(UnitType.City).length,
      [UnitType.Factory]: other.units(UnitType.Factory).length,
      [UnitType.Port]: other.units(UnitType.Port).length,
    };
    visible.isTraitor = other.isTraitor();
  }
}

interface ClusterInfo {
  key: number;
  stations: TrainStation[];
}

interface ClusterAnalysis extends AgentEconomyClusterSummary {
  /** eligible + embargo-blocked City/Port stations (trade stations). */
  tradeStationCount: number;
}

/** The pure snapshot (exported for direct tests). Read-only over game state. */
export function buildAgentEconomySnapshot(
  game: Game,
  player: Player,
): AgentEconomyObservation {
  const { infoByCluster, stationByUnit } = collectClusters(game);

  // Clusters touching the agent: >=1 station whose unit the agent owns.
  const touching = [...infoByCluster.values()]
    .filter((info) =>
      info.stations.some((station) => station.unit.owner() === player),
    )
    .sort((a, b) => a.key - b.key);

  const clusterAnalyses = touching.map((info) => analyzeCluster(info, player));
  const analysisByKey = new Map(
    clusterAnalyses.map((analysis) => [analysis.clusterKey, analysis] as const),
  );
  const eligibleDestinationCount = sumInts(
    clusterAnalyses.map((analysis) => analysis.eligibleDestinationCount),
  );
  const embargoBlockedDestinationCount = sumInts(
    clusterAnalyses.map((analysis) => analysis.embargoBlockedDestinationCount),
  );

  const factories = classifyFactories({
    player,
    stationByUnit,
    infoByCluster,
    analysisByKey,
  });
  const factoryStatusCounts = {
    operational: countStatus(factories, "operational"),
    idleNoDestination: countStatus(factories, "idle_no_destination"),
    blockedByEmbargo: countStatus(factories, "blocked_by_embargo"),
  };

  const counterparties = buildCounterparties({
    game,
    player,
    touching,
    eligibleDestinationCount,
  });

  const bottleneck = selectBottleneck({
    game,
    player,
    factoryCount: factories.length,
    factoryStatusCounts,
    eligibleDestinationCount,
    embargoBlockedDestinationCount,
    clusterAnalyses,
    counterparties,
  });

  return {
    incomeBySource: incomeBySource(game, player),
    clusterCount: clusterAnalyses.length,
    clusters: clusterAnalyses
      .slice(0, ECONOMY_CLUSTER_CAP)
      .map(({ tradeStationCount: _tradeStationCount, ...summary }) => summary),
    factoryCount: factories.length,
    factories: factories.slice(0, ECONOMY_FACTORY_CAP),
    factoryStatusCounts,
    eligibleDestinationCount,
    embargoBlockedDestinationCount,
    counterpartyCount: counterparties.length,
    counterparties: selectCounterparties(counterparties),
    bottleneck,
  };
}

/** Compact per-decision facts for spectator-event derivation. */
export function economyRecordFacts(
  snapshot: AgentEconomyObservation,
): AgentEconomyRecordFacts {
  return {
    factoryCount: snapshot.factoryCount,
    operationalFactoryCount: snapshot.factoryStatusCounts.operational,
    idleFactoryCount: snapshot.factoryStatusCounts.idleNoDestination,
    blockedFactoryCount: snapshot.factoryStatusCounts.blockedByEmbargo,
    eligibleDestinationCount: snapshot.eligibleDestinationCount,
    embargoBlockedDestinationCount: snapshot.embargoBlockedDestinationCount,
    counterparties: snapshot.counterparties.map((counterparty) => ({
      playerID: counterparty.playerID,
      name: counterparty.name,
      isAllied: counterparty.isAllied,
      myEligibleDestinationsTheyOwn: counterparty.myEligibleDestinationsTheyOwn,
      eligibleDestinationSharePct: counterparty.eligibleDestinationSharePct,
      embargoOursOnThem: counterparty.embargoOursOnThem,
      embargoTheirsOnUs: counterparty.embargoTheirsOnUs,
    })),
    bottleneckKind: snapshot.bottleneck.kind,
  };
}

/**
 * Same compact facts recovered from a stamped affordance block (fallback for
 * records that retained tacticalAffordances but not economyFacts).
 */
export function economyFactsFromAffordance(
  affordance: AgentEconomyNetworkAffordance,
): AgentEconomyRecordFacts {
  return {
    factoryCount: affordance.factoryCount,
    operationalFactoryCount: affordance.operationalFactoryCount,
    idleFactoryCount: affordance.idleFactoryCount,
    blockedFactoryCount: affordance.blockedFactoryCount,
    eligibleDestinationCount: affordance.eligibleDestinationCount,
    embargoBlockedDestinationCount: affordance.embargoBlockedDestinationCount,
    counterparties: affordance.counterparties,
    bottleneckKind: affordance.bottleneckKind,
  };
}

function collectClusters(game: Game): {
  infoByCluster: Map<Cluster, ClusterInfo>;
  stationByUnit: Map<Unit, TrainStation>;
} {
  const stationByUnit = new Map<Unit, TrainStation>();
  const infoByCluster = new Map<Cluster, ClusterInfo>();
  for (const station of game.railNetwork().stationManager().getAll()) {
    stationByUnit.set(station.unit, station);
    const cluster = station.getCluster();
    if (cluster === null) {
      continue;
    }
    let info = infoByCluster.get(cluster);
    if (info === undefined) {
      info = { key: station.id, stations: [] };
      infoByCluster.set(cluster, info);
    }
    info.stations.push(station);
    if (station.id < info.key) {
      info.key = station.id;
    }
  }
  return { infoByCluster, stationByUnit };
}

function analyzeCluster(info: ClusterInfo, player: Player): ClusterAnalysis {
  const ownStations = { city: 0, factory: 0, port: 0 };
  const foreignStations = { city: 0, factory: 0, port: 0 };
  let eligibleDestinationCount = 0;
  let embargoBlockedDestinationCount = 0;
  const blockedByOwner = new Map<string, { owner: Player; count: number }>();

  for (const station of info.stations) {
    const type = station.unit.type();
    const owner = station.unit.owner();
    const bucket = owner === player ? ownStations : foreignStations;
    if (type === UnitType.City) {
      bucket.city += 1;
    } else if (type === UnitType.Factory) {
      bucket.factory += 1;
    } else if (type === UnitType.Port) {
      bucket.port += 1;
    } else {
      continue;
    }
    if (type !== UnitType.City && type !== UnitType.Port) {
      continue;
    }
    // The core trade gate itself: self always eligible, otherwise embargo-only.
    if (station.tradeAvailable(player)) {
      eligibleDestinationCount += 1;
    } else {
      embargoBlockedDestinationCount += 1;
      const entry = blockedByOwner.get(owner.id());
      if (entry === undefined) {
        blockedByOwner.set(owner.id(), { owner, count: 1 });
      } else {
        entry.count += 1;
      }
    }
  }

  const blockedBy: AgentEconomyEmbargoBlock[] = [...blockedByOwner.values()]
    .map(({ owner, count }) => ({
      playerID: owner.id(),
      name: owner.name(),
      direction: embargoDirection(player, owner),
      blockedDestinationCount: count,
    }))
    .sort((a, b) => a.playerID.localeCompare(b.playerID));

  return {
    clusterKey: info.key,
    stationCount: info.stations.length,
    ownStations,
    foreignStations,
    eligibleDestinationCount,
    embargoBlockedDestinationCount,
    blockedBy,
    tradeStationCount:
      eligibleDestinationCount + embargoBlockedDestinationCount,
  };
}

function embargoDirection(
  player: Player,
  owner: Player,
): AgentEconomyEmbargoBlock["direction"] {
  const ours = player.hasEmbargoAgainst(owner);
  const theirs = owner.hasEmbargoAgainst(player);
  if (ours && theirs) {
    return "mutual";
  }
  return ours ? "ours" : "theirs";
}

function classifyFactories(input: {
  player: Player;
  stationByUnit: Map<Unit, TrainStation>;
  infoByCluster: Map<Cluster, ClusterInfo>;
  analysisByKey: Map<number, ClusterAnalysis>;
}): AgentEconomyFactorySummary[] {
  return input.player
    .units(UnitType.Factory)
    .slice()
    .sort((a, b) => a.id() - b.id())
    .map((unit) => {
      const station = input.stationByUnit.get(unit);
      const cluster = station?.getCluster() ?? null;
      const clusterKey =
        cluster === null
          ? null
          : (input.infoByCluster.get(cluster)?.key ?? null);
      const analysis =
        clusterKey === null ? undefined : input.analysisByKey.get(clusterKey);
      return {
        unitID: unit.id(),
        tile: unit.tile(),
        level: unit.level(),
        clusterKey,
        status: factoryStatus(analysis),
      };
    });
}

function factoryStatus(
  analysis: ClusterAnalysis | undefined,
): AgentEconomyFactoryStatus {
  if (analysis === undefined) {
    return "idle_no_destination";
  }
  if (analysis.eligibleDestinationCount > 0) {
    return "operational";
  }
  return analysis.tradeStationCount > 0
    ? "blocked_by_embargo"
    : "idle_no_destination";
}

function buildCounterparties(input: {
  game: Game;
  player: Player;
  touching: ClusterInfo[];
  eligibleDestinationCount: number;
}): AgentEconomyCounterpartySummary[] {
  const { game, player, touching } = input;
  const counterpartyPlayers = new Map<string, Player>();
  for (const info of touching) {
    for (const station of info.stations) {
      const owner = station.unit.owner();
      if (owner !== player) {
        counterpartyPlayers.set(owner.id(), owner);
      }
    }
  }
  const ownPortCount = player.units(UnitType.Port).length;
  if (ownPortCount > 0) {
    for (const other of game.players()) {
      if (other === player || !other.isAlive()) {
        continue;
      }
      if (other.units(UnitType.Port).length > 0) {
        counterpartyPlayers.set(other.id(), other);
      }
    }
  }

  const allyStopGold = game.config().trainGold("ally", 0, player).toString();
  return [...counterpartyPlayers.values()]
    .sort((a, b) => a.id().localeCompare(b.id()))
    .map((other) => {
      const sharedInfos = touching.filter((info) =>
        info.stations.some((station) => station.unit.owner() === other),
      );
      let myEligibleDestinationsTheyOwn = 0;
      let theirEligibleDestinationsIOwn = 0;
      for (const info of sharedInfos) {
        for (const station of info.stations) {
          const type = station.unit.type();
          if (type !== UnitType.City && type !== UnitType.Port) {
            continue;
          }
          const owner = station.unit.owner();
          if (owner === other && station.tradeAvailable(player)) {
            myEligibleDestinationsTheyOwn += 1;
          }
          if (owner === player && station.tradeAvailable(other)) {
            theirEligibleDestinationsIOwn += 1;
          }
        }
      }
      const relation = player.isOnSameTeam(other)
        ? "team"
        : player.isAlliedWith(other)
          ? "ally"
          : "other";
      return {
        playerID: other.id(),
        name: other.name(),
        isAllied: player.isAlliedWith(other),
        sharedClusterKeys: sharedInfos.map((info) => info.key),
        myEligibleDestinationsTheyOwn,
        theirEligibleDestinationsIOwn,
        eligibleDestinationSharePct:
          input.eligibleDestinationCount > 0
            ? Math.floor(
                (myEligibleDestinationsTheyOwn * 100) /
                  input.eligibleDestinationCount,
              )
            : null,
        portTradeEligible:
          ownPortCount > 0 &&
          other.units(UnitType.Port).length > 0 &&
          player.canTrade(other),
        embargoOursOnThem: player.hasEmbargoAgainst(other),
        embargoTheirsOnUs: other.hasEmbargoAgainst(player),
        trainStopGoldCurrent: game
          .config()
          .trainGold(relation, 0, player)
          .toString(),
        trainStopGoldIfAllied: allyStopGold,
      };
    });
}

/**
 * Cap to ECONOMY_COUNTERPARTY_CAP. Selection prefers structural relevance
 * (rail-sharing, then eligible destinations they own, then port-trade
 * eligibility) so the cap never evicts the load-bearing counterparties;
 * presentation is re-sorted by playerID for a stable order.
 */
function selectCounterparties(
  counterparties: AgentEconomyCounterpartySummary[],
): AgentEconomyCounterpartySummary[] {
  return counterparties
    .slice()
    .sort(
      (a, b) =>
        rankOfCounterparty(b) - rankOfCounterparty(a) ||
        a.playerID.localeCompare(b.playerID),
    )
    .slice(0, ECONOMY_COUNTERPARTY_CAP)
    .sort((a, b) => a.playerID.localeCompare(b.playerID));
}

function rankOfCounterparty(
  counterparty: AgentEconomyCounterpartySummary,
): number {
  return (
    (counterparty.sharedClusterKeys.length > 0 ? 1_000_000 : 0) +
    counterparty.myEligibleDestinationsTheyOwn * 1_000 +
    counterparty.theirEligibleDestinationsIOwn * 10 +
    (counterparty.portTradeEligible ? 1 : 0)
  );
}

function incomeBySource(game: Game, player: Player) {
  const gold = game.stats().getPlayerStats(player)?.gold;
  const at = (index: number): string =>
    (gold !== undefined && gold.length > index ? gold[index] : 0n).toString();
  return {
    work: at(GOLD_INDEX_WORK),
    war: at(GOLD_INDEX_WAR),
    tradeShips: at(GOLD_INDEX_TRADE),
    capturedTradeShips: at(GOLD_INDEX_STEAL),
    trainSelf: at(GOLD_INDEX_TRAIN_SELF),
    trainExternal: at(GOLD_INDEX_TRAIN_OTHER),
  };
}

/**
 * One primary bottleneck, first matching rule wins (documented cascade):
 * embargo_disruption → missing_trade_destination → foreign_dependency →
 * (no factories: insufficient_gold → unsafe_investment_window →
 * insufficient_factory_capacity) → population_capacity → none.
 * `unknown` is reserved and never produced by this cascade.
 */
function selectBottleneck(input: {
  game: Game;
  player: Player;
  factoryCount: number;
  factoryStatusCounts: {
    operational: number;
    idleNoDestination: number;
    blockedByEmbargo: number;
  };
  eligibleDestinationCount: number;
  embargoBlockedDestinationCount: number;
  clusterAnalyses: ClusterAnalysis[];
  counterparties: AgentEconomyCounterpartySummary[];
}): AgentEconomyBottleneck {
  const { game, player, factoryCount, factoryStatusCounts } = input;

  if (factoryStatusCounts.blockedByEmbargo > 0) {
    return {
      kind: "embargo_disruption",
      evidence: `${factoryStatusCounts.blockedByEmbargo} of ${factoryCount} factories are embargo-blocked: every City/Port on their rail network belongs to an embargoed counterparty (${blockerNames(input.clusterAnalyses)}).`,
    };
  }

  if (factoryStatusCounts.idleNoDestination > 0) {
    return {
      kind: "missing_trade_destination",
      evidence: `${factoryStatusCounts.idleNoDestination} of ${factoryCount} factories have no City or Port on their rail network, so no trains can run from them.`,
    };
  }

  const topDependency = topCounterpartyByDependency(input.counterparties);
  if (
    topDependency !== null &&
    (topDependency.eligibleDestinationSharePct ?? 0) >=
      DEPENDENCY_BOTTLENECK_PCT &&
    input.eligibleDestinationCount >= 2 &&
    factoryStatusCounts.operational > 0
  ) {
    return {
      kind: "foreign_dependency",
      evidence: `${topDependency.name} owns ${topDependency.eligibleDestinationSharePct}% (${topDependency.myEligibleDestinationsTheyOwn} of ${input.eligibleDestinationCount}) of the eligible City/Port destinations on this rail network (${topDependency.isAllied ? "allied — allied train stops pay more" : "not allied"}).`,
    };
  }

  if (factoryCount === 0) {
    const factoryCost = game
      .config()
      .unitInfo(UnitType.Factory)
      .cost(game, player);
    if (player.gold() < factoryCost) {
      return {
        kind: "insufficient_gold",
        evidence: `Gold ${player.gold()} is below the ${factoryCost} cost of a Factory — the seed of every rail network.`,
      };
    }
    const incomingAttackCount = player.incomingAttacks().length;
    if (incomingAttackCount > 0) {
      return {
        kind: "unsafe_investment_window",
        evidence: `A Factory (${factoryCost} gold) is affordable, but ${incomingAttackCount} incoming attack${incomingAttackCount === 1 ? "" : "s"} make new economy construction risky right now.`,
      };
    }
    return {
      kind: "insufficient_factory_capacity",
      evidence: `No factories built: a Factory (${factoryCost} gold, affordable now) is the seed of every rail network — without one no stations form and no trains spawn.`,
    };
  }

  const maxTroops = game.config().maxTroops(player);
  if (
    maxTroops > 0 &&
    Math.floor((player.troops() * 100) / maxTroops) >= POPULATION_CAPACITY_PCT
  ) {
    return {
      kind: "population_capacity",
      evidence: `Troops ${Math.floor(player.troops())} sit at ${Math.floor((player.troops() * 100) / maxTroops)}% of the ${Math.floor(maxTroops)} capacity; further worker/troop growth needs more territory or Cities.`,
    };
  }

  return {
    kind: "none",
    evidence: `${factoryStatusCounts.operational} factories operational, ${input.eligibleDestinationCount} eligible City/Port destinations, ${input.embargoBlockedDestinationCount === 0 ? "no embargo-blocked destinations" : `${input.embargoBlockedDestinationCount} embargo-blocked destination${input.embargoBlockedDestinationCount === 1 ? "" : "s"} (none decisive)`} on this network.`,
  };
}

function topCounterpartyByDependency(
  counterparties: AgentEconomyCounterpartySummary[],
): AgentEconomyCounterpartySummary | null {
  let top: AgentEconomyCounterpartySummary | null = null;
  for (const counterparty of counterparties) {
    if (counterparty.eligibleDestinationSharePct === null) {
      continue;
    }
    if (
      top === null ||
      counterparty.eligibleDestinationSharePct >
        (top.eligibleDestinationSharePct ?? 0)
    ) {
      top = counterparty;
    }
  }
  return top;
}

function blockerNames(clusterAnalyses: ClusterAnalysis[]): string {
  const names = new Map<string, string>();
  for (const analysis of clusterAnalyses) {
    for (const block of analysis.blockedBy) {
      names.set(block.playerID, block.name);
    }
  }
  const sorted = [...names.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, name]) => name);
  if (sorted.length <= EVIDENCE_NAME_CAP) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, EVIDENCE_NAME_CAP).join(", ")} +${sorted.length - EVIDENCE_NAME_CAP} more`;
}

function countStatus(
  factories: AgentEconomyFactorySummary[],
  status: AgentEconomyFactoryStatus,
): number {
  return factories.filter((factory) => factory.status === status).length;
}

function sumInts(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
