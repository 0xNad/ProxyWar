import { describe, expect, it } from "vitest";

import {
  resolveWinnerSlot,
  type ResolvedPlayerIdentity,
} from "../../coworld-adapter/src/coworld-results";

const p = (
  id: unknown,
  team: string | null,
  tilesOwned: number,
): ResolvedPlayerIdentity => ({ id, team, tilesOwned });

describe("resolveWinnerSlot (Coworld result contract, ADAPTER-02)", () => {
  it("returns null when there is no winner (scoring falls back to tile-share)", () => {
    expect(
      resolveWinnerSlot([p(10, null, 5), p(11, null, 3)], { type: "none" }),
    ).toBeNull();
  });

  it("credits a Player winner by id, regardless of slot order", () => {
    expect(
      resolveWinnerSlot([p(10, null, 5), p(11, null, 3), p(12, null, 9)], {
        type: "player",
        id: 12,
      }),
    ).toBe(2);
  });

  it("matches by exact IDENTITY, never a name substring (no collision)", () => {
    // The old phase.includes(username) bug credited "War" against "Warlord".
    const slots = [p("Warlord", null, 5), p("War", null, 3)];
    expect(resolveWinnerSlot(slots, { type: "player", id: "War" })).toBe(1);
    expect(resolveWinnerSlot(slots, { type: "player", id: "Warlord" })).toBe(0);
  });

  it("returns null when no slot's id matches the winner", () => {
    expect(
      resolveWinnerSlot([p(10, null, 5), p(11, null, 3)], {
        type: "player",
        id: 99,
      }),
    ).toBeNull();
  });

  it("never credits a slot whose live player is missing (null id)", () => {
    // slot 0 has no live player; it must never be credited even if asked for.
    expect(
      resolveWinnerSlot([p(null, null, 99), p(11, null, 3)], {
        type: "player",
        id: 11,
      }),
    ).toBe(1);
  });

  it("credits a Team winner to the on-team slot holding the most tiles", () => {
    expect(
      resolveWinnerSlot(
        [p(10, "Red", 4), p(11, "Blue", 9), p(12, "Red", 7)],
        { type: "team", team: "Red" },
      ),
    ).toBe(2);
  });

  it("returns null for a team with no resolvable members (no false win)", () => {
    expect(
      resolveWinnerSlot([p(10, "Red", 4), p(11, "Blue", 9)], {
        type: "team",
        team: "Green",
      }),
    ).toBeNull();
  });

  // 4-player FFA cases — the actual upload target. A decisive 4-player win was
  // never exercised before (certify's short episodes never produce one).
  it("credits slot 3 (the last of 4 FFA seats) for a decisive win", () => {
    expect(
      resolveWinnerSlot(
        [p(10, null, 1), p(11, null, 2), p(12, null, 3), p(13, null, 9)],
        { type: "player", id: 13 },
      ),
    ).toBe(3);
  });

  it("credits each of the 4 FFA slots by identity, independent of order", () => {
    const four = [p(10, null, 5), p(11, null, 5), p(12, null, 5), p(13, null, 5)];
    expect(resolveWinnerSlot(four, { type: "player", id: 10 })).toBe(0);
    expect(resolveWinnerSlot(four, { type: "player", id: 12 })).toBe(2);
    expect(resolveWinnerSlot(four, { type: "player", id: 13 })).toBe(3);
  });

  it("never returns a slot outside 0..3 for a 4-player FFA (winner_slot schema max=3)", () => {
    const four = [p(10, null, 1), p(11, null, 1), p(12, null, 1), p(13, null, 1)];
    for (const w of [10, 11, 12, 13]) {
      const slot = resolveWinnerSlot(four, { type: "player", id: w });
      expect(slot).not.toBeNull();
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThanOrEqual(3);
    }
  });
});
