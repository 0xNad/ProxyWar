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
    [0, "PWSAAAAA"],
    [1, "PWSAAAAB"],
    [25, "PWSAAAAZ"],
    [26, "PWSAAABA"],
    [MAX_COWORLD_EPISODE_SEED, "PWSZZZZZ"],
  ])("encodes supported seed %i as deterministic game id %s", (seed, gameId) => {
    expect(coworldEpisodeIdentity(seed)).toEqual({ gameId, seed });
  });

  it("keeps sampled seeds distinct and reproducible", () => {
    const seeds = [0, 1, 25, 26, 424242, 9_876_543, MAX_COWORLD_EPISODE_SEED];
    const first = seeds.map((seed) => coworldEpisodeIdentity(seed).gameId);
    const second = seeds.map((seed) => coworldEpisodeIdentity(seed).gameId);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((gameId) => /^[A-Za-z0-9]{8}$/.test(gameId))).toBe(true);
  });

  it("avoids the signed-hash symmetry that collides in the rejected six-letter range", () => {
    const signedSimpleHash = (value: string) => {
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) {
        hash = (hash << 5) - hash + value.charCodeAt(index);
        hash &= hash;
      }
      return Math.abs(hash);
    };
    // These two old game IDs have the same OpenFront RNG seed. Both numeric
    // seeds are now outside the supported range and therefore cannot alias.
    expect(signedSimpleHash("PWIAAAAB")).toBe(
      signedSimpleHash("PWZWOZIZ"),
    );
    expect(95_051_009).toBeGreaterThan(MAX_COWORLD_EPISODE_SEED);
    expect(307_351_069).toBeGreaterThan(MAX_COWORLD_EPISODE_SEED);

    const boundaryIDs = [
      coworldEpisodeIdentity(0).gameId,
      coworldEpisodeIdentity(MAX_COWORLD_EPISODE_SEED).gameId,
    ];
    expect(boundaryIDs.map(signedSimpleHash)).toEqual([32_564_309, 56_421_934]);
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
