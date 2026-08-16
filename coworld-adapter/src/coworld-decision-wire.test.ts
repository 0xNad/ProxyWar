import { describe, expect, it } from "vitest";

import {
  MAX_WIRE_ACTIONS_PER_DECISION as CANONICAL_MAX,
  MAX_SPAWN_PREFERENCE_ACTION_IDS as CANONICAL_MAX_SPAWN_PREFERENCES,
} from "../../src/server/agents/AgentWireProtocol.ts";
import {
  decisionRequestEnvelope,
  MAX_WIRE_ACTION_ID_LENGTH,
  MAX_WIRE_ACTIONS_PER_DECISION,
  MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
  normalizeDecisionResponse,
} from "./coworld-decision-wire.ts";

describe("wire constant parity", () => {
  it("mirrors the canonical MAX_WIRE_ACTIONS_PER_DECISION exactly", () => {
    // The adapter cannot value-import from src/ at image runtime (it deploys
    // to /app/integration with the engine at /app/proxywar), so it carries a
    // literal. This pin is what keeps the mirror honest.
    expect(MAX_WIRE_ACTIONS_PER_DECISION).toBe(CANONICAL_MAX);
  });

  it("mirrors the independent canonical spawn-preference cap exactly", () => {
    expect(MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS).toBe(
      CANONICAL_MAX_SPAWN_PREFERENCES,
    );
  });
});

describe("decisionRequestEnvelope", () => {
  it("advertises the batch capability as an envelope sibling, request untouched", () => {
    const request = { legalActions: [{ id: "a" }], nested: { deep: true } };
    const envelope = decisionRequestEnvelope({
      requestID: "req_1",
      slot: 3,
      request,
    });
    expect(envelope).toEqual({
      type: "decision_request",
      requestID: "req_1",
      slot: 3,
      protocol: {
        maxActionsPerDecision: MAX_WIRE_ACTIONS_PER_DECISION,
        maxSpawnPreferences: MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
      },
      request,
    });
    // The inner payload rides by reference — byte-identical on the wire.
    expect(envelope.request).toBe(request);
  });
});

