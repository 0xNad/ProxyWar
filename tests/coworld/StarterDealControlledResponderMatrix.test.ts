import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDealManager,
  DEAL_ACTION_COOLDOWN_STEPS,
  DEAL_PROPOSAL_TTL_STEPS,
} from "../../src/server/agents/AgentDealManager";
import {
  validateAgentDealDecision,
  validateAgentDecision,
} from "../../src/server/agents/AgentDecisionValidator";
import type {
  AgentDecisionRecord,
  AgentObservation,
  AgentSupportOption,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import {
  DEALS_FLAG,
  fabricatedRecord,
  stubObservation,
  stubVisiblePlayer,
  type StubSeat,
} from "../server/DealTestHarness";

/**
 * Deterministic controlled-counterparty matrix for the public LLM starter.
 *
 * Unlike the selector-only posture suite, these scenarios cross the public
 * starter's exact picks through the production validators, the real deal
 * manager lifecycle, and (for accepted commitments) the compliance referee.
 * The only fabricated boundary is a confirmed core-effect decision record:
 * DealTestHarness deliberately has no live GameServer, so that record is the
 * narrow fixture used by the server compliance suites as well.
 */

const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

const STARTER: StubSeat = {
  agentID: "starter",
  playerID: "P_STARTER",
  username: "Public starter",
};
const RESPONDER: StubSeat = {
  agentID: "responder",
  playerID: "P_RESPONDER",
  username: "Controlled responder",
};
const TARGET: StubSeat = {
  agentID: "target",
  playerID: "P_TARGET",
  username: "Named target",
};
const SEATS = [STARTER, RESPONDER, TARGET];

const BASE_PLAN = {
  focus: "expand",
  preferKinds: [] as string[],
  target: null as string | null,
  avoidTargets: [] as string[],
  dealPolicies: [] as Array<{
    playerID: string;
    acceptTemplates: string[];
    proposeTemplates: string[];
  }>,
  breakDealIDs: [] as string[],
};

type StarterPlan = typeof BASE_PLAN;

interface StarterExecutor {
  choose: (
    plan: StarterPlan,
    actions: LegalAction[],
    observation: AgentObservation,
  ) => LegalAction | null | undefined;
  dealMove: (
    plan: StarterPlan,
    actions: LegalAction[],
    observation: AgentObservation,
  ) => LegalAction | null | undefined;
  socialNote: (
    plan: StarterPlan,
    chosen: LegalAction,
    dealMove: LegalAction | null,
    observation: AgentObservation,
  ) => string;
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `function ${name} closing brace not found`).toBeGreaterThan(
    start,
  );
  return source.slice(start, end + 2);
}

async function loadStarterExecutor(): Promise<StarterExecutor> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const order = source.match(/const DEFAULT_ORDER = \[[\s\S]*?\];/)?.[0];
  const retry = source.match(/const DEAL_PROPOSAL_RETRY_STEPS = \d+;/)?.[0];
  const maxAttempts = source.match(
    /const DEAL_PROPOSAL_MAX_ATTEMPTS_PER_KEY = \d+;/,
  )?.[0];
  const trustFloor = source.match(
    /const DEAL_TRUST_MIN_RELIABILITY = [\d.]+;/,
  )?.[0];
  const attempts = source.match(/const proposalAttempts = new Map\(\);/)?.[0];
  expect(order).toBeDefined();
  expect(retry).toBeDefined();
  expect(maxAttempts).toBeDefined();
  expect(trustFloor).toBeDefined();
  expect(attempts).toBeDefined();
  return new Function(
    `${order}
     ${retry}
     ${maxAttempts}
     ${trustFloor}
     ${attempts}
     const history = [];
     function avoidActionIDs() { return []; }
     let plan = null;
     ${extractFunction(source, "clean")}
     ${extractFunction(source, "cleanID")}
     ${extractFunction(source, "dealConstraints")}
     ${extractFunction(source, "hasOpenDeal")}
     ${extractFunction(source, "dealPolicyFor")}
     ${extractFunction(source, "failedReliabilityGate")}
     ${extractFunction(source, "chooseDealMove")}
     ${extractFunction(source, "chooseObligationMove")}
     ${extractFunction(source, "socialActionNote")}
     ${extractFunction(source, "pendingRenewalAction")}
     ${extractFunction(source, "choose")}
     return {
       choose: (nextPlan, actions, observation) => {
         plan = nextPlan;
         return choose(actions, observation);
       },
       dealMove: (nextPlan, actions, observation) => {
         plan = nextPlan;
         return chooseDealMove(actions, observation);
       },
       socialNote: (nextPlan, chosen, dealMove, observation) => {
         plan = nextPlan;
         return socialActionNote(chosen, dealMove, observation);
       },
     };`,
  )() as StarterExecutor;
}

