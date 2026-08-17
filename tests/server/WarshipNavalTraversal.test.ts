import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/configuration/ConfigLoader", () => ({
  getServerConfigFromServer: () => ({
    otelEnabled: () => false,
    otelAuthHeader: () => "",
    otelEndpoint: () => "",
    env: () => 0,
  }),
  getServerConfig: () => ({
    otelEnabled: () => false,
  }),
}));

import path from "node:path";
import { Executor } from "../../src/core/execution/ExecutionManager";
import { WarshipExecution } from "../../src/core/execution/WarshipExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

/**
 * Naval TRAVERSAL, not just order acceptance.
 *
 * `WarshipRestoration.test.ts` (PR #122) proves a `move_warship` order passes
 * the validator, the runner, the intent queue, and core execution — it asserts
 * the patrol ANCHOR is rewritten (`warshipState().patrolTile`). It never
 * asserts the hull actually goes anywhere. Since warships came back in 0.1.48
 * alongside the A* pathfinding fix, "the anchor moved" and "the warship sailed
 * to the anchor" are different claims, and only the second one is naval play.
 *
 * These tests drive `WarshipExecution`'s `WaterPathFinder` over many ticks and
 * assert real displacement: the warship closes distance to its ordered tile,
 * stays on water the whole way, and does not stall short of it.
 */

// half_land_half_ocean: land is x <= 7, water is x >= 8 (same fixture contract
// as Warship.test.ts and WarshipRestoration.test.ts).
const coastX = 7;
// `setup` defaults its map root to __dirname, which is undefined under ESM.
const TEST_UTIL_DIR = path.join(process.cwd(), "tests", "util");
const clientID = "CLNT0001";
const rivalClientID = "CLNT0002";

async function navalGame(): Promise<{
  game: Game;
  player: Player;
  rival: Player;
}> {
  const game = await setup("half_land_half_ocean", { instantBuild: true }, [
    new PlayerInfo("Navy Agent", PlayerType.Human, clientID, "PLAYER01"),
    new PlayerInfo("Rival", PlayerType.Human, rivalClientID, "PLAYER02"),
  ]);
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  const player = game.player("PLAYER01");
  const rival = game.player("PLAYER02");
  for (let y = 8; y <= 12; y++) {
    for (let x = 4; x <= coastX; x++) {
      player.conquer(game.ref(x, y));
    }
  }
  for (let y = 13; y <= 15; y++) {
    for (let x = 4; x <= coastX; x++) {
      rival.conquer(game.ref(x, y));
    }
  }
  return { game, player, rival };
}

function orderMove(game: Game, warship: Unit, tile: TileRef): void {
  const executor = new Executor(game, "WARSHIP_NAV", clientID);
  game.addExecution(
    ...executor.createExecs({
      turnNumber: game.ticks(),
      intents: [
        {
          type: "move_warship",
          unitIds: [warship.id()],
          tile,
          clientID,
        },
      ],
    }),
  );
}

