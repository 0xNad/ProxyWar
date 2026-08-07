import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DEAL_STATED_REASON_LENGTH } from "../../src/server/agents/AgentDealCompliance";
import { DEAL_ACTION_COOLDOWN_STEPS } from "../../src/server/agents/AgentDealManager";
import { validateAgentDealDecision } from "../../src/server/agents/AgentDecisionValidator";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import { sanitizeStatedReason } from "../../src/server/agents/AgentStatedReasonPolicy";
import type {
  AgentDealsObservation,
  AgentDecision,
  AgentDecisionRecord,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import {
  DEALS_FLAG,
  dealLeagueHarness,
  pickByID,
  pickWithDeal,
  stubObservation,
  stubVisiblePlayer,
  type StubSeat,
} from "./DealTestHarness";

// The diplomacy slot (`AgentDecision.dealActionID`, behind
// PROXYWAR_TUNE_STRUCTURED_DEALS): an OPTIONAL second selection applied
// alongside the game action, so negotiating no longer costs the agent its
// move. Covered here: the raw-intent-bypass guard (only the four deal kinds,
// exact id, no fallback), game action + deal action in one step, the
// per-agent proposal cooldown (menu suppression + loud refusal, responses
// never gated), and the VIEWER-ONLY stated reasons — recorded, sanitized,
// omitted when the brain stated none, present in spectator telemetry, and
// absent from every other agent's observation.

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const C: StubSeat = { agentID: "c1", playerID: "P_C", username: "Riven" };

const ROSTER = [A, B, C].map((seat) => ({
  agentID: seat.agentID,
  username: seat.username,
  profile: "diplomatic" as const,
  clientID: `CLNT_${seat.playerID}`,
  brainType: "rule" as const,
}));

const PROPOSE_B_NAP = "deal_propose:P_B:non_aggression_pact";
const NAP_A_TO_B = "deal:P_A:P_B:non_aggression_pact:0";

beforeEach(() => {
  process.env[DEALS_FLAG] = "1";
});

afterEach(() => {
  delete process.env[DEALS_FLAG];
});

function recordFor(
  records: AgentDecisionRecord[],
  seat: StubSeat,
): AgentDecisionRecord {
  const record = records.find(
    (candidate) => candidate.agentID === seat.agentID,
  );
  expect(record, `no record for ${seat.agentID}`).toBeDefined();
  return record!;
}

describe("deal slot — the raw-intent-bypass guard", () => {
  const menu: LegalAction[] = [
    {
      id: "hold",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "none", score: 0 },
    },
    {
      id: "alliance:P_B",
      kind: "alliance_request",
      label: "Request alliance with Sefirot",
      intent: { type: "allianceRequest", recipient: "P_B" },
      risk: { level: "low", score: 0.2 },
    },
    {
      id: `deal_accept:${NAP_A_TO_B}`,
      kind: "deal_accept",
      label: "Accept",
      intent: null,
      risk: { level: "medium", score: 0.35 },
    },
  ];
  const decision = (dealActionID?: string | null): AgentDecision => ({
    actionID: "hold",
    reason: "test",
    ...(dealActionID !== undefined ? { dealActionID } : {}),
  });

  it("returns null (shipped path untouched) when the field is absent or blank", () => {
    expect(validateAgentDealDecision(decision(), menu)).toBeNull();
    expect(validateAgentDealDecision(decision(null), menu)).toBeNull();
    expect(validateAgentDealDecision(decision("   "), menu)).toBeNull();
  });

  it("accepts exactly one offered deal id", () => {
    const validation = validateAgentDealDecision(
      decision(`deal_accept:${NAP_A_TO_B}`),
      menu,
    );
    expect(validation).toEqual({ ok: true, action: menu[2] });
  });

  it("rejects an id naming a GAME action, an off-menu id, and offers no fallback", () => {
    const gameAction = validateAgentDealDecision(
      decision("alliance:P_B"),
      menu,
    );
    expect(gameAction).toEqual({
      ok: false,
      reason:
        "deal selection named a non-deal action kind (alliance_request): alliance:P_B",
    });
    expect(gameAction).not.toHaveProperty("action");
    expect(gameAction).not.toHaveProperty("fallback");
    expect(validateAgentDealDecision(decision("hold"), menu)).toMatchObject({
      ok: false,
      reason: "deal selection named a non-deal action kind (hold): hold",
    });
    expect(
      validateAgentDealDecision(decision("deal_accept:not-offered"), menu),
    ).toEqual({
      ok: false,
      reason: "deal selection named unknown action id: deal_accept:not-offered",
    });
  });
});

