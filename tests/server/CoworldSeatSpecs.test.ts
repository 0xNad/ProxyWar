import { describe, expect, it } from "vitest";
import {
  competitiveSeatSpecs,
  proxyWarUsernames,
} from "../../coworld-adapter/src/coworld-seat-specs";

describe("Coworld competitive seat specs", () => {
  it("assigns every seat the same neutral competitive profile", () => {
    let nextID = 0;
    const specs = competitiveSeatSpecs(
      [
        { name: "Auri" },
        { name: "daveey" },
        { name: "RelhAlpha" },
        { name: "James Boggs" },
      ],
      27,
      () => `seat-${nextID++}`,
    );

    expect(specs.map((spec) => spec.profile)).toEqual([
      "opportunistic",
      "opportunistic",
      "opportunistic",
      "opportunistic",
    ]);
    expect(specs.map((spec) => spec.persistentID)).toEqual([
      "seat-0",
      "seat-1",
      "seat-2",
      "seat-3",
    ]);
  });

  it("preserves username sanitization and uniqueness", () => {
    expect(
      proxyWarUsernames(
        [{ name: "Auri!!!" }, { name: "Auri!!!" }, { name: "x" }],
        12,
      ),
    ).toEqual(["Auri", "Auri 2", "Coworld Play"]);
  });
});
