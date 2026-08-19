import { describe, expect, it } from "vitest";
import {
  chooseKeystoneDealMove,
  decisionToResponse,
  keystoneAbstentionPartners,
  withKeystoneDeal,
  withoutKeystoneTreatyBreaches,
} from "../../coworld-adapter/src/keystone-player";
import type {
  AgentDecision,
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

function action(
  kind: string,
  id: string,
  metadata: Record<string, unknown> = {},
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: "medium", score: 0.5 },
    metadata,
  } as unknown as LegalAction;
}

function observation(overrides: {
  ownID?: string;
  incoming?: Array<{
    dealID: string;
    proposerPlayerID: string;
    template: string;
    answerableThroughStep?: number;
  }>;
  outgoing?: Array<{ recipientPlayerID: string; proposerPlayerID: string }>;
  active?: Array<{
    dealID: string;
    proposerPlayerID: string;
    recipientPlayerID: string;
    obligations: Array<{
      obligorPlayerID: string;
      kind: string;
      status: string;
    }>;
  }>;
  rivals?: Array<{
    playerID: string;
    sharesBorder?: boolean;
    isAllied?: boolean;
    isAlive?: boolean;
  }>;
}): AgentObservation {
  return {
    ownState: { playerID: overrides.ownID ?? "me" },
    visiblePlayers: overrides.rivals ?? [],
    deals: {
      incomingProposals: (overrides.incoming ?? []).map((p) => ({
        dealID: p.dealID,
        proposerPlayerID: p.proposerPlayerID,
        recipientPlayerID: overrides.ownID ?? "me",
        terms: { template: p.template },
        answerableThroughStep: p.answerableThroughStep ?? 4,
      })),
      outgoingProposals: overrides.outgoing ?? [],
      activeDeals: overrides.active ?? [],
      proposalOptions: [],
    },
  } as unknown as AgentObservation;
}

const liveRival = (id: string) => ({
  playerID: id,
  sharesBorder: true,
  isAllied: false,
  isAlive: true,
});

describe("keystone structured deals", () => {
  it("answers an incoming proposal rather than letting it expire", () => {
    const move = chooseKeystoneDealMove({
      observation: observation({
        incoming: [
          {
            dealID: "d1",
            proposerPlayerID: "r1",
            template: "non_aggression_pact",
          },
        ],
        rivals: [liveRival("r1")],
      }),
      legalActions: [
        action("deal_accept", "accept:d1", { dealID: "d1" }),
        action("deal_reject", "reject:d1", { dealID: "d1" }),
      ],
      proposed: new Set(),
    });
    expect(move?.id).toBe("accept:d1");
  });

  it("answers the nearest deadline first when several are open", () => {
    const move = chooseKeystoneDealMove({
      observation: observation({
        incoming: [
          {
            dealID: "late",
            proposerPlayerID: "r1",
            template: "non_aggression_pact",
            answerableThroughStep: 9,
          },
          {
            dealID: "soon",
            proposerPlayerID: "r2",
            template: "non_aggression_pact",
            answerableThroughStep: 2,
          },
        ],
        rivals: [liveRival("r1"), liveRival("r2")],
      }),
      legalActions: [
        action("deal_accept", "accept:late", { dealID: "late" }),
        action("deal_accept", "accept:soon", { dealID: "soon" }),
      ],
      proposed: new Set(),
    });
    expect(move?.id).toBe("accept:soon");
  });

  // The core safety rule: keystone's brain cannot donate, so accepting a
  // support_request would make our champion a proven violator.
  it("rejects support_request explicitly instead of accepting what it cannot honor", () => {
    const move = chooseKeystoneDealMove({
      observation: observation({
        incoming: [
          { dealID: "d2", proposerPlayerID: "r1", template: "support_request" },
        ],
        rivals: [liveRival("r1")],
      }),
      legalActions: [
        action("deal_accept", "accept:d2", { dealID: "d2" }),
        action("deal_reject", "reject:d2", { dealID: "d2" }),
      ],
      proposed: new Set(),
    });
    expect(move?.id).toBe("reject:d2");
  });

  it("accepts joint_attack, whose obligation falls on the proposer", () => {
    const move = chooseKeystoneDealMove({
      observation: observation({
        incoming: [
          { dealID: "d3", proposerPlayerID: "r1", template: "joint_attack" },
        ],
        rivals: [liveRival("r1")],
      }),
      legalActions: [
        action("deal_accept", "accept:d3", { dealID: "d3" }),
        action("deal_reject", "reject:d3", { dealID: "d3" }),
      ],
      proposed: new Set(),
    });
    expect(move?.id).toBe("accept:d3");
  });

  it("rejects a proposal from a dead proposer", () => {
    const move = chooseKeystoneDealMove({
      observation: observation({
        incoming: [
          {
            dealID: "d4",
            proposerPlayerID: "ghost",
            template: "non_aggression_pact",
          },
        ],
        rivals: [{ ...liveRival("ghost"), isAlive: false }],
      }),
      legalActions: [
        action("deal_accept", "accept:d4", { dealID: "d4" }),
        action("deal_reject", "reject:d4", { dealID: "d4" }),
      ],
      proposed: new Set(),
    });
    expect(move?.id).toBe("reject:d4");
  });

  it("proposes a pact to a bordering rival, never to an ally or a stranger", () => {
    const legalActions = [
      action("deal_propose", "propose:ally", {
        recipientID: "ally",
        template: "non_aggression_pact",
      }),
      action("deal_propose", "propose:far", {
        recipientID: "far",
        template: "non_aggression_pact",
      }),
      action("deal_propose", "propose:border", {
        recipientID: "border",
        template: "non_aggression_pact",
      }),
    ];
    const move = chooseKeystoneDealMove({
      observation: observation({
        rivals: [
          {
            playerID: "ally",
            sharesBorder: true,
            isAllied: true,
            isAlive: true,
          },
          {
            playerID: "far",
            sharesBorder: false,
            isAllied: false,
            isAlive: true,
          },
          liveRival("border"),
        ],
      }),
      legalActions,
      proposed: new Set(),
    });
    expect(move?.id).toBe("propose:border");
  });

  it("does not stack proposals on a rival we already have something open with", () => {
    const move = chooseKeystoneDealMove({
      observation: observation({
        outgoing: [{ recipientPlayerID: "r1", proposerPlayerID: "me" }],
        rivals: [liveRival("r1")],
      }),
      legalActions: [
        action("deal_propose", "propose:r1", {
          recipientID: "r1",
          template: "non_aggression_pact",
        }),
      ],
      proposed: new Set(),
    });
    expect(move).toBeNull();
  });

  it("caps proposals per counterparty across the match", () => {
    const proposed = new Set<string>();
    const legalActions = [
      action("deal_propose", "propose:r1", {
        recipientID: "r1",
        template: "non_aggression_pact",
      }),
    ];
    const obs = observation({ rivals: [liveRival("r1")] });
    let sent = 0;
    for (let i = 0; i < 40; i += 1) {
      if (
        chooseKeystoneDealMove({ observation: obs, legalActions, proposed })
      ) {
        sent += 1;
      }
    }
    expect(sent).toBe(2);
  });

  // Never withdraw our own unanswered offer — PR #113's defect, where 96.4% of
  // withdrawals landed one step after the proposal.
  it("never selects deal_withdraw", () => {
    const proposed = new Set<string>();
    const obs = observation({
      outgoing: [{ recipientPlayerID: "r1", proposerPlayerID: "me" }],
      rivals: [liveRival("r1")],
    });
    const move = chooseKeystoneDealMove({
      observation: obs,
      legalActions: [action("deal_withdraw", "withdraw:d1", { dealID: "d1" })],
      proposed,
    });
    expect(move).toBeNull();
  });

  it("stays silent when the game offers no deal actions at all", () => {
    expect(
      chooseKeystoneDealMove({
        observation: observation({ rivals: [liveRival("r1")] }),
        legalActions: [action("hold", "hold")],
        proposed: new Set(),
      }),
    ).toBeNull();
  });
});

