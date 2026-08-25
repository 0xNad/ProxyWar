import { describe, expect, it } from "vitest";

import {
  validateAgentDealDecision,
  validateAgentMessageDecision,
} from "../../src/server/agents/AgentDecisionValidator.ts";
import { FREETEXT_MESSAGE_MAX_CHARS } from "../../src/server/agents/AgentTunables.ts";
import {
  agentRuntimeModes,
  normalizeAgentRuntimeMode,
} from "../../src/server/agents/AgentTypes.ts";
import {
  AGENT_DEGRADATION_CAUSES,
  MAX_WIRE_ACTIONS_PER_DECISION as CANONICAL_MAX,
  MAX_SPAWN_PREFERENCE_ACTION_IDS as CANONICAL_MAX_SPAWN_PREFERENCES,
  isSelfReportedDegradationCause,
} from "../../src/server/agents/AgentWireProtocol.ts";
import { COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST } from "../../src/server/agents/CommanderXpProtocol.ts";
import {
  commanderExecutionEnvelope,
  composeCoworldDecision,
  COWORLD_AGENT_RUNTIME_MODES,
  COWORLD_COMMANDER_EXECUTION_METADATA_KEYS,
  decisionRequestEnvelope,
  MAX_WIRE_ACTION_ID_LENGTH,
  MAX_WIRE_ACTIONS_PER_DECISION,
  MAX_WIRE_MESSAGE_TEXT_LENGTH,
  MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
  normalizeCommanderExecutionEnvelope,
  normalizeDecisionResponse,
  normalizeDegradedCause,
  normalizeRecordedDegradationCause,
  normalizeRuntimeMode,
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

  it("mirrors the five canonical runtime modes exactly", () => {
    expect(COWORLD_AGENT_RUNTIME_MODES).toEqual(agentRuntimeModes);
  });

  it("mirrors the canonical Commander execution metadata allowlist exactly", () => {
    expect(COWORLD_COMMANDER_EXECUTION_METADATA_KEYS).toEqual(
      COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST,
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

  it("preserves a bounded deal id raw and defaults the reason", () => {
    const withDeal = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedDealActionId: " deal_propose:P_B:nap ",
    });
    expect(withDeal.dealActionID).toBe(" deal_propose:P_B:nap ");
    expect(withDeal.reason).toBe("Coworld player returned no reason.");

    const withoutDeal = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      reason: "r".repeat(600),
    });
    expect("dealActionID" in withoutDeal).toBe(false);
    expect(withoutDeal.reason).toHaveLength(500);
  });

  it.each([
    ["blank", "   ", "   "],
    ["non-string", 7, ""],
    ["null", null, ""],
    ["object", { id: "deal_propose:P_B:nap" }, ""],
  ])(
    "keeps a present %s deal attempt visible for backend rejection",
    (_case, selectedDealActionId, expected) => {
      const normalized = normalizeDecisionResponse({
        selectedLegalActionId: "attack:one",
        selectedDealActionId,
      });
      expect(normalized.dealActionID).toBe(expected);
      expect(
        validateAgentDealDecision(
          {
            actionID: "attack:one",
            dealActionID: normalized.dealActionID,
            reason: "wire authority test",
          },
          [
            {
              id: "deal_propose:P_B:nap",
              kind: "deal_propose",
              label: "Offer pact",
              intent: null,
              risk: { level: "low", score: 0.1 },
            },
          ],
        )?.ok,
      ).toBe(false);
    },
  );

  it("never truncates an overlong deal id into a valid offered prefix", () => {
    const offeredID = `deal_propose:${"x".repeat(
      MAX_WIRE_ACTION_ID_LENGTH - "deal_propose:".length,
    )}`;
    expect(offeredID).toHaveLength(MAX_WIRE_ACTION_ID_LENGTH);
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedDealActionId: `${offeredID}:attacker-suffix`,
    });

    expect(normalized.dealActionID).toBe("");
    expect(normalized.dealActionID).not.toBe(offeredID);
    expect(
      validateAgentDealDecision(
        {
          actionID: "attack:one",
          dealActionID: normalized.dealActionID,
          reason: "prefix collision",
        },
        [
          {
            id: offeredID,
            kind: "deal_propose",
            label: "Offered exact prefix",
            intent: null,
            risk: { level: "low", score: 0.1 },
          },
        ],
      )?.ok,
    ).toBe(false);
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
  const dealAction = {
    id: "deal_propose:P_B:nap",
    kind: "deal_propose",
    label: "Offer pact",
    intent: null,
    risk: { level: "low", score: 0.1 },
  } as never;

  it("carries the comms pair through to the AgentDecision field names", () => {
    // The regression this whole change exists for: before the fix the pair was
    // dropped here, so no league policy could ever speak regardless of flags.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:P_B",
      selectedDealActionId: " deal_propose:P_B:nap ",
      selectedMessageActionId: " message:P_B ",
      messageText: "Truce on our shared border until turn 300.",
      reason: "open negotiation",
    });

    expect(normalized.messageActionID).toBe(" message:P_B ");
    expect(normalized.messageText).toBe(
      "Truce on our shared border until turn 300.",
    );
    // The deal slot is untouched by the comms slot: talking costs neither the
    // move nor the negotiation.
    expect(normalized.actionID).toBe("attack:P_B");
    expect(normalized.dealActionID).toBe(" deal_propose:P_B:nap ");
    expect(
      validateAgentDealDecision(
        {
          actionID: normalized.actionID,
          dealActionID: normalized.dealActionID,
          reason: normalized.reason,
        },
        [dealAction],
      )?.ok,
    ).toBe(false);
    expect(
      validateAgentMessageDecision(
        {
          actionID: normalized.actionID,
          messageActionID: normalized.messageActionID,
          messageText: normalized.messageText,
          reason: normalized.reason,
        },
        [messageAction],
      )?.ok,
    ).toBe(false);
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

  it("passes the body through verbatim, leaving rejection to the validator", () => {
    // Untrimmed and uncollapsed on purpose. The validator rejects unsafe raw
    // layout; rewriting here would make the delivered quote and rejection
    // evidence diverge from what the player authored.
    const text = "  hold\tthe\n\nline  ";
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:P_B",
      messageText: text,
    });
    expect(normalized.messageText).toBe(text);
    expect(
      validateAgentMessageDecision(
        {
          actionID: normalized.actionID,
          messageActionID: normalized.messageActionID,
          messageText: normalized.messageText,
          reason: normalized.reason,
        },
        [messageAction],
      )?.ok,
    ).toBe(false);
  });

  it.each([
    ["blank", "   "],
    ["control-only", "\u0007"],
  ])("keeps a present %s body visible but unaccepted", (_case, text) => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: "message:P_B",
      messageText: text,
    });

    expect(normalized.messageActionID).toBe("message:P_B");
    expect(normalized.messageText).toBe(text);
    expect(
      validateAgentMessageDecision(
        {
          actionID: normalized.actionID,
          messageActionID: normalized.messageActionID,
          messageText: normalized.messageText,
          reason: normalized.reason,
        },
        [messageAction],
      )?.ok,
    ).toBe(false);
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
    // Exact sentinel length remains over the validator cap, so it cannot pass.
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

  it("never truncates an overlong comms id into a valid offered prefix", () => {
    const offeredID = `message:${"m".repeat(
      MAX_WIRE_ACTION_ID_LENGTH - "message:".length,
    )}`;
    expect(offeredID).toHaveLength(MAX_WIRE_ACTION_ID_LENGTH);
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedMessageActionId: `${offeredID}:attacker-suffix`,
      messageText: "hi",
    });
    expect(normalized.messageActionID).toBe("");
    expect(normalized.messageActionID).not.toBe(offeredID);
    expect(
      validateAgentMessageDecision(
        {
          actionID: normalized.actionID,
          messageActionID: normalized.messageActionID,
          messageText: normalized.messageText,
          reason: normalized.reason,
        },
        [
          {
            id: offeredID,
            kind: "message",
            label: "Offered exact prefix",
            intent: null,
            risk: { level: "none", score: 0 },
          } as never,
        ],
      )?.ok,
    ).toBe(false);
  });

  it.each([
    [
      "id without a body",
      { selectedMessageActionId: "message:P_B" },
      "message:P_B",
      undefined,
    ],
    ["body without an id", { messageText: "hello" }, undefined, "hello"],
    [
      "non-string id",
      { selectedMessageActionId: 7, messageText: "hello" },
      undefined,
      "hello",
    ],
    [
      "non-string body",
      { selectedMessageActionId: "message:P_B", messageText: 7 },
      "message:P_B",
      undefined,
    ],
    [
      "null body",
      { selectedMessageActionId: "message:P_B", messageText: null },
      "message:P_B",
      undefined,
    ],
    [
      "object body",
      { selectedMessageActionId: "message:P_B", messageText: { a: 1 } },
      "message:P_B",
      undefined,
    ],
    [
      "array id",
      { selectedMessageActionId: ["message:P_B"], messageText: "hello" },
      undefined,
      "hello",
    ],
    [
      "blank id",
      { selectedMessageActionId: "   ", messageText: "hello" },
      "   ",
      "hello",
    ],
    [
      "blank body",
      { selectedMessageActionId: "message:P_B", messageText: "   \n " },
      "message:P_B",
      "   \n ",
    ],
    ["non-string id only", { selectedMessageActionId: 7 }, "", undefined],
    ["non-string body only", { messageText: 7 }, undefined, ""],
    [
      "both fields non-string",
      { selectedMessageActionId: 7, messageText: { hostile: true } },
      "",
      undefined,
    ],
  ])(
    "keeps a %s attempt observable as bounded fields that cannot be accepted",
    (_case, comms, expectedID, expectedText) => {
      const normalized = normalizeDecisionResponse({
        selectedLegalActionId: "attack:one",
        ...comms,
      });
      expect(normalized.messageActionID).toBe(expectedID);
      expect(normalized.messageText).toBe(expectedText);
      expect(
        validateAgentMessageDecision(
          {
            actionID: normalized.actionID,
            messageActionID: normalized.messageActionID,
            messageText: normalized.messageText,
            reason: normalized.reason,
          },
          [messageAction],
        )?.ok,
      ).toBe(false);
    },
  );

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
    // The REAL composition the episode runner resolves as the AgentDecision,
    // not a hand-rebuilt copy of it: no-docker-coworld-episode.ts cannot be
    // imported (top-level `await main()`), so this used to be reconstructed
    // here — and a reconstruction cannot catch the actual spread being
    // replaced by explicit field picking, which is the drift that would drop
    // a slot again.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedDealActionId: "deal_propose:P_B:nap",
      selectedMessageActionId: "message:P_B",
      messageText: "hello",
    });
    const resolved = composeCoworldDecision({
      normalized,
      message: {},
      slot: 1,
      requestID: "req_1",
      offeredLegalActionCount: 4,
    });
    expect(resolved.dealActionID).toBe("deal_propose:P_B:nap");
    expect(resolved.messageActionID).toBe("message:P_B");
    expect(resolved.messageText).toBe("hello");
    expect(validateAgentDealDecision(resolved as never, [dealAction])?.ok).toBe(
      true,
    );
    expect(
      validateAgentMessageDecision(resolved as never, [messageAction])?.ok,
    ).toBe(true);
  });

  it.each([
    [
      "text only",
      { messageText: "hello" },
      undefined,
      "hello",
      "without a string messageActionID",
    ],
    [
      "id only",
      { selectedMessageActionId: "message:P_B" },
      "message:P_B",
      undefined,
      "carried no messageText",
    ],
    [
      "padded id",
      {
        selectedMessageActionId: " message:P_B ",
        messageText: "hello",
      },
      " message:P_B ",
      "hello",
      "unknown action id",
    ],
  ])(
    "composeCoworldDecision preserves a %s rejection shape",
    (_case, comms, expectedID, expectedText, expectedReason) => {
      const normalized = normalizeDecisionResponse({
        selectedLegalActionId: "attack:one",
        ...comms,
      });
      const resolved = composeCoworldDecision({
        normalized,
        message: {
          selectedLegalActionId: "attack:one",
          ...comms,
        },
        slot: 1,
        requestID: "req_rejected_shape",
        offeredLegalActionCount: 2,
      });

      expect(resolved.messageActionID).toBe(expectedID);
      expect(resolved.messageText).toBe(expectedText);
      const validation = validateAgentMessageDecision(resolved as never, [
        messageAction,
      ]);
      expect(validation?.ok).toBe(false);
      expect(validation && !validation.ok ? validation.reason : "").toContain(
        expectedReason,
      );
    },
  );

  it("composeCoworldDecision preserves padded deal authority for rejection", () => {
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
      selectedDealActionId: " deal_propose:P_B:nap ",
    });
    const resolved = composeCoworldDecision({
      normalized,
      message: {
        selectedLegalActionId: "attack:one",
        selectedDealActionId: " deal_propose:P_B:nap ",
      },
      slot: 1,
      requestID: "req_padded_deal",
      offeredLegalActionCount: 2,
    });

    expect(resolved.dealActionID).toBe(" deal_propose:P_B:nap ");
    expect(validateAgentDealDecision(resolved as never, [dealAction])?.ok).toBe(
      false,
    );
  });
});

