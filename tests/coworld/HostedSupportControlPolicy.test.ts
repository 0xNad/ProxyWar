import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const POLICY_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "hosted-support-control-policy.mjs",
);

type Decision = {
  selectedLegalActionId: string;
  selectedDealActionId?: string;
  reason: string;
  confidence: number;
  fallbackUsed: boolean;
  llmPlannerDegraded: boolean;
};

async function createSelector(): Promise<
  (input: { legalActions: unknown[]; observation?: unknown }) => Decision
> {
  const module = (await import(pathToFileURL(POLICY_FILE).href)) as {
    createHostedSupportControlPolicy: () => (value: unknown) => Decision;
  };
  const select = module.createHostedSupportControlPolicy();
  return (input) => select({ observation: {}, ...input });
}

const HOLD = {
  id: "hold",
  kind: "hold",
  risk: { level: "none" },
};
const EXPAND = {
  id: "attack:neutral:10",
  kind: "attack",
  risk: { level: "low" },
  metadata: { expansion: true },
};
const ALLIANCE = {
  id: "alliance:P_STARTER",
  kind: "alliance_request",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER" },
};
const SUPPORT = {
  id: "deal_propose:P_STARTER:support_request",
  kind: "deal_propose",
  risk: { level: "low" },
  metadata: { recipientID: "P_STARTER", template: "support_request" },
};

function observation(isFriendly: boolean) {
  return {
    visiblePlayers: [{ playerID: "P_STARTER", isAlive: true, isFriendly }],
    deals: { incomingProposals: [] },
  };
}

describe("hosted support control policy", () => {
  it("establishes a core alliance before ordinary expansion", async () => {
    const choose = await createSelector();
    const decision = choose({
      legalActions: [HOLD, EXPAND, ALLIANCE, SUPPORT],
      observation: observation(false),
    });
    expect(decision.selectedLegalActionId).toBe(ALLIANCE.id);
    expect(decision.selectedDealActionId).toBeUndefined();
  });

  it("repeatedly selects only the exact offered support action for a friendly player", async () => {
    const choose = await createSelector();
    const menu = [HOLD, SUPPORT, EXPAND];
    const first = choose({
      legalActions: menu,
      observation: observation(true),
    });
    const repeated = choose({
      legalActions: [...menu].reverse(),
      observation: observation(true),
    });
    expect(first).toEqual(repeated);
    expect(first.selectedLegalActionId).toBe(EXPAND.id);
    expect(first.selectedDealActionId).toBe(SUPPORT.id);
    expect(menu.map((action) => action.id)).toContain(
      first.selectedDealActionId,
    );
    expect(first.fallbackUsed).toBe(false);
    expect(first.llmPlannerDegraded).toBe(false);
  });

  it("accepts negative covenants before proposing support", async () => {
    const choose = await createSelector();
    const proposal = {
      dealID: "deal:P_STARTER:P_CONTROL:non_aggression_pact:3",
      terms: { template: "non_aggression_pact" },
    };
    const accept = {
      id: `deal_accept:${proposal.dealID}`,
      kind: "deal_accept",
      risk: { level: "medium" },
      metadata: { dealID: proposal.dealID },
    };
    const decision = choose({
      legalActions: [SUPPORT, accept, HOLD],
      observation: {
        ...observation(true),
        deals: { incomingProposals: [proposal] },
      },
    });
    expect(decision.selectedDealActionId).toBe(accept.id);
  });

  it("rejects an incoming support obligation it was not built to fulfill", async () => {
    const choose = await createSelector();
    const proposal = {
      dealID: "deal:P_STARTER:P_CONTROL:support_request:4",
      terms: { template: "support_request" },
    };
    const reject = {
      id: `deal_reject:${proposal.dealID}`,
      kind: "deal_reject",
      risk: { level: "none" },
      metadata: { dealID: proposal.dealID },
    };
    const decision = choose({
      legalActions: [reject, HOLD],
      observation: {
        ...observation(true),
        deals: { incomingProposals: [proposal] },
      },
    });
    expect(decision.selectedDealActionId).toBe(reject.id);
  });

  it("rotates repeated opportunities across friendly recipients", async () => {
    const choose = await createSelector();
    const supportA = {
      ...SUPPORT,
      id: "deal_propose:P_A:support_request",
      metadata: { ...SUPPORT.metadata, recipientID: "P_A" },
    };
    const supportB = {
      ...SUPPORT,
      id: "deal_propose:P_B:support_request",
      metadata: { ...SUPPORT.metadata, recipientID: "P_B" },
    };
    const input = {
      legalActions: [supportB, HOLD, supportA],
      observation: {
        visiblePlayers: [
          { playerID: "P_B", isAlive: true, isFriendly: true },
          { playerID: "P_A", isAlive: true, isFriendly: true },
        ],
        deals: { incomingProposals: [] },
      },
    };
    expect(choose(input).selectedDealActionId).toBe(supportA.id);
    expect(choose(input).selectedDealActionId).toBe(supportB.id);
    expect(choose(input).selectedDealActionId).toBe(supportA.id);
  });
});