interface MatrixState {
  manager: AgentDealManager;
  records: AgentDecisionRecord[];
  step: number;
}

interface MenuOptions {
  visibleOverrides?: Partial<Record<string, Partial<AgentVisiblePlayer>>>;
  supportOptions?: AgentSupportOption[];
}

function startMatrix(): MatrixState {
  const state: MatrixState = {
    manager: new AgentDealManager(),
    records: [],
    step: 0,
  };
  state.manager.beginDecisionStep({ turnNumber: 0, records: state.records });
  for (const seat of SEATS) {
    menuFor(state, seat);
  }
  return state;
}

function advanceTo(state: MatrixState, targetStep: number): void {
  expect(targetStep).toBeGreaterThan(state.step);
  while (state.step < targetStep) {
    state.step += 1;
    state.manager.beginDecisionStep({
      turnNumber: state.step * 25,
      records: state.records,
    });
  }
}

function menuFor(
  state: MatrixState,
  seat: StubSeat,
  options: MenuOptions = {},
): { observation: AgentObservation; actions: LegalAction[] } {
  const visiblePlayers = SEATS.filter(
    (candidate) => candidate.playerID !== seat.playerID,
  ).map((candidate) =>
    stubVisiblePlayer(candidate, {
      ...(options.visibleOverrides?.[candidate.playerID] ?? {}),
    }),
  );
  const base = stubObservation({
    seat,
    others: visiblePlayers,
    turnNumber: state.step * 25,
    gameID: "STARTER_CONTROLLED_DEAL_MATRIX",
  });
  const observation: AgentObservation = {
    ...base,
    nonCombat: {
      ...base.nonCombat,
      supportOptions: options.supportOptions ?? base.nonCombat.supportOptions,
    },
  };
  const deals = state.manager.observationFor({
    agentID: seat.agentID,
    observation,
  });
  expect(deals).toBeDefined();
  const dealAware = { ...observation, deals };
  return {
    observation: dealAware,
    actions: new LegalActionBuilder().build({ observation: dealAware }),
  };
}

function validateDealPick(
  action: LegalAction | null | undefined,
  actions: LegalAction[],
): LegalAction {
  expect(action).toBeDefined();
  expect(action).not.toBeNull();
  const validation = validateAgentDealDecision(
    {
      actionID: "hold",
      dealActionID: action!.id,
      reason: "controlled deal matrix",
    },
    actions,
  );
  if (validation === null || !validation.ok) {
    throw new Error(
      validation === null ? "deal pick was absent" : validation.reason,
    );
  }
  expect(validation.action).toBe(action);
  return validation.action;
}

function validateGamePick(
  action: LegalAction | null | undefined,
  actions: LegalAction[],
): LegalAction {
  expect(action).toBeDefined();
  expect(action).not.toBeNull();
  const validation = validateAgentDecision(
    { actionID: action!.id, reason: "controlled deal matrix" },
    actions,
  );
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  expect(validation.action).toBe(action);
  return validation.action;
}

function applyDealPick(
  state: MatrixState,
  seat: StubSeat,
  action: LegalAction,
): string | null {
  const outcome = state.manager.applyDealAction({
    agentID: seat.agentID,
    playerID: seat.playerID,
    playerName: seat.username,
    action,
    turnNumber: state.step * 25,
    statedReason: "controlled deal matrix",
  });
  expect(outcome.result.accepted).toBe(true);
  expect(outcome.stamps.dealApplyAccepted).toBe(true);
  return typeof outcome.stamps.dealID === "string"
    ? outcome.stamps.dealID
    : null;
}

