import { describe, expect, it } from "vitest";

import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import {
  ClientIntentMessageSchema,
  type GameConfig,
} from "../../src/core/Schemas";
import {
  CreateGameInputSchema,
  GameInputSchema,
} from "../../src/core/WorkerSchemas";
import { MasterMessageSchema } from "../../src/server/IPCBridgeSchema";

const ordinaryConfig: GameConfig = {
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

describe("external game configuration donation audience boundary", () => {
  it("rejects true at HTTP Worker create and partial-update schemas", () => {
    expect(
      CreateGameInputSchema.safeParse({
        ...ordinaryConfig,
        donateToNonFriendly: true,
      }).success,
    ).toBe(false);
    expect(
      GameInputSchema.safeParse({ donateToNonFriendly: true }).success,
    ).toBe(false);
  });

  it("rejects true on client update intents and master-to-worker creation", () => {
    expect(
      ClientIntentMessageSchema.safeParse({
        type: "intent",
        intent: {
          type: "update_game_config",
          config: { donateToNonFriendly: true },
        },
      }).success,
    ).toBe(false);
    expect(
      MasterMessageSchema.safeParse({
        type: "createGame",
        gameID: "DONATE01",
        gameConfig: {
          ...ordinaryConfig,
          gameType: GameType.Public,
          donateToNonFriendly: true,
        },
        publicGameType: "ffa",
      }).success,
    ).toBe(false);
  });

  it("keeps absent and explicit false ordinary configurations valid", () => {
    expect(CreateGameInputSchema.parse(ordinaryConfig)).toEqual(ordinaryConfig);
    expect(
      CreateGameInputSchema.parse({
        ...ordinaryConfig,
        donateToNonFriendly: false,
      }),
    ).toEqual({ ...ordinaryConfig, donateToNonFriendly: false });
    expect(GameInputSchema.parse({})).toEqual({});
    expect(GameInputSchema.parse({ donateToNonFriendly: false })).toEqual({
      donateToNonFriendly: false,
    });
    expect(
      ClientIntentMessageSchema.safeParse({
        type: "intent",
        intent: {
          type: "update_game_config",
          config: { donateToNonFriendly: false },
        },
      }).success,
    ).toBe(true);
  });
});
