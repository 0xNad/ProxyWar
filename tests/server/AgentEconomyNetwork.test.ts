import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { CityExecution } from "../../src/core/execution/CityExecution";
import { FactoryExecution } from "../../src/core/execution/FactoryExecution";
import { RecomputeRailClusterExecution } from "../../src/core/execution/RecomputeRailClusterExecution";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../src/core/game/Game";
import { TrainStation } from "../../src/core/game/TrainStation";
import {
  buildAgentEconomySnapshot,
  ECONOMY_CLUSTER_CAP,
  ECONOMY_COUNTERPARTY_CAP,
  ECONOMY_FACTORY_CAP,
  economyRecordFacts,
} from "../../src/server/agents/AgentEconomyNetwork";
import { setup } from "../util/Setup";

// Phase A (economy+negotiation V1): the pure economy snapshot. These tests
// exercise the REAL core harness (no mocks) with constructed rail/embargo
// states, mirroring the Phase 0 patterns in tests/core/executions/TrainSpawn.
// The snapshot must agree with the core trade gate (TrainStation.tradeAvailable
// → Player.canTrade, embargo-only), be deterministic, capped, and read-only.

function station(game: Game, unit: Unit): TrainStation | null {
  return game.railNetwork().stationManager().findStation(unit);
}

function ticksUntil(game: Game, cond: () => boolean, maxTicks: number): number {
  let n = 0;
  while (!cond() && n < maxTicks) {
    game.executeNextTick();
    n++;
  }
  return n;
}

async function railGame(playerCount = 2): Promise<{
  game: Game;
  players: Player[];
}> {
  const infos = Array.from(
    { length: playerCount },
    (_, index) =>
      new PlayerInfo(
        `player${index}`,
        PlayerType.Human,
        `CLNT_${index}`,
        `P_${index}`,
      ),
  );
  const game = await setup("plains", {}, infos);
  const players = infos.map((info) => game.player(info.id));
  players.forEach((player, index) => {
    player.conquer(game.ref(10 + index * 3, 90));
    player.addGold(10_000_000n);
  });
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
  return { game, players };
}

