import { describe, expect, it, vi } from "vitest";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import {
  createGame as createPathfindingGame,
  L,
  W,
} from "../core/pathfinding/_fixtures";
import { setup } from "../util/Setup";

async function threePlayerGame() {
  const agent = new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT");
  const rivalA = new PlayerInfo("Rival A", PlayerType.Human, "CLNT_A", "P_A");
  const rivalB = new PlayerInfo("Rival B", PlayerType.Human, "CLNT_B", "P_B");
  const game = await setup(
    "plains",
    { nations: "disabled", infiniteGold: true, instantBuild: true, infiniteTroops: true },
    [agent, rivalA, rivalB],
  );
  game.player("P_AGENT").conquer(game.ref(0, 0));
  game.player("P_A").conquer(game.ref(0, 1));
  game.player("P_B").conquer(game.ref(0, 2));
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  return game;
}

function observe(game: Game) {
  return new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: "CLNT_AGENT",
    username: "Agent",
    profile: "aggressive",
    gameID: "COALITION",
    turnNumber: 10,
    gameState: game,
  });
}

function boatOptionsFor(
  builder: AgentObservationBuilder,
  game: Game,
  player: PlayerInfo,
) {
  return (
    builder.build({
      agentID: `agent-${player.id}`,
      clientID: player.clientID,
      username: player.name,
      profile: "aggressive",
      gameID: "BOAT_TARGETS",
      turnNumber: game.ticks(),
      gameState: game,
    }).nonCombat.boatOptions ?? []
  );
}

function spawnPlayers(
  game: Game,
  players: Array<{ info: PlayerInfo; x: number; y: number }>,
): void {
  for (const { info, x, y } of players) {
    game.addPlayer(info);
    game.addExecution(new SpawnExecution("BOAT_TARGETS", info, game.ref(x, y)));
  }
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
}

function disconnectedSeasGame(): {
  game: Game;
  agent: PlayerInfo;
  rival: PlayerInfo;
  unreachableShore: number;
  reachableShore: number;
} {
  const width = 20;
  const height = 20;
  const row = [W, W, ...Array<string>(16).fill(L), W, W];
  const game = createPathfindingGame({
    width,
    height,
    grid: Array.from({ length: height }, () => [...row]).flat(),
  });
  const agent = new PlayerInfo(
    "Agent",
    PlayerType.Human,
    "CLNT_AGENT",
    "P_AGENT",
  );
  const rival = new PlayerInfo(
    "Rival",
    PlayerType.Human,
    "CLNT_RIVAL",
    "P_RIVAL",
  );
  spawnPlayers(game, [
    { info: agent, x: 4, y: 1 },
    { info: rival, x: 15, y: 1 },
  ]);

  const unreachableShore = game.ref(17, 1);
  const reachableShore = game.ref(2, 19);
  game.player(rival.id).conquer(unreachableShore);
  game.player(rival.id).conquer(reachableShore);

  return { game, agent, rival, unreachableShore, reachableShore };
}

