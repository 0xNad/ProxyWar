import { DonateGoldExecution } from "../src/core/execution/DonateGoldExecution";
import { DonateTroopsExecution } from "../src/core/execution/DonateTroopExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import { PlayerInfo, PlayerType } from "../src/core/game/Game";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

describe("Donate troops to an ally", () => {
  it("Troops should be successfully donated", async () => {
    const gameID: GameID = "game_id";
    const game = await setup("ocean_and_land", {
      infiniteTroops: false,
      donateTroops: true,
    });

    const donorInfo = new PlayerInfo(
      "donor",
      PlayerType.Human,
      null,
      "donor_id",
    );
    const recipientInfo = new PlayerInfo(
      "recipient",
      PlayerType.Human,
      null,
      "recipient_id",
    );

    game.addPlayer(donorInfo);
    game.addPlayer(recipientInfo);

    const donor = game.player(donorInfo.id);
    const recipient = game.player(recipientInfo.id);

    // Spawn both players
    const spawnA = game.ref(0, 10);
    const spawnB = game.ref(0, 15);

    game.addExecution(
      new SpawnExecution(gameID, donorInfo, spawnA),
      new SpawnExecution(gameID, recipientInfo, spawnB),
    );

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    // donor sends alliance request to recipient
    const allianceRequest = donor.createAllianceRequest(recipient);
    expect(allianceRequest).not.toBeNull();

    // recipient accepts the alliance request
    if (allianceRequest) {
      allianceRequest.accept();
    }

    // Ensure donor can actually donate the requested amount
    donor.addTroops(6000);
    const donorTroopsBefore = donor.troops();
    const recipientTroopsBefore = recipient.troops();
    const donationCursor = donor.donationCount();
    game.addExecution(new DonateTroopsExecution(donor, recipientInfo.id, 5000));

    for (let i = 0; i < 5; i++) {
      game.executeNextTick();
    }

    expect(donor.troops() < donorTroopsBefore).toBe(true);
    expect(recipient.troops() > recipientTroopsBefore).toBe(true);
    expect(donor.donationsSentSince(donationCursor)).toEqual([
      {
        recipientID: recipient.id(),
        tick: expect.any(Number),
        resource: "troops",
        amount: 5000,
      },
    ]);

    // A second transfer inside the shared donation cooldown is rejected and
    // cannot create a misleading receipt.
    game.addExecution(new DonateTroopsExecution(donor, recipientInfo.id, 5000));
    game.executeNextTick();
    expect(donor.donationCount()).toBe(donationCursor + 1);
  });

  it("records the recipient-capacity-clamped troop amount", async () => {
    const gameID: GameID = "game_id";
    const game = await setup("ocean_and_land", {
      infiniteTroops: false,
      donateTroops: true,
    });
    const donorInfo = new PlayerInfo(
      "donor",
      PlayerType.Human,
      null,
      "donor_id",
    );
    const recipientInfo = new PlayerInfo(
      "recipient",
      PlayerType.Human,
      null,
      "recipient_id",
    );
    game.addPlayer(donorInfo);
    game.addPlayer(recipientInfo);
    const donor = game.player(donorInfo.id);
    const recipient = game.player(recipientInfo.id);
    game.addExecution(
      new SpawnExecution(gameID, donorInfo, game.ref(0, 10)),
      new SpawnExecution(gameID, recipientInfo, game.ref(0, 15)),
    );
    while (game.inSpawnPhase()) game.executeNextTick();
    donor.createAllianceRequest(recipient)?.accept();
    donor.addTroops(10_000);
    recipient.setTroops(game.config().maxTroops(recipient) - 3_000);
    expect(donor.isFriendly(recipient)).toBe(true);
    expect(donor.canDonateTroops(recipient)).toBe(true);
    expect(
      game.config().maxTroops(recipient) - recipient.troops(),
    ).toBeGreaterThan(2_999);
    const cursor = donor.donationCount();
    game.addExecution(new DonateTroopsExecution(donor, recipient.id(), 7_000));
    for (let i = 0; i < 5; i++) game.executeNextTick();

    const receipts = donor.donationsSentSince(cursor);
    expect(receipts).toEqual([
      {
        recipientID: recipient.id(),
        tick: expect.any(Number),
        resource: "troops",
        amount: expect.any(Number),
      },
    ]);
    expect(receipts[0].amount).toBeGreaterThan(0);
    expect(receipts[0].amount).toBeLessThanOrEqual(3_000);
  });
});