function ally(game: Game, a: Player, b: Player): void {
  game.addExecution(new AllianceRequestExecution(a, b.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(b, a.id()));
  game.executeNextTick();
}

function gameProbe(game: Game): string {
  return JSON.stringify({
    stations: [...game.railNetwork().stationManager().getAll()].map(
      (trainStation) => trainStation.id,
    ),
    players: game.players().map((player) => ({
      id: player.id(),
      gold: player.gold().toString(),
      troops: player.troops(),
      tiles: player.numTilesOwned(),
      cities: player.units(UnitType.City).length,
      factories: player.units(UnitType.Factory).length,
      ports: player.units(UnitType.Port).length,
      embargoes: player.getEmbargoes().length,
    })),
  });
}

describe("AgentEconomyNetwork snapshot", () => {
  test("operational factory with an own City: classification, cluster summary, six income sources, bottleneck none", async () => {
    const { game, players } = await railGame(2);
    const [playerA] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    const city = playerA.buildUnit(UnitType.City, game.ref(30, 50), {});
    game.addExecution(new CityExecution(city));
    ticksUntil(game, () => station(game, city) !== null, 10);

    const snapshot = buildAgentEconomySnapshot(game, playerA);

    expect(snapshot.factoryCount).toBe(1);
    expect(snapshot.factories[0]).toMatchObject({
      unitID: factory.id(),
      level: factory.level(),
      status: "operational",
    });
    expect(snapshot.factories[0].clusterKey).not.toBeNull();
    expect(snapshot.factoryStatusCounts).toEqual({
      operational: 1,
      idleNoDestination: 0,
      blockedByEmbargo: 0,
    });
    expect(snapshot.clusterCount).toBe(1);
    expect(snapshot.clusters[0]).toMatchObject({
      stationCount: 2,
      ownStations: { city: 1, factory: 1, port: 0 },
      foreignStations: { city: 0, factory: 0, port: 0 },
      eligibleDestinationCount: 1,
      embargoBlockedDestinationCount: 0,
      blockedBy: [],
    });
    // Derived cluster key = min stable station id of the cluster.
    const stationIDs = [factory, city].map((unit) => station(game, unit)!.id);
    expect(snapshot.clusters[0].clusterKey).toBe(Math.min(...stationIDs));
    expect(snapshot.eligibleDestinationCount).toBe(1);
    // No rival owns a station or a port: no structural counterparties.
    expect(snapshot.counterpartyCount).toBe(0);
    expect(snapshot.bottleneck.kind).toBe("none");
    // The six verified GOLD_INDEX_* sources, never merged, serialized bigints.
    expect(Object.keys(snapshot.incomeBySource)).toEqual([
      "work",
      "war",
      "tradeShips",
      "capturedTradeShips",
      "trainSelf",
      "trainExternal",
    ]);
    for (const value of Object.values(snapshot.incomeBySource)) {
      expect(value).toMatch(/^\d+$/);
    }
  });

  test("factory with no City/Port on its network: idle_no_destination and missing_trade_destination evidence", async () => {
    const { game, players } = await railGame(2);
    const [playerA] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);

    const snapshot = buildAgentEconomySnapshot(game, playerA);

    expect(snapshot.factories[0].status).toBe("idle_no_destination");
    expect(snapshot.eligibleDestinationCount).toBe(0);
    expect(snapshot.bottleneck.kind).toBe("missing_trade_destination");
    expect(snapshot.bottleneck.evidence).toContain("1 of 1 factories");
    expect(snapshot.bottleneck.evidence).toContain("no City or Port");
  });

  test("embargoed foreign City: blocked_by_embargo, embargo direction attribution, embargo_disruption evidence; lifting re-classifies", async () => {
    const { game, players } = await railGame(2);
    const [playerA, playerB] = players;
    // B's city exists first; A's factory back-fills its station into the same
    // physical cluster (connections are not owner-filtered).
    const city = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    playerB.addEmbargo(playerA, false);
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(
      game,
      () => station(game, factory) !== null && station(game, city) !== null,
      10,
    );

    const blocked = buildAgentEconomySnapshot(game, playerA);
    expect(blocked.factories[0].status).toBe("blocked_by_embargo");
    expect(blocked.clusters[0].eligibleDestinationCount).toBe(0);
    expect(blocked.clusters[0].embargoBlockedDestinationCount).toBe(1);
    expect(blocked.clusters[0].blockedBy).toEqual([
      {
        playerID: playerB.id(),
        name: playerB.name(),
        direction: "theirs",
        blockedDestinationCount: 1,
      },
    ]);
    expect(blocked.bottleneck.kind).toBe("embargo_disruption");
    expect(blocked.bottleneck.evidence).toContain(playerB.name());
    const blockedCounterparty = blocked.counterparties.find(
      (counterparty) => counterparty.playerID === playerB.id(),
    );
    expect(blockedCounterparty).toMatchObject({
      myEligibleDestinationsTheyOwn: 0,
      embargoOursOnThem: false,
      embargoTheirsOnUs: true,
      portTradeEligible: false,
    });
    expect(blockedCounterparty!.sharedClusterKeys).toHaveLength(1);

    // Mutual embargo is attributed as such.
    playerA.addEmbargo(playerB, false);
    expect(
      buildAgentEconomySnapshot(game, playerA).clusters[0].blockedBy[0]
        .direction,
    ).toBe("mutual");
    playerA.stopEmbargo(playerB);

    // Lifting the embargo makes the same station an eligible destination.
    playerB.stopEmbargo(playerA);
    const lifted = buildAgentEconomySnapshot(game, playerA);
    expect(lifted.factories[0].status).toBe("operational");
    expect(lifted.eligibleDestinationCount).toBe(1);
    const counterparty = lifted.counterparties.find(
      (candidate) => candidate.playerID === playerB.id(),
    );
    expect(counterparty).toMatchObject({
      myEligibleDestinationsTheyOwn: 1,
      eligibleDestinationSharePct: 100,
    });
    // 100% dependency but only ONE eligible destination in total: the
    // foreign_dependency bottleneck requires >= 2, so this stays "none".
    expect(lifted.bottleneck.kind).toBe("none");
  });

  test("structural dependency: rival owning half the destinations, ally-pays-more implication, foreign_dependency evidence", async () => {
    const { game, players } = await railGame(2);
    const [playerA, playerB] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    const ownCity = playerA.buildUnit(UnitType.City, game.ref(30, 50), {});
    game.addExecution(new CityExecution(ownCity));
    const rivalCity = playerB.buildUnit(UnitType.City, game.ref(50, 50), {});
    game.addExecution(new CityExecution(rivalCity));
    ticksUntil(
      game,
      () =>
        station(game, ownCity) !== null && station(game, rivalCity) !== null,
      10,
    );

    const snapshot = buildAgentEconomySnapshot(game, playerA);
    expect(snapshot.eligibleDestinationCount).toBe(2);
    const counterparty = snapshot.counterparties.find(
      (candidate) => candidate.playerID === playerB.id(),
    );
    expect(counterparty).toMatchObject({
      isAllied: false,
      myEligibleDestinationsTheyOwn: 1,
      theirEligibleDestinationsIOwn: 1,
      eligibleDestinationSharePct: 50,
      // Verified payout tiers (TrainStation.test.ts pins the numbers):
      // neutral stop 25k, allied stop 35k.
      trainStopGoldCurrent: "25000",
      trainStopGoldIfAllied: "35000",
    });
    expect(snapshot.bottleneck.kind).toBe("foreign_dependency");
    expect(snapshot.bottleneck.evidence).toContain("50%");
    expect(snapshot.bottleneck.evidence).toContain(playerB.name());
    expect(snapshot.bottleneck.evidence).toContain("not allied");

    // Ally the counterparty: the current tier rises to the allied payout.
    ally(game, playerA, playerB);
    expect(playerA.isAlliedWith(playerB)).toBe(true);
    const allied = buildAgentEconomySnapshot(game, playerA);
    const alliedCounterparty = allied.counterparties.find(
      (candidate) => candidate.playerID === playerB.id(),
    );
    expect(alliedCounterparty).toMatchObject({
      isAllied: true,
      trainStopGoldCurrent: "35000",
      trainStopGoldIfAllied: "35000",
    });
    expect(allied.bottleneck.evidence).toContain("allied");
  });

  test("determinism: same snapshot in, deep-equal block out with stable ordering", async () => {
    const { game, players } = await railGame(3);
    const [playerA, playerB, playerC] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    const cities = [
      playerA.buildUnit(UnitType.City, game.ref(30, 50), {}),
      playerB.buildUnit(UnitType.City, game.ref(50, 50), {}),
      playerC.buildUnit(UnitType.City, game.ref(10, 30), {}),
    ];
    cities.forEach((city) => game.addExecution(new CityExecution(city)));
    ticksUntil(
      game,
      () => cities.every((city) => station(game, city) !== null),
      10,
    );
    playerC.addEmbargo(playerA, false);

    const first = buildAgentEconomySnapshot(game, playerA);
    const second = buildAgentEconomySnapshot(game, playerA);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Stable sort orders: counterparties by playerID, factories by unitID.
    expect(first.counterparties.map((c) => c.playerID)).toEqual(
      [...first.counterparties.map((c) => c.playerID)].sort(),
    );
    expect(economyRecordFacts(first)).toEqual(economyRecordFacts(second));
  });

  test("no game-state mutation: identical core probe before and after snapshots", async () => {
    const { game, players } = await railGame(3);
    const [playerA, playerB] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    const rivalCity = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    game.addExecution(new CityExecution(rivalCity));
    ticksUntil(game, () => station(game, rivalCity) !== null, 10);
    playerB.addEmbargo(playerA, false);

    const before = gameProbe(game);
    buildAgentEconomySnapshot(game, playerA);
    buildAgentEconomySnapshot(game, playerB);
    const after = gameProbe(game);
    expect(after).toBe(before);
  });

  test("counterparty cap: 9 rival city owners in one cluster report counterpartyCount 9 but at most 8 entries, id-sorted", async () => {
    const { game, players } = await railGame(10);
    const [playerA, ...rivals] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(50, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    const ringPositions: Array<[number, number]> = [
      [30, 50],
      [70, 50],
      [50, 30],
      [50, 70],
      [35, 35],
      [65, 65],
      [35, 65],
      [65, 35],
      [50, 20],
    ];
    const cities = rivals.map((rival, index) => {
      const [x, y] = ringPositions[index];
      rival.conquer(game.ref(x, y));
      const city = rival.buildUnit(UnitType.City, game.ref(x, y), {});
      game.addExecution(new CityExecution(city));
      return city;
    });
    ticksUntil(
      game,
      () => cities.every((city) => station(game, city) !== null),
      20,
    );

    const snapshot = buildAgentEconomySnapshot(game, playerA);
    expect(snapshot.counterpartyCount).toBe(9);
    expect(snapshot.counterparties).toHaveLength(ECONOMY_COUNTERPARTY_CAP);
    const reportedIDs = snapshot.counterparties.map((c) => c.playerID);
    expect(reportedIDs).toEqual([...reportedIDs].sort());
    // Equal structural rank: the deterministic tie-break drops the highest id.
    expect(reportedIDs).not.toContain(rivals[rivals.length - 1].id());
    // The pair-link list is UNCAPPED (M1): every linked counterparty appears
    // even when the rich list is capped, id-sorted, with exact link counts —
    // spectator pair-transition events read only this list.
    expect(snapshot.pairLinks).toHaveLength(9);
    const pairIDs = snapshot.pairLinks.map((pair) => pair.playerID);
    expect(pairIDs).toEqual(rivals.map((rival) => rival.id()).sort());
    expect(
      snapshot.pairLinks.every(
        (pair) =>
          pair.links === 1 &&
          !pair.embargoOursOnThem &&
          !pair.embargoTheirsOnUs,
      ),
    ).toBe(true);
    expect(snapshot.clusters.length).toBeLessThanOrEqual(ECONOMY_CLUSTER_CAP);
    expect(snapshot.eligibleDestinationCount).toBe(9);
    const shares = new Set(
      snapshot.counterparties.map((c) => c.eligibleDestinationSharePct),
    );
    expect(shares).toEqual(new Set([Math.floor(100 / 9)]));
    expect(snapshot.bottleneck.kind).toBe("none");
  });

  test("cluster and factory caps: 13 isolated factories cap lists at 6 clusters / 12 factories with exact totals", async () => {
    const { game, players } = await railGame(2);
    const [playerA] = players;
    // Pairwise distances < trainStationMinRange (15): every factory station
    // stays an isolated single-station cluster (no connection is attempted
    // below the minimum range, and there is no rail to snap to).
    const factories = Array.from({ length: 13 }, (_, index) =>
      playerA.buildUnit(UnitType.Factory, game.ref(40 + index, 40), {}),
    );
    // One FactoryExecution: its station back-fill covers the other 12 units
    // in range (queueing 13 executions at once would double-register stations
    // for units the first back-fill already latched).
    game.addExecution(new FactoryExecution(factories[0]));
    ticksUntil(
      game,
      () => factories.every((factory) => station(game, factory) !== null),
      30,
    );

    const snapshot = buildAgentEconomySnapshot(game, playerA);
    expect(snapshot.clusterCount).toBe(13);
    expect(snapshot.clusters).toHaveLength(ECONOMY_CLUSTER_CAP);
    const clusterKeys = snapshot.clusters.map((cluster) => cluster.clusterKey);
    expect(clusterKeys).toEqual([...clusterKeys].sort((a, b) => a - b));
    expect(snapshot.factoryCount).toBe(13);
    expect(snapshot.factories).toHaveLength(ECONOMY_FACTORY_CAP);
    expect(snapshot.factoryStatusCounts).toEqual({
      operational: 0,
      idleNoDestination: 13,
      blockedByEmbargo: 0,
    });
    expect(snapshot.bottleneck.kind).toBe("missing_trade_destination");
    expect(snapshot.bottleneck.evidence).toContain("13 of 13 factories");
  });

  test("port-trade counterparty without any rail: eligibility only, embargo turns it off", async () => {
    const infos = [
      new PlayerInfo("porterA", PlayerType.Human, "CLNT_PA", "P_PA"),
      new PlayerInfo("porterB", PlayerType.Human, "CLNT_PB", "P_PB"),
    ];
    const game = await setup("half_land_half_ocean", {}, infos);
    const playerA = game.player("P_PA");
    const playerB = game.player("P_PB");
    const shoreTiles: number[] = [];
    game.forEachTile((tile) => {
      if (game.isShore(tile)) {
        shoreTiles.push(tile);
      }
    });
    expect(shoreTiles.length).toBeGreaterThanOrEqual(2);
    playerA.conquer(shoreTiles[0]);
    playerB.conquer(shoreTiles[1]);
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
    playerA.buildUnit(UnitType.Port, shoreTiles[0], {});
    playerB.buildUnit(UnitType.Port, shoreTiles[1], {});

    const open = buildAgentEconomySnapshot(game, playerA);
    const counterparty = open.counterparties.find(
      (candidate) => candidate.playerID === playerB.id(),
    );
    expect(counterparty).toMatchObject({
      portTradeEligible: true,
      sharedClusterKeys: [],
      myEligibleDestinationsTheyOwn: 0,
    });

    playerA.addEmbargo(playerB, false);
    const embargoed = buildAgentEconomySnapshot(game, playerA);
    expect(
      embargoed.counterparties.find(
        (candidate) => candidate.playerID === playerB.id(),
      ),
    ).toMatchObject({
      portTradeEligible: false,
      embargoOursOnThem: true,
      embargoTheirsOnUs: false,
    });
  });

  test("no factories: gold-aware bottleneck cascade (insufficient_gold → insufficient_factory_capacity)", async () => {
    const { game, players } = await railGame(2);
    const [playerA] = players;
    // railGame grants 10M gold — a Factory is affordable, nothing is built,
    // no attack is inbound: the missing factory itself is the bottleneck.
    const affordable = buildAgentEconomySnapshot(game, playerA);
    expect(affordable.bottleneck.kind).toBe("insufficient_factory_capacity");
    expect(affordable.bottleneck.evidence).toContain("seed of every rail");

    // Drain gold below the factory cost: insufficient_gold with the numbers.
    playerA.removeGold(playerA.gold());
    const broke = buildAgentEconomySnapshot(game, playerA);
    expect(broke.bottleneck.kind).toBe("insufficient_gold");
    expect(broke.bottleneck.evidence).toMatch(/Gold \d+ is below the \d+ cost/);
  });

  test("no factories + affordable Factory + live incoming attack: unsafe_investment_window with evidence", async () => {
    const { game, players } = await railGame(2);
    const [playerA, playerB] = players;
    // Give B tiles adjacent to A so a land attack is live against A.
    playerB.conquer(game.ref(11, 90));
    playerB.conquer(game.ref(12, 90));
    game.addExecution(new AttackExecution(100, playerB, playerA.id()));
    game.executeNextTick();
    expect(playerA.incomingAttacks().length).toBeGreaterThan(0);

    const snapshot = buildAgentEconomySnapshot(game, playerA);
    expect(snapshot.factoryCount).toBe(0);
    expect(snapshot.bottleneck.kind).toBe("unsafe_investment_window");
    expect(snapshot.bottleneck.evidence).toMatch(/incoming attack/);
    expect(snapshot.bottleneck.evidence).toContain("affordable");
  });

  test("troops at >=95% of capacity with an operational rail economy: population_capacity with evidence", async () => {
    const { game, players } = await railGame(2);
    const [playerA] = players;
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    const city = playerA.buildUnit(UnitType.City, game.ref(30, 50), {});
    game.addExecution(new CityExecution(city));
    ticksUntil(game, () => station(game, city) !== null, 10);

    const maxTroops = game.config().maxTroops(playerA);
    playerA.setTroops(Math.ceil(maxTroops * 0.96));

    const snapshot = buildAgentEconomySnapshot(game, playerA);
    expect(snapshot.factoryStatusCounts.operational).toBe(1);
    expect(snapshot.bottleneck.kind).toBe("population_capacity");
    expect(snapshot.bottleneck.evidence).toContain("capacity");
    expect(snapshot.bottleneck.evidence).toMatch(/\b(9[5-9]|100)%/);
  });
});
