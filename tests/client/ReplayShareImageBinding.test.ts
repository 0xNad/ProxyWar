import { describe, expect, test } from "vitest";
import {
  readReplayShareStandings,
  replayShareImageTitle,
} from "../../src/client/ReplayShareImageBinding";
import type { GameView } from "../../src/core/game/GameView";

/**
 * Share capture is a convenience layered on top of playback. It reads GameView
 * APIs that a partially-constructed or stubbed view may not expose, and it is
 * mounted from ClientGameRunner.start() — so a throw here would abort game
 * startup entirely. That is not hypothetical: the first version resolved the
 * caption eagerly in start() and took down ten replay tests with
 * "game.config is not a function".
 *
 * These pin the invariant: no shape of GameView may make the share path throw.
 */
describe("replayShareImageTitle", () => {
  test("uses the map name when the view exposes one", () => {
    const game = {
      config: () => ({ gameConfig: () => ({ gameMap: "Pangaea" }) }),
    } as unknown as GameView;
    expect(replayShareImageTitle(game)).toBe("Pangaea");
  });

  test("falls back when config() is missing entirely", () => {
    expect(replayShareImageTitle({} as unknown as GameView)).toBe("Proxy War");
  });

  test("falls back when gameConfig() is missing", () => {
    const game = { config: () => ({}) } as unknown as GameView;
    expect(replayShareImageTitle(game)).toBe("Proxy War");
  });

  test("falls back when the accessor throws", () => {
    const game = {
      config: () => {
        throw new Error("not ready");
      },
    } as unknown as GameView;
    expect(replayShareImageTitle(game)).toBe("Proxy War");
  });

  test("falls back on a blank or non-string map name", () => {
    const blank = {
      config: () => ({ gameConfig: () => ({ gameMap: "   " }) }),
    } as unknown as GameView;
    const numeric = {
      config: () => ({ gameConfig: () => ({ gameMap: 7 }) }),
    } as unknown as GameView;
    expect(replayShareImageTitle(blank)).toBe("Proxy War");
    expect(replayShareImageTitle(numeric)).toBe("Proxy War");
  });
});

describe("readReplayShareStandings", () => {
  const view = (
    players: Array<{ name: string; tiles: number; alive: boolean }>,
    landTiles: number,
    fallout: number,
  ): GameView =>
    ({
      numLandTiles: () => landTiles,
      numTilesWithFallout: () => fallout,
      config: () => ({
        theme: () => ({ territoryColor: () => ({ toHex: () => "#abcdef" }) }),
      }),
      playerViews: () =>
        players.map((p) => ({
          displayName: () => p.name,
          numTilesOwned: () => p.tiles,
          isAlive: () => p.alive,
        })),
    }) as unknown as GameView;

  test("excludes fallout from the denominator, matching the leaderboard", () => {
    // The leaderboard divides by land minus fallout. Diverging here would make
    // the shared image quietly disagree with the page it was captured from.
    const rows = readReplayShareStandings(
      view([{ name: "a", tiles: 250, alive: true }], 1000, 500),
    );
    expect(rows[0].share).toBeCloseTo(0.5, 6);
  });

  test("survives a board that is entirely fallout without dividing by zero", () => {
    const rows = readReplayShareStandings(
      view([{ name: "a", tiles: 0, alive: true }], 1000, 1000),
    );
    expect(Number.isFinite(rows[0].share)).toBe(true);
    expect(rows[0].share).toBe(0);
  });

  test("carries liveness through so eliminated players can be filtered", () => {
    const rows = readReplayShareStandings(
      view(
        [
          { name: "a", tiles: 10, alive: true },
          { name: "dead", tiles: 0, alive: false },
        ],
        100,
        0,
      ),
    );
    expect(rows.map((r) => r.isAlive)).toEqual([true, false]);
  });
});