describe("normalizeDecisionResponse", () => {
  it("keeps scalar-only replies byte-identical (no actionIDs key)", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      reason: "push north",
    });
    expect(normalized).toEqual({
      actionID: "attack:one",
      reason: "push north",
    });
    expect("actionIDs" in normalized).toBe(false);
  });

  it("normalizes a batch: scalar first, deduped, capped", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedLegalActionIds: [
        "attack:two",
        "attack:one",
        "attack:two",
        "attack:three",
        "attack:four",
        "attack:five",
        "attack:six",
      ],
      reason: "everything",
    });
    expect(normalized.actionIDs).toEqual([
      "attack:one",
      "attack:two",
      "attack:three",
      "attack:four",
      "attack:five",
    ]);
    expect(normalized.actionIDs).toHaveLength(MAX_WIRE_ACTIONS_PER_DECISION);
  });

  it("prepends the scalar when the array omits it", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedLegalActionIds: ["build:two"],
      reason: "expand then build",
    });
    expect(normalized.actionIDs).toEqual(["attack:one", "build:two"]);
  });

  it("omits a batch that collapses to one id", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedLegalActionIds: ["attack:one", "", "   "],
      reason: "just the one",
    });
    expect(normalized.actionIDs).toBeUndefined();
  });

  it("ignores non-array and non-string batch noise", () => {
    expect(
      normalizeDecisionResponse({
        selectedLegalActionId: "attack:one",
        selectedLegalActionIds: "attack:two",
        reason: "wrong shape",
      }).actionIDs,
    ).toBeUndefined();
    expect(
      normalizeDecisionResponse({
        selectedLegalActionId: "attack:one",
        selectedLegalActionIds: [7, null, "attack:two"],
        reason: "mixed",
      }).actionIDs,
    ).toEqual(["attack:one", "attack:two"]);
  });

  it("length-bounds every id including the scalar", () => {
    const long = "x".repeat(MAX_WIRE_ACTION_ID_LENGTH + 50);
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: long,
      selectedLegalActionIds: [long, "attack:two"],
      reason: "bounded",
    });
    expect(normalized.actionID).toHaveLength(MAX_WIRE_ACTION_ID_LENGTH);
    expect(normalized.actionIDs?.[0]).toHaveLength(MAX_WIRE_ACTION_ID_LENGTH);
    expect(normalized.actionIDs?.[1]).toBe("attack:two");
  });

  it("forwards the deal slot only when non-empty, and defaults the reason", () => {
    const withDeal = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedDealActionId: " deal_propose:P_B:nap ",
    });
    expect(withDeal.dealActionID).toBe("deal_propose:P_B:nap");
    expect(withDeal.reason).toBe("Coworld player returned no reason.");

    const withoutDeal = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedDealActionId: "   ",
      reason: "r".repeat(600),
    });
    expect("dealActionID" in withoutDeal).toBe(false);
    expect(withoutDeal.reason).toHaveLength(500);
  });

  it("maps an explicit spawn ballot to its independent internal field without creating an action batch", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "spawn:20",
      spawnPreferenceLegalActionIds: ["spawn:20", "spawn:10", "spawn:30"],
      reason: "ranked spawn ballot",
    });

    expect(normalized.spawnPreferenceActionIDs).toEqual([
      "spawn:20",
      "spawn:10",
      "spawn:30",
    ]);
    expect(normalized.actionIDs).toBeUndefined();
  });

  it.each([
    ["without a ranked ballot", undefined],
    ["alongside a ranked ballot", ["spawn:20", "spawn:10"]],
  ])(
    "marks an all-spawn response invalid when it carries executable batching %s",
    (_case, spawnPreferenceLegalActionIds) => {
      const normalized = normalizeDecisionResponse(
        {
          selectedLegalActionId: "spawn:20",
          selectedLegalActionIds: ["spawn:20", "spawn:10"],
          ...(spawnPreferenceLegalActionIds === undefined
            ? {}
            : { spawnPreferenceLegalActionIds }),
          reason: "conflicting spawn wire fields",
        },
        { allSpawnMenu: true },
      );

      expect(normalized.actionIDs).toBeUndefined();
      expect(normalized.spawnPreferenceActionIDs).toBeNull();
    },
  );

  it("preserves one-item ballot presence and malformed evidence for backend rejection", () => {
    expect(
      normalizeDecisionResponse({
        selectedLegalActionId: "spawn:10",
        spawnPreferenceLegalActionIds: ["spawn:10"],
      }).spawnPreferenceActionIDs,
    ).toEqual(["spawn:10"]);

    expect(
      normalizeDecisionResponse({
        selectedLegalActionId: "spawn:10",
        spawnPreferenceLegalActionIds: "spawn:10",
      }).spawnPreferenceActionIDs,
    ).toBeNull();

    expect(
      normalizeDecisionResponse({
        selectedLegalActionId: "spawn:10",
        spawnPreferenceLegalActionIds: ["spawn:10", 7, "spawn:10"],
      }).spawnPreferenceActionIDs,
    ).toEqual(["spawn:10", 7, "spawn:10"]);
  });

  it("bounds hostile spawn ballots while preserving an overflow witness and overlong-id rejection", () => {
    const overflow = Array.from(
      { length: MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS + 100 },
      (_, index) => `spawn:${index}`,
    );
    const normalizedOverflow = normalizeDecisionResponse({
      selectedLegalActionId: "spawn:0",
      spawnPreferenceLegalActionIds: overflow,
    });
    expect(normalizedOverflow.spawnPreferenceActionIDs).toHaveLength(
      MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS + 1,
    );

    const overlong = `spawn:${"x".repeat(MAX_WIRE_ACTION_ID_LENGTH)}`;
    const normalizedOverlong = normalizeDecisionResponse({
      selectedLegalActionId: "spawn:1",
      spawnPreferenceLegalActionIds: ["spawn:1", overlong],
    });
    expect(normalizedOverlong.spawnPreferenceActionIDs).toEqual([
      "spawn:1",
      "",
    ]);
  });
});
