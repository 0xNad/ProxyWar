import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOpenEndedMessagePrompt,
  chooseOpenEndedMessageIntent,
  parseOpenEndedMessageResponse,
} from "./open-ended-message.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixture() {
  const dealID = "deal:P_A:P_B:non_aggression_pact:7";
  const messageEventID = "msg_12345678-1234-4123-8123-123456789abc";
  return {
    actions: [
      {
        id: "message:P_B",
        kind: "message",
        metadata: { recipientID: "P_B" },
      },
    ],
    observation: {
      turnNumber: 800,
      ownState: {
        playerID: "P_A",
        name: "Builder",
        troops: 1200,
        tileShare: 0.22,
        incomingAttacks: 0,
      },
      visiblePlayers: [
        {
          playerID: "P_B",
          name: "Rival North",
          isAllied: false,
          isFriendly: false,
          sharesBorder: true,
          relation: -1,
          relativeTroopRatio: 1.2,
          bearing: "north",
          distanceClass: "adjacent",
        },
      ],
      deals: {
        incomingProposals: [
          {
            dealID,
            proposerPlayerID: "P_B",
            recipientPlayerID: "P_A",
            terms: { template: "non_aggression_pact" },
          },
        ],
        outgoingProposals: [],
        activeDeals: [],
      },
      nonCombat: {
        inboundMessages: [
          {
            messageEventID,
            senderID: "P_B",
            senderName: "Rival North",
            turnNumber: 700,
            text: "Will you hold the northern border if I accept your pact?",
          },
        ],
      },
    },
    dealID,
    messageEventID,
  };
}

test("intent binds one offered recipient but commits only after generation", () => {
  const { actions, observation, messageEventID } = fixture();
  const answered = new Set();
  const intent = chooseOpenEndedMessageIntent(
    actions,
    observation,
    answered,
    null,
    280,
  );
  assert.equal(intent.actionID, "message:P_B");
  assert.equal(intent.recipientID, "P_B");
  assert.equal(intent.purpose, "reply");
  assert.equal(answered.size, 0);
  intent.commit();
  assert.ok(answered.has(messageEventID));
  assert.ok(answered.has("reply:P_B:0"));
});

test("authoring prompt contains live semantics but no private identifiers", () => {
  const { actions, observation, dealID, messageEventID } = fixture();
  const intent = chooseOpenEndedMessageIntent(
    actions,
    observation,
    new Set(),
    null,
    280,
  );
  const prompt = buildOpenEndedMessagePrompt({
    intent,
    observation,
    gameplayKind: "build",
    dealKind: "deal_accept",
  });
  assert.match(prompt, /Rival North/u);
  assert.match(prompt, /northern border/u);
  assert.match(prompt, /non_aggression_pact/u);
  assert.doesNotMatch(prompt, /message:P_B/u);
  assert.doesNotMatch(prompt, /\bP_[AB]\b/u);
  assert.doesNotMatch(prompt, new RegExp(messageEventID, "u"));
  assert.doesNotMatch(prompt, new RegExp(dealID, "u"));
});

test("valid model bodies survive byte-for-byte and remain distinct", () => {
  const first = "Hold the north for three turns; I’ll accept the pact.";
  const second = "No pact yet—pull back first, then ask me again.";
  assert.equal(
    parseOpenEndedMessageResponse(JSON.stringify({ message: first }), 280),
    first,
  );
  assert.equal(
    parseOpenEndedMessageResponse(JSON.stringify({ message: second }), 280),
    second,
  );
  assert.notEqual(first, second);
});

test("malformed or unsafe model output is rejected without rewriting", () => {
  for (const raw of [
    "not json",
    '```json\n{"message":"hello"}\n```',
    JSON.stringify({ message: "" }),
    JSON.stringify({ message: "hello\nthere" }),
    JSON.stringify({ message: "hello\u202ethere" }),
    JSON.stringify({ message: "x".repeat(281) }),
    JSON.stringify({ message: "hello", actionID: "message:P_B" }),
  ]) {
    assert.throws(() => parseOpenEndedMessageResponse(raw, 280));
  }
});

test("LLM runtime contains no deterministic negotiation templates", () => {
  const source = fs.readFileSync(path.join(HERE, "llm-player.mjs"), "utf8");
  const dockerfile = fs.readFileSync(path.join(HERE, "Dockerfile"), "utf8");
  assert.doesNotMatch(source, /MESSAGE_REPLIES|MESSAGE_OPENERS/u);
  assert.doesNotMatch(source, /We are allied\. I will not move/u);
  assert.match(source, /authorOpenEndedMessage/u);
  assert.match(source, /messageFailed/u);
  assert.match(dockerfile, /COPY .*open-ended-message\.mjs/u);
});
