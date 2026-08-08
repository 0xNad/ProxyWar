/**
 * P0 fix (found live 2026-08-02): after Back from a replay, Forward failed
 * with "History entry not found" — `Main.ts`'s `handleJoinLobby`'s "ensure
 * a homepage entry" `replaceState` fired on ANY page with an empty hash,
 * including a replay/premiere/game page re-joined via Back/Forward
 * (none of those carry a hash either), silently rewriting an
 * already-legitimate history entry to `#refresh` and orphaning whatever
 * the browser's session history expected to sit there.
 *
 * `isReplayOrGamePathShape` is the extracted, pure guard predicate: the
 * `replaceState` in `Main.ts`'s `handleJoinLobby` only fires when this
 * returns false. Lives in its own side-effect-free module (see its own
 * doc) so it's testable without pulling in `Main.ts`'s module-load
 * bootstrap (`new Client().initialize()`, which requires a real browser).
 */
import {
  isReplayOrGamePathShape,
  shouldPushAiLeagueReplayHistoryEntry,
} from "../../src/client/HistoryGuard";

describe("isReplayOrGamePathShape", () => {
  it("recognizes every one of handleJoinLobby's own target history-entry shapes", () => {
    expect(isReplayOrGamePathShape("/ai-league-replay/league-coworld-x")).toBe(
      true,
    );
    expect(isReplayOrGamePathShape("/premiere/prem_abc123")).toBe(true);
    expect(isReplayOrGamePathShape("/streamer-mode")).toBe(true);
    expect(isReplayOrGamePathShape("/w1/game/lobby-abc123")).toBe(true);
  });

  it("does not flag a plain content page as a replay/game shape", () => {
    expect(isReplayOrGamePathShape("/")).toBe(false);
    expect(isReplayOrGamePathShape("/league")).toBe(false);
    expect(isReplayOrGamePathShape("/watch")).toBe(false);
    expect(isReplayOrGamePathShape("/agents")).toBe(false);
    expect(isReplayOrGamePathShape("/agent/some-agent")).toBe(false);
    expect(isReplayOrGamePathShape("/build")).toBe(false);
  });

  it("does not false-positive on a path that merely starts similarly", () => {
    // Must anchor at the start and require a trailing `/` after the
    // matched alternative — a bare "/premiere" must not match.
    expect(isReplayOrGamePathShape("/premiere")).toBe(false);
    expect(isReplayOrGamePathShape("/premieres/x")).toBe(false);
  });
});

/**
 * P0 REOPEN fix (pass-3 repro, 2026-08-02): the ai-league-replay join
 * branch's `history.pushState` used to fire unconditionally, unlike the
 * premiere branch immediately above it (already guarded on path
 * equality). Real-browser verification (genuine click navigation + a
 * delayed `pushState` to the SAME url, then native `history.back()`/
 * `forward()`) confirmed the un-guarded call desyncs the browser's
 * actual session-history stack from the page's own belief: Back lands
 * back on the SAME url (a phantom duplicate entry) instead of the true
 * previous page. `shouldPushAiLeagueReplayHistoryEntry` is the extracted
 * guard now gating that call.
 */
describe("shouldPushAiLeagueReplayHistoryEntry", () => {
  it("returns false when already on the exact target replay path — a fresh/hard navigation straight to the replay URL, the exact repro shape", () => {
    const target = "/ai-league-replay/league-coworld-x";
    expect(shouldPushAiLeagueReplayHistoryEntry(target, target)).toBe(false);
  });

  it("returns true when arriving from a different path — a genuine in-app join (e.g. a modal-driven join with no prior URL change) still gets its first real pushState", () => {
    expect(
      shouldPushAiLeagueReplayHistoryEntry(
        "/watch",
        "/ai-league-replay/league-coworld-x",
      ),
    ).toBe(true);
    expect(
      shouldPushAiLeagueReplayHistoryEntry(
        "/",
        "/ai-league-replay/league-coworld-x",
      ),
    ).toBe(true);
  });
});
