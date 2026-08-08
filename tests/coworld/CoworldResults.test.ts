import { describe, expect, it } from "vitest";

import {
  coworldResults,
  resolveWinnerSlot,
  type CoworldDecisionRecord,
  type CoworldResultsFinalState,
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

describe("coworldResults (Coworld results.json contract)", () => {
  // Minimal finalState fixture: two players, second one alive with more tiles.
  const finalState = (
    winnerSlot: number | null,
    tilesOwned: [number | null, number | null] = [4, 6],
  ): CoworldResultsFinalState => ({
    winnerSlot,
    turnCount: 42,
    tick: 4200,
    players: [
      { username: "seat-0", tilesOwned: tilesOwned[0], isAlive: true },
      { username: "seat-1", tilesOwned: tilesOwned[1], isAlive: true },
    ],
  });

  const record = (
    accepted: boolean,
    fallbackUsed = false,
    llmPlannerDegraded = false,
  ): CoworldDecisionRecord => ({
    result: { accepted },
    decisionMetadata: { fallbackUsed, llmPlannerDegraded },
  });

  it("stamps the authoritative game_id from the caller's game.id, never recomputing it", () => {
    const result = coworldResults({
      gameId: "COWRLD01",
      seed: null,
      players: [{ name: "Alice" }, { name: "Bob" }],
      finalState: finalState(1),
      records: [],
    });
    expect(result.game_id).toBe("COWRLD01");
    // results_schema.properties.game_id.pattern: ^[A-Za-z0-9]{8}$
    expect(result.game_id).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it("emits seed: null for a deliberately seedless episode", () => {
    const result = coworldResults({
      gameId: "COWRLD01",
      seed: null,
      players: [{ name: "Alice" }, { name: "Bob" }],
      finalState: finalState(null),
      records: [],
    });
    // results_schema.properties.seed.type allows ["integer", "null"].
    expect(result.seed).toBeNull();
  });

  it("stamps the exact seed encoded into the authoritative game identity", () => {
    const result = coworldResults({
      gameId: "PWSAYDPA",
      seed: 424242,
      players: [{ name: "Alice" }, { name: "Bob" }],
      finalState: finalState(null),
      records: [],
    });
    expect(result).toMatchObject({ game_id: "PWSAYDPA", seed: 424242 });
  });

  it("still scores a decisive winner 1/0 by slot (unchanged by the metadata addition)", () => {
    const result = coworldResults({
      gameId: "COWRLD01",
      seed: null,
      players: [{ name: "Alice" }, { name: "Bob" }],
      finalState: finalState(1),
      records: [],
    });
    expect(result.winner_slot).toBe(1);
    expect(result.scores).toEqual([0, 1]);
  });

  it("still falls back to tile-share scoring when there is no winner", () => {
    const result = coworldResults({
      gameId: "COWRLD01",
      seed: null,
      players: [{ name: "Alice" }, { name: "Bob" }],
      finalState: finalState(null, [4, 6]),
      records: [],
    });
    expect(result.winner_slot).toBeNull();
    expect(result.scores).toEqual([0.4, 0.6]);
  });

  it("still counts decisions, acceptance, fallback (fallbackUsed OR llmPlannerDegraded), and degraded", () => {
    const result = coworldResults({
      gameId: "COWRLD01",
      seed: null,
      players: [{ name: "Alice" }, { name: "Bob" }],
      finalState: finalState(1),
      records: [
        record(true, false, false),
        record(false, true, false),
        record(true, false, true),
        record(true, true, true),
      ],
    });
    expect(result.decision_count).toBe(4);
    expect(result.accepted_decision_count).toBe(3);
    expect(result.fallback_count).toBe(3);
    expect(result.degraded_count).toBe(2);
  });

  it("still carries per-slot name/score/tiles_owned/is_alive, falling back to finalState username", () => {
    const result = coworldResults({
      gameId: "COWRLD01",
      seed: null,
      players: [{ name: "Alice" }],
      finalState: finalState(0),
      records: [],
    });
    expect(result.players).toEqual([
      { slot: 0, name: "Alice", score: 1, tiles_owned: 4, is_alive: true },
      { slot: 1, name: "seat-1", score: 0, tiles_owned: 6, is_alive: true },
    ]);
  });
});
