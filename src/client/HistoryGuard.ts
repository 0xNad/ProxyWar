/**
 * True when `pathname` is already one of `Main.ts`'s `handleJoinLobby` own
 * target history-entry shapes (a replay, premiere, streamer-mode,
 * or live-game URL).
 *
 * P0 fix (found live 2026-08-02): after Back from a replay, Forward failed
 * with "History entry not found". `handleJoinLobby`'s "ensure a homepage
 * entry" `history.replaceState` used to fire on ANY page with an empty
 * hash, including a replay/premiere/game page re-joined via Back/
 * Forward (none of those carry a hash either) — silently rewriting an
 * already-legitimate history entry to `#refresh` and orphaning whatever
 * the browser's session history expected to sit there. That `replaceState`
 * now only fires when this predicate returns false.
 *
 * Kept in its own side-effect-free module (rather than exported straight
 * from `Main.ts`) so it can be unit tested without pulling in `Main.ts`'s
 * own module-load bootstrap (`new Client().initialize()`, which requires a
 * real browser: `FontFace`, CrazyGames SDK probing, etc.).
 */
export function isReplayOrGamePathShape(pathname: string): boolean {
  return (
    /^\/(ai-league-replay|premiere)\//.test(pathname) ||
    pathname === "/streamer-mode" ||
    pathname.includes("/game/")
  );
}

/**
 * True when `handleJoinLobby`'s ai-league-replay join branch should
 * actually call `history.pushState` for the resolved run's canonical
 * `/ai-league-replay/:runID` path — false when the browser is ALREADY on
 * that exact path (a fresh/hard navigation straight to the replay URL,
 * or a re-join that never left it), the SAME pathname-equality guard the
 * premiere branch immediately above it in `handleJoinLobby` already uses.
 *
 * P0 REOPEN fix (pass-3 repro, 2026-08-02): the un-guarded call used to
 * fire unconditionally, ~2.5-5s after the page's own `onload` (the join
 * flow's own async settle time) — well past the window several browsers
 * require to still trust a `pushState` as user-gesture-driven (documented
 * for Chrome/WebKit on iOS; see Chromium issue 330744614, "History entry
 * not added even if history.pushState was called"). A push that arrives
 * too late for that window can be silently dropped from the actual
 * session-history stack while the page still believes it landed — the
 * exact desync a real-browser repro confirmed: native Back landed back on
 * the SAME url instead of the true previous page (a phantom duplicate
 * entry), and Forward afterward failed with "History entry not found".
 * Guarding on path equality means a fresh/re-navigated visitor whose URL
 * is already correct is never redundantly re-pushed at all.
 */
export function shouldPushAiLeagueReplayHistoryEntry(
  currentPathname: string,
  targetPathname: string,
): boolean {
  return currentPathname !== targetPathname;
}
