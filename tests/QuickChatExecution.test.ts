import { QuickChatExecution } from "../src/core/execution/QuickChatExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { playerInfo, setup } from "./util/Setup";

let game: Game;
let player1: Player;
let player2: Player;
let player3: Player;

describe("QuickChatExecution", () => {
  beforeEach(async () => {
    game = await setup(
      "plains",
      {
        infiniteGold: true,
        infiniteTroops: true,
      },
      [
        playerInfo("player1", PlayerType.Human),
        playerInfo("player2", PlayerType.Human),
        playerInfo("player3", PlayerType.Human),
      ],
    );

    player1 = game.player("player1");
    player2 = game.player("player2");
    player3 = game.player("player3");

    player1.conquer(game.ref(0, 0));
    player2.conquer(game.ref(0, 1));
    player3.conquer(game.ref(0, 2));

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("quick chat is broadcast as a public match message", () => {
    game.addExecution(
      new QuickChatExecution(player1, player2.id(), "attack.focus", player3.id()),
    );

    game.executeNextTick();
    const updates = game.executeNextTick();
    const chats = updates[GameUpdateType.DisplayChatEvent] ?? [];

    expect(chats).toHaveLength(3);
    expect(chats.map((chat) => chat.playerID).sort()).toEqual(
      game
        .players()
        .map((player) => player.smallID())
        .sort(),
    );
    expect(chats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "attack",
          key: "focus",
          target: player3.id(),
          isFrom: true,
          recipient: player1.id(),
        }),
      ]),
    );
  });
});
