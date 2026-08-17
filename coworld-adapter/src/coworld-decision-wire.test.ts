import { describe, expect, it } from "vitest";

import { validateAgentMessageDecision } from "../../src/server/agents/AgentDecisionValidator.ts";
import { FREETEXT_MESSAGE_MAX_CHARS } from "../../src/server/agents/AgentTunables.ts";
import {
  MAX_WIRE_ACTIONS_PER_DECISION as CANONICAL_MAX,
  MAX_SPAWN_PREFERENCE_ACTION_IDS as CANONICAL_MAX_SPAWN_PREFERENCES,
} from "../../src/server/agents/AgentWireProtocol.ts";
import {
  decisionRequestEnvelope,
  MAX_WIRE_ACTION_ID_LENGTH,
  MAX_WIRE_ACTIONS_PER_DECISION,
  MAX_WIRE_MESSAGE_TEXT_LENGTH,
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

  it("keeps the comms transport bound STRICTLY above the validator's cap", () => {
    // Not cosmetic. The validator rejects over-cap text instead of trimming it,
    // because a shortened promise is a different promise. If this transport
    // bound ever slid down to (or below) the cap, the adapter would hand the
    // validator a pre-shortened body that then PASSES — turning a rejection
    // into an accepted message the agent never wrote, and stamping it as
    // verbatim evidence. Everything else in the comms path assumes this holds.
    expect(MAX_WIRE_MESSAGE_TEXT_LENGTH).toBeGreaterThan(
      FREETEXT_MESSAGE_MAX_CHARS,
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

  it("advertises maxMessageChars only when the caller supplies it", () => {
    const withComms = decisionRequestEnvelope({
      requestID: "req_2",
      slot: 1,
      request: {},
      maxMessageChars: FREETEXT_MESSAGE_MAX_CHARS,
    });
    expect(withComms.protocol).toEqual({
      maxActionsPerDecision: MAX_WIRE_ACTIONS_PER_DECISION,
      maxSpawnPreferences: MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
      maxMessageChars: FREETEXT_MESSAGE_MAX_CHARS,
    });

    // Flag off => the caller passes nothing => the envelope is byte-identical
    // to shipped behavior, so no policy can detect the feature from the wire.
    const withoutComms = decisionRequestEnvelope({
      requestID: "req_2",
      slot: 1,
      request: {},
    });
    expect(withoutComms.protocol).toEqual({
      maxActionsPerDecision: MAX_WIRE_ACTIONS_PER_DECISION,
      maxSpawnPreferences: MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "omits a %s comms advertisement rather than publishing nonsense",
    (_case, maxMessageChars) => {
      const envelope = decisionRequestEnvelope({
        requestID: "req_3",
        slot: 0,
        request: {},
        maxMessageChars,
      });
      expect(envelope.protocol).not.toHaveProperty("maxMessageChars");
    },
  );
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

describe("normalizeDecisionResponse comms slot", () => {
  const messageAction = {
    id: "message:P_B",
    kind: "message",
    label: "Message P_B",
  } as never;

  it("carries the comms pair through to the AgentDecision field names", () => {
    // The regression this whole change exists for: before the fix the pair was
    // dropped here, so no league policy could ever speak regardless of flags.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:P_B",
      selectedDealActionId: "deal_propose:P_B:nap",
      selectedMessageActionId: " message:P_B ",
      messageText: "Truce on our shared border until turn 300.",
      reason: "open negotiation",
    });

    expect(normalized.messageActionID).toBe("message:P_B");
    expect(normalized.messageText).toBe(
      "Truce on our shared border until turn 300.",
    );
    // The deal slot is untouched by the comms slot: talking costs neither the
    // move nor the negotiation.
    expect(normalized.actionID).toBe("attack:P_B");
    expect(normalized.dealActionID).toBe("deal_propose:P_B:nap");
  });

  it("keeps comms-free replies byte-identical (no comms keys at all)", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      reason: "push north",
    });
    expect("messageActionID" in normalized).toBe(false);
    expect("messageText" in normalized).toBe(false);
    expect(normalized).toEqual({
      actionID: "attack:one",
      reason: "push north",
    });
  });

  it("passes the body through verbatim, leaving normalization to the validator", () => {
    // Untrimmed and uncollapsed on purpose. The validator collapses whitespace
    // then measures; doing it here too is how the delivered text and the
    // stamped commsSlotText evidence drift apart.
    const text = "  hold\tthe\n\nline  ";
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:P_B",
      messageText: text,
    });
    expect(normalized.messageText).toBe(text);
  });

  it("never pre-shortens over-cap text into something the validator would accept", () => {
    // The reject-don't-rewrite guard, end to end through the REAL validator.
    // This body is over the 280-char cap but under the transport bound, so it
    // must arrive intact and be REJECTED — not silently clamped to 280 and
    // accepted as a message the agent never wrote.
    const overCap = "a".repeat(FREETEXT_MESSAGE_MAX_CHARS + 20);
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:P_B",
      messageText: overCap,
    });
    expect(normalized.messageText).toBe(overCap);

    const validation = validateAgentMessageDecision(
      {
        actionID: "attack:one",
        messageActionID: normalized.messageActionID,
        messageText: normalized.messageText,
        reason: "over cap",
      } as never,
      [messageAction],
    );
    expect(validation?.ok).toBe(false);
    expect(validation && !validation.ok ? validation.reason : "").toContain(
      "rejected, not truncated",
    );
  });

  it("replaces an oversize body with a bounded sentinel the validator still rejects", () => {
    const hostile = "b".repeat(MAX_WIRE_MESSAGE_TEXT_LENGTH + 5_000);
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:P_B",
      messageText: hostile,
    });

    // Bounded transport: the hostile body is not retained.
    expect(normalized.messageText).toHaveLength(MAX_WIRE_MESSAGE_TEXT_LENGTH);
    expect(normalized.messageText).not.toBe(
      hostile.slice(0, MAX_WIRE_MESSAGE_TEXT_LENGTH),
    );
    // No whitespace, so it cannot collapse under the cap and sneak through.
    expect(/\s/u.test(normalized.messageText ?? "")).toBe(false);
    // The id survives, so the attempt is recorded as a rejection instead of
    // vanishing silently at the adapter.
    expect(normalized.messageActionID).toBe("message:P_B");

    const validation = validateAgentMessageDecision(
      {
        actionID: "attack:one",
        messageActionID: normalized.messageActionID,
        messageText: normalized.messageText,
        reason: "hostile",
      } as never,
      [messageAction],
    );
    expect(validation?.ok).toBe(false);
  });

  it("length-bounds the comms id like every other id on the wire", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "m".repeat(MAX_WIRE_ACTION_ID_LENGTH + 50),
      messageText: "hi",
    });
    expect(normalized.messageActionID).toHaveLength(MAX_WIRE_ACTION_ID_LENGTH);
  });

  it.each([
    ["id without a body", { selectedMessageActionId: "message:P_B" }],
    ["body without an id", { messageText: "hello" }],
    ["non-string id", { selectedMessageActionId: 7, messageText: "hello" }],
    [
      "non-string body",
      { selectedMessageActionId: "message:P_B", messageText: 7 },
    ],
    [
      "null body",
      { selectedMessageActionId: "message:P_B", messageText: null },
    ],
    [
      "object body",
      { selectedMessageActionId: "message:P_B", messageText: { a: 1 } },
    ],
    [
      "array id",
      { selectedMessageActionId: ["message:P_B"], messageText: "hello" },
    ],
    ["blank id", { selectedMessageActionId: "   ", messageText: "hello" }],
    [
      "blank body",
      { selectedMessageActionId: "message:P_B", messageText: "   \n " },
    ],
  ])("drops the whole pair on a %s", (_case, comms) => {
    // Pair-or-nothing: an id must never reach the validator without the body
    // it has to be judged with, and a body must never arrive unattributed.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      ...comms,
    });
    expect("messageActionID" in normalized).toBe(false);
    expect("messageText" in normalized).toBe(false);
  });

  it("does not check menu membership — that stays the validator's job", () => {
    // Mirrors the deal slot: dropping unknown ids here would hide rejections
    // from the decision record, so a bogus id must still be forwarded.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:NOT_OFFERED",
      messageText: "hello",
    });
    expect(normalized.messageActionID).toBe("message:NOT_OFFERED");

    const validation = validateAgentMessageDecision(
      {
        actionID: "attack:one",
        messageActionID: normalized.messageActionID,
        messageText: normalized.messageText,
        reason: "bogus",
      } as never,
      [messageAction],
    );
    expect(validation?.ok).toBe(false);
    expect(validation && !validation.ok ? validation.reason : "").toContain(
      "unknown action id",
    );
  });

  it("survives the runner's resolve composition alongside metadata", () => {
    // The episode runner resolves `{ ...normalized, metadata }` as the
    // AgentDecision (no-docker-coworld-episode.ts is un-importable here — it
    // ends in a top-level `await main()`), so this pins the composition that
    // carries comms into AgentLeagueMatch. The real proof is the end-to-end
    // episode; this catches a spread being replaced by explicit field picking.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:P_B",
      messageText: "hello",
    });
    const resolved = {
      ...normalized,
      metadata: { brain: "coworld-websocket" },
    };
    expect(resolved.messageActionID).toBe("message:P_B");
    expect(resolved.messageText).toBe("hello");
  });
});
