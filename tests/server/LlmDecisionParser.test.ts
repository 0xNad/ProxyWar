import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegalAction } from "../../src/server/agents/AgentTypes";
import {
  MAX_SPAWN_PREFERENCE_ACTION_IDS,
  MAX_WIRE_ACTIONS_PER_DECISION,
} from "../../src/server/agents/AgentWireProtocol";
import { LlmDecisionParser } from "../../src/server/agents/LlmDecisionParser";

function action(id: string, kind: LegalAction["kind"] = "attack"): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: "low", score: 0.1 },
  };
}

const MENU: LegalAction[] = [
  action("attack:one"),
  action("attack:two"),
  action("build:three", "build"),
  action("build:four", "build"),
  action("boat:five", "boat"),
  action("attack:six"),
  action("hold", "hold"),
];

const SPAWN_MENU: LegalAction[] = Array.from(
  { length: MAX_SPAWN_PREFERENCE_ACTION_IDS + 1 },
  (_, index) => action(`spawn:${index + 1}`, "spawn"),
);

function reply(fields: Record<string, unknown>): string {
  return JSON.stringify({ reason: "test reason", ...fields });
}

describe("LlmDecisionParser selectedLegalActionIds", () => {
  const originalDealsFlag = process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;

  beforeEach(() => {
    delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
  });

  afterEach(() => {
    if (originalDealsFlag === undefined) {
      delete process.env.PROXYWAR_TUNE_STRUCTURED_DEALS;
    } else {
      process.env.PROXYWAR_TUNE_STRUCTURED_DEALS = originalDealsFlag;
    }
  });

  describe("strict mode", () => {
    const parser = new LlmDecisionParser();

    it("keeps legacy scalar-only replies unchanged", () => {
      const result = parser.parse(
        reply({ selectedLegalActionId: "attack:one" }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionId).toBe("attack:one");
      expect(result.selectedLegalActionIds).toBeUndefined();
    });

    it("accepts a batch of offered ids, scalar authoritative first", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["build:three", "boat:five"],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toEqual([
        "attack:one",
        "build:three",
        "boat:five",
      ]);
    });

    it("deduplicates ids preserving order", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: [
            "attack:one",
            "build:three",
            "build:three",
            "attack:one",
          ],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toEqual([
        "attack:one",
        "build:three",
      ]);
    });

    it("omits the batch when it normalizes to one id", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["attack:one"],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toBeUndefined();
    });

    it("coaching-fails a batch above the wire cap", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: [
            "attack:two",
            "build:three",
            "build:four",
            "boat:five",
            "attack:six",
          ],
        }),
        MENU,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(
        `exceeds ${MAX_WIRE_ACTIONS_PER_DECISION} actions`,
      );
    });

    it("accepts a batch exactly at the wire cap", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: [
            "attack:two",
            "build:three",
            "build:four",
            "boat:five",
          ],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toHaveLength(
        MAX_WIRE_ACTIONS_PER_DECISION,
      );
    });

    it("fails on non-string entries", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["build:three", 7],
        }),
        MENU,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("array of strings");
    });

    it("fails on empty-string entries", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["build:three", "  "],
        }),
        MENU,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("cannot be empty");
    });

    it("fails on an off-menu batch entry", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["invented:admin:kick"],
        }),
        MENU,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(
        "unknown selectedLegalActionIds entry: invented:admin:kick",
      );
    });

    it("accepts the batch key with the structured-deals flag OFF, while the deal key stays gated", () => {
      const batch = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["build:three"],
        }),
        MENU,
      );
      expect(batch.ok).toBe(true);

      const deal = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedDealActionId: "deal:propose:x",
        }),
        MENU,
      );
      expect(deal.ok).toBe(false);
      if (deal.ok) return;
      expect(deal.reason).toContain("unknown JSON field: selectedDealActionId");
    });

    it("still rejects other unknown keys", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIdz: ["build:three"],
        }),
        MENU,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("unknown JSON field");
    });
  });

  describe("robust mode", () => {
    const parser = new LlmDecisionParser({ strict: false });

    it("keeps legacy scalar-only replies unchanged", () => {
      const result = parser.parse(
        reply({ selectedLegalActionId: "attack:one" }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toBeUndefined();
    });

    it("tolerates noise: drops non-strings, empties, and off-menu ids", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: [
            "build:three",
            42,
            " ",
            "invented:admin:kick",
            "boat:five",
          ],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toEqual([
        "attack:one",
        "build:three",
        "boat:five",
      ]);
    });

    it("truncates an oversized batch to the wire cap", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: [
            "attack:two",
            "build:three",
            "build:four",
            "boat:five",
            "attack:six",
            "hold",
          ],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toEqual([
        "attack:one",
        "attack:two",
        "build:three",
        "build:four",
        "boat:five",
      ]);
    });

    it("omits the batch when everything usable collapses to the scalar", () => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedLegalActionIds: ["attack:one", "invented:x", 3],
        }),
        MENU,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedLegalActionIds).toBeUndefined();
    });
  });
});

