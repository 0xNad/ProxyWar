import { describe, expect, it, vi } from "vitest";

import { DonateGoldExecution } from "../src/core/execution/DonateGoldExecution";
import { DonateTroopsExecution } from "../src/core/execution/DonateTroopExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  type PlayerID,
} from "../src/core/game/Game";
import type { TileRef } from "../src/core/game/GameMap";
import type { GameConfig } from "../src/core/Schemas";
import { GameConfigSchema, GameStartInfoSchema } from "../src/core/Schemas";
import { setup } from "./util/Setup";

interface Pair {
  game: Game;
  donor: Player;
  recipient: Player;
  donorTile: TileRef;
  recipientTile: TileRef;
}

async function pair(config: Partial<GameConfig> = {}): Promise<Pair> {
  const game = await setup(
    "plains",
    {
      nations: "disabled",
      donateGold: true,
      donateTroops: true,
      ...config,
    },
    [
      new PlayerInfo("Donor", PlayerType.Human, "DONORCL1", "DONOR001"),
      new PlayerInfo("Recipient", PlayerType.Human, "RECIPCL1", "RECIP001"),
    ],
  );
  const donor = game.player("DONOR001");
  const recipient = game.player("RECIP001");
  const donorTile = game.ref(10, 50);
  const recipientTile = game.ref(30, 50);
  donor.conquer(donorTile);
  recipient.conquer(recipientTile);
  donor.setSpawnTile(donorTile);
  recipient.setSpawnTile(recipientTile);
  while (game.inSpawnPhase()) game.executeNextTick();
  return { game, donor, recipient, donorTile, recipientTile };
}

function resetGold(player: Player, amount: bigint): void {
  player.removeGold(player.gold());
  player.addGold(amount);
}