describe("deal slot — league submission pass", () => {
  it("refuses a game action in the deal slot: nothing is submitted and the record says so", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      // `alliance:P_B` is a real offered action carrying a game INTENT.
      scripts: [[pickWithDeal(null, "alliance:P_B")], [], []],
    });
    const step0 = await harness.league.runDecisionTurn({ turnNumber: 0 });
    const record = recordFor(step0, A);

    expect(record.chosenActionKind).toBe("hold");
    expect(record.intent).toBeNull();
    expect(record.result).toEqual({
      accepted: true,
      reason: "hold action selected; no game intent submitted",
      submittedIntent: null,
    });
    expect(record.decisionMetadata?.dealSlotRejected).toBe(
      "deal selection named a non-deal action kind (alliance_request): alliance:P_B",
    );
    expect(record.decisionMetadata?.dealSlotRequestedID).toBe("alliance:P_B");
    // No deal was applied, and no second record was produced for the seat.
    expect(record.decisionMetadata?.dealAction).toBeUndefined();
    expect(step0.filter((entry) => entry.agentID === A.agentID)).toHaveLength(
      1,
    );
    expect(harness.league.dealLedger().deals).toEqual([]);
  });

  it("refuses an off-menu deal id without touching the game action", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(null, "deal_accept:deal:invented")], [], []],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );
    expect(record.decisionMetadata?.dealSlotRejected).toBe(
      "deal selection named unknown action id: deal_accept:deal:invented",
    );
    expect(harness.league.dealLedger().deals).toEqual([]);
  });

  it("applies the game action AND the deal action in the same step, stamping one record", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          pickWithDeal(
            "alliance:P_C",
            PROPOSE_B_NAP,
            "flank first, pact second",
          ),
        ],
        [],
        [],
      ],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );

    // The GAME action still owns the decision: kind, id, intent and result.
    expect(record.chosenActionID).toBe("alliance:P_C");
    expect(record.chosenActionKind).toBe("alliance_request");
    expect(record.intent).toEqual({
      type: "allianceRequest",
      recipient: C.playerID,
    });
    // ...and the deal applied independently of how the game action fared.
    expect(record.result.accepted).toBe(false);
    expect(record.decisionMetadata).toMatchObject({
      dealAction: "propose",
      dealID: NAP_A_TO_B,
      dealTemplate: "non_aggression_pact",
      dealCounterpartyID: B.playerID,
      dealApplyAccepted: true,
      dealSeparateSlot: true,
      dealSlotResult: `deal proposed: ${NAP_A_TO_B}`,
    });
    expect(
      harness.league.dealLedger().deals.map((deal) => deal.dealID),
    ).toEqual([NAP_A_TO_B]);
  });

  it("refuses to apply the same deal action twice (action slot and deal slot)", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(PROPOSE_B_NAP, PROPOSE_B_NAP)], [], []],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );
    expect(record.decisionMetadata?.dealAction).toBe("propose");
    expect(record.decisionMetadata?.dealSlotRejected).toBe(
      "a deal action was already played as this decision's game action",
    );
    expect(harness.league.dealLedger().deals).toHaveLength(1);
  });

  // ONE deal action per decision. Two would collide on the same record stamp
  // keys, so the second would silently overwrite the first: the record would
  // name an action that never happened and the overwritten deal's spectator
  // beat would vanish while the deal itself stayed live.
  it("refuses a DIFFERENT deal action in the slot when the action slot already played one", async () => {
    // B offers A a pact at step 0; at step 1 A accepts it as its game action
    // and also asks to open a new offer to C through the deal slot.
    const dealID = "deal:P_B:P_A:non_aggression_pact:0";
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          () => null,
          pickWithDeal(
            `deal_accept:${dealID}`,
            "deal_propose:P_C:non_aggression_pact",
            "sealing the pact",
          ),
        ],
        [pickWithDeal(null, "deal_propose:P_A:non_aggression_pact")],
        [],
      ],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const step1 = await harness.league.runDecisionTurn({ turnNumber: 25 });
    const record = recordFor(step1, A);

    // The record's deal stamps are coherent and belong to the ACCEPT.
    expect(record.chosenActionID).toBe(`deal_accept:${dealID}`);
    expect(record.chosenActionKind).toBe("deal_accept");
    expect(record.decisionMetadata).toMatchObject({
      dealAction: "accept",
      dealID,
      dealCounterpartyID: B.playerID,
      dealApplyAccepted: true,
      dealPublicText:
        "Auri accepted Sefirot's non-aggression pact (12 decisions).",
      dealStatedReason: "sealing the pact",
      dealSlotRejected:
        "a deal action was already played as this decision's game action",
      dealSlotRequestedID: "deal_propose:P_C:non_aggression_pact",
    });
    expect(record.decisionMetadata?.dealSeparateSlot).toBeUndefined();

    // The ledger gained NO second entry, and the pact is live.
    const ledger = harness.league.dealLedger();
    expect(ledger.deals.map((deal) => deal.dealID)).toEqual([dealID]);
    expect(ledger.deals[0].status).toBe("accepted");

    // The accepted pact's story beat survives into spectator telemetry.
    const events = buildAgentSpectatorTelemetry({
      runID: "DEAL_SLOT_COLLISION",
      records: harness.records(),
      roster: ROSTER,
    }).events.filter((event) => event.kind.startsWith("deal_"));
    expect(events.map((event) => event.kind)).toEqual([
      "deal_proposed",
      "deal_accepted",
    ]);
    expect(events[1]).toMatchObject({
      tone: "pact",
      importance: 78,
      actorAgentID: A.agentID,
      statedReason: "sealing the pact",
    });
  });

  it("refuses a second action on the SAME deal (reject in the action slot, accept in the deal slot)", async () => {
    const dealID = "deal:P_B:P_A:non_aggression_pact:0";
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          () => null,
          pickWithDeal(`deal_reject:${dealID}`, `deal_accept:${dealID}`),
        ],
        [pickWithDeal(null, "deal_propose:P_A:non_aggression_pact")],
        [],
      ],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 25 }),
      A,
    );

    // Only the reject happened, and every stamp on the record describes it.
    expect(record.chosenActionKind).toBe("deal_reject");
    expect(record.decisionMetadata).toMatchObject({
      dealAction: "reject",
      dealID,
      dealApplyAccepted: true,
      dealPublicText: "Auri rejected Sefirot's non-aggression pact.",
      dealSlotRejected:
        "a deal action was already played as this decision's game action",
    });
    const ledger = harness.league.dealLedger();
    expect(ledger.deals.map((deal) => deal.dealID)).toEqual([dealID]);
    expect(ledger.deals[0].status).toBe("rejected");
    expect(
      buildAgentSpectatorTelemetry({
        runID: "DEAL_SLOT_SAME_DEAL",
        records: harness.records(),
        roster: ROSTER,
      })
        .events.filter((event) => event.kind.startsWith("deal_"))
        .map((event) => event.kind),
    ).toEqual(["deal_proposed", "deal_rejected"]);
  });

  it("caps the agent-controlled id it stamps into the decision record", async () => {
    const huge = `deal_accept:${"z".repeat(5_000)}`;
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(null, huge)], [], []],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );
    const requested = record.decisionMetadata?.dealSlotRequestedID as string;
    const rejected = record.decisionMetadata?.dealSlotRejected as string;
    expect(requested.length).toBe(120);
    expect(rejected.length).toBeLessThanOrEqual(200);
    expect(rejected).toContain("(5012 chars)");
    expect(JSON.stringify(record).length).toBeLessThan(12_000);
  });
});

