import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDealManager,
  DEAL_ACTION_COOLDOWN_STEPS,
  DEAL_PROPOSAL_TTL_STEPS,
  MAX_ACTIVE_DEALS_PER_AGENT,
  MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR,
} from "../../src/server/agents/AgentDealManager";
import type {
  AgentDecisionRecord,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  DEALS_FLAG,
  dealLeagueHarness,
  pickByID,
  stubObservation,
  stubVisiblePlayer,
  type StubSeat,
} from "./DealTestHarness";

// Phase B (PROXYWAR_TUNE_STRUCTURED_DEALS): deterministic deal IDs, decision
// step timing (proposed at N => visible at N+1; accepted at N+1 => active
// from N+2), lifecycle (open -> accepted | rejected | withdrawn | expired),
// caps, and bilateral privacy (a third seat's observation never contains the
// deal).

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const C: StubSeat = { agentID: "c1", playerID: "P_C", username: "Riven" };

beforeEach(() => {
  process.env[DEALS_FLAG] = "1";
});

afterEach(() => {
  delete process.env[DEALS_FLAG];
});

function proposeAction(
  recipient: StubSeat,
  template: string,
  metadata: Record<string, string | number | boolean | null> = {},
): LegalAction {
  return {
    id: `deal_propose:${recipient.playerID}:${template}`,
    kind: "deal_propose",
    label: `Propose ${template} to ${recipient.username}`,
    intent: null,
    risk: { level: "low", score: 0.15 },
    metadata: {
      recipientID: recipient.playerID,
      recipientName: recipient.username,
      template,
      ...metadata,
    },
  };
}

function responseAction(
  kind: "deal_accept" | "deal_reject" | "deal_withdraw",
  dealID: string,
): LegalAction {
  return {
    id: `${kind}:${dealID}`,
    kind,
    label: `${kind} ${dealID}`,
    intent: null,
    risk: { level: "none", score: 0 },
    metadata: { dealID },
  };
}

function registeredManager(seats: StubSeat[]): {
  manager: AgentDealManager;
  records: AgentDecisionRecord[];
  beginStep: (turnNumber?: number) => void;
} {
  const manager = new AgentDealManager();
  const records: AgentDecisionRecord[] = [];
  const beginStep = (turnNumber = 0) =>
    manager.beginDecisionStep({ turnNumber, records });
  beginStep();
  for (const seat of seats) {
    manager.observationFor({
      agentID: seat.agentID,
      observation: stubObservation({
        seat,
        others: seats
          .filter((other) => other.agentID !== seat.agentID)
          .map((other) => stubVisiblePlayer(other)),
        turnNumber: 0,
      }),
    });
  }
  return { manager, records, beginStep };
}

