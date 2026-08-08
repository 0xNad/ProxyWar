import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const POLICY_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "social-control-policy.mjs",
);

type Profile = "keeper" | "defector" | "skeptic" | "deal-blind";
type Arm = "off" | "ignored" | "active";
type Decision = {
  selectedLegalActionId: string;
  selectedDealActionId?: string;
  reason: string;
  confidence: number;
  fallbackUsed: boolean;
  llmPlannerDegraded: boolean;
};

async function choose(input: {
  profile: Profile;
  arm: Arm;
  legalActions: unknown[];
  observation?: unknown;
}): Promise<Decision> {
  const module = (await import(pathToFileURL(POLICY_FILE).href)) as {
    chooseSocialControlDecision: (value: unknown) => Decision;
  };
  return module.chooseSocialControlDecision({
    observation: {},
    ...input,
  });
}

async function policyModule() {
  return (await import(pathToFileURL(POLICY_FILE).href)) as {
    resolveSocialControlConfig: (value: unknown) => {
      profile: Profile;
      arm: Arm;
      source: string;
    };
  };
}

const HOLD = {
  id: "hold",
  kind: "hold",
  label: "Hold",
  risk: { level: "none" },
};
const EXPAND = {
  id: "attack:neutral:10",
  kind: "attack",
  label: "Expand",
  risk: { level: "low" },
  metadata: { targetID: null, expansion: true, troopPercentage: 0.1 },
};
const PROPOSE_NAP = {
  id: "deal_propose:P_OTHER:non_aggression_pact",
  kind: "deal_propose",
  label: "Propose non-aggression pact",
  risk: { level: "low" },
  metadata: {
    recipientID: "P_OTHER",
    recipientName: "Other",
    template: "non_aggression_pact",
  },
};

function proposal(template = "non_aggression_pact") {
  return {
    dealID: `deal:P_OTHER:P_ME:${template}:1`,
    proposerPlayerID: "P_OTHER",
    proposerName: "Other",
    recipientPlayerID: "P_ME",
    recipientName: "Me",
    terms: { template, durationSteps: 12 },
  };
}

function responseActions(p = proposal()) {
  return [
    {
      id: `deal_accept:${p.dealID}`,
      kind: "deal_accept",
      label: "Accept",
      risk: { level: "medium" },
      metadata: { dealID: p.dealID, template: p.terms.template },
    },
    {
      id: `deal_reject:${p.dealID}`,
      kind: "deal_reject",
      label: "Reject",
      risk: { level: "none" },
      metadata: { dealID: p.dealID, template: p.terms.template },
    },
  ];
}

function activeDeal(input: {
  template?: string;
  obligationKind?: string;
  targetPlayerID?: string;
}) {
  return {
    dealID: "deal:P_ME:P_OTHER:test:2",
    template: input.template ?? "non_aggression_pact",
    proposerPlayerID: "P_ME",
    proposerName: "Me",
    recipientPlayerID: "P_OTHER",
    recipientName: "Other",
    activeFromStep: 3,
    expiresAfterStep: 12,
    stepsRemaining: 8,
    obligations: [
      {
        obligorPlayerID: "P_ME",
        obligorName: "Me",
        kind: input.obligationKind ?? "non_aggression",
        status: "pending",
        ...(input.targetPlayerID
          ? { targetPlayerID: input.targetPlayerID }
          : {}),
      },
    ],
  };
}

