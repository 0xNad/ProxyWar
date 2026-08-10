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

/**
 * Plays the SAME game action an ignorer plays, and additionally proposes a
 * non-aggression pact through the diplomacy slot when one is offered. With
 * the flag off no deal action exists, so the field is never set and the seat
 * is indistinguishable from an ignorer.
 */
function slotProposerBrain(): AgentBrain {
  return {
    brainType: "rule",
    decide: (input: AgentBrainInput) => {
      const expand = input.legalActions.find(
        (action) => action.id === "expand:terra-nullius:10",
      );
      const propose = input.legalActions.find(
        (action) =>
          action.kind === "deal_propose" &&
          action.metadata?.template === "non_aggression_pact",
      );
      return {
        actionID: expand?.id ?? "hold",
        reason: "expand now, pact on the side",
        ...(propose !== undefined ? { dealActionID: propose.id } : {}),
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

async function runArm(flagOn: boolean, dealerUsesSlot = false) {
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
        index === 0
          ? dealerUsesSlot
            ? slotProposerBrain()
            : proposerBrain()
          : ignorerBrain(),
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

function supportRequesterBrain(): AgentBrain {
  return {
    brainType: "rule",
    decide: (input: AgentBrainInput) => {
      const ally = input.legalActions.find(
        (action) =>
          action.kind === "alliance_request" &&
          action.metadata?.recipientName === "Supporter",
      );
      const request = input.legalActions.find(
        (action) =>
          action.kind === "deal_propose" &&
          action.metadata?.template === "support_request" &&
          action.metadata?.recipientName === "Supporter",
      );
      return {
        actionID: ally?.id ?? request?.id ?? "hold",
        reason: ally !== undefined ? "form alliance" : "request support",
      };
    },
  };
}

function supportDonorBrain(): AgentBrain {
  return {
    brainType: "rule",
    decide: (input: AgentBrainInput) => {
      const ally = input.legalActions.find(
        (action) =>
          action.kind === "alliance_request" &&
          action.metadata?.recipientName === "Requester",
      );
      const accept = input.legalActions.find(
        (action) =>
          action.kind === "deal_accept" &&
          action.metadata?.template === "support_request",
      );
      const transfer = input.legalActions.find(
        (action) =>
          action.metadata?.recipientName === "Requester" &&
          ((action.kind === "donate_gold" &&
            Number(action.metadata?.gold ?? 0) >= 50_000) ||
            (action.kind === "donate_troops" &&
              Number(action.metadata?.troops ?? 0) >= 5_000)),
      );
      if (ally !== undefined) {
        return { actionID: ally.id, reason: "form alliance" };
      }
      if (accept !== undefined) {
        return {
          actionID: "hold",
          dealActionID: accept.id,
          reason: "accept feasible support, then transfer next step",
        };
      }
      return {
        actionID: transfer?.id ?? "hold",
        reason: transfer !== undefined ? "send exact promised support" : "hold",
      };
    },
  };
}

async function runSupportReceiptArm() {
  process.env[DEALS_FLAG] = "1";
  const log = makeLogger();
  const mapLoader = new StaticMapLoader();
  const supportConfig: GameConfig = {
    ...gameConfig,
    donateGold: true,
    donateTroops: true,
    maxPlayers: 2,
  };
  const terrain = await loadTerrainMap(
    supportConfig.gameMap,
    supportConfig.gameMapSize,
    mapLoader,
  );
  const participants = createAgentParticipants(
    [
      { username: "Requester", profile: "diplomatic" },
      { username: "Supporter", profile: "defensive" },
    ],
    log,
    {
      brainFactory: (_spec, index) =>
        index === 0 ? supportRequesterBrain() : supportDonorBrain(),
    },
  );
  const game = new GameServer(
    "SUPPORT1",
    log,
    Date.now(),
    steppedServerConfig,
    supportConfig,
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
        maxSteps: 12,
        maxSpawnAdvanceTurns: 2_000,
        maxDecisionMs: 5_000,
        waitForMirrorCatchup: true,
      },
      log,
    });
    return { result, ledger: league.dealLedger() };
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

  it("plays a game action AND a deal action in the same step, with zero effect on the simulation", async () => {
    // Both arms run the SAME game actions; the ON arm additionally fills the
    // diplomacy slot. If deals cost nothing and change nothing, the two
    // simulations must be identical down to the final territory.
    const on = await runArm(true, true);
    const off = await runArm(false, true);

    const dealerRecords = on.result.postSpawnRecords.filter(
      (record) => record.username === "Dealer",
    );
    const slotRecords = dealerRecords.filter(
      (record) => record.decisionMetadata?.dealSeparateSlot === true,
    );
    expect(slotRecords.length).toBeGreaterThan(0);
    for (const record of slotRecords) {
      // The decision's ACTION is a real map move, not the deal.
      expect(record.chosenActionKind).not.toMatch(/^deal_/);
      expect(record.chosenActionID).toBe("expand:terra-nullius:10");
      expect(record.decisionMetadata?.dealAction).toBe("propose");
      expect(record.decisionMetadata?.dealApplyAccepted).toBe(true);
      expect(record.decisionMetadata?.dealStatedReason).toBe(
        "expand now, pact on the side",
      );
      expect(record.decisionMetadata?.dealSlotResult).toMatch(
        /^deal proposed: deal:/,
      );
    }
    // Proposals are paced: the dealer never opens two in consecutive steps.
    expect(slotRecords.length).toBeLessThan(dealerRecords.length);
    expect(on.ledger.deals.length).toBeGreaterThan(0);

    // Nothing about the match changed: same chosen actions for every seat
    // (including the dealer's), and the same final territory.
    for (const username of [
      "Dealer",
      "Ignorer One",
      "Ignorer Two",
      "Ignorer Three",
    ]) {
      expect(on.chosenByUsername(username)).toEqual(
        off.chosenByUsername(username),
      );
      expect(
        on
          .chosenByUsername(username)
          .some((actionID) => actionID.startsWith("deal_")),
      ).toBe(false);
    }
    expect(on.tilesByUsername).toEqual(off.tilesByUsername);
    expect(off.ledger.deals).toEqual([]);
  }, 600_000);

  it("confirms an exact support receipt across a real 25-turn mirror advance", async () => {
    const arm = await runSupportReceiptArm();
    const support = arm.ledger.deals.find(
      (deal) => deal.template === "support_request",
    );
    expect(support).toBeDefined();
    expect(support?.status).toBe("accepted");
    expect(support?.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fulfilled",
          resolutionEvidence: expect.stringContaining("confirmed donation"),
        }),
      ]),
    );
    const transfer = arm.result.postSpawnRecords.find(
      (record) =>
        record.username === "Supporter" &&
        record.audit?.confirmedDonation !== undefined,
    );
    expect(transfer?.audit?.auditStatus).toBe("confirmed");
    expect(transfer?.audit?.before?.sentDonationCount).toBe(0);
    expect(transfer?.audit?.after?.sentDonationCount).toBe(1);
    const receipt = transfer?.audit?.confirmedDonation;
    expect(
      receipt !== undefined &&
        (receipt.resource === "gold"
          ? BigInt(receipt.amount) >= 50_000n
          : receipt.amount >= 5_000),
    ).toBe(true);
  }, 600_000);
});