describe("AgentDealManager (league-driven timing, visibility, privacy)", () => {
  it("proposes with a deterministic ID, becomes visible at N+1, activates at N+2, and stays bilateral", async () => {
    const dealID = "deal:P_A:P_B:non_aggression_pact:0";
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [pickByID("deal_propose:P_B:non_aggression_pact")],
        [() => null, pickByID(`deal_accept:${dealID}`)],
        [],
      ],
    });
    const step0 = await harness.league.runDecisionTurn({ turnNumber: 0 });
    const step1 = await harness.league.runDecisionTurn({ turnNumber: 25 });
    await harness.league.runDecisionTurn({ turnNumber: 50 });

    // Step 0: the proposer's menu offered the propose action; the record is
    // stamped with dealAction/dealID and an accurate meta-action reason.
    const proposeRecord = step0.find((record) => record.agentID === A.agentID)!;
    expect(proposeRecord.chosenActionKind).toBe("deal_propose");
    expect(proposeRecord.chosenActionID).toBe(
      "deal_propose:P_B:non_aggression_pact",
    );
    expect(proposeRecord.result.accepted).toBe(true);
    expect(proposeRecord.result.reason).toBe(`deal proposed: ${dealID}`);
    expect(proposeRecord.decisionMetadata).toMatchObject({
      dealAction: "propose",
      dealID,
      dealTemplate: "non_aggression_pact",
      dealCounterpartyID: "P_B",
      dealApplyAccepted: true,
    });
    expect(proposeRecord.intent).toBeNull();

    // Step 0: NOT yet visible to the recipient (visible at N+1, not N).
    const recipientStep0 = harness.handles[1].inputs[0];
    expect(recipientStep0.observation.deals).toBeDefined();
    expect(recipientStep0.observation.deals!.incomingProposals).toEqual([]);
    expect(
      recipientStep0.legalActions.some(
        (action) => action.kind === "deal_accept",
      ),
    ).toBe(false);

    // Step 1: visible to the recipient with accept/reject offered.
    const recipientStep1 = harness.handles[1].inputs[1];
    expect(
      recipientStep1.observation.deals!.incomingProposals.map(
        (proposal) => proposal.dealID,
      ),
    ).toEqual([dealID]);
    expect(recipientStep1.legalActions.map((action) => action.id)).toContain(
      `deal_accept:${dealID}`,
    );
    expect(recipientStep1.legalActions.map((action) => action.id)).toContain(
      `deal_reject:${dealID}`,
    );

    // Privacy: the third seat NEVER sees the bilateral deal — not in its
    // observation JSON and not in its menu — at any step.
    for (const input of harness.handles[2].inputs) {
      expect(JSON.stringify(input.observation)).not.toContain(dealID);
      expect(
        input.legalActions.some((action) => action.id.includes(dealID)),
      ).toBe(false);
    }

    // Step 1: acceptance recorded; active from step 2 for 12 steps.
    const acceptRecord = step1.find((record) => record.agentID === B.agentID)!;
    expect(acceptRecord.chosenActionKind).toBe("deal_accept");
    expect(acceptRecord.result.reason).toBe(`deal accepted: ${dealID}`);
    expect(acceptRecord.decisionMetadata).toMatchObject({
      dealAction: "accept",
      dealID,
      dealApplyAccepted: true,
    });

    // Step 2: both parties observe the active deal; obligations pending.
    for (const handleIndex of [0, 1]) {
      const step2Input = harness.handles[handleIndex].inputs[2];
      const active = step2Input.observation.deals!.activeDeals;
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        dealID,
        template: "non_aggression_pact",
        activeFromStep: 2,
        expiresAfterStep: 13,
        stepsRemaining: 12,
      });
      expect(
        active[0].obligations.map((obligation) => obligation.status),
      ).toEqual(["pending", "pending"]);
    }

    const ledger = harness.league.dealLedger();
    expect(ledger.deals).toHaveLength(1);
    expect(ledger.deals[0]).toMatchObject({
      dealID,
      status: "accepted",
      proposedAtStep: 0,
      respondedAtStep: 1,
      activeFromStep: 2,
      expiresAfterStep: 13,
      durationSteps: 12,
    });
    expect(ledger.events.map((event) => event.event)).toEqual([
      "deal_proposed",
      "deal_accepted",
    ]);
  });

  it("rejects, withdraws, and silently expires proposals (TTL) with ledger evidence", async () => {
    const napID = "deal:P_A:P_B:non_aggression_pact:0";
    const tspID = "deal:P_A:P_B:trade_security_pact:3";
    const secondNapID = "deal:P_A:P_B:non_aggression_pact:6";
    const holdSteps = (count: number) =>
      Array.from({ length: count }, () => () => null);
    // A's proposals are spaced by DEAL_ACTION_COOLDOWN_STEPS (0, 3, 6);
    // responses (reject at step 1, withdraw at step 4) are never gated.
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          pickByID("deal_propose:P_B:non_aggression_pact"),
          () => null,
          () => null,
          pickByID("deal_propose:P_B:trade_security_pact"),
          pickByID(`deal_withdraw:${tspID}`),
          () => null,
          pickByID("deal_propose:P_B:non_aggression_pact"),
          ...holdSteps(5),
        ],
        [() => null, pickByID(`deal_reject:${napID}`), ...holdSteps(10)],
        [],
      ],
    });
    const stepRecords: AgentDecisionRecord[][] = [];
    for (let step = 0; step < 12; step += 1) {
      stepRecords.push(
        await harness.league.runDecisionTurn({ turnNumber: step * 25 }),
      );
    }

    const ledger = harness.league.dealLedger();
    const byID = new Map(ledger.deals.map((deal) => [deal.dealID, deal]));
    expect(byID.get(napID)).toMatchObject({
      status: "rejected",
      respondedAtStep: 1,
    });
    expect(byID.get(tspID)).toMatchObject({
      status: "withdrawn",
      respondedAtStep: 4,
    });
    // The second NAP was never answered: silently expired after the TTL.
    expect(byID.get(secondNapID)).toMatchObject({
      status: "expired",
      proposedAtStep: 6,
      answerableThroughStep: 6 + DEAL_PROPOSAL_TTL_STEPS,
    });

    // Reject stamps ride the recipient's record.
    const rejectRecord = stepRecords[1].find(
      (record) => record.agentID === B.agentID,
    )!;
    expect(rejectRecord.decisionMetadata).toMatchObject({
      dealAction: "reject",
      dealID: napID,
      dealApplyAccepted: true,
    });
    // Withdraw is silent: stamps only, no ledger event.
    const withdrawRecord = stepRecords[4].find(
      (record) => record.agentID === A.agentID,
    )!;
    expect(withdrawRecord.decisionMetadata).toMatchObject({
      dealAction: "withdraw",
      dealID: tspID,
      dealApplyAccepted: true,
    });
    expect(ledger.events.filter((event) => event.dealID === tspID)).toEqual([
      expect.objectContaining({ event: "deal_proposed" }),
    ]);

    // Proposal lapse produced a deal_expired ledger event AND a
    // dealComplianceEvent stamp on a record at the expiry step (step 11).
    const lapse = ledger.events.find(
      (event) => event.event === "deal_expired" && event.dealID === secondNapID,
    );
    expect(lapse).toBeDefined();
    expect(lapse!.publicText).toContain("expire unanswered");
    const stamped = stepRecords[11].find(
      (record) =>
        typeof record.decisionMetadata?.dealComplianceEvent === "string" &&
        record.decisionMetadata.dealComplianceEvent.includes(secondNapID),
    );
    expect(stamped).toBeDefined();
    expect(
      JSON.parse(stamped!.decisionMetadata!.dealComplianceEvent as string),
    ).toEqual([
      expect.objectContaining({ event: "deal_expired", dealID: secondNapID }),
    ]);
  });

  it("produces identical deal IDs for identical histories (determinism)", async () => {
    const run = async () => {
      const harness = dealLeagueHarness({
        seats: [A, B],
        scripts: [[pickByID("deal_propose:P_B:non_aggression_pact")], []],
      });
      await harness.league.runDecisionTurn({ turnNumber: 0 });
      return harness.league.dealLedger().deals.map((deal) => deal.dealID);
    };
    expect(await run()).toEqual(await run());
    expect(await run()).toEqual(["deal:P_A:P_B:non_aggression_pact:0"]);
  });
});