describe("Donate gold to an ally", () => {
  it("Gold should be successfully donated", async () => {
    const game = await setup("ocean_and_land", {
      infiniteGold: false,
      donateGold: true,
    });
    const gameID: GameID = "game_id";

    const donorInfo = new PlayerInfo(
      "donor",
      PlayerType.Human,
      null,
      "donor_id",
    );
    const recipientInfo = new PlayerInfo(
      "recipient",
      PlayerType.Human,
      null,
      "recipient_id",
    );

    game.addPlayer(donorInfo);
    game.addPlayer(recipientInfo);

    const donor = game.player(donorInfo.id);
    const recipient = game.player(recipientInfo.id);

    // Spawn both players
    const spawnA = game.ref(0, 10);
    const spawnB = game.ref(0, 15);

    game.addExecution(
      new SpawnExecution(gameID, donorInfo, spawnA),
      new SpawnExecution(gameID, recipientInfo, spawnB),
    );

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    // donor sends alliance request to recipient
    const allianceRequest = donor.createAllianceRequest(recipient);
    expect(allianceRequest).not.toBeNull();

    // recipient accepts the alliance request
    if (allianceRequest) {
      allianceRequest.accept();
    }
    game.executeNextTick();

    // Ensure donor can actually donate the requested amount
    donor.addGold(6000n);
    const donorGoldBefore = donor.gold();
    const recipientGoldBefore = recipient.gold();
    const donationCursor = donor.donationCount();
    game.addExecution(new DonateGoldExecution(donor, recipientInfo.id, 5000));

    for (let i = 0; i < 5; i++) {
      game.executeNextTick();
    }

    expect(donor.gold() < donorGoldBefore).toBe(true);
    expect(recipient.gold() > recipientGoldBefore).toBe(true);
    const receipts = donor.donationsSentSince(donationCursor);
    expect(receipts).toEqual([
      {
        recipientID: recipient.id(),
        tick: expect.any(Number),
        resource: "gold",
        amount: 5000n,
      },
    ]);
    const mutableReceipt = receipts[0] as {
      recipientID: string;
      tick: number;
    };
    mutableReceipt.recipientID = "forged_recipient";
    mutableReceipt.tick = -100_000;
    expect(donor.donationsSentSince(donationCursor)[0]).toMatchObject({
      recipientID: recipient.id(),
      tick: expect.any(Number),
    });
    expect(donor.canDonateGold(recipient)).toBe(false);
    (receipts as Array<(typeof receipts)[number]>).push(receipts[0]);
    expect(donor.donationCount()).toBe(donationCursor + 1);
  });

  it("records the sender-balance-clamped gold amount", async () => {
    const game = await setup("ocean_and_land", {
      infiniteGold: false,
      donateGold: true,
    });
    const donorInfo = new PlayerInfo(
      "donor",
      PlayerType.Human,
      null,
      "donor_id",
    );
    const recipientInfo = new PlayerInfo(
      "recipient",
      PlayerType.Human,
      null,
      "recipient_id",
    );
    game.addPlayer(donorInfo);
    game.addPlayer(recipientInfo);
    const donor = game.player(donorInfo.id);
    const recipient = game.player(recipientInfo.id);
    donor.createAllianceRequest(recipient)?.accept();
    donor.removeGold(donor.gold());
    donor.addGold(3_000n);
    const cursor = donor.donationCount();

    expect(donor.donateGold(recipient, 5_000n)).toBe(true);

    expect(donor.donationsSentSince(cursor)).toEqual([
      {
        recipientID: recipient.id(),
        tick: expect.any(Number),
        resource: "gold",
        amount: 3_000n,
      },
    ]);
  });
});