describe("composeCoworldDecision", () => {
  const normalized = normalizeDecisionResponse({
    selectedLegalActionId: "attack:one",
    reason: "push north",
  });

  it("adds the episode-local metadata envelope and nothing else", () => {
    const composed = composeCoworldDecision({
      normalized,
      message: { selectedLegalActionId: "attack:one" },
      slot: 2,
      requestID: "req_42",
      offeredLegalActionCount: 7,
    });
    const { metadata, ...selection } = composed;
    // The selection half must be the normalized decision verbatim — the
    // composition's only job is provenance.
    expect(selection).toEqual(normalized);
    expect(metadata).toMatchObject({
      brain: "coworld-websocket",
      externalActionCall: false,
      parseSuccess: true,
      coworldSlot: 2,
      coworldRequestID: "req_42",
      offeredLegalActionCount: 7,
      rawProviderOutputPresent: false,
    });
    expect("externalRawOutput" in metadata).toBe(false);
  });

  it("counts only strict provider-call attestations and preserves bounded usage", () => {
    const composed = composeCoworldDecision({
      normalized,
      message: {
        selectedLegalActionId: "attack:one",
        providerEvidence: {
          callKind: "action",
          provider: "bedrock-sidecar",
          requestedModel: "us.anthropic.claude-sonnet-4-6",
          attemptedModels: [
            "us.anthropic.claude-sonnet-4-6",
            "us.anthropic.claude-haiku-4-5",
          ],
          attemptCount: 2,
          completedAttemptCount: 1,
          failedAttemptCount: 1,
          timedOutAttemptCount: 0,
          responseModel: "us.anthropic.claude-sonnet-4-6",
          requestID: "req-provider-42",
          inputTokens: 3525,
          outputTokens: 87,
          rawOutputPresent: true,
        },
      },
      slot: 2,
      requestID: "req_42",
      offeredLegalActionCount: 7,
    });
    expect(composed.metadata).toMatchObject({
      externalActionCall: true,
      rawProviderOutputPresent: true,
      providerEvidenceSource: "policy-self-attested",
      providerCallKind: "action",
      providerName: "bedrock-sidecar",
      providerRequestedModel: "us.anthropic.claude-sonnet-4-6",
      providerAttemptedModels:
        '["us.anthropic.claude-sonnet-4-6","us.anthropic.claude-haiku-4-5"]',
      providerAttemptCount: 2,
      providerCompletedAttemptCount: 1,
      providerFailedAttemptCount: 1,
      providerTimedOutAttemptCount: 0,
      providerResponseModel: "us.anthropic.claude-sonnet-4-6",
      providerRequestID: "req-provider-42",
      providerInputTokens: 3525,
      providerOutputTokens: 87,
    });
  });

  it("fails closed on malformed provider evidence", () => {
    for (const providerEvidence of [
      { provider: "bedrock-sidecar" },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model with spaces",
      },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model",
        attemptedModels: ["model"],
        attemptCount: 2,
        completedAttemptCount: 1,
        failedAttemptCount: 0,
        timedOutAttemptCount: 0,
        rawOutputPresent: true,
      },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model",
        attemptedModels: Array.from({ length: 9 }, () => "model"),
        attemptCount: 9,
        completedAttemptCount: 9,
        failedAttemptCount: 0,
        timedOutAttemptCount: 0,
        rawOutputPresent: true,
      },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model",
        attemptedModels: ["model"],
        attemptCount: 1,
        completedAttemptCount: 0,
        failedAttemptCount: 0,
        timedOutAttemptCount: 1,
        responseModel: "impossible-response",
        requestID: "impossible-request",
        inputTokens: 1,
        outputTokens: 1,
        rawOutputPresent: true,
      },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model",
        inputTokens: -1,
        rawOutputPresent: true,
      },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model",
        surprise: "unbounded",
        rawOutputPresent: true,
      },
      {
        provider: "bedrock-sidecar",
        callKind: "action",
        requestedModel: "model",
      },
    ]) {
      const composed = composeCoworldDecision({
        normalized,
        message: { providerEvidence },
        slot: 0,
        requestID: "req_bad",
        offeredLegalActionCount: 1,
      });
      expect(composed.metadata.externalActionCall).toBe(false);
      expect(composed.metadata.rawProviderOutputPresent).toBe(false);
      expect(composed.metadata.providerEvidenceInvalid).toBe(true);
      expect("providerName" in composed.metadata).toBe(false);
    }
  });

  it("reports the player's own degradation flags rather than assuming health", () => {
    // The v1 bedrock seat failed silently for 60+ rounds because this was
    // hardcoded healthy; a degraded seat has to reach fallback_count.
    const healthy = composeCoworldDecision({
      normalized,
      message: {},
      slot: 0,
      requestID: "req_1",
      offeredLegalActionCount: 1,
    });
    expect(healthy.metadata.fallbackUsed).toBe(false);
    expect("llmPlannerDegraded" in healthy.metadata).toBe(false);

    const degraded = composeCoworldDecision({
      normalized,
      message: { fallbackUsed: true, llmPlannerDegraded: true },
      slot: 0,
      requestID: "req_1",
      offeredLegalActionCount: 1,
    });
    expect(degraded.metadata.fallbackUsed).toBe(true);
    expect(degraded.metadata.llmPlannerDegraded).toBe(true);
  });

  it("carries one hashed Commander execution envelope into game-owned metadata", () => {
    const envelope = commanderExecutionEnvelope({
      runtimeMode: "commander-v0-selector",
      plannerSource: "strategic-commander-v0",
      externalPlannerCall: true,
      planID: "plan-wire-fixture",
      planObjective: "survive",
      commanderSelectedOptionID: "survive",
      commanderSelectedOptionFamily: "survive",
      commanderSelectorSource: "fallback-deterministic",
      commanderDeterministicPreferredOptionId: "expand",
      commanderDeterministicPreferredOptionAbsent: true,
      commanderFidelity: "aligned_primary",
      commanderBatchFidelities: JSON.stringify({
        "hold:fixture": "aligned_primary",
      }),
      batchIndex: 0,
      batchSize: 1,
      batchActionIDs: "hold:fixture",
    });
    expect(envelope).toBeDefined();
    expect(normalizeCommanderExecutionEnvelope(envelope)).toEqual(envelope);
    expect(envelope?.selection).toEqual({
      planID: "plan-wire-fixture",
      selectedOptionID: "survive",
      selectedOptionFamily: "survive",
      selectorSource: "fallback-deterministic",
      deterministicPreferredOptionID: "expand",
      deterministicPreferredOptionAbsent: true,
    });
    expect(envelope?.selectionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope?.metadata.externalPlannerCall).toBe(true);

    const composed = composeCoworldDecision({
      normalized,
      message: {
        runtimeMode: "commander-v0-selector",
        commanderExecution: envelope,
        providerEvidence: {
          callKind: "planner",
          provider: "bedrock-sidecar",
          requestedModel: "us.anthropic.claude-sonnet-4-6",
          attemptedModels: ["us.anthropic.claude-sonnet-4-6"],
          attemptCount: 1,
          completedAttemptCount: 1,
          failedAttemptCount: 0,
          timedOutAttemptCount: 0,
          rawOutputPresent: true,
        },
      },
      slot: 1,
      requestID: "req_commander_wire",
      offeredLegalActionCount: 1,
    });
    expect(composed.actionID).toBe(normalized.actionID);
    expect(composed.metadata).toMatchObject({
      runtimeMode: "commander-v0-selector",
      planID: "plan-wire-fixture",
      planObjective: "survive",
      commanderFidelity: "aligned_primary",
      externalPlannerCall: true,
      externalActionCall: false,
      providerCallKind: "planner",
      commanderExecutionSha256: envelope?.metadataSha256,
      commanderSelectionSha256: envelope?.selectionSha256,
    });

    const withoutProvider = composeCoworldDecision({
      normalized,
      message: { commanderExecution: envelope },
      slot: 1,
      requestID: "req_commander_no_provider",
      offeredLegalActionCount: 1,
    });
    expect(withoutProvider.metadata.externalPlannerCall).toBe(false);
    expect(withoutProvider.metadata.externalActionCall).toBe(false);

    const denyingEnvelope = commanderExecutionEnvelope({
      runtimeMode: "commander-v0-selector",
      externalPlannerCall: false,
      planID: "plan-wire-denies-provider",
    });
    const providerOverridesLegacyFalse = composeCoworldDecision({
      normalized,
      message: {
        commanderExecution: denyingEnvelope,
        providerEvidence: {
          callKind: "planner",
          provider: "bedrock-sidecar",
          requestedModel: "model",
          attemptedModels: ["model"],
          attemptCount: 1,
          completedAttemptCount: 1,
          failedAttemptCount: 0,
          timedOutAttemptCount: 0,
          rawOutputPresent: true,
        },
      },
      slot: 1,
      requestID: "req_provider_overrides_false",
      offeredLegalActionCount: 1,
    });
    expect(providerOverridesLegacyFalse.metadata.externalPlannerCall).toBe(
      true,
    );
    expect(providerOverridesLegacyFalse.metadata.externalActionCall).toBe(
      false,
    );

    const tampered = structuredClone(envelope!);
    tampered.metadata.planObjective = "pressure_rival:forged";
    expect(normalizeCommanderExecutionEnvelope(tampered)).toBeNull();
    const ignored = composeCoworldDecision({
      normalized,
      message: { commanderExecution: tampered },
      slot: 1,
      requestID: "req_commander_wire_tampered",
      offeredLegalActionCount: 1,
    });
    expect(ignored.metadata).not.toHaveProperty("commanderExecutionSha256");
    expect(ignored.metadata).not.toHaveProperty("planObjective");

    const divergentSelection = structuredClone(envelope!);
    divergentSelection.selection.selectedOptionID = "expand";
    expect(normalizeCommanderExecutionEnvelope(divergentSelection)).toBeNull();
  });

  it("forwards all five exact runtime modes and rejects near-miss or forged values", () => {
    for (const runtimeMode of agentRuntimeModes) {
      expect(normalizeAgentRuntimeMode(runtimeMode)).toBe(runtimeMode);
      expect(normalizeRuntimeMode(runtimeMode)).toBe(runtimeMode);
      const composed = composeCoworldDecision({
        normalized,
        message: { runtimeMode },
        slot: 0,
        requestID: `req_${runtimeMode}`,
        offeredLegalActionCount: 1,
      });
      expect(composed.metadata.runtimeMode).toBe(runtimeMode);
    }

    for (const runtimeMode of [
      " llm-policy-planner",
      "LLM-POLICY-PLANNER",
      "llm-policy-planner-extra",
      "",
      7,
      null,
      { mode: "llm-policy-planner" },
      ["llm-policy-planner"],
      "x".repeat(3_000),
    ]) {
      expect(normalizeAgentRuntimeMode(runtimeMode)).toBeUndefined();
      expect(normalizeRuntimeMode(runtimeMode)).toBeUndefined();
      const composed = composeCoworldDecision({
        normalized,
        message: { runtimeMode },
        slot: 0,
        requestID: "req_forged_mode",
        offeredLegalActionCount: 1,
      });
      expect(composed.metadata).not.toHaveProperty("runtimeMode");
    }
  });

  it("does not mislabel an ordinary websocket frame as provider output", () => {
    const composed = composeCoworldDecision({
      normalized,
      message: { reason: "r".repeat(5_000), confidence: 0.5 },
      slot: 0,
      requestID: "req_1",
      offeredLegalActionCount: 1,
    });
    expect(composed.metadata.externalRawOutput).toBeUndefined();
    expect(composed.metadata.externalActionCall).toBe(false);
    expect(composed.metadata.rawProviderOutputPresent).toBe(false);
    expect(composed.metadata.confidence).toBe(0.5);
    // A non-numeric confidence is dropped, never coerced into a fake score.
    expect(
      composeCoworldDecision({
        normalized,
        message: { confidence: "high" },
        slot: 0,
        requestID: "req_1",
        offeredLegalActionCount: 1,
      }).metadata.confidence,
    ).toBeUndefined();
  });
});

