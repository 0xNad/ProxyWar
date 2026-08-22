import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  composeCoworldDecision,
  normalizeDecisionResponse,
} from "../../coworld-adapter/src/coworld-decision-wire";
import type { AgentInboundMessage } from "../../src/server/agents/AgentTypes";
import {
  dealLeagueHarness,
  type ScriptedPicker,
  type StubSeat,
} from "./DealTestHarness";

// End-to-end delivery for the comms slot (PROXYWAR_TUNE_FREETEXT_MESSAGES):
// a scripted seat selects a `message` action, and the message must reach the
// RECIPIENT's next observation and nobody else's. The unit tests cover the
// validator and the windowing; this covers the wiring between them, which is
// where privacy is actually decided.

const FLAG = "PROXYWAR_TUNE_FREETEXT_MESSAGES";

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const C: StubSeat = { agentID: "c1", playerID: "P_C", username: "Riven" };

/** Selects hold plus a message to `recipientPlayerID`, if one is offered. */
function sendMessageTo(
  recipientPlayerID: string,
  text: string,
): ScriptedPicker {
  return (input) => {
    const offer = input.legalActions.find(
      (action) =>
        action.kind === "message" &&
        action.metadata?.recipientID === recipientPlayerID,
    );
    return {
      actionID: null,
      ...(offer ? { messageActionID: offer.id, messageText: text } : {}),
    };
  };
}

function rawMessagePairTo(
  recipientPlayerID: string,
  buildPair: (offeredID: string) => {
    messageActionID?: string;
    messageText?: string;
  },
): ScriptedPicker {
  return (input) => {
    const offer = input.legalActions.find(
      (action) =>
        action.kind === "message" &&
        action.metadata?.recipientID === recipientPlayerID,
    );
    return {
      actionID: null,
      ...buildPair(offer?.id ?? `message:${recipientPlayerID}`),
    };
  };
}

const quiet: ScriptedPicker = () => null;

function inboxOf(
  handles: ReturnType<typeof dealLeagueHarness>["handles"],
  seatIndex: number,
  callIndex: number,
): AgentInboundMessage[] {
  return (
    handles[seatIndex].inputs[callIndex]?.observation.nonCombat
      .inboundMessages ?? []
  );
}

/**
 * These runners never join a real game, so a genuine `agent_message` intent
 * always fails on transport. Stub submission to ACCEPTED so the tests exercise
 * delivery, routing, and privacy rather than the socket. The intent itself is
 * covered by tests/AgentMessageExecution.test.ts and the schema tests.
 */
function stubAcceptedSubmission(
  harness: ReturnType<typeof dealLeagueHarness>,
  onSubmit?: () => void,
): void {
  for (const runner of harness.runners) {
    runner.submitAgentMessage = () => {
      onSubmit?.();
      return {
        accepted: true,
        reason: "stubbed transport",
        intent: null,
      };
    };
  }
}