describe("deal slot — proposal cooldown", () => {
  it("suppresses further proposals from the menu while responses stay available", async () => {
    // Step 0: A offers B a pact; B offers C one (so B is on cooldown too).
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [pickWithDeal(null, PROPOSE_B_NAP)],
        [
          pickWithDeal(null, "deal_propose:P_C:non_aggression_pact"),
          pickWithDeal(null, `deal_accept:${NAP_A_TO_B}`),
        ],
        [],
      ],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const step1 = await harness.league.runDecisionTurn({ turnNumber: 25 });

    const menuAtStep1 = (seatIndex: number) =>
      harness.handles[seatIndex].inputs[1].legalActions.map(
        (action) => action.id,
      );
    // Both proposers are inside the cooldown window: no propose option is
    // offered to either of them at all.
    for (const seatIndex of [0, 1]) {
      expect(
        menuAtStep1(seatIndex).filter((id) => id.startsWith("deal_propose:")),
      ).toEqual([]);
      expect(
        harness.handles[seatIndex].inputs[1].observation.deals!.proposalOptions,
      ).toEqual([]);
    }
    // C never proposed, so C still sees its options.
    expect(
      menuAtStep1(2).filter((id) => id.startsWith("deal_propose:")).length,
    ).toBeGreaterThan(0);

    // Responses are NEVER gated by the cooldown: B answers A's offer while
    // still inside its own proposal window, and the pact activates.
    expect(menuAtStep1(1)).toContain(`deal_accept:${NAP_A_TO_B}`);
    expect(menuAtStep1(1)).toContain(`deal_reject:${NAP_A_TO_B}`);
    expect(recordFor(step1, B).decisionMetadata).toMatchObject({
      dealAction: "accept",
      dealID: NAP_A_TO_B,
      dealApplyAccepted: true,
      dealSeparateSlot: true,
    });
    expect(
      harness.league
        .dealLedger()
        .deals.find((deal) => deal.dealID === NAP_A_TO_B)!.status,
    ).toBe("accepted");
  });

  it("refuses a second proposal inside the window loudly when one is asked for anyway", async () => {
    // Step 1 still offers no propose action, so the request is rejected by
    // exact-id validation; by step 3 the cooldown has cleared and it lands.
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          pickWithDeal(null, PROPOSE_B_NAP),
          pickWithDeal(null, "deal_propose:P_C:non_aggression_pact"),
          pickWithDeal(null, "deal_propose:P_C:non_aggression_pact"),
          pickWithDeal(null, "deal_propose:P_C:non_aggression_pact"),
        ],
        [],
        [],
      ],
    });
    const steps: AgentDecisionRecord[][] = [];
    for (let step = 0; step < 4; step += 1) {
      steps.push(
        await harness.league.runDecisionTurn({ turnNumber: step * 25 }),
      );
    }
    expect(DEAL_ACTION_COOLDOWN_STEPS).toBe(3);
    for (const step of [1, 2]) {
      expect(recordFor(steps[step], A).decisionMetadata?.dealSlotRejected).toBe(
        "deal selection named unknown action id: deal_propose:P_C:non_aggression_pact",
      );
    }
    expect(recordFor(steps[3], A).decisionMetadata).toMatchObject({
      dealAction: "propose",
      dealApplyAccepted: true,
      dealCounterpartyID: C.playerID,
    });
  });
});

