import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Public LLM starter deal policy. The module opens a WebSocket at import time,
 * so these tests extract and execute its pure selection functions.
 */
const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

async function loadBuildState(): Promise<
  (obs: unknown, actions: unknown[]) => Record<string, unknown>
> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  return new Function(
    `function avoidActionIDs() { return []; }
     ${extractFunction(source, "clean")}
     ${extractFunction(source, "cleanID")}
     ${extractFunction(source, "buildState")}
     return buildState;`,
  )() as (obs: unknown, actions: unknown[]) => Record<string, unknown>;
}

type ChooseFn = (
  plan: unknown,
  actions: unknown[],
  obs: unknown,
) => { id: string; kind: string } | undefined | null;

async function loadSelectors(): Promise<{
  choose: ChooseFn;
  dealMove: ChooseFn;
  socialNote: (
    plan: unknown,
    chosen: unknown,
    dealMove: unknown,
    obs: unknown,
  ) => string;
}> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const order = source.match(/const DEFAULT_ORDER = \[[\s\S]*?\];/)?.[0];
  const retry = source.match(/const DEAL_PROPOSAL_RETRY_STEPS = \d+;/)?.[0];
  const maxAttempts = source.match(
    /const DEAL_PROPOSAL_MAX_ATTEMPTS_PER_KEY = \d+;/,
  )?.[0];
  const attempts = source.match(/const proposalAttempts = new Map\(\);/)?.[0];
  expect(order).toBeDefined();
  expect(retry).toBeDefined();
  expect(maxAttempts).toBeDefined();
  expect(attempts).toBeDefined();
  return new Function(
    `${order}
     ${retry}
     ${maxAttempts}
     ${attempts}
     const history = [];
     function avoidActionIDs() { return []; }
     let plan = null;
     ${extractFunction(source, "clean")}
     ${extractFunction(source, "cleanID")}
     ${extractFunction(source, "dealConstraints")}
     ${extractFunction(source, "hasOpenDeal")}
     ${extractFunction(source, "dealPolicyFor")}
     ${extractFunction(source, "chooseDealMove")}
     ${extractFunction(source, "chooseObligationMove")}
     ${extractFunction(source, "socialActionNote")}
     ${extractFunction(source, "choose")}
     return {
       choose: (p, actions, obs) => { plan = p; return choose(actions, obs); },
       dealMove: (p, actions, obs) => { plan = p; return chooseDealMove(actions, obs); },
       socialNote: (p, chosen, dealMove, obs) => {
         plan = p;
         return socialActionNote(chosen, dealMove, obs);
       },
     };`,
  )() as {
    choose: ChooseFn;
    dealMove: ChooseFn;
    socialNote: (
      plan: unknown,
      chosen: unknown,
      dealMove: unknown,
      obs: unknown,
    ) => string;
  };
}

const BASE_PLAN = {
  focus: "expand",
  preferKinds: [],
  target: null,
  avoidTargets: [],
  dealPolicies: [],
  breakDealIDs: [],
};

const BASE_OBS = {
  phase: "active",
  ownState: {
    playerID: "P_ME",
    name: "Me",
    tileShare: 0.12,
    troops: 50_000,
    troopRatio: 0.4,
    gold: "1000000",
    borderTiles: 40,
    incomingAttacks: 0,
    units: { City: 1 },
  },
  visiblePlayers: [
    {
      playerID: "P_A",
      name: "Auri",
      isAlive: true,
      tileShare: 0.2,
      relativeTroopRatio: 1.2,
      sharesBorder: true,
      isAllied: false,
      relation: 1,
      canAttack: true,
    },
    {
      playerID: "P_S",
      name: "Sefirot",
      isAlive: true,
      tileShare: 0.3,
      relativeTroopRatio: 0.8,
      sharesBorder: true,
      isAllied: false,
      relation: 1,
      canAttack: true,
    },
  ],
};

const HOLD = {
  id: "hold",
  kind: "hold",
  label: "Hold",
  risk: { level: "none" },
};
const EXPAND = {
  id: "expand:terra-nullius:10",
  kind: "attack",
  label: "Expand into neutral land with 10% troops",
  risk: { level: "low" },
  metadata: { targetID: null, expansion: true },
};

