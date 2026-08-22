import { describe, expect, it } from "vitest";

import { coworldSpawnPriorityMetadataFromConfig } from "./coworld-spawn-priority-metadata.ts";
import type { CoworldConfig } from "./no-docker-coworld-episode.ts";

function baseConfig(overrides: Partial<CoworldConfig> = {}): CoworldConfig {
  return {
    tokens: ["t1", "t2"],
    players: [{ name: "mutable-a" }, { name: "mutable-b" }],
    max_decision_steps: 10,
    turns_per_decision_step: 1,
    max_decision_ms: 1000,
    map: "world",
    map_size: "compact",
    difficulty: "medium",
    ...overrides,
  };
}

describe("Coworld rated spawn-priority metadata", () => {
  it("keeps standalone fixtures backward compatible and explicitly unrated", () => {
    expect(coworldSpawnPriorityMetadataFromConfig(baseConfig())).toEqual({
      ratedPlay: false,
      episodeIndex: 0,
      playerIDs: null,
    });
  });

  it("accepts complete rated metadata without changing the immutable ids", () => {
    expect(
      coworldSpawnPriorityMetadataFromConfig(
        baseConfig({
          rated_play: true,
          episodeIndex: 19,
          player_ids: ["ply_a", "ply_b"],
        }),
      ),
    ).toEqual({
      ratedPlay: true,
      episodeIndex: 19,
      playerIDs: ["ply_a", "ply_b"],
    });
  });

  it("fails rated play closed when the scheduler omits either required field", () => {
    expect(() =>
      coworldSpawnPriorityMetadataFromConfig(
        baseConfig({ rated_play: true, player_ids: ["ply_a", "ply_b"] }),
      ),
    ).toThrow(/requires per-episode episodeIndex/);
    expect(() =>
      coworldSpawnPriorityMetadataFromConfig(
        baseConfig({ rated_play: true, episodeIndex: 3 }),
      ),
    ).toThrow(/requires immutable player_ids/);
  });

  it.each([
    { player_ids: ["ply_a"] },
    { player_ids: ["ply_a", "ply_a"] },
    { player_ids: ["ply_a", ""] },
  ] satisfies Array<Partial<CoworldConfig>>)(
    "rejects malformed or non-unique player ids: %j",
    (metadata) => {
      expect(() =>
        coworldSpawnPriorityMetadataFromConfig(
          baseConfig({ rated_play: true, episodeIndex: 0, ...metadata }),
        ),
      ).toThrow();
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid episodeIndex %s even for an unrated fixture",
    (episodeIndex) => {
      expect(() =>
        coworldSpawnPriorityMetadataFromConfig(baseConfig({ episodeIndex })),
      ).toThrow(/non-negative safe integer/);
    },
  );
});