describe("stated reasons — recorded, sanitized, viewer-only", () => {
  const PROPOSER_CLAIM = "Pact buys me the western flank for twelve decisions";
  const ACCEPTOR_CLAIM = "Taking it to buy time while I rebuild troops";

  async function runPactWithClaims() {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [pickWithDeal(null, PROPOSE_B_NAP, PROPOSER_CLAIM)],
        [
          () => null,
          pickWithDeal(null, `deal_accept:${NAP_A_TO_B}`, ACCEPTOR_CLAIM),
        ],
        [],
      ],
    });
    for (let step = 0; step < 3; step += 1) {
      await harness.league.runDecisionTurn({ turnNumber: step * 25 });
    }
    return harness;
  }

  it("stamps the proposer's and acceptor's own reasons onto the ledger and the records", async () => {
    const harness = await runPactWithClaims();
    const deal = harness.league
      .dealLedger()
      .deals.find((candidate) => candidate.dealID === NAP_A_TO_B)!;
    expect(deal.proposerStatedReason).toBe(PROPOSER_CLAIM);
    expect(deal.acceptorStatedReason).toBe(ACCEPTOR_CLAIM);

    const records = harness.records();
    expect(
      records.find(
        (record) => record.decisionMetadata?.dealAction === "propose",
      )!.decisionMetadata!.dealStatedReason,
    ).toBe(PROPOSER_CLAIM);
    expect(
      records.find(
        (record) => record.decisionMetadata?.dealAction === "accept",
      )!.decisionMetadata!.dealStatedReason,
    ).toBe(ACCEPTOR_CLAIM);

    // The ledger events keep the CLAIM separate from the server-authored FACT.
    const proposed = harness.league
      .dealLedger()
      .events.find((event) => event.event === "deal_proposed")!;
    expect(proposed.statedReason).toBe(PROPOSER_CLAIM);
    expect(proposed.publicText).not.toContain(PROPOSER_CLAIM);
    expect(proposed.publicText).toBe(
      "Auri proposed a non-aggression pact to Sefirot (12 decisions).",
    );
  });

  it("surfaces them on spectator events in their own field, never inside publicText", async () => {
    const harness = await runPactWithClaims();
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "DEAL_SLOT_TELEMETRY",
      records: harness.records(),
      roster: ROSTER,
    });
    const proposed = telemetry.events.find(
      (event) => event.kind === "deal_proposed",
    )!;
    const accepted = telemetry.events.find(
      (event) => event.kind === "deal_accepted",
    )!;
    expect(proposed.statedReason).toBe(PROPOSER_CLAIM);
    expect(accepted.statedReason).toBe(ACCEPTOR_CLAIM);
    for (const event of [proposed, accepted]) {
      expect(event.publicText).not.toContain(event.statedReason);
      expect(event.message).not.toContain(event.statedReason);
    }
    // ...and the artifact as a whole DOES carry them (viewer surface).
    expect(JSON.stringify(telemetry)).toContain(PROPOSER_CLAIM);
  });

  it("PRIVACY: no other agent's observation or menu ever contains them", async () => {
    const harness = await runPactWithClaims();
    const seen = (seatIndex: number) =>
      harness.handles[seatIndex].inputs.map((input) =>
        JSON.stringify({
          observation: input.observation,
          legalActions: input.legalActions,
        }),
      );
    // The counterparty (B) never sees the proposer's rationale; the third
    // seat (C) never sees either party's. Agent-authored text entering
    // another agent's prompt would be an instruction-injection channel.
    for (const payload of seen(1)) {
      expect(payload).not.toContain(PROPOSER_CLAIM);
      expect(payload).not.toContain("western flank");
    }
    for (const payload of seen(2)) {
      expect(payload).not.toContain(PROPOSER_CLAIM);
      expect(payload).not.toContain(ACCEPTOR_CLAIM);
      expect(payload).not.toContain("western flank");
      expect(payload).not.toContain("rebuild troops");
    }
    for (const payload of seen(0)) {
      expect(payload).not.toContain(ACCEPTOR_CLAIM);
      expect(payload).not.toContain("rebuild troops");
    }
    // The bilateral block the counterparty DOES see carries structured terms.
    const bStep1 = harness.handles[1].inputs[1].observation.deals!;
    expect(bStep1.incomingProposals).toHaveLength(1);
    expect(Object.keys(bStep1.incomingProposals[0]).sort()).toEqual([
      "answerableThroughStep",
      "dealID",
      "proposedAtStep",
      "proposerName",
      "proposerPlayerID",
      "recipientName",
      "recipientPlayerID",
      "terms",
    ]);
  });

  it("sanitizes to printable ASCII, collapses whitespace, and caps the length", async () => {
    // Escape sequences only - no literal invisible characters in source.
    const messy =
      "line one\nline\ttwo    caf\u00e9 \u202eRTL\u202c " + "x".repeat(200);
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(null, PROPOSE_B_NAP, messy)], [], []],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const stored = harness.league.dealLedger().deals[0].proposerStatedReason!;
    expect(stored.length).toBe(MAX_DEAL_STATED_REASON_LENGTH);
    expect(stored).toMatch(/^[\x20-\x7e]+$/);
    expect(stored).not.toContain("  ");
    expect(stored.startsWith("line one line two caf RTL xxx")).toBe(true);
  });

  it("omits the field entirely when the brain stated no reason (never substitutes text)", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(null, PROPOSE_B_NAP, null)], [], []],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );
    expect(record.reason).toBeNull();
    expect(record.decisionMetadata).not.toHaveProperty("dealStatedReason");
    const ledger = harness.league.dealLedger();
    expect(ledger.deals[0]).not.toHaveProperty("proposerStatedReason");
    expect(ledger.events[0]).not.toHaveProperty("statedReason");
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "DEAL_SLOT_NO_REASON",
      records: harness.records(),
      roster: ROSTER,
    });
    expect(
      telemetry.events.find((event) => event.kind === "deal_proposed"),
    ).not.toHaveProperty("statedReason");
  });

  it("keeps a blank or whitespace-only reason out of the artifact", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(null, PROPOSE_B_NAP, "   \n  ")], [], []],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    expect(harness.league.dealLedger().deals[0]).not.toHaveProperty(
      "proposerStatedReason",
    );
  });
});

