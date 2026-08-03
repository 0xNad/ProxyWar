import { EventBus } from "../core/EventBus";
import { ReplaySpeedChangeEvent } from "./InputHandler";
import { ReplaySpeedMultiplier } from "./utilities/ReplaySpeedMultiplier";

/**
 * P0 fix (2026-08-03): a user's manually-picked replay speed used to reset
 * to 1x across the `?turn=` backward-seek navigation path
 * (`dispatchJumpToTurn`'s reload branch — see `Main.ts`/`LocalServer.ts`'s
 * own `userOverrodeReplaySpeed` "house rule" doc) — that latch is plain
 * in-memory `LocalServer` instance state, and a real page reload makes a
 * fresh instance, silently reverting to the default even though the whole
 * point of the original speed-latch fix was "a user speed change should
 * stick, never be silently reverted by automatic pacing". A `?turn=`
 * navigation is exactly that: an automatic-pacing-adjacent mechanic (the
 * SAME reload-based path Director Cut/timeline backward-seeks use), not a
 * fresh visit where reverting to the default is expected.
 *
 * `sessionStorage`-backed, keyed by run id — same convention (and same
 * rationale for session-scoped, not `localStorage`) as
 * `ReplayPositionPersistence.ts`'s own "refresh-resume" mechanism: a
 * genuinely NEW visit (new tab, or the tab closed) should start at the
 * default speed, not silently resume a stale pick from a different
 * session. Deliberately a SEPARATE file/key from position resume — the two
 * are independent concerns that can be cleared/inspected independently,
 * matching this codebase's existing one-concern-per-persistence-module
 * convention (`PointOfView.ts`, `PremiereReminder.ts`).
 */
const REPLAY_SPEED_KEY_PREFIX = "proxywar:replay-speed:";

function replaySpeedStorageKey(runId: string): string {
  return `${REPLAY_SPEED_KEY_PREFIX}${runId}`;
}

const VALID_SPEED_VALUES: ReadonlySet<number> = new Set(
  Object.values(ReplaySpeedMultiplier).filter(
    (value): value is number => typeof value === "number",
  ),
);

/** `null` when there's no saved speed, or storage is unavailable (private browsing, quota), or the saved value isn't a recognised `ReplaySpeedMultiplier`. */
export function loadPersistedReplaySpeed(
  runId: string,
): ReplaySpeedMultiplier | null {
  try {
    const raw = sessionStorage.getItem(replaySpeedStorageKey(runId));
    if (raw === null) return null;
    const parsed = Number(raw);
    return VALID_SPEED_VALUES.has(parsed)
      ? (parsed as ReplaySpeedMultiplier)
      : null;
  } catch {
    return null;
  }
}

function saveReplaySpeed(runId: string, speed: ReplaySpeedMultiplier): void {
  try {
    sessionStorage.setItem(replaySpeedStorageKey(runId), String(speed));
  } catch {
    // Storage unavailable (private browsing, quota) — no-op this session, never a crash.
  }
}

/**
 * Persists every USER-sourced speed change (never an "auto" one — Director
 * Cut's per-segment pacing or the archived-replay fastest-default must
 * never get written back as if the viewer had picked them). Returns a
 * cleanup function; the caller (`Main.ts`'s `handleJoinLobby`) disposes it
 * the same way it already disposes `watchReplayPositionForResume`.
 */
export function watchReplaySpeedForResume(
  runId: string,
  eventBus: EventBus,
): () => void {
  const onSpeedChange = (event: ReplaySpeedChangeEvent): void => {
    if (event.source !== "user") return;
    saveReplaySpeed(runId, event.replaySpeedMultiplier);
  };
  eventBus.on(ReplaySpeedChangeEvent, onSpeedChange);
  return () => eventBus.off(ReplaySpeedChangeEvent, onSpeedChange);
}
