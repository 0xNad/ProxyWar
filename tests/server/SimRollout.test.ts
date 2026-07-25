import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { GameMapLoader, MapData } from "../../src/core/game/GameMapLoader";
import { createGameRunner, GameRunner } from "../../src/core/GameRunner";
import {
  GameConfig,
  GameStartInfo,
  StampedIntent,
  Turn,
} from "../../src/core/Schemas";
import { MapManifest } from "../../src/core/game/TerrainMapLoader";
import {
  CandidateCommitment,
  cloneFromSnapshot,
  evaluateCommitments,
  fingerprintGameState,
  forecastCommitment,
  GameSnapshot,
  RolloutAgentSeat,
} from "../../src/server/agents/SimRollout";

// ---------------------------------------------------------------------------
// Test map loader (mirrors the StaticMapLoader pattern used by the league tests:
// reads the real packed maps from resources/maps).
// ---------------------------------------------------------------------------
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

const AGENT_CLIENT = "SIMAGENT";
const RIVAL_CLIENT = "SIMRIVAL";

function gameConfig(): GameConfig {
  return {
    gameMap: GameMapType.Pangaea,
    gameMapSize: GameMapSize.Compact,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    // Nations off so the two human seats fully determine the world; keeps the
    // constructed position controllable and the determinism test tight.
    nations: "disabled",
    bots: 0,
    donateGold: false,
    donateTroops: false,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    disabledUnits: [],
    maxPlayers: 4,
  };
}

function gameStartInfo(): GameStartInfo {
  return {
    gameID: "SIMROLL0",
    lobbyCreatedAt: 0,
    config: gameConfig(),
    players: [
      { clientID: AGENT_CLIENT, username: "Sim Agent", clanTag: null },
      { clientID: RIVAL_CLIENT, username: "Sim Rival", clanTag: null },
    ],
  };
}

function spawnTurn(
  turnNumber: number,
  spawns: Array<{ clientID: string; tile: number }>,
): Turn {
  const intents: StampedIntent[] = spawns.map((s) => ({
    type: "spawn",
    tile: s.tile,
    clientID: s.clientID,
  }));
  return { turnNumber, intents };
}

function emptyTurn(turnNumber: number): Turn {
  return { turnNumber, intents: [] };
}

/**
 * Build a deterministic, asymmetric post-spawn snapshot purely from a turn log.
 *
 * The agent spawns first and grows ALONE for a stretch, then a weaker rival spawns
 * one tile away and both grow on into a shared border. The head start makes the
 * agent the clearly stronger, bordering side at snapshot time — the position where
 * a decisive attack directive can express itself and out-perform turtling. (A
 * symmetric simultaneous spawn produces two equal seats with a large neutral gap
 * between them, where every directive collapses to the same neutral expansion and
 * nothing discriminates — verified via the probe sweep.)
 *
 * Returns the snapshot plus the agent's / rival's tile counts at snapshot time so
 * the test can assert the constructed asymmetry.
 */
async function buildAsymmetricSnapshot(
  opts: { rivalSpawnDelay?: number; growTicks?: number } = {},
): Promise<{
  snapshot: GameSnapshot;
  agentTiles: number;
  rivalTiles: number;
  rivalID: string;
  sharesBorder: boolean;
}> {
  const rivalSpawnDelay = opts.rivalSpawnDelay ?? 80;
  const growTicks = opts.growTicks ?? 300;
  const loader = new StaticMapLoader();
  const startInfo = gameStartInfo();
  const runner = await createGameRunner(
    startInfo,
    undefined,
    loader,
    () => undefined,
  );
  const map = runner.game.map();

  // Place the two seats one tile apart near the middle of the landmass so they
  // grow into a shared border quickly. Pangaea/Compact is a single connected
  // continent, so central tiles are reliably land.
  const cx = Math.floor(map.width() / 2);
  const cy = Math.floor(map.height() / 2);
  const agentTile = landTileNear(runner, cx - 1, cy);
  const rivalTile = landTileNear(runner, cx + 1, cy);

  const turns: Turn[] = [];
  // Tick once empty so the runner is past init, then spawn the agent.
  turns.push(emptyTurn(0));
  turns.push(spawnTurn(1, [{ clientID: AGENT_CLIENT, tile: agentTile }]));
  // Agent grows alone for `rivalSpawnDelay` ticks (the head start).
  let tn = 2;
  for (let i = 0; i < rivalSpawnDelay; i++, tn++) {
    turns.push(emptyTurn(tn));
  }
  // The weaker rival spawns adjacent, then both grow on into a shared border.
  turns.push(spawnTurn(tn++, [{ clientID: RIVAL_CLIENT, tile: rivalTile }]));
  for (let i = 0; i < growTicks; i++, tn++) {
    turns.push(emptyTurn(tn));
  }

  for (const turn of turns) {
    runner.addTurn(turn);
  }
  while (runner.pendingTurns() > 0) {
    runner.executeNextTick(runner.pendingTurns());
  }

  const agent = runner.game.playerByClientID(AGENT_CLIENT);
  const rival = runner.game.playerByClientID(RIVAL_CLIENT);
  if (agent === null || rival === null) {
    throw new Error("test fixture: seats did not spawn");
  }
  const sharesBorder = agent.sharesBorderWith(rival);
  console.error(
    "DIAG snapshot",
    JSON.stringify({
      ticks: runner.game.ticks(),
      agentTiles: agent.numTilesOwned(),
      agentTroops: Math.round(agent.troops()),
      rivalTiles: rival.numTilesOwned(),
      rivalTroops: Math.round(rival.troops()),
      sharesBorder,
    }),
  );

  return {
    snapshot: { gameStartInfo: startInfo, turns },
    agentTiles: agent.numTilesOwned(),
    rivalTiles: rival.numTilesOwned(),
    rivalID: rival.id(),
    sharesBorder,
  };
}

