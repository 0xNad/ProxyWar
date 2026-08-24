import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FREETEXT_INBOX_MAX_PER_RIVAL } from "../../src/server/agents/AgentTunables";

/**
 * Echo-loop regression for every shipped starter's comms routine.
 *
 * Hosted episode `ereq_3fc90743` on canonical `proxywar:0.1.49` (four seats of
 * `proxywar-freetext-tester:v1`) proved agents can hear each other — and in the
 * same breath proved they cannot stop talking: **5 openers, 861 replies over
 * 1,204 decisions**, 285/285 and 145/146 per mirrored pair, a message on ~72%
 * of all decisions.
 *
 * Cause: the anti-loop memory was keyed `${senderID}:${turnNumber}`, which only
 * prevents answering the SAME message twice. Every reply becomes a new inbound
 * message with a new turn number on the other side, so both agents forever see
 * a key neither has answered. The comments claiming "a spammer cannot pull us
 * into a loop" and "silence is the default" described an intent the code did
 * not implement.
 *
 * These tests simulate the real ping-pong — feed each reply back as the next
 * inbound message, exactly as the server does — and assert the exchange
 * TERMINATES. A per-message assertion cannot catch this class; only iterating
 * the loop can.
 */

const STARTER_FILES = [
  // First: the copy the hosted image actually runs (coworld_manifest.json
  // points at /app/integration/src/starter-player.mjs).
  path.join("coworld-adapter", "src", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter-llm", "starter-player.mjs"),
  path.join("coworld-adapter", "tester-starter-llm", "llm-player.mjs"),
];

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} missing`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

function optionalFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}

function extractConst(source: string, name: string): string {
  const match = source.match(
    new RegExp(`const ${name} =[\\s\\S]*?;(?=\\n)`),
  )?.[0];
  expect(match, `const ${name} missing`).toBeDefined();
  return match!;
}

interface MessageMove {
  id: string;
  text: string;
}

interface CommsApi {
  chooseMessageMove: (
    actions: unknown[],
    obs: unknown,
    answered: Set<string>,
    dealMove: unknown,
  ) => MessageMove | null;
  MESSAGE_MAX_REPLIES_PER_RIVAL: number;
}

async function commsFor(relativePath: string): Promise<CommsApi> {
  const source = await fs.readFile(
    path.join(process.cwd(), relativePath),
    "utf8",
  );
  // Both the deterministic copies and the LLM copy are supported: the trust
  // helper and its constant differ by name between them.
  return new Function(
    [
      extractConst(source, "MESSAGE_MAX_CHARS"),
      extractConst(source, "MESSAGE_REPLIES"),
      extractConst(source, "MESSAGE_OPENERS"),
      extractConst(source, "MESSAGE_MAX_REPLIES_PER_RIVAL"),
      source.includes("const MESSAGE_TRUST_MIN_RELIABILITY")
        ? extractConst(source, "MESSAGE_TRUST_MIN_RELIABILITY")
        : extractConst(source, "DEAL_TRUST_MIN_RELIABILITY"),
      optionalFunction(source, "provenDealBreaker"),
      optionalFunction(source, "failedReliabilityGate"),
      extractFunction(source, "chooseMessageMove"),
      extractFunction(source, "chooseMessageOpener"),
      "return { chooseMessageMove, MESSAGE_MAX_REPLIES_PER_RIVAL };",
    ].join("\n"),
  )() as CommsApi;
}

const MESSAGE_ACTIONS = [
  {
    id: "message:P_RIVAL",
    kind: "message",
    metadata: { recipientID: "P_RIVAL", recipientName: "Rival" },
  },
];

function observationWithInbox(
  turnNumber: number,
  inbound: {
    messageEventID?: string;
    senderID: string;
    senderName: string;
    text: string;
    turnNumber: number;
  }[],
) {
  return {
    phase: "active",
    turnNumber,
    ownState: { playerID: "P_ME", name: "Me" },
    visiblePlayers: [
      {
        playerID: "P_RIVAL",
        name: "Rival",
        isAlive: true,
        hasSpawned: true,
        sharesBorder: true,
        isAllied: false,
      },
    ],
    nonCombat: { inboundMessages: inbound },
  };
}

describe.each(STARTER_FILES)("echo loop: %s", (starterFile) => {
  it("terminates a mutual exchange instead of replying forever", async () => {
    const { chooseMessageMove, MESSAGE_MAX_REPLIES_PER_RIVAL } =
      await commsFor(starterFile);
    const answered = new Set<string>();

    // The rival opens, then answers every reply — the exact hosted pattern.
    let sent = 0;
    let inboundTurn = 100;
    for (let decision = 0; decision < 200; decision++) {
      const move = chooseMessageMove(
        MESSAGE_ACTIONS,
        observationWithInbox(inboundTurn + 1, [
          {
            senderID: "P_RIVAL",
            senderName: "Rival",
            text: "answer me",
            turnNumber: inboundTurn,
          },
        ]),
        answered,
        null,
      );
      if (move === null) {
        inboundTurn += 2;
        continue;
      }
      sent += 1;
      // Our reply lands in the rival's inbox; its answer comes back on a NEW
      // turn, which is precisely what defeated the per-message key.
      inboundTurn += 2;
    }

    expect(MESSAGE_MAX_REPLIES_PER_RIVAL).toBeGreaterThan(0);
    expect(MESSAGE_MAX_REPLIES_PER_RIVAL).toBeLessThanOrEqual(
      FREETEXT_INBOX_MAX_PER_RIVAL,
    );
    // Bounded, and bounded by the declared budget — not by luck or by the
    // rival going quiet.
    expect(sent).toBe(MESSAGE_MAX_REPLIES_PER_RIVAL);
  });

  it("keeps answering a rival that stays within the budget", async () => {
    const { chooseMessageMove } = await commsFor(starterFile);
    const answered = new Set<string>();

    // First inbound message must always earn a reply: the budget must not be
    // so tight that talking becomes impossible.
    const first = chooseMessageMove(
      MESSAGE_ACTIONS,
      observationWithInbox(101, [
        {
          senderID: "P_RIVAL",
          senderName: "Rival",
          text: "pact?",
          turnNumber: 100,
        },
      ]),
      answered,
      null,
    );
    expect(first).not.toBeNull();
    expect(first!.id).toBe("message:P_RIVAL");

    // Re-offering the SAME inbound message earns nothing (unchanged contract).
    const repeat = chooseMessageMove(
      MESSAGE_ACTIONS,
      observationWithInbox(101, [
        {
          senderID: "P_RIVAL",
          senderName: "Rival",
          text: "pact?",
          turnNumber: 100,
        },
      ]),
      answered,
      null,
    );
    expect(repeat).toBeNull();
  });

  it("distinguishes same-turn messages by server-owned event id and keeps the legacy fallback", async () => {
    const { chooseMessageMove } = await commsFor(starterFile);
    const answered = new Set<string>();
    const message = (messageEventID: string) =>
      observationWithInbox(101, [
        {
          messageEventID,
          senderID: "P_RIVAL",
          senderName: "Rival",
          text: "pact?",
          turnNumber: 100,
        },
      ]);

    expect(
      chooseMessageMove(
        MESSAGE_ACTIONS,
        message("msg_00000000-0000-4000-8000-000000000001"),
        answered,
        null,
      ),
    ).not.toBeNull();
    expect(
      chooseMessageMove(
        MESSAGE_ACTIONS,
        message("msg_00000000-0000-4000-8000-000000000002"),
        answered,
        null,
      ),
    ).not.toBeNull();
    expect(
      chooseMessageMove(
        MESSAGE_ACTIONS,
        message("msg_00000000-0000-4000-8000-000000000002"),
        answered,
        null,
      ),
    ).toBeNull();
  });

  it("spends the budget per counterparty, not globally", async () => {
    const { chooseMessageMove, MESSAGE_MAX_REPLIES_PER_RIVAL } =
      await commsFor(starterFile);
    const answered = new Set<string>();
    const twoRivalActions = [
      ...MESSAGE_ACTIONS,
      {
        id: "message:P_OTHER",
        kind: "message",
        metadata: { recipientID: "P_OTHER", recipientName: "Other" },
      },
    ];

    const observationFrom = (senderID: string, turnNumber: number) => ({
      phase: "active",
      turnNumber: turnNumber + 1,
      ownState: { playerID: "P_ME", name: "Me" },
      visiblePlayers: [
        {
          playerID: senderID,
          name: senderID,
          isAlive: true,
          hasSpawned: true,
          sharesBorder: true,
          isAllied: false,
        },
      ],
      nonCombat: {
        inboundMessages: [
          { senderID, senderName: senderID, text: "hello", turnNumber },
        ],
      },
    });

    // Exhaust the first rival.
    let turn = 200;
    for (let i = 0; i < MESSAGE_MAX_REPLIES_PER_RIVAL + 3; i++) {
      chooseMessageMove(
        twoRivalActions,
        observationFrom("P_RIVAL", turn),
        answered,
        null,
      );
      turn += 2;
    }
    const exhausted = chooseMessageMove(
      twoRivalActions,
      observationFrom("P_RIVAL", turn),
      answered,
      null,
    );
    expect(exhausted).toBeNull();

    // A DIFFERENT counterparty still gets an answer: the budget is per rival,
    // so one spammer cannot mute us to everyone else.
    const other = chooseMessageMove(
      twoRivalActions,
      observationFrom("P_OTHER", turn + 2),
      answered,
      null,
    );
    expect(other).not.toBeNull();
    expect(other!.id).toBe("message:P_OTHER");
  });
});
