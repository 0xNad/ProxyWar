import { describe, expect, it } from "vitest";

import { episodeIndexFromConfig } from "./coworld-episode-index.ts";
import type { CoworldConfig } from "./no-docker-coworld-episode.ts";

function baseConfig(overrides: Partial<CoworldConfig> = {}): CoworldConfig {
  return {
    tokens: ["t1", "t2"],
    players: [{ name: "a" }, { name: "b" }],
    max_decision_steps: 10,
    turns_per_decision_step: 1,
    max_decision_ms: 1000,
    map: "world",
    map_size: "compact",
    difficulty: "medium",
    ...overrides,
  };
}

describe("episodeIndexFromConfig (real runtime wiring: runProxyWarEpisode -> AgentLeagueMatchOptions.episodeIndex)", () => {
  it("defaults to occurrence 0 when the config omits episodeIndex", () => {
    expect(episodeIndexFromConfig(baseConfig())).toBe(0);
  });

  it("passes the commissioner's same-variant episode ordinal through unmodified", () => {
    expect(episodeIndexFromConfig(baseConfig({ episodeIndex: 0 }))).toBe(0);
    expect(episodeIndexFromConfig(baseConfig({ episodeIndex: 1 }))).toBe(1);
    expect(episodeIndexFromConfig(baseConfig({ episodeIndex: 7 }))).toBe(7);
  });

  it("fails closed when a rated episode omits the ordinal", () => {
    expect(() =>
      episodeIndexFromConfig(
        baseConfig({ rated_play: true, player_ids: ["ply-a", "ply-b"] }),
      ),
    ).toThrow(/requires per-episode episodeIndex/);
  });
});
