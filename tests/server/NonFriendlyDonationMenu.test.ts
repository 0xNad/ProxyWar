import { afterEach, describe, expect, it } from "vitest";

import { Game, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentDealsObservation,
  AgentObservation,
} from "../../src/server/agents/AgentTypes";
import {
  LegalActionBuilder,
  NON_FRIENDLY_SUPPORT_ACTION_CAP,
} from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";

const DONOR_ID = "PLAYER00";
const DONOR_CLIENT_ID = "CLIENT00";
const STRUCTURED_DEALS_FLAG = "PROXYWAR_TUNE_STRUCTURED_DEALS";
const FREE_TEXT_FLAG = "PROXYWAR_TUNE_FREETEXT_MESSAGES";

const originalDealsFlag = process.env[STRUCTURED_DEALS_FLAG];
const originalFreeTextFlag = process.env[FREE_TEXT_FLAG];

afterEach(() => {
  restoreEnv(STRUCTURED_DEALS_FLAG, originalDealsFlag);
  restoreEnv(FREE_TEXT_FLAG, originalFreeTextFlag);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function roster(): PlayerInfo[] {
  return Array.from(
    { length: 16 },
    (_, index) =>
      new PlayerInfo(
        `Player ${index}`,
        PlayerType.Human,
        `CLIENT${index.toString().padStart(2, "0")}`,
        `PLAYER${index.toString().padStart(2, "0")}`,
      ),
  );
}

async function sixteenPlayerObservation(input: {
  reverse: boolean;
  donateToNonFriendly: boolean;
}): Promise<{ game: Game; observation: AgentObservation; rivalIDs: string[] }> {
  const players = roster();
  const ordered = input.reverse ? [...players].reverse() : players;
  const game = await setup(
    "plains",
    {
      nations: "disabled",
      donateGold: true,
      donateTroops: true,
      donateToNonFriendly: input.donateToNonFriendly,
    },
    ordered,
  );
  for (const [index, info] of players.entries()) {
    const player = game.player(info.id);
    const tile = game.ref(5 + index * 5, 50);
    player.conquer(tile);
    player.setSpawnTile(tile);
  }
  while (game.inSpawnPhase()) game.executeNextTick();

  const donor = game.player(DONOR_ID);
  donor.addGold(2_000_000n);
  donor.setTroops(100_000);
  const observation = new AgentObservationBuilder().build({
    agentID: "agent-donor",
    clientID: DONOR_CLIENT_ID,
    username: "Player 0",
    profile: "diplomatic",
    gameID: "DONATE16",
    turnNumber: 500,
    gameState: game,
  });
  return {
    game,
    observation,
    rivalIDs: players
      .map((player) => player.id)
      .filter((id) => id !== DONOR_ID),
  };
}

function crowdedWithDeals(
  observation: AgentObservation,
  rivalIDs: readonly string[],
): AgentObservation {
  const [napProposerID, supportProposerID] = rivalIDs;
  const visibleByID = new Map(
    observation.visiblePlayers.map((player) => [player.playerID, player]),
  );
  const deals: AgentDealsObservation = {
    decisionStep: 5,
    incomingProposals: [
      {
        dealID: `deal:${napProposerID}:${DONOR_ID}:non_aggression_pact:4`,
        proposerPlayerID: napProposerID!,
        proposerName: visibleByID.get(napProposerID!)!.name,
        recipientPlayerID: DONOR_ID,
        recipientName: "Player 0",
        terms: { template: "non_aggression_pact", durationSteps: 12 },
        proposedAtStep: 4,
        answerableThroughStep: 8,
      },
      {
        dealID: `deal:${supportProposerID}:${DONOR_ID}:support_request:4`,
        proposerPlayerID: supportProposerID!,
        proposerName: visibleByID.get(supportProposerID!)!.name,
        recipientPlayerID: DONOR_ID,
        recipientName: "Player 0",
        terms: {
          template: "support_request",
          durationSteps: 6,
          goldAmount: "50000",
          troopAmount: 5000,
        },
        proposedAtStep: 4,
        answerableThroughStep: 8,
      },
    ],
    outgoingProposals: [],
    activeDeals: [],
    proposalOptions: [],
    rivalReliability: [],
  };
  return {
    ...observation,
    combat: {
      ...observation.combat,
      outgoingAttacks: Array.from({ length: 160 }, (_, index) => ({
        attackID: `crowded-${index}`,
        targetID: rivalIDs[index % rivalIDs.length]!,
        targetName: `Crowded target ${index}`,
        troops: 100,
        retreating: false,
        sourceTile: null,
        borderSize: 1,
      })),
    },
    deals,
  };
}

describe("Coworld non-friendly donation action lane", () => {
  it.each([false, true])(
    "keeps all 30 support IDs, comms, hold, and atomic deal responses with reverse=%s",
    async (reverse) => {
      process.env[STRUCTURED_DEALS_FLAG] = "1";
      process.env[FREE_TEXT_FLAG] = "1";
      const { observation, rivalIDs } = await sixteenPlayerObservation({
        reverse,
        donateToNonFriendly: true,
      });

      expect(observation.nonCombat.donateToNonFriendly).toBe(true);
      expect(observation.nonCombat.supportOptions).toHaveLength(15);
      expect(
        observation.nonCombat.supportOptions.every(
          (option) =>
            option.canDonateGold &&
            option.canDonateTroops &&
            option.legalReasons.every((reason) =>
              reason.includes("non-friendly donations"),
            ),
        ),
      ).toBe(true);

      const menu = new LegalActionBuilder().build({
        observation: crowdedWithDeals(observation, rivalIDs),
      });
      const ids = menu.map((action) => action.id);
      const donationIDs = menu
        .filter(
          (action) =>
            action.kind === "donate_gold" || action.kind === "donate_troops",
        )
        .map((action) => action.id);
      const expectedDonationIDs = rivalIDs.flatMap((id) => [
        `donate_troops:${id}`,
        `donate_gold:${id}`,
      ]);

      expect(menu.length).toBeLessThanOrEqual(96);
      expect(menu).toHaveLength(96);
      expect(new Set(ids).size).toBe(ids.length);
      expect(donationIDs).toHaveLength(NON_FRIENDLY_SUPPORT_ACTION_CAP);
      expect(new Set(donationIDs)).toEqual(new Set(expectedDonationIDs));
      expect(menu.filter((action) => action.kind === "message")).toHaveLength(
        6,
      );
      expect(ids).toContain("hold");

      const napID = `deal:${rivalIDs[0]}:${DONOR_ID}:non_aggression_pact:4`;
      expect(ids).toContain(`deal_accept:${napID}`);
      expect(ids).toContain(`deal_reject:${napID}`);
      const supportID = `deal:${rivalIDs[1]}:${DONOR_ID}:support_request:4`;
      expect(ids).not.toContain(`deal_accept:${supportID}`);
      expect(ids).toContain(`deal_reject:${supportID}`);
    },
  );

  it("keeps the flag-off observation and enemy menu donation-free", async () => {
    const { observation } = await sixteenPlayerObservation({
      reverse: false,
      donateToNonFriendly: false,
    });
    expect(observation.nonCombat.donateToNonFriendly).toBeUndefined();
    expect(observation.nonCombat.supportOptions).toEqual([]);
    const menu = new LegalActionBuilder().build({ observation });
    expect(
      menu.filter(
        (action) =>
          action.kind === "donate_gold" || action.kind === "donate_troops",
      ),
    ).toEqual([]);
  });
});
