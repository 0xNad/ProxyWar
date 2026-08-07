import { CityExecution } from "../../../src/core/execution/CityExecution";
import { FactoryExecution } from "../../../src/core/execution/FactoryExecution";
import { RecomputeRailClusterExecution } from "../../../src/core/execution/RecomputeRailClusterExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { TrainStation } from "../../../src/core/game/TrainStation";
import { setup } from "../../util/Setup";

// Phase 0 regression tests (economy+negotiation project): train spawn
// preconditions in TrainStationExecution/FactoryExecution/CityExecution.
// These exercise the real harness (no mocks): factory is the seed, only
// factories spawn trains, and spawning requires at least one *eligible*
// City/Port destination in the factory's rail cluster.
//
// Already pinned elsewhere (cite, don't duplicate):
// - exact trainGold tier amounts + trade-stop penalty:
//   tests/core/game/TrainStation.test.ts
// - ghost-rail path matrix + cluster merge mechanics:
//   tests/core/game/RailNetwork.test.ts

let game: Game;
let playerA: Player;
let playerB: Player;

function station(g: Game, unit: Unit): TrainStation | null {
  return g.railNetwork().stationManager().findStation(unit);
}

function ticksUntil(g: Game, cond: () => boolean, maxTicks: number): number {
  let n = 0;
  while (!cond() && n < maxTicks) {
    g.executeNextTick();
    n++;
  }
  return n;
}

describe("Train spawn preconditions", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      new PlayerInfo("playerA", PlayerType.Human, null, "playerA_id"),
      new PlayerInfo("playerB", PlayerType.Human, null, "playerB_id"),
    ]);

    playerA = game.player("playerA_id");
    playerB = game.player("playerB_id");
    // Own one tile each so both players are alive.
    playerA.conquer(game.ref(10, 50));
    playerB.conquer(game.ref(30, 50));
    playerA.addGold(10_000_000n);
    playerB.addGold(10_000_000n);

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    // Mirror GameRunner wiring: lazy cluster recompute runs per tick when
    // the Factory unit is enabled (GameRunner.init).
    game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));

    // Deterministic spawn rolls: PseudoRandom.chance(1) is always true, so a
    // factory spawns a train on every eligible tick (subject to the 10-tick
    // per-station cooldown and the eligible-destination gate under test).
    game.config().trainSpawnRate = () => 1;
  });

  test("factory with no City/Port in its cluster spawns no train; a connecting City enables spawning", () => {
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));

    // Let the factory station get created and connected, then run well past
    // the 10-tick spawn cooldown.
    ticksUntil(game, () => factory.hasTrainStation(), 10);
    expect(factory.hasTrainStation()).toBe(true);

    for (let i = 0; i < 30; i++) {
      game.executeNextTick();
    }

    // The station exists and has a cluster, but there is no eligible trade
    // destination (factories are not trade stations), so nothing spawned.
    const factoryStation = station(game, factory);
    expect(factoryStation).not.toBeNull();
    const cluster = factoryStation!.getCluster();
    expect(cluster).not.toBeNull();
    expect(cluster!.hasAnyTradeDestination(playerA)).toBe(false);
    expect(playerA.units(UnitType.Train)).toHaveLength(0);

    // Build a City 20 tiles away (> trainStationMinRange 15, < max 100).
    // CityExecution's one-shot latch sees the nearby factory and creates the
    // city's station, which joins the factory's cluster.
    const city = playerA.buildUnit(UnitType.City, game.ref(30, 50), {});
    game.addExecution(new CityExecution(city));

    ticksUntil(game, () => station(game, city) !== null, 10);
    const cityStation = station(game, city);
    expect(cityStation).not.toBeNull();
    expect(cityStation!.getCluster()).toBe(factoryStation!.getCluster());
    expect(factoryStation!.getCluster()!.hasAnyTradeDestination(playerA)).toBe(
      true,
    );

    // With an eligible destination the factory now spawns a train.
    ticksUntil(game, () => playerA.units(UnitType.Train).length > 0, 15);
    const trains = playerA.units(UnitType.Train);
    expect(trains.length).toBeGreaterThan(0);
    // The spawned train targets the only eligible destination: the city.
    expect(trains.some((t) => t.targetUnit() === city)).toBe(true);
  });

  test("factory-only cluster never produces trains (factories are never destinations)", () => {
    const factory1 = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    const factory2 = playerA.buildUnit(UnitType.Factory, game.ref(30, 50), {});
    game.addExecution(
      new FactoryExecution(factory1),
      new FactoryExecution(factory2),
    );

    ticksUntil(
      game,
      () =>
        station(game, factory1) !== null && station(game, factory2) !== null,
      10,
    );

    // Both factory stations exist and are physically connected in the same
    // cluster...
    const station1 = station(game, factory1);
    const station2 = station(game, factory2);
    expect(station1).not.toBeNull();
    expect(station2).not.toBeNull();
    expect(station1!.getCluster()).not.toBeNull();
    expect(station1!.getCluster()).toBe(station2!.getCluster());

    // ...but factories are never trade destinations, so no train ever spawns.
    for (let i = 0; i < 40; i++) {
      game.executeNextTick();
    }
    expect(station1!.getCluster()!.hasAnyTradeDestination(playerA)).toBe(false);
    expect(playerA.units(UnitType.Train)).toHaveLength(0);
  });

  test("an embargo makes the only destination ineligible; lifting it re-enables spawning", () => {
    // B's city exists first; the factory back-fills its station
    // (FactoryExecution.createStation covers City/Port/Factory in range).
    const city = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    // Embargo before any train can spawn. Either direction blocks trade;
    // here the city owner embargoes the factory owner.
    playerB.addEmbargo(playerA, false);

    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    game.addExecution(new FactoryExecution(factory));

    ticksUntil(
      game,
      () => station(game, factory) !== null && station(game, city) !== null,
      10,
    );
    const factoryStation = station(game, factory);
    const cityStation = station(game, city);
    expect(factoryStation).not.toBeNull();
    expect(cityStation).not.toBeNull();
    // The enemy city is in the same physical cluster (connections are not
    // owner-filtered)...
    expect(cityStation!.getCluster()).toBe(factoryStation!.getCluster());

    // ...but embargoed owners are not eligible destinations: no trains.
    for (let i = 0; i < 30; i++) {
      game.executeNextTick();
    }
    expect(factoryStation!.getCluster()!.hasAnyTradeDestination(playerA)).toBe(
      false,
    );
    expect(playerA.units(UnitType.Train)).toHaveLength(0);

    // Lift the embargo: the destination becomes eligible and a train spawns.
    playerB.stopEmbargo(playerA);
    expect(factoryStation!.getCluster()!.hasAnyTradeDestination(playerA)).toBe(
      true,
    );
    ticksUntil(game, () => playerA.units(UnitType.Train).length > 0, 15);
    expect(playerA.units(UnitType.Train).length).toBeGreaterThan(0);
  });
});
