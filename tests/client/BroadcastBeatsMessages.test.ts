import { afterEach, describe, expect, it } from "vitest";
import {
  curatedWarRoomEvents,
  matchTimelineEventMarkers,
  MESSAGE_BEATS_DISPLAY_GLOBAL,
  recordedAgentMessages,
  type AiLeagueSpectatorTelemetry,
  type RecordedAgentMessage,
} from "../../src/client/BroadcastBeats";
import { severityOf } from "../../src/client/graphics/layers/WarRoomToasts";

/**
 * MESSAGE beats (free-text negotiation viewer surface). The source contract
 * under test: beats derive from the RECORD's server-relayed `agent_message`
 * intents — the turn stream — never from a decision record alone. A queued
 * intent may still be dropped if its recipient dies before core execution.
 */

function telemetryWith(
  agents: Array<{ playerID: string | null; username: string }>,
): AiLeagueSpectatorTelemetry {
  return {
    version: 1,
    runID: "run-1",
    agents,
    relationships: [],
    events: [],
    communicationThreads: [],
    timelineBuckets: [],
  };
}

const ROSTER = telemetryWith([
  { playerID: "p1", username: "Auri" },
  { playerID: "p2", username: "Calc" },
  { playerID: "p3", username: "Jordan" },
]);

const MESSAGE_EVENT_ID = "msg_00000000-0000-4000-8000-000000000001";

function message(
  overrides: Partial<RecordedAgentMessage> = {},
): RecordedAgentMessage {
  return {
    turn: 900,
    sequence: 0,
    senderName: "Auri",
    recipientPlayerID: "p2",
    text: "We share a border. Pact?",
    ...overrides,
  };
}

function messageEvents(
  telemetry: AiLeagueSpectatorTelemetry | null,
  messages: readonly RecordedAgentMessage[],
) {
  return curatedWarRoomEvents(telemetry, [], null, messages).filter(
    (event) => event.kind === "message",
  );
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[MESSAGE_BEATS_DISPLAY_GLOBAL];
});

describe("recordedAgentMessages — the turn stream is the source", () => {
  const record = {
    info: {
      players: [
        { clientID: "c1", username: "Auri" },
        { clientID: "c2", username: "Calc" },
      ],
    },
    turns: [
      {
        turnNumber: 900,
        intents: [
          {
            type: "agent_message",
            clientID: "c1",
            recipient: "p2",
            text: "Pact?",
            messageEventID: MESSAGE_EVENT_ID,
          },
          { type: "attack", clientID: "c2", troops: 100 },
        ],
      },
      { turnNumber: 930 }, // malformed turn: no intents array
      {
        turnNumber: 950,
        intents: [
          {
            type: "agent_message",
            clientID: "c2",
            recipient: "p1",
            text: "Maybe.",
          },
          // Unknown sender: dropped rather than misattributed.
          {
            type: "agent_message",
            clientID: "ghost",
            recipient: "p1",
            text: "boo",
          },
        ],
      },
    ],
  };

  it("extracts server-relayed messages in record order with resolved sender names", () => {
    const messages = recordedAgentMessages(record);
    expect(messages).toEqual([
      {
        messageEventID: MESSAGE_EVENT_ID,
        turn: 900,
        sequence: 0,
        senderName: "Auri",
        recipientPlayerID: "p2",
        text: "Pact?",
      },
      {
        turn: 950,
        sequence: 1,
        senderName: "Calc",
        recipientPlayerID: "p1",
        text: "Maybe.",
      },
    ]);
  });

  it("returns nothing for a malformed or message-less record", () => {
    expect(recordedAgentMessages(null)).toEqual([]);
    expect(recordedAgentMessages("not a record")).toEqual([]);
    expect(recordedAgentMessages({ turns: "nope" })).toEqual([]);
    expect(recordedAgentMessages({ info: record.info, turns: [] })).toEqual([]);
  });
});

