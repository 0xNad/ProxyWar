import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const POLICY_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "hosted-social-counterparty-policy.mjs",
);

type Decision = {
  selectedLegalActionId: string;
  selectedDealActionId?: string;
  reason: string;
};

async function policy(profile: string) {
  const module = (await import(pathToFileURL(POLICY_FILE).href)) as {
    createHostedSocialCounterpartyPolicy: (
      value: string,
    ) => (input: unknown) => Decision;
    resolveHostedSocialCounterpartyConfig: (input: unknown) => unknown;
  };
  return {
    choose: module.createHostedSocialCounterpartyPolicy(profile),
    resolve: module.resolveHostedSocialCounterpartyConfig,
  };
}

const HOLD = { id: "hold", kind: "hold", risk: { level: "none" } };
const EXPAND = {
  id: "attack:neutral:10",
  kind: "attack",
  risk: { level: "low" },
  metadata: { expansion: true },
};
const ATTACK = {
  id: "attack:P_STARTER:20",
  kind: "attack",
  risk: { level: "medium" },
  metadata: { targetID: "P_STARTER", expansion: false },
};
const NAP = {
  id: "deal_propose:P_STARTER:non_aggression_pact",
  kind: "deal_propose",
  risk: { level: "low" },
  metadata: {
    recipientID: "P_STARTER",
    template: "non_aggression_pact",
  },
};
const SUPPORT = {
  id: "deal_propose:P_STARTER:support_request",
  kind: "deal_propose",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER", template: "support_request" },
};

function baseObservation(step = 10) {
  return {
    ownState: {
      playerID: "P_CONTROL",
      tileShare: 0.2,
      troopRatio: 0.5,
      incomingAttacks: 0,
    },
    visiblePlayers: [
      {
        playerID: "P_STARTER",
        isAlive: true,
        isFriendly: false,
        sharesBorder: true,
        canAttack: true,
        tileShare: 0.3,
        troops: 20_000,
        maxTroops: 100_000,
      },
    ],
    deals: {
      decisionStep: step,
      incomingProposals: [],
      outgoingProposals: [],
      activeDeals: [],
      rivalReliability: [],
    },
  };
}

function incoming(dealID: string, template: string) {
  return {
    dealID,
    proposerPlayerID: "P_STARTER",
    terms: {
      template,
      goldAmount: "50000",
      troopAmount: 5000,
    },
    answerableThroughStep: 20,
  };
}

function response(dealID: string, kind: "deal_accept" | "deal_reject") {
  return {
    id: `${kind}:${dealID}`,
    kind,
    risk: { level: "none" },
    metadata: { dealID },
  };
}

