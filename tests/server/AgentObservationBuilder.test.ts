import { describe, expect, it, vi } from "vitest";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import {
  BuildableAttacks,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import {
  AgentObservationBuilder,
  BUILD_OPTION_CANDIDATES,
  buildCandidateLimit,
  SHARED_LAND_STRUCTURE_BUILD_TYPES,
} from "../../src/server/agents/AgentObservationBuilder";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import {
  createGame as createPathfindingGame,
  L,
  W,
} from "../core/pathfinding/_fixtures";
import { setup } from "../util/Setup";

async function plainsGame(
  rivals: PlayerInfo[] = [],
  gameConfig: Parameters<typeof setup>[1] = {},
) {
  const agent = new PlayerInfo(
    "Agent",
    PlayerType.Human,
    "CLNT_AGENT",
    "P_AGENT",
  );
  const players = [agent, ...rivals];
  const game = await setup(
    "plains",
    { nations: "disabled", instantBuild: true, ...gameConfig },
    players,
  );
  for (const [index, player] of players.entries()) {
    game.player(player.id).conquer(game.ref(0, index));
  }
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  return game;
}

async function threePlayerGame() {
  const rivalA = new PlayerInfo("Rival A", PlayerType.Human, "CLNT_A", "P_A");
  const rivalB = new PlayerInfo("Rival B", PlayerType.Human, "CLNT_B", "P_B");
  return plainsGame([rivalA, rivalB], {
    infiniteGold: true,
    infiniteTroops: true,
  });
}

async function finiteGoldGame() {
  const game = await plainsGame();
  const player = game.player("P_AGENT");
  for (let x = 30; x <= 45; x++) {
    for (let y = 46; y <= 54; y++) {
      player.conquer(game.ref(x, y));
    }
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

const BUILD_OPTION_UNITS = [
  UnitType.DefensePost,
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
] as const;

type AgentObservationBuilderInternals = {
  buildOptions(gameState: Game, player: Player): unknown;
  buildSearchTiles(
    gameState: Game,
    player: Player,
    unit: UnitType,
    context: unknown,
  ): readonly number[];
  hostileFrontTiles(gameState: Game, player: Player): number[];
  incomingAttackFrontTiles(gameState: Game, player: Player): number[];
  nukeTargetTiles(gameState: Game, player: Player): number[];
};

function midGameBuildSearchGame(): Game {
  const width = 208;
  const height = 108;
  const grid = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      x === 0 || y === 0 || x === width - 1 || y === height - 1 ? W : L,
    ),
  ).flat();
  const game = createPathfindingGame({ width, height, grid });
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
    { info: agent, x: 20, y: height / 2 },
    { info: rival, x: width - 21, y: height / 2 },
  ]);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const owner = x < width / 2 ? agent : rival;
      game.player(owner.id).conquer(game.ref(x, y));
    }
  }
  return game;
}