/**
 * PROVENANCE, not text. When a brain fails it SUBSTITUTES a synthesized
 * reason and returns a complete decision, and on this lineage
 * (`AgentDecision.reason: string`, not upstream's `string | null`) that text
 * is indistinguishable by content from a genuine one — several real
 * substitutions are benign enough to clear the denylist outright. Publishing
 * one as an agent's motive for a pact or a betrayal would be a fabrication,
 * so every stated-reason stamp gates on `reasonIsBrainAuthored` first.
 */
describe("stated reasons — fallback provenance gate", () => {
  const GENUINE = "Pact buys me the western flank for twelve decisions";
  // The real LlmAgentBrain no-legal-actions substitution: benign wording that
  // passes the denylist unchanged, which is exactly why text filtering alone
  // is not enough.
  const SUBSTITUTED =
    "No legal actions were offered; requested safe hold fallback.";
  const FALLBACK_METADATA = { fallbackUsed: true, llmParseOk: false };

  it("the substituted text would clear the content denylist on its own", () => {
    // Guards the premise: if this ever starts returning null the gate is still
    // correct, but this suite would stop proving what it claims to prove.
    expect(sanitizeStatedReason(SUBSTITUTED)).toBe(SUBSTITUTED);
  });

  it("omits the stated reason everywhere when the deal decision fell back", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [pickWithDeal(null, PROPOSE_B_NAP, SUBSTITUTED, FALLBACK_METADATA)],
        [],
        [],
      ],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );

    // The decision still carries the substitute text...
    expect(record.reason).toBe(SUBSTITUTED);
    expect(record.decisionMetadata?.fallbackUsed).toBe(true);
    // ...and none of the three published surfaces repeat it.
    expect(record.decisionMetadata).not.toHaveProperty("dealStatedReason");
    const ledger = harness.league.dealLedger();
    expect(ledger.deals[0]).not.toHaveProperty("proposerStatedReason");
    expect(ledger.events[0]).not.toHaveProperty("statedReason");
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "DEAL_SLOT_FALLBACK",
      records: harness.records(),
      roster: ROSTER,
    });
    expect(
      telemetry.events.find((event) => event.kind === "deal_proposed"),
    ).not.toHaveProperty("statedReason");
    expect(JSON.stringify(telemetry)).not.toContain(SUBSTITUTED);
  });

  it("omits it on the diplomacy slot too when that decision fell back", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [pickWithDeal("hold", PROPOSE_B_NAP, SUBSTITUTED, FALLBACK_METADATA)],
        [],
        [],
      ],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );
    // The deal really did go through the separate slot beside a game action.
    expect(record.decisionMetadata?.dealSeparateSlot).toBe(true);
    expect(record.decisionMetadata).not.toHaveProperty("dealStatedReason");
    const ledger = harness.league.dealLedger();
    expect(ledger.deals[0]).not.toHaveProperty("proposerStatedReason");
    expect(ledger.events[0]).not.toHaveProperty("statedReason");
  });

  it("a parser failure alone is enough to suppress it", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          pickWithDeal(null, PROPOSE_B_NAP, SUBSTITUTED, {
            parseSuccess: false,
          }),
        ],
        [],
        [],
      ],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    expect(harness.league.dealLedger().deals[0]).not.toHaveProperty(
      "proposerStatedReason",
    );
  });

  it("still publishes a genuine reason when the brain authored it", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          pickWithDeal(null, PROPOSE_B_NAP, GENUINE, {
            fallbackUsed: false,
            llmParseOk: true,
          }),
        ],
        [],
        [],
      ],
    });
    const record = recordFor(
      await harness.league.runDecisionTurn({ turnNumber: 0 }),
      A,
    );
    expect(record.decisionMetadata!.dealStatedReason).toBe(GENUINE);
    const ledger = harness.league.dealLedger();
    expect(ledger.deals[0].proposerStatedReason).toBe(GENUINE);
    expect(ledger.events[0].statedReason).toBe(GENUINE);
    const telemetry = buildAgentSpectatorTelemetry({
      runID: "DEAL_SLOT_GENUINE",
      records: harness.records(),
      roster: ROSTER,
    });
    expect(
      telemetry.events.find((event) => event.kind === "deal_proposed")!
        .statedReason,
    ).toBe(GENUINE);
  });

  it("treats a decision with no provenance metadata as brain-authored", async () => {
    // Deterministic brains (rule/strategy) author reasons without setting any
    // failure key; the gate must not silently erase them.
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal(null, PROPOSE_B_NAP, GENUINE)], [], []],
    });
    await harness.league.runDecisionTurn({ turnNumber: 0 });
    expect(harness.league.dealLedger().deals[0].proposerStatedReason).toBe(
      GENUINE,
    );
  });
});

