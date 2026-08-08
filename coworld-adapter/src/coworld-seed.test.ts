import { describe, expect, it } from "vitest";

import {
  coworldEpisodeIdentity,
  MAX_COWORLD_EPISODE_SEED,
} from "./coworld-seed.ts";

describe("coworldEpisodeIdentity", () => {
  it("preserves the honest legacy identity when no seed is configured", () => {
    expect(coworldEpisodeIdentity(undefined)).toEqual({
      gameId: "COWRLD01",
      seed: null,
    });
  });

  it.each([
    [0, "PWAAAAAA"],
    [1, "PWAAAAAB"],
    [25, "PWAAAAAZ"],
    [26, "PWAAAABA"],
    [MAX_COWORLD_EPISODE_SEED, "PWZZZZZZ"],
  ])("encodes supported seed %i as deterministic game id %s", (seed, gameId) => {
    expect(coworldEpisodeIdentity(seed)).toEqual({ gameId, seed });
  });

  it("keeps sampled seeds distinct and reproducible", () => {
    const seeds = [0, 1, 25, 26, 424242, 123456789, MAX_COWORLD_EPISODE_SEED];
    const first = seeds.map((seed) => coworldEpisodeIdentity(seed).gameId);
    const second = seeds.map((seed) => coworldEpisodeIdentity(seed).gameId);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((gameId) => /^[A-Za-z0-9]{8}$/.test(gameId))).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, MAX_COWORLD_EPISODE_SEED + 1])(
    "rejects unsupported seed %s instead of silently changing identity",
    (seed) => {
      expect(() => coworldEpisodeIdentity(seed)).toThrow(
        `Coworld seed must be an integer from 0 through ${MAX_COWORLD_EPISODE_SEED}`,
      );
    },
  );
});
