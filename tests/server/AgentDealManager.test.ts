import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDealManager,
  DEAL_ACTION_COOLDOWN_STEPS,
  DEAL_PROPOSAL_TTL_STEPS,
  MAX_ACTIVE_DEALS_PER_AGENT,
  MAX_OPEN_PROPOSALS_PER_ORDERED_PAIR,
} from "../../src/server/agents/AgentDealManager";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import type {
  AgentDecisionRecord,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  DEALS_FLAG,
  dealLeagueHarness,
  pickByID,
  pickWithDeal,
  stubObservation,
  stubVisiblePlayer,
  type StubSeat,
} from "./DealTestHarness";

// Phase B (PROXYWAR_TUNE_STRUCTURED_DEALS): deterministic deal IDs, decision
// step timing (proposed at N => visible at N+1; accepted at N+1 => active
// from N+2), lifecycle
// (open -> accepted | rejected | withdrawn | superseded | expired),
// caps, and bilateral privacy (a third seat's observation never contains the
// deal).

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const C: StubSeat = { agentID: "c1", playerID: "P_C", username: "Riven" };
const D: StubSeat = { agentID: "d1", playerID: "P_D", username: "Mori" };

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
  metadata: Record<string, string | number | boolean | null> = {},
): LegalAction {
  return {
    id: `${kind}:${dealID}`,
    kind,
    label: `${kind} ${dealID}`,
    intent: null,
    risk: { level: "none", score: 0 },
    metadata: {
      dealID,
      ...(kind === "deal_accept" ? { supportFeasible: true } : {}),
      ...metadata,
    },
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

  it("keeps an ordinary last-step TTL expiry at turn 500 while a finalize-only expiry uses turn 600", () => {
    const { manager, records, beginStep } = registeredManager([A, B, C]);
    const ordinaryDealID = "deal:P_A:P_B:non_aggression_pact:0";
    const forceExpiredDealID = "deal:P_C:P_B:non_aggression_pact:3";
    expect(
      manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: proposeAction(B, "non_aggression_pact"),
        turnNumber: 0,
      }).result.accepted,
    ).toBe(true);
    beginStep(100);
    beginStep(200);
    beginStep(300);
    expect(
      manager.applyDealAction({
        agentID: C.agentID,
        playerID: C.playerID,
        playerName: C.username,
        action: proposeAction(B, "non_aggression_pact"),
        turnNumber: 300,
      }).result.accepted,
    ).toBe(true);
    beginStep(400);
    beginStep(500);

    const ordinaryExpiry = manager
      .ledgerSnapshot()
      .events.find(
        (event) =>
          event.event === "deal_expired" && event.dealID === ordinaryDealID,
      );
    expect(ordinaryExpiry).toMatchObject({
      step: 5,
      sourceTurnNumber: 500,
    });

    manager.finalize({ records, turnNumber: 600 });
    const ledger = manager.ledgerSnapshot();
    const forceExpiry = ledger.events.find(
      (event) =>
        event.event === "deal_expired" && event.dealID === forceExpiredDealID,
    );
    expect(
      ledger.events.find(
        (event) =>
          event.event === "deal_expired" && event.dealID === ordinaryDealID,
      ),
    ).toMatchObject({ step: 5, sourceTurnNumber: 500 });
    expect(forceExpiry).toMatchObject({ step: 5, sourceTurnNumber: 600 });

    const telemetry = buildAgentSpectatorTelemetry({
      runID: "DEAL_TURN_PROVENANCE",
      records,
      roster: [A, B, C].map((seat) => ({
        agentID: seat.agentID,
        username: seat.username,
        profile: "diplomatic" as const,
        clientID: `CLNT_${seat.playerID}`,
        brainType: "rule" as const,
      })),
      dealLedger: ledger,
    });
    const expiryTurns = new Map(
      telemetry.events
        .filter((event) => event.kind === "deal_expired")
        .map((event) => [event.actionID, event.turnNumber]),
    );
    expect(expiryTurns).toEqual(
      new Map([
        [`deal:deal_expired:${ordinaryDealID}:${B.playerID}`, 500],
        [`deal:deal_expired:${forceExpiredDealID}:${B.playerID}`, 600],
      ]),
    );
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

  it.each([
    { first: A, second: B },
    { first: B, second: A },
  ])(
    "terminally supersedes the crossed loser without a later unanswered lapse in $first.username-first order",
    async ({ first, second }) => {
      const template = "non_aggression_pact";
      const firstToSecond = `deal:${first.playerID}:${second.playerID}:${template}:0`;
      const secondToFirst = `deal:${second.playerID}:${first.playerID}:${template}:0`;
      const harness = dealLeagueHarness({
        seats: [first, second],
        scripts: [
          [
            pickWithDeal(null, `deal_propose:${second.playerID}:${template}`),
            pickWithDeal(null, `deal_accept:${secondToFirst}`),
            () => null,
          ],
          [
            pickWithDeal(null, `deal_propose:${first.playerID}:${template}`),
            pickWithDeal(null, `deal_accept:${firstToSecond}`),
            () => null,
          ],
        ],
      });
      await harness.league.runDecisionTurn({ turnNumber: 0 });
      const acceptRecords = await harness.league.runDecisionTurn({
        turnNumber: 25,
      });

      const beforeNextMenu = harness.league.dealLedger();
      expect(
        beforeNextMenu.deals.find((deal) => deal.dealID === secondToFirst),
      ).toMatchObject({ status: "accepted", respondedAtStep: 1 });
      expect(
        beforeNextMenu.deals.find((deal) => deal.dealID === firstToSecond),
      ).toMatchObject({
        status: "superseded",
        respondedAtStep: 1,
        respondedAtTurn: 25,
        supersededByDealID: secondToFirst,
      });
      expect(beforeNextMenu.events.map((event) => event.event)).toEqual([
        "deal_proposed",
        "deal_proposed",
        "deal_accepted",
        "deal_superseded",
      ]);
      expect(beforeNextMenu.events[3]).toMatchObject({
        actorPlayerID: second.playerID,
        targetPlayerID: first.playerID,
        supersededByDealID: secondToFirst,
        publicText: `${second.username}'s acceptance of ${first.username}'s non-aggression pact was redundant; their equivalent deal was already accepted.`,
      });

      const winner = acceptRecords.find(
        (record) => record.agentID === first.agentID,
      )!;
      const crossedLoser = acceptRecords.find(
        (record) => record.agentID === second.agentID,
      )!;
      expect(winner.dealSlotEvidence).toMatchObject({
        validation: {
          accepted: true,
          actionID: `deal_accept:${secondToFirst}`,
        },
        application: { attempted: true, accepted: true },
      });
      expect(crossedLoser).toMatchObject({
        chosenActionID: "hold",
        chosenActionKind: "hold",
        result: { accepted: true },
        dealSlotEvidence: {
          validation: {
            accepted: true,
            actionID: `deal_accept:${firstToSecond}`,
          },
          application: {
            attempted: true,
            accepted: false,
            reason: `redundant accept superseded by equivalent accepted deal: ${secondToFirst}`,
          },
        },
      });
      expect(crossedLoser.decisionMetadata).toMatchObject({
        dealTerminalCause: "redundant_accept_superseded",
        dealSupersededByDealID: secondToFirst,
      });
      expect(
        JSON.parse(
          crossedLoser.decisionMetadata!.dealComplianceEvent as string,
        ),
      ).toEqual([
        expect.objectContaining({
          event: "deal_superseded",
          dealID: firstToSecond,
          supersededByDealID: secondToFirst,
        }),
      ]);
      expect(crossedLoser.legalActionIDs).toContain(
        `deal_accept:${firstToSecond}`,
      );

      await harness.league.runDecisionTurn({ turnNumber: 50 });
      const proposerInput = harness.handles[0].inputs[2];
      const recipientInput = harness.handles[1].inputs[2];
      expect(
        proposerInput.observation.deals?.outgoingProposals.map(
          (proposal) => proposal.dealID,
        ),
      ).not.toContain(firstToSecond);
      expect(
        proposerInput.legalActions.map((action) => action.id),
      ).not.toContain(`deal_withdraw:${firstToSecond}`);
      expect(
        recipientInput.observation.deals?.incomingProposals.map(
          (proposal) => proposal.dealID,
        ),
      ).not.toContain(firstToSecond);
      const recipientMenuIDs = recipientInput.legalActions.map(
        (action) => action.id,
      );
      expect(recipientMenuIDs).not.toContain(`deal_accept:${firstToSecond}`);
      expect(recipientMenuIDs).not.toContain(`deal_reject:${firstToSecond}`);

      // Run beyond the original proposal TTL without a withdrawal. A recorded
      // blocked accept is already terminal and can never be narrated later as
      // an unanswered lapse.
      for (const turnNumber of [75, 100, 125, 150]) {
        await harness.league.runDecisionTurn({ turnNumber });
      }
      harness.league.finalizeDeals({ turnNumber: 150 });
      const finalLedger = harness.league.dealLedger();
      expect(
        finalLedger.deals.find((deal) => deal.dealID === firstToSecond),
      ).toMatchObject({
        status: "superseded",
        respondedAtStep: 1,
        supersededByDealID: secondToFirst,
      });
      const supersededEvents = finalLedger.events.filter(
        (event) =>
          event.event === "deal_superseded" && event.dealID === firstToSecond,
      );
      expect(supersededEvents).toHaveLength(1);
      expect(
        finalLedger.events.some(
          (event) =>
            event.dealID === firstToSecond &&
            (event.event === "deal_expired" ||
              event.publicText.includes("unanswered")),
        ),
      ).toBe(false);
      const evidence = finalLedger.actionEvidence.filter(
        (entry) => entry.selectedActionID === `deal_accept:${firstToSecond}`,
      );
      expect(evidence).toEqual([
        expect.objectContaining({
          offeredActionIDs: expect.arrayContaining([
            `deal_accept:${firstToSecond}`,
          ]),
          managerApplied: false,
          terminalCause: "redundant_accept_superseded",
          supersededByDealID: secondToFirst,
        }),
      ]);
      expect(
        finalLedger.actionEvidence.some(
          (entry) => entry.selectedActionKind === "deal_withdraw",
        ),
      ).toBe(false);
    },
  );

  it("preserves same-step causal append order instead of lexically sorting events", async () => {
    // Participant B applies first, but B's deal id sorts AFTER A's. The
    // immutable ledger must retain application order; sorting by deal id would
    // invert the two server-authored facts within the same decision step.
    const harness = dealLeagueHarness({
      seats: [B, A, C],
      scripts: [
        [pickByID("deal_propose:P_A:non_aggression_pact")],
        [pickByID("deal_propose:P_C:non_aggression_pact")],
        [],
      ],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });

    const events = harness.league.dealLedger().events;
    expect(events.map((event) => [event.step, event.actorPlayerID])).toEqual([
      [0, "P_B"],
      [0, "P_A"],
    ]);
    expect(events[0].dealID > events[1].dealID).toBe(true);
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
    expect(support!.terms.goldAmount).toBe("50000");
    expect(support!.terms.troopAmount).toBe(5000);
    // Non-friendly recipient never gets a support_request offer.
    expect(
      rich!.proposalOptions.some(
        (option) =>
          option.recipientPlayerID === C.playerID &&
          option.terms.template === "support_request",
      ),
    ).toBe(false);
  });

  it("preserves executable crossed proposals with a distinct template, pair, or one-sided target", () => {
    const observe = (
      manager: AgentDealManager,
      seat: StubSeat,
      others: StubSeat[],
    ) =>
      manager.observationFor({
        agentID: seat.agentID,
        observation: stubObservation({
          seat,
          others: others.map((other) => stubVisiblePlayer(other)),
          turnNumber: 25,
        }),
      })!;

    // Same pair, distinct template: accepting B→A NAP must not hide A→B TSP.
    const distinctTemplate = registeredManager([A, B]);
    const tsp = distinctTemplate.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "trade_security_pact"),
      turnNumber: 0,
    }).stamps.dealID as string;
    const nap = distinctTemplate.manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: proposeAction(A, "non_aggression_pact"),
      turnNumber: 0,
    }).stamps.dealID as string;
    distinctTemplate.beginStep(25);
    expect(
      distinctTemplate.manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: responseAction("deal_accept", nap),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);
    expect(
      observe(distinctTemplate.manager, B, [A]).incomingProposals.map(
        (proposal) => proposal.dealID,
      ),
    ).toEqual([tsp]);
    expect(
      distinctTemplate.manager.applyDealAction({
        agentID: B.agentID,
        playerID: B.playerID,
        playerName: B.username,
        action: responseAction("deal_accept", tsp),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);

    // Same template, distinct pair: active A↔B must not hide C→B.
    const distinctPair = registeredManager([A, B, C]);
    const bToA = distinctPair.manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: proposeAction(A, "non_aggression_pact"),
      turnNumber: 0,
    }).stamps.dealID as string;
    const cToB = distinctPair.manager.applyDealAction({
      agentID: C.agentID,
      playerID: C.playerID,
      playerName: C.username,
      action: proposeAction(B, "non_aggression_pact"),
      turnNumber: 0,
    }).stamps.dealID as string;
    distinctPair.beginStep(25);
    expect(
      distinctPair.manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: responseAction("deal_accept", bToA),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);
    expect(
      observe(distinctPair.manager, B, [A, C]).incomingProposals.map(
        (proposal) => proposal.dealID,
      ),
    ).toEqual([cToB]);

    // Reciprocal joint attacks carry different one-sided promises: the
    // proposer is the obligor, and these proposals name different targets.
    const asymmetricTarget = registeredManager([A, B, C, D]);
    const aAttacksC = asymmetricTarget.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "joint_attack", {
        targetID: C.playerID,
        targetName: C.username,
      }),
      turnNumber: 0,
    }).stamps.dealID as string;
    const bAttacksD = asymmetricTarget.manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: proposeAction(A, "joint_attack", {
        targetID: D.playerID,
        targetName: D.username,
      }),
      turnNumber: 0,
    }).stamps.dealID as string;
    asymmetricTarget.beginStep(25);
    expect(
      asymmetricTarget.manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: responseAction("deal_accept", bAttacksD),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);
    const preserved = observe(asymmetricTarget.manager, B, [A, C, D]);
    expect(preserved.incomingProposals).toEqual([
      expect.objectContaining({
        dealID: aAttacksC,
        terms: expect.objectContaining({ targetPlayerID: C.playerID }),
      }),
    ]);
    expect(
      asymmetricTarget.manager.applyDealAction({
        agentID: B.agentID,
        playerID: B.playerID,
        playerName: B.username,
        action: responseAction("deal_accept", aAttacksC),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);
    expect(
      asymmetricTarget.manager
        .ledgerSnapshot()
        .deals.filter((deal) => deal.status === "accepted"),
    ).toHaveLength(2);
  });

  it("keeps proposal menus and apply-time equivalence gates in parity", () => {
    const accept = (
      harness: ReturnType<typeof registeredManager>,
      recipient: StubSeat,
      dealID: string,
    ) => {
      harness.beginStep(25);
      expect(
        harness.manager.applyDealAction({
          agentID: recipient.agentID,
          playerID: recipient.playerID,
          playerName: recipient.username,
          action: responseAction("deal_accept", dealID),
          turnNumber: 25,
        }).result.accepted,
      ).toBe(true);
    };
    const optionsFor = (
      manager: AgentDealManager,
      seat: StubSeat,
      others: ReturnType<typeof stubVisiblePlayer>[],
    ) =>
      manager.observationFor({
        agentID: seat.agentID,
        observation: stubObservation({ seat, others, turnNumber: 25 }),
      })!.proposalOptions;

    // Exact reciprocal trade-security is the same symmetric promise: neither
    // the menu nor applyPropose may offer/accept it again.
    const trade = registeredManager([A, B]);
    const tradeID = trade.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "trade_security_pact"),
      turnNumber: 0,
    }).stamps.dealID as string;
    accept(trade, B, tradeID);
    expect(
      optionsFor(trade.manager, B, [stubVisiblePlayer(A)]).some(
        (option) => option.terms.template === "trade_security_pact",
      ),
    ).toBe(false);
    const duplicateTrade = trade.manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: proposeAction(A, "trade_security_pact"),
      turnNumber: 25,
    });
    expect(duplicateTrade.result).toMatchObject({
      accepted: false,
      reason:
        "an equivalent active trade_security_pact between this pair already exists",
    });

    // Reciprocal support reverses the obligor, so it is a distinct promise in
    // both the offered menu and apply-time gate.
    const support = registeredManager([A, B]);
    const supportID = support.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "support_request"),
      turnNumber: 0,
    }).stamps.dealID as string;
    accept(support, B, supportID);
    const reciprocalSupport = optionsFor(support.manager, B, [
      stubVisiblePlayer(A, { isFriendly: true }),
    ]).find((option) => option.terms.template === "support_request");
    expect(reciprocalSupport).toMatchObject({
      recipientPlayerID: A.playerID,
      terms: { goldAmount: "50000", troopAmount: 5000 },
    });
    expect(
      support.manager.applyDealAction({
        agentID: B.agentID,
        playerID: B.playerID,
        playerName: B.username,
        action: proposeAction(A, "support_request"),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);

    // Reverse joint promises remain distinct because the proposer is the
    // obligor, both when they name the same target and a different target.
    for (const expectedTarget of [C, D]) {
      const joint = registeredManager([A, B, C, D]);
      const jointID = joint.manager.applyDealAction({
        agentID: A.agentID,
        playerID: A.playerID,
        playerName: A.username,
        action: proposeAction(B, "joint_attack", {
          targetID: C.playerID,
          targetName: C.username,
        }),
        turnNumber: 0,
      }).stamps.dealID as string;
      accept(joint, B, jointID);
      const reverseJoint = optionsFor(joint.manager, B, [
        stubVisiblePlayer(A),
        stubVisiblePlayer(C, {
          tilesOwned: expectedTarget === C ? 900 : 100,
        }),
        stubVisiblePlayer(D, {
          tilesOwned: expectedTarget === D ? 900 : 100,
        }),
      ]).find(
        (option) =>
          option.recipientPlayerID === A.playerID &&
          option.terms.template === "joint_attack",
      );
      expect(reverseJoint?.terms.targetPlayerID).toBe(expectedTarget.playerID);
      expect(
        joint.manager.applyDealAction({
          agentID: B.agentID,
          playerID: B.playerID,
          playerName: B.username,
          action: proposeAction(A, "joint_attack", {
            targetID: expectedTarget.playerID,
            targetName: expectedTarget.username,
          }),
          turnNumber: 25,
        }).result.accepted,
      ).toBe(true);
    }

    // Symmetric pacts with distinct durations are distinct exact terms.
    const duration = registeredManager([A, B]);
    const longNap = duration.manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "non_aggression_pact", { durationSteps: 20 }),
      turnNumber: 0,
    }).stamps.dealID as string;
    accept(duration, B, longNap);
    expect(
      optionsFor(duration.manager, B, [stubVisiblePlayer(A)]).find(
        (option) => option.terms.template === "non_aggression_pact",
      )?.terms.durationSteps,
    ).toBe(12);
    expect(
      duration.manager.applyDealAction({
        agentID: B.agentID,
        playerID: B.playerID,
        playerName: B.username,
        action: proposeAction(A, "non_aggression_pact"),
        turnNumber: 25,
      }).result.accepted,
    ).toBe(true);
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

  it("fails closed when a support accept action lacks the server feasibility stamp", () => {
    const { manager, beginStep } = registeredManager([A, B]);
    const proposed = manager.applyDealAction({
      agentID: A.agentID,
      playerID: A.playerID,
      playerName: A.username,
      action: proposeAction(B, "support_request"),
      turnNumber: 0,
    });
    expect(proposed.result.accepted).toBe(true);
    const dealID = proposed.stamps.dealID as string;
    beginStep(25);

    const outcome = manager.applyDealAction({
      agentID: B.agentID,
      playerID: B.playerID,
      playerName: B.username,
      action: responseAction("deal_accept", dealID, {
        supportFeasible: false,
      }),
      turnNumber: 25,
    });

    expect(outcome.result.accepted).toBe(false);
    expect(outcome.result.reason).toContain("currently feasible transfer");
    expect(manager.ledgerSnapshot().deals[0].status).toBe("open");
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