describe("degraded cause on the wire", () => {
  const normalized = normalizeDecisionResponse({
    selectedLegalActionId: "attack:one",
    reason: "push north",
  });

  it("mirrors the canonical SELF-REPORTED vocabulary exactly", () => {
    // Same reason the action cap is mirrored: the deployed player image cannot
    // value-import from src/. Drift must fail here rather than silently drop a
    // cause the league is already emitting.
    const canonicalSelfReported = AGENT_DEGRADATION_CAUSES.filter((cause) =>
      isSelfReportedDegradationCause(cause),
    );
    for (const cause of canonicalSelfReported) {
      expect(
        normalizeDegradedCause(cause),
        `${cause} is canonical but the adapter mirror rejects it`,
      ).toBe(cause);
    }
    const canonicalServerObserved = AGENT_DEGRADATION_CAUSES.filter(
      (cause) => !isSelfReportedDegradationCause(cause),
    );
    for (const cause of canonicalServerObserved) {
      expect(
        normalizeDegradedCause(cause),
        `${cause} is a SERVER observation and must not be accepted from a player`,
      ).toBeUndefined();
    }
  });

  it("mirrors the complete canonical vocabulary for trusted decision records", () => {
    for (const cause of AGENT_DEGRADATION_CAUSES) {
      expect(
        normalizeRecordedDegradationCause(cause),
        `${cause} is canonical but the trusted-record parser rejects it`,
      ).toBe(cause);
    }
    for (const unknown of ["", "plan-parse-ish", " brain-timeout", null]) {
      expect(normalizeRecordedDegradationCause(unknown)).toBeUndefined();
    }
  });

  it("rejects near-miss and hostile causes instead of coercing them", () => {
    for (const value of [
      " plan-warmup",
      "PLAN-WARMUP",
      "plan-warmupX",
      "plan",
      "",
      undefined,
      null,
      7,
      {},
      ["plan-warmup"],
      "x".repeat(3_000),
    ]) {
      expect(normalizeDegradedCause(value)).toBeUndefined();
    }
  });

  it("carries a self-reported cause only alongside the policy's own degraded flag", () => {
    const composedWithFlag = composeCoworldDecision({
      normalized,
      message: {
        selectedLegalActionId: "attack:one",
        llmPlannerDegraded: true,
        degradedCause: "plan-warmup",
      },
      slot: 1,
      requestID: "req_cause",
      offeredLegalActionCount: 3,
    });
    expect(composedWithFlag.metadata).toMatchObject({
      llmPlannerDegraded: true,
      degradedCause: "plan-warmup",
    });

    // A cause without the flag would let a seat that reported HEALTH carry
    // failure evidence — the record must stay clean.
    const composedWithoutFlag = composeCoworldDecision({
      normalized,
      message: {
        selectedLegalActionId: "attack:one",
        degradedCause: "plan-unavailable",
      },
      slot: 1,
      requestID: "req_nocause",
      offeredLegalActionCount: 3,
    });
    expect(composedWithoutFlag.metadata).not.toHaveProperty("degradedCause");
    expect(composedWithoutFlag.metadata.llmPlannerDegraded).toBeUndefined();
  });

  it("refuses a forged SERVER observation from the player frame", () => {
    // `brain-timeout` asserts the server never heard from this seat. This seat
    // answered, so the claim is false by construction and must not be recorded —
    // while its honest degradation flag still stands.
    for (const forged of ["brain-timeout", "brain-error"]) {
      const composed = composeCoworldDecision({
        normalized,
        message: {
          selectedLegalActionId: "attack:one",
          llmPlannerDegraded: true,
          degradedCause: forged,
        },
        slot: 4,
        requestID: `req_${forged}`,
        offeredLegalActionCount: 5,
      });
      expect(composed.metadata).not.toHaveProperty("degradedCause");
      expect(composed.metadata.llmPlannerDegraded).toBe(true);
    }
  });
});