function ally(
  game: Awaited<ReturnType<typeof threePlayerGame>>,
  a: string,
  b: string,
): void {
  const pa = game.player(a);
  const pb = game.player(b);
  game.addExecution(new AllianceRequestExecution(pa, pb.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(pb, pa.id()));
  game.executeNextTick();
}

describe("AgentObservationBuilder rival-rival coalition graph", () => {
  it("surfaces which rivals are allied with EACH OTHER (not just with the agent)", async () => {
    const game = await threePlayerGame();
    ally(game, "P_A", "P_B");
    expect(game.player("P_A").isAlliedWith(game.player("P_B"))).toBe(true);

    const observation = observe(game);
    const seenA = observation.visiblePlayers.find((p) => p.playerID === "P_A");
    const seenB = observation.visiblePlayers.find((p) => p.playerID === "P_B");

    // The agent (not part of the coalition) can SEE the rival-rival alliance.
    expect(seenA?.alliedWithVisibleIds).toEqual(["P_B"]);
    expect(seenB?.alliedWithVisibleIds).toEqual(["P_A"]);
    // And the agent's own alliance flag stays false for both — this is a coalition it is
    // NOT in (the 3v1-forming signal that was previously invisible).
    expect(seenA?.isAllied).toBe(false);
    expect(seenB?.isAllied).toBe(false);
  });

  it("omits alliedWithVisibleIds when a rival has no alliances", async () => {
    const game = await threePlayerGame();
    const observation = observe(game);
    for (const rival of observation.visiblePlayers) {
      expect(rival.alliedWithVisibleIds).toBeUndefined();
    }
  });

  it("excludes the agent's own alliance from a rival's coalition list", async () => {
    // The agent allies rivalA. That must show as isAllied on rivalA, NOT as a rival-rival
    // edge — alliedWithVisibleIds is strictly OTHER rivals (the agent is excluded).
    const game = await threePlayerGame();
    ally(game, "P_AGENT", "P_A");
    expect(game.player("P_AGENT").isAlliedWith(game.player("P_A"))).toBe(true);

    const observation = observe(game);
    const seenA = observation.visiblePlayers.find((p) => p.playerID === "P_A");
    expect(seenA?.isAllied).toBe(true);
    // rivalA is allied only with the agent, so it has no rival-rival edge.
    expect(seenA?.alliedWithVisibleIds).toBeUndefined();
  });

  it("marks a rival under siege when another rival has a live attack on it", async () => {
    const game = await threePlayerGame();
    const rivalA = game.player("P_A");
    const rivalB = game.player("P_B");
    rivalA.conquer(game.ref(1, 1));
    rivalA.conquer(game.ref(2, 1));

    game.addExecution(new AttackExecution(100, rivalB, rivalA.id()));
    game.executeNextTick();

    expect(rivalA.incomingAttacks().length).toBeGreaterThan(0);
    const seenA = observe(game).visiblePlayers.find(
      (player) => player.playerID === "P_A",
    );
    expect(seenA?.underSiege).toBe(true);
    expect(seenA?.incomingAttack).toBe(false);
  });
});

describe("AgentObservationBuilder boat targets", () => {
  it("reuses the neutral-shore scan without changing either seat's options", () => {
    const { game, agent, rival } = disconnectedSeasGame();
    const sharedBuilder = new AgentObservationBuilder();
    const scan = vi.spyOn(game, "forEachTile");

    const cachedAtTick = [
      boatOptionsFor(sharedBuilder, game, agent),
      boatOptionsFor(sharedBuilder, game, rival),
    ];
    expect(scan).toHaveBeenCalledTimes(1);

    scan.mockClear();
    const uncachedAtTick = [
      boatOptionsFor(new AgentObservationBuilder(), game, agent),
      boatOptionsFor(new AgentObservationBuilder(), game, rival),
    ];
    expect(scan).toHaveBeenCalledTimes(2);
    expect(cachedAtTick).toEqual(uncachedAtTick);

    const claimedOption = cachedAtTick[0].find(
      (option) => option.targetID === null,
    );
    expect(claimedOption).toBeDefined();
    game.player(agent.id).conquer(claimedOption!.targetTile);
    const previousTick = game.ticks();
    game.executeNextTick();
    expect(game.ticks()).toBe(previousTick + 1);

    scan.mockClear();
    const cachedAfterOwnershipChange = [
      boatOptionsFor(sharedBuilder, game, agent),
      boatOptionsFor(sharedBuilder, game, rival),
    ];
    expect(scan).toHaveBeenCalledTimes(1);

    scan.mockClear();
    const uncachedAfterOwnershipChange = [
      boatOptionsFor(new AgentObservationBuilder(), game, agent),
      boatOptionsFor(new AgentObservationBuilder(), game, rival),
    ];
    expect(scan).toHaveBeenCalledTimes(2);
    expect(cachedAfterOwnershipChange).toEqual(uncachedAfterOwnershipChange);
    expect(
      cachedAfterOwnershipChange[0].some(
        (option) => option.targetTile === claimedOption!.targetTile,
      ),
    ).toBe(false);
  });

  it("offers a hostile transatlantic landing on the real World map", async () => {
    const game = await setup("world", {
      nations: "disabled",
      infiniteTroops: true,
    });
    const agent = new PlayerInfo(
      "Agent",
      PlayerType.Human,
      "CLNT_AGENT",
      "P_AGENT",
    );
    const rival = new PlayerInfo(
      "Rival",
      PlayerType.Human,
      "CLNT_RIVAL",
      "P_RIVAL",
    );
    const nearestShore = (x: number, y: number): number => {
      let best: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      game.forEachTile((tile) => {
        if (!game.isShore(tile)) return;
        const distance =
          Math.abs(game.x(tile) - x) + Math.abs(game.y(tile) - y);
        if (distance < bestDistance) {
          best = tile;
          bestDistance = distance;
        }
      });
      expect(best).not.toBeNull();
      return best!;
    };
    const miamiShore = nearestShore(488, 355);
    const spainShore = nearestShore(926, 283);

    game.addPlayer(agent);
    game.addPlayer(rival);
    game.addExecution(
      new SpawnExecution("WORLD_BOAT_TARGETS", agent, miamiShore),
    );
    game.addExecution(
      new SpawnExecution("WORLD_BOAT_TARGETS", rival, spainShore),
    );
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    expect(game.getWaterComponent(miamiShore)).toBe(
      game.getWaterComponent(spainShore),
    );
    expect(
      game.player(agent.id).canBuild(UnitType.TransportShip, spainShore),
    ).not.toBe(false);

    const observation = observe(game);
    const boatActions = new LegalActionBuilder()
      .build({ observation })
      .filter((action) => action.kind === "boat");
    expect(
      boatActions.some((action) => action.metadata?.targetID === rival.id),
    ).toBe(true);
  });

  it("offers a reachable later coastline when an enemy's first coastline is disconnected", () => {
    const { game, rival, unreachableShore, reachableShore } =
      disconnectedSeasGame();
    const player = game.player("P_AGENT");
    const enemyShores = Array.from(game.player(rival.id).borderTiles()).filter(
      (tile) => game.isShore(tile),
    );

    expect(enemyShores.indexOf(unreachableShore)).toBeLessThan(
      enemyShores.indexOf(reachableShore),
    );
    expect(player.canBuild(UnitType.TransportShip, unreachableShore)).toBe(
      false,
    );
    expect(player.canBuild(UnitType.TransportShip, reachableShore)).not.toBe(
      false,
    );

    const boatOptions = observe(game).nonCombat.boatOptions ?? [];
    expect(boatOptions).toHaveLength(6);
    expect(boatOptions.some((option) => option.targetID === null)).toBe(true);
    expect(boatOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetID: rival.id,
          targetTile: reachableShore,
        }),
      ]),
    );
    const legalBoatActions = new LegalActionBuilder()
      .build({ observation: observe(game) })
      .filter((action) => action.kind === "boat");
    expect(
      legalBoatActions.some(
        (action) => action.metadata?.targetID === rival.id,
      ),
    ).toBe(true);
    expect(
      legalBoatActions.some(
        (action) => action.metadata?.targetName === "Terra Nullius",
      ),
    ).toBe(true);

    const repeatedBoatOptions = observe(game).nonCombat.boatOptions ?? [];
    expect(JSON.stringify(repeatedBoatOptions)).toBe(
      JSON.stringify(boatOptions),
    );
  });

  it("does not offer an enemy whose coastlines are genuinely disconnected", () => {
    const { game, rival, reachableShore } = disconnectedSeasGame();
    game.player(rival.id).relinquish(reachableShore);

    const player = game.player("P_AGENT");
    const rivalShores = Array.from(game.player(rival.id).borderTiles()).filter(
      (tile) => game.isShore(tile),
    );
    expect(rivalShores.length).toBeGreaterThan(0);
    expect(
      rivalShores.every(
        (tile) => player.canBuild(UnitType.TransportShip, tile) === false,
      ),
    ).toBe(true);

    const boatOptions = observe(game).nonCombat.boatOptions ?? [];
    expect(boatOptions.some((option) => option.targetID === rival.id)).toBe(
      false,
    );
  });

  it("does not hide a reachable naval target merely because it is stronger and shares a land border", () => {
    const { game, rival, reachableShore } = disconnectedSeasGame();
    const player = game.player("P_AGENT");
    const enemy = game.player(rival.id);
    const adjacentNeutral = Array.from(player.borderTiles())
      .flatMap((tile) => Array.from(game.neighbors(tile)))
      .find(
        (tile) =>
          game.isLand(tile) &&
          game.owner(tile) !== player &&
          game.owner(tile) !== enemy,
      );
    expect(adjacentNeutral).toBeDefined();
    enemy.conquer(adjacentNeutral!);
    enemy.setTroops(player.troops() + 100_000);

    expect(player.sharesBorderWith(enemy)).toBe(true);
    expect(player.canBuild(UnitType.TransportShip, reachableShore)).not.toBe(
      false,
    );
    expect(
      (observe(game).nonCombat.boatOptions ?? []).some(
        (option) => option.targetID === rival.id,
      ),
    ).toBe(true);
  });

  it("reports no launch options when all transport slots are occupied", () => {
    const { game } = disconnectedSeasGame();
    const player = game.player("P_AGENT");
    for (let index = 0; index < game.config().boatMaxNumber(); index += 1) {
      const tile = game.ref(1, index + 1);
      player.buildUnit(UnitType.TransportShip, tile, { targetTile: tile });
    }

    expect(player.unitCount(UnitType.TransportShip)).toBe(
      game.config().boatMaxNumber(),
    );
    expect(observe(game).nonCombat.boatOptions).toEqual([]);
  });

  it("surfaces transport progress and does not offer manual recall for a healthy voyage", () => {
    const { game, rival, reachableShore } = disconnectedSeasGame();
    const player = game.player("P_AGENT");
    const boatTile = game.ref(1, 4);
    const transport = player.buildUnit(UnitType.TransportShip, boatTile, {
      targetTile: reachableShore,
    });

    const observation = observe(game);
    expect(observation.nonCombat.transportLaunch).toEqual({
      activeTransportCount: 1,
      maximumTransportCount: game.config().boatMaxNumber(),
      launchSlotsRemaining: game.config().boatMaxNumber() - 1,
      blocker: null,
    });
    expect(observation.nonCombat.transportStates).toEqual([
      expect.objectContaining({
        unitID: transport.id(),
        status: "en_route",
        tile: boatTile,
        targetTile: reachableShore,
        targetID: rival.id,
        targetName: rival.name,
        remainingManhattanDistance: game.manhattanDist(
          boatTile,
          reachableShore,
        ),
      }),
    ]);

    const legalActions = new LegalActionBuilder().build({ observation });
    expect(legalActions.some((action) => action.kind === "boat_retreat")).toBe(
      false,
    );
  });

  it("shows returning transports as occupying launch slots", () => {
    const { game } = disconnectedSeasGame();
    const player = game.player("P_AGENT");
    const boatTile = game.ref(1, 4);
    const ownShore = Array.from(player.borderTiles()).find((tile) =>
      game.isShore(tile),
    );
    expect(ownShore).toBeDefined();
    const transport = player.buildUnit(UnitType.TransportShip, boatTile, {
      targetTile: ownShore!,
    });
    transport.updateTransportShipState({ isRetreating: true });

    const observation = observe(game);
    expect(observation.nonCombat.boatRetreatOptions).toBeUndefined();
    expect(observation.nonCombat.transportStates).toEqual([
      expect.objectContaining({
        unitID: transport.id(),
        status: "returning",
        targetTile: ownShore,
      }),
    ]);
    expect(observation.nonCombat.transportLaunch?.activeTransportCount).toBe(1);
    expect(observation.nonCombat.transportLaunch?.launchSlotsRemaining).toBe(
      game.config().boatMaxNumber() - 1,
    );
    expect(
      observation.tacticalAffordances?.transportTroopBanking
        .activeTransportCount,
    ).toBe(1);
    expect(
      observation.tacticalAffordances?.navalControl?.activeTransportCount,
    ).toBe(1);
  });
});
