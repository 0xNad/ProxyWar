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
 * under test: beats derive from the RECORD's own delivered `agent_message`
 * intents — the turn stream — never from the runner's `commsSlotAccepted`
 * claim, so a message that was never relayed can never be announced.
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

  it("extracts delivered messages in record order with resolved sender names", () => {
    const messages = recordedAgentMessages(record);
    expect(messages).toEqual([
      {
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
  it("curates a delivered message into a MESSAGE beat with the chat wording", () => {
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
