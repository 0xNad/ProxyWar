import { analytics } from "./analytics/AnalyticsClient";
import { translateText } from "./Utils";

const REPLAY_LOADING_ID = "proxywar-replay-loading";
const REPLAY_ROUTE_CLASS = "proxywar-replay-route";
const REPLAY_BOOTING_CLASS = "proxywar-replay-booting";
const REPLAY_FRAME_EVENT = "ai-league-replay-frame";
const REPLAY_ERROR_EVENT = "ai-league-replay-load-error";

export const REPLAY_LOADING_SLOW_TIMEOUT_MS = 45_000;
/**
 * How long a live join is allowed to sit in "Joining live…" with no
 * convergence signal before recovery options (Retry / Back to league)
 * surface. Independent of `REPLAY_LOADING_SLOW_TIMEOUT_MS`: that timer is
 * cleared the moment join-sync begins (see `Main.ts`'s veil handling), so
 * without a dedicated bound here a join that never converges has no
 * escape at all — an indefinite spinner with nothing reachable. Generous
 * enough that a real, still-progressing catch-up under heavy load is not
 * mistaken for a stuck one; a genuinely converging join clears this by
 * reaching `onJoinSync`'s "complete" state long before it fires.
 */
export const JOIN_SYNC_TIMEOUT_MS = 60_000;

export interface JoinSyncWatchdogCallbacks {
  /** Fires once the join has gone `timeoutMs` with no forward progress. */
  onStalled: () => void;
  /**
   * Fires when forward progress resumes after `onStalled` already fired --
   * the caller should clear whatever it rendered from `onStalled` and
   * resume the honest in-progress veil.
   */
  onRecovered: () => void;
}

export interface JoinSyncWatchdog {
  /** (Re)starts the join from a clean slate: no prior turn, not stalled. */
  arm: () => void;
  /**
   * Reports the latest `onJoinSync` "syncing" turn. Only a STRICTLY
   * greater turn than the last one observed counts as progress -- `null`
   * (target known, nothing dispatched yet) or a repeat of the same turn
   * never rearms the timer and never clears a latched stall.
   */
  recordProgress: (currentTurn: number | null) => void;
  /** Cancels the pending timer without touching `stalled`. */
  clear: () => void;
  readonly stalled: boolean;
}

/**
 * An honest, INACTIVITY-based join-sync watchdog -- never a fixed deadline
 * from first sync. `JOIN_SYNC_TIMEOUT_MS` bounds SILENCE, not total join
 * time: a catch-up on a backlogged market can legitimately keep advancing
 * well past that window (network ingest and worker dispatch both free-run
 * far beyond it), so a one-shot timer fired regardless of whether the join
 * was still alive -- latching a terminal-looking failure OVER a sync that
 * was still climbing behind it. `recordProgress` rearms on every distinct
 * forward step and clears any already-latched stall the moment progress
 * resumes; `onStalled` only ever fires after a genuine silence of the
 * full window.
 */
export function createJoinSyncWatchdog(
  callbacks: JoinSyncWatchdogCallbacks,
  timeoutMs = JOIN_SYNC_TIMEOUT_MS,
): JoinSyncWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTurn: number | null = null;
  let stalled = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const rearm = () => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      stalled = true;
      callbacks.onStalled();
    }, timeoutMs);
  };

  return {
    arm() {
      lastTurn = null;
      stalled = false;
      rearm();
    },
    recordProgress(currentTurn) {
      const advanced =
        currentTurn !== null && (lastTurn === null || currentTurn > lastTurn);
      if (!advanced) return;
      lastTurn = currentTurn;
      rearm();
      if (stalled) {
        stalled = false;
        callbacks.onRecovered();
      }
    },
    clear,
    get stalled() {
      return stalled;
    },
  };
}

export type ReplayLoadingMessageKey =
  | "ai_league_replay.loading_replay"
  | "ai_league_replay.waiting_for_replay"
  | "ai_league_replay.loading_slow"
  | "ai_league_replay.loading_failed"
  | "replay_premiere.loading_premiere"
  | "replay_premiere.joining_live"
  | "replay_premiere.waiting_for_start";