describe("Donate troops to a non ally", () => {
  it("Troops should not be donated", async () => {
    const game = await setup("ocean_and_land", {
      infiniteTroops: false,
      donateTroops: true,
    });
    const gameID: GameID = "game_id";

    const donorInfo = new PlayerInfo(
      "donor",
      PlayerType.Human,
      null,
      "donor_id",
    );
    const recipientInfo = new PlayerInfo(
      "recipient",
      PlayerType.Human,
      null,
      "recipient_id",
    );

    game.addPlayer(donorInfo);
    game.addPlayer(recipientInfo);

    const donor = game.player(donorInfo.id);
    const recipient = game.player(recipientInfo.id);

    // Spawn both players
    const spawnA = game.ref(0, 10);
    const spawnB = game.ref(0, 15);

    game.addExecution(
      new SpawnExecution(gameID, donorInfo, spawnA),
      new SpawnExecution(gameID, recipientInfo, spawnB),
    );

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    // Donor sends alliance request to Recipient
    const allianceRequest = donor.createAllianceRequest(recipient);
    expect(allianceRequest).not.toBeNull();

    // Donor rejects the Recipient
    if (allianceRequest) {
      allianceRequest.reject();
    }

    const donorTroopsBefore = donor.troops();
    const recipientTroopsBefore = recipient.troops();
    const donationCursor = donor.donationCount();

    game.addExecution(new DonateTroopsExecution(donor, recipientInfo.id, 5000));
    game.executeNextTick();

    // Troops should not be donated since they are not allies
    expect(donor.troops() >= donorTroopsBefore).toBe(true);
    expect(recipient.troops() >= recipientTroopsBefore).toBe(true);
    expect(donor.donationsSentSince(donationCursor)).toEqual([]);
  });
});

describe("Donate Gold to a non ally", () => {
  it("Gold should not be donated", async () => {
    const game = await setup("ocean_and_land", {
      infiniteGold: false,
      donateGold: true,
    });
    const gameID: GameID = "game_id";

    const donorInfo = new PlayerInfo(
      "donor",
      PlayerType.Human,
      null,
      "donor_id",
    );
    const recipientInfo = new PlayerInfo(
      "recipient",
      PlayerType.Human,
      null,
      "recipient_id",
    );

    game.addPlayer(donorInfo);
    game.addPlayer(recipientInfo);

    const donor = game.player(donorInfo.id);
    const recipient = game.player(recipientInfo.id);

    // Spawn both players
    const spawnA = game.ref(0, 10);
    const spawnB = game.ref(0, 15);

    game.addExecution(
      new SpawnExecution(gameID, donorInfo, spawnA),
      new SpawnExecution(gameID, recipientInfo, spawnB),
    );

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    // Donor sends alliance request to Recipient
    const allianceRequest = donor.createAllianceRequest(recipient);
    expect(allianceRequest).not.toBeNull();

    // Donor rejects the Recipient
    if (allianceRequest) {
      allianceRequest.reject();
    }

    const donorGoldBefore = donor.gold();
    const recipientGoldBefore = donor.gold();
    const donationCursor = donor.donationCount();

    game.addExecution(new DonateGoldExecution(donor, recipientInfo.id, 5000));
    game.executeNextTick();

    // Gold should not be donated since they are not allies
    expect(donor.gold() >= donorGoldBefore).toBe(true);
    expect(recipient.gold() >= recipientGoldBefore).toBe(true);
    expect(donor.donationsSentSince(donationCursor)).toEqual([]);
  });
});
