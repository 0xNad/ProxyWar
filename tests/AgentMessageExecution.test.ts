import { AgentMessageExecution } from "../src/core/execution/AgentMessageExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { playerInfo, setup } from "./util/Setup";

let game: Game;
let player1: Player;
let player2: Player;

async function freshGame(): Promise<Game> {
  const created = await setup(
    "ocean_and_land",
    { infiniteGold: true, instantBuild: true, infiniteTroops: true },
    [
      playerInfo("player1", PlayerType.Human),
      playerInfo("player2", PlayerType.Human),
      playerInfo("player3", PlayerType.Nation),
    ],
  );
  while (created.inSpawnPhase()) {
    created.executeNextTick();
  }
  return created;
}

describe("AgentMessageExecution (free-text negotiation)", () => {
  beforeEach(async () => {
    game = await freshGame();
    player1 = game.player("player1");
    player2 = game.player("player2");
  });

  test("emits one AgentMessageEvent carrying the text verbatim", () => {
    const text = "Truce on the north border until turn 200?";
    game.addExecution(new AgentMessageExecution(player1, player2.id(), text));
    // executeNextTick() inits newly added executions AFTER ticking existing
    // ones, so a fresh execution first runs on the following tick.
    game.executeNextTick();
    const updates = game.executeNextTick();

    const events = updates[GameUpdateType.AgentMessageEvent] ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      senderID: player1.smallID(),
      recipientID: player2.smallID(),
      text,
    });
  });

  test("does not re-trim or rewrite the text it was given", () => {
    // Normalization is the validator's job and happens before this point. If
    // this execution also normalized, the rendered transcript could disagree
    // with the decision record the evidence is built on.
    const text = "a  b";
    game.addExecution(new AgentMessageExecution(player1, player2.id(), text));
    game.executeNextTick();
    const updates = game.executeNextTick();
    expect(updates[GameUpdateType.AgentMessageEvent]?.[0]).toMatchObject({
      text,
    });
  });

  test("becomes inactive after delivering exactly once", () => {
    const execution = new AgentMessageExecution(player1, player2.id(), "hi");
    game.addExecution(execution);
    game.executeNextTick();
    game.executeNextTick();
    expect(execution.isActive()).toBe(false);

    const later = game.executeNextTick();
    expect(later[GameUpdateType.AgentMessageEvent] ?? []).toHaveLength(0);
  });

  test("drops silently when the recipient does not exist", () => {
    const execution = new AgentMessageExecution(player1, "NOPE1234", "hi");
    game.addExecution(execution);
    game.executeNextTick();
    const updates = game.executeNextTick();
    expect(updates[GameUpdateType.AgentMessageEvent] ?? []).toHaveLength(0);
    expect(execution.isActive()).toBe(false);
  });

  test("never runs during the spawn phase", () => {
    const execution = new AgentMessageExecution(player1, player2.id(), "hi");
    expect(execution.activeDuringSpawnPhase()).toBe(false);
  });

  /**
   * The game publishes a state hash as a Hash update every 10 ticks. Collecting
   * those is the only public way to compare simulation state, and it is the
   * signal the desync detector itself uses.
   */
  const hashesOver = (target: Game, ticks: number): number[] => {
    const hashes: number[] = [];
    for (let i = 0; i < ticks; i++) {
      const updates = target.executeNextTick();
      for (const update of updates[GameUpdateType.Hash] ?? []) {
        hashes.push(update.hash);
      }
    }
    return hashes;
  };

  test("is simulation-inert: wording cannot change the game hash", async () => {
    // The determinism guarantee the core rule rests on. Two identical games are
    // advanced identically except for the CONTENT of one message; if any
    // simulation state read the text, these hashes would diverge.
    const gameA = await freshGame();
    const gameB = await freshGame();

    const send = (target: Game, text: string) => {
      target.addExecution(
        new AgentMessageExecution(
          target.player("player1"),
          target.player("player2").id(),
          text,
        ),
      );
    };
    send(gameA, "I will hold the north line, on my word.");
    send(gameB, "x");

    const hashesA = hashesOver(gameA, 40);
    const hashesB = hashesOver(gameB, 40);
    expect(hashesA.length).toBeGreaterThan(0);
    expect(hashesA).toEqual(hashesB);
  });

  test("a game with a message hashes the same as one with no message at all", async () => {
    const withMessage = await freshGame();
    const without = await freshGame();

    withMessage.addExecution(
      new AgentMessageExecution(
        withMessage.player("player1"),
        withMessage.player("player2").id(),
        "attack them, not me",
      ),
    );
    const hashesWith = hashesOver(withMessage, 40);
    const hashesWithout = hashesOver(without, 40);
    expect(hashesWith.length).toBeGreaterThan(0);
    expect(hashesWith).toEqual(hashesWithout);
  });
});
