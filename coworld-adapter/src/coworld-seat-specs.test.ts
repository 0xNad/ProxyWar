import { describe, expect, it } from "vitest";

import {
  commanderXpArmInvariantSeatPlayers,
  competitiveSeatSpecs,
} from "./coworld-seat-specs";

describe("Commander XP arm-invariant Coworld seat identity", () => {
  it("keeps matched B/C game identities byte-equal despite distinct hosted policy names", () => {
    const armB = [
      { name: "commander-xp-B:v17" },
      { name: "opponent-1:v4" },
      { name: "opponent-2:v9" },
      { name: "opponent-3:v2" },
    ];
    const armC = structuredClone(armB);
    armC[0] = { name: "commander-xp-C:v18" };

    expect(armB[0]?.name).not.toBe(armC[0]?.name);
    const bSpecs = competitiveSeatSpecs(
      commanderXpArmInvariantSeatPlayers(armB),
      27,
    );
    const cSpecs = competitiveSeatSpecs(
      commanderXpArmInvariantSeatPlayers(armC),
      27,
    );

    expect(cSpecs).toEqual(bSpecs);
    expect(bSpecs.map(({ username }) => username)).toEqual([
      "Commander XP Seat 1",
      "Commander XP Seat 2",
      "Commander XP Seat 3",
      "Commander XP Seat 4",
    ]);
    expect(new Set(bSpecs.map(({ persistentID }) => persistentID)).size).toBe(
      4,
    );
  });
});
