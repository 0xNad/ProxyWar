import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmDecisionParser } from "../../src/server/agents/LlmDecisionParser";
import {
  interleaveLayers,
  MAX_WIRE_ACTIONS_PER_DECISION,
} from "../../src/server/agents/AgentWireProtocol";
import { LegalAction } from "../../src/server/agents/AgentTypes";

describe("interleaveLayers", () => {
  it("emits one element per list per layer in fixed list order", () => {
    expect(
      interleaveLayers([
        ["A1", "A2", "A3"],
        ["B1"],
        ["C1", "C2"],
      ]),
    ).toEqual(["A1", "B1", "C1", "A2", "C2", "A3"]);
  });

  it("handles empty input and empty lists", () => {
    expect(interleaveLayers([])).toEqual([]);
    expect(interleaveLayers([[], ["B1"]])).toEqual(["B1"]);
  });

  it("degenerates to the flat list for all-scalar layers", () => {
    expect(interleaveLayers([["A1"], ["B1"], ["C1"]])).toEqual([
      "A1",
      "B1",
      "C1",
    ]);
  });
});

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
