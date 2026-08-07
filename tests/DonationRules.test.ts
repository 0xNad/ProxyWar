import { DonateGoldExecution } from "../src/core/execution/DonateGoldExecution";
import { DonateTroopsExecution } from "../src/core/execution/DonateTroopExecution";
import {
  Game,
  GameMode,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

// Phase 0 regression tests (economy+negotiation project): donation legality
// edges in PlayerImpl.canDonateGold/canDonateTroops and the donate
// executions.
//
// Base facts under test (verified against current source):
// - donations require isFriendly (ally OR team) and are refused when the
//   recipient is disconnected (isFriendly returns false for disconnected
//   players)
// - per-recipient cooldown donateCooldown() = 100 ticks
// - troop donation defaults to 1/3 of the sender's troops
//   (defaultDonationAmount) capped by the recipient's headroom
//   (maxTroops(recipient) - recipient.troops())
// - gold donation with an explicit amount transfers exactly that amount
// - null-gold donation defaults to 1/3 of the sender's gold (see below)
//
// Already pinned elsewhere (cite, don't duplicate):
// - ally can donate / non-ally cannot: tests/Donate.test.ts,
//   tests/AllianceDonation.test.ts
// - the null-gold default's other edges (explicit amount still exact, explicit
//   0 still refused, clamp to the sender's balance):
//   tests/DonateGoldDefaultAmount.test.ts

let game: Game;
let donor: Player;
let recipient: Player;

function ally(a: Player, b: Player): void {
  const request = a.createAllianceRequest(b);
  expect(request).not.toBeNull();
  request!.accept();
  expect(a.isAlliedWith(b)).toBe(true);
}

async function setupPair(): Promise<void> {
  game = await setup(
    "plains",
    {
      donateGold: true,
      donateTroops: true,
    },
    [
      new PlayerInfo("donor", PlayerType.Human, null, "donor_id"),
      new PlayerInfo("recipient", PlayerType.Human, null, "recipient_id"),
    ],
  );
  donor = game.player("donor_id");
  recipient = game.player("recipient_id");
  // One tile each: alive, and no PlayerExecution income drift so gold and
  // troop assertions stay exact.
  donor.conquer(game.ref(10, 50));
  recipient.conquer(game.ref(30, 50));
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
}

describe("Donation rules", () => {
  beforeEach(async () => {
    await setupPair();
  });

  test("teammates can donate (isFriendly covers team, not just ally)", async () => {
    const teamGame = await setup("plains", {
      gameMode: GameMode.Team,
      playerTeams: 2,
      donateGold: true,
      donateTroops: true,
    });
    // Team assignment hashes the player id (GameImpl.maybeAssignTeam);
    // "mateA_id" and "mateC_id" deterministically land on the same team.
    const infoA = new PlayerInfo("mateA", PlayerType.Human, null, "mateA_id");
    const infoB = new PlayerInfo("mateB", PlayerType.Human, null, "mateC_id");
    const mateA = teamGame.addPlayer(infoA);
    const mateB = teamGame.addPlayer(infoB);
    mateA.conquer(teamGame.ref(10, 50));
    mateB.conquer(teamGame.ref(30, 50));
    while (teamGame.inSpawnPhase()) {
      teamGame.executeNextTick();
    }

    expect(mateA.isOnSameTeam(mateB)).toBe(true);
    expect(mateA.isAlliedWith(mateB)).toBe(false);
    expect(mateA.canDonateGold(mateB)).toBe(true);
    expect(mateA.canDonateTroops(mateB)).toBe(true);

    mateA.addGold(10_000n);
    const donorBefore = mateA.gold();
    const recipientBefore = mateB.gold();
    teamGame.addExecution(new DonateGoldExecution(mateA, mateB.id(), 1_234));
    teamGame.executeNextTick();
    teamGame.executeNextTick();

    expect(mateA.gold()).toBe(donorBefore - 1_234n);
    expect(mateB.gold()).toBe(recipientBefore + 1_234n);
  });

  test("donations to a disconnected recipient are refused", () => {
    ally(donor, recipient);
    donor.addGold(10_000n);
    donor.addTroops(10_000);

    recipient.markDisconnected(true);
    expect(donor.canDonateGold(recipient)).toBe(false);
    expect(donor.canDonateTroops(recipient)).toBe(false);

    const donorGold = donor.gold();
    const recipientGold = recipient.gold();
    const donorTroops = donor.troops();
    const recipientTroops = recipient.troops();
    game.addExecution(
      new DonateGoldExecution(donor, recipient.id(), 5_000),
      new DonateTroopsExecution(donor, recipient.id(), 5_000),
    );
    game.executeNextTick();
    game.executeNextTick();

    expect(donor.gold()).toBe(donorGold);
    expect(recipient.gold()).toBe(recipientGold);
    expect(donor.troops()).toBe(donorTroops);
    expect(recipient.troops()).toBe(recipientTroops);

    // Reconnecting restores eligibility.
    recipient.markDisconnected(false);
    expect(donor.canDonateGold(recipient)).toBe(true);
  });

  test("per-recipient donation cooldown is 100 ticks", () => {
    expect(game.config().donateCooldown()).toBe(100);
    ally(donor, recipient);
    donor.addGold(100_000n);

    const recipientBefore = recipient.gold();

    // First donation goes through.
    game.addExecution(new DonateGoldExecution(donor, recipient.id(), 1_000));
    game.executeNextTick();
    game.executeNextTick();
    expect(recipient.gold()).toBe(recipientBefore + 1_000n);
    expect(donor.canDonateGold(recipient)).toBe(false);

    // A second donation inside the cooldown window is refused.
    game.addExecution(new DonateGoldExecution(donor, recipient.id(), 1_000));
    game.executeNextTick();
    game.executeNextTick();
    expect(recipient.gold()).toBe(recipientBefore + 1_000n);

    // After the cooldown elapses, donations work again.
    for (let i = 0; i < 100; i++) {
      game.executeNextTick();
    }
    expect(donor.canDonateGold(recipient)).toBe(true);
    game.addExecution(new DonateGoldExecution(donor, recipient.id(), 1_000));
    game.executeNextTick();
    game.executeNextTick();
    expect(recipient.gold()).toBe(recipientBefore + 2_000n);
  });

  test("troop donation defaults to 1/3 of the sender's troops", () => {
    ally(donor, recipient);
    donor.setTroops(30_000);
    recipient.setTroops(0);

    const expected = game.config().defaultDonationAmount(donor);
    expect(expected).toBe(10_000);
    // Ample headroom: the default is not capped here.
    expect(
      game.config().maxTroops(recipient) - recipient.troops(),
    ).toBeGreaterThan(expected);

    game.addExecution(new DonateTroopsExecution(donor, recipient.id(), null));
    game.executeNextTick();
    game.executeNextTick();

    expect(recipient.troops()).toBe(expected);
    expect(donor.troops()).toBe(30_000 - expected);
  });

  test("troop donation is capped by the recipient's remaining troop headroom", () => {
    ally(donor, recipient);
    donor.setTroops(30_000);
    const max = game.config().maxTroops(recipient);
    recipient.setTroops(max - 500);

    game.addExecution(new DonateTroopsExecution(donor, recipient.id(), null));
    game.executeNextTick();
    game.executeNextTick();

    // Only the 500 headroom is transferred, not the 10k default.
    expect(recipient.troops()).toBe(max);
    expect(donor.troops()).toBe(30_000 - 500);
  });

  test("gold donation with an explicit amount transfers exactly that amount", () => {
    ally(donor, recipient);
    donor.addGold(100_000n);
    const donorBefore = donor.gold();
    const recipientBefore = recipient.gold();

    game.addExecution(new DonateGoldExecution(donor, recipient.id(), 7_777));
    game.executeNextTick();
    game.executeNextTick();

    expect(donor.gold()).toBe(donorBefore - 7_777n);
    expect(recipient.gold()).toBe(recipientBefore + 7_777n);
  });

  test("null-gold donation defaults to 1/3 of the sender's gold", () => {
    // This case used to pin a dead-default bug: the DonateGoldExecution
    // constructor ran `this.gold = toInt(goldNum ?? 0)`, so a null amount
    // became 0n, the `this.gold ??= sender.gold() / 3n` fallback in init()
    // was unreachable, donateGold(recipient, 0n) returned false, and the
    // donation silently did nothing. Fixed by "Default null gold donations to
    // a third of the sender's gold" (DonateGoldExecution.ts:21, 33 - null is
    // preserved through construction so the init() fallback fires), which
    // makes gold mirror DonateTroopsExecution's 1/3 default. The default is
    // captured at init() from the sender's balance at that moment.
    ally(donor, recipient);
    donor.addGold(90_000n);
    const donorBefore = donor.gold();
    const recipientBefore = recipient.gold();
    const expected = donorBefore / 3n;
    expect(expected).toBeGreaterThan(0n);
    expect(donor.canDonateGold(recipient)).toBe(true);

    game.addExecution(new DonateGoldExecution(donor, recipient.id(), null));
    game.executeNextTick();
    game.executeNextTick();

    expect(donor.gold()).toBe(donorBefore - expected);
    expect(recipient.gold()).toBe(recipientBefore + expected);
  });
});