describe("AgentDealManager caps and clamps (direct)", () => {
  it("paces proposals by the per-agent cooldown, refuses duplicate templates, and clamps durations", () => {
    const { manager, beginStep } = registeredManager([A, B, C]);
    const optionsFor = (seat: StubSeat, others: StubSeat[]) =>
      manager.observationFor({
        agentID: seat.agentID,
        observation: stubObservation({
          seat,
          others: others.map((other) => stubVisiblePlayer(other)),
          turnNumber: 0,
        }),
      })!.proposalOptions;
    const openFromAToB = () =>
      manager
        .ledgerSnapshot()
        .deals.filter(
          (deal) =>
            deal.status === "open" &&
            deal.proposerPlayerID === A.playerID &&
            deal.recipientPlayerID === B.playerID,
        );

    const first = manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "non_aggression_pact", { durationSteps: 999 }),
      turnNumber: 0,
    });
    expect(first.result.accepted).toBe(true);

    // A second proposal inside the cooldown window fails LOUDLY, and the
    // proposer is offered no propose option at all while it waits (a model
    // must never see a move it cannot make).
    const tooSoon = manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(C, "non_aggression_pact"),
      turnNumber: 0,
    });
    expect(tooSoon.result.accepted).toBe(false);
    expect(tooSoon.result.reason).toContain("proposal cooldown active");
    expect(tooSoon.stamps.dealApplyAccepted).toBe(false);
    expect(manager.proposalCooldownRemainingSteps(A.playerID)).toBe(
      DEAL_ACTION_COOLDOWN_STEPS,
    );
    expect(optionsFor(A, [B, C])).toEqual([]);

    beginStep(25); // step 1
    beginStep(50); // step 2 — still inside the window
    expect(manager.proposalCooldownRemainingSteps(A.playerID)).toBe(1);
    expect(optionsFor(A, [B, C])).toEqual([]);
    beginStep(75); // step 3 — cooldown cleared
    expect(manager.proposalCooldownRemainingSteps(A.playerID)).toBe(0);

    const second = manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "trade_security_pact", { durationSteps: 1 }),
      turnNumber: 75,
    });
    expect(second.result.accepted).toBe(true);

    // Durations clamp into [3, 20].
    expect(
      manager.ledgerSnapshot().deals.map((deal) => deal.durationSteps),
    ).toEqual([20, 3]);
    // The cooldown is what now bounds concurrent offers: the pair never gets
    // past MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR open proposals (the cap itself
    // stays as defense in depth for any future path that outpaces the TTL).
    expect(openFromAToB().length).toBeLessThanOrEqual(
      MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR,
    );
    expect(openFromAToB()).toHaveLength(2);

    // Duplicate template to the same recipient is refused even off cooldown:
    // B proposes a NAP to A at step 3 and again at step 6.
    const duplicate = manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: proposeAction(A, "non_aggression_pact"),
      turnNumber: 75,
    });
    expect(duplicate.result.accepted).toBe(true);
    beginStep(100); // 4
    beginStep(125); // 5
    beginStep(150); // 6 — B off cooldown, its step-3 proposal still open
    expect(manager.proposalCooldownRemainingSteps(B.playerID)).toBe(0);
    const duplicateAgain = manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: proposeAction(A, "non_aggression_pact"),
      turnNumber: 150,
    });
    expect(duplicateAgain.result.accepted).toBe(false);
    expect(duplicateAgain.result.reason).toContain("already exists");

    // A's own open trade-security proposal to B removes exactly that template
    // from its offers; the pair is still otherwise proposable.
    const aOptions = optionsFor(A, [B, C]).filter(
      (option) => option.recipientPlayerID === B.playerID,
    );
    expect(
      aOptions.some(
        (option) => option.terms.template === "trade_security_pact",
      ),
    ).toBe(false);
    expect(
      aOptions.some(
        (option) => option.terms.template === "non_aggression_pact",
      ),
    ).toBe(true);
  });

  it("enforces the per-agent active-deal cap on accept and on offers", () => {
    const seats: StubSeat[] = [
      A,
      ...Array.from({ length: 7 }, (_, index) => ({
        agentID: `x${index + 1}`,
        playerID: `P_X${index + 1}`,
        username: `Rival ${index + 1}`,
      })),
    ];
    const { manager, beginStep } = registeredManager(seats);
    // Step 0: all 7 rivals propose a NAP to A (one proposal each — the
    // per-agent proposal cooldown is per PROPOSER, so seven different
    // proposers in one step is legal, one agent proposing seven times is not).
    for (const seat of seats.slice(1)) {
      const outcome = manager.applyDealAction({
        agentID: seat.agentID,
        playerID: seat.playerID,
        playerName: seat.username,
        action: proposeAction(A, "non_aggression_pact"),
        turnNumber: 0,
      });
      expect(outcome.result.accepted).toBe(true);
    }
    // Step 1: A accepts six; the seventh hits A's active-deal cap.
    beginStep(25);
    for (const seat of seats.slice(1, 7)) {
      const outcome = manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: responseAction(
          "deal_accept",
          `deal:${seat.playerID}:P_A:non_aggression_pact:0`,
        ),
        turnNumber: 25,
      });
      expect(outcome.result.accepted).toBe(true);
    }
    const seventh = seats[7];
    const blocked = manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: responseAction(
        "deal_accept",
        `deal:${seventh.playerID}:P_A:non_aggression_pact:0`,
      ),
      turnNumber: 25,
    });
    expect(blocked.result.accepted).toBe(false);
    expect(blocked.result.reason).toContain(
      `active-deal cap reached (${MAX_ACTIVE_DEALS_PER_AGENT} per agent)`,
    );

    // At the cap, A gets no further proposal options at all.
    const observation = manager.observationFor({
      agentID: A.agentID,
      observation: stubObservation({
        seat: A,
        others: seats.slice(1).map((seat) => stubVisiblePlayer(seat)),
        turnNumber: 25,
      }),
    });
    expect(observation!.proposalOptions).toEqual([]);
    expect(observation!.activeDeals).toHaveLength(6);
  });

  it("gates offers by template preconditions (joint target path, friendly support)", () => {
    const { manager } = registeredManager([A, B, C]);
    // No friendly rivals and no attackable-with-path target beyond the
    // recipient: only the two pact templates are offered per recipient.
    const bare = manager.observationFor({
      agentID: A.agentID,
      observation: stubObservation({
        seat: A,
        others: [
          stubVisiblePlayer(B, { sharesBorder: false, canAttack: false }),
          stubVisiblePlayer(C, { sharesBorder: false, canAttack: false }),
        ],
        turnNumber: 0,
      }),
    });
    expect(
      bare!.proposalOptions.map((option) => option.terms.template),
    ).toEqual([
      "non_aggression_pact",
      "trade_security_pact",
      "non_aggression_pact",
      "trade_security_pact",
    ]);

    // A bordered attackable third seat enables joint_attack (deterministic
    // strongest target); a friendly recipient enables support_request with
    // ALWAYS-explicit amounts.
    const rich = manager.observationFor({
      agentID: A.agentID,
      observation: stubObservation({
        seat: A,
        others: [
          stubVisiblePlayer(B, { isFriendly: true, canAttack: false }),
          stubVisiblePlayer(C, { tilesOwned: 900 }),
        ],
        turnNumber: 0,
      }),
    });
    const forB = rich!.proposalOptions.filter(
      (option) => option.recipientPlayerID === B.playerID,
    );
    const joint = forB.find(
      (option) => option.terms.template === "joint_attack",
    );
    expect(joint).toBeDefined();
    expect(joint!.terms.targetPlayerID).toBe(C.playerID);
    const support = forB.find(
      (option) => option.terms.template === "support_request",
    );
    expect(support).toBeDefined();
    expect(support!.terms.goldAmount).toBe("150000");
    expect(support!.terms.troopAmount).toBe(20000);
    // Non-friendly recipient never gets a support_request offer.
    expect(
      rich!.proposalOptions.some(
        (option) =>
          option.recipientPlayerID === C.playerID &&
          option.terms.template === "support_request",
      ),
    ).toBe(false);
  });

  it("resolves the withdraw-vs-accept same-step race deterministically by pass order", () => {
    // Order 1: the proposer's withdraw lands first in the submission pass —
    // the recipient's accept fails loudly.
    const first = registeredManager([A, B]);
    const dealID = "deal:P_A:P_B:non_aggression_pact:0";
    expect(
      first.manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: proposeAction(B, "non_aggression_pact"),
        turnNumber: 0,
      }).result.accepted,
    ).toBe(true);
    first.beginStep(25);
    const withdrawFirst = first.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: responseAction("deal_withdraw", dealID),
      turnNumber: 25,
    });
    expect(withdrawFirst.result.accepted).toBe(true);
    const lateAccept = first.manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: responseAction("deal_accept", dealID),
      turnNumber: 25,
    });
    expect(lateAccept.result.accepted).toBe(false);
    expect(lateAccept.result.reason).toBe(
      "deal is not open (status: withdrawn)",
    );
    expect(lateAccept.stamps.dealApplyAccepted).toBe(false);
    expect(first.manager.ledgerSnapshot().deals[0].status).toBe("withdrawn");

    // Order 2: the recipient accepts first — the proposer's withdraw fails
    // loudly and the pact stands.
    const second = registeredManager([A, B]);
    expect(
      second.manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: proposeAction(B, "non_aggression_pact"),
        turnNumber: 0,
      }).result.accepted,
    ).toBe(true);
    second.beginStep(25);
    expect(
      second.manager.applyDealAction({
        agentID: B.agentID,
        playerID: B.playerID,
        playerName: B.username,
        action: responseAction("deal_accept", dealID),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);
    const lateWithdraw = second.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: responseAction("deal_withdraw", dealID),
      turnNumber: 25,
    });
    expect(lateWithdraw.result.accepted).toBe(false);
    expect(lateWithdraw.result.reason).toBe(
      "deal is not open (status: accepted)",
    );
    expect(second.manager.ledgerSnapshot().deals[0].status).toBe("accepted");
  });

  it("returns no deals block for spawn-phase or dead observations", () => {
    const { manager } = registeredManager([A, B]);
    const spawnObservation = stubObservation({
      seat: A,
      others: [stubVisiblePlayer(B)],
      turnNumber: 0,
    });
    spawnObservation.phase = "spawn";
    expect(
      manager.observationFor({
        agentID: A.agentID,
        observation: spawnObservation,
      }),
    ).toBeUndefined();

    const deadObservation = stubObservation({
      seat: A,
      others: [stubVisiblePlayer(B)],
      turnNumber: 0,
    });
    deadObservation.ownState = {
      ...deadObservation.ownState!,
      isAlive: false,
    };
    expect(
      manager.observationFor({
        agentID: A.agentID,
        observation: deadObservation,
      }),
    ).toBeUndefined();
  });
});
