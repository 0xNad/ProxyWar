import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildRatedPremiereSourceBundle,
  PremiereWageringSourceBundleError,
} from "../../../src/scripts/premiere-wagering/PremiereWageringSourceBundle";
import type { ActiveRosterSeat } from "../../../src/scripts/premiere-wagering/PremiereWageringRoster";

let root: string;

beforeEach(async () => {
  const realTemporaryRoot = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(path.join(realTemporaryRoot, "premiere-wagering-source-bundle-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Real production `game-record.json` (`league-coworld-2026-07-27T13-12-27-186Z-c77cd758`),
 * trimmed to 2 of its 44,600 turns — the shape (config, players, top-level
 * envelope) is verbatim so it passes `GameRecordSchema.strict()` for real,
 * not a hand-guessed shape that happens to satisfy this one test. */
const REAL_CLIENT_IDS = [
  "fz14Uigc",
  "biYaKe4S",
  "Ebebz5DS",
  "FkpiNoh9",
  "TxFjenZR",
  "QRiHUY1z",
  "fKgwqB4F",
  "Tb4XZAG9",
  "vaQR7CjB",
  "MWJrBFNS",
  "bTpTwJCZ",
  "vUBb4A25",
] as const;

function realGameRecord(overrides: { players?: unknown[] } = {}) {
  return {
    version: "v0.0.2",
    gitCommit: "DEV",
    subdomain: "local",
    domain: "ai-league-demo",
    info: {
      gameID: "COWRLD01",
      lobbyCreatedAt: 1785156338465,
      lobbyFillTime: 0,
      config: {
        gameMap: "World",
        difficulty: "Easy",
        donateGold: true,
        donateTroops: true,
        gameType: "Private",
        gameMode: "Free For All",
        gameMapSize: "Normal",
        nations: "disabled",
        bots: 0,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
        maxPlayers: 12,
        disabledUnits: [],
        startingGold: 200000,
      },
      players:
        overrides.players ??
        REAL_CLIENT_IDS.map((clientID, index) => ({
          clientID,
          username: `rgr_user_${index}`,
          clanTag: null,
          isLobbyCreator: false,
          persistentID: null,
        })),
      start: 1785156338465,
      end: 1785157947174,
      duration: 1608,
      num_turns: 44600,
    },
    turns: [
      {
        turnNumber: 0,
        intents: REAL_CLIENT_IDS.map((clientID) => ({
          type: "mark_disconnected",
          clientID,
          isDisconnected: false,
        })),
      },
      {
        turnNumber: 100,
        intents: REAL_CLIENT_IDS.map((clientID) => ({
          type: "spawn",
          tile: 1,
          clientID,
        })),
      },
    ],
  };
}

function rosterSeat(index: number, overrides: Partial<ActiveRosterSeat> = {}): ActiveRosterSeat {
  return {
    policyVersionId: `pv_${index}`,
    policyLabel: `agent-${index}:v${index + 1}`,
    playerId: `ply_${index}`,
    playerName: `player-${index}`,
    ...overrides,
  };
}

async function writeSealedBundle(
  dir: string,
  overrides: {
    seats?: ActiveRosterSeat[];
    winnerSlot?: number | null;
    sealed?: boolean;
    players?: unknown[];
  } = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const seats = overrides.seats ?? REAL_CLIENT_IDS.map((_, index) => rosterSeat(index));
  const rosterFile = {
    schemaVersion: 1,
    leagueId: "league_test",
    divisionId: "div_test",
    experienceRequestId: "xreq_test",
    episodeRequestId: "ereq_test",
    episodeId: "epi_test",
    coworldId: "cow_test",
    coworldName: "proxywar-ffa-12p",
    coworldVersion: "0.0.4",
    variantName: "twelve-player-ffa-world",
    replayUrl: "https://example.test/replay.json",
    requesterUserId: "usr_test",
    winnerSlot: overrides.winnerSlot ?? null,
    map: "World",
    mapSize: "Normal",
    turnCount: 44600,
    decisionCount: 100,
    degradedCount: 0,
    seats,
  };
  const sealedManifest = {
    schemaVersion: 1,
    sealedAt: "2026-07-27T00:00:00.000Z",
    bundleDirName: path.basename(dir),
    runId: "xpreq-test-run",
    map: "World",
    seatCount: seats.length,
    turnCount: 44600,
    gameType: "Private",
    randomSpawn: false,
    spawnPhaseTurns: 100,
    checkpointTurns: [15610, 28990],
    naiveCheckpointTurnsForComparison: [15610, 28990],
    fileHashes: { "game-record.json": "deadbeef" },
    provenance: { source: "xp_request", reason: "test" },
    alreadyPremiered: false,
    sealed: overrides.sealed ?? true,
  };
  await Promise.all([
    fs.writeFile(
      path.join(dir, "game-record.json"),
      JSON.stringify(realGameRecord({ players: overrides.players })),
    ),
    fs.writeFile(path.join(dir, "xp-request-roster.json"), JSON.stringify(rosterFile)),
    fs.writeFile(
      path.join(dir, "premiere-wagering.sealed.json"),
      JSON.stringify(sealedManifest),
    ),
  ]);
}

describe("buildRatedPremiereSourceBundle", () => {
  test("zips seats by slot index; policy identity from the roster, display name bound to the game record's own username", async () => {
    await writeSealedBundle(root);
    const result = await buildRatedPremiereSourceBundle({
      bundleDir: root,
      turnIntervalMs: 50,
    });
    expect(result.seats).toHaveLength(12);
    expect(result.seats[0]).toEqual({
      seatId: REAL_CLIENT_IDS[0],
      // Must equal the game record's own username exactly — publication's
      // `validateControlledSourceSeats` binds them and rejects a mismatch
      // (`controlled_source_seat_player_binding_mismatch`), verified against
      // a real admitted xp-request premiere.
      displayName: "rgr_user_0",
      policyIdentity: {
        namespace: "softmax_policy_version",
        policyVersionId: "pv_0",
        policyName: "agent-0:v1",
        serverAssignedVersion: "v1",
      },
    });
  });

  test("policyIdentity always comes from the roster sidecar, never the game record", async () => {
    await writeSealedBundle(root);
    const result = await buildRatedPremiereSourceBundle({
      bundleDir: root,
      turnIntervalMs: 50,
    });
    expect(
      result.seats.map((s) =>
        s.policyIdentity.namespace === "softmax_policy_version"
          ? s.policyIdentity.policyVersionId
          : null,
      ),
    ).toEqual(REAL_CLIENT_IDS.map((_, index) => `pv_${index}`));
  });

  test("marks exactly the winning slot's seat won and injects the winner into gameRecord.info", async () => {
    await writeSealedBundle(root, { winnerSlot: 3 });
    const result = await buildRatedPremiereSourceBundle({
      bundleDir: root,
      turnIntervalMs: 50,
    });
    const written = JSON.parse(await fs.readFile(result.outFile, "utf8"));
    expect(written.gameRecord.info.winner).toEqual(["player", REAL_CLIENT_IDS[3]]);
    const decoded = JSON.parse(
      Buffer.from(written.authoritativeResult.bytes, "base64").toString("utf8"),
    );
    expect(decoded.winner).toEqual(["player", REAL_CLIENT_IDS[3]]);
    expect(decoded.seats.filter((s: { won: boolean }) => s.won)).toHaveLength(1);
    expect(decoded.seats[3].seatId).toBe(REAL_CLIENT_IDS[3]);
    expect(decoded.seats[3].won).toBe(true);
  });

  test("refuses a bundle whose sealed manifest reports sealed: false", async () => {
    await writeSealedBundle(root, { sealed: false });
    await expect(
      buildRatedPremiereSourceBundle({ bundleDir: root, turnIntervalMs: 50 }),
    ).rejects.toThrow(PremiereWageringSourceBundleError);
  });

  test("refuses when the game record's player count doesn't match the persisted roster", async () => {
    await writeSealedBundle(root, {
      seats: REAL_CLIENT_IDS.slice(0, 11).map((_, index) => rosterSeat(index)),
    });
    await expect(
      buildRatedPremiereSourceBundle({ bundleDir: root, turnIntervalMs: 50 }),
    ).rejects.toThrow(PremiereWageringSourceBundleError);
  });

  test("writes a bundleKind admit.ts already accepts, with xp-request coworld ids (no fake round)", async () => {
    await writeSealedBundle(root);
    const result = await buildRatedPremiereSourceBundle({
      bundleDir: root,
      turnIntervalMs: 50,
    });
    const written = JSON.parse(await fs.readFile(result.outFile, "utf8"));
    expect(written.bundleKind).toBe("proxywar_rated_coworld_source");
    expect(written.coworld).toEqual({
      episodeId: "epi_test",
      leagueId: "league_test",
      divisionId: "div_test",
      roundId: "xreq_test",
    });
  });

  test("refuses to overwrite an existing source bundle file", async () => {
    await writeSealedBundle(root);
    await buildRatedPremiereSourceBundle({ bundleDir: root, turnIntervalMs: 50 });
    await expect(
      buildRatedPremiereSourceBundle({ bundleDir: root, turnIntervalMs: 50 }),
    ).rejects.toThrow(PremiereWageringSourceBundleError);
  });
});
