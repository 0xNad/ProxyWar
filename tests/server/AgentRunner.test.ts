import { describe, expect, it, vi } from "vitest";
import { Logger } from "winston";
import { rankOfferedActionsWithSpatial } from "../../coworld-adapter/tester-starter-llm/owner-capabilities.mjs";

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

import { GameEnv, ServerConfig } from "../../src/core/configuration/Config";
import { Executor } from "../../src/core/execution/ExecutionManager";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "../../src/core/game/Game";
import { GameConfig, Intent, StampedIntent } from "../../src/core/Schemas";
import { validateAgentDecision } from "../../src/server/agents/AgentDecisionValidator";
import { AgentRunner } from "../../src/server/agents/AgentRunner";
import { LegalAction } from "../../src/server/agents/AgentTypes";
import { GameServer } from "../../src/server/GameServer";
import { setup } from "../util/Setup";

const persistentID = "11111111-1111-4111-8111-111111111111";

function makeLogger(): Logger {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

const serverConfig = {
  turnIntervalMs: () => 100,
  env: () => GameEnv.Dev,
} as ServerConfig;

const gameConfig: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Private,
  difficulty: Difficulty.Medium,
  nations: "disabled",
  donateGold: false,
  donateTroops: false,
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  disabledUnits: [],
};

function queuedIntents(game: GameServer): StampedIntent[] {
  return (game as unknown as { intents: StampedIntent[] }).intents;
}