describe("warship naval traversal", () => {
  it("sails the hull across open water to the ordered tile, not just the patrol anchor", async () => {
    const { game, player } = await navalGame();
    const startTile = game.ref(coastX + 1, 10);
    const warship = player.buildUnit(UnitType.Warship, startTile, {
      patrolTile: startTile,
    });
    warship.setUnderConstruction(false);
    // `buildUnit` creates the hull but NOT its behaviour loop; without this the
    // warship can never sail (tests/util/utils.ts:1-4).
    game.addExecution(new WarshipExecution(warship));

    // Far corner of the ocean: a genuine voyage, not a one-step nudge.
    const targetTile = game.ref(game.width() - 1, game.height() - 1);
    expect(game.isWater(startTile)).toBe(true);
    expect(game.isWater(targetTile)).toBe(true);

    const startDistance = game.manhattanDist(startTile, targetTile);
    orderMove(game, warship, targetTile);

    const visited: TileRef[] = [];
    let bestDistance = startDistance;
    for (let tick = 0; tick < 400; tick++) {
      executeTicks(game, 1);
      if (!warship.isActive()) break;
      const tile = warship.tile();
      visited.push(tile);
      bestDistance = Math.min(
        bestDistance,
        game.manhattanDist(tile, targetTile),
      );
      if (tile === targetTile) break;
    }

    // The anchor is bookkeeping; displacement is the behaviour under test.
    expect(warship.warshipState().patrolTile).toBe(targetTile);
    expect(warship.tile()).not.toBe(startTile);
    expect(bestDistance).toBeLessThan(startDistance);

    // Every intermediate tile must be water: a hull crossing land would mean
    // the naval path ignored terrain.
    for (const tile of visited) {
      expect(game.isWater(tile)).toBe(true);
    }

    // It must actually arrive (or effectively arrive at its patrol radius),
    // not creep one tile and stall. A stalled hull is the failure mode the
    // anchor-only assertion cannot see.
    expect(bestDistance).toBeLessThanOrEqual(2);
  }, 60_000);

  it("re-targets mid-voyage instead of finishing the stale order", async () => {
    const { game, player } = await navalGame();
    const startTile = game.ref(coastX + 1, 2);
    const warship = player.buildUnit(UnitType.Warship, startTile, {
      patrolTile: startTile,
    });
    warship.setUnderConstruction(false);
    // `buildUnit` creates the hull but NOT its behaviour loop; without this the
    // warship can never sail (tests/util/utils.ts:1-4).
    game.addExecution(new WarshipExecution(warship));

    const firstTarget = game.ref(game.width() - 1, game.height() - 1);
    orderMove(game, warship, firstTarget);
    executeTicks(game, 40);
    const afterFirstLeg = warship.tile();
    expect(afterFirstLeg).not.toBe(startTile);

    // A new order while under way: the agent changed its mind, which is the
    // normal case in a match (menus are rebuilt every decision step).
    const secondTarget = game.ref(coastX + 1, game.height() - 2);
    orderMove(game, warship, secondTarget);
    const distanceAtReorder = game.manhattanDist(afterFirstLeg, secondTarget);

    let bestToSecond = distanceAtReorder;
    for (let tick = 0; tick < 400; tick++) {
      executeTicks(game, 1);
      if (!warship.isActive()) break;
      bestToSecond = Math.min(
        bestToSecond,
        game.manhattanDist(warship.tile(), secondTarget),
      );
      if (warship.tile() === secondTarget) break;
    }

    expect(warship.warshipState().patrolTile).toBe(secondTarget);
    expect(bestToSecond).toBeLessThan(distanceAtReorder);
    expect(bestToSecond).toBeLessThanOrEqual(2);
  }, 60_000);

  it("keeps the warship affordance reachable only through a port, and reports it once one exists", async () => {
    const { game, player } = await navalGame();

    // No port: the observation must not advertise a warship build option, which
    // is exactly why agents in a real match never see warships until they have
    // invested in a port first.
    const before = new AgentObservationBuilder().build({
      agentID: "agent-navy",
      clientID,
      username: "Navy Agent",
      profile: "defensive",
      gameID: "WARSHIP_NAV",
      turnNumber: game.ticks(),
      gameState: game,
    });
    expect(
      (before.nonCombat.buildOptions ?? []).some(
        (option) => option.unit === UnitType.Warship,
      ),
    ).toBe(false);

    const port = player.buildUnit(UnitType.Port, game.ref(coastX, 10), {});
    port.setUnderConstruction(false);
    player.addGold(10_000_000n);

    const after = new AgentObservationBuilder().build({
      agentID: "agent-navy",
      clientID,
      username: "Navy Agent",
      profile: "defensive",
      gameID: "WARSHIP_NAV",
      turnNumber: game.ticks(),
      gameState: game,
    });
    expect(
      (after.nonCombat.buildOptions ?? []).some(
        (option) => option.unit === UnitType.Warship,
      ),
    ).toBe(true);
  }, 60_000);

  it("completes a long voyage on the real world map, routing around landmasses", async () => {
    // The 0.1.48 A* fix's first real water workout: `half_land_half_ocean` is a
    // 16x16 pond, so it cannot tell a working water graph from a broken one.
    const game = await setup(
      "world",
      { instantBuild: true, infiniteGold: true, nations: "disabled" },
      [new PlayerInfo("Navy Agent", PlayerType.Human, clientID, "PLAYER01")],
      TEST_UTIL_DIR,
    );
    const player = game.player("PLAYER01");

    // Deterministic coastal foothold: first land tile on a coarse lattice that
    // touches water.
    let startTile: TileRef | undefined;
    let homeLand: TileRef | undefined;
    for (
      let y = 100;
      y < game.height() - 100 && startTile === undefined;
      y += 7
    ) {
      for (
        let x = 100;
        x < game.width() - 100 && startTile === undefined;
        x += 7
      ) {
        const tile = game.ref(x, y);
        if (!game.isLand(tile)) continue;
        const water = game.neighbors(tile).find((n) => game.isWater(n));
        if (water === undefined) continue;
        homeLand = tile;
        startTile = water;
      }
    }
    if (startTile === undefined || homeLand === undefined) {
      throw new Error("world fixture has no coastal land on the scan lattice");
    }
    for (const tile of [homeLand, ...game.neighbors(homeLand)]) {
      if (game.isLand(tile)) player.conquer(tile);
    }
    while (game.inSpawnPhase()) game.executeNextTick();

    // Farthest water tile in the SAME water component: reachable by sea, and
    // far enough that a straight line crosses land.
    const component = game.getWaterComponent(startTile);
    expect(component).not.toBeNull();
    let target: TileRef | undefined;
    let startDistance = 0;
    for (let y = 20; y < game.height() - 20; y += 23) {
      for (let x = 20; x < game.width() - 20; x += 23) {
        const tile = game.ref(x, y);
        if (!game.isWater(tile)) continue;
        if (!game.hasWaterComponent(tile, component!)) continue;
        const distance = game.manhattanDist(startTile, tile);
        if (distance > startDistance) {
          startDistance = distance;
          target = tile;
        }
      }
    }
    if (target === undefined) {
      throw new Error("no far same-component water tile found");
    }
    // A voyage worth the name, and one that cannot be flown in a straight line.
    expect(startDistance).toBeGreaterThan(1_000);
    let straightLineLandSamples = 0;
    for (let step = 1; step < 100; step++) {
      const x = Math.round(
        game.x(startTile) + ((game.x(target) - game.x(startTile)) * step) / 100,
      );
      const y = Math.round(
        game.y(startTile) + ((game.y(target) - game.y(startTile)) * step) / 100,
      );
      if (game.isLand(game.ref(x, y))) straightLineLandSamples++;
    }
    expect(straightLineLandSamples).toBeGreaterThan(0);

    const warship = player.buildUnit(UnitType.Warship, startTile, {
      patrolTile: startTile,
    });
    warship.setUnderConstruction(false);
    game.addExecution(new WarshipExecution(warship));
    orderMove(game, warship, target);

    let bestDistance = startDistance;
    let offWaterTicks = 0;
    for (let tick = 0; tick < 3_000; tick++) {
      game.executeNextTick();
      if (!warship.isActive()) break;
      const tile = warship.tile();
      // Water pathing runs on the mini map and is shore-coerced
      // (`ShoreCoercingTransformer` in PathFinding.Water), so a hull may sit on
      // a SHORE tile in passing — but never on inland land.
      if (!game.isWater(tile) && !game.isShore(tile)) offWaterTicks++;
      bestDistance = Math.min(bestDistance, game.manhattanDist(tile, target));
      if (tile === target) break;
    }

    expect(warship.warshipState().patrolTile).toBe(target);
    expect(offWaterTicks).toBe(0);
    // Closes essentially the whole distance; a broken water graph would stall
    // early or wander.
    expect(bestDistance).toBeLessThan(startDistance * 0.1);
  }, 120_000);
});