function incomingProposal(
  dealID: string,
  proposerPlayerID: string,
  proposerName: string,
  template = "non_aggression_pact",
) {
  return {
    dealID,
    proposerPlayerID,
    proposerName,
    recipientPlayerID: "P_ME",
    recipientName: "Me",
    terms: { template, durationSteps: 12 },
    proposedAtStep: 1,
    answerableThroughStep: 5,
  };
}

function responseActions(dealID: string) {
  return [
    {
      id: `deal_accept:${dealID}`,
      kind: "deal_accept",
      label: "Accept deal",
      risk: { level: "medium" },
      metadata: { dealID },
    },
    {
      id: `deal_reject:${dealID}`,
      kind: "deal_reject",
      label: "Reject deal",
      risk: { level: "none" },
      metadata: { dealID },
    },
  ];
}

function proposalOption(
  recipientPlayerID: string,
  template: string,
  terms: Record<string, unknown> = {},
) {
  return {
    recipientPlayerID,
    recipientName: recipientPlayerID === "P_A" ? "Auri" : "Sefirot",
    terms: { template, durationSteps: 12, ...terms },
  };
}

function proposalAction(recipientPlayerID: string, template: string) {
  return {
    id: `deal_propose:${recipientPlayerID}:${template}`,
    kind: "deal_propose",
    label: `Propose ${template} to ${recipientPlayerID}`,
    risk: { level: "low" },
    metadata: { recipientID: recipientPlayerID, template },
  };
}

describe("tester-starter-llm bounded deal state", () => {
  it("is byte-compatible when deals are absent", async () => {
    const buildState = await loadBuildState();
    const state = buildState(BASE_OBS, [HOLD]);
    expect("deals" in state).toBe(false);
    expect((state.rivals as Array<{ playerID?: string }>)[0].playerID).toBe(
      undefined,
    );
  });

  it("preserves exact counterparties, obligations, terms, options, and reliability", async () => {
    const buildState = await loadBuildState();
    const withoutDeals = buildState(BASE_OBS, [HOLD]);
    const withDeals = buildState(
      {
        ...BASE_OBS,
        deals: {
          decisionStep: 4,
          incomingProposals: [
            {
              ...incomingProposal("D1", "P_A", "Auri", "support_request"),
              terms: {
                template: "support_request",
                durationSteps: 6,
                goldAmount: "150000",
                troopAmount: 20000,
              },
            },
          ],
          outgoingProposals: [],
          activeDeals: [
            {
              dealID: "D2",
              template: "joint_attack",
              proposerPlayerID: "P_ME",
              proposerName: "Me",
              recipientPlayerID: "P_A",
              recipientName: "Auri",
              stepsRemaining: 4,
              obligations: [
                {
                  obligorPlayerID: "P_ME",
                  status: "pending",
                  kind: "confirmed_attack_on_target",
                  targetPlayerID: "P_S",
                  targetName: "Sefirot",
                },
              ],
            },
          ],
          proposalOptions: [
            {
              recipientPlayerID: "P_S",
              recipientName: "Sefirot",
              terms: {
                template: "support_request",
                durationSteps: 6,
                goldAmount: "150000",
                troopAmount: 20000,
              },
            },
          ],
          rivalReliability: [
            {
              playerID: "P_A",
              name: "Auri",
              fulfilled: 2,
              terminalNonMoot: 3,
              reliability: 0.67,
            },
          ],
        },
      },
      [HOLD],
    );
    const deals = withDeals.deals as {
      counterparties: Array<Record<string, unknown>>;
      incoming: Array<Record<string, unknown>>;
      active: Array<Record<string, unknown>>;
      proposalOptions: Array<Record<string, unknown>>;
      reliability: Array<Record<string, unknown>>;
    };
    expect(deals.counterparties).toContainEqual({
      playerID: "P_A",
      name: "Auri",
    });
    expect(deals.incoming[0]).toMatchObject({
      id: "D1",
      fromID: "P_A",
      template: "support_request",
      gold: "150000",
      troops: 20000,
    });
    expect(deals.active[0]).toMatchObject({
      id: "D2",
      withID: "P_A",
      template: "joint_attack",
      owe: [{ kind: "confirmed_attack_on_target", targetID: "P_S" }],
    });
    expect(deals.proposalOptions[0]).toMatchObject({
      toID: "P_S",
      template: "support_request",
      duration: 6,
      gold: "150000",
      troops: 20000,
    });
    expect(deals.reliability[0]).toMatchObject({
      playerID: "P_A",
      kept: 2,
      judged: 3,
      rate: 0.67,
    });
    expect(JSON.stringify(deals).length).toBeLessThan(2500);
    const { deals: _deals, ...rest } = withDeals;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(withoutDeals));
  });

  it("keeps stable counterparty IDs visible during an empty proposal cooldown", async () => {
    const buildState = await loadBuildState();
    const state = buildState(
      {
        ...BASE_OBS,
        deals: {
          decisionStep: 4,
          incomingProposals: [],
          outgoingProposals: [],
          activeDeals: [],
          proposalOptions: [],
          rivalReliability: [],
        },
      },
      [HOLD],
    );
    expect(state.deals).toMatchObject({
      step: 4,
      counterparties: [
        { playerID: "P_A", name: "Auri" },
        { playerID: "P_S", name: "Sefirot" },
      ],
      incoming: [],
      active: [],
      outgoing: [],
      reliability: [],
      proposalOptions: [],
    });
  });
});