function landTileNear(runner: GameRunner, x: number, y: number): number {
  const map = runner.game.map();
  for (let radius = 0; radius < 40; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.width() || ny >= map.height()) {
          continue;
        }
        const ref = map.ref(nx, ny);
        if (map.isLand(ref)) {
          return ref;
        }
      }
    }
  }
  throw new Error("test fixture: no land tile found near requested location");
}

function seats(rivalProfile: RolloutAgentSeat["profile"]): RolloutAgentSeat[] {
  return [
    { clientID: AGENT_CLIENT, profile: "aggressive" },
    { clientID: RIVAL_CLIENT, profile: rivalProfile },
  ];
}

describe("SimRollout", () => {
  it("clones a snapshot deterministically (same fingerprint twice)", async () => {
    const loader = new StaticMapLoader();
    const { snapshot } = await buildAsymmetricSnapshot();

    const cloneA = await cloneFromSnapshot(snapshot, loader);
    const cloneB = await cloneFromSnapshot(snapshot, loader);

    // Two independent reconstructions of the same log are byte-identical (the
    // core determinism invariant), and they are distinct objects.
    expect(cloneA).not.toBe(cloneB);
    expect(fingerprintGameState(cloneA.game)).toBe(
      fingerprintGameState(cloneB.game),
    );
    // The clone reproduced the constructed position (both seats present + alive).
    expect(cloneA.game.playerByClientID(AGENT_CLIENT)?.isAlive()).toBe(true);
    expect(cloneA.game.playerByClientID(RIVAL_CLIENT)?.isAlive()).toBe(true);
  });

  it("produces exactly reproducible forecasts for the same commitment", async () => {
    const loader = new StaticMapLoader();
    const { snapshot, rivalID } = await buildAsymmetricSnapshot();
    const commitment: CandidateCommitment = {
      id: "pressure-rival",
      objective: "pressure_rival",
      targetPlayerId: rivalID,
      troopRatio: 0.4,
    };

    const first = await forecastCommitment({
      snapshot,
      mapLoader: loader,
      agentClientID: AGENT_CLIENT,
      commitment,
      agents: seats("defensive"),
    });
    const second = await forecastCommitment({
      snapshot,
      mapLoader: loader,
      agentClientID: AGENT_CLIENT,
      commitment,
      agents: seats("defensive"),
    });

    expect(second).toEqual(first);
  });

  it("never mutates the source game when rolling forward", async () => {
    const loader = new StaticMapLoader();
    const { snapshot, rivalID } = await buildAsymmetricSnapshot();

    // A "live" game reconstructed from the same snapshot — this stands in for the
    // caller's in-progress game. Fingerprint it, run a (separate) rollout off the
    // same snapshot, and assert the live game is byte-identical afterwards.
    const live = await cloneFromSnapshot(snapshot, loader);
    const before = fingerprintGameState(live.game);

    await forecastCommitment({
      snapshot,
      mapLoader: loader,
      agentClientID: AGENT_CLIENT,
      commitment: {
        id: "pressure-rival",
        objective: "pressure_rival",
        targetPlayerId: rivalID,
        troopRatio: 0.5,
      },
      agents: seats("defensive"),
    });

    const after = fingerprintGameState(live.game);
    expect(after).toBe(before);
  });

  it("forecast distinguishes a decisive attack from a passive directive", async () => {
    const loader = new StaticMapLoader();
    // Horizon 8: the attack-vs-fortify signal needs a few steps to bite (a short
    // 3-step horizon on this map is dominated by opening neutral expansion, which
    // every directive does identically — verified via the probe sweep).
    const HORIZON = 8;
    const { snapshot, agentTiles, rivalTiles, rivalID, sharesBorder } =
      await buildAsymmetricSnapshot();

    // Sanity: the agent really is the stronger, BORDERING side (constructed
    // asymmetry). If these ever fail it is the fixture, not the engine, that
    // regressed — a decisive attack directive can only out-perform turtling when
    // there is a weaker neighbour to actually press.
    expect(agentTiles).toBeGreaterThan(0);
    expect(rivalTiles).toBeGreaterThan(0);
    expect(agentTiles).toBeGreaterThan(rivalTiles);
    expect(sharesBorder).toBe(true);

    // GOOD: commit decisively to pressuring the weaker bordering rival.
    const pressure: CandidateCommitment = {
      id: "a-pressure-weak-rival",
      objective: "pressure_rival",
      targetPlayerId: rivalID,
      troopRatio: 0.6,
    };
    // PASSIVE: fortify the border instead of attacking — the genuinely worse
    // directive on this position (it forgoes the free territory the attack takes).
    const fortify: CandidateCommitment = {
      id: "c-fortify",
      objective: "fortify_border",
      targetPlayerId: null,
    };
    // ROBUSTNESS: a directive aimed at a rival that does not exist. The binding
    // cannot resolve (no such visible player), so it must NOT crash and must still
    // produce a well-formed forecast. On a one-rival board the executor's own
    // target selection still finds the only enemy, so this is not expected to BEAT
    // the resolvable directive — only to be handled gracefully.
    const pressureGhost: CandidateCommitment = {
      id: "b-pressure-nonexistent",
      objective: "pressure_rival",
      targetPlayerId: "no-such-player",
      troopRatio: 0.6,
    };

    const ranked = await evaluateCommitments({
      snapshot,
      mapLoader: loader,
      agentClientID: AGENT_CLIENT,
      commitments: [pressure, pressureGhost, fortify],
      agents: seats("defensive"),
      config: { horizonSteps: HORIZON },
    });

    console.error(
      "DIAG fixture",
      JSON.stringify({ agentTiles, rivalTiles, rivalID, sharesBorder }),
      "ranked",
      JSON.stringify(ranked),
    );

    expect(ranked).toHaveLength(3);
    const byId = new Map(ranked.map((f) => [f.commitmentId, f]));
    const good = byId.get("a-pressure-weak-rival")!;
    const ghost = byId.get("b-pressure-nonexistent")!;
    const passive = byId.get("c-fortify")!;

    // Forecasts are well-formed and horizon-tagged.
    expect(good.horizonSteps).toBe(HORIZON);
    expect(good.objective).toBe("pressure_rival");
    expect(good.targetPlayerId).toBe(rivalID);
    expect(Number.isFinite(good.outcomeScore)).toBe(true);

    // THE DISCRIMINATION: the decisive attack on the weak neighbour captures more
    // territory than the passive fortify directive, and therefore scores higher.
    // This is exactly what the world-model exists to surface — "committing pays
    // off vs turtling" — grounded in forward simulation rather than vibes.
    expect(good.tileDelta).toBeGreaterThan(passive.tileDelta);
    expect(good.outcomeScore).toBeGreaterThan(passive.outcomeScore);

    // Robustness: the unresolvable directive produced a valid forecast and did not
    // crash; pressing the real target is never WORSE than pressing a phantom.
    expect(ranked).toContain(ghost);
    expect(Number.isFinite(ghost.outcomeScore)).toBe(true);
    expect(good.tileDelta).toBeGreaterThanOrEqual(ghost.tileDelta);

    // Ranking is best-first, so the decisive attack is the top entry.
    expect(ranked[0]!.commitmentId).toBe("a-pressure-weak-rival");

    // Ranking is reproducible across runs (engine determinism end-to-end).
    const rankedAgain = await evaluateCommitments({
      snapshot,
      mapLoader: loader,
      agentClientID: AGENT_CLIENT,
      commitments: [pressure, pressureGhost, fortify],
      agents: seats("defensive"),
      config: { horizonSteps: HORIZON },
    });
    expect(rankedAgain.map((f) => f.commitmentId)).toEqual(
      ranked.map((f) => f.commitmentId),
    );
    expect(rankedAgain).toEqual(ranked);
  }, 120_000);
});
