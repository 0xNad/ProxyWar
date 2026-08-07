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
  it("defaults to episode 0 when the config omits episodeIndex (single/first episode, current production configs)", () => {
    expect(episodeIndexFromConfig(baseConfig())).toBe(0);
  });

  it("passes an explicit episodeIndex straight through, unmodified, for a future repeated-episode scheduler to set", () => {
    expect(episodeIndexFromConfig(baseConfig({ episodeIndex: 0 }))).toBe(0);
    expect(episodeIndexFromConfig(baseConfig({ episodeIndex: 1 }))).toBe(1);
    expect(episodeIndexFromConfig(baseConfig({ episodeIndex: 7 }))).toBe(7);
  });
});