describe("non-friendly donation configuration", () => {
  it("defaults false and keeps old game/replay configuration parseable", async () => {
    const { game, donor, recipient } = await pair();
    expect(game.config().donateToNonFriendly()).toBe(false);
    expect(donor.isFriendly(recipient)).toBe(false);
    expect(donor.canDonateGold(recipient)).toBe(false);
    expect(donor.canDonateTroops(recipient)).toBe(false);

    const oldConfig = { ...game.config().gameConfig() };
    delete oldConfig.donateToNonFriendly;
    expect(
      GameConfigSchema.parse(oldConfig).donateToNonFriendly,
    ).toBeUndefined();
    expect(
      GameStartInfoSchema.safeParse({
        gameID: "OLDRPLY1",
        lobbyCreatedAt: 1,
        config: oldConfig,
        players: [],
      }).success,
    ).toBe(true);
  });

  it("enables exact enemy gold and troop transfers with deterministic relation and receipts", async () => {
    const runGold = async () => {
      const { game, donor, recipient } = await pair({
        donateToNonFriendly: true,
      });
      resetGold(donor, 100_000n);
      const donorBefore = donor.gold();
      const recipientBefore = recipient.gold();
      const relationBefore = recipient.relation(donor);
      const cursor = donor.donationCount();
      game.addExecution(new DonateGoldExecution(donor, recipient.id(), 50_000));
      game.executeNextTick();
      game.executeNextTick();
      return {
        donorDelta: donorBefore - donor.gold(),
        recipientDelta: recipient.gold() - recipientBefore,
        relationBefore,
        relationAfter: recipient.relation(donor),
        receipts: donor.donationsSentSince(cursor),
      };
    };

    const first = await runGold();
    const second = await runGold();
    expect(first).toEqual(second);
    expect(first.donorDelta).toBe(50_000n);
    expect(first.recipientDelta).toBe(50_000n);
    expect(first.relationAfter).toBe(first.relationBefore);
    expect(first.receipts).toEqual([
      {
        recipientID: "RECIP001",
        tick: expect.any(Number),
        resource: "gold",
        amount: 50_000n,
      },
    ]);

    const { game, donor, recipient } = await pair({
      donateToNonFriendly: true,
    });
    donor.setTroops(20_000);
    const maxTroops = game.config().maxTroops(recipient);
    recipient.setTroops(maxTroops - 750);
    const cursor = donor.donationCount();
    game.addExecution(new DonateTroopsExecution(donor, recipient.id(), 5_000));
    game.executeNextTick();
    game.executeNextTick();
    expect(recipient.troops()).toBe(maxTroops);
    expect(donor.donationsSentSince(cursor)).toEqual([
      {
        recipientID: recipient.id(),
        tick: expect.any(Number),
        resource: "troops",
        amount: 750,
      },
    ]);
  });

  it("centralizes self, life, connection, resource, headroom, and cooldown eligibility", async () => {
    const active = await pair({ donateToNonFriendly: true });
    resetGold(active.donor, 10_000n);
    active.donor.setTroops(10_000);
    expect(active.donor.canDonateGold(active.donor)).toBe(false);
    expect(active.donor.canDonateTroops(active.donor)).toBe(false);

    active.recipient.markDisconnected(true);
    expect(active.donor.canDonateGold(active.recipient)).toBe(false);
    expect(active.donor.canDonateTroops(active.recipient)).toBe(false);
    active.recipient.markDisconnected(false);
    active.donor.markDisconnected(true);
    expect(active.donor.canDonateGold(active.recipient)).toBe(false);
    expect(active.donor.canDonateTroops(active.recipient)).toBe(false);

    const deadRecipient = await pair({ donateToNonFriendly: true });
    deadRecipient.recipient.relinquish(deadRecipient.recipientTile);
    expect(deadRecipient.recipient.isAlive()).toBe(false);
    expect(deadRecipient.donor.canDonateGold(deadRecipient.recipient)).toBe(
      false,
    );

    const deadDonor = await pair({ donateToNonFriendly: true });
    deadDonor.donor.relinquish(deadDonor.donorTile);
    expect(deadDonor.donor.isAlive()).toBe(false);
    expect(deadDonor.donor.canDonateTroops(deadDonor.recipient)).toBe(false);

    const resourceOff = await pair({
      donateToNonFriendly: true,
      donateGold: false,
      donateTroops: false,
    });
    resetGold(resourceOff.donor, 10_000n);
    resourceOff.donor.setTroops(10_000);
    expect(resourceOff.donor.canDonateGold(resourceOff.recipient)).toBe(false);
    expect(resourceOff.donor.canDonateTroops(resourceOff.recipient)).toBe(
      false,
    );

    const empty = await pair({ donateToNonFriendly: true });
    resetGold(empty.donor, 0n);
    empty.donor.setTroops(0);
    expect(empty.donor.canDonateGold(empty.recipient)).toBe(false);
    expect(empty.donor.canDonateTroops(empty.recipient)).toBe(false);

    const fullRecipient = await pair({ donateToNonFriendly: true });
    fullRecipient.donor.setTroops(10_000);
    fullRecipient.recipient.setTroops(
      fullRecipient.game.config().maxTroops(fullRecipient.recipient),
    );
    expect(fullRecipient.donor.canDonateTroops(fullRecipient.recipient)).toBe(
      false,
    );

    const cooldown = await pair({ donateToNonFriendly: true });
    resetGold(cooldown.donor, 10_000n);
    cooldown.donor.setTroops(10_000);
    expect(cooldown.donor.donateGold(cooldown.recipient, 1_000n)).toBe(true);
    expect(cooldown.donor.canDonateGold(cooldown.recipient)).toBe(false);
    expect(cooldown.donor.canDonateTroops(cooldown.recipient)).toBe(false);
  });

  it("direct donation methods cannot bypass the configured audience", async () => {
    const { donor, recipient } = await pair();
    resetGold(donor, 10_000n);
    donor.setTroops(10_000);
    const donorGold = donor.gold();
    const recipientGold = recipient.gold();
    const donorTroops = donor.troops();
    const recipientTroops = recipient.troops();
    expect(donor.donateGold(recipient, 1_000n)).toBe(false);
    expect(donor.donateTroops(recipient, 1_000)).toBe(false);
    expect(donor.gold()).toBe(donorGold);
    expect(recipient.gold()).toBe(recipientGold);
    expect(donor.troops()).toBe(donorTroops);
    expect(recipient.troops()).toBe(recipientTroops);
    expect(donor.donationsSentSince(0)).toEqual([]);
  });

  it("missing recipients fail without a transfer or fabricated receipt", async () => {
    const { game, donor } = await pair({ donateToNonFriendly: true });
    resetGold(donor, 10_000n);
    donor.setTroops(10_000);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cursor = donor.donationCount();
    game.addExecution(
      new DonateGoldExecution(donor, "MISSING1" as PlayerID, 1_000),
      new DonateTroopsExecution(donor, "MISSING1" as PlayerID, 1_000),
    );
    game.executeNextTick();
    game.executeNextTick();
    expect(donor.donationsSentSince(cursor)).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