describe("tester-starter-llm deal selection", () => {
  it("keeps exact game and deal selections in separate slots", async () => {
    const source = await fs.readFile(STARTER_FILE, "utf8");
    expect(source).toContain("const chosen = choose(actions, obs);");
    expect(source).toContain("const dealMove = chooseDealMove(actions, obs);");
    expect(source).toContain("selectedLegalActionId: chosen.id,");
    expect(source).toContain(
      "...(dealMove ? { selectedDealActionId: dealMove.id } : {}),",
    );
    expect(source).toContain('"dealPolicies"');
    expect(source).toContain('"breakDealIDs"');
    expect(source).not.toContain('"deal":"<accept|decline');

    const { choose, dealMove } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [incomingProposal("D1", "P_A", "Auri")],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [],
      },
    };
    const plan = {
      ...BASE_PLAN,
      dealPolicies: [
        {
          playerID: "P_A",
          acceptTemplates: ["non_aggression_pact"],
          proposeTemplates: [],
        },
      ],
    };
    const actions = [...responseActions("D1"), EXPAND, HOLD];
    expect(dealMove(plan, actions, obs)?.id).toBe("deal_accept:D1");
    expect(choose(plan, actions, obs)?.id).toBe(EXPAND.id);
  });

  it("opens one bounded exact-ID alliance path so support can become legal", async () => {
    const { choose } = await loadSelectors();
    const alliance = {
      id: "alliance:P_A",
      kind: "alliance_request",
      label: "Request alliance with Auri",
      risk: { level: "low", score: 0.2 },
      metadata: { recipientID: "P_A", recipientName: "Auri" },
    };
    const obsAt = (step: number, friendly = false) => ({
      ...BASE_OBS,
      visiblePlayers: BASE_OBS.visiblePlayers.map((player) =>
        player.playerID === "P_A"
          ? { ...player, isFriendly: friendly }
          : { ...player, isFriendly: true },
      ),
      deals: {
        decisionStep: step,
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [],
      },
    });

    expect(choose(BASE_PLAN, [EXPAND, alliance, HOLD], obsAt(1))?.id).toBe(
      alliance.id,
    );
    expect(
      choose(BASE_PLAN, [EXPAND, alliance, HOLD], obsAt(2, true))?.id,
    ).toBe(EXPAND.id);
    expect(choose(BASE_PLAN, [EXPAND, alliance, HOLD], obsAt(2))?.id).toBe(
      EXPAND.id,
    );
    expect(choose(BASE_PLAN, [EXPAND, alliance, HOLD], obsAt(61))?.id).toBe(
      alliance.id,
    );
    expect(choose(BASE_PLAN, [EXPAND, alliance, HOLD], obsAt(121))?.id).toBe(
      EXPAND.id,
    );
  });

  it("answers by stable counterparty ID and defaults unknown or unsupported offers to rejection", async () => {
    const { dealMove } = await loadSelectors();
    const plan = {
      ...BASE_PLAN,
      dealPolicies: [
        {
          playerID: "P_A",
          acceptTemplates: ["non_aggression_pact"],
          proposeTemplates: [],
        },
        {
          playerID: "P_S",
          acceptTemplates: ["trade_security_pact"],
          proposeTemplates: [],
        },
      ],
    };
    const auri = incomingProposal("D1", "P_A", "Same Name");
    const sefirot = incomingProposal("D2", "P_S", "Same Name");
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [auri, sefirot],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [],
      },
    };
    const actions = [...responseActions("D1"), ...responseActions("D2"), HOLD];
    expect(dealMove(plan, actions, obs)?.id).toBe("deal_accept:D1");
    expect(
      dealMove(plan, actions, {
        ...obs,
        deals: { ...obs.deals, incomingProposals: [sefirot] },
      })?.id,
    ).toBe("deal_reject:D2");

    const unknown = incomingProposal(
      "D3",
      "P_UNKNOWN",
      "Unknown",
      "support_request",
    );
    expect(
      dealMove(plan, [...responseActions("D3"), HOLD], {
        ...obs,
        deals: { ...obs.deals, incomingProposals: [unknown] },
      })?.id,
    ).toBe("deal_reject:D3");
  });

  it("accepts support from a friendly partner only when current reserves can cover the cumulative threshold", async () => {
    const { dealMove } = await loadSelectors();
    const support = {
      ...incomingProposal("SUPPORT", "P_A", "Auri", "support_request"),
      terms: {
        template: "support_request",
        durationSteps: 6,
        goldAmount: "150000",
        troopAmount: 20000,
      },
    };
    const donateGold = {
      id: "donate_gold:P_A",
      kind: "donate_gold",
      label: "Donate gold to Auri",
      risk: { level: "low" },
      metadata: { recipientID: "P_A", gold: 100000 },
    };
    const obs = {
      ...BASE_OBS,
      visiblePlayers: BASE_OBS.visiblePlayers.map((player) =>
        player.playerID === "P_A" ? { ...player, isFriendly: true } : player,
      ),
      deals: {
        decisionStep: 3,
        incomingProposals: [support],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [],
      },
    };
    const actions = [...responseActions("SUPPORT"), donateGold, HOLD];
    expect(dealMove(BASE_PLAN, actions, obs)?.id).toBe("deal_accept:SUPPORT");
    expect(
      dealMove(BASE_PLAN, [...responseActions("SUPPORT"), donateGold, HOLD], {
        ...obs,
        ownState: { ...BASE_OBS.ownState, gold: "100000", troops: 10000 },
      })?.id,
    ).toBe("deal_reject:SUPPORT");
    expect(
      dealMove(BASE_PLAN, actions, {
        ...obs,
        visiblePlayers: BASE_OBS.visiblePlayers,
      })?.id,
    ).toBe("deal_reject:SUPPORT");
  });

  it("matches exact proposal options and permits only one retry after 60 steps", async () => {
    const { dealMove } = await loadSelectors();
    const napA = proposalAction("P_A", "non_aggression_pact");
    const tradeA = proposalAction("P_A", "trade_security_pact");
    const jointA = proposalAction("P_A", "joint_attack");
    const actions = [napA, tradeA, jointA, EXPAND, HOLD];
    const plan = {
      ...BASE_PLAN,
      dealPolicies: [
        {
          playerID: "P_A",
          acceptTemplates: [],
          proposeTemplates: [
            "non_aggression_pact",
            "trade_security_pact",
            "joint_attack",
          ],
        },
      ],
    };
    const obsAt = (step: number, options: unknown[]) => ({
      ...BASE_OBS,
      deals: {
        decisionStep: step,
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: options,
      },
    });

    expect(
      dealMove(
        plan,
        actions,
        obsAt(1, [proposalOption("P_S", "non_aggression_pact")]),
      ),
    ).toBeNull();
    expect(
      dealMove(
        plan,
        actions,
        obsAt(1, [proposalOption("P_A", "non_aggression_pact")]),
      )?.id,
    ).toBe(napA.id);
    expect(
      dealMove(
        plan,
        actions,
        obsAt(4, [proposalOption("P_A", "non_aggression_pact")]),
      ),
    ).toBeNull();
    expect(
      dealMove(
        plan,
        actions,
        obsAt(4, [proposalOption("P_A", "trade_security_pact")]),
      )?.id,
    ).toBe(tradeA.id);
    expect(
      dealMove(
        plan,
        actions,
        obsAt(61, [proposalOption("P_A", "non_aggression_pact")]),
      )?.id,
    ).toBe(napA.id);
    expect(
      dealMove(
        plan,
        actions,
        obsAt(121, [proposalOption("P_A", "non_aggression_pact")]),
      ),
    ).toBeNull();

    expect(
      dealMove(
        plan,
        actions,
        obsAt(5, [
          proposalOption("P_A", "joint_attack", { targetPlayerID: "P_X" }),
        ]),
      )?.id,
    ).toBe(jointA.id);
    expect(
      dealMove(
        plan,
        actions,
        obsAt(65, [
          proposalOption("P_A", "joint_attack", { targetPlayerID: "P_Y" }),
        ]),
      )?.id,
    ).toBe(jointA.id);
    expect(
      dealMove(
        plan,
        actions,
        obsAt(125, [
          proposalOption("P_A", "joint_attack", { targetPlayerID: "P_Z" }),
        ]),
      ),
    ).toBeNull();
  });

  it("fails closed on retries when the decision clock is missing", async () => {
    const { dealMove } = await loadSelectors();
    const plan = {
      ...BASE_PLAN,
      dealPolicies: [
        {
          playerID: "P_A",
          acceptTemplates: [],
          proposeTemplates: ["non_aggression_pact"],
        },
      ],
    };
    const action = proposalAction("P_A", "non_aggression_pact");
    const observation = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [proposalOption("P_A", "non_aggression_pact")],
      },
    };
    expect(dealMove(plan, [action, EXPAND, HOLD], observation)?.id).toBe(
      action.id,
    );
    expect(dealMove(plan, [action, EXPAND, HOLD], observation)).toBeNull();
  });

  it("never duplicates an outgoing or active recipient/template deal", async () => {
    const plan = {
      ...BASE_PLAN,
      dealPolicies: [
        {
          playerID: "P_A",
          acceptTemplates: [],
          proposeTemplates: ["non_aggression_pact"],
        },
      ],
    };
    const action = proposalAction("P_A", "non_aggression_pact");

    for (const open of ["outgoing", "active"] as const) {
      const { dealMove } = await loadSelectors();
      const outgoingProposals =
        open === "outgoing"
          ? [
              {
                recipientPlayerID: "P_A",
                terms: { template: "non_aggression_pact" },
              },
            ]
          : [];
      const activeDeals =
        open === "active"
          ? [
              {
                proposerPlayerID: "P_ME",
                recipientPlayerID: "P_A",
                template: "non_aggression_pact",
              },
            ]
          : [];
      expect(
        dealMove(plan, [action, EXPAND, HOLD], {
          ...BASE_OBS,
          deals: {
            decisionStep: 20,
            incomingProposals: [],
            outgoingProposals,
            activeDeals,
            proposalOptions: [proposalOption("P_A", "non_aggression_pact")],
          },
        }),
      ).toBeNull();
    }
  });

  it("answers incoming proposals before making another proposal", async () => {
    const { dealMove } = await loadSelectors();
    const plan = {
      ...BASE_PLAN,
      dealPolicies: [
        {
          playerID: "P_A",
          acceptTemplates: [],
          proposeTemplates: ["non_aggression_pact"],
        },
      ],
    };
    const obs = {
      ...BASE_OBS,
      deals: {
        decisionStep: 1,
        incomingProposals: [incomingProposal("D1", "P_S", "Sefirot")],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [proposalOption("P_A", "non_aggression_pact")],
      },
    };
    expect(
      dealMove(
        plan,
        [
          ...responseActions("D1"),
          proposalAction("P_A", "non_aggression_pact"),
        ],
        obs,
      )?.id,
    ).toBe("deal_reject:D1");
  });

  it("does not let a duplicate display name suppress a stable-ID proposal", async () => {
    const { dealMove } = await loadSelectors();
    const action = proposalAction("P_A", "non_aggression_pact");
    const obs = {
      ...BASE_OBS,
      visiblePlayers: BASE_OBS.visiblePlayers.map((player) => ({
        ...player,
        name: "Same Name",
      })),
      deals: {
        decisionStep: 1,
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [],
        proposalOptions: [proposalOption("P_A", "non_aggression_pact")],
      },
    };
    expect(
      dealMove(
        {
          ...BASE_PLAN,
          target: "Same Name",
          dealPolicies: [
            {
              playerID: "P_A",
              acceptTemplates: [],
              proposeTemplates: ["non_aggression_pact"],
            },
          ],
        },
        [action, HOLD],
        obs,
      )?.id,
    ).toBe(action.id);
  });

  it("uses the one response slot for the earliest-expiring offer", async () => {
    const { dealMove } = await loadSelectors();
    const later = incomingProposal("D1", "P_A", "Auri");
    const urgent = {
      ...incomingProposal("D2", "P_S", "Sefirot"),
      answerableThroughStep: 3,
    };
    expect(
      dealMove(
        BASE_PLAN,
        [...responseActions("D1"), ...responseActions("D2"), HOLD],
        {
          ...BASE_OBS,
          deals: {
            incomingProposals: [later, urgent],
            outgoingProposals: [],
            activeDeals: [],
            proposalOptions: [],
          },
        },
      )?.id,
    ).toBe("deal_reject:D2");
  });
});

