import { BreakAllianceExecution } from "../src/core/execution/alliance/BreakAllianceExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { Game, Player, PlayerInfo, PlayerType } from "../src/core/game/Game";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

// Phase 0 regression tests (economy+negotiation project): alliance break and
// expiry side effects.
//
// Base facts under test (verified against current source):
// - breaking an alliance creates NO embargo in either direction
//   (BreakAllianceExecution has no embargo call; GameImpl.breakAlliance only
//   marks the traitor and removes the alliance)
// - the breaker is marked traitor for traitorDuration (30s = 300 ticks)
//   UNLESS the victim is already a traitor or disconnected
// - alliance expiry is silent: no traitor, no embargo
//   (PlayerExecution expiry sweep -> AllianceImpl.expire -> GameImpl.expireAlliance)
//
// Already pinned elsewhere (cite, don't duplicate):
// - traitor with active victim / no traitor with DISCONNECTED victim:
//   tests/core/game/GameImpl.test.ts ("Do/Don't become traitor ...")

let game: Game;
let playerA: Player;
let playerB: Player;

function ally(a: Player, b: Player): void {
  const request = a.createAllianceRequest(b);
  expect(request).not.toBeNull();
  request!.accept();
  expect(a.isAlliedWith(b)).toBe(true);
}

describe("Alliance break", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      new PlayerInfo("playerA", PlayerType.Human, null, "playerA_id"),
      new PlayerInfo("playerB", PlayerType.Human, null, "playerB_id"),
    ]);
    playerA = game.player("playerA_id");
    playerB = game.player("playerB_id");
    playerA.conquer(game.ref(10, 50));
    playerB.conquer(game.ref(30, 50));
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("breaking an alliance marks the breaker traitor but creates no embargo", () => {
    ally(playerA, playerB);

    game.addExecution(new BreakAllianceExecution(playerA, playerB.id()));
    game.executeNextTick();
    game.executeNextTick();

    expect(playerA.isAlliedWith(playerB)).toBe(false);
    expect(playerA.isTraitor()).toBe(true);
    expect(playerB.isTraitor()).toBe(false);

    // No embargo in either direction: trade is untouched by betrayal.
    expect(playerA.getEmbargoes()).toHaveLength(0);
    expect(playerB.getEmbargoes()).toHaveLength(0);
    expect(playerA.canTrade(playerB)).toBe(true);
    expect(playerB.canTrade(playerA)).toBe(true);
  });

  test("traitor status lasts traitorDuration (300 ticks) and then clears", () => {
    // Pin the constant this test relies on.
    expect(game.config().traitorDuration()).toBe(300);

    ally(playerA, playerB);
    game.addExecution(new BreakAllianceExecution(playerA, playerB.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(playerA.isTraitor()).toBe(true);

    // isTraitor is derived from the marked tick; advance past the duration.
    for (let i = 0; i < 301; i++) {
      game.executeNextTick();
    }
    expect(playerA.isTraitor()).toBe(false);
  });

  test("breaking with an already-traitor victim is free (no traitor mark)", () => {
    ally(playerA, playerB);

    // The victim is already a traitor; betraying a traitor is free.
    playerB.markTraitor();
    expect(playerB.isTraitor()).toBe(true);

    game.addExecution(new BreakAllianceExecution(playerA, playerB.id()));
    game.executeNextTick();
    game.executeNextTick();

    expect(playerA.isAlliedWith(playerB)).toBe(false);
    expect(playerA.isTraitor()).toBe(false);
    expect(playerB.isTraitor()).toBe(true);
  });
});

describe("Alliance expiry", () => {
  const gameID: GameID = "game_id";

  beforeEach(async () => {
    game = await setup("plains", {});
    const infoA = new PlayerInfo("playerA", PlayerType.Human, null, "pa_id");
    const infoB = new PlayerInfo("playerB", PlayerType.Human, null, "pb_id");
    playerA = game.addPlayer(infoA);
    playerB = game.addPlayer(infoB);
    // Spawn through the real path so each player gets a PlayerExecution
    // (which owns the alliance expiry sweep).
    game.addExecution(
      new SpawnExecution(gameID, infoA, game.ref(20, 20)),
      new SpawnExecution(gameID, infoB, game.ref(80, 80)),
    );
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("alliance expiry after allianceDuration (3000 ticks) is silent: no traitor, no embargo", () => {
    // Pin the constant this test relies on.
    expect(game.config().allianceDuration()).toBe(3000);

    ally(playerA, playerB);
    const alliance = playerA.allianceWith(playerB);
    expect(alliance).not.toBeNull();
    const expiresAt = alliance!.expiresAt();

    // Still allied right before expiry.
    while (game.ticks() < expiresAt) {
      game.executeNextTick();
    }
    expect(playerA.isAlliedWith(playerB)).toBe(true);

    // The PlayerExecution sweep expires it at/after expiresAt.
    while (game.ticks() <= expiresAt + 2) {
      game.executeNextTick();
    }
    expect(playerA.isAlliedWith(playerB)).toBe(false);
    expect(playerB.isAlliedWith(playerA)).toBe(false);

    // Silent: nobody is a traitor and no embargo was created.
    expect(playerA.isTraitor()).toBe(false);
    expect(playerB.isTraitor()).toBe(false);
    expect(playerA.getEmbargoes()).toHaveLength(0);
    expect(playerB.getEmbargoes()).toHaveLength(0);
    expect(playerA.canTrade(playerB)).toBe(true);
    expect(playerB.canTrade(playerA)).toBe(true);
  });
});
