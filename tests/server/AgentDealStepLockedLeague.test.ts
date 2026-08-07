import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "winston";

vi.mock("../../src/core/configuration/ConfigLoader", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/core/configuration/ConfigLoader")
    >();
  return {
    ...actual,
    getServerConfigFromServer: () => ({
      otelEnabled: () => false,
      otelAuthHeader: () => "",
      otelEndpoint: () => "",
      env: () => 0,
    }),
    getServerConfig: () => ({
      otelEnabled: () => false,
    }),
  };
});

import { GameEnv, ServerConfig } from "../../src/core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { GameMapLoader, MapData } from "../../src/core/game/GameMapLoader";
import {
  loadTerrainMap,
  MapManifest,
} from "../../src/core/game/TerrainMapLoader";
import { GameConfig } from "../../src/core/Schemas";
import {
  AgentLeagueMatchRunner,
  createAgentParticipants,
} from "../../src/server/agents/AgentLeagueMatch";
import { AgentLocalGameMirror } from "../../src/server/agents/AgentLocalGameMirror";
import { runAgentStepLockedLeague } from "../../src/server/agents/AgentStepLockedLeague";
import type {
  AgentBrain,
  AgentBrainInput,
} from "../../src/server/agents/AgentTypes";
import { buildSpawnCandidates } from "../../src/server/agents/LegalActionBuilder";
import { GameServer } from "../../src/server/GameServer";
import { DEALS_FLAG } from "./DealTestHarness";

// Phase B end-to-end (real game, real audits, step-locked league): an agent
// that IGNORES deal actions is provably unaffected — its chosen actions and
// the final game state are identical with the flag ON (a rival proposing
// deals at it every chance) and OFF. Deal proposals to it simply expire.
// Also proves: deal meta-actions count as non-hold for the step-locked
// quality gates, audit as not_applicable, and the ledger force-resolves.

function makeLogger(): Logger {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

const steppedServerConfig = {
  turnIntervalMs: () => 60 * 60 * 1_000,
  env: () => GameEnv.Dev,
} as ServerConfig;

const gameConfig: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Compact,
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
  maxPlayers: 4,
};

class StaticMapLoader implements GameMapLoader {
  private readonly maps = new Map<GameMapType, MapData>();
  private readonly rootDir: string;

  constructor() {
    const currentFile = fileURLToPath(import.meta.url);
    this.rootDir = path.resolve(
      path.dirname(currentFile),
      "../../resources/maps",
    );
  }

  getMapData(map: GameMapType): MapData {
    const cached = this.maps.get(map);
    if (cached !== undefined) {
      return cached;
    }
    const mapDir = path.join(this.rootDir, this.mapDirectoryName(map));
    const mapData = {
      mapBin: () => fs.promises.readFile(path.join(mapDir, "map.bin")),
      map4xBin: () => fs.promises.readFile(path.join(mapDir, "map4x.bin")),
      map16xBin: () => fs.promises.readFile(path.join(mapDir, "map16x.bin")),
      manifest: () =>
        fs.promises
          .readFile(path.join(mapDir, "manifest.json"), "utf8")
          .then((text) => JSON.parse(text) as MapManifest),
      webpPath: path.join(mapDir, "thumbnail.webp"),
    } satisfies MapData;
    this.maps.set(map, mapData);
    return mapData;
  }

  private mapDirectoryName(map: GameMapType): string {
    const enumKey = Object.keys(GameMapType).find(
      (key) => GameMapType[key as keyof typeof GameMapType] === map,
    );
    if (enumKey === undefined) {
      throw new Error(`Unknown map: ${map}`);
    }
    return enumKey.toLowerCase();
  }
}

/** Proposes a non-aggression pact whenever one is offered; holds otherwise. */
function proposerBrain(): AgentBrain {
  return {
    brainType: "rule",
    decide: (input: AgentBrainInput) => {
      const propose = input.legalActions.find(
        (action) =>
          action.kind === "deal_propose" &&
          action.metadata?.template === "non_aggression_pact",
      );
      return {
        actionID: propose?.id ?? "hold",
        reason: propose !== undefined ? "propose a pact" : "hold",
      };
    },
  };
}

/** Ignores deals entirely: expands when offered, otherwise holds. */
function ignorerBrain(): AgentBrain {
  return {
    brainType: "rule",
    decide: (input: AgentBrainInput) => {
      const expand = input.legalActions.find(
        (action) => action.id === "expand:terra-nullius:10",
      );
      return {
        actionID: expand?.id ?? "hold",
        reason: expand !== undefined ? "expand" : "hold",
      };
    },
  };
}

