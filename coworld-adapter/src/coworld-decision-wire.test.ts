import { describe, expect, it } from "vitest";

import { validateAgentMessageDecision } from "../../src/server/agents/AgentDecisionValidator.ts";
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
import {
  composeCoworldDecision,
  COWORLD_AGENT_RUNTIME_MODES,
  decisionRequestEnvelope,
  MAX_WIRE_ACTION_ID_LENGTH,
  MAX_WIRE_ACTIONS_PER_DECISION,
  MAX_WIRE_MESSAGE_TEXT_LENGTH,
  MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
  normalizeDecisionResponse,
  normalizeDegradedCause,
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
    // The REAL composition the episode runner resolves as the AgentDecision,
    // not a hand-rebuilt copy of it: no-docker-coworld-episode.ts cannot be
    // imported (top-level `await main()`), so this used to be reconstructed
    // here — and a reconstruction cannot catch the actual spread being
    // replaced by explicit field picking, which is the drift that would drop
    // a slot again.
    const normalized = normalizeDecisionResponse({
      selectedLegalActionId: "attack:one",
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
    expect(resolved.messageActionID).toBe("message:P_B");
    expect(resolved.messageText).toBe("hello");
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
      externalActionCall: true,
      parseSuccess: true,
      coworldSlot: 2,
      coworldRequestID: "req_42",
      offeredLegalActionCount: 7,
      rawProviderOutputPresent: true,
    });
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

  it("bounds the raw frame it stamps as evidence", () => {
    const composed = composeCoworldDecision({
      normalized,
      message: { reason: "r".repeat(5_000), confidence: 0.5 },
      slot: 0,
      requestID: "req_1",
      offeredLegalActionCount: 1,
    });
    expect(String(composed.metadata.externalRawOutput)).toHaveLength(1_000);
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
