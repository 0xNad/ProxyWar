import { readProxyWarClipGenerationCapabilities } from "./ClipGenerationCapabilities";
import { translateText } from "./Utils";

const LEAGUE_CLIP_MIN_ANCHOR_TURN = 50;
const LEAGUE_CLIP_POLL_MS = 3_000;
const LEAGUE_CLIP_MAX_POLLS = 130;

interface LeagueClipReadyView {
  clipUrl: string;
  caption: string;
  firstReply: string;
}

interface LeagueClipState {
  runKey: string;
  status: "idle" | "preparing" | "ready" | "failed" | "busy";
  generationCapability: "unknown" | "loading" | "enabled" | "disabled";
  ready: LeagueClipReadyView | null;
  latestTurn: number;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollBucket: number | null;
  pollAttempts: number;
  subscribers: Set<() => void>;
  fetchImpl: typeof fetch;
}

export interface ReplayScopedLeagueClipControlHandle {
  dispose(): void;
}

export interface ReplayScopedLeagueClipControlOptions {
  container: HTMLElement;
  runKey: string;
  documentRef?: Document;
  navigatorRef?: Navigator;
  fetchImpl?: typeof fetch;
}

type LeagueClipWindow = Window & {
  __proxyWarLeagueClipStates?: Map<string, LeagueClipState>;
};

/**
 * Mount the canonical retained-run clip control.
 *
 * Both the ordinary league replay and an archived rated Premiere use this
 * controller, so they share the exact endpoint, capability gate, response
 * validation, polling, and cache-download behavior. The archive path never
 * creates or consumes a Premiere interaction session.
 */
export function mountReplayScopedLeagueClipControl(
  options: ReplayScopedLeagueClipControlOptions,
): ReplayScopedLeagueClipControlHandle {
  const documentRef = options.documentRef ?? document;
  const navigatorRef = options.navigatorRef ?? navigator;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const state = leagueClipState(
    options.runKey,
    fetchImpl,
    documentRef.defaultView,
  );
  let disposed = false;

  const render = (): void => {
    if (!disposed && options.container.isConnected) {
      renderLeagueClipSection(
        options.container,
        state,
        navigatorRef,
        fetchImpl,
      );
    }
  };
  const onFrame = (event: Event): void => {
    const detail = (event as CustomEvent<{ turnNumber?: unknown }>).detail;
    if (
      typeof detail?.turnNumber !== "number" ||
      !Number.isSafeInteger(detail.turnNumber) ||
      detail.turnNumber < 0
    ) {
      return;
    }
    const previous = state.latestTurn;
    state.latestTurn = Math.max(state.latestTurn, detail.turnNumber);
    if (
      previous < LEAGUE_CLIP_MIN_ANCHOR_TURN &&
      state.latestTurn >= LEAGUE_CLIP_MIN_ANCHOR_TURN &&
      state.status === "idle"
    ) {
      notifyLeagueClipState(state);
    }
  };

  state.subscribers.add(render);
  documentRef.addEventListener("ai-league-replay-frame", onFrame);
  if (state.generationCapability === "unknown") {
    state.generationCapability = "loading";
    void readProxyWarClipGenerationCapabilities(fetchImpl).then(
      (capabilities) => {
        state.generationCapability = capabilities.leagueGenerationEnabled
          ? "enabled"
          : "disabled";
        if (state.generationCapability === "disabled") {
          clearLeagueClipPoll(state);
        }
        notifyLeagueClipState(state);
      },
      () => {
        state.generationCapability = "disabled";
        clearLeagueClipPoll(state);
        notifyLeagueClipState(state);
      },
    );
  }
  render();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      state.subscribers.delete(render);
      documentRef.removeEventListener("ai-league-replay-frame", onFrame);
      options.container.replaceChildren();
      if (state.subscribers.size === 0) {
        clearLeagueClipPoll(state);
      }
    },
  };
}

