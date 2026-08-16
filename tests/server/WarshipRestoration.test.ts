import { describe, expect, it, vi } from "vitest";
import { Logger } from "winston";

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
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import {
  ClientIntentMessageSchema,
  GameConfig,
  StampedIntent,
} from "../../src/core/Schemas";
import { AgentRunFinalState } from "../../src/server/agents/AgentDecisionLogWriter";
import { validateAgentDecision } from "../../src/server/agents/AgentDecisionValidator";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { AgentRunner } from "../../src/server/agents/AgentRunner";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import {
  AgentDecisionRecord,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { GameServer } from "../../src/server/GameServer";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

// half_land_half_ocean: land is x <= 7, water is x >= 8 (see Warship.test.ts).
const coastX = 7;
const clientID = "CLNT0001";
const rivalClientID = "CLNT0002";
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

const baseGameConfig: GameConfig = {
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

async function navalGame(
  gameConfig: Record<string, unknown> = {},
): Promise<{ game: Game; player: Player; rival: Player }> {
  const game = await setup("half_land_half_ocean", { ...gameConfig }, [
    new PlayerInfo("Navy Agent", PlayerType.Human, clientID, "PLAYER01"),
    new PlayerInfo("Rival", PlayerType.Human, rivalClientID, "PLAYER02"),
  ]);
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  const player = game.player("PLAYER01");
  const rival = game.player("PLAYER02");
  // Coastal territory keeps the player alive and gives it a shoreline.
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

function observationFor(game: Game) {
  return new AgentObservationBuilder().build({
    agentID: "agent-navy",
    clientID,
    username: "Navy Agent",
    profile: "defensive",
    gameID: "WARSHIP1",
    turnNumber: game.ticks(),
    gameState: game,
  });
}

describe("Warship restoration", () => {
  it("offers a legal build_unit Warship action when a port exists, gold suffices, and no config disables it", async () => {
    const { game, player } = await navalGame();
    const portTile = game.ref(coastX, 10);
    player.buildUnit(UnitType.Port, portTile, {});
    player.addGold(50_000_000n);

    const observation = observationFor(game);
    const option = observation.nonCombat.buildOptions.find(
      (build) => build.unit === UnitType.Warship,
    );
    expect(option).toBeDefined();
    // The target tile is the patrol anchor and must be water; the hull spawns
    // at the port (core warshipSpawn returns the port tile as build tile).
    expect(game.isWater(option!.targetTile)).toBe(true);
    expect(option!.buildTile).toBe(portTile);
    // Core accepts the same placement a human could order.
    expect(player.canBuild(UnitType.Warship, option!.targetTile)).not.toBe(
      false,
    );

    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 120,
    });
    const buildAction = actions.find((action) => action.kind === "warship");
    expect(buildAction).toBeDefined();
    expect(buildAction!.intent).toMatchObject({
      type: "build_unit",
      unit: UnitType.Warship,
      tile: option!.targetTile,
    });
    expect(() =>
      ClientIntentMessageSchema.parse({
        type: "intent",
        intent: buildAction!.intent,
      }),
    ).not.toThrow();
  });

  it("offers move_warship options for an owned warship and the selected move passes validator, runner, and core execution", async () => {
    const { game, player, rival } = await navalGame();
    const portTile = game.ref(coastX, 10);
    player.buildUnit(UnitType.Port, portTile, {});
    rival.buildUnit(UnitType.Port, game.ref(coastX, 14), {});
    // Patrol the far corner of the ocean so every derived target (own-port
    // anchorage, hostile shoreline, rival port lane) is a real reposition,
    // not a suppressed near-no-op move.
    const warshipTile = game.ref(coastX + 2, 1);
    const warship = player.buildUnit(UnitType.Warship, warshipTile, {
      patrolTile: warshipTile,
    });

    const observation = observationFor(game);
    const moveOptions = observation.nonCombat.warshipMoveOptions ?? [];
    expect(moveOptions.length).toBeGreaterThan(0);
    for (const option of moveOptions) {
      expect(option.unitIDs).toEqual([warship.id()]);
      expect(game.isWater(option.targetTile)).toBe(true);
      expect(option.legalReason.length).toBeGreaterThan(0);
    }

    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 120,
    });
    const moveAction = actions.find((action) => action.kind === "move_warship");
    expect(moveAction).toBeDefined();
    if (moveAction!.intent?.type !== "move_warship") {
      throw new Error("move_warship action must carry a move_warship intent");
    }
    const moveIntent = moveAction!.intent;
    expect(moveIntent.unitIds).toEqual([warship.id()]);

    // Validator accepts the offered id.
    const validation = validateAgentDecision(
      { actionID: moveAction!.id, reason: "Reposition the patrol." },
      actions,
    );
    expect(validation.ok).toBe(true);
    if (validation.ok !== true) {
      throw new Error("unreachable");
    }

    // Runner submits it into the GameServer intent queue unchanged.
    const log = makeLogger();
    const gameServer = new GameServer(
      "WARSHIP2",
      log,
      Date.now(),
      serverConfig,
      baseGameConfig,
      persistentID,
    );
    const agent = new AgentRunner({
      agentID: "agent-navy",
      username: "Navy Agent",
      persistentID,
      log,
    });
    expect(agent.attachToGame(gameServer).status).toBe("joined");
    const submission = agent.submitLegalAction(validation.action);
    expect(submission.accepted).toBe(true);
    const queued = (
      gameServer as unknown as { intents: StampedIntent[] }
    ).intents.find((intent) => intent.type === "move_warship");
    expect(queued).toMatchObject({
      type: "move_warship",
      unitIds: [warship.id()],
      tile: moveIntent.tile,
    });

    // Core accepts the same stamped intent: the patrol anchor moves.
    const executor = new Executor(game, "WARSHIP1", clientID);
    game.addExecution(
      ...executor.createExecs({
        turnNumber: game.ticks(),
        intents: [{ ...moveIntent, clientID }],
      }),
    );
    executeTicks(game, 2);
    expect(warship.warshipState().patrolTile).toBe(moveIntent.tile);
  });

  it("still honors an explicit disabledUnits config (config authority restored)", async () => {
    const { game, player } = await navalGame({
      disabledUnits: [UnitType.Warship],
    });
    const portTile = game.ref(coastX, 10);
    player.buildUnit(UnitType.Port, portTile, {});
    player.addGold(50_000_000n);

    expect(player.canBuild(UnitType.Warship, game.ref(coastX + 2, 10))).toBe(
      false,
    );
    const observation = observationFor(game);
    expect(
      observation.nonCombat.buildOptions.some(
        (build) => build.unit === UnitType.Warship,
      ),
    ).toBe(false);
  });

  it("keeps the lobby game config authoritative in GameServer instead of force-disabling warships", () => {
    const log = makeLogger();
    const server = new GameServer(
      "WARSHIP3",
      log,
      Date.now(),
      serverConfig,
      { ...baseGameConfig, disabledUnits: [] },
      persistentID,
    );
    expect(server.gameConfig.disabledUnits).toEqual([]);

    // Explicit disables still apply...
    server.updateGameConfig({ disabledUnits: [UnitType.Warship] });
    expect(server.gameConfig.disabledUnits).toEqual([UnitType.Warship]);

    // ...and the lobby can re-enable: no retirement override survives.
    server.updateGameConfig({ disabledUnits: [] });
    expect(server.gameConfig.disabledUnits).toEqual([]);
  });

  it("emits spectator telemetry events for warship build and move decisions", () => {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "warship-run",
      roster: [
        {
          agentID: "a1",
          username: "Navy Agent",
          profile: "defensive",
          clientID: "c1",
          brainType: "planner-executor",
        },
      ],
      records: [
        record(1, "warship", {
          unit: "Warship",
          targetTile: 700,
          buildTile: 300,
          cost: "250000",
        }),
        record(2, "move_warship", {
          unitCount: 1,
          targetTile: 700,
        }),
      ],
      finalState: finalState(),
    });

    const buildEvent = telemetry.events.find(
      (event) => event.actionKind === "warship",
    );
    expect(buildEvent).toBeDefined();
    expect(buildEvent!.kind).toBe("build");
    expect(buildEvent!.message).toMatch(/warship/i);

    const moveEvent = telemetry.events.find(
      (event) => event.actionKind === "move_warship",
    );
    expect(moveEvent).toBeDefined();
    expect(moveEvent!.kind).toBe("warship_move");
    expect(moveEvent!.message).toMatch(/warship/i);
  });
});