describe("keystone treaty compliance guard", () => {
  const pactObservation = observation({
    active: [
      {
        dealID: "d1",
        proposerPlayerID: "partner",
        recipientPlayerID: "me",
        obligations: [
          {
            obligorPlayerID: "me",
            kind: "non_aggression",
            status: "pending",
          },
        ],
      },
    ],
    rivals: [liveRival("partner"), liveRival("other")],
  });

  it("identifies the partners we owe abstention to", () => {
    expect([...keystoneAbstentionPartners(pactObservation)]).toEqual([
      "partner",
    ]);
  });

  it("withholds attacks on a pact partner while leaving every other action", () => {
    const kept = withoutKeystoneTreatyBreaches(
      [
        action("attack", "attack:partner", { targetID: "partner" }),
        action("embargo", "embargo:partner", { targetID: "partner" }),
        action("attack", "attack:other", { targetID: "other" }),
        action("build", "build:city"),
      ],
      pactObservation,
    ).map((a) => a.id);
    expect(kept).toEqual(["attack:other", "build:city"]);
  });

  it("leaves the menu untouched when we owe nobody", () => {
    const actions = [action("attack", "attack:other", { targetID: "other" })];
    expect(withoutKeystoneTreatyBreaches(actions, observation({}))).toBe(
      actions,
    );
  });

  it("never hands the brain an empty menu, even to keep a treaty", () => {
    const actions = [
      action("attack", "attack:partner", { targetID: "partner" }),
    ];
    expect(withoutKeystoneTreatyBreaches(actions, pactObservation)).toBe(
      actions,
    );
  });

  it("stops withholding once the obligation is no longer pending", () => {
    const settled = observation({
      active: [
        {
          dealID: "d1",
          proposerPlayerID: "partner",
          recipientPlayerID: "me",
          obligations: [
            { obligorPlayerID: "me", kind: "non_aggression", status: "kept" },
          ],
        },
      ],
      rivals: [liveRival("partner")],
    });
    const actions = [
      action("attack", "attack:partner", { targetID: "partner" }),
    ];
    expect(withoutKeystoneTreatyBreaches(actions, settled)).toBe(actions);
  });
});

describe("keystone deal wire", () => {
  it("carries the chosen deal action in its own slot", () => {
    const decision = withKeystoneDeal(
      { actionID: "hold", reason: "r" } as unknown as AgentDecision,
      action("deal_accept", "accept:d1", { dealID: "d1" }),
    );
    expect(decision.dealActionID).toBe("accept:d1");
    expect(decisionToResponse("req-1", decision).selectedDealActionId).toBe(
      "accept:d1",
    );
  });

  it("omits the slot entirely when no deal was chosen", () => {
    const response = decisionToResponse("req-2", {
      actionID: "hold",
      reason: "r",
    } as unknown as AgentDecision);
    expect(response).not.toHaveProperty("selectedDealActionId");
  });

  it("does not clobber a brain that already chose a deal", () => {
    const spoken = {
      actionID: "hold",
      reason: "r",
      dealActionID: "accept:own",
    } as unknown as AgentDecision;
    expect(
      withKeystoneDeal(spoken, action("deal_reject", "reject:x", {}))
        .dealActionID,
    ).toBe("accept:own");
  });
});
