import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../../src/core/game/Game";
import type { GameStartInfo, Turn } from "../../../src/core/Schemas";
import {
  DeterministicReplayPremiereCheckpointProjector,
  projectEligibleReplayPremiereSeatIds,
  projectReplayPremiereCheckpointOptionsWithGameRunner,
  ReplayPremiereFilesystemMapLoader,
} from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { verifiedPublicationFixture } from "./ReplayPremiereFixtures";

const SEATS = ["SEAT0001", "SEAT0002", "SEAT0003"] as const;

describe("ReplayPremiere checkpoint eligibility projection", () => {
  test("uses the real GameRunner and tracked filesystem map to project spawned seats after each checkpoint turn", async () => {
    const projection =
      await projectReplayPremiereCheckpointOptionsWithGameRunner({
        gameStartInfo: randomSpawnGameStart(),
        turns: turns(),
        checkpoints: [
          { id: "cp_00000001", sequence: 1 },
          { id: "cp_00000002", sequence: 2 },
        ],
        provenanceSeatIds: SEATS,
        mapLoader: new ReplayPremiereFilesystemMapLoader(
          path.resolve("resources", "maps"),
        ),
        signal: new AbortController().signal,
      });

    expect(projection).toEqual([
      { id: "cp_00000001", sequence: 1, optionSeatIds: SEATS },
      { id: "cp_00000002", sequence: 2, optionSeatIds: SEATS },
    ]);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection[0].optionSeatIds)).toBe(true);
  });

  test("excludes an eliminated provenance seat while preserving order and ignoring non-provenance players", () => {
    const players = new Map([
      ["SEAT0001", player(true, true)],
      ["SEAT0002", player(true, false)],
      ["SEAT0003", player(true, true)],
      ["BOT00001", player(true, true)],
    ]);

    expect(
      projectEligibleReplayPremiereSeatIds({
        provenanceSeatIds: SEATS,
        playerByClientID: (seatId) => players.get(seatId) ?? null,
      }),
    ).toEqual(["SEAT0001", "SEAT0003"]);
  });

  test("fails closed on an archived hash mismatch or an unspawned provenance seat", async () => {
    await expect(
      projectReplayPremiereCheckpointOptionsWithGameRunner({
        gameStartInfo: randomSpawnGameStart(),
        turns: turns(123_456),
        checkpoints: [
          { id: "cp_00000001", sequence: 1 },
          { id: "cp_00000002", sequence: 2 },
        ],
        provenanceSeatIds: SEATS,
        mapLoader: new ReplayPremiereFilesystemMapLoader(
          path.resolve("resources", "maps"),
        ),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      operatorCode: "checkpoint_projection_archived_hash_mismatch",
    });

    expect(() =>
      projectEligibleReplayPremiereSeatIds({
        provenanceSeatIds: SEATS,
        playerByClientID: (seatId) =>
          seatId === "SEAT0002" ? player(false, false) : player(true, true),
      }),
    ).toThrowError(
      expect.objectContaining({
        operatorCode: "checkpoint_projection_player_unspawned",
      }),
    );
  });

  test("fails closed instead of presenting a one-option checkpoint", () => {
    expect(() =>
      projectEligibleReplayPremiereSeatIds({
        provenanceSeatIds: SEATS,
        playerByClientID: (seatId) => player(true, seatId === "SEAT0001"),
      }),
    ).toThrowError(
      expect.objectContaining({
        operatorCode: "checkpoint_projection_fewer_than_two_options",
      }),
    );
  });

  test("honors an already-aborted fence and an abort during gate-bound turn extraction", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "premiere-checkpoint-abort-"),
    );
    try {
      const { gate, drafts } = await verifiedPublicationFixture(root);
      const projector = new DeterministicReplayPremiereCheckpointProjector(
        path.resolve("resources", "maps"),
      );

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        projector.project({
          gate,
          drafts,
          signal: alreadyAborted.signal,
        }),
      ).rejects.toMatchObject({
        operatorCode: "checkpoint_projection_aborted",
      });

      const abortedDuringExtraction = new AbortController();
      const projection = projector.project({
        gate,
        drafts,
        signal: abortedDuringExtraction.signal,
      });
      setImmediate(() => abortedDuringExtraction.abort());
      await expect(projection).rejects.toMatchObject({
        operatorCode: "checkpoint_projection_aborted",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function randomSpawnGameStart(): GameStartInfo {
  return {
    gameID: "PROJ0001",
    lobbyCreatedAt: 1,
    config: {
      gameMap: GameMapType.Asia,
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      difficulty: Difficulty.Medium,
      nations: "disabled",
      donateGold: false,
      donateTroops: false,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: true,
    },
    players: SEATS.map((clientID, index) => ({
      clientID,
      username: `Seat ${index + 1}`,
      clanTag: null,
    })),
  };
}

function turns(hash?: number): Turn[] {
  return [
    {
      turnNumber: 0,
      intents: [],
      ...(hash === undefined ? {} : { hash }),
    },
    { turnNumber: 1, intents: [] },
    { turnNumber: 2, intents: [] },
  ];
}

function player(hasSpawned: boolean, isAlive: boolean) {
  return {
    hasSpawned: () => hasSpawned,
    isAlive: () => isAlive,
  };
}
