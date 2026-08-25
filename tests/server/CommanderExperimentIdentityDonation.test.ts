import { describe, expect, it } from "vitest";

import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import type { GameConfig } from "../../src/core/Schemas";
import {
  normalizeCommanderGameConfig,
  parseCommanderCanonicalGameConfig,
} from "../../src/server/agents/CommanderExperimentIdentity";

const baseConfig: GameConfig = {
  gameMap: GameMapType.Asia,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Private,
  difficulty: Difficulty.Medium,
  nations: "disabled",
  donateGold: true,
  donateTroops: true,
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  disabledUnits: [],
};

describe("Commander donation-audience experiment identity", () => {
  it("binds the enabled audience into new canonical evidence and readback", () => {
    const normalized = normalizeCommanderGameConfig({
      ...baseConfig,
      donateToNonFriendly: true,
    });
    expect(normalized.donateToNonFriendly).toBe(true);
    expect(parseCommanderCanonicalGameConfig(normalized)).toEqual(normalized);
    expect(JSON.stringify(normalized)).toContain('"donateToNonFriendly":true');
  });

  it("keeps absent source and legacy artifacts byte-stably default false", () => {
    const normalized = normalizeCommanderGameConfig(baseConfig);
    expect(normalized.donateToNonFriendly).toBeUndefined();

    expect(parseCommanderCanonicalGameConfig(normalized)).toEqual(normalized);
    expect(JSON.stringify(normalized)).not.toContain("donateToNonFriendly");
  });

  it("rejects malformed new evidence instead of fabricating a default", () => {
    const normalized = normalizeCommanderGameConfig(baseConfig);
    const malformed = {
      ...normalized,
      donateToNonFriendly: "true",
    };
    expect(() => parseCommanderCanonicalGameConfig(malformed)).toThrow(
      "Commander selected game configuration is malformed",
    );
    expect(() =>
      parseCommanderCanonicalGameConfig({
        ...normalized,
        donateToNonFriendly: false,
      }),
    ).toThrow("Commander selected game configuration is malformed");
  });
});
