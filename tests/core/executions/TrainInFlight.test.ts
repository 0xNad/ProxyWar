import { RecomputeRailClusterExecution } from "../../../src/core/execution/RecomputeRailClusterExecution";
import { TrainExecution } from "../../../src/core/execution/TrainExecution";
import { TrainStationExecution } from "../../../src/core/execution/TrainStationExecution";
import {
  Game,
  GameMode,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { TrainStation } from "../../../src/core/game/TrainStation";
import { setup } from "../../util/Setup";

// Phase 0 regression tests (economy+negotiation project): TrainExecution
// in-flight behavior and per-stop payouts, exercised on the real harness.
//
// Base facts under test (verified against current source):
// - payout is per City/Port stop along the whole route; when train owner and
//   station owner differ BOTH are paid the full amount (minting, not split)
//   (TrainStation.TradeStationStopHandler.onStop)
// - relationship tier is computed at stop time: team is classified before
//   ally, so teammates earn the lower tier (TrainStation.rel)
// - in-flight trains never reroute: an embargo in either direction vs the
//   next station's owner kills the train (TrainExecution.canTradeWithDestination),
//   a destroyed next station kills it (TrainExecution.activeSourceOrDestination),
//   and a captured station does NOT kill it - the tier is recomputed against
//   the new owner when the stop is reached.
//
// Exact trainGold tier amounts are already pinned by
// tests/core/game/TrainStation.test.ts (cite, don't duplicate); here we
// assert the end-to-end amounts produced by real trains.

const BASE_OTHER = 25_000n;
const BASE_ALLY = 35_000n;
const BASE_TEAM = 25_000n;

let game: Game;
let playerA: Player; // train owner
let playerB: Player; // station owner
let playerC: Player; // third party (captor)

function wireStations(g: Game, units: Unit[]): TrainStation[] {
  // Create stations with the real TrainStationExecution, in insertion order,
  // without the factory's train-spawning role so directly constructed
  // TrainExecutions are the only trains in flight.
  g.addExecution(...units.map((u) => new TrainStationExecution(u)));
  g.executeNextTick(); // init
  g.executeNextTick(); // tick: stations created + connected in order
  return units.map((u) => {
    const station = g.railNetwork().stationManager().findStation(u);
    if (station === null) {
      throw new Error("station not created for test unit");
    }
    return station;
  });
}

function runUntilDone(g: Game, exec: TrainExecution, maxTicks = 300): void {
  for (let i = 0; i < maxTicks && exec.isActive(); i++) {
    g.executeNextTick();
  }
}

describe("TrainExecution in-flight behavior", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      new PlayerInfo("playerA", PlayerType.Human, null, "playerA_id"),
      new PlayerInfo("playerB", PlayerType.Human, null, "playerB_id"),
      new PlayerInfo("playerC", PlayerType.Human, null, "playerC_id"),
    ]);
    playerA = game.player("playerA_id");
    playerB = game.player("playerB_id");
    playerC = game.player("playerC_id");
    playerA.conquer(game.ref(10, 50));
    playerB.conquer(game.ref(30, 50));
    playerC.conquer(game.ref(70, 50));
    playerA.addGold(10_000_000n);
    playerB.addGold(10_000_000n);
    playerC.addGold(10_000_000n);

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
    game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
  });

  test("multi-hop route pays once per City stop and mints for both parties", () => {
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    const city1 = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    const city2 = playerB.buildUnit(UnitType.City, game.ref(50, 50), {});
    const [fStation, , c2Station] = wireStations(game, [factory, city1, city2]);

    const aBefore = playerA.gold();
    const bBefore = playerB.gold();

    const exec = new TrainExecution(
      game.railNetwork(),
      playerA,
      fStation,
      c2Station,
      5,
    );
    game.addExecution(exec);
    runUntilDone(game, exec);
    expect(exec.isActive()).toBe(false);

    // Two City stops (intermediate city1 + destination city2), each paying
    // the full "other" tier to BOTH the train owner and the station owner.
    expect(exec.tradeStopsVisited()).toBe(2);
    expect(playerA.gold() - aBefore).toBe(2n * BASE_OTHER);
    expect(playerB.gold() - bBefore).toBe(2n * BASE_OTHER);
  });

  test("allied cross-border stop pays the ally tier to both sides", () => {
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    const city = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    const [fStation, cStation] = wireStations(game, [factory, city]);

    const request = playerA.createAllianceRequest(playerB);
    expect(request).not.toBeNull();
    request!.accept();
    expect(playerA.isAlliedWith(playerB)).toBe(true);

    const aBefore = playerA.gold();
    const bBefore = playerB.gold();

    const exec = new TrainExecution(
      game.railNetwork(),
      playerA,
      fStation,
      cStation,
      5,
    );
    game.addExecution(exec);
    runUntilDone(game, exec);
    expect(exec.isActive()).toBe(false);

    expect(playerA.gold() - aBefore).toBe(BASE_ALLY);
    expect(playerB.gold() - bBefore).toBe(BASE_ALLY);
  });

  test("teammates are classified as team before ally and earn the lower tier", async () => {
    // Team-mode game where the pair is BOTH on the same team AND allied:
    // TrainStation's rel() checks isOnSameTeam before isAlliedWith, so the
    // payout uses the lower team tier, not the ally tier.
    const teamGame = await setup("plains", {
      gameMode: GameMode.Team,
      playerTeams: 2,
    });
    // Team assignment hashes the player id (GameImpl.maybeAssignTeam);
    // "teamA_id" and "teamC_id" deterministically land on the same team.
    const infoA = new PlayerInfo("teamA", PlayerType.Human, null, "teamA_id");
    const infoB = new PlayerInfo("teamB", PlayerType.Human, null, "teamC_id");
    const teamA = teamGame.addPlayer(infoA);
    const teamB = teamGame.addPlayer(infoB);
    expect(teamA.isOnSameTeam(teamB)).toBe(true);
    teamA.conquer(teamGame.ref(10, 50));
    teamB.conquer(teamGame.ref(30, 50));
    teamA.addGold(10_000_000n);
    teamB.addGold(10_000_000n);
    while (teamGame.inSpawnPhase()) {
      teamGame.executeNextTick();
    }
    teamGame.addExecution(
      new RecomputeRailClusterExecution(teamGame.railNetwork()),
    );

    const factory = teamA.buildUnit(UnitType.Factory, teamGame.ref(10, 50), {});
    const city = teamB.buildUnit(UnitType.City, teamGame.ref(30, 50), {});
    const [fStation, cStation] = wireStations(teamGame, [factory, city]);

    const request = teamA.createAllianceRequest(teamB);
    expect(request).not.toBeNull();
    request!.accept();
    expect(teamA.isAlliedWith(teamB)).toBe(true);
    expect(teamA.isOnSameTeam(teamB)).toBe(true);

    const aBefore = teamA.gold();
    const bBefore = teamB.gold();

    const exec = new TrainExecution(
      teamGame.railNetwork(),
      teamA,
      fStation,
      cStation,
      5,
    );
    teamGame.addExecution(exec);
    for (let i = 0; i < 300 && exec.isActive(); i++) {
      teamGame.executeNextTick();
    }
    expect(exec.isActive()).toBe(false);

    // Team tier (25k), NOT the ally tier (35k), despite the live alliance.
    expect(teamA.gold() - aBefore).toBe(BASE_TEAM);
    expect(teamB.gold() - bBefore).toBe(BASE_TEAM);
    expect(BASE_TEAM < BASE_ALLY).toBe(true);
  });

  test.each([
    [
      "station owner embargoes train owner",
      () => playerB.addEmbargo(playerA, false),
    ],
    [
      "train owner embargoes station owner",
      () => playerA.addEmbargo(playerB, false),
    ],
  ])("mid-flight embargo (%s) kills the train with no payout", (_desc, act) => {
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    const city1 = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    const city2 = playerB.buildUnit(UnitType.City, game.ref(50, 50), {});
    const [fStation, , c2Station] = wireStations(game, [factory, city1, city2]);

    const aBefore = playerA.gold();
    const bBefore = playerB.gold();

    const exec = new TrainExecution(
      game.railNetwork(),
      playerA,
      fStation,
      c2Station,
      5,
    );
    game.addExecution(exec);
    // Let the train spawn and start moving (still on the first leg).
    game.executeNextTick(); // init: units built
    expect(playerA.units(UnitType.Train)).toHaveLength(7); // engine + tail + 5 cars
    game.executeNextTick();
    game.executeNextTick();
    expect(exec.isActive()).toBe(true);

    act();

    // The next-leg trade check fails on the following tick: the train dies
    // before reaching the next station, and nobody is paid.
    game.executeNextTick();
    game.executeNextTick();
    expect(exec.isActive()).toBe(false);
    expect(playerA.units(UnitType.Train)).toHaveLength(0);
    expect(exec.tradeStopsVisited()).toBe(0);
    expect(playerA.gold() - aBefore).toBe(0n);
    expect(playerB.gold() - bBefore).toBe(0n);
  });

  test("destroying the next station kills the in-flight train with no payout", () => {
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    const city1 = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    const city2 = playerB.buildUnit(UnitType.City, game.ref(50, 50), {});
    const [fStation, , c2Station] = wireStations(game, [factory, city1, city2]);

    const aBefore = playerA.gold();
    const bBefore = playerB.gold();

    const exec = new TrainExecution(
      game.railNetwork(),
      playerA,
      fStation,
      c2Station,
      5,
    );
    game.addExecution(exec);
    game.executeNextTick(); // init
    game.executeNextTick();
    game.executeNextTick();
    expect(exec.isActive()).toBe(true);

    // Destroy the next station (city1) while the train is on its first leg.
    city1.delete();

    game.executeNextTick();
    game.executeNextTick();
    expect(exec.isActive()).toBe(false);
    expect(playerA.units(UnitType.Train)).toHaveLength(0);
    expect(playerA.gold() - aBefore).toBe(0n);
    expect(playerB.gold() - bBefore).toBe(0n);
  });

  test("capturing the destination does not kill the train; the tier is recomputed against the new owner", () => {
    const factory = playerA.buildUnit(UnitType.Factory, game.ref(10, 50), {});
    const city = playerB.buildUnit(UnitType.City, game.ref(30, 50), {});
    const [fStation, cStation] = wireStations(game, [factory, city]);

    // A is allied with C (the future captor) but NOT with B (the current
    // station owner). If the tier were locked at departure it would pay the
    // "other" tier; recomputing at stop time against the new owner pays ally.
    const request = playerA.createAllianceRequest(playerC);
    expect(request).not.toBeNull();
    request!.accept();
    expect(playerA.isAlliedWith(playerC)).toBe(true);

    const aBefore = playerA.gold();
    const bBefore = playerB.gold();
    const cBefore = playerC.gold();

    const exec = new TrainExecution(
      game.railNetwork(),
      playerA,
      fStation,
      cStation,
      5,
    );
    game.addExecution(exec);
    game.executeNextTick(); // init
    game.executeNextTick();
    game.executeNextTick();
    expect(exec.isActive()).toBe(true);

    // C captures B's city mid-flight. The station survives with a new owner.
    playerC.captureUnit(city);
    expect(city.owner()).toBe(playerC);
    expect(cStation.isActive()).toBe(true);

    runUntilDone(game, exec);
    expect(exec.isActive()).toBe(false);

    // Train completed and paid the ALLY tier to the new owner; the previous
    // owner got nothing.
    expect(exec.tradeStopsVisited()).toBe(1);
    expect(playerA.gold() - aBefore).toBe(BASE_ALLY);
    expect(playerC.gold() - cBefore).toBe(BASE_ALLY);
    expect(playerB.gold() - bBefore).toBe(0n);
  });
});
