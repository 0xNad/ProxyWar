import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BroadcastScrubber,
  REPLAY_SEEK_DEAD_ZONE_TURNS,
} from "../../src/client/graphics/layers/BroadcastScrubber";
import type { GameView } from "../../src/core/game/GameView";

/**
 * SEEK-01, found on the live product 2026-08-19: clicking a beat marker the
 * playhead had already passed did nothing except flash "ALREADY ARRIVING —
 * KEEP WATCHING". That message is false for a past beat — waiting will never
 * show it again — and at the end of a match EVERY marker is in that state, so
 * the whole beat feed went dead exactly when a viewer wants to look back.
 *
 * The scrubber emits seeks as `ai-league-replay-jump-turn` document events, so
 * the test drives the real method and listens for the real event rather than
 * asserting on internals.
 */
const MARK_SEEK_LEAD_TURNS = 300;

function scrubberAt(currentTurn: number, totalTurns = 20_000) {
  const scrubber = new BroadcastScrubber({} as GameView) as unknown as {
    totalTurns: number;
    currentTurn: number;
    seekToMark(turn: number): void;
    flashStatus(text: string): void;
  };
  scrubber.totalTurns = totalTurns;
  scrubber.currentTurn = currentTurn;
  // flashStatus touches DOM the constructor has not built in a unit context.
  const flashes: string[] = [];
  scrubber.flashStatus = (text: string) => {
    flashes.push(text);
  };
  return { scrubber, flashes };
}

describe("BroadcastScrubber.seekToMark", () => {
  let seeks: number[];
  const listener = (event: Event) => {
    seeks.push((event as CustomEvent).detail.turnNumber);
  };

  beforeEach(() => {
    seeks = [];
    document.addEventListener("ai-league-replay-jump-turn", listener);
  });
  afterEach(() => {
    document.removeEventListener("ai-league-replay-jump-turn", listener);
    vi.restoreAllMocks();
  });

  it("REWINDS to a marker the playhead has already passed", () => {
    const { scrubber, flashes } = scrubberAt(10_000);
    scrubber.seekToMark(5_000);
    expect(seeks).toEqual([5_000 - MARK_SEEK_LEAD_TURNS]);
    expect(flashes).toEqual([]);
  });

  it("still leads a marker that is ahead and reachable", () => {
    const { scrubber, flashes } = scrubberAt(1_000);
    scrubber.seekToMark(9_000);
    expect(seeks).toEqual([9_000 - MARK_SEEK_LEAD_TURNS]);
    expect(flashes).toEqual([]);
  });

  it("clamps a rewind target at turn zero rather than seeking negative", () => {
    const { scrubber } = scrubberAt(10_000);
    scrubber.seekToMark(100);
    expect(seeks).toEqual([0]);
  });

  it("keeps 'already arriving' only when the mark is genuinely unreachable", () => {
    // Just AHEAD, inside the dead zone: playback gets there in seconds and no
    // seek can land closer, so the message is true here.
    const { scrubber, flashes } = scrubberAt(1_000);
    scrubber.seekToMark(1_000 + REPLAY_SEEK_DEAD_ZONE_TURNS - 1);
    expect(seeks).toEqual([]);
    expect(flashes).toHaveLength(1);
    expect(flashes[0]).toMatch(/ALREADY ARRIVING/i);
  });

  it("rewinds to the lead-in for a beat that only just passed", () => {
    // A beat one turn behind is still over, and the 300-turn lead exists so a
    // viewer watches it happen rather than landing on top of it.
    const { scrubber, flashes } = scrubberAt(1_000);
    scrubber.seekToMark(999);
    expect(seeks).toEqual([999 - MARK_SEEK_LEAD_TURNS]);
    expect(flashes).toEqual([]);
  });

  it("does not rewind for a mark just AHEAD inside the dead zone", () => {
    // Falling through the forward branch does not mean "behind" — without an
    // explicit test this threw the viewer ~300 turns back for a beat they
    // were seconds from reaching.
    const { scrubber, flashes } = scrubberAt(5_000);
    scrubber.seekToMark(5_000 + REPLAY_SEEK_DEAD_ZONE_TURNS - 1);
    expect(seeks).toEqual([]);
    expect(flashes).toHaveLength(1);
  });

  it("ignores non-finite marks and empty replays", () => {
    const { scrubber, flashes } = scrubberAt(1_000);
    scrubber.seekToMark(Number.NaN);
    const empty = scrubberAt(0, 0);
    empty.scrubber.seekToMark(500);
    expect(seeks).toEqual([]);
    expect(flashes).toEqual([]);
    expect(empty.flashes).toEqual([]);
  });
});