describe("AgentRunner", () => {
  it("joins a private game and queues a validated spawn legal action", () => {
    const log = makeLogger();
    const game = new GameServer(
      "AGENT001",
      log,
      Date.now(),
      serverConfig,
      gameConfig,
      persistentID,
    );
    const agent = new AgentRunner({
      agentID: "hardcoded-agent-1",
      username: "Agent One",
      persistentID,
      log,
    });

    const join = agent.attachToGame(game);
    expect(join.status).toBe("joined");
    expect(
      agent.serverMessages().some((msg) => msg.type === "lobby_info"),
    ).toBe(true);

    const spawnAction: LegalAction = {
      id: "spawn:test:10",
      kind: "spawn",
      label: "Spawn at tile 10",
      intent: { type: "spawn", tile: 10 },
      risk: { level: "none", score: 0 },
    };
    const validation = validateAgentDecision(
      {
        actionID: spawnAction.id,
        reason: "Spawn through the legal action contract.",
      },
      [spawnAction],
    );
    expect(validation.ok).toBe(true);

    const result =
      validation.ok === true
        ? agent.submitLegalAction(validation.action)
        : { accepted: false, reason: validation.reason, intent: null };
    expect(result.accepted).toBe(true);

    const spawnIntent = queuedIntents(game).find(
      (intent) => intent.type === "spawn",
    );
    expect(spawnIntent).toEqual({
      type: "spawn",
      tile: 10,
      clientID: agent.clientID(),
    });
  });

  it("rejects an invalid legal action intent before it reaches the game", () => {
    const log = makeLogger();
    const game = new GameServer(
      "AGENT002",
      log,
      Date.now(),
      serverConfig,
      gameConfig,
      persistentID,
    );
    const agent = new AgentRunner({
      username: "Agent Two",
      persistentID,
      log,
    });

    agent.attachToGame(game);
    const invalidIntent = { type: "spawn", tile: "bad" } as unknown as Intent;
    const result = agent.submitLegalAction({
      id: "spawn:invalid",
      kind: "spawn",
      label: "Invalid spawn",
      intent: invalidIntent,
      risk: { level: "high", score: 1 },
    });

    expect(result.accepted).toBe(false);
    expect(
      queuedIntents(game).filter((intent) => intent.type === "spawn"),
    ).toHaveLength(0);
  });

  it("lets rich spatial state change only which exact offered id reaches validator and runner", () => {
    const actions: LegalAction[] = [
      {
        id: "spawn:10",
        kind: "spawn",
        label: "Spawn at tile 10",
        intent: { type: "spawn", tile: 10 },
        risk: { level: "none", score: 0 },
        metadata: { targetID: "P_A" },
      },
      {
        id: "spawn:20",
        kind: "spawn",
        label: "Spawn at tile 20",
        intent: { type: "spawn", tile: 20 },
        risk: { level: "none", score: 0 },
        metadata: { targetID: "P_B" },
      },
    ];
    const borderWithYou = {
      tiles: 10,
      shareOfYourBorder: 25,
      terrain: "mixed",
      terrainBreakdown: {
        plains: 4,
        highland: 3,
        mountain: 3,
        shore: 2,
      },
      defensePostsCovering: 0,
      defensePostFrontCoverage: { covered: 0, uncovered: 10 },
      underAttackHere: false,
    };
    const observation = {
      ownState: { playerID: "P_SELF" },
      mapInfo: {
        name: "Pangaea",
        width: 100,
        height: 80,
        tileRefEncoding: "row-major-y-width-plus-x",
        coordinateFrame: {
          origin: "top_left",
          xIncreases: "east",
          yIncreases: "south",
        },
      },
      visiblePlayers: [
        { playerID: "P_A", distanceClass: "adjacent", borderWithYou },
        { playerID: "P_B", distanceClass: "adjacent", borderWithYou },
      ],
      spatial: {
        schemaVersion: 3,
        visibilityModel: "global-lockstep-public-map-v1",
        ownShape: {
          quadrant: "west",
          compactness: "compact",
          regionCount: 1,
          largestRegionShare: 100,
          regionAnalysis: "complete",
          centroidBasis: "largest_region_border",
          coastShare: 25,
          centroid: { xPct: 30, yPct: 50 },
        },
        positionedAssets: {
          analysis: "complete",
          structures: [],
          structuresTotal: 0,
          structuresReturned: 0,
          structuresTruncated: false,
          warships: Array.from({ length: 8 }, (_, index) => ({
            ownerPlayerID: "P_B",
            type: "Warship",
            tile: 4_000 + index,
            x: index,
            y: 40,
          })),
          warshipsTotal: 8,
          warshipsReturned: 8,
          warshipsTruncated: false,
        },
      },
    };
    const ranked = rankOfferedActionsWithSpatial(actions, observation);
    expect(ranked[0]).toBe(actions[1]);
    expect(ranked.every((action) => actions.includes(action))).toBe(true);

    const validation = validateAgentDecision(
      { actionID: ranked[0].id, reason: "Use the bounded public map summary." },
      actions,
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error(validation.reason);

    const log = makeLogger();
    const game = new GameServer(
      "SPATIAL1",
      log,
      Date.now(),
      serverConfig,
      gameConfig,
      persistentID,
    );
    const agent = new AgentRunner({
      agentID: "agent-spatial",
      username: "Spatial Agent",
      persistentID,
      log,
    });
    expect(agent.attachToGame(game).status).toBe("joined");
    expect(agent.submitLegalAction(validation.action).accepted).toBe(true);
    expect(
      queuedIntents(game).find((intent) => intent.type === "spawn"),
    ).toMatchObject({
      type: "spawn",
      tile: 20,
      clientID: agent.clientID(),
    });
  });

  it("proves the same stamped spawn intent is legal in core execution", async () => {
    const clientID = "CLNT0001";
    const playerInfo = new PlayerInfo(
      "Agent One",
      PlayerType.Human,
      clientID,
      "PLAYER01",
    );
    const game = await setup("half_land_half_ocean", { nations: "disabled" }, [
      playerInfo,
    ]);
    const executor = new Executor(game, "AGENT001", clientID);

    game.addExecution(
      ...executor.createExecs({
        turnNumber: 0,
        intents: [{ type: "spawn", tile: 10, clientID }],
      }),
    );

    let ticks = 0;
    while (game.inSpawnPhase() && ticks < 1000) {
      game.executeNextTick();
      ticks++;
    }

    expect(ticks).toBeLessThan(1000);
    expect(game.playerByClientID(clientID)?.spawnTile()).toBe(10);
  });
});