describe("deterministic social-control arms", () => {
  it("keeps OFF and ON-but-ignored behavior identical for every frozen profile", async () => {
    for (const profile of [
      "keeper",
      "defector",
      "skeptic",
      "deal-blind",
    ] as const) {
      const legalActions = [PROPOSE_NAP, HOLD, EXPAND];
      const off = await choose({ profile, arm: "off", legalActions });
      const ignored = await choose({ profile, arm: "ignored", legalActions });
      expect(off.selectedLegalActionId).toBe(EXPAND.id);
      expect(ignored.selectedLegalActionId).toBe(EXPAND.id);
      expect(off.selectedDealActionId).toBeUndefined();
      expect(ignored.selectedDealActionId).toBeUndefined();
      expect(off).toEqual(ignored);
    }
  });

  it("keeper accepts an offered promise without displacing the game action", async () => {
    const offer = proposal();
    const actions = [HOLD, ...responseActions(offer), EXPAND];
    const decision = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: actions,
      observation: {
        ownState: { playerID: "P_ME" },
        deals: { incomingProposals: [offer], activeDeals: [] },
      },
    });
    expect(decision.selectedLegalActionId).toBe(EXPAND.id);
    expect(decision.selectedDealActionId).toBe(`deal_accept:${offer.dealID}`);
    expect(actions.map((action) => action.id)).toContain(
      decision.selectedDealActionId,
    );
  });

  it("keeper filters accidental pact violations and fulfills explicit support", async () => {
    const attackPartner = {
      id: "attack:P_OTHER:40",
      kind: "attack",
      label: "Attack Other",
      risk: { level: "medium" },
      metadata: {
        targetID: "P_OTHER",
        expansion: false,
        troopPercentage: 0.4,
      },
    };
    const pactDecision = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: [attackPartner, EXPAND, HOLD],
      observation: {
        ownState: { playerID: "P_ME" },
        deals: {
          decisionStep: 4,
          incomingProposals: [],
          activeDeals: [activeDeal({})],
        },
      },
    });
    expect(pactDecision.selectedLegalActionId).toBe(EXPAND.id);

    const donate = {
      id: "donate_gold:P_OTHER:150000",
      kind: "donate_gold",
      label: "Donate gold",
      risk: { level: "low" },
      metadata: { recipientID: "P_OTHER", gold: 150_000 },
    };
    const supportDecision = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: [EXPAND, HOLD, donate],
      observation: {
        ownState: { playerID: "P_ME" },
        deals: {
          decisionStep: 4,
          incomingProposals: [],
          activeDeals: [
            activeDeal({
              template: "support_request",
              obligationKind: "send_support",
            }),
          ],
        },
      },
    });
    expect(supportDecision.selectedLegalActionId).toBe(donate.id);
  });

  it("keeper fulfills an attack pledge with offered above-threshold pressure", async () => {
    const attackTarget = {
      id: "attack:P_TARGET:40",
      kind: "attack",
      label: "Attack Target",
      risk: { level: "medium" },
      metadata: {
        targetID: "P_TARGET",
        expansion: false,
        troopPercentage: 0.4,
      },
    };
    const decision = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: [EXPAND, attackTarget, HOLD],
      observation: {
        ownState: { playerID: "P_ME" },
        deals: {
          decisionStep: 5,
          incomingProposals: [],
          activeDeals: [
            activeDeal({
              template: "joint_attack",
              obligationKind: "confirmed_attack_on_target",
              targetPlayerID: "P_TARGET",
            }),
          ],
        },
      },
    });
    expect(decision.selectedLegalActionId).toBe(attackTarget.id);
  });

  it("defector deliberately violates an active pact from the first judged step", async () => {
    const attackPartner = {
      id: "attack:P_OTHER:25",
      kind: "attack",
      label: "Attack Other",
      risk: { level: "medium" },
      metadata: {
        targetID: "P_OTHER",
        expansion: false,
        troopPercentage: 0.25,
      },
    };
    const decision = await choose({
      profile: "defector",
      arm: "active",
      legalActions: [EXPAND, HOLD, attackPartner],
      observation: {
        ownState: { playerID: "P_ME" },
        deals: {
          decisionStep: 3,
          incomingProposals: [],
          activeDeals: [activeDeal({})],
        },
      },
    });
    expect(decision.selectedLegalActionId).toBe(attackPartner.id);
    expect(decision.reason).toContain("intentionally breaks");
  });

  it("skeptic rejects while deal-blind omits the optional slot", async () => {
    const offer = proposal("support_request");
    const actions = [...responseActions(offer), EXPAND, HOLD, PROPOSE_NAP];
    const observation = {
      ownState: { playerID: "P_ME" },
      deals: { incomingProposals: [offer], activeDeals: [] },
    };
    const skeptic = await choose({
      profile: "skeptic",
      arm: "active",
      legalActions: actions,
      observation,
    });
    const blind = await choose({
      profile: "deal-blind",
      arm: "active",
      legalActions: actions,
      observation,
    });
    expect(skeptic.selectedDealActionId).toBe(`deal_reject:${offer.dealID}`);
    expect(blind.selectedDealActionId).toBeUndefined();
    expect(skeptic.selectedLegalActionId).toBe(EXPAND.id);
    expect(blind.selectedLegalActionId).toBe(EXPAND.id);
  });

  it("is deterministic under offered-menu permutation and never returns an off-menu id", async () => {
    const actions = [HOLD, PROPOSE_NAP, EXPAND];
    const a = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: actions,
    });
    const b = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: [...actions].reverse(),
    });
    expect(a).toEqual(b);
    const offered = new Set(actions.map((action) => action.id));
    expect(offered.has(a.selectedLegalActionId)).toBe(true);
    expect(offered.has(a.selectedDealActionId ?? "")).toBe(true);
    expect(a.fallbackUsed).toBe(false);
    expect(a.llmPlannerDegraded).toBe(false);
  });

  it("selects ordinary combat before core alliance/chat noise while keeper still filters its pact partner", async () => {
    const attackRival = {
      id: "attack:P_RIVAL:25",
      kind: "attack",
      label: "Attack Rival",
      risk: { level: "medium" },
      metadata: { targetID: "P_RIVAL", expansion: false },
    };
    const alliance = {
      id: "alliance:P_RIVAL",
      kind: "alliance_request",
      label: "Ally Rival",
      risk: { level: "low" },
      metadata: { targetID: "P_RIVAL" },
    };
    const chat = {
      id: "quick_chat:P_RIVAL:help",
      kind: "quick_chat",
      label: "Chat",
      risk: { level: "none" },
      metadata: { targetID: "P_RIVAL" },
    };
    const ordinary = await choose({
      profile: "deal-blind",
      arm: "active",
      legalActions: [chat, alliance, HOLD, attackRival],
    });
    expect(ordinary.selectedLegalActionId).toBe(attackRival.id);

    const keeper = await choose({
      profile: "keeper",
      arm: "active",
      legalActions: [chat, alliance, HOLD, attackRival],
      observation: {
        ownState: { playerID: "P_ME" },
        deals: {
          decisionStep: 4,
          incomingProposals: [],
          activeDeals: [
            {
              ...activeDeal({}),
              recipientPlayerID: "P_RIVAL",
            },
          ],
        },
      },
    });
    expect(keeper.selectedLegalActionId).toBe(HOLD.id);
  });

  it("gives the immutable build stamp precedence over hosted argv/env overrides", async () => {
    const { resolveSocialControlConfig } = await policyModule();
    expect(
      resolveSocialControlConfig({
        builtConfig: { profile: "keeper", arm: "active" },
        argv: ["defector", "off"],
        env: {
          PROXYWAR_SOCIAL_CONTROL_POLICY: "skeptic",
          PROXYWAR_SOCIAL_CONTROL_ARM: "ignored",
        },
      }),
    ).toEqual({ profile: "keeper", arm: "active", source: "build" });
  });
});

describe("active deal contract surfaces", () => {
  it("documents the enabled optional slot and accurate one-sided attack-pledge semantics", async () => {
    const files = [
      "coworld-adapter/ENTER_THE_LEAGUE.md",
      "coworld-adapter/docs/player-protocol.md",
      "coworld-adapter/coworld/coworld_manifest.json",
      "coworld-adapter/tester-starter-llm/README.md",
      "coworld-adapter/tester-starter-llm/ONBOARDING.md",
    ];
    const contents = await Promise.all(
      files.map((file) => fs.readFile(path.join(process.cwd(), file), "utf8")),
    );
    for (const content of contents.slice(0, 3)) {
      expect(content).not.toContain("inert on every match today");
      expect(content).toContain("selectedDealActionId");
    }
    expect(contents[1]).toContain("attack pledge");
    expect(contents[1]).toContain("The proposer only");
    expect(contents[3]).toContain("chooseDealMove");
    expect(contents[4]).toContain("chooseDealMove");

    const manifest = JSON.parse(contents[2]) as {
      game: { runnable: { env: Record<string, string> } };
    };
    expect(manifest.game.runnable.env.PROXYWAR_TUNE_STRUCTURED_DEALS).toBe("1");
  });
});
