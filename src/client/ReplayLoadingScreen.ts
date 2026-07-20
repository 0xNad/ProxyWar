import { translateText } from "./Utils";

const REPLAY_LOADING_ID = "proxywar-replay-loading";
const REPLAY_ROUTE_CLASS = "proxywar-replay-route";
const REPLAY_BOOTING_CLASS = "proxywar-replay-booting";
const REPLAY_FRAME_EVENT = "ai-league-replay-frame";
const REPLAY_ERROR_EVENT = "ai-league-replay-load-error";

export const REPLAY_LOADING_SLOW_TIMEOUT_MS = 45_000;

export type ReplayLoadingMessageKey =
  | "ai_league_replay.loading_replay"
  | "ai_league_replay.waiting_for_replay"
  | "ai_league_replay.loading_slow"
  | "ai_league_replay.loading_failed";

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

  const retry = screen.querySelector<HTMLButtonElement>(
    "[data-replay-loading-retry]",
  );
  if (retry !== null) {
    retry.hidden = true;
  }
  const back = screen.querySelector<HTMLElement>("[data-replay-loading-back]");
  if (back !== null) {
    back.hidden = true;
  }

  document.getElementById("proxywar-coworld-splash")?.remove();
  return screen;
}

export function holdReplayLoadingScreenUntilFirstFrame(
  timeoutMs = REPLAY_LOADING_SLOW_TIMEOUT_MS,
): () => void {
  showReplayLoadingScreen();

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
    finishReplayLoadingScreen();
  };

  const onReplayError = () => {
    cleanup();
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
  const retry = screen.querySelector<HTMLButtonElement>(
    "[data-replay-loading-retry]",
  );
  screen.setAttribute("role", "alert");
  if (retry !== null) {
    retry.hidden = false;
    retry.dataset.i18n = "ai_league_replay.retry";
    const translated = translateText("ai_league_replay.retry");
    retry.textContent =
      translated === "ai_league_replay.retry" ? "" : translated;
    retry.focus();
  }
  const back = screen.querySelector<HTMLAnchorElement>(
    "[data-replay-loading-back]",
  );
  if (back !== null) {
    back.hidden = false;
    back.dataset.i18n = "ai_league_replay.back_to_league";
    const translated = translateText("ai_league_replay.back_to_league");
    back.textContent =
      translated === "ai_league_replay.back_to_league" ? "" : translated;
  }
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

  const retry = document.createElement("button");
  retry.type = "button";
  retry.dataset.replayLoadingRetry = "";
  retry.hidden = true;

  const actions = document.createElement("div");
  actions.className = "proxywar-replay-loading-actions";

  const back = document.createElement("a");
  back.href = "/league";
  back.dataset.replayLoadingBack = "";
  back.hidden = true;

  actions.append(retry, back);
  content.append(spinner, message, actions);
  screen.append(content);
  document.body.prepend(screen);
  bindRetry(screen);
  return screen;
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
