import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { EmbargoExecution } from "../../../src/core/execution/EmbargoExecution";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
} from "../../../src/core/game/Game";
import { GameID } from "../../../src/core/Schemas";
import { playerInfo, setup } from "../../util/Setup";

// Phase 0 regression tests (economy+negotiation project): the temporary
// embargo automatically created by AttackExecution.init on the DEFENDER's
// side against the attacker (AttackExecution: targetPlayer.addEmbargo(owner,
// true) before the attack is validated), its expiry sweep in
// PlayerExecution, the manual-embargo non-downgrade rule in
// PlayerImpl.addEmbargo, and the bot exclusion.

const gameID: GameID = "game_id";
let game: Game;
let attacker: Player;
let defender: Player;

function tempEmbargoOf(owner: Player, target: Player) {
  return owner.getEmbargoes().find((e) => e.target === target);
}

describe("Attack-created temporary embargo", () => {
  beforeEach(async () => {
    game = await setup("plains", {});
    const attackerInfo = new PlayerInfo(
      "attacker",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    const defenderInfo = new PlayerInfo(
      "defender",
      PlayerType.Human,
      null,
      "defender_id",
    );
    attacker = game.addPlayer(attackerInfo);
    defender = game.addPlayer(defenderInfo);

    // Spawn through the real path so each player gets a PlayerExecution
    // (which owns the temporary-embargo expiry sweep).
    game.addExecution(
      new SpawnExecution(gameID, attackerInfo, game.ref(20, 20)),
      new SpawnExecution(gameID, defenderInfo, game.ref(80, 80)),
    );
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
    attacker.setTroops(5_000);
    defender.setTroops(5_000);
  });

  test("attacking creates a temporary embargo on the defender's side only", () => {
    expect(defender.canTrade(attacker)).toBe(true);

    game.addExecution(new AttackExecution(100, attacker, defender.id()));
    game.executeNextTick();
    game.executeNextTick();

    // Defender-side embargo against the attacker, marked temporary.
    expect(defender.hasEmbargoAgainst(attacker)).toBe(true);
    const embargo = tempEmbargoOf(defender, attacker);
    expect(embargo).toBeDefined();
    expect(embargo!.isTemporary).toBe(true);

    // The attacker gets no embargo of its own, but trade is blocked both
    // ways because either side's embargo blocks both directions.
    expect(attacker.hasEmbargoAgainst(defender)).toBe(false);
    expect(defender.canTrade(attacker)).toBe(false);
    expect(attacker.canTrade(defender)).toBe(false);
  });

  test("the temporary embargo expires after temporaryEmbargoDuration (3000 ticks)", () => {
    // Pin the duration constant this test relies on.
    expect(game.config().temporaryEmbargoDuration()).toBe(3000);

    game.addExecution(new AttackExecution(100, attacker, defender.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(defender.hasEmbargoAgainst(attacker)).toBe(true);
    const createdAt = tempEmbargoOf(defender, attacker)!.createdAt;

    // Still embargoed right before expiry.
    while (game.ticks() <= createdAt + 2999) {
      game.executeNextTick();
    }
    expect(defender.hasEmbargoAgainst(attacker)).toBe(true);

    // The defender's PlayerExecution sweep lifts it once the duration has
    // fully elapsed (strictly greater than the duration).
    while (game.ticks() <= createdAt + 3002) {
      game.executeNextTick();
    }
    expect(defender.hasEmbargoAgainst(attacker)).toBe(false);
    expect(defender.canTrade(attacker)).toBe(true);
    expect(attacker.canTrade(defender)).toBe(true);
  });

  test("a pre-existing manual embargo is not downgraded by a later attack", () => {
    // Defender manually embargoes the attacker first (EmbargoExecution is
    // the manual path: isTemporary false).
    game.addExecution(new EmbargoExecution(defender, attacker.id(), "start"));
    game.executeNextTick();
    game.executeNextTick();
    const manual = tempEmbargoOf(defender, attacker);
    expect(manual).toBeDefined();
    expect(manual!.isTemporary).toBe(false);
    const manualCreatedAt = manual!.createdAt;

    // The attack tries to add a temporary embargo; the manual one wins.
    game.addExecution(new AttackExecution(100, attacker, defender.id()));
    game.executeNextTick();
    game.executeNextTick();
    const after = tempEmbargoOf(defender, attacker);
    expect(after).toBeDefined();
    expect(after!.isTemporary).toBe(false);
    expect(after!.createdAt).toBe(manualCreatedAt);

    // Manual embargoes never expire: still in force well past the temporary
    // duration.
    const horizon = game.ticks() + game.config().temporaryEmbargoDuration() + 5;
    while (game.ticks() <= horizon) {
      game.executeNextTick();
    }
    expect(defender.hasEmbargoAgainst(attacker)).toBe(true);
    expect(tempEmbargoOf(defender, attacker)!.isTemporary).toBe(false);
    expect(defender.canTrade(attacker)).toBe(false);
  });

  test("bots are excluded from attack embargoes in both roles", () => {
    const bot = game.addPlayer(playerInfo("bot", PlayerType.Bot));
    bot.conquer(game.ref(50, 50));
    bot.setTroops(1_000);

    // Human attacks bot: no embargo created on the bot's side.
    game.addExecution(new AttackExecution(100, attacker, bot.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(bot.hasEmbargoAgainst(attacker)).toBe(false);
    expect(bot.getEmbargoes()).toHaveLength(0);

    // Bot attacks human: no embargo created on the human's side.
    game.addExecution(new AttackExecution(100, bot, defender.id()));
    game.executeNextTick();
    game.executeNextTick();
    expect(defender.hasEmbargoAgainst(bot)).toBe(false);
    expect(defender.getEmbargoes()).toHaveLength(0);
  });
});