function controlledDealAction(
  state: MatrixState,
  seat: StubSeat,
  actionID: string,
  options: MenuOptions = {},
): LegalAction {
  const menu = menuFor(state, seat, options);
  const action = menu.actions.find((candidate) => candidate.id === actionID);
  return validateDealPick(action, menu.actions);
}

function planFor(
  playerID: string,
  input: { accept?: string[]; propose?: string[] } = {},
): StarterPlan {
  return {
    ...BASE_PLAN,
    dealPolicies: [
      {
        playerID,
        acceptTemplates: input.accept ?? [],
        proposeTemplates: input.propose ?? [],
      },
    ],
  };
}

function proposeAndAcceptNap(
  state: MatrixState,
  executor: StarterExecutor,
): string {
  const proposal = controlledDealAction(
    state,
    RESPONDER,
    `deal_propose:${STARTER.playerID}:non_aggression_pact`,
  );
  const dealID = applyDealPick(state, RESPONDER, proposal);
  expect(dealID).toBe(
    `deal:${RESPONDER.playerID}:${STARTER.playerID}:non_aggression_pact:0`,
  );
  advanceTo(state, 1);
  const menu = menuFor(state, STARTER);
  const accept = validateDealPick(
    executor.dealMove(
      planFor(RESPONDER.playerID, { accept: ["non_aggression_pact"] }),
      menu.actions,
      menu.observation,
    ),
    menu.actions,
  );
  expect(accept.id).toBe(`deal_accept:${dealID}`);
  expect(applyDealPick(state, STARTER, accept)).toBe(dealID);
  advanceTo(state, 2);
  return dealID!;
}

function confirmedRecord(
  state: MatrixState,
  seat: StubSeat,
  action: LegalAction,
  reason: string,
): AgentDecisionRecord {
  const confirmedDonation =
    action.kind === "donate_gold"
      ? {
          recipientPlayerID: String(action.metadata?.recipientID),
          tick: state.step * 25 + 1,
          resource: "gold" as const,
          amount: String(action.metadata?.gold ?? 0),
        }
      : action.kind === "donate_troops"
        ? {
            recipientPlayerID: String(action.metadata?.recipientID),
            tick: state.step * 25 + 1,
            resource: "troops" as const,
            amount: Number(action.metadata?.troops ?? 0),
          }
        : undefined;
  return fabricatedRecord({
    sequence: state.records.length + 1,
    agentID: seat.agentID,
    playerID: seat.playerID,
    username: seat.username,
    turnNumber: state.step * 25,
    kind: action.kind,
    actionID: action.id,
    reason,
    metadata: action.metadata,
    auditStatus:
      action.kind === "attack" || confirmedDonation !== undefined
        ? "confirmed"
        : "not_applicable",
    ...(confirmedDonation !== undefined ? { confirmedDonation } : {}),
  });
}

beforeEach(() => {
  process.env[DEALS_FLAG] = "1";
});

afterEach(() => {
  delete process.env[DEALS_FLAG];
});