describe("deal menu — budget under pressure", () => {
  // Deals ride their own slot now, but they are still MENU entries, so the
  // assembly budget and the reserved-diplomacy protection must still hold.
  // (Reserved-slot protection itself is pinned in StructuredDealsFlag.test.ts:
  // 100 attacks + 3 deal actions at cap 96 / reserve 8 keeps all three.)
  function crowdedDeals(): AgentDealsObservation {
    const proposal = (proposer: StubSeat, template: string) => ({
      dealID: `deal:${proposer.playerID}:P_A:${template}:1`,
      proposerPlayerID: proposer.playerID,
      proposerName: proposer.username,
      recipientPlayerID: A.playerID,
      recipientName: A.username,
      terms: { template, durationSteps: 12 } as never,
      proposedAtStep: 1,
      answerableThroughStep: 5,
    });
    return {
      decisionStep: 2,
      incomingProposals: [
        proposal(B, "non_aggression_pact"),
        proposal(C, "non_aggression_pact"),
      ],
      outgoingProposals: [],
      activeDeals: [],
      proposalOptions: [
        {
          recipientPlayerID: B.playerID,
          recipientName: B.username,
          terms: { template: "trade_security_pact", durationSteps: 12 },
        },
      ],
      rivalReliability: [],
    };
  }

  it("stops at the budget and never offers an accept without its reject", () => {
    const observation = {
      ...stubObservation({
        seat: A,
        others: [stubVisiblePlayer(B), stubVisiblePlayer(C)],
        turnNumber: 42,
      }),
      deals: crowdedDeals(),
    };
    const builder = new LegalActionBuilder();
    const dealsAt = (maxPostSpawnActions?: number) =>
      builder
        .build({
          observation,
          ...(maxPostSpawnActions !== undefined ? { maxPostSpawnActions } : {}),
        })
        .filter((action) => action.kind.startsWith("deal_"))
        .map((action) => action.id);
    const pairB = [
      "deal_accept:deal:P_B:P_A:non_aggression_pact:1",
      "deal_reject:deal:P_B:P_A:non_aggression_pact:1",
    ];
    const pairC = [
      "deal_accept:deal:P_C:P_A:non_aggression_pact:1",
      "deal_reject:deal:P_C:P_A:non_aggression_pact:1",
    ];

    // Uncapped: both incoming pairs plus the one propose option.
    expect(dealsAt()).toEqual([
      ...pairB,
      ...pairC,
      "deal_propose:P_B:trade_security_pact",
    ]);
    // 11 non-deal actions precede the deal block here, so the cap sets the
    // deal budget directly. One free slot is not enough for a pair, and a
    // half-pair is never emitted: a menu that can accept but not reject
    // would bias the answer.
    expect(dealsAt(12)).toEqual([]);
    expect(dealsAt(13)).toEqual(pairB);
    expect(dealsAt(14)).toEqual(pairB);
    expect(dealsAt(15)).toEqual([...pairB, ...pairC]);
    // Every budget keeps accepts and rejects balanced.
    for (const cap of [12, 13, 14, 15, 16, undefined]) {
      const ids = dealsAt(cap);
      expect(ids.filter((id) => id.startsWith("deal_accept:")).length).toBe(
        ids.filter((id) => id.startsWith("deal_reject:")).length,
      );
    }
  });
});

describe("deal slot — untouched when unused", () => {
  it("a decision that never sets the field behaves exactly as before", async () => {
    const withoutField = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickByID("hold")], [], []],
    });
    const explicitlyNull = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [[pickWithDeal("hold", null)], [], []],
    });
    const normalize = (records: AgentDecisionRecord[]) =>
      JSON.stringify(
        records.map((record) => ({
          ...record,
          decidedAt: 0,
          decisionLatencyMs: 0,
        })),
      );
    const first = await withoutField.league.runDecisionTurn({ turnNumber: 0 });
    const second = await explicitlyNull.league.runDecisionTurn({
      turnNumber: 0,
    });
    expect(normalize(second)).toBe(normalize(first));
    expect(normalize(first)).not.toContain("dealSlot");
  });
});
