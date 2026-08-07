import { TradeShipExecution } from "../../../src/core/execution/TradeShipExecution";
import { WarshipExecution } from "../../../src/core/execution/WarshipExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { setup } from "../../util/Setup";

// Phase 0 regression tests (economy+negotiation project): trade ship
// interrupts on the real harness.
//
// Base facts under test (verified against current source):
// - a mid-voyage embargo between the source and destination owners (either
//   direction) kills the ship with no payout (TradeShipExecution.tick:
//   !tradeShipOwner.canTrade(dstPortOwner) -> delete)
// - after a warship capture, the captor collects 100% of the payout on
//   delivery and neither original party is paid (TradeShipExecution.complete,
//   wasCaptured branch)
//
// Warship note: warships were retired from NEW gameplay on 2026-08-07
// (PR #35) at the client/server/agent layer only - the core
// WarshipExecution, unit type, and capture mechanics remain fully
// constructible as replay-compat, so the capture payout stays testable here
// (and tests/Warship.test.ts still exercises the hunt mechanics).

let game: Game;
let trader: Player; // source-port owner and original ship owner
let destOwner: Player; // destination-port owner
let pirate: Player; // captor
let srcPort: Unit;
let dstPort: Unit;

function activeTradeShip(p: Player): Unit | undefined {
  return p.units(UnitType.TradeShip)[0];
}

describe("Trade ship interrupts", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", {}, [
      new PlayerInfo("trader", PlayerType.Human, null, "trader_id"),
      new PlayerInfo("destOwner", PlayerType.Human, null, "dest_id"),
      new PlayerInfo("pirate", PlayerType.Human, null, "pirate_id"),
    ]);
    trader = game.player("trader_id");
    destOwner = game.player("dest_id");
    pirate = game.player("pirate_id");
    // Own one land tile each: the trade ship spawn path goes through
    // canBuild, which requires a living owner.
    trader.conquer(game.ref(0, 3));
    destOwner.conquer(game.ref(0, 12));
    pirate.conquer(game.ref(0, 8));
    trader.addGold(10_000_000n);
    destOwner.addGold(10_000_000n);
    pirate.addGold(10_000_000n);

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    // Coast is at x=7 on this map, open water from x=8 (same layout as
    // tests/Warship.test.ts).
    expect(game.isWater(game.ref(9, 8))).toBe(true);
    srcPort = trader.buildUnit(UnitType.Port, game.ref(7, 3), {});
    dstPort = destOwner.buildUnit(UnitType.Port, game.ref(7, 12), {});
  });

  test.each([
    [
      "destination owner embargoes ship owner",
      () => destOwner.addEmbargo(trader, false),
    ],
    [
      "ship owner embargoes destination owner",
      () => trader.addEmbargo(destOwner, false),
    ],
  ])("mid-voyage embargo (%s) kills the ship with no payout", (_desc, act) => {
    const traderBefore = trader.gold();
    const destBefore = destOwner.gold();

    const exec = new TradeShipExecution(trader, srcPort, dstPort);
    game.addExecution(exec);
    game.executeNextTick(); // init
    game.executeNextTick(); // ship built + first move
    game.executeNextTick();
    game.executeNextTick();
    const ship = activeTradeShip(trader);
    expect(ship).toBeDefined();
    expect(ship!.isActive()).toBe(true);
    expect(exec.isActive()).toBe(true);

    act();

    game.executeNextTick();
    game.executeNextTick();
    expect(exec.isActive()).toBe(false);
    expect(ship!.isActive()).toBe(false);

    // No payout on either side.
    expect(trader.gold()).toBe(traderBefore);
    expect(destOwner.gold()).toBe(destBefore);
  });

  test("after a warship capture the captor collects 100% on delivery", () => {
    // The captor needs a port: it gates trade-ship hunting and becomes the
    // captured ship's new destination.
    const piratePort = pirate.buildUnit(UnitType.Port, game.ref(7, 8), {});
    const warship = pirate.buildUnit(UnitType.Warship, game.ref(9, 8), {
      patrolTile: game.ref(9, 8),
    });
    game.addExecution(new WarshipExecution(warship));

    // Freshly spawned trade ships are pirate-safe for 20 ticks and re-arm
    // when hugging the shoreline; disable the grace period so the hunt is
    // deterministic on this tiny map.
    game.config().safeFromPiratesCooldownMax = () => 0;

    const traderBefore = trader.gold();
    const destBefore = destOwner.gold();
    const pirateBefore = pirate.gold();

    const exec = new TradeShipExecution(trader, srcPort, dstPort);
    game.addExecution(exec);
    game.executeNextTick(); // init
    game.executeNextTick(); // ship built
    const ship = activeTradeShip(trader) ?? activeTradeShip(pirate);
    expect(ship).toBeDefined();

    // Run until the warship captures the ship (ownership flips to the
    // pirate), then until the voyage completes at the pirate's own port.
    for (let i = 0; i < 60 && ship!.owner() !== pirate; i++) {
      game.executeNextTick();
    }
    expect(ship!.owner()).toBe(pirate);
    expect(exec.isActive()).toBe(true);

    for (let i = 0; i < 120 && exec.isActive(); i++) {
      game.executeNextTick();
    }
    expect(exec.isActive()).toBe(false);
    expect(ship!.isActive()).toBe(false);
    // The captured ship was rerouted to the captor's port and delivered.
    expect(piratePort.isActive()).toBe(true);

    // The captor collects the full distance payout; the original trader and
    // the original destination owner get nothing.
    const tilesTraveled = (exec as unknown as { tilesTraveled: number })
      .tilesTraveled;
    expect(tilesTraveled).toBeGreaterThan(0);
    const expectedGold = game.config().tradeShipGold(tilesTraveled, pirate);
    expect(expectedGold).toBeGreaterThan(0n);
    expect(pirate.gold() - pirateBefore).toBe(expectedGold);
    expect(trader.gold()).toBe(traderBefore);
    expect(destOwner.gold()).toBe(destBefore);
  });
});