describe("tester-starter-llm obligation execution", () => {
  it("prioritizes partial support progress to the exact requesting counterparty", async () => {
    const { choose } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        proposalOptions: [],
        activeDeals: [
          {
            dealID: "SUPPORT",
            template: "support_request",
            proposerPlayerID: "P_A",
            proposerName: "Auri",
            recipientPlayerID: "P_ME",
            recipientName: "Me",
            stepsRemaining: 4,
            obligations: [
              {
                obligorPlayerID: "P_ME",
                status: "pending",
                kind: "send_support",
                goldAmount: "150000",
                troopAmount: 20000,
                donatedGold: "50000",
                donatedTroops: 0,
              },
            ],
          },
        ],
      },
    };
    const donateA = {
      id: "donate_gold:P_A",
      kind: "donate_gold",
      label: "Donate gold to Auri",
      risk: { level: "low" },
      metadata: { recipientID: "P_A", gold: 100000 },
    };
    const donateS = {
      ...donateA,
      id: "donate_gold:P_S",
      metadata: { recipientID: "P_S", gold: 100000 },
    };
    expect(choose(BASE_PLAN, [donateS, EXPAND, donateA, HOLD], obs)?.id).toBe(
      donateA.id,
    );
    const partialGold = {
      ...donateA,
      metadata: { recipientID: "P_A", gold: 50000 },
    };
    const completingTroops = {
      id: "donate_troops:P_A",
      kind: "donate_troops",
      label: "Donate troops to Auri",
      risk: { level: "medium" },
      metadata: { recipientID: "P_A", troops: 30000 },
    };
    expect(
      choose(BASE_PLAN, [partialGold, EXPAND, completingTroops, HOLD], obs)?.id,
    ).toBe(completingTroops.id);
    expect(
      choose(
        { ...BASE_PLAN, breakDealIDs: ["SUPPORT"] },
        [donateA, EXPAND, HOLD],
        obs,
      )?.id,
    ).toBe(EXPAND.id);

    const complete = {
      ...obs,
      deals: {
        ...obs.deals,
        activeDeals: [
          {
            ...obs.deals.activeDeals[0],
            obligations: [
              {
                ...obs.deals.activeDeals[0].obligations[0],
                donatedTroops: 20000,
              },
            ],
          },
        ],
      },
    };
    expect(choose(BASE_PLAN, [donateA, EXPAND, HOLD], complete)?.id).toBe(
      EXPAND.id,
    );
  });

  it("fulfills only its own pending joint-attack pledge with qualifying pressure", async () => {
    const { choose } = await loadSelectors();
    const attack = (pct: number) => ({
      id: `attack:P_S:${pct}`,
      kind: "attack",
      label: `Attack Sefirot with ${pct}% troops`,
      risk: { level: "medium" },
      metadata: {
        targetID: "P_S",
        expansion: false,
        troopPercentage: pct / 100,
      },
    });
    const active = (obligorPlayerID: string, status = "pending") => ({
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        proposalOptions: [],
        activeDeals: [
          {
            dealID: "ATTACK",
            template: "joint_attack",
            proposerPlayerID: obligorPlayerID,
            proposerName: obligorPlayerID === "P_ME" ? "Me" : "Auri",
            recipientPlayerID: obligorPlayerID === "P_ME" ? "P_A" : "P_ME",
            recipientName: obligorPlayerID === "P_ME" ? "Auri" : "Me",
            stepsRemaining: 3,
            obligations: [
              {
                obligorPlayerID,
                status,
                kind: "confirmed_attack_on_target",
                targetPlayerID: "P_S",
                targetName: "Sefirot",
              },
            ],
          },
        ],
      },
    });
    expect(
      choose(
        BASE_PLAN,
        [attack(10), attack(40), attack(20), EXPAND],
        active("P_ME"),
      )?.id,
    ).toBe(attack(20).id);
    const nuke = {
      id: "nuke:P_S:AtomBomb",
      kind: "nuke",
      label: "Launch Atom Bomb at Sefirot",
      risk: { level: "high" },
      metadata: { targetID: "P_S" },
    };
    expect(choose(BASE_PLAN, [nuke, EXPAND], active("P_ME"))?.id).toBe(
      EXPAND.id,
    );
    expect(
      choose(
        { ...BASE_PLAN, preferKinds: ["nuke"], target: "Auri" },
        [nuke, EXPAND],
        active("P_ME"),
      )?.id,
    ).toBe(EXPAND.id);
    expect(
      choose(
        { ...BASE_PLAN, preferKinds: ["nuke"], target: "Sefirot" },
        [nuke, EXPAND],
        active("P_ME"),
      )?.id,
    ).toBe(nuke.id);
    expect(
      choose(BASE_PLAN, [EXPAND, attack(20), HOLD], active("P_A"))?.id,
    ).toBe(EXPAND.id);
    expect(
      choose(BASE_PLAN, [EXPAND, attack(20), HOLD], active("P_ME", "moot"))?.id,
    ).toBe(EXPAND.id);
  });
});

