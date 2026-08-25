import { describe, expect, it } from "vitest";
import {
  chooseKeystoneMessageIntent,
  decisionToResponse,
  withKeystoneMessage,
} from "../../coworld-adapter/src/keystone-player";
import { validateAgentMessageDecision } from "../../src/server/agents/AgentDecisionValidator";
import type {
  AgentDecision,
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

// Minimal shapes: the chooser reads only inbound messages, visible players and
// the deal views, so the fixture states exactly those rather than a whole
// observation (which would hide which field drives which branch).
function observation(
  overrides: Partial<AgentObservation> & {
    inbound?: Array<{ senderID: string; turnNumber: number }>;
    rivals?: Array<{
      playerID: string;
      sharesBorder?: boolean;
      isAllied?: boolean;
    }>;
  } = {},
): AgentObservation {
  const { inbound = [], rivals = [], ...rest } = overrides;
  return {
    visiblePlayers: rivals,
    nonCombat: { inboundMessages: inbound },
    deals: { incomingProposals: [], outgoingProposals: [], activeDeals: [] },
    ...rest,
  } as unknown as AgentObservation;
}

function messageOffer(recipientID: string): LegalAction {
  return {
    id: `message:${recipientID}`,
    kind: "message",
    label: `Message ${recipientID}`,
    intent: null,
    risk: { level: "none", score: 0 },
    metadata: { recipientID },
  } as unknown as LegalAction;
}

const holdAction = {
  id: "hold",
  kind: "hold",
  label: "Hold",
  intent: null,
  risk: { level: "none", score: 0 },
} as unknown as LegalAction;

describe("keystone free-text voice", () => {
  it("stays silent when the menu offers no comms slot (flag off, or spawn phase)", () => {
    expect(
      chooseKeystoneMessageIntent([holdAction], observation(), new Set()),
    ).toBeNull();
  });

  it("answers the newest inbound message from a rival that offered a slot", () => {
    const move = chooseKeystoneMessageIntent(
      [holdAction, messageOffer("rival-a")],
      observation({ inbound: [{ senderID: "rival-a", turnNumber: 120 }] }),
      new Set(),
    );
    expect(move?.actionID).toBe("message:rival-a");
    expect(move?.purpose).toBe("reply");
    expect(move).not.toHaveProperty("text");
  });

  it("never answers the same inbound turn twice", () => {
    const answered = new Set<string>();
    const actions = [messageOffer("rival-a")];
    const obs = observation({
      inbound: [{ senderID: "rival-a", turnNumber: 120 }],
    });
    const first = chooseKeystoneMessageIntent(actions, obs, answered);
    expect(first).not.toBeNull();
    first?.commit?.();
    expect(chooseKeystoneMessageIntent(actions, obs, answered)).toBeNull();
  });

  // The defect this budget exists for: every reply becomes a NEW inbound turn
  // on the other side, so a per-turn guard alone lets two agents ping-pong
  // forever. `ereq_3fc90743` produced 861 replies that way.
  it("terminates an exchange at three replies per rival even as turns keep arriving", () => {
    const answered = new Set<string>();
    const actions = [messageOffer("rival-a")];
    let sent = 0;
    for (let turn = 100; turn < 100 + 200 * 10; turn += 10) {
      const move = chooseKeystoneMessageIntent(
        actions,
        observation({ inbound: [{ senderID: "rival-a", turnNumber: turn }] }),
        answered,
      );
      if (move !== null) {
        sent += 1;
        move.commit?.();
      }
    }
    expect(sent).toBe(3);
  });

  it("keeps the budget per counterparty", () => {
    const answered = new Set<string>();
    for (let turn = 100; turn < 200; turn += 10) {
      chooseKeystoneMessageIntent(
        [messageOffer("rival-a")],
        observation({ inbound: [{ senderID: "rival-a", turnNumber: turn }] }),
        answered,
      )?.commit?.();
    }
    const other = chooseKeystoneMessageIntent(
      [messageOffer("rival-b")],
      observation({ inbound: [{ senderID: "rival-b", turnNumber: 300 }] }),
      answered,
    );
    expect(other?.actionID).toBe("message:rival-b");
  });

  it("opens to a bordering rival once per match, and never to an ally", () => {
    const answered = new Set<string>();
    const actions = [messageOffer("rival-a"), messageOffer("ally-b")];
    const obs = observation({
      rivals: [
        { playerID: "rival-a", sharesBorder: true, isAllied: false },
        { playerID: "ally-b", sharesBorder: true, isAllied: true },
      ],
    });
    const opener = chooseKeystoneMessageIntent(actions, obs, answered);
    expect(opener?.actionID).toBe("message:rival-a");
    opener?.commit?.();
    expect(chooseKeystoneMessageIntent(actions, obs, answered)).toBeNull();
  });

  it("does not open to a rival it shares no border with", () => {
    expect(
      chooseKeystoneMessageIntent(
        [messageOffer("far-c")],
        observation({
          rivals: [{ playerID: "far-c", sharesBorder: false, isAllied: false }],
        }),
        new Set(),
      ),
    ).toBeNull();
  });

  it("stays silent rather than talking past someone whose budget is spent", () => {
    const answered = new Set<string>();
    const actions = [messageOffer("rival-a"), messageOffer("rival-b")];
    const obs = (turn: number) =>
      observation({
        inbound: [{ senderID: "rival-a", turnNumber: turn }],
        rivals: [{ playerID: "rival-b", sharesBorder: true, isAllied: false }],
      });
    for (let turn = 100; turn < 180; turn += 10) {
      chooseKeystoneMessageIntent(actions, obs(turn), answered)?.commit?.();
    }
    // rival-a is exhausted; rival-b borders us and is unwritten — but an
    // unanswered inbound must not be stepped over to start a new conversation.
    expect(chooseKeystoneMessageIntent(actions, obs(500), answered)).toBeNull();
  });

  it("a generated line survives the server-side message validator", () => {
    const move = {
      actionID: "message:rival-a",
      text: "Hold west until turn 240; I will keep my troops east.",
    };
    const validation = validateAgentMessageDecision(
      { messageActionID: move.actionID, messageText: move.text } as never,
      [messageOffer("rival-a")],
    );
    expect(validation).not.toBeNull();
    if (validation === null || validation.ok !== true) {
      throw new Error(
        `validator rejected generated prose: ${validation === null ? "null" : validation.reason}`,
      );
    }
    expect(validation.text).toBe(move.text);
  });

  it("attaches the pair to a decision without clobbering a brain that already spoke", () => {
    const base = { actionID: "hold", reason: "r" } as unknown as AgentDecision;
    expect(
      withKeystoneMessage(base, { actionID: "message:x", text: "hi" }),
    ).toMatchObject({ messageActionID: "message:x", messageText: "hi" });
    expect(withKeystoneMessage(base, null)).toBe(base);
    const spoken = {
      ...base,
      messageActionID: "message:own",
      messageText: "mine",
    } as AgentDecision;
    expect(
      withKeystoneMessage(spoken, { actionID: "message:x", text: "hi" })
        .messageActionID,
    ).toBe("message:own");
  });

  // The wire half. decisionToResponse PICKS fields, so a decision that speaks
  // reaches no artifact unless the pair is named — the same omission that made
  // every hosted message vanish before PR #125.
  it("carries the comms pair onto the wire, and only as a pair", () => {
    const spoke = decisionToResponse("req-1", {
      actionID: "hold",
      reason: "r",
      messageActionID: "message:rival-a",
      messageText: "we hold",
    } as unknown as AgentDecision);
    expect(spoke.selectedMessageActionId).toBe("message:rival-a");
    expect(spoke.messageText).toBe("we hold");

    const silent = decisionToResponse("req-2", {
      actionID: "hold",
      reason: "r",
    } as unknown as AgentDecision);
    expect(silent).not.toHaveProperty("selectedMessageActionId");
    expect(silent).not.toHaveProperty("messageText");

    const idOnly = decisionToResponse("req-3", {
      actionID: "hold",
      reason: "r",
      messageActionID: "message:rival-a",
    } as unknown as AgentDecision);
    expect(idOnly).not.toHaveProperty("selectedMessageActionId");
  });
});