describe("free-text message delivery and privacy", () => {
  beforeEach(() => {
    process.env[FLAG] = "1";
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("delivers a message to the recipient's NEXT observation only", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [
          sendMessageTo("P_B", "Hold the north and I will not touch you."),
          quiet,
        ],
        [quiet, quiet],
        [quiet, quiet],
      ],
    });

    stubAcceptedSubmission(harness);

    await harness.league.runDecisionTurn({ turnNumber: 0 });
    // Nobody has an inbox on the turn the message is sent.
    expect(inboxOf(harness.handles, 1, 0)).toHaveLength(0);

    await harness.league.runDecisionTurn({ turnNumber: 25 });

    const recipientInbox = inboxOf(harness.handles, 1, 1);
    expect(recipientInbox).toHaveLength(1);
    expect(recipientInbox[0]).toMatchObject({
      senderID: "P_A",
      senderName: "Auri",
      text: "Hold the north and I will not touch you.",
    });
  });

  it("never shows an A->B message to the uninvolved seat C", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B, C],
      scripts: [
        [sendMessageTo("P_B", "secret pact terms"), quiet],
        [quiet, quiet],
        [quiet, quiet],
      ],
    });

    stubAcceptedSubmission(harness);

    await harness.league.runDecisionTurn({ turnNumber: 0 });
    await harness.league.runDecisionTurn({ turnNumber: 25 });

    expect(inboxOf(harness.handles, 2, 1)).toHaveLength(0);
    // The sender does not receive its own message back either.
    expect(inboxOf(harness.handles, 0, 1)).toHaveLength(0);
  });

  it("records the message on the sender's decision record verbatim", async () => {
    const text = "I will hold the north line, on my word.";
    const harness = dealLeagueHarness({
      seats: [A, B],
      scripts: [[sendMessageTo("P_B", text)], [quiet]],
    });

    stubAcceptedSubmission(harness);

    await harness.league.runDecisionTurn({ turnNumber: 0 });

    const senderRecord = harness
      .records()
      .find((record) => record.agentID === "a1");
    expect(senderRecord?.decisionMetadata).toMatchObject({
      commsSlotRecipientID: "P_B",
      commsSlotText: text,
    });
  });

  it.each([
    ["U+2028 LINE SEPARATOR", "\u2028"],
    ["U+2029 PARAGRAPH SEPARATOR", "\u2029"],
  ])("rejects %s before recording or delivery", async (_, separator) => {
    const harness = dealLeagueHarness({
      seats: [A, B],
      scripts: [
        [sendMessageTo("P_B", `hold${separator}then attack`), quiet],
        [quiet, quiet],
      ],
    });

    stubAcceptedSubmission(harness);

    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const senderRecord = harness
      .records()
      .find((record) => record.agentID === "a1");
    expect(senderRecord?.decisionMetadata).toMatchObject({
      commsSlotRejected:
        "messageText contained invisible formatting or bidi-override characters",
    });
    expect(senderRecord?.decisionMetadata?.commsSlotText).toBeUndefined();

    await harness.league.runDecisionTurn({ turnNumber: 25 });
    expect(inboxOf(harness.handles, 1, 1)).toHaveLength(0);
  });

  it("rejects a padded offered message id without submission or delivery", async () => {
    let submitCalls = 0;
    const harness = dealLeagueHarness({
      seats: [A, B],
      scripts: [
        [
          rawMessagePairTo("P_B", (offeredID) => ({
            messageActionID: ` ${offeredID} `,
            messageText: "hold the north",
          })),
          quiet,
        ],
        [quiet, quiet],
      ],
    });
    stubAcceptedSubmission(harness, () => {
      submitCalls += 1;
    });

    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const senderRecord = harness
      .records()
      .find((record) => record.agentID === "a1");
    expect(senderRecord?.decisionMetadata).toMatchObject({
      commsSlotRequestedID: " message:P_B ",
      commsSlotRejected:
        "message selection named unknown action id:  message:P_B ",
    });
    expect(senderRecord?.decisionMetadata?.commsSlotText).toBeUndefined();
    expect(submitCalls).toBe(0);

    await harness.league.runDecisionTurn({ turnNumber: 25 });
    expect(inboxOf(harness.handles, 1, 1)).toHaveLength(0);
  });

  it.each([
    ["blank", "   ", "carried blank messageText"],
    ["control-only", "\u0007", "contained control characters"],
  ])(
    "rejects a present %s message pair without submission or delivery",
    async (_case, messageText, expectedReason) => {
      let submitCalls = 0;
      const harness = dealLeagueHarness({
        seats: [A, B],
        scripts: [
          [sendMessageTo("P_B", messageText), quiet],
          [quiet, quiet],
        ],
      });
      stubAcceptedSubmission(harness, () => {
        submitCalls += 1;
      });

      await harness.league.runDecisionTurn({ turnNumber: 0 });
      const senderRecord = harness
        .records()
        .find((record) => record.agentID === "a1");
      expect(senderRecord?.decisionMetadata?.commsSlotRequestedID).toBe(
        "message:P_B",
      );
      expect(senderRecord?.decisionMetadata?.commsSlotRejected).toContain(
        expectedReason,
      );
      expect(senderRecord?.decisionMetadata?.commsSlotText).toBeUndefined();
      expect(submitCalls).toBe(0);

      await harness.league.runDecisionTurn({ turnNumber: 25 });
      expect(inboxOf(harness.handles, 1, 1)).toHaveLength(0);
    },
  );

  it.each([
    [
      "id only",
      (offeredID: string) => ({ messageActionID: offeredID }),
      "message:P_B",
      "carried no messageText",
    ],
    [
      "text only",
      () => ({ messageText: "present without id" }),
      undefined,
      "without a string messageActionID",
    ],
  ] as const)(
    "rejects a partial comms pair (%s) without submission or delivery",
    async (_case, buildPair, expectedRequestedID, expectedReason) => {
      let submitCalls = 0;
      const harness = dealLeagueHarness({
        seats: [A, B],
        scripts: [
          [rawMessagePairTo("P_B", buildPair), quiet],
          [quiet, quiet],
        ],
      });
      stubAcceptedSubmission(harness, () => {
        submitCalls += 1;
      });

      await harness.league.runDecisionTurn({ turnNumber: 0 });
      const senderRecord = harness
        .records()
        .find((record) => record.agentID === "a1");
      expect(senderRecord?.decisionMetadata?.commsSlotRequestedID).toBe(
        expectedRequestedID,
      );
      expect(senderRecord?.decisionMetadata?.commsSlotRejected).toContain(
        expectedReason,
      );
      expect(senderRecord?.decisionMetadata?.commsSlotText).toBeUndefined();
      expect(submitCalls).toBe(0);

      await harness.league.runDecisionTurn({ turnNumber: 25 });
      expect(inboxOf(harness.handles, 1, 1)).toHaveLength(0);
    },
  );

  it("stamps a Coworld text-only attempt without fabricating a requested id", async () => {
    let submitCalls = 0;
    const wireMessage = {
      selectedLegalActionId: "hold",
      messageText: "present without id",
    };
    const composed = composeCoworldDecision({
      normalized: normalizeDecisionResponse(wireMessage),
      message: wireMessage,
      slot: 0,
      requestID: "req_text_only",
      offeredLegalActionCount: 2,
    });
    const harness = dealLeagueHarness({
      seats: [A, B],
      scripts: [
        [() => composed, quiet],
        [quiet, quiet],
      ],
    });
    stubAcceptedSubmission(harness, () => {
      submitCalls += 1;
    });

    await harness.league.runDecisionTurn({ turnNumber: 0 });
    const senderRecord = harness
      .records()
      .find((record) => record.agentID === "a1");
    expect(
      senderRecord?.decisionMetadata?.commsSlotRequestedID,
    ).toBeUndefined();
    expect(senderRecord?.decisionMetadata?.commsSlotRejected).toBe(
      "messageText was present without a string messageActionID",
    );
    expect(senderRecord?.decisionMetadata?.commsSlotText).toBeUndefined();
    expect(submitCalls).toBe(0);

    await harness.league.runDecisionTurn({ turnNumber: 25 });
    expect(inboxOf(harness.handles, 1, 1)).toHaveLength(0);
  });

  it("rejects a comms slot naming a non-message action and leaves the game action alone", async () => {
    const harness = dealLeagueHarness({
      seats: [A, B],
      scripts: [
        [
          (input) => {
            const hold = input.legalActions.find(
              (action) => action.kind === "hold",
            );
            return {
              actionID: hold?.id ?? null,
              // A game action smuggled into the comms slot.
              messageActionID:
                input.legalActions.find((action) => action.kind === "attack")
                  ?.id ?? "attack:P_B",
              messageText: "give me your troops",
            };
          },
        ],
        [quiet],
      ],
    });

    stubAcceptedSubmission(harness);

    await harness.league.runDecisionTurn({ turnNumber: 0 });

    const record = harness.records().find((r) => r.agentID === "a1");
    expect(record?.decisionMetadata?.commsSlotRejected).toContain(
      "non-message action kind",
    );
    expect(record?.decisionMetadata?.commsSlotText).toBeUndefined();
  });

  it("delivers nothing at all when the flag is off", async () => {
    delete process.env[FLAG];
    const harness = dealLeagueHarness({
      seats: [A, B],
      scripts: [[sendMessageTo("P_B", "hello")], [quiet]],
    });

    stubAcceptedSubmission(harness);

    await harness.league.runDecisionTurn({ turnNumber: 0 });
    await harness.league.runDecisionTurn({ turnNumber: 25 });

    expect(inboxOf(harness.handles, 1, 1)).toHaveLength(0);
    const record = harness.records().find((r) => r.agentID === "a1");
    expect(record?.decisionMetadata?.commsSlotText).toBeUndefined();
    expect(record?.decisionMetadata?.commsSlotRejected).toBeUndefined();
  });
});