describe("tester-starter-llm social reason evidence", () => {
  it("reports actual fulfillment ahead of a stale break intent", async () => {
    const { socialNote } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        activeDeals: [
          {
            dealID: "SUPPORT",
            template: "support_request",
            proposerPlayerID: "P_A",
            recipientPlayerID: "P_ME",
            obligations: [
              {
                obligorPlayerID: "P_ME",
                status: "pending",
                kind: "send_support",
              },
            ],
          },
        ],
      },
    };
    const donate = {
      id: "donate_gold:P_A",
      kind: "donate_gold",
      label: "Donate gold to Auri",
      metadata: { recipientID: "P_A", gold: 100000 },
    };
    const plan = { ...BASE_PLAN, breakDealIDs: ["SUPPORT"] };
    expect(socialNote(plan, donate, null, obs)).toBe(
      "fulfil support promise SUPPORT",
    );
    expect(socialNote(plan, EXPAND, null, obs)).toBe(
      "intentional non-fulfilment SUPPORT",
    );
  });

  it("labels only referee-relevant pact violations as intentional breach", async () => {
    const { socialNote } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        activeDeals: [
          {
            dealID: "PACT",
            template: "trade_security_pact",
            proposerPlayerID: "P_ME",
            recipientPlayerID: "P_S",
            obligations: [
              {
                obligorPlayerID: "P_ME",
                status: "pending",
                kind: "trade_security",
              },
            ],
          },
        ],
      },
    };
    const plan = { ...BASE_PLAN, breakDealIDs: ["PACT"] };
    const allianceRequest = {
      id: "alliance_request:P_S",
      kind: "alliance_request",
      label: "Request alliance with Sefirot",
      metadata: { targetID: "P_S" },
    };
    const attack = {
      id: "attack:P_S:25",
      kind: "attack",
      label: "Attack Sefirot",
      metadata: { targetID: "P_S", expansion: false },
    };
    const embargo = {
      id: "embargo:P_S:start",
      kind: "embargo",
      label: "Embargo Sefirot",
      metadata: { targetID: "P_S", action: "start" },
    };
    const boat = {
      id: "boat:P_S:25",
      kind: "boat",
      label: "Launch transport toward Sefirot",
      metadata: { targetID: "P_S" },
    };
    expect(socialNote(plan, allianceRequest, null, obs)).toBe("");
    expect(socialNote(plan, attack, null, obs)).toBe("intentional breach PACT");
    expect(socialNote(plan, embargo, null, obs)).toBe(
      "intentional breach PACT",
    );
    expect(socialNote(plan, boat, null, obs)).toBe("intentional breach PACT");
  });
});

