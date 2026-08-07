/**
 * P2 fix (2026-08-02): "refresh-resume" for an archived AI League Full
 * Replay (`/ai-league-replay/:runID`) — reloading (or navigating away and
 * back within the same tab) used to lose all playback progress with no
 * scrub bar to manually get back to where the viewer was. A full seek/
 * timeline control is a real FEATURE, out of scope here; this is the
 * cheap 80% win: `sessionStorage`-backed auto-resume via the existing
 * `ReplayJumpToTurnEvent` (`jumpReplayForward()`'s forward-only seek,
 * already used by the reveal-seek/URL-turn-param/rail-click call sites in
 * `Main.ts`).
 *
 * Session-scoped (not `localStorage`) deliberately — the same convention
 * `ReplayPremiereRuntime.ts`'s own session persistence already uses for
 * viewer-local, per-tab playback state: a genuinely NEW visit (new tab, or
 * the tab closed) should start
 * from turn 0, not silently resume a stale position from a different
 * session. Keyed by the run id, same flat-namespace convention
 * `PremiereReminder.ts`'s reminder keys already use (that file's own doc
 * explains why one flat key namespace is safe here: `ai_league_run_id`
 * strings never collide with anything else keyed this way).
 */

const REPLAY_POSITION_KEY_PREFIX = "proxywar:replay-position:";
// Below this many turns, resuming isn't worth it — a fresh short replay
// (or one abandoned in its first few seconds) should just play normally
// from the start rather than "resuming" to somewhere barely past turn 0.
const MIN_RESUMABLE_TURN = 10;
// How many turns must elapse between saves — every single
// `ai-league-replay-frame` tick would be wasteful (fastest-speed replay
// can render many turns per second); this still saves often enough that a
// reload loses at most a few seconds of progress.
const SAVE_INTERVAL_TURNS = 10;

function replayPositionStorageKey(runId: string): string {
  return `${REPLAY_POSITION_KEY_PREFIX}${runId}`;
}

/** `null` when there's no saved position, storage is unavailable (private browsing, quota), or the saved value doesn't clear `MIN_RESUMABLE_TURN`. */
export function loadResumableReplayTurn(runId: string): number | null {
  try {
    const raw = sessionStorage.getItem(replayPositionStorageKey(runId));
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= MIN_RESUMABLE_TURN
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function saveReplayPosition(runId: string, turnNumber: number): void {
  try {
    sessionStorage.setItem(replayPositionStorageKey(runId), String(turnNumber));
  } catch {
    // Storage unavailable (private browsing, quota) — no-op this session, never a crash.
  }
}

/**
 * Subscribes to the SAME `ai-league-replay-frame` DOM `CustomEvent` every
 * other per-frame subsystem in this codebase already listens to
 * (`AiLeagueReplayOverlay.ts`, `ReplayClipControl.ts`) — never a bespoke
 * timer/RAF loop. Saves at most
 * once every `SAVE_INTERVAL_TURNS` turns. Returns a cleanup function; the
 * caller (`Main.ts`'s `handleJoinLobby`) is responsible for calling it
 * when the replay ends or the viewer leaves, same as every other
 * `ai-league-replay-frame` subscriber's own dispose pattern.
 */
export function watchReplayPositionForResume(
  runId: string,
  documentRef: Document = document,
): () => void {
  let lastSavedTurn = -SAVE_INTERVAL_TURNS;
  const onFrame = (event: Event) => {
    const turnNumber = (event as CustomEvent<{ turnNumber?: unknown }>).detail
      ?.turnNumber;
    if (
      typeof turnNumber !== "number" ||
      !Number.isSafeInteger(turnNumber) ||
      turnNumber < lastSavedTurn + SAVE_INTERVAL_TURNS
    ) {
      return;
    }
    lastSavedTurn = turnNumber;
    saveReplayPosition(runId, turnNumber);
  };
  documentRef.addEventListener("ai-league-replay-frame", onFrame);
  return () =>
    documentRef.removeEventListener("ai-league-replay-frame", onFrame);
}