function record(
  sequence: number,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null>,
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "WARSHIPS",
    agentID: "a1",
    clientID: "c1",
    username: "Navy Agent",
    profile: "defensive",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 12,
    observationSummary: "Navy Agent sees the board",
    legalActionIDs: [`${kind}:${sequence}`],
    legalActionIDsByKind: { [kind]: [`${kind}:${sequence}`] },
    attackActionIDs: [],
    chosenActionID: `${kind}:${sequence}`,
    chosenActionKind: kind,
    reason: `Navy Agent selects ${kind}`,
    decisionMetadata: {},
    chosenActionMetadata: metadata,
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
    audit: {
      auditStatus: "confirmed",
      auditReason: "test decision applied",
      after: {
        tick: sequence,
        playerID: "p1",
        isAlive: true,
        hasSpawned: true,
        tilesOwned: 10 + sequence,
        troops: 1000,
        gold: "100",
        unitCounts: {},
        outgoingAttackTargetIDs: [],
        outgoingAllianceRequestRecipientIDs: [],
        outgoingEmbargoTargetIDs: [],
      },
    },
  };
}

function finalState(): AgentRunFinalState {
  return {
    phase: "finished",
    tick: 50,
    turnCount: 500,
    players: [
      {
        agentID: "a1",
        username: "Navy Agent",
        profile: "defensive",
        playerID: "p1",
        isAlive: true,
        tilesOwned: 100,
        troops: 2000,
        gold: "500",
      },
    ],
  };
}