describe.each([
  ["strict", new LlmDecisionParser()],
  ["robust", new LlmDecisionParser({ strict: false })],
] as const)("LlmDecisionParser social side slots (%s)", (_mode, parser) => {
  const dealsFlag = "PROXYWAR_TUNE_STRUCTURED_DEALS";
  const messagesFlag = "PROXYWAR_TUNE_FREETEXT_MESSAGES";
  const originalDealsFlag = process.env[dealsFlag];
  const originalMessagesFlag = process.env[messagesFlag];

  beforeEach(() => {
    process.env[dealsFlag] = "1";
    process.env[messagesFlag] = "1";
  });

  afterEach(() => {
    if (originalDealsFlag === undefined) {
      delete process.env[dealsFlag];
    } else {
      process.env[dealsFlag] = originalDealsFlag;
    }
    if (originalMessagesFlag === undefined) {
      delete process.env[messagesFlag];
    } else {
      process.env[messagesFlag] = originalMessagesFlag;
    }
  });

  it.each(["", "   ", "\u0007"])(
    "preserves raw padded ids and the present message pair %#",
    (messageText) => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "attack:one",
          selectedDealActionId: " deal:exact ",
          selectedMessageActionId: " message:exact ",
          messageText,
        }),
        MENU,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.selectedDealActionId).toBe(" deal:exact ");
      expect(result.selectedMessageActionId).toBe(" message:exact ");
      expect(result.messageText).toBe(messageText);
    },
  );

  it("preserves exact valid ids and text byte-for-byte", () => {
    const result = parser.parse(
      reply({
        selectedLegalActionId: "attack:one",
        selectedDealActionId: "deal:exact",
        selectedMessageActionId: "message:exact",
        messageText: "  exact words stay padded  ",
      }),
      MENU,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selectedDealActionId).toBe("deal:exact");
    expect(result.selectedMessageActionId).toBe("message:exact");
    expect(result.messageText).toBe("  exact words stay padded  ");
  });

  it.each([
    [{ selectedMessageActionId: "message:exact" }],
    [{ messageText: "present without id" }],
  ])("rejects a partial comms pair: %j", (sideFields) => {
    const result = parser.parse(
      reply({ selectedLegalActionId: "attack:one", ...sideFields }),
      MENU,
    );
    expect(result).toMatchObject({
      ok: false,
      reason:
        "selectedMessageActionId and messageText must be provided together",
    });
  });

  it.each([
    [
      { selectedDealActionId: 7 },
      "selectedDealActionId must be a string when present",
    ],
    [
      { selectedMessageActionId: null, messageText: "hello" },
      "selectedMessageActionId must be a string when present",
    ],
    [
      { selectedMessageActionId: "message:exact", messageText: 7 },
      "messageText must be a string when present",
    ],
  ])("rejects a malformed present side slot: %j", (sideFields, reason) => {
    const result = parser.parse(
      reply({ selectedLegalActionId: "attack:one", ...sideFields }),
      MENU,
    );
    expect(result).toMatchObject({ ok: false, reason });
  });
});

