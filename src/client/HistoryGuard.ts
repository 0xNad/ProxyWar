/**
 * True when `pathname` is already one of `Main.ts`'s `handleJoinLobby` own
 * target history-entry shapes (a replay, premiere, betting, streamer-mode,
 * or live-game URL).
 *
 * P0 fix (found live 2026-08-02): after Back from a replay, Forward failed
 * with "History entry not found". `handleJoinLobby`'s "ensure a homepage
 * entry" `history.replaceState` used to fire on ANY page with an empty
 * hash, including a replay/premiere/bet/game page re-joined via Back/
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
    /^\/(ai-league-replay|premiere|bet)\//.test(pathname) ||
    pathname === "/streamer-mode" ||
    pathname.includes("/game/")
  );
}