function leagueClipState(
  runKey: string,
  fetchImpl: typeof fetch,
  windowRef: Window | null,
): LeagueClipState {
  const target = (windowRef ?? window) as LeagueClipWindow;
  target.__proxyWarLeagueClipStates ??= new Map<string, LeagueClipState>();
  const existing = target.__proxyWarLeagueClipStates.get(runKey);
  if (existing !== undefined) return existing;
  const created: LeagueClipState = {
    runKey,
    status: "idle",
    generationCapability: "unknown",
    ready: null,
    latestTurn: 0,
    pollTimer: null,
    pollBucket: null,
    pollAttempts: 0,
    subscribers: new Set(),
    fetchImpl,
  };
  target.__proxyWarLeagueClipStates.set(runKey, created);
  return created;
}

function notifyLeagueClipState(state: LeagueClipState): void {
  for (const render of state.subscribers) render();
}

function renderLeagueClipSection(
  container: HTMLElement,
  state: LeagueClipState,
  navigatorRef: Navigator,
  fetchImpl: typeof fetch,
): void {
  container.replaceChildren();
  if (state.generationCapability !== "enabled") {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const heading = documentFor(container).createElement("strong");
  heading.textContent = translateText("ai_league_replay.clip_heading");
  container.append(heading);

  if (state.status === "ready" && state.ready !== null) {
    appendStatus(container, "ai_league_replay.clip_ready");
    const download = documentFor(container).createElement("a");
    download.className = "ai-league-badge";
    download.href = state.ready.clipUrl;
    download.setAttribute("download", "");
    download.dataset.aiLeagueClipDownload = "";
    download.textContent = translateText("ai_league_replay.clip_download_file");
    container.append(download);
    const copy = actionButton(
      container,
      "ai_league_replay.clip_copy_caption",
      "aiLeagueClipCopyCaption",
    );
    copy.addEventListener("click", () => {
      const caption = state.ready?.caption;
      if (typeof caption === "string") {
        void navigatorRef.clipboard?.writeText(caption).catch(() => undefined);
      }
    });
    container.append(copy);
    return;
  }
  if (state.status === "preparing") {
    appendStatus(container, "ai_league_replay.clip_preparing");
    return;
  }

  if (state.latestTurn < LEAGUE_CLIP_MIN_ANCHOR_TURN) {
    appendStatus(container, "ai_league_replay.clip_waiting_playback");
  } else {
    const render = actionButton(
      container,
      "ai_league_replay.clip_render",
      "aiLeagueClipRender",
    );
    render.addEventListener("click", () => {
      void requestLeagueClip(state, fetchImpl);
    });
    container.append(render);
  }
  if (state.status === "failed") {
    appendStatus(container, "ai_league_replay.clip_failed");
  } else if (state.status === "busy") {
    appendStatus(container, "ai_league_replay.clip_busy");
  }
}

function actionButton(
  container: HTMLElement,
  translationKey: string,
  datasetKey: "aiLeagueClipCopyCaption" | "aiLeagueClipRender",
): HTMLButtonElement {
  const button = documentFor(container).createElement("button");
  button.type = "button";
  button.className = "ai-league-badge";
  button.dataset[datasetKey] = "";
  button.textContent = translateText(translationKey);
  return button;
}

function appendStatus(container: HTMLElement, translationKey: string): void {
  const status = documentFor(container).createElement("span");
  status.className = "ai-league-muted";
  status.textContent = translateText(translationKey);
  container.append(status);
}

function documentFor(element: HTMLElement): Document {
  return element.ownerDocument;
}

async function requestLeagueClip(
  state: LeagueClipState,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (
    state.generationCapability !== "enabled" ||
    state.status === "preparing" ||
    state.latestTurn < LEAGUE_CLIP_MIN_ANCHOR_TURN
  ) {
    return;
  }
  clearLeagueClipPoll(state);
  state.status = "preparing";
  state.ready = null;
  notifyLeagueClipState(state);
  let response: Response;
  try {
    response = await fetchImpl(
      `/api/league-runs/${encodeURIComponent(state.runKey)}/clips`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn: state.latestTurn }),
      },
    );
  } catch {
    applyLeagueClipFailure(state, "failed");
    return;
  }
  if (!response.ok) {
    applyLeagueClipFailure(
      state,
      response.status === 429 || response.status === 503 ? "busy" : "failed",
    );
    return;
  }
  try {
    applyLeagueClipStatus(state, await response.json());
  } catch {
    applyLeagueClipFailure(state, "failed");
  }
}