describe("hosted social counterparty policy", () => {
  it("freezes the build profile ahead of runtime overrides", async () => {
    const { resolve } = await policy("deal-blind");
    expect(
      resolve({
        builtConfig: { profile: "pact-keeper" },
        argv: ["pact-breaker"],
        env: { PROXYWAR_HOSTED_SOCIAL_COUNTERPARTY: "mutual-aid" },
      }),
    ).toEqual({ profile: "pact-keeper", source: "build" });
  });

  it("keeps the deal-blind control out of the diplomacy slot", async () => {
    const { choose } = await policy("deal-blind");
    const decision = choose({
      legalActions: [NAP, EXPAND, HOLD],
      observation: baseObservation(),
    });
    expect(decision.selectedLegalActionId).toBe(EXPAND.id);
    expect(decision.selectedDealActionId).toBeUndefined();
  });

  it("makes keeping and breaking the same accepted pact observably different", async () => {
    const active = {
      ...baseObservation(12),
      deals: {
        ...baseObservation(12).deals,
        activeDeals: [
          {
            dealID: "PACT",
            template: "non_aggression_pact",
            proposerPlayerID: "P_STARTER",
            recipientPlayerID: "P_CONTROL",
            activeFromStep: 12,
            obligations: [
              {
                obligorPlayerID: "P_CONTROL",
                status: "pending",
                kind: "non_aggression",
              },
            ],
          },
        ],
      },
    };
    const keeper = (await policy("pact-keeper")).choose({
      legalActions: [ATTACK, HOLD],
      observation: active,
    });
    const breaker = (await policy("pact-breaker")).choose({
      legalActions: [ATTACK, HOLD],
      observation: active,
    });
    expect(keeper.selectedLegalActionId).toBe(HOLD.id);
    expect(breaker.selectedLegalActionId).toBe(ATTACK.id);
    expect(breaker.reason).toContain("intentionally violates");
  });

  it("rejects positive promises the profile does not explicitly fulfill", async () => {
    const { choose } = await policy("pact-keeper");
    const proposal = incoming("JOINT", "joint_attack");
    expect(
      choose({
        legalActions: [
          response("JOINT", "deal_accept"),
          response("JOINT", "deal_reject"),
          HOLD,
        ],
        observation: {
          ...baseObservation(),
          deals: {
            ...baseObservation().deals,
            incomingProposals: [proposal],
          },
        },
      }).selectedDealActionId,
    ).toBe("deal_reject:JOINT");
  });

  it("offers at most two bordered NAPs with a meaningful retry interval", async () => {
    const { choose } = await policy("pact-keeper");
    const decide = (step: number) =>
      choose({
        legalActions: [NAP, EXPAND, HOLD],
        observation: baseObservation(step),
      });
    expect(decide(4).selectedDealActionId).toBe(NAP.id);
    expect(decide(5).selectedDealActionId).toBeUndefined();
    expect(decide(34).selectedDealActionId).toBe(NAP.id);
    expect(decide(64).selectedDealActionId).toBeUndefined();
  });

  it("requests bounded support only when disadvantaged", async () => {
    const { choose } = await policy("mutual-aid");
    const observation = baseObservation(18);
    observation.visiblePlayers[0].isFriendly = true;
    const first = choose({
      legalActions: [SUPPORT, EXPAND, HOLD],
      observation,
    });
    expect(first.selectedDealActionId).toBe(SUPPORT.id);
    const immediate = choose({
      legalActions: [SUPPORT, EXPAND, HOLD],
      observation: {
        ...observation,
        deals: { ...observation.deals, decisionStep: 19 },
      },
    });
    expect(immediate.selectedDealActionId).toBeUndefined();
    const retry = choose({
      legalActions: [SUPPORT, EXPAND, HOLD],
      observation: {
        ...observation,
        deals: { ...observation.deals, decisionStep: 78 },
      },
    });
    expect(retry.selectedDealActionId).toBe(SUPPORT.id);
  });

  it("accepts and fulfills support only after the partner has earned reciprocity", async () => {
    const { choose } = await policy("mutual-aid");
    const support = incoming("SUPPORT", "support_request");
    const accept = response("SUPPORT", "deal_accept");
    const reject = response("SUPPORT", "deal_reject");
    const donate = {
      id: "donate_gold:P_STARTER",
      kind: "donate_gold",
      risk: { level: "low" },
      metadata: { recipientID: "P_STARTER", gold: 50000 },
    };
    const unearnedBase = baseObservation(20);
    const unearned = {
      ...unearnedBase,
      visiblePlayers: unearnedBase.visiblePlayers.map((player) => ({
        ...player,
        isFriendly: true,
      })),
      deals: {
        ...unearnedBase.deals,
        incomingProposals: [support],
      },
    };
    expect(
      choose({
        legalActions: [accept, reject, donate, HOLD],
        observation: unearned,
      }).selectedDealActionId,
    ).toBe(reject.id);

    const earned = {
      ...unearned,
      deals: {
        ...unearned.deals,
        rivalReliability: [
          {
            playerID: "P_STARTER",
            fulfilled: 1,
            terminalNonMoot: 1,
            reliability: 1,
          },
        ],
      },
    };
    expect(
      choose({
        legalActions: [accept, reject, donate, HOLD],
        observation: earned,
      }).selectedDealActionId,
    ).toBe(accept.id);

    const troopOnly = {
      id: "donate_troops:P_STARTER",
      kind: "donate_troops",
      risk: { level: "medium" },
      metadata: { recipientID: "P_STARTER", troops: 7000 },
    };
    const nearCap = {
      ...earned,
      visiblePlayers: earned.visiblePlayers.map((player) => ({
        ...player,
        troops: 98_000,
        maxTroops: 100_000,
      })),
    };
    expect(
      choose({
        legalActions: [accept, reject, troopOnly, HOLD],
        observation: nearCap,
      }).selectedDealActionId,
    ).toBe(reject.id);

    const active = {
      ...earned,
      deals: {
        ...earned.deals,
        incomingProposals: [],
        activeDeals: [
          {
            dealID: "SUPPORT",
            proposerPlayerID: "P_STARTER",
            recipientPlayerID: "P_CONTROL",
            obligations: [
              {
                obligorPlayerID: "P_CONTROL",
                status: "pending",
                kind: "send_support",
                goldAmount: "50000",
                troopAmount: 5000,
                donatedGold: "0",
                donatedTroops: 0,
              },
            ],
          },
        ],
      },
    };
    expect(
      choose({ legalActions: [EXPAND, donate, HOLD], observation: active })
        .selectedLegalActionId,
    ).toBe(donate.id);
  });
});
