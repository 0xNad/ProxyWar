import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { AgentDealManager } from "../../src/server/agents/AgentDealManager";
import type {
  AgentDecisionRecord,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { setup } from "../util/Setup";
import {
  DEALS_FLAG,
  fabricatedRecord,
  stubObservation,
  stubVisiblePlayer,
  type StubSeat,
} from "./DealTestHarness";

// Phase B compliance referee (PROXYWAR_TUNE_STRUCTURED_DEALS): judges
// CONFIRMED game effects only — decision records' audit/result data and
// game-state liveness facts, never merely selected actions. The victim's
// automatic attack-created embargo is never the victim's violation;
// emoji/quick_chat/target_player are never violations; every accepted
// obligation reaches a terminal state by match end (force-resolve).

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const C: StubSeat = { agentID: "c1", playerID: "P_C", username: "Riven" };

beforeEach(() => {
  process.env[DEALS_FLAG] = "1";
});

afterEach(() => {
  delete process.env[DEALS_FLAG];
});

interface ComplianceHarness {
  manager: AgentDealManager;
  records: AgentDecisionRecord[];
  step: () => number;
  beginStep: (turnNumber?: number) => void;
  propose: (
    proposer: StubSeat,
    recipient: StubSeat,
    template: string,
    metadata?: Record<string, string | number | boolean | null>,
  ) => string;
  respond: (
    kind: "deal_accept" | "deal_reject" | "deal_withdraw",
    seat: StubSeat,
    dealID: string,
  ) => { accepted: boolean; reason: string };
  push: (record: AgentDecisionRecord) => void;
}

function complianceHarness(seats: StubSeat[]): ComplianceHarness {
  const manager = new AgentDealManager();
  const records: AgentDecisionRecord[] = [];
  let sequence = 0;
  const beginStep = (turnNumber?: number) =>
    manager.beginDecisionStep({
      turnNumber: turnNumber ?? manager.currentDecisionStep() * 25 + 25,
      records,
    });
  manager.beginDecisionStep({ turnNumber: 0, records });
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
  return {
    manager,
    records,
    step: () => manager.currentDecisionStep(),
    beginStep,
    propose: (proposer, recipient, template, metadata = {}) => {
      const action: LegalAction = {
        id: `deal_propose:${recipient.playerID}:${template}`,
        kind: "deal_propose",
        label: "propose",
        intent: null,
        risk: { level: "low", score: 0.15 },
        metadata: {
          recipientID: recipient.playerID,
          recipientName: recipient.username,
          template,
          ...metadata,
        },
      };
      const outcome = manager.applyDealAction({
        agentID: proposer.agentID,
        playerID: proposer.playerID,
        playerName: proposer.username,
        action,
        turnNumber: 0,
      });
      expect(outcome.result.accepted).toBe(true);
      return outcome.stamps.dealID as string;
    },
    respond: (kind, seat, dealID) => {
      const outcome = manager.applyDealAction({
        agentID: seat.agentID,
        playerID: seat.playerID,
        playerName: seat.username,
        action: {
          id: `${kind}:${dealID}`,
          kind,
          label: kind,
          intent: null,
          risk: { level: "none", score: 0 },
          metadata: { dealID },
        },
        turnNumber: 0,
      });
      return outcome.result;
    },
    push: (record) => {
      sequence += 1;
      records.push({ ...record, sequence });
    },
  };
}

/** NAP/TSP active from step 2 (propose step 0, accept step 1). */
function activatePact(
  harness: ComplianceHarness,
  template: "non_aggression_pact" | "trade_security_pact",
): string {
  const dealID = harness.propose(A, B, template);
  harness.beginStep(); // step 1
  expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
  harness.beginStep(); // step 2 — active window opens
  return dealID;
}

function obligationsOf(harness: ComplianceHarness, dealID: string) {
  const deal = harness.manager
    .ledgerSnapshot()
    .deals.find((candidate) => candidate.dealID === dealID)!;
  return deal.obligations;
}

describe("AgentDealCompliance — violations (confirmed effects only)", () => {
  it("confirms a land-attack violation from an audited attack record with the verdict text", () => {
    const harness = complianceHarness([A, B, C]);
    const dealID = activatePact(harness, "non_aggression_pact");
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 50,
        kind: "attack",
        actionID: `attack:${B.playerID}:25`,
        metadata: { targetID: B.playerID, targetName: B.username },
        auditStatus: "confirmed",
      }),
    );
    harness.beginStep(); // step 3 judges step 2

    const obligations = obligationsOf(harness, dealID);
    const violator = obligations.find(
      (obligation) => obligation.obligorPlayerID === A.playerID,
    )!;
    expect(violator.status).toBe("violated");
    expect(violator.resolvedAtStep).toBe(2);
    const victim = obligations.find(
      (obligation) => obligation.obligorPlayerID === B.playerID,
    )!;
    expect(victim.status).toBe("pending");

    const stamp = harness.manager.takePendingComplianceStamp(A.agentID);
    expect(stamp).not.toBeNull();
    const events = JSON.parse(stamp!) as Array<Record<string, unknown>>;
    expect(events).toEqual([
      expect.objectContaining({
        event: "deal_violated",
        dealID,
        tone: "betrayal",
        importance: 96,
      }),
    ]);
    expect(events[0].publicText).toBe(
      "VERDICT: Auri violated the pact — land attack on Sefirot at step 2.",
    );
  });

  it("never lets same-step actions retroactively violate (accepted at N ⇒ judged from N+1)", () => {
    const harness = complianceHarness([A, B]);
    const dealID = harness.propose(A, B, "non_aggression_pact");
    harness.beginStep(); // step 1
    expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
    // Same step as the acceptance: a confirmed attack by A on B.
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 25,
        kind: "attack",
        actionID: `attack:${B.playerID}:25`,
        metadata: { targetID: B.playerID },
        auditStatus: "confirmed",
      }),
    );
    harness.beginStep(); // step 2 judges step 1 — before the active window
    const obligations = obligationsOf(harness, dealID);
    expect(obligations.map((obligation) => obligation.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("catches transport-invasion arrival through the before/after attack snapshots", () => {
    const harness = complianceHarness([A, B]);
    const dealID = activatePact(harness, "non_aggression_pact");
    // No attack ACTION was selected this step — the arrival of an earlier
    // transport creates the attack, visible only as a snapshot delta.
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 50,
        kind: "hold",
        attackTargetsBefore: [],
        attackTargetsAfter: [B.playerID],
      }),
    );
    harness.beginStep();
    const violator = obligationsOf(harness, dealID).find(
      (obligation) => obligation.obligorPlayerID === A.playerID,
    )!;
    expect(violator.status).toBe("violated");
    expect(violator.resolutionEvidence).toContain("confirmed attack");
  });

  it("attributes the victim's automatic attack-created embargo to nobody (trade_security)", () => {
    const harness = complianceHarness([A, B]);
    const dealID = activatePact(harness, "trade_security_pact");
    // B attacks A (confirmed) — B violates. A, the VICTIM, automatically
    // gains a temporary embargo against B (defender side): it appears only
    // in A's audit snapshots, never as an embargo action record.
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: B.agentID,
        playerID: B.playerID,
        username: B.username,
        turnNumber: 50,
        kind: "attack",
        actionID: `attack:${A.playerID}:25`,
        metadata: { targetID: A.playerID },
        auditStatus: "confirmed",
      }),
    );
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 50,
        kind: "hold",
        embargoTargetsBefore: [],
        embargoTargetsAfter: [B.playerID],
      }),
    );
    harness.beginStep();
    const obligations = obligationsOf(harness, dealID);
    const victim = obligations.find(
      (obligation) => obligation.obligorPlayerID === A.playerID,
    )!;
    // The auto-embargo is NEVER the victim's violation.
    expect(victim.status).toBe("pending");
    const attacker = obligations.find(
      (obligation) => obligation.obligorPlayerID === B.playerID,
    )!;
    expect(attacker.status).toBe("violated");
  });

  it("confirms manual embargo and embargo_all as trade_security violations", () => {
    const manual = complianceHarness([A, B]);
    const manualID = activatePact(manual, "trade_security_pact");
    manual.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 50,
        kind: "embargo",
        actionID: `embargo:${B.playerID}:start`,
        metadata: { targetID: B.playerID, action: "start" },
        auditStatus: "confirmed",
      }),
    );
    manual.beginStep();
    const manualViolator = obligationsOf(manual, manualID).find(
      (obligation) => obligation.obligorPlayerID === A.playerID,
    )!;
    expect(manualViolator.status).toBe("violated");
    expect(manualViolator.resolutionEvidence).toContain("manual embargo");
    const stamp = manual.manager.takePendingComplianceStamp(A.agentID)!;
    expect(stamp).toContain("violated the trade-security pact");

    const bulk = complianceHarness([A, B]);
    const bulkID = activatePact(bulk, "trade_security_pact");
    bulk.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 50,
        kind: "embargo_all",
        actionID: "embargo_all:start",
        metadata: { action: "start" },
        auditStatus: "confirmed",
      }),
    );
    bulk.beginStep();
    expect(
      obligationsOf(bulk, bulkID).find(
        (obligation) => obligation.obligorPlayerID === A.playerID,
      )!.status,
    ).toBe("violated");
  });

  it("never treats emoji, quick chat, or target markers as violations", () => {
    const harness = complianceHarness([A, B]);
    const dealID = activatePact(harness, "trade_security_pact");
    const kinds = [
      ["emoji", { recipientID: B.playerID, emoji: 60 }],
      ["quick_chat", { recipientID: B.playerID, quickChatKey: "attack.focus" }],
      ["target_player", { targetID: B.playerID }],
    ] as const;
    for (const [kind, metadata] of kinds) {
      harness.push(
        fabricatedRecord({
          sequence: 0,
          agentID: A.agentID,
          playerID: A.playerID,
          username: A.username,
          turnNumber: 50,
          kind,
          metadata: metadata as Record<string, string | number>,
          auditStatus: "confirmed",
        }),
      );
    }
    harness.beginStep();
    expect(
      obligationsOf(harness, dealID).map((obligation) => obligation.status),
    ).toEqual(["pending", "pending"]);
  });
});