async function runArm(flagOn: boolean) {
  if (flagOn) {
    process.env[DEALS_FLAG] = "1";
  } else {
    delete process.env[DEALS_FLAG];
  }
  const log = makeLogger();
  const mapLoader = new StaticMapLoader();
  const terrain = await loadTerrainMap(
    gameConfig.gameMap,
    gameConfig.gameMapSize,
    mapLoader,
  );
  const participants = createAgentParticipants(
    [
      { username: "Dealer", profile: "diplomatic" },
      { username: "Ignorer One", profile: "aggressive" },
      { username: "Ignorer Two", profile: "defensive" },
      { username: "Ignorer Three", profile: "opportunistic" },
    ],
    log,
    {
      brainFactory: (_spec, index) =>
        index === 0 ? proposerBrain() : ignorerBrain(),
    },
  );
  const game = new GameServer(
    "DEALE2E1",
    log,
    Date.now(),
    steppedServerConfig,
    gameConfig,
  );
  const league = new AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates: buildSpawnCandidates(terrain.gameMap, {
      maxCandidates: 300,
      stride: 2,
    }),
    log,
  });
  const mirror = new AgentLocalGameMirror(mapLoader, log);
  try {
    league.attachAgents();
    league.startGame();
    const result = await runAgentStepLockedLeague({
      league,
      game,
      mirror,
      messages: () => participants[0]?.runner.serverMessages() ?? [],
      config: {
        turnsPerDecisionStep: 25,
        maxSteps: 6,
        maxSpawnAdvanceTurns: 2_000,
        maxDecisionMs: 5_000,
        waitForMirrorCatchup: true,
      },
      log,
    });
    const tilesByUsername = new Map(
      participants.map((participant) => {
        const clientID = participant.runner.clientID();
        const player =
          clientID === null
            ? null
            : result.finalGameState.playerByClientID(clientID);
        return [participant.spec.username, player?.numTilesOwned() ?? null];
      }),
    );
    return {
      result,
      ledger: league.dealLedger(),
      tilesByUsername,
      chosenByUsername: (username: string) =>
        result.postSpawnRecords
          .filter((record) => record.username === username)
          .map((record) => record.chosenActionID),
    };
  } finally {
    await game.end({ archive: false });
  }
}

describe("structured deals — step-locked league end to end", () => {
  afterEach(() => {
    delete process.env[DEALS_FLAG];
  });

  it("leaves deal-ignoring agents provably unaffected while the ledger resolves", async () => {
    const on = await runArm(true);
    const off = await runArm(false);

    // The dealer proposed at least once, as a first-class non-hold decision.
    const dealRecords = on.result.postSpawnRecords.filter((record) =>
      record.chosenActionKind.startsWith("deal_"),
    );
    expect(dealRecords.length).toBeGreaterThan(0);
    for (const record of dealRecords) {
      expect(record.chosenActionKind).toBe("deal_propose");
      expect(record.result.accepted).toBe(true);
      expect(record.result.reason).toMatch(/^deal proposed: deal:/);
      expect(record.intent).toBeNull();
      // Deal meta-actions audit as not_applicable (their truth lives in the
      // compliance ledger, not the game-effect audit).
      expect(record.audit?.auditStatus).toBe("not_applicable");
      expect(record.decisionMetadata?.dealAction).toBe("propose");
    }

    // Hold-quality gates: deal actions count as non-hold decisions.
    const nonHoldExpected = on.result.postSpawnRecords.filter(
      (record) =>
        record.chosenActionKind !== "hold" &&
        record.chosenActionKind !== "spawn",
    ).length;
    expect(on.result.postSpawnNonHoldActionCount).toBe(nonHoldExpected);
    expect(nonHoldExpected).toBeGreaterThanOrEqual(dealRecords.length);
    expect(on.result.onlyHoldReason).toBeNull();

    // The ignoring agents chose EXACTLY the same actions with the flag on
    // (deals offered at them, proposals pending) as with it off.
    for (const username of ["Ignorer One", "Ignorer Two", "Ignorer Three"]) {
      expect(on.chosenByUsername(username)).toEqual(
        off.chosenByUsername(username),
      );
      expect(
        on
          .chosenByUsername(username)
          .some((actionID) => actionID.startsWith("deal_")),
      ).toBe(false);
    }
    // And the simulation itself is untouched: identical final territory.
    expect(on.tilesByUsername).toEqual(off.tilesByUsername);

    // Ledger: proposals to non-responders expired silently (TTL) or, if
    // still open at match end, were force-resolved to expired — every deal
    // reached a terminal state and no obligation is left pending.
    expect(on.ledger.deals.length).toBeGreaterThan(0);
    for (const deal of on.ledger.deals) {
      expect(["expired", "rejected", "withdrawn"]).toContain(deal.status);
      for (const obligation of deal.obligations) {
        expect(obligation.status).not.toBe("pending");
      }
    }
    expect(
      on.ledger.events.filter((event) => event.event === "deal_proposed")
        .length,
    ).toBeGreaterThan(0);

    // Flag OFF arm: no deal surface at all.
    expect(off.ledger.deals).toEqual([]);
    expect(
      off.result.postSpawnRecords.some((record) =>
        record.chosenActionKind.startsWith("deal_"),
      ),
    ).toBe(false);
  }, 600_000);
});