describe("tester-starter-llm explicit breach authority", () => {
  it("requires every exact active dealID; target names and wrong IDs do nothing", async () => {
    const { choose } = await loadSelectors();
    const pact = (dealID: string, template = "non_aggression_pact") => ({
      dealID,
      template,
      proposerPlayerID: "P_ME",
      proposerName: "Me",
      recipientPlayerID: "P_S",
      recipientName: "Sefirot",
      stepsRemaining: 8,
      obligations: [
        { obligorPlayerID: "P_ME", status: "pending" },
        { obligorPlayerID: "P_S", status: "pending" },
      ],
    });
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        proposalOptions: [],
        activeDeals: [pact("D4"), pact("D5")],
      },
    };
    const attackPartner = {
      id: "attack:P_S:25",
      kind: "attack",
      label: "Attack Sefirot with 25% troops",
      risk: { level: "medium" },
      metadata: { targetID: "P_S", targetName: "Sefirot" },
    };
    const actions = [attackPartner, EXPAND, HOLD];
    expect(choose({ ...BASE_PLAN, target: "Sefirot" }, actions, obs)?.id).toBe(
      EXPAND.id,
    );
    expect(
      choose({ ...BASE_PLAN, breakDealIDs: ["WRONG"] }, actions, obs)?.id,
    ).toBe(EXPAND.id);
    expect(
      choose({ ...BASE_PLAN, breakDealIDs: ["D4"] }, actions, obs)?.id,
    ).toBe(EXPAND.id);
    expect(
      choose({ ...BASE_PLAN, breakDealIDs: ["D4", "D5"] }, actions, obs)?.id,
    ).toBe(attackPartner.id);
  });

  it("does not treat terminal obligations as binding", async () => {
    const { choose } = await loadSelectors();
    const attackPartner = {
      id: "attack:P_S:25",
      kind: "attack",
      label: "Attack Sefirot",
      risk: { level: "medium" },
      metadata: { targetID: "P_S" },
    };
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        proposalOptions: [],
        activeDeals: [
          {
            dealID: "D4",
            template: "trade_security_pact",
            proposerPlayerID: "P_ME",
            recipientPlayerID: "P_S",
            obligations: [{ obligorPlayerID: "P_ME", status: "violated" }],
          },
        ],
      },
    };
    expect(choose(BASE_PLAN, [attackPartner, EXPAND], obs)?.id).toBe(
      attackPartner.id,
    );
  });
});
