import { describe, expect, it } from "vitest";
import {
  dedupeAndCapActionIDs,
  interleaveLayers,
  MAX_WIRE_ACTIONS_PER_DECISION,
  normalizeWireActionIds,
} from "../../src/server/agents/AgentWireProtocol";

describe("interleaveLayers", () => {
  it("emits one element per list per layer in fixed list order", () => {
    expect(
      interleaveLayers([["A1", "A2", "A3"], ["B1"], ["C1", "C2"]]),
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

describe("dedupeAndCapActionIDs", () => {
  // This is the helper SimRollout stages intents with; it must reproduce the
  // league runner's requestedDecisionActionIDs semantics or forecasts drift
  // from live play.
  it("deduplicates BEFORE capping so a repeat never burns capacity", () => {
    expect(
      dedupeAndCapActionIDs(["a", "a", "b", "c", "d", "e", "f"]),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("caps at the wire limit", () => {
    const capped = dedupeAndCapActionIDs([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(capped).toHaveLength(MAX_WIRE_ACTIONS_PER_DECISION);
    expect(capped).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("drops empty ids and preserves order", () => {
    expect(dedupeAndCapActionIDs(["", "b", "", "a", "b"])).toEqual(["b", "a"]);
  });

  it("passes short lists through unchanged", () => {
    expect(dedupeAndCapActionIDs(["only"])).toEqual(["only"]);
    expect(dedupeAndCapActionIDs([])).toEqual([]);
  });
});

describe("normalizeWireActionIds", () => {
  it("puts the scalar primary first and dedupes", () => {
    expect(normalizeWireActionIds("a", ["b", "a", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("trims and drops empties", () => {
    expect(normalizeWireActionIds(" a ", ["  ", " b "])).toEqual(["a", "b"]);
  });

  it("stops collecting past the cap without changing observable output", () => {
    // Default stopAt is cap+1: enough for strict parsing to detect "over the
    // cap", bounded so a huge hostile array cannot drive a quadratic scan.
    const huge = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
    const normalized = normalizeWireActionIds("primary", huge);
    expect(normalized).toHaveLength(MAX_WIRE_ACTIONS_PER_DECISION + 1);
    // The surviving prefix is exactly what an uncapped walk would have given.
    expect(normalized.slice(0, MAX_WIRE_ACTIONS_PER_DECISION)).toEqual([
      "primary",
      "id-0",
      "id-1",
      "id-2",
      "id-3",
    ]);
  });

  it("honors an explicit stopAt", () => {
    expect(normalizeWireActionIds("a", ["b", "c", "d"], 2)).toEqual(["a", "b"]);
  });
});