describe.each([
  ["strict", new LlmDecisionParser()],
  ["robust", new LlmDecisionParser({ strict: false })],
] as const)("LlmDecisionParser spawn preferences (%s)", (_mode, parser) => {
  it("keeps a legacy scalar-only spawn reply unchanged", () => {
    const result = parser.parse(
      reply({ selectedLegalActionId: "spawn:1" }),
      SPAWN_MENU,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spawnPreferenceLegalActionIds).toBeUndefined();
  });

  it("accepts an exact offered ranking and preserves a one-item authored ballot", () => {
    const ranked = parser.parse(
      reply({
        selectedLegalActionId: "spawn:2",
        spawnPreferenceLegalActionIds: ["spawn:2", "spawn:1", "spawn:3"],
      }),
      SPAWN_MENU,
    );
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) return;
    expect(ranked.spawnPreferenceLegalActionIds).toEqual([
      "spawn:2",
      "spawn:1",
      "spawn:3",
    ]);

    const one = parser.parse(
      reply({
        selectedLegalActionId: "spawn:4",
        spawnPreferenceLegalActionIds: ["spawn:4"],
      }),
      SPAWN_MENU,
    );
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.spawnPreferenceLegalActionIds).toEqual(["spawn:4"]);
  });

  it.each([
    ["without a ballot", undefined],
    ["alongside a ballot", ["spawn:1", "spawn:2"]],
  ])(
    "rejects the executable batch field on an all-spawn menu %s",
    (_case, spawnPreferenceLegalActionIds) => {
      const result = parser.parse(
        reply({
          selectedLegalActionId: "spawn:1",
          selectedLegalActionIds: ["spawn:1", "spawn:2"],
          ...(spawnPreferenceLegalActionIds === undefined
            ? {}
            : { spawnPreferenceLegalActionIds }),
        }),
        SPAWN_MENU,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(
        "selectedLegalActionIds is not allowed on an all-spawn menu",
      );
    },
  );

  it("rejects the field outside an all-spawn menu", () => {
    const result = parser.parse(
      reply({
        selectedLegalActionId: "attack:one",
        spawnPreferenceLegalActionIds: ["attack:one"],
      }),
      MENU,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(
      "only when every offered legal action is a spawn",
    );
  });

  it.each([
    [
      "does not start with the scalar",
      ["spawn:2", "spawn:1"],
      "selectedLegalActionId must be the first",
    ],
    [
      "contains a duplicate",
      ["spawn:1", "spawn:2", "spawn:2"],
      "cannot contain duplicate",
    ],
    [
      "contains an off-menu id",
      ["spawn:1", "spawn:999"],
      "unknown spawnPreferenceLegalActionIds entry: spawn:999",
    ],
    [
      "contains a whitespace-normalized rather than exact id",
      ["spawn:1", " spawn:2 "],
      "unknown spawnPreferenceLegalActionIds entry:  spawn:2 ",
    ],
    ["contains a non-string", ["spawn:1", 2], "array of strings"],
  ])("rejects a ranking that %s", (_case, preferences, expected) => {
    const result = parser.parse(
      reply({
        selectedLegalActionId: "spawn:1",
        spawnPreferenceLegalActionIds: preferences,
      }),
      SPAWN_MENU,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(expected);
  });

  it("rejects overflow instead of truncating or deduplicating it", () => {
    const result = parser.parse(
      reply({
        selectedLegalActionId: "spawn:1",
        spawnPreferenceLegalActionIds: SPAWN_MENU.map((action) => action.id),
      }),
      SPAWN_MENU,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(
      `exceeds ${MAX_SPAWN_PREFERENCE_ACTION_IDS} preferences`,
    );
  });
});