describe("message war-room beats", () => {
  it("curates a server-relayed message into a MESSAGE beat with the chat wording", () => {
    const beats = messageEvents(ROSTER, [message()]);
    expect(beats).toHaveLength(1);
    expect(beats[0].kind).toBe("message");
    expect(beats[0].turn).toBe(900);
    expect(beats[0].headline).toBe("Auri → Calc: We share a border. Pact?");
    expect(beats[0].participants).toEqual(["Auri", "Calc"]);
    // The message IS the agent's words; there is no second-line claim.
    expect(beats[0].publicReason).toBeNull();
    expect(beats[0].tier).toBe(2);
  });

  it("uses the server-owned event id while preserving the exact legacy fallback", () => {
    const identified = messageEvents(ROSTER, [
      message({ messageEventID: MESSAGE_EVENT_ID }),
    ]);
    expect(identified[0]?.id).toBe(MESSAGE_EVENT_ID);

    const legacy = messageEvents(ROSTER, [message({ turn: 901, sequence: 7 })]);
    expect(legacy[0]?.id).toBe("message:901:7");
  });

  it("drops a message whose recipient the telemetry roster cannot name", () => {
    expect(
      messageEvents(ROSTER, [message({ recipientPlayerID: "unknown" })]),
    ).toHaveLength(0);
    // No telemetry at all -> no roster -> no message beats (the mount's
    // existing best-effort contract), never a guessed name.
    expect(messageEvents(null, [message()])).toHaveLength(0);
  });

  it("announces a pair's opener and collapses the rapid back-and-forth", () => {
    const beats = curatedWarRoomEvents(ROSTER, [], null, [
      message({ turn: 900, sequence: 0 }),
      // Same ordered pair inside the re-announce window: transcript, not news.
      message({ turn: 950, sequence: 1, text: "Still there?" }),
      message({ turn: 1000, sequence: 2, text: "Answer me." }),
      // The REPLY is its own ordered pair, so it announces too — the approved
      // reference frame (opener + reply + counter-offer all toast).
      message({
        turn: 1050,
        sequence: 3,
        senderName: "Calc",
        recipientPlayerID: "p1",
        text: "Convince me.",
      }),
    ]);
    const messages = beats.filter((event) => event.kind === "message");
    // Opener and reply announce; the two rapid same-pair follow-ups between
    // them collapsed into one grouped transcript row.
    const tiers = messages.map((event) => event.tier);
    expect(tiers.filter((tier) => tier === 2)).toHaveLength(2);
    const grouped = messages.find((event) =>
      event.headline.includes("more message"),
    );
    expect(grouped).toBeDefined();
    expect(grouped?.headline).toBe("+2 more messages");
    expect(grouped?.tier).toBe(3);
  });

  it("re-announces the same pair after the cadence window passes", () => {
    const beats = messageEvents(ROSTER, [
      message({ turn: 900, sequence: 0 }),
      message({ turn: 1900, sequence: 1, text: "The pact held. Renew?" }),
    ]);
    expect(beats.map((event) => event.tier)).toEqual([2, 2]);
  });

  it("keeps message beats out of the timeline-marker spoiler surface", () => {
    // matchTimelineEventMarkers deliberately takes NO message input: markers
    // are sparse, positional and spoiler-surfaced, and a talkative match
    // would bury the scrubber's few real symbols. Pinned so a future marker
    // emitter for messages has to consciously delete this test.
    const markers = matchTimelineEventMarkers(ROSTER, null);
    expect(markers.map((marker) => marker.kind as string)).not.toContain(
      "message",
    );
    const beats = curatedWarRoomEvents(ROSTER, [], null, [message()]);
    expect(beats.some((event) => event.kind === "message")).toBe(true);
  });

  it("suppresses MESSAGE beats when the display kill switch stamps the page global", () => {
    (globalThis as Record<string, unknown>)[MESSAGE_BEATS_DISPLAY_GLOBAL] =
      false;
    const beats = curatedWarRoomEvents(ROSTER, [], null, [message()]);
    expect(beats.some((event) => event.kind === "message")).toBe(false);
  });
});

describe("superseded deal replay join", () => {
  it("preserves the server narration in the War Room and timeline", () => {
    const publicText =
      "Calc's acceptance of Auri's non-aggression pact was redundant; their equivalent deal was already accepted.";
    const telemetry: AiLeagueSpectatorTelemetry = {
      ...ROSTER,
      events: [
        {
          id: "superseded-1",
          sequence: 4,
          turnNumber: 250,
          kind: "deal_superseded",
          tone: "info",
          actorAgentID: "a2",
          actorName: "Calc",
          targetAgentID: "a1",
          targetName: "Auri",
          message: publicText,
          publicText,
          supersededByDealID: "deal:p2:p1:non_aggression_pact:0",
          evidenceLevel: "state_derived",
          importance: 42,
        },
      ],
    };

    expect(curatedWarRoomEvents(telemetry, [], null)).toEqual([
      expect.objectContaining({
        id: "superseded-1",
        kind: "deal_superseded",
        headline: publicText,
        tier: 3,
      }),
    ]);
    expect(matchTimelineEventMarkers(telemetry, null)).toEqual([
      {
        kind: "deal_superseded",
        turn: 250,
        sequence: 4,
        label: publicText,
      },
    ]);
  });
});

describe("plan-change public rationale", () => {
  it("never quotes policy/debug codes as an agent-stated reason", () => {
    const beats = curatedWarRoomEvents(
      null,
      [
        {
          sequence: 1,
          turnNumber: 10,
          username: "Auri",
          reason: "dgd:err:atk",
          planObjective: "expand",
        },
        {
          sequence: 2,
          turnNumber: 20,
          username: "Auri",
          reason: "heuristic-expand",
          planObjective: "survive",
          planRationale: "e1:hold",
        },
      ],
      null,
    );
    const planChange = beats.find((event) => event.kind === "plan_change");
    expect(planChange?.publicReason).toBeNull();
    expect(planChange?.expandedDetail).toBeNull();
  });
});

describe("toast severity for MESSAGE cards", () => {
  it("takes the gold sharp accent, never hazard", () => {
    expect(severityOf("message")).toBe("sharp");
    // The incumbent rule is unchanged around it.
    expect(severityOf("nuke")).toBe("grave");
    expect(severityOf("elimination")).toBe("grave");
    expect(severityOf("lead_change")).toBe("sharp");
    expect(severityOf("alliance")).toBe("quiet");
  });
});
