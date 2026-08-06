import { Game, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import {
  evaluateSpawnTileLegality,
  parseSpawnTileFromActionID,
  SpawnLegalityContext,
} from "../../src/server/agents/AgentSpawnLegality";
import { buildSpawnCandidates } from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";

function baseContext(gameState: Game): SpawnLegalityContext {
  return { gameState, minSpawnDistance: 8, rivalStakes: [] };
}

function findFirstTile(
  game: Game,
  predicate: (tile: number) => boolean,
): number | null {
  let found: number | null = null;
  game.forEachTile((tile) => {
    if (found === null && predicate(tile)) {
      found = tile;
    }
  });
  return found;
}

async function spawnOnePlayer(game: Game, tile: number): Promise<void> {
  const info = new PlayerInfo("seed", PlayerType.Human, "seed_client", "seed_id");
  game.addExecution(new SpawnExecution("game_id", info, tile));
  while (game.inSpawnPhase() && game.playerByClientID("seed_client") === null) {
    game.executeNextTick();
  }
  // Let the SpawnExecution actually apply (one more tick past acceptance).
  if (game.inSpawnPhase()) {
    game.executeNextTick();
  }
}

describe("evaluateSpawnTileLegality", () => {
  it("accepts a currently-legal tile drawn from the same pool buildSpawnCandidates uses", async () => {
    const game = await setup("half_land_half_ocean");
    const candidate = buildSpawnCandidates(game.map(), { maxCandidates: 5 })[0];
    expect(candidate).toBeDefined();

    const result = evaluateSpawnTileLegality(candidate.tile, baseContext(game));

    expect(result.legal).toBe(true);
    if (result.legal) {
      expect(result.candidate.tile).toBe(candidate.tile);
      expect(result.candidate.x).toBe(game.x(candidate.tile));
      expect(result.candidate.y).toBe(game.y(candidate.tile));
    }
  });

  it("rejects an out-of-bounds tile", async () => {
    const game = await setup("half_land_half_ocean");
    const outOfBounds = game.width() * game.height() + 999_999;

    const result = evaluateSpawnTileLegality(outOfBounds, baseContext(game));

    expect(result.legal).toBe(false);
    if (!result.legal) {
      expect(result.reason).toBe("tile is out of bounds");
    }
  });

  it("rejects a water tile", async () => {
    const game = await setup("half_land_half_ocean");
    const waterTile = findFirstTile(game, (tile) => !game.isLand(tile));
    expect(waterTile).not.toBeNull();

    const result = evaluateSpawnTileLegality(waterTile ?? -1, baseContext(game));

    expect(result.legal).toBe(false);
    if (!result.legal) {
      expect(result.reason).toBe("tile is water");
    }
  });

  it("rejects an occupied tile and a bordering tile once a player has spawned", async () => {
    const game = await setup("half_land_half_ocean");
    const seedTile = buildSpawnCandidates(game.map(), { maxCandidates: 5 })[0].tile;
    await spawnOnePlayer(game, seedTile);
    expect(game.hasOwner(seedTile)).toBe(true);

    const occupied = evaluateSpawnTileLegality(seedTile, baseContext(game));
    expect(occupied.legal).toBe(false);
    if (!occupied.legal) {
      expect(occupied.reason).toBe("tile is occupied");
    }

    const borderTile = findFirstTile(
      game,
      (t) => !game.hasOwner(t) && game.isBorder(t),
    );
    expect(borderTile).not.toBeNull();
    const bordered = evaluateSpawnTileLegality(borderTile ?? -1, baseContext(game));
    expect(bordered.legal).toBe(false);
    if (!bordered.legal) {
      expect(bordered.reason).toBe("tile borders a claimed territory");
    }
  });

  it("rejects a tile within minDistanceBetweenPlayers of an already-spawned player", async () => {
    const game = await setup("half_land_half_ocean");
    const candidates = buildSpawnCandidates(game.map(), { maxCandidates: 500 });
    const seed = candidates[0];
    await spawnOnePlayer(game, seed.tile);
    const minDistance = game.config().minDistanceBetweenPlayers();

    const nearby = candidates.find(
      (c) =>
        c.tile !== seed.tile &&
        !game.hasOwner(c.tile) &&
        !game.isBorder(c.tile) &&
        game.manhattanDist(c.tile, seed.tile) < minDistance,
    );
    expect(nearby).toBeDefined();

    const result = evaluateSpawnTileLegality(nearby!.tile, baseContext(game));
    expect(result.legal).toBe(false);
    if (!result.legal) {
      expect(result.reason).toContain("minDistanceBetweenPlayers");
    }
  });

  it("rejects a tile within the league's minSpawnDistance of another agent's in-progress stake", async () => {
    const game = await setup("half_land_half_ocean");
    const candidate = buildSpawnCandidates(game.map(), { maxCandidates: 5 })[0];
    const ctx: SpawnLegalityContext = {
      gameState: game,
      minSpawnDistance: 8,
      rivalStakes: [
        {
          tile: candidate.tile,
          x: candidate.x,
          y: candidate.y,
          pressureScore: 0,
          safetyScore: 0,
          diplomacyScore: 0,
          opportunityScore: 0,
        },
      ],
    };

    const result = evaluateSpawnTileLegality(candidate.tile, ctx);

    expect(result.legal).toBe(false);
    if (!result.legal) {
      expect(result.reason).toContain("reserved spawn");
    }
  });
});

describe("parseSpawnTileFromActionID", () => {
  it("parses a well-formed spawn:<tile> id", () => {
    expect(parseSpawnTileFromActionID("spawn:12345")).toBe(12345);
    expect(parseSpawnTileFromActionID("spawn:0")).toBe(0);
  });

  it("returns null for any other id shape", () => {
    expect(parseSpawnTileFromActionID("hold")).toBeNull();
    expect(parseSpawnTileFromActionID("spawn:")).toBeNull();
    expect(parseSpawnTileFromActionID("spawn:12.5")).toBeNull();
    expect(parseSpawnTileFromActionID("spawn:-1")).toBeNull();
    expect(parseSpawnTileFromActionID("attack:12345")).toBeNull();
  });
});