describe("public starter controlled-responder deal matrix", () => {
  it("keeps an accepted NAP for its complete window when no exact breach ID is authorized", async () => {
    const executor = await loadStarterExecutor();
    const state = startMatrix();
    const dealID = proposeAndAcceptNap(state, executor);
    const keepPlan: StarterPlan = {
      ...BASE_PLAN,
      preferKinds: ["attack"],
      target: RESPONDER.username,
    };

    for (let step = 2; step <= 13; step += 1) {
      expect(state.step).toBe(step);
      const menu = menuFor(state, STARTER, {
        visibleOverrides: {
          [TARGET.playerID]: { canAttack: false, sharesBorder: false },
        },
      });
      const chosen = validateGamePick(
        executor.choose(keepPlan, menu.actions, menu.observation),
        menu.actions,
      );
      expect(chosen.metadata?.targetID).not.toBe(RESPONDER.playerID);
      expect(chosen.metadata?.expansion).toBe(true);
      state.records.push(
        confirmedRecord(
          state,
          STARTER,
          chosen,
          `keep ${dealID} at step ${step}`,
        ),
      );
      advanceTo(state, step + 1);
    }

    const obligation = state.manager
      .ledgerSnapshot()
      .deals.find((deal) => deal.dealID === dealID)!
      .obligations.find(
        (candidate) => candidate.obligorPlayerID === STARTER.playerID,
      )!;
    expect(obligation).toMatchObject({
      status: "fulfilled",
      auditCoverageComplete: true,
      auditCoverageGapCount: 0,
    });
    expect(obligation.resolutionEvidence).toContain(
      "12 decisions without a validator-accepted hostile action",
    );
  });

  it("requires the exact active deal ID before selecting and recording a NAP breach", async () => {
    const executor = await loadStarterExecutor();
    const state = startMatrix();
    const dealID = proposeAndAcceptNap(state, executor);
    const menu = menuFor(state, STARTER, {
      visibleOverrides: {
        [TARGET.playerID]: { canAttack: false, sharesBorder: false },
      },
    });
    const attackPlan: StarterPlan = {
      ...BASE_PLAN,
      preferKinds: ["attack"],
      target: RESPONDER.username,
      breakDealIDs: ["deal:wrong"],
    };
    const wrongIDPick = validateGamePick(
      executor.choose(attackPlan, menu.actions, menu.observation),
      menu.actions,
    );
    expect(wrongIDPick.metadata?.targetID).not.toBe(RESPONDER.playerID);

    const exactPlan = { ...attackPlan, breakDealIDs: [dealID] };
    const breach = validateGamePick(
      executor.choose(exactPlan, menu.actions, menu.observation),
      menu.actions,
    );
    expect(breach).toMatchObject({
      id: `attack:${RESPONDER.playerID}:10`,
      kind: "attack",
      metadata: { targetID: RESPONDER.playerID },
    });
    expect(breach.metadata?.expansion).not.toBe(true);
    const reason = executor.socialNote(
      exactPlan,
      breach,
      null,
      menu.observation,
    );
    expect(reason).toBe(`intentional breach ${dealID}`);
    const source = confirmedRecord(state, STARTER, breach, reason);
    state.records.push(source);
    advanceTo(state, 3);

    const ledger = state.manager.ledgerSnapshot();
    const obligation = ledger.deals
      .find((deal) => deal.dealID === dealID)!
      .obligations.find(
        (candidate) => candidate.obligorPlayerID === STARTER.playerID,
      )!;
    expect(obligation).toMatchObject({
      status: "violated",
      obligorStatedReason: `intentional breach ${dealID}`,
    });
    expect(
      ledger.events.find(
        (event) => event.event === "deal_violated" && event.dealID === dealID,
      ),
    ).toMatchObject({
      sourceSequence: source.sequence,
      sourceAuditStatus: "confirmed",
      sourceFallbackUsed: false,
      sourceLlmPlannerDegraded: false,
    });
  });

  it("accepts a support request and fulfills it only to the exact requesting counterparty", async () => {
    const executor = await loadStarterExecutor();
    const state = startMatrix();
    const proposal = controlledDealAction(
      state,
      RESPONDER,
      `deal_propose:${STARTER.playerID}:support_request`,
      {
        visibleOverrides: {
          [STARTER.playerID]: {
            isFriendly: true,
            canAttack: false,
            canDonateGold: true,
            canDonateTroops: true,
          },
        },
      },
    );
    const dealID = applyDealPick(state, RESPONDER, proposal)!;
    advanceTo(state, 1);

    const support = (seat: StubSeat): AgentSupportOption => ({
      recipientID: seat.playerID,
      recipientName: seat.username,
      canDonateGold: true,
      canDonateTroops: true,
      suggestedGold: 50_000,
      suggestedTroops: 5_000,
      legalReasons: ["controlled donation affordance"],
    });
    const responseMenu = menuFor(state, STARTER, {
      visibleOverrides: {
        [RESPONDER.playerID]: {
          isFriendly: true,
          canAttack: false,
          troops: 20_000,
          maxTroops: 100_000,
        },
      },
      supportOptions: [support(RESPONDER)],
    });
    const accept = validateDealPick(
      executor.dealMove(
        planFor(RESPONDER.playerID, { accept: ["support_request"] }),
        responseMenu.actions,
        responseMenu.observation,
      ),
      responseMenu.actions,
    );
    expect(accept.id).toBe(`deal_accept:${dealID}`);
    applyDealPick(state, STARTER, accept);
    advanceTo(state, 2);

    const fulfillmentMenu = menuFor(state, STARTER, {
      // The decoy is intentionally first in the real builder input.
      supportOptions: [support(TARGET), support(RESPONDER)],
    });
    const chosen = validateGamePick(
      executor.choose(
        planFor(RESPONDER.playerID, { accept: ["support_request"] }),
        fulfillmentMenu.actions,
        fulfillmentMenu.observation,
      ),
      fulfillmentMenu.actions,
    );
    expect(chosen).toMatchObject({
      id: `donate_gold:${RESPONDER.playerID}`,
      kind: "donate_gold",
      metadata: { recipientID: RESPONDER.playerID, gold: 50_000 },
    });
    const source = confirmedRecord(
      state,
      STARTER,
      chosen,
      `fulfil support promise ${dealID}`,
    );
    source.audit!.auditStatus = "confirmed";
    state.records.push(source);
    advanceTo(state, 3);

    const obligation = state.manager
      .ledgerSnapshot()
      .deals.find((deal) => deal.dealID === dealID)!.obligations[0];
    expect(obligation).toMatchObject({
      obligorPlayerID: STARTER.playerID,
      counterpartyPlayerID: RESPONDER.playerID,
      status: "fulfilled",
      donatedGold: "50000",
      donatedTroops: 0,
    });
  });

  it("proposes a joint attack, then selects the named target at the exact 20% fulfillment floor", async () => {
    const executor = await loadStarterExecutor();
    const state = startMatrix();
    const proposalMenu = menuFor(state, STARTER);
    const proposal = validateDealPick(
      executor.dealMove(
        planFor(RESPONDER.playerID, { propose: ["joint_attack"] }),
        proposalMenu.actions,
        proposalMenu.observation,
      ),
      proposalMenu.actions,
    );
    expect(proposal).toMatchObject({
      id: `deal_propose:${RESPONDER.playerID}:joint_attack`,
      metadata: {
        recipientID: RESPONDER.playerID,
        template: "joint_attack",
        targetID: TARGET.playerID,
        targetName: TARGET.username,
      },
    });
    const dealID = applyDealPick(state, STARTER, proposal)!;
    advanceTo(state, 1);
    const accept = controlledDealAction(
      state,
      RESPONDER,
      `deal_accept:${dealID}`,
    );
    applyDealPick(state, RESPONDER, accept);
    advanceTo(state, 2);

    const fulfillmentMenu = menuFor(state, STARTER);
    const attack25 = fulfillmentMenu.actions.find(
      (action) => action.id === `attack:${TARGET.playerID}:25`,
    )!;
    const attack20: LegalAction = {
      ...attack25,
      id: `attack:${TARGET.playerID}:20`,
      label: `Attack ${TARGET.username} with 20% troops`,
      intent: { type: "attack", targetID: TARGET.playerID, troops: 2_000 },
      metadata: {
        ...attack25.metadata,
        troops: 2_000,
        troopPercentage: 0.2,
        troopPercent: 20,
      },
    };
    const offeredActions = [...fulfillmentMenu.actions, attack20];
    const chosen = validateGamePick(
      executor.choose(
        planFor(RESPONDER.playerID, { propose: ["joint_attack"] }),
        offeredActions,
        fulfillmentMenu.observation,
      ),
      offeredActions,
    );
    expect(chosen).toBe(attack20);
    const source = confirmedRecord(
      state,
      STARTER,
      chosen,
      `fulfil attack pledge ${dealID}`,
    );
    state.records.push(source);
    advanceTo(state, 3);

    expect(
      state.manager
        .ledgerSnapshot()
        .deals.find((deal) => deal.dealID === dealID)!.obligations[0],
    ).toMatchObject({
      obligorPlayerID: STARTER.playerID,
      targetPlayerID: TARGET.playerID,
      status: "fulfilled",
      resolutionEvidence: `land attack (20% troops) on ${TARGET.username} at step 2`,
    });
  });

  it("learns from one rejection and one expiry without bypassing server cooldown or retry caps", async () => {
    const executor = await loadStarterExecutor();
    const state = startMatrix();
    const plan = planFor(RESPONDER.playerID, {
      propose: ["non_aggression_pact"],
    });
    const initialMenu = menuFor(state, STARTER);
    const first = validateDealPick(
      executor.dealMove(plan, initialMenu.actions, initialMenu.observation),
      initialMenu.actions,
    );
    const firstID = applyDealPick(state, STARTER, first)!;

    // An open proposal suppresses a duplicate immediately.
    const openMenu = menuFor(state, STARTER);
    expect(
      executor.dealMove(plan, openMenu.actions, openMenu.observation),
    ).toBeNull();

    advanceTo(state, 1);
    const reject = controlledDealAction(
      state,
      RESPONDER,
      `deal_reject:${firstID}`,
    );
    applyDealPick(state, RESPONDER, reject);
    expect(
      state.manager
        .ledgerSnapshot()
        .deals.find((deal) => deal.dealID === firstID)?.status,
    ).toBe("rejected");

    // Server-side cooldown removes every proposal option at steps 1 and 2.
    for (const step of [1, 2]) {
      if (state.step < step) advanceTo(state, step);
      const menu = menuFor(state, STARTER);
      expect(menu.observation.deals?.proposalOptions).toEqual([]);
      expect(
        executor.dealMove(plan, menu.actions, menu.observation),
      ).toBeNull();
    }
    expect(DEAL_ACTION_COOLDOWN_STEPS).toBe(3);

    // At step 3 the manager reopens the option, but the starter retains the
    // rejection and refuses its own retry until the long 60-step interval.
    advanceTo(state, 3);
    const reopened = menuFor(state, STARTER);
    expect(
      reopened.observation.deals?.proposalOptions.some(
        (option) =>
          option.recipientPlayerID === RESPONDER.playerID &&
          option.terms.template === "non_aggression_pact",
      ),
    ).toBe(true);
    expect(
      executor.dealMove(plan, reopened.actions, reopened.observation),
    ).toBeNull();

    advanceTo(state, 60);
    const retryMenu = menuFor(state, STARTER);
    const retry = validateDealPick(
      executor.dealMove(plan, retryMenu.actions, retryMenu.observation),
      retryMenu.actions,
    );
    const retryID = applyDealPick(state, STARTER, retry)!;
    expect(retryID).toBe(
      `deal:${STARTER.playerID}:${RESPONDER.playerID}:non_aggression_pact:60`,
    );

    // The controlled responder ignores the retry. It expires at step 65
    // (answerable through 64), and the starter's two-attempt cap stays binding
    // even after every server-side cooldown has long since cleared.
    advanceTo(state, 60 + DEAL_PROPOSAL_TTL_STEPS + 1);
    const expired = state.manager
      .ledgerSnapshot()
      .deals.find((deal) => deal.dealID === retryID)!;
    expect(expired).toMatchObject({
      status: "expired",
      answerableThroughStep: 60 + DEAL_PROPOSAL_TTL_STEPS,
    });
    const afterExpiry = menuFor(state, STARTER);
    expect(
      afterExpiry.observation.deals?.proposalOptions.some(
        (option) =>
          option.recipientPlayerID === RESPONDER.playerID &&
          option.terms.template === "non_aggression_pact",
      ),
    ).toBe(true);
    expect(
      executor.dealMove(plan, afterExpiry.actions, afterExpiry.observation),
    ).toBeNull();

    advanceTo(state, 120);
    const longAfterExpiry = menuFor(state, STARTER);
    expect(
      executor.dealMove(
        plan,
        longAfterExpiry.actions,
        longAfterExpiry.observation,
      ),
    ).toBeNull();
    expect(
      state.manager
        .ledgerSnapshot()
        .events.filter((event) => event.event === "deal_expired")
        .map((event) => event.dealID),
    ).toContain(retryID);
  });
});
