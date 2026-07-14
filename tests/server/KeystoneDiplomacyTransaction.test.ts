import { describe, expect, it } from "vitest";

import {
  activeKeystoneDiplomacyMacroTarget,
  classifyKeystoneAllianceRequest,
  completeKeystoneDiplomacyMacro,
  initialKeystoneDiplomacyLedger,
  KEYSTONE_DIPLOMACY_MACRO_TURNS,
  reconcileKeystoneDiplomacyLedger,
  registerKeystonePendingBreak,
} from "../../coworld-adapter/src/keystone-diplomacy-transaction";
import type { RecentAgentDecision } from "../../src/server/agents/AgentTypes";

function decision(
  sequence: number,
  actionKind: RecentAgentDecision["actionKind"],
  targetID: string,
  accepted = true,
  actionID = `${actionKind}:${targetID}`,
): RecentAgentDecision {
  return {
    sequence,
    actionID,
    actionKind,
    targetID,
    accepted,
    reason: "fixture",
  };
}

function reset(turnNumber = 100) {
  return reconcileKeystoneDiplomacyLedger(initialKeystoneDiplomacyLedger(), {
    gameID: "GAME-A",
    turnNumber,
    recentDecisions: [],
  }).ledger;
}

describe("Keystone diplomacy transaction ledger", () => {
  it("resets at a game boundary and remains deeply immutable", () => {
    const initial = reset();
    const next = reconcileKeystoneDiplomacyLedger(initial, {
      gameID: "GAME-B",
      turnNumber: 5,
      recentDecisions: [decision(1, "alliance_request", "B")],
    });

    expect(next).toMatchObject({ changed: true, reason: "accepted_request" });
    expect(next.ledger).toMatchObject({
      gameID: "GAME-B",
      lastTurn: 5,
      lastObservedDecisionSequence: 1,
      requestedTargetIDs: ["B"],
      brokenTargetIDs: [],
      macro: { state: "idle" },
    });
    expect(Object.isFrozen(next.ledger)).toBe(true);
    expect(Object.isFrozen(next.ledger.requestedTargetIDs)).toBe(true);
    expect(Object.isFrozen(next.ledger.macro)).toBe(true);
  });

  it("learns accepted requests once and ignores retries or rejected records", () => {
    const first = reconcileKeystoneDiplomacyLedger(reset(), {
      gameID: "GAME-A",
      turnNumber: 120,
      recentDecisions: [
        decision(4, "alliance_request", "A", false),
        decision(5, "alliance_request", "B"),
      ],
    });
    const replayed = reconcileKeystoneDiplomacyLedger(first.ledger, {
      gameID: "GAME-A",
      turnNumber: 140,
      recentDecisions: [
        decision(4, "alliance_request", "A", false),
        decision(5, "alliance_request", "B"),
      ],
    });

    expect(first.ledger.requestedTargetIDs).toEqual(["B"]);
    expect(first.ledger.lastObservedDecisionSequence).toBe(5);
    expect(replayed.ledger.requestedTargetIDs).toEqual(["B"]);
    expect(replayed.reason).toBe("none");
  });

  it("classifies reactive, first, pending, repeated, and post-break requests", () => {
    let ledger = reset();
    expect(
      classifyKeystoneAllianceRequest({
        ledger,
        targetPlayerID: "A",
        hasIncomingAllianceRequest: true,
        hasOutgoingAllianceRequest: false,
      }),
    ).toBe("reactive_request");
    expect(
      classifyKeystoneAllianceRequest({
        ledger,
        targetPlayerID: "A",
        hasIncomingAllianceRequest: false,
        hasOutgoingAllianceRequest: false,
      }),
    ).toBe("first_request");
    expect(
      classifyKeystoneAllianceRequest({
        ledger,
        targetPlayerID: "A",
        hasIncomingAllianceRequest: false,
        hasOutgoingAllianceRequest: true,
      }),
    ).toBe("outgoing_request_pending");

    ledger = reconcileKeystoneDiplomacyLedger(ledger, {
      gameID: "GAME-A",
      turnNumber: 110,
      recentDecisions: [decision(1, "alliance_request", "A")],
    }).ledger;
    expect(
      classifyKeystoneAllianceRequest({
        ledger,
        targetPlayerID: "A",
        hasIncomingAllianceRequest: false,
        hasOutgoingAllianceRequest: false,
      }),
    ).toBe("repeat_request");

    ledger = reconcileKeystoneDiplomacyLedger(ledger, {
      gameID: "GAME-A",
      turnNumber: 120,
      recentDecisions: [decision(2, "break_alliance", "A")],
    }).ledger;
    expect(
      classifyKeystoneAllianceRequest({
        ledger,
        targetPlayerID: "A",
        hasIncomingAllianceRequest: true,
        hasOutgoingAllianceRequest: false,
      }),
    ).toBe("realliance_after_break");
  });

  it("arms break to conquest only after the exact accepted break appears", () => {
    const pending = registerKeystonePendingBreak(reset(8_000), {
      gameID: "GAME-A",
      turnNumber: 8_000,
      actionID: "break:ALLY:v2",
      targetPlayerID: "ALLY",
    });
    const rejected = reconcileKeystoneDiplomacyLedger(pending.ledger, {
      gameID: "GAME-A",
      turnNumber: 8_010,
      recentDecisions: [
        decision(10, "break_alliance", "ALLY", false, "break:ALLY:v2"),
      ],
    });
    const wrongOffer = reconcileKeystoneDiplomacyLedger(rejected.ledger, {
      gameID: "GAME-A",
      turnNumber: 8_020,
      recentDecisions: [
        decision(11, "break_alliance", "ALLY", true, "break:ALLY:stale"),
      ],
    });

    expect(pending).toMatchObject({
      changed: true,
      reason: "pending_break_registered",
      ledger: { macro: { state: "pending" } },
    });
    expect(rejected.ledger.macro.state).toBe("pending");
    expect(wrongOffer.ledger.macro.state).toBe("pending");
    expect(activeKeystoneDiplomacyMacroTarget(wrongOffer.ledger)).toBeNull();

    const accepted = reconcileKeystoneDiplomacyLedger(wrongOffer.ledger, {
      gameID: "GAME-A",
      turnNumber: 8_030,
      recentDecisions: [
        decision(12, "break_alliance", "ALLY", true, "break:ALLY:v2"),
      ],
    });
    expect(accepted).toMatchObject({
      changed: true,
      reason: "accepted_break_armed",
      ledger: {
        macro: {
          state: "armed",
          targetPlayerID: "ALLY",
          armedTurn: 8_030,
          expiresAfterTurn: 8_630,
        },
      },
    });
    expect(activeKeystoneDiplomacyMacroTarget(accepted.ledger)).toBe("ALLY");
  });

  it("keeps the macro through its inclusive 600-turn horizon then expires", () => {
    const pending = registerKeystonePendingBreak(reset(1_000), {
      gameID: "GAME-A",
      turnNumber: 1_000,
      actionID: "break:B",
      targetPlayerID: "B",
    }).ledger;
    const armed = reconcileKeystoneDiplomacyLedger(pending, {
      gameID: "GAME-A",
      turnNumber: 1_010,
      recentDecisions: [decision(1, "break_alliance", "B", true, "break:B")],
    }).ledger;
    const boundary = reconcileKeystoneDiplomacyLedger(armed, {
      gameID: "GAME-A",
      turnNumber: 1_010 + KEYSTONE_DIPLOMACY_MACRO_TURNS,
      recentDecisions: [],
    });
    const expired = reconcileKeystoneDiplomacyLedger(boundary.ledger, {
      gameID: "GAME-A",
      turnNumber: 1_611,
      recentDecisions: [],
    });

    expect(boundary.ledger.macro.state).toBe("armed");
    expect(expired).toMatchObject({
      changed: true,
      reason: "macro_expired",
      ledger: { macro: { state: "expired" } },
    });
  });

  it("completes into a bounded cooldown and later returns to idle", () => {
    const pending = registerKeystonePendingBreak(reset(1_000), {
      gameID: "GAME-A",
      turnNumber: 1_000,
      actionID: "break:B",
      targetPlayerID: "B",
    }).ledger;
    const armed = reconcileKeystoneDiplomacyLedger(pending, {
      gameID: "GAME-A",
      turnNumber: 1_010,
      recentDecisions: [decision(1, "break_alliance", "B", true, "break:B")],
    }).ledger;
    const completed = completeKeystoneDiplomacyMacro(armed, 1_100, "B");
    const idle = reconcileKeystoneDiplomacyLedger(completed.ledger, {
      gameID: "GAME-A",
      turnNumber: 1_701,
      recentDecisions: [],
    });

    expect(completed).toMatchObject({
      reason: "macro_completed",
      ledger: { macro: { state: "cooldown", cooldownUntilTurn: 1_700 } },
    });
    expect(idle).toMatchObject({
      reason: "cooldown_completed",
      ledger: { macro: { state: "idle" } },
    });
  });
});