function applyLeagueClipStatus(state: LeagueClipState, value: unknown): void {
  const status = parseLeagueClipStatus(value, state.runKey);
  if (status === null) {
    applyLeagueClipFailure(state, "failed");
    return;
  }
  if (status.state === "ready") {
    clearLeagueClipPoll(state);
    state.status = "ready";
    state.ready = status.ready;
    notifyLeagueClipState(state);
    return;
  }
  if (status.state === "pending") {
    state.status = "preparing";
    state.ready = null;
    state.pollBucket = status.bucket;
    state.pollAttempts = 0;
    notifyLeagueClipState(state);
    scheduleLeagueClipPoll(state);
    return;
  }
  applyLeagueClipFailure(state, "failed");
}

type ParsedLeagueClipStatus =
  | { state: "pending"; bucket: number }
  | { state: "ready"; bucket: number; ready: LeagueClipReadyView };

function parseLeagueClipStatus(
  value: unknown,
  runKey: string,
): ParsedLeagueClipStatus | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (
    value.premiereId !== runKey ||
    value.clipVersion !== 1 ||
    !Number.isSafeInteger(value.bucket) ||
    Number(value.bucket) < 0
  ) {
    return null;
  }
  const bucket = Number(value.bucket);
  if (value.state === "pending" && value.ready === null) {
    return { state: "pending", bucket };
  }
  if (value.state !== "ready" || !isRecord(value.ready)) return null;
  const ready = value.ready;
  const social = ready.social;
  const expectedUrl = `/ai-league-runs/${runKey}/clip-v1-${bucket}.mp4`;
  if (
    ready.clipUrl !== expectedUrl ||
    !isRecord(social) ||
    typeof social.caption !== "string" ||
    typeof social.firstReply !== "string"
  ) {
    return null;
  }
  return {
    state: "ready",
    bucket,
    ready: {
      clipUrl: expectedUrl,
      caption: social.caption,
      firstReply: social.firstReply,
    },
  };
}

function scheduleLeagueClipPoll(state: LeagueClipState): void {
  clearLeagueClipPoll(state);
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    void pollLeagueClipStatus(state);
  }, LEAGUE_CLIP_POLL_MS);
}

async function pollLeagueClipStatus(state: LeagueClipState): Promise<void> {
  if (state.status !== "preparing" || state.pollBucket === null) return;
  state.pollAttempts += 1;
  if (state.pollAttempts > LEAGUE_CLIP_MAX_POLLS) {
    applyLeagueClipFailure(state, "failed");
    return;
  }
  let response: Response;
  try {
    response = await state.fetchImpl(
      `/api/league-runs/${encodeURIComponent(state.runKey)}/clips/${state.pollBucket}`,
    );
  } catch {
    scheduleLeagueClipPoll(state);
    return;
  }
  if (response.status === 404) {
    applyLeagueClipFailure(state, "failed");
    return;
  }
  if (!response.ok) {
    scheduleLeagueClipPoll(state);
    return;
  }
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && value.state === "pending") {
      scheduleLeagueClipPoll(state);
      return;
    }
    applyLeagueClipStatus(state, value);
  } catch {
    scheduleLeagueClipPoll(state);
  }
}

function applyLeagueClipFailure(
  state: LeagueClipState,
  kind: "failed" | "busy",
): void {
  clearLeagueClipPoll(state);
  state.status = kind;
  state.ready = null;
  notifyLeagueClipState(state);
}

function clearLeagueClipPoll(state: LeagueClipState): void {
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
