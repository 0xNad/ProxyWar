import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Phase B starter surface: `buildState` may surface the flag-gated
 * observation `deals` block as ONE compact `deals` line (<= 300 chars,
 * absent => byte-identical state), and the deterministic executor gains a
 * deal posture: auto-reject offers from the plan's target, auto-accept
 * pact offers from avoidTargets or under the "accept" posture, propose one
 * non-aggression pact when focus === "ally", and never violate an accepted
 * pact unless the LLM plan explicitly names the partner as target.
 *
 * Like StarterEconomyState.test.ts, the module opens a WebSocket at import
 * time, so the pure functions (clean/buildState/dealConstraints/
 * chooseDealMove/choose) are extracted from the shipped source text and
 * evaluated standalone.
 */

const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in llm-player.mjs`).toBeGreaterThan(
    -1,
  );
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

async function loadBuildState(): Promise<
  (obs: unknown, actions: unknown[]) => Record<string, unknown>
> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const cleanSrc = extractFunction(source, "clean");
  const buildStateSrc = extractFunction(source, "buildState");
  return new Function(
    `function avoidActionIDs() { return []; }\n${cleanSrc}\n${buildStateSrc}\nreturn buildState;`,
  )() as (obs: unknown, actions: unknown[]) => Record<string, unknown>;
}

type ChooseFn = (
  plan: unknown,
  actions: unknown[],
  obs: unknown,
) => { id: string; kind: string } | undefined;

/**
 * `choose` (the GAME move) and `chooseDealMove` (the deal posture) are now
 * two independent selections: the starter sends the deal in the separate
 * `selectedDealActionId` slot ALONGSIDE the game action, so a pact never
 * costs it a turn. Both are extracted here from the shipped source text.
 */
async function loadSelectors(): Promise<{
  choose: ChooseFn;
  dealMove: ChooseFn;
}> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const orderSrc = source.match(/const DEFAULT_ORDER = \[[\s\S]*?\];/)?.[0];
  expect(orderSrc, "DEFAULT_ORDER not found in llm-player.mjs").toBeDefined();
  const cleanSrc = extractFunction(source, "clean");
  const constraintsSrc = extractFunction(source, "dealConstraints");
  const moveSrc = extractFunction(source, "chooseDealMove");
  const chooseSrc = extractFunction(source, "choose");
  const preamble = `${orderSrc}\nfunction avoidActionIDs() { return []; }\nlet plan = null;\n${cleanSrc}\n${constraintsSrc}\n${moveSrc}\n${chooseSrc}\n`;
  return new Function(
    `${preamble}return {
       choose: (p, actions, obs) => { plan = p; return choose(actions, obs); },
       dealMove: (p, actions, obs) => { plan = p; return chooseDealMove(actions, obs); },
     };`,
  )() as { choose: ChooseFn; dealMove: ChooseFn };
}

async function loadChoose(): Promise<ChooseFn> {
  return (await loadSelectors()).choose;
}

async function loadDealMove(): Promise<ChooseFn> {
  return (await loadSelectors()).dealMove;
}

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
  proposerName: string,
  template = "non_aggression_pact",
) {
  return {
    dealID,
    proposerPlayerID: `P_${proposerName}`,
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
      label: "Accept pact",
      risk: { level: "medium" },
      metadata: { dealID },
    },
    {
      id: `deal_reject:${dealID}`,
      kind: "deal_reject",
      label: "Reject pact",
      risk: { level: "none" },
      metadata: { dealID },
    },
  ];
}

describe("tester-starter-llm buildState deals line", () => {
  it("without a deals block the state has no deals key and stays byte-identical", async () => {
    const buildState = await loadBuildState();
    const state = buildState(BASE_OBS, [HOLD]);
    expect("deals" in state).toBe(false);
  });

  it("with a deals block it adds ONE compact deals line (<= 300 chars) and nothing else", async () => {
    const buildState = await loadBuildState();
    const withoutDeals = buildState(BASE_OBS, [HOLD]);
    const withDeals = buildState(
      {
        ...BASE_OBS,
        deals: {
          decisionStep: 4,
          incomingProposals: [incomingProposal("D1", "Auri")],
          outgoingProposals: [
            incomingProposal("D2", "Me"),
            incomingProposal("D3", "Me"),
          ],
          activeDeals: [
            {
              dealID: "D4",
              template: "non_aggression_pact",
              proposerPlayerID: "P_ME",
              proposerName: "Me",
              recipientPlayerID: "P_S",
              recipientName: "Sefirot",
              stepsRemaining: 8,
              obligations: [],
            },
          ],
          proposalOptions: [],
          rivalReliability: [],
        },
      },
      [HOLD],
    );
    const deals = withDeals.deals as string;
    expect(typeof deals).toBe("string");
    expect(deals.length).toBeLessThanOrEqual(300);
    expect(deals).not.toContain("\n");
    expect(deals).toContain("1 offer in (nap from Auri)");
    expect(deals).toContain("1 active (nap w/ Sefirot, 8 left)");
    expect(deals).toContain("2 out");

    const { deals: _line, ...rest } = withDeals;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(withoutDeals));
  });

  it("an empty deals block adds nothing", async () => {
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
    expect("deals" in state).toBe(false);
    expect(JSON.stringify(state)).toBe(
      JSON.stringify(buildState(BASE_OBS, [HOLD])),
    );
  });
});

describe("tester-starter-llm decision reply shape", () => {
  it("sends the deal in its own slot alongside the game action, and only when there is one", async () => {
    const source = await fs.readFile(STARTER_FILE, "utf8");
    // Both selections are made, independently, on every decision.
    expect(source).toContain("const chosen = choose(actions, obs);");
    expect(source).toContain("const dealMove = chooseDealMove(actions, obs);");
    // The game action is always sent; the deal slot only when one was chosen.
    expect(source).toContain("selectedLegalActionId: chosen.id,");
    expect(source).toContain(
      "...(dealMove ? { selectedDealActionId: dealMove.id } : {}),",
    );
    // Deal kinds are not plannable game kinds any more.
    const planKinds = source.match(/const PLAN_KINDS = \[[\s\S]*?\];/)?.[0];
    expect(planKinds).toBeDefined();
    expect(planKinds).not.toContain("deal_");
  });
});

describe("tester-starter-llm deterministic deal posture", () => {
  it("keeps the deal out of the game slot: the deal move and the game move are separate", async () => {
    const { choose, dealMove } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [incomingProposal("D1", "Auri")],
        outgoingProposals: [],
        activeDeals: [],
      },
    };
    const actions = [...responseActions("D1"), EXPAND, HOLD];
    const plan = { target: null, avoidTargets: [], deal: "accept" };
    // The pact is answered AND the expansion still happens in the same step.
    expect(dealMove(plan, actions, obs)?.id).toBe("deal_accept:D1");
    expect(choose(plan, actions, obs)?.id).toBe(EXPAND.id);
    // `choose` never returns a deal action, whatever the plan asks for.
    expect(
      choose(
        { ...plan, preferKinds: ["deal_accept", "deal_reject"] },
        actions,
        obs,
      )?.id,
    ).toBe(EXPAND.id);
  });

  it("auto-rejects proposals from the plan's current target — even under an accept posture", async () => {
    const dealMove = await loadDealMove();
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [incomingProposal("D1", "Sefirot")],
        outgoingProposals: [],
        activeDeals: [],
      },
    };
    const actions = [...responseActions("D1"), EXPAND, HOLD];
    const chosen = dealMove(
      { target: "Sefirot", avoidTargets: [], deal: "accept" },
      actions,
      obs,
    );
    expect(chosen?.id).toBe("deal_reject:D1");
  });

  it("auto-accepts pact offers from avoidTargets or under the accept posture", async () => {
    const { choose, dealMove } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [incomingProposal("D1", "Auri")],
        outgoingProposals: [],
        activeDeals: [],
      },
    };
    const actions = [...responseActions("D1"), EXPAND, HOLD];
    expect(
      dealMove({ target: null, avoidTargets: ["Auri"] }, actions, obs)?.id,
    ).toBe("deal_accept:D1");
    expect(
      dealMove({ target: null, avoidTargets: [], deal: "accept" }, actions, obs)
        ?.id,
    ).toBe("deal_accept:D1");
    // No posture and not an avoid-target: the offer is left pending, and the
    // game move is unaffected either way.
    expect(
      dealMove({ target: null, avoidTargets: [] }, actions, obs),
    ).toBeFalsy();
    expect(choose({ target: null, avoidTargets: [] }, actions, obs)?.id).toBe(
      EXPAND.id,
    );
  });

  it("never auto-accepts joint-attack or support pledges", async () => {
    const { choose, dealMove } = await loadSelectors();
    const obs = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [
          incomingProposal("D1", "Auri", "joint_attack"),
          incomingProposal("D2", "Auri", "support_request"),
        ],
        outgoingProposals: [],
        activeDeals: [],
      },
    };
    const actions = [...responseActions("D1"), ...responseActions("D2"), HOLD];
    const plan = { target: null, avoidTargets: [], deal: "accept" };
    expect(dealMove(plan, actions, obs)).toBeFalsy();
    expect(choose(plan, actions, obs)?.id).toBe("hold");
  });

  it("proposes ONE non-aggression pact to the strongest non-target neighbor when focus is ally", async () => {
    const { choose, dealMove } = await loadSelectors();
    const proposeAuri = {
      id: "deal_propose:P_A:non_aggression_pact",
      kind: "deal_propose",
      label: "Propose non-aggression pact to Auri",
      risk: { level: "low" },
      metadata: { recipientID: "P_A", template: "non_aggression_pact" },
    };
    const proposeSefirot = {
      id: "deal_propose:P_S:non_aggression_pact",
      kind: "deal_propose",
      label: "Propose non-aggression pact to Sefirot",
      risk: { level: "low" },
      metadata: { recipientID: "P_S", template: "non_aggression_pact" },
    };
    const obs = {
      ...BASE_OBS,
      deals: { incomingProposals: [], outgoingProposals: [], activeDeals: [] },
    };
    const actions = [proposeAuri, proposeSefirot, EXPAND, HOLD];
    // Sefirot is the strongest neighbor but is the plan's target: Auri wins.
    expect(
      dealMove(
        { focus: "ally", target: "Sefirot", avoidTargets: [] },
        actions,
        obs,
      )?.id,
    ).toBe(proposeAuri.id);
    // The offer costs no move: the game action is still the expansion.
    expect(
      choose(
        { focus: "ally", target: "Sefirot", avoidTargets: [] },
        actions,
        obs,
      )?.id,
    ).toBe(EXPAND.id);
    // Strongest neighbor when no target is named.
    expect(
      dealMove({ focus: "ally", target: null, avoidTargets: [] }, actions, obs)
        ?.id,
    ).toBe(proposeSefirot.id);
    // An open proposal to the strongest neighbor moves to the next candidate.
    const withOpen = {
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [
          {
            dealID: "D9",
            proposerPlayerID: "P_ME",
            proposerName: "Me",
            recipientPlayerID: "P_S",
            recipientName: "Sefirot",
            terms: { template: "non_aggression_pact", durationSteps: 12 },
            proposedAtStep: 1,
            answerableThroughStep: 5,
          },
        ],
        activeDeals: [],
      },
    };
    expect(
      dealMove(
        { focus: "ally", target: null, avoidTargets: [] },
        actions,
        withOpen,
      )?.id,
    ).toBe(proposeAuri.id);
    // Without the ally focus, no proposal is made.
    expect(
      dealMove(
        { focus: "expand", target: null, avoidTargets: [] },
        actions,
        obs,
      ),
    ).toBeFalsy();
    expect(
      choose({ focus: "expand", target: null, avoidTargets: [] }, actions, obs)
        ?.id,
    ).toBe(EXPAND.id);
  });

  it("honors accepted pacts: hostile actions on the partner are filtered unless the plan names them", async () => {
    const choose = await loadChoose();
    const activePact = (myStatus: string) => ({
      ...BASE_OBS,
      deals: {
        incomingProposals: [],
        outgoingProposals: [],
        activeDeals: [
          {
            dealID: "D4",
            template: "trade_security_pact",
            proposerPlayerID: "P_ME",
            proposerName: "Me",
            recipientPlayerID: "P_S",
            recipientName: "Sefirot",
            stepsRemaining: 8,
            obligations: [
              { obligorPlayerID: "P_ME", status: myStatus },
              { obligorPlayerID: "P_S", status: "pending" },
            ],
          },
        ],
      },
    });
    const attackPartner = {
      id: "attack:P_S:25",
      kind: "attack",
      label: "Attack Sefirot with 25% troops",
      risk: { level: "medium" },
      metadata: { targetID: "P_S", targetName: "Sefirot" },
    };
    const embargoPartner = {
      id: "embargo:P_S:start",
      kind: "embargo",
      label: "Embargo Sefirot",
      risk: { level: "medium" },
      metadata: { targetID: "P_S", action: "start" },
    };
    const embargoAll = {
      id: "embargo_all:start",
      kind: "embargo_all",
      label: "Embargo all eligible rivals",
      risk: { level: "medium" },
      metadata: { action: "start" },
    };
    const actions = [attackPartner, embargoPartner, embargoAll, EXPAND, HOLD];

    // Pact pending, partner not targeted: hostile options are filtered.
    expect(
      choose({ target: null, avoidTargets: [] }, actions, activePact("pending"))
        ?.id,
    ).toBe(EXPAND.id);
    expect(
      choose(
        { target: null, avoidTargets: [], preferKinds: ["embargo"] },
        actions,
        activePact("pending"),
      )?.id,
    ).toBe(EXPAND.id);
    expect(
      choose(
        { target: null, avoidTargets: [], preferKinds: ["embargo_all"] },
        actions,
        activePact("pending"),
      )?.id,
    ).toBe(EXPAND.id);

    // Betrayal stays possible and intentional: the plan names the partner.
    expect(
      choose(
        { target: "Sefirot", avoidTargets: [] },
        actions,
        activePact("pending"),
      )?.id,
    ).toBe(attackPartner.id);

    // A terminal own-obligation lifts the constraint.
    expect(
      choose(
        { target: null, avoidTargets: [] },
        actions,
        activePact("violated"),
      )?.id,
    ).toBe(attackPartner.id);
  });
});