function legacyBuildSearchTiles(
  builder: AgentObservationBuilderInternals,
  gameState: Game,
  player: Player,
  unit: UnitType,
): number[] {
  const tiles = Array.from(player.tiles());
  const spawnTile = player.spawnTile();
  let source: number[];
  if (unit === UnitType.DefensePost) {
    source = Array.from(player.borderTiles());
  } else if (unit === UnitType.Port) {
    source = tiles.filter((tile) => gameState.isShore(tile));
  } else if (BuildableAttacks.has(unit)) {
    return builder.nukeTargetTiles(gameState, player);
  } else {
    source = tiles;
  }
  return source.sort((a, b) => {
    if (spawnTile === undefined) {
      return a - b;
    }
    return (
      gameState.manhattanDist(a, spawnTile) -
        gameState.manhattanDist(b, spawnTile) || a - b
    );
  });
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

describe("AgentObservationBuilder build search pruning", () => {
  const buildOptionUnits = new Set<UnitType>(
    BUILD_OPTION_CANDIDATES.map(({ unit }) => unit),
  );
  const sharedLandStructureTypes = new Set<UnitType>(
    SHARED_LAND_STRUCTURE_BUILD_TYPES,
  );

  it("does not search build tiles for unaffordable units", async () => {
    const game = await finiteGoldGame();
    const player = game.player("P_AGENT");
    player.removeGold(player.gold());
    const canBuild = vi.spyOn(player, "canBuild");
    const internals =
      new AgentObservationBuilder() as unknown as AgentObservationBuilderInternals;
    const tiles = vi.spyOn(player, "tiles");
    const hostileFrontTiles = vi.spyOn(internals, "hostileFrontTiles");
    const incomingFrontTiles = vi.spyOn(internals, "incomingAttackFrontTiles");
    const nukeTargetTiles = vi.spyOn(internals, "nukeTargetTiles");

    const buildOptions = internals.buildOptions(game, player);

    expect(buildOptions).toEqual([]);
    expect(
      canBuild.mock.calls.filter(([unit]) => buildOptionUnits.has(unit)),
    ).toEqual([]);
    expect(tiles).not.toHaveBeenCalled();
    expect(hostileFrontTiles).not.toHaveBeenCalled();
    expect(incomingFrontTiles).not.toHaveBeenCalled();
    expect(nukeTargetTiles).not.toHaveBeenCalled();
  });

  it("does not calculate costs for disabled units", async () => {
    const game = await plainsGame([], {
      disabledUnits: [UnitType.AtomBomb],
    });
    const atomBombCost = vi.spyOn(
      game.config().unitInfo(UnitType.AtomBomb),
      "cost",
    );

    observe(game);

    expect(atomBombCost).not.toHaveBeenCalled();
  });

  it("searches build tiles when gold exactly equals the unit cost", async () => {
    const game = await finiteGoldGame();
    const player = game.player("P_AGENT");
    player.removeGold(player.gold());
    player.addGold(game.config().unitInfo(UnitType.City).cost(game, player));

    const observation = observe(game);

    expect(
      observation.nonCombat.buildOptions.some(
        ({ unit }) => unit === UnitType.City,
      ),
    ).toBe(true);
  });

  it("checks each land target only once across structure types", async () => {
    const game = await finiteGoldGame();
    const player = game.player("P_AGENT");
    player.addGold(1_000_000_000_000n);
    player.buildUnit(UnitType.City, game.ref(30, 50), {});
    const canBuild = vi.spyOn(player, "canBuild");

    const observation = observe(game);

    const sharedCalls = canBuild.mock.calls.flatMap(([unit, target], index) =>
      sharedLandStructureTypes.has(unit) ? [{ index, target, unit }] : [],
    );
    const checkedTargets = sharedCalls.map(({ target }) => target);
    const checkedTypes = new Set(sharedCalls.map(({ unit }) => unit));
    expect(checkedTypes.has(UnitType.DefensePost)).toBe(true);
    expect(checkedTypes.has(UnitType.City)).toBe(true);
    expect(new Set(checkedTargets).size).toBeGreaterThan(1);
    expect(new Set(checkedTargets).size).toBe(checkedTargets.length);
    expect(
      sharedCalls.some(({ index, target }) => {
        const buildTile = canBuild.mock.results[index]?.value;
        return buildTile !== false && buildTile !== target;
      }),
    ).toBe(true);

    const sharedOptions = observation.nonCombat.buildOptions.filter(
      ({ unit }) => sharedLandStructureTypes.has(unit),
    );
    const wasDirectlyChecked = (unit: UnitType, target: number) =>
      canBuild.mock.calls.some(
        ([calledUnit, calledTarget]) =>
          calledUnit === unit && calledTarget === target,
      );
    expect(
      sharedOptions.some(
        ({ unit, targetTile }) => !wasDirectlyChecked(unit, targetTile),
      ),
    ).toBe(true);
    for (const option of sharedOptions) {
      expect(option.legalReason).toBe(
        wasDirectlyChecked(option.unit, option.targetTile)
          ? `core canBuild(${option.unit}) returned build tile ${option.buildTile}`
          : `shared land-structure spawn check returned build tile ${option.buildTile}`,
      );
    }
  });

  it("keeps shared land-structure spawn results equivalent", async () => {
    const game = await finiteGoldGame();
    const player = game.player("P_AGENT");
    player.addGold(1_000_000_000_000n);
    player.buildUnit(UnitType.City, game.ref(30, 50), {});
    const targets = [game.ref(30, 50), game.ref(35, 50), game.ref(45, 50)];

    expect(sharedLandStructureTypes.has(UnitType.Port)).toBe(false);
    const [firstType, ...remainingTypes] = SHARED_LAND_STRUCTURE_BUILD_TYPES;
    const expected = targets.map((target) =>
      player.canBuild(firstType, target),
    );
    expect(expected[0]).toBe(false);
    expect(expected[1]).not.toBe(false);
    expect(expected[1]).not.toBe(targets[1]);
    expect(expected[2]).toBe(targets[2]);
    for (const unit of remainingTypes) {
      expect(targets.map((target) => player.canBuild(unit, target))).toEqual(
        expected,
      );
    }
  });
});

describe("AgentObservationBuilder build search", () => {
  it("preserves legacy candidate lists while sharing search work", () => {
    const game = midGameBuildSearchGame();
    const player = game.player("P_AGENT");
    player.addGold(1_000_000_000_000n);
    const builder = new AgentObservationBuilder();
    const internals = builder as unknown as AgentObservationBuilderInternals;
    const expected = new Map<UnitType, number[]>();

    expect(player.numTilesOwned()).toBeGreaterThan(240);
    expect(
      Array.from(player.tiles()).filter((tile) => game.isShore(tile)).length,
    ).toBeGreaterThan(120);
    expect(player.borderTiles().size).toBeGreaterThan(400);
    for (const unit of BUILD_OPTION_UNITS) {
      expected.set(
        unit,
        legacyBuildSearchTiles(internals, game, player, unit).slice(
          0,
          buildCandidateLimit(unit),
        ),
      );
    }

    const tiles = vi.spyOn(player, "tiles");
    const buildSearchTiles = vi.spyOn(internals, "buildSearchTiles");
    const hostileFrontTiles = vi.spyOn(internals, "hostileFrontTiles");
    const incomingFrontTiles = vi.spyOn(internals, "incomingAttackFrontTiles");
    const nukeTargetTiles = vi.spyOn(internals, "nukeTargetTiles");
    vi.spyOn(player, "canBuild").mockReturnValue(false);

    internals.buildOptions(game, player);

    expect(tiles).toHaveBeenCalledTimes(1);
    expect(buildSearchTiles).toHaveBeenCalledTimes(BUILD_OPTION_UNITS.length);
    expect(hostileFrontTiles).toHaveBeenCalledTimes(1);
    expect(incomingFrontTiles).toHaveBeenCalledTimes(1);
    expect(nukeTargetTiles).toHaveBeenCalledTimes(1);

    const actual = new Map<UnitType, number[]>();
    for (const [index, call] of buildSearchTiles.mock.calls.entries()) {
      const unit = call[2];
      const returned = buildSearchTiles.mock.results[index]?.value as
        | readonly number[]
        | undefined;
      expect(returned).toBeDefined();
      actual.set(
        unit,
        Array.from(returned ?? []).slice(0, buildCandidateLimit(unit)),
      );
    }
    for (const unit of BUILD_OPTION_UNITS) {
      expect(actual.get(unit)).toEqual(expected.get(unit));
    }
  });
});

describe("AgentObservationBuilder rival-rival coalition graph", () => {
  it("matches the legacy double-build result with one communication-aware build", async () => {
    const game = await threePlayerGame();
    const input = {
      agentID: "agent-1",
      clientID: "CLNT_AGENT",
      username: "Agent",
      profile: "aggressive" as const,
      gameID: "COMMUNICATION_EQUIVALENCE",
      turnNumber: 10,
      gameState: game,
    };
    const recentCommunications = [
      {
        sequence: 7,
        turnNumber: 9,
        senderAgentID: "rival-agent-a",
        senderPlayerID: "P_A",
        senderName: "Rival A",
        senderProfile: "diplomatic" as const,
        actionKind: "quick_chat" as const,
        intent: "coordinate_attack" as const,
        recipientID: "P_AGENT",
        recipientName: "Agent",
        targetID: "P_B",
        targetName: "Rival B",
        quickChatKey: "attack.now",
        message: "Attack Rival B",
        directToAgent: true,
      },
    ];

    const legacyBuilder = new AgentObservationBuilder();
    legacyBuilder.build(input);
    const legacyDoubleBuild = legacyBuilder.build({
      ...input,
      recentCommunications,
    });

    const singleBuildBuilder = new AgentObservationBuilder();
    const singleBuildSpy = vi.spyOn(singleBuildBuilder, "build");
    const singleBuild = singleBuildBuilder.build({
      ...input,
      recentCommunications,
    });

    expect(singleBuild).toEqual(legacyDoubleBuild);
    expect(singleBuildSpy).toHaveBeenCalledTimes(1);
  });

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
  it("reuses neutral-shore scans only within a stable observation batch", () => {
    const { game, agent, rival } = disconnectedSeasGame();
    const sharedBuilder = new AgentObservationBuilder();
    const scan = vi.spyOn(game, "forEachTile");
    const seats = [agent, rival];

    for (const seat of seats) {
      expect(
        Array.from(game.player(seat.id).borderTiles()).some((tile) =>
          game.isShore(tile),
        ),
      ).toBe(true);
    }

    const buildAndCompare = () => {
      scan.mockClear();
      const batched = sharedBuilder.withObservationBatch(game, () =>
        seats.map((seat) => boatOptionsFor(sharedBuilder, game, seat)),
      );
      expect(scan).toHaveBeenCalledTimes(1);

      scan.mockClear();
      const uncached = seats.map((seat) =>
        boatOptionsFor(sharedBuilder, game, seat),
      );
      expect(scan).toHaveBeenCalledTimes(2);
      expect(batched).toEqual(uncached);
      return batched;
    };

    const cachedAtTick = buildAndCompare();

    const falloutOption = cachedAtTick[0].find(
      (option) => option.targetID === null,
    );
    expect(falloutOption).toBeDefined();
    const previousTick = game.ticks();
    game.setFallout(falloutOption!.targetTile, true);
    expect(game.ticks()).toBe(previousTick);
    expect(game.hasFallout(falloutOption!.targetTile)).toBe(true);

    const cachedAfterFallout = buildAndCompare();
    expect(
      cachedAfterFallout[0].some(
        (option) => option.targetTile === falloutOption!.targetTile,
      ),
    ).toBe(false);

    const claimedOption = cachedAfterFallout[0].find(
      (option) => option.targetID === null,
    );
    expect(claimedOption).toBeDefined();
    game.player(agent.id).conquer(claimedOption!.targetTile);
    game.executeNextTick();
    expect(game.ticks()).toBe(previousTick + 1);

    const cachedAfterOwnershipChange = buildAndCompare();
    expect(
      cachedAfterOwnershipChange[0].some(
        (option) => option.targetTile === claimedOption!.targetTile,
      ),
    ).toBe(false);
  });

  it("restores nested batches and rejects asynchronous callbacks", () => {
    const { game, agent, rival } = disconnectedSeasGame();
    const builder = new AgentObservationBuilder();
    const scan = vi.spyOn(game, "forEachTile");

    builder.withObservationBatch(game, () => {
      boatOptionsFor(builder, game, agent);
      builder.withObservationBatch(game, () => {
        boatOptionsFor(builder, game, rival);
      });
      boatOptionsFor(builder, game, rival);
    });
    expect(scan).toHaveBeenCalledTimes(2);

    const asyncCallback = vi.fn(() => ({ then: () => undefined }));
    expect(() =>
      builder.withObservationBatch(
        game,
        asyncCallback as unknown as () => void,
      ),
    ).toThrow("observation batch callback must be synchronous");

    expect(() =>
      builder.withObservationBatch(game, () => game.executeNextTick()),
    ).toThrow("game tick changed during observation batch");
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