describe("AgentDealCompliance — fulfillment, expiry, moot, force-resolve", () => {
  it("fulfills a joint_attack pledge only on confirmed attack against the named target", () => {
    const harness = complianceHarness([A, B, C]);
    const dealID = harness.propose(A, B, "joint_attack", {
      targetID: C.playerID,
      targetName: C.username,
    });
    harness.beginStep(); // 1
    expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
    harness.beginStep(); // 2
    // A confirmed attack on the WRONG seat does not fulfill.
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 50,
        kind: "attack",
        actionID: `attack:${B.playerID}:10`,
        metadata: { targetID: B.playerID },
        auditStatus: "confirmed",
      }),
    );
    harness.beginStep(); // 3
    expect(obligationsOf(harness, dealID)[0].status).toBe("pending");
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: A.agentID,
        playerID: A.playerID,
        username: A.username,
        turnNumber: 75,
        kind: "attack",
        actionID: `attack:${C.playerID}:25`,
        metadata: { targetID: C.playerID, targetName: C.username },
        auditStatus: "confirmed",
      }),
    );
    harness.beginStep(); // 4
    const obligation = obligationsOf(harness, dealID)[0];
    expect(obligation.status).toBe("fulfilled");
    const stamp = harness.manager.takePendingComplianceStamp(A.agentID)!;
    expect(stamp).toContain("deal_fulfilled");
    expect(stamp).toContain("fulfilled the joint-attack pledge");
  });

  it("expires an unfulfilled joint_attack pledge after its window (deal_expired)", () => {
    const harness = complianceHarness([A, B, C]);
    const dealID = harness.propose(A, B, "joint_attack", {
      targetID: C.playerID,
      targetName: C.username,
      durationSteps: 3,
    });
    harness.beginStep(); // 1
    expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
    // Active steps 2..4; resolution at the start of step 5.
    for (let step = 2; step <= 5; step += 1) {
      harness.beginStep();
    }
    const obligation = obligationsOf(harness, dealID)[0];
    expect(obligation.status).toBe("expired_unfulfilled");
    const stamp = harness.manager.takePendingComplianceStamp(A.agentID)!;
    const events = JSON.parse(stamp) as Array<Record<string, unknown>>;
    expect(events).toEqual([
      expect.objectContaining({ event: "deal_expired", dealID }),
    ]);
    expect(events[0].publicText).toContain(
      "pledge to attack Riven expired unfulfilled",
    );
  });

  it("fulfills support_request from cumulative CONFIRMED donations only", () => {
    const harness = complianceHarness([A, B]);
    // A requests support; the accepting recipient B is the obligor (B → A).
    const dealID = harness.propose(A, B, "support_request");
    harness.beginStep(); // 1
    expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
    harness.beginStep(); // 2
    // An UNCONFIRMED donation (audit unknown) never counts.
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: B.agentID,
        playerID: B.playerID,
        username: B.username,
        turnNumber: 50,
        kind: "donate_gold",
        actionID: `donate_gold:${A.playerID}`,
        metadata: { recipientID: A.playerID, gold: 999_999 },
        auditStatus: "unknown",
      }),
    );
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: B.agentID,
        playerID: B.playerID,
        username: B.username,
        turnNumber: 50,
        kind: "donate_gold",
        actionID: `donate_gold:${A.playerID}`,
        metadata: { recipientID: A.playerID, gold: 100_000 },
        auditStatus: "confirmed",
      }),
    );
    harness.beginStep(); // 3
    const partway = obligationsOf(harness, dealID)[0];
    expect(partway.status).toBe("pending");
    expect(partway.donatedGold).toBe("100000");
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: B.agentID,
        playerID: B.playerID,
        username: B.username,
        turnNumber: 75,
        kind: "donate_gold",
        actionID: `donate_gold:${A.playerID}`,
        metadata: { recipientID: A.playerID, gold: 60_000 },
        auditStatus: "confirmed",
      }),
    );
    harness.beginStep(); // 4
    const fulfilled = obligationsOf(harness, dealID)[0];
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.donatedGold).toBe("160000");
    expect(harness.manager.takePendingComplianceStamp(B.agentID)).toContain(
      "fulfilled the support pledge",
    );
  });

  it("fulfills a pact whose whole window passes without a confirmed violation", () => {
    const harness = complianceHarness([A, B]);
    const dealID = harness.propose(A, B, "non_aggression_pact", {
      durationSteps: 3,
    });
    harness.beginStep(); // 1
    expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
    for (let step = 2; step <= 5; step += 1) {
      harness.beginStep();
    }
    const obligations = obligationsOf(harness, dealID);
    expect(obligations.map((obligation) => obligation.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const stamp = harness.manager.takePendingComplianceStamp(A.agentID)!;
    expect(stamp).toContain("honored the non-aggression pact");
    expect(stamp).toContain("without a confirmed hostile action");
  });

  it("moots obligations when the counterparty is eliminated (game-state fact)", async () => {
    const infos = [
      new PlayerInfo(
        A.username,
        PlayerType.Human,
        `CLNT_${A.playerID}`,
        A.playerID,
      ),
      new PlayerInfo(
        B.username,
        PlayerType.Human,
        `CLNT_${B.playerID}`,
        B.playerID,
      ),
    ];
    const game = await setup("plains", {}, infos);
    const tile = game.ref(10, 50);
    game.player(B.playerID).conquer(tile);
    game.player(B.playerID).setSpawnTile(tile);

    const harness = complianceHarness([A, B]);
    const dealID = activatePact(harness, "non_aggression_pact");
    // B is alive: nothing moots.
    harness.manager.beginDecisionStep({
      turnNumber: 75,
      gameState: game,
      records: harness.records,
    });
    expect(
      obligationsOf(harness, dealID).map((obligation) => obligation.status),
    ).toEqual(["pending", "pending"]);
    // B eliminated (spawned, then lost every tile).
    game.player(B.playerID).relinquish(tile);
    expect(game.player(B.playerID).isAlive()).toBe(false);
    harness.manager.beginDecisionStep({
      turnNumber: 100,
      gameState: game,
      records: harness.records,
    });
    const obligations = obligationsOf(harness, dealID);
    expect(obligations.map((obligation) => obligation.status)).toEqual([
      "moot",
      "moot",
    ]);
    expect(obligations[0].resolutionEvidence).toContain("eliminated");
  });

  it("force-resolves every accepted obligation to a terminal state at match end", () => {
    const harness = complianceHarness([A, B, C]);
    // Mid-window NAP (negative → forced fulfilled).
    const napID = activatePact(harness, "non_aggression_pact");
    // Mid-window support pledge (positive, window cut short → forced moot).
    const supportID = harness.propose(A, B, "support_request");
    harness.beginStep();
    expect(harness.respond("deal_accept", B, supportID).accepted).toBe(true);
    // An open, unanswered proposal (→ expired).
    const openID = harness.propose(A, C, "non_aggression_pact");

    harness.manager.finalize({ records: harness.records });
    const ledger = harness.manager.ledgerSnapshot();
    const byID = new Map(ledger.deals.map((deal) => [deal.dealID, deal]));
    expect(byID.get(openID)!.status).toBe("expired");
    expect(
      byID
        .get(napID)!
        .obligations.map((obligation) => [
          obligation.status,
          obligation.forcedResolution,
        ]),
    ).toEqual([
      ["fulfilled", true],
      ["fulfilled", true],
    ]);
    expect(
      byID.get(supportID)!.obligations.map((obligation) => obligation.status),
    ).toEqual(["moot"]);
    // EVERY obligation across the ledger is terminal.
    for (const deal of ledger.deals) {
      for (const obligation of deal.obligations) {
        expect(obligation.status).not.toBe("pending");
      }
    }
    // Idempotent.
    harness.manager.finalize({ records: harness.records });
    expect(harness.manager.ledgerSnapshot().deals).toEqual(ledger.deals);
  });

  it("computes public per-rival reliability as fulfilled / terminal non-moot (null without sample)", () => {
    const harness = complianceHarness([A, B, C]);
    // A fulfills one NAP obligation (whole window passes) while B violates.
    const dealID = harness.propose(A, B, "non_aggression_pact", {
      durationSteps: 3,
    });
    harness.beginStep(); // 1
    expect(harness.respond("deal_accept", B, dealID).accepted).toBe(true);
    harness.beginStep(); // 2
    harness.push(
      fabricatedRecord({
        sequence: 0,
        agentID: B.agentID,
        playerID: B.playerID,
        username: B.username,
        turnNumber: 50,
        kind: "attack",
        actionID: `attack:${A.playerID}:25`,
        metadata: { targetID: A.playerID },
        auditStatus: "confirmed",
      }),
    );
    for (let step = 3; step <= 6; step += 1) {
      harness.beginStep();
    }
    const view = harness.manager.observationFor({
      agentID: C.agentID,
      observation: stubObservation({
        seat: C,
        others: [stubVisiblePlayer(A), stubVisiblePlayer(B)],
        turnNumber: 150,
      }),
    })!;
    expect(view.rivalReliability).toEqual([
      {
        playerID: A.playerID,
        name: A.username,
        fulfilled: 1,
        terminalNonMoot: 1,
        reliability: 1,
      },
      {
        playerID: B.playerID,
        name: B.username,
        fulfilled: 0,
        terminalNonMoot: 1,
        reliability: 0,
      },
    ]);
    // No bilateral terms leak through the public aggregate.
    expect(JSON.stringify(view.rivalReliability)).not.toContain(dealID);
  });
});