export function showReplayLoadingScreen(
  messageKey: ReplayLoadingMessageKey = "ai_league_replay.loading_replay",
  busy = true,
): HTMLElement {
  document.documentElement.classList.add(
    REPLAY_ROUTE_CLASS,
    REPLAY_BOOTING_CLASS,
  );

  const screen = ensureReplayLoadingScreen();
  screen.setAttribute("role", "status");
  screen.setAttribute("aria-busy", String(busy));
  updateReplayLoadingMessage(screen, messageKey);

  // A stalled/failed load is the ONLY point Retry is real: `loading_slow`
  // ("this is taking longer than expected…") and `loading_failed`
  // ("Replay unavailable") both leave the viewer stuck with nothing
  // actionable but a status region unless Retry is reachable here too --
  // not just on the terminal failure screen. Every other in-progress
  // message key keeps it hidden until there is something real to retry.
  const retry = screen.querySelector<HTMLButtonElement>(
    "[data-replay-loading-retry]",
  );
  if (retry !== null) {
    const retryEligible =
      messageKey === "ai_league_replay.loading_slow" ||
      messageKey === "ai_league_replay.loading_failed";
    retry.hidden = !retryEligible;
    if (retryEligible) {
      retry.dataset.i18n = "ai_league_replay.retry";
      const translated = translateText("ai_league_replay.retry");
      retry.textContent =
        translated === "ai_league_replay.retry" ? "" : translated;
    }
  }
  // The back-to-league escape stays reachable for the ENTIRE loading
  // sequence, not just after a confirmed failure — an indefinite wait
  // with nothing focusable but a status region is a dead end for keyboard
  // users regardless of what eventually goes wrong (or doesn't resolve at
  // all).
  ensureBackLinkVisible(screen);
  setReplayLoadingProgress(null);

  document.getElementById("proxywar-coworld-splash")?.remove();
  return screen;
}

/**
 * Live-updating subline under the veil message (join-sync progress:
 * "Syncing to turn {n}…"). Pass null to clear/hide. No aria-live: it updates
 * many times per second during a catch-up; the headline message carries the
 * announced state.
 */
export function setReplayLoadingProgress(text: string | null): void {
  const progress = document.querySelector<HTMLElement>(
    "[data-replay-loading-progress]",
  );
  if (progress === null) return;
  if (text === null || text.length === 0) {
    progress.hidden = true;
    progress.textContent = "";
    return;
  }
  progress.hidden = false;
  progress.textContent = text;
}

/**
 * Also the single hook point for `replay_load_started`/`succeeded`/`failed`
 * (Phase 7): this function already brackets the exact "started loading" ->
 * "first frame" / "load error" lifecycle with one-shot listeners (`{once:
 * true}` + `cleanup()`), so there is no separate per-tick or duplicate-fire
 * risk to guard against here — each of the three events can only land once
 * per call. `matchId` is optional since not every caller necessarily has
 * one at hand, but `Main.ts`'s `openAiLeagueReplay` always does.
 */
export function holdReplayLoadingScreenUntilFirstFrame(
  timeoutMs = REPLAY_LOADING_SLOW_TIMEOUT_MS,
  messageKey: ReplayLoadingMessageKey = "ai_league_replay.loading_replay",
  matchId?: string,
): () => void {
  showReplayLoadingScreen(messageKey);
  analytics.track("replay_load_started", matchId !== undefined ? { matchId } : undefined);

  let active = true;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (!active) return;
    active = false;
    document.removeEventListener(REPLAY_FRAME_EVENT, onFirstFrame);
    document.removeEventListener(REPLAY_ERROR_EVENT, onReplayError);
    if (slowTimer !== null) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
  };

  const onFirstFrame = () => {
    cleanup();
    analytics.track("replay_load_succeeded", matchId !== undefined ? { matchId } : undefined);
    finishReplayLoadingScreen();
  };

  const onReplayError = () => {
    cleanup();
    analytics.track("replay_load_failed", {
      reason: "load_error",
      ...(matchId !== undefined ? { matchId } : {}),
    });
    showReplayLoadingFailure();
  };

  document.addEventListener(REPLAY_FRAME_EVENT, onFirstFrame, { once: true });
  document.addEventListener(REPLAY_ERROR_EVENT, onReplayError, { once: true });
  slowTimer = setTimeout(() => {
    if (active) {
      showReplayLoadingScreen("ai_league_replay.loading_slow");
    }
  }, timeoutMs);

  return cleanup;
}

