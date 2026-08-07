import { DonateGoldExecution } from "../src/core/execution/DonateGoldExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import { playerInfo, setup } from "./util/Setup";

// Regression suite for the gold-donation amount path in DonateGoldExecution,
// added with the fix that made a null amount default to a third of the
// sender's gold (the constructor used to coerce null to 0n, leaving the
// `this.gold ??= this.sender.gold() / 3n` fallback in init() unreachable).
// Pins all four amount cases: the null default, an explicit amount, explicit
// 0 (still refused by PlayerImpl.donateGold), and the clamp in
// PlayerImpl.removeGold that caps any transfer at the sender's balance.
//
// Donation legality edges (friendly-only, disconnected recipient, cooldown)
// live in tests/DonationRules.test.ts - cite, don't duplicate.

let game: Game;
let donor: Player;
let recipient: Player;

describe("DonateGoldExecution amount handling", () => {
  beforeEach(async () => {
    game = await setup(
      "plains",
      {
        infiniteGold: false,
        donateGold: true,
      },
      [
        playerInfo("donor", PlayerType.Human),
        playerInfo("recipient", PlayerType.Human),
      ],
    );

    donor = game.player("donor");
    donor.conquer(game.ref(0, 0));
    donor.addGold(10_000n);

    recipient = game.player("recipient");
    recipient.conquer(game.ref(0, 1));

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    const allianceRequest = donor.createAllianceRequest(recipient);
    expect(allianceRequest).not.toBeNull();
    if (allianceRequest) {
      allianceRequest.accept();
    }
  });

  test("null amount donates a third of the sender's gold", () => {
    const donorBefore = donor.gold();
    const recipientBefore = recipient.gold();
    const expected = donorBefore / 3n;
    expect(expected).toBeGreaterThan(0n);

    game.addExecution(new DonateGoldExecution(donor, recipient.id(), null));
    // First tick initializes the execution (captures the default amount),
    // second tick performs the transfer.
    game.executeNextTick();
    game.executeNextTick();

    expect(recipient.gold()).toBe(recipientBefore + expected);
    expect(donor.gold()).toBe(donorBefore - expected);
  });

  test("explicit amount donates exactly that amount", () => {
    const donorBefore = donor.gold();
    const recipientBefore = recipient.gold();

    game.addExecution(new DonateGoldExecution(donor, recipient.id(), 500));
    game.executeNextTick();
    game.executeNextTick();

    expect(recipient.gold()).toBe(recipientBefore + 500n);
    expect(donor.gold()).toBe(donorBefore - 500n);
  });

  test("zero amount does not donate", () => {
    expect(donor.canDonateGold(recipient)).toBe(true);

    const donorBefore = donor.gold();
    const recipientBefore = recipient.gold();

    game.addExecution(new DonateGoldExecution(donor, recipient.id(), 0));
    game.executeNextTick();
    game.executeNextTick();

    expect(recipient.gold()).toBe(recipientBefore);
    expect(donor.gold()).toBe(donorBefore);
  });

  test("an amount above the sender's balance is clamped to the balance", () => {
    // PlayerImpl.removeGold returns minInt(this._gold, toRemove), so an
    // over-large explicit amount empties the sender rather than transferring
    // gold that does not exist. The null default cannot reach this path
    // (gold/3 is always <= gold); it guards explicit amounts, which is what
    // agents and the UI send.
    const donorBefore = donor.gold();
    const recipientBefore = recipient.gold();
    const requested = donorBefore * 5n;
    expect(requested).toBeGreaterThan(donorBefore);

    game.addExecution(
      new DonateGoldExecution(donor, recipient.id(), Number(requested)),
    );
    game.executeNextTick();
    game.executeNextTick();

    expect(donor.gold()).toBe(0n);
    expect(recipient.gold()).toBe(recipientBefore + donorBefore);
  });
});
