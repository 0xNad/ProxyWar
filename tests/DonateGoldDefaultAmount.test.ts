import { DonateGoldExecution } from "../src/core/execution/DonateGoldExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import { playerInfo, setup } from "./util/Setup";

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
});
