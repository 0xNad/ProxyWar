/**
 * P0 fix (found live 2026-08-02): after Back from a replay, Forward failed
 * with "History entry not found" — `Main.ts`'s `handleJoinLobby`'s "ensure
 * a homepage entry" `replaceState` fired on ANY page with an empty hash,
 * including a replay/premiere/bet/game page re-joined via Back/Forward
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
import { isReplayOrGamePathShape } from "../../src/client/HistoryGuard";

describe("isReplayOrGamePathShape", () => {
  it("recognizes every one of handleJoinLobby's own target history-entry shapes", () => {
    expect(isReplayOrGamePathShape("/ai-league-replay/league-coworld-x")).toBe(
      true,
    );
    expect(isReplayOrGamePathShape("/premiere/prem_abc123")).toBe(true);
    expect(isReplayOrGamePathShape("/bet/prem_abc123")).toBe(true);
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
    // matched alternative — a bare "/premiere" or "/bets/x" must not match.
    expect(isReplayOrGamePathShape("/premiere")).toBe(false);
    expect(isReplayOrGamePathShape("/bets/x")).toBe(false);
    expect(isReplayOrGamePathShape("/premieres/x")).toBe(false);
  });
});
