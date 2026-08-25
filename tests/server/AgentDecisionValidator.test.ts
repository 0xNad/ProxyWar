import { describe, expect, it } from "vitest";
import {
  validateAgentDealDecision,
  validateAgentDecision,
  validateAgentDecisionBatch,
  validateAgentMessageDecision,
} from "../../src/server/agents/AgentDecisionValidator";
import type {
  AgentDecision,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

const hold: LegalAction = {
  id: "hold",
  kind: "hold",
  label: "Hold",
  intent: null,
  risk: { level: "none", score: 0 },
};

const ordinary: LegalAction = {
  id: "attack:P_B:25",
  kind: "attack",
  label: "Attack P_B with 25%",
  intent: { type: "attack", targetID: "P_B", troops: 25 },
  risk: { level: "medium", score: 0.5 },
};

const deals: LegalAction[] = [
  {
    id: "deal_propose:P_B:non_aggression_pact",
    kind: "deal_propose",
    label: "Propose pact",
    intent: null,
    risk: { level: "low", score: 0.1 },
  },
  {
    id: "deal_accept:D1",
    kind: "deal_accept",
    label: "Accept pact",
    intent: null,
    risk: { level: "none", score: 0 },
  },
  {
    id: "deal_reject:D1",
    kind: "deal_reject",
    label: "Reject pact",
    intent: null,
    risk: { level: "none", score: 0 },
  },
  {
    id: "deal_withdraw:D2",
    kind: "deal_withdraw",
    label: "Withdraw pact",
    intent: null,
    risk: { level: "low", score: 0.1 },
  },
];

const message: LegalAction = {
  id: "message:P_B",
  kind: "message",
  label: "Message P_B",
  intent: null,
  risk: { level: "none", score: 0 },
  metadata: { recipientID: "P_B" },
};

const menu = [hold, ordinary, ...deals, message];
const ordinaryOnly = {
  primaryActionPolicy: "ordinary-only" as const,
};

function decision(actionID: string, actionIDs?: string[]): AgentDecision {
  return {
    actionID,
    ...(actionIDs === undefined ? {} : { actionIDs }),
    reason: "validator contract test",
  };
}

describe("AgentDecisionValidator primary-slot policy", () => {
  it("rejects a batch whose primary entry disagrees with the scalar action id", () => {
    expect(
      validateAgentDecisionBatch(
        decision(hold.id, [ordinary.id, hold.id]),
        menu,
      ),
    ).toEqual({
      ok: false,
      actions: [hold],
      rejectedActionIDs: [hold.id, ordinary.id],
      fallback: hold,
      reason: `decision batch primary did not match scalar action id: ${ordinary.id} != ${hold.id}`,
    });
  });

  it("rejects both authorities when the scalar id is absent from the batch", () => {
    expect(
      validateAgentDecisionBatch(decision(hold.id, [ordinary.id]), menu),
    ).toEqual({
      ok: false,
      actions: [hold],
      rejectedActionIDs: [hold.id, ordinary.id],
      fallback: hold,
      reason: `decision batch primary did not match scalar action id: ${ordinary.id} != ${hold.id}`,
    });
  });

  it("pins legacy scalar and batch compatibility for all four deal kinds", () => {
    for (const deal of deals) {
      expect(validateAgentDecision(decision(deal.id), menu)).toEqual({
        ok: true,
        action: deal,
      });
    }

    expect(
      validateAgentDecisionBatch(
        decision(
          deals[0].id,
          deals.map((deal) => deal.id),
        ),
        menu,
      ),
    ).toEqual({
      ok: true,
      actions: deals,
      rejectedActionIDs: [],
      fallback: null,
      reason: "all requested action ids are legal",
    });

    // A response can write arbitrary bounded decision metadata, but it cannot
    // opt itself into or out of a server validation contract.
    expect(
      validateAgentDecision(
        {
          ...decision(deals[0].id),
          metadata: { primaryActionPolicy: "ordinary-only" },
        },
        menu,
      ),
    ).toEqual({ ok: true, action: deals[0] });
  });

  it("rejects a primary message in both scalar and batch validation under the legacy contract", () => {
    expect(validateAgentDecision(decision(message.id), menu)).toEqual({
      ok: false,
      reason:
        "message actions belong in the comms slot (messageActionID + messageText), not the game action slot; nothing was sent",
      fallback: hold,
    });

    expect(
      validateAgentDecisionBatch(
        decision(ordinary.id, [ordinary.id, message.id]),
        menu,
      ),
    ).toEqual({
      ok: false,
      actions: [ordinary],
      rejectedActionIDs: [message.id],
      fallback: null,
      reason: `ignored primary-slot-forbidden action ids: ${message.id}`,
    });
  });

  it("rejects every deal and message primary under ordinary-only while preserving ordinary actions", () => {
    expect(
      validateAgentDecision(decision(ordinary.id), menu, ordinaryOnly),
    ).toEqual({ ok: true, action: ordinary });
    for (const deal of deals) {
      expect(
        validateAgentDecision(decision(deal.id), menu, ordinaryOnly),
      ).toEqual({
        ok: false,
        reason:
          "deal actions belong in the diplomacy slot (dealActionID), not the ordinary game action slot under the in-house social prompt contract",
        fallback: hold,
      });
    }
    expect(
      validateAgentDecision(decision(message.id), menu, ordinaryOnly),
    ).toMatchObject({ ok: false, fallback: hold });
  });

  it("keeps a mixed ordinary-only batch, rejecting forbidden and unknown ids in request order", () => {
    const unknown = "invented:raw-intent";
    expect(
      validateAgentDecisionBatch(
        decision(ordinary.id, [ordinary.id, deals[0].id, message.id, unknown]),
        menu,
        ordinaryOnly,
      ),
    ).toEqual({
      ok: false,
      actions: [ordinary],
      rejectedActionIDs: [deals[0].id, message.id, unknown],
      fallback: null,
      reason: `ignored unknown action ids: ${unknown}; primary-slot-forbidden action ids: ${deals[0].id},${message.id}`,
    });
  });

  it("uses the existing hold fallback when an ordinary-only batch contains only side-slot ids", () => {
    expect(
      validateAgentDecisionBatch(
        decision(deals[0].id, [deals[0].id, message.id]),
        menu,
        ordinaryOnly,
      ),
    ).toEqual({
      ok: false,
      actions: [hold],
      rejectedActionIDs: [deals[0].id, message.id],
      fallback: hold,
      reason: `decision selected no primary-slot-eligible action ids: ${deals[0].id},${message.id}`,
    });
  });

  it("leaves exact-id deal and message side-slot validation unchanged", () => {
    const sideSlotDecision: AgentDecision = {
      actionID: ordinary.id,
      dealActionID: deals[0].id,
      messageActionID: message.id,
      messageText: "Pact first, pressure elsewhere.",
      reason: "Use both bounded side slots",
    };

    expect(validateAgentDealDecision(sideSlotDecision, menu)).toEqual({
      ok: true,
      action: deals[0],
    });
    expect(validateAgentMessageDecision(sideSlotDecision, menu)).toEqual({
      ok: true,
      action: message,
      text: "Pact first, pressure elsewhere.",
    });
  });
});