export async function runReplayStartup(
  startup: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await startup();
  } catch (error) {
    onFailure(error);
  }
}

export function showReplayLoadingFailure(): HTMLElement {
  const screen = showReplayLoadingScreen(
    "ai_league_replay.loading_failed",
    false,
  );
  screen.setAttribute("role", "alert");
  screen
    .querySelector<HTMLButtonElement>("[data-replay-loading-retry]")
    ?.focus();
  return screen;
}

export function finishReplayLoadingScreen(): void {
  document.documentElement.classList.remove(REPLAY_BOOTING_CLASS);
  document.getElementById(REPLAY_LOADING_ID)?.remove();
  document.getElementById("proxywar-coworld-splash")?.remove();
}

function ensureReplayLoadingScreen(): HTMLElement {
  const existing = document.getElementById(REPLAY_LOADING_ID);
  if (existing !== null) {
    bindRetry(existing);
    ensureProgressElement(existing);
    return existing;
  }

  const screen = document.createElement("div");
  screen.id = REPLAY_LOADING_ID;
  screen.setAttribute("role", "status");
  screen.setAttribute("aria-live", "polite");
  screen.setAttribute("aria-atomic", "true");

  const content = document.createElement("div");
  content.className = "proxywar-replay-loading-content";

  const spinner = document.createElement("div");
  spinner.className = "proxywar-replay-loading-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const message = document.createElement("p");
  message.dataset.replayLoadingMessage = "";

  const progress = document.createElement("p");
  progress.dataset.replayLoadingProgress = "";
  progress.className = "proxywar-replay-loading-progress";
  progress.hidden = true;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.dataset.replayLoadingRetry = "";
  retry.hidden = true;

  const actions = document.createElement("div");
  actions.className = "proxywar-replay-loading-actions";

  const back = document.createElement("a");
  back.href = "/league";
  back.dataset.replayLoadingBack = "";

  actions.append(retry, back);
  content.append(spinner, message, progress, actions);
  screen.append(content);
  document.body.prepend(screen);
  bindRetry(screen);
  return screen;
}

// The static first-paint veil may come from a cached app shell that predates
// the join-sync progress line; owning the screen adds it when missing.
function ensureProgressElement(screen: HTMLElement): void {
  if (screen.querySelector("[data-replay-loading-progress]") !== null) {
    return;
  }
  const progress = document.createElement("p");
  progress.dataset.replayLoadingProgress = "";
  progress.className = "proxywar-replay-loading-progress";
  progress.hidden = true;
  const message = screen.querySelector("[data-replay-loading-message]");
  if (message?.parentElement) {
    message.after(progress);
  } else {
    screen.append(progress);
  }
}

// Always reachable for the entire loading sequence (see
// `showReplayLoadingScreen`'s call site) — labels/unhides the back-to-
// league link whether it came from `ensureReplayLoadingScreen`'s freshly
// created DOM or was adopted from the static pre-hydration veil in
// `index.html` (which ships `hidden` for a pre-JS-boot instant, same
// reasoning as `ensureProgressElement` above).
function ensureBackLinkVisible(screen: HTMLElement): void {
  const back = screen.querySelector<HTMLAnchorElement>(
    "[data-replay-loading-back]",
  );
  if (back === null) return;
  back.hidden = false;
  back.dataset.i18n = "ai_league_replay.back_to_league";
  const translated = translateText("ai_league_replay.back_to_league");
  back.textContent =
    translated === "ai_league_replay.back_to_league" ? "" : translated;
}

function bindRetry(screen: HTMLElement): void {
  const retry = screen.querySelector<HTMLButtonElement>(
    "[data-replay-loading-retry]",
  );
  if (retry === null || retry.dataset.replayRetryBound === "true") return;
  retry.dataset.replayRetryBound = "true";
  retry.addEventListener("click", () => window.location.reload());
}

function updateReplayLoadingMessage(
  screen: HTMLElement,
  messageKey: ReplayLoadingMessageKey,
): void {
  const message = screen.querySelector<HTMLElement>(
    "[data-replay-loading-message]",
  );
  if (message === null) return;
  message.dataset.i18n = messageKey;
  const translated = translateText(messageKey);
  message.textContent = translated === messageKey ? "" : translated;
}
