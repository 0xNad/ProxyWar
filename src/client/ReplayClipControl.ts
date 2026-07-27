import { readProxyWarClipGenerationCapabilities } from "./ClipGenerationCapabilities";
import { parseReplayRenderFastForwardUntilTurn } from "./ReplayRenderFastForward";
import { translateText } from "./Utils";

const LEAGUE_CLIP_BUCKET_TURNS = 10;
const LEAGUE_CLIP_BUCKET_CENTER_OFFSET = 5;
const LEAGUE_CLIP_MIN_BUCKET = 5;
const LEAGUE_CLIP_POLL_MS = 3_000;

interface LeagueClipReadyView {
  clipUrl: string;
  caption: string;
  firstReply: string;
}

interface LeagueClipPendingView {
  phase: "queued" | "rendering";
  jobsAhead: number;
}

interface LeagueClipState {
  runKey: string;
  status: "idle" | "preparing" | "ready" | "failed" | "busy";
  generationCapability: "unknown" | "loading" | "enabled" | "disabled";
  ready: LeagueClipReadyView | null;
  readyBucket: number | null;
  currentTick: number;
  selectedBucket: number;
  selectionManuallySet: boolean;
  renderableThroughTurn: number | null;
  requestedBucket: number | null;
  pending: LeagueClipPendingView | null;
  preparingStartedMs: number | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<() => void>;
  fetchImpl: typeof fetch;
}

export interface ReplayScopedLeagueClipControlHandle {
  dispose(): void;
}

export interface ReplayScopedLeagueClipControlOptions {
  container: HTMLElement;
  runKey: string;
  /** Highest turn retained for this replay, when the caller has record metadata. */
  renderableThroughTurn?: number | null;
  documentRef?: Document;
  navigatorRef?: Navigator;
  fetchImpl?: typeof fetch;
}

/**
 * A capped/no-winner record ends at its declared turn count. Winner-bearing
 * records can terminate earlier, so their safe Clip range must instead grow
 * from observed frames and freeze on the spoiler-neutral terminal event.
 */
export function initialReplayClipRenderableThroughTurn(info: {
  num_turns: number;
  winner?: unknown;
}): number | null {
  return info.winner === undefined || info.winner === null
    ? info.num_turns
    : null;
}

/** Strictly recognizes the exact fresh-document Preview URL contract. */
export function replayClipPreviewTarget(search: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const rawTurn = params.get("turn");
  if (
    params.get("clipPreview") !== "1" ||
    rawTurn === null ||
    !/^[1-9][0-9]{0,6}$/.test(rawTurn)
  ) {
    return null;
  }
  const turn = Number(rawTurn);
  return parseReplayRenderFastForwardUntilTurn(search) === turn ? turn : null;
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
  applyRenderableThroughTurn(state, options.renderableThroughTurn);
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
    const detail = (
      event as CustomEvent<{
        tick?: unknown;
        terminal?: unknown;
      }>
    ).detail;
    if (
      typeof detail?.tick !== "number" ||
      !Number.isSafeInteger(detail.tick) ||
      detail.tick < 0
    ) {
      return;
    }
    // `turnNumber` reports queued/dispatched navigation progress and can lead
    // the map. Clip anchors follow only the post-render visible simulation tick.
    state.currentTick = detail.tick;
    let shouldNotify = false;
    if (detail.terminal === true) {
      const previousMaximum = state.renderableThroughTurn;
      const previousSelection = state.selectedBucket;
      applyRenderableThroughTurn(state, detail.tick);
      shouldNotify =
        state.renderableThroughTurn !== previousMaximum ||
        state.selectedBucket !== previousSelection;
    }
    if (state.selectionManuallySet) {
      if (shouldNotify) notifyLeagueClipState(state);
      return;
    }
    const nextBucket = bucketForSelectableTurn(state, detail.tick);
    if (nextBucket !== null && nextBucket !== state.selectedBucket) {
      state.selectedBucket = nextBucket;
      shouldNotify = true;
    }
    if (shouldNotify) notifyLeagueClipState(state);
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
        } else if (state.status === "preparing") {
          scheduleLeagueClipPoll(state);
        }
        notifyLeagueClipState(state);
      },
      () => {
        state.generationCapability = "disabled";
        clearLeagueClipPoll(state);
        notifyLeagueClipState(state);
      },
    );
  } else if (
    state.generationCapability === "enabled" &&
    state.status === "preparing"
  ) {
    scheduleLeagueClipPoll(state);
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
    readyBucket: null,
    currentTick: 0,
    selectedBucket: LEAGUE_CLIP_MIN_BUCKET,
    selectionManuallySet: false,
    renderableThroughTurn: null,
    requestedBucket: null,
    pending: null,
    preparingStartedMs: null,
    pollTimer: null,
    subscribers: new Set(),
    fetchImpl,
  };
  target.__proxyWarLeagueClipStates.set(runKey, created);
  return created;
}

function applyRenderableThroughTurn(
  state: LeagueClipState,
  value: number | null | undefined,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return;
  }
  state.renderableThroughTurn =
    state.renderableThroughTurn === null
      ? value
      : Math.min(state.renderableThroughTurn, value);
  const range = clipBucketRange(state);
  if (range !== null) {
    state.selectedBucket = clamp(
      state.selectedBucket,
      range.minBucket,
      range.maxBucket,
    );
  }
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

  const range = clipBucketRange(state);
  if (range === null) {
    appendStatus(
      container,
      state.renderableThroughTurn === null
        ? "ai_league_replay.clip_range_pending"
        : "ai_league_replay.clip_too_short",
    );
    return;
  }
  appendMomentSelector(container, state, range);

  const selectedBucket = state.selectedBucket;
  if (
    state.status === "ready" &&
    state.ready !== null &&
    state.readyBucket === selectedBucket
  ) {
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
    appendPendingStatus(container, state);
    return;
  }

  const render = actionButton(
    container,
    "ai_league_replay.clip_render",
    "aiLeagueClipRender",
  );
  render.addEventListener("click", () => {
    void requestLeagueClip(state, fetchImpl);
  });
  container.append(render);
  if (state.status === "failed") {
    appendStatus(container, "ai_league_replay.clip_failed");
  } else if (state.status === "busy") {
    appendStatus(container, "ai_league_replay.clip_busy");
  }
}

function appendMomentSelector(
  container: HTMLElement,
  state: LeagueClipState,
  range: { minBucket: number; maxBucket: number },
): void {
  const documentRef = documentFor(container);
  const fieldset = documentRef.createElement("fieldset");
  fieldset.className = "ai-league-clip-selector";
  fieldset.disabled = state.status === "preparing";

  const legend = documentRef.createElement("legend");
  legend.textContent = translateText("ai_league_replay.clip_moment_label");
  fieldset.append(legend);

  const selectedTurn = representativeTurn(state.selectedBucket);
  const selected = documentRef.createElement("output");
  selected.className = "ai-league-clip-selected";
  selected.dataset.aiLeagueClipSelectedTurn = String(selectedTurn);
  selected.textContent = translateText(
    "ai_league_replay.clip_selected_moment",
    {
      time: formatReplayTime(selectedTurn),
      turn: selectedTurn,
    },
  );
  fieldset.append(selected);

  const slider = documentRef.createElement("input");
  slider.type = "range";
  slider.min = String(range.minBucket);
  slider.max = String(range.maxBucket);
  slider.step = "1";
  slider.value = String(state.selectedBucket);
  slider.dataset.aiLeagueClipMoment = "";
  slider.setAttribute(
    "aria-label",
    translateText("ai_league_replay.clip_moment_slider_label"),
  );
  slider.addEventListener("input", () => {
    selectLeagueClipBucket(state, Number(slider.value), true);
  });
  fieldset.append(slider);

  const actions = documentRef.createElement("div");
  actions.className = "ai-league-clip-moment-actions";

  const previous = actionButton(
    container,
    "ai_league_replay.clip_previous_second",
    "aiLeagueClipPreviousSecond",
  );
  previous.disabled = state.selectedBucket <= range.minBucket;
  previous.addEventListener("click", () => {
    selectLeagueClipBucket(state, state.selectedBucket - 1, true);
  });
  actions.append(previous);

  const next = actionButton(
    container,
    "ai_league_replay.clip_next_second",
    "aiLeagueClipNextSecond",
  );
  next.disabled = state.selectedBucket >= range.maxBucket;
  next.addEventListener("click", () => {
    selectLeagueClipBucket(state, state.selectedBucket + 1, true);
  });
  actions.append(next);

  const current = actionButton(
    container,
    "ai_league_replay.clip_use_current",
    "aiLeagueClipUseCurrent",
  );
  current.disabled = state.currentTick < representativeTurn(range.minBucket);
  current.addEventListener("click", () => {
    const bucket = bucketForSelectableTurn(state, state.currentTick);
    if (bucket !== null) selectLeagueClipBucket(state, bucket, true);
  });
  actions.append(current);

  const preview = actionButton(
    container,
    "ai_league_replay.clip_preview",
    "aiLeagueClipPreview",
  );
  preview.dataset.aiLeaguePreviewTurn = String(selectedTurn);
  preview.setAttribute(
    "aria-label",
    translateText("ai_league_replay.clip_preview_label", {
      time: formatReplayTime(selectedTurn),
      turn: selectedTurn,
    }),
  );
  actions.append(preview);

  fieldset.append(actions);
  appendStatus(fieldset, "ai_league_replay.clip_process_hint");
  container.append(fieldset);
}

function selectLeagueClipBucket(
  state: LeagueClipState,
  bucket: number,
  manual: boolean,
): void {
  const range = clipBucketRange(state);
  if (
    range === null ||
    !Number.isSafeInteger(bucket) ||
    state.status === "preparing"
  ) {
    return;
  }
  state.selectedBucket = clamp(bucket, range.minBucket, range.maxBucket);
  state.selectionManuallySet ||= manual;
  if (state.status === "failed" || state.status === "busy") {
    state.status = "idle";
  }
  notifyLeagueClipState(state);
}

function appendPendingStatus(
  container: HTMLElement,
  state: LeagueClipState,
): void {
  const elapsed = Math.max(
    0,
    Math.floor((Date.now() - (state.preparingStartedMs ?? Date.now())) / 1_000),
  );
  if (state.pending?.phase === "rendering") {
    appendStatus(container, "ai_league_replay.clip_rendering", { elapsed });
    return;
  }
  if (state.pending?.phase === "queued") {
    appendStatus(
      container,
      state.pending.jobsAhead === 0
        ? "ai_league_replay.clip_queued_next"
        : "ai_league_replay.clip_queued_ahead",
      { elapsed, count: state.pending.jobsAhead },
    );
    return;
  }
  appendStatus(container, "ai_league_replay.clip_preparing", { elapsed });
}

type ClipActionDatasetKey =
  | "aiLeagueClipCopyCaption"
  | "aiLeagueClipRender"
  | "aiLeagueClipPreviousSecond"
  | "aiLeagueClipNextSecond"
  | "aiLeagueClipUseCurrent"
  | "aiLeagueClipPreview";

function actionButton(
  container: HTMLElement,
  translationKey: string,
  datasetKey: ClipActionDatasetKey,
): HTMLButtonElement {
  const button = documentFor(container).createElement("button");
  button.type = "button";
  button.className = "ai-league-badge";
  button.dataset[datasetKey] = "";
  button.textContent = translateText(translationKey);
  return button;
}

function appendStatus(
  container: HTMLElement,
  translationKey: string,
  params?: Record<string, string | number>,
): void {
  const status = documentFor(container).createElement("span");
  status.className = "ai-league-muted";
  status.textContent = translateText(translationKey, params);
  container.append(status);
}

function documentFor(element: HTMLElement): Document {
  return element.ownerDocument;
}

async function requestLeagueClip(
  state: LeagueClipState,
  fetchImpl: typeof fetch,
): Promise<void> {
  const range = clipBucketRange(state);
  if (
    state.generationCapability !== "enabled" ||
    state.status === "preparing" ||
    range === null
  ) {
    return;
  }
  const requestedBucket = clamp(
    state.selectedBucket,
    range.minBucket,
    range.maxBucket,
  );
  const requestedTurn = representativeTurn(requestedBucket);
  clearLeagueClipPoll(state);
  state.selectionManuallySet = true;
  state.status = "preparing";
  state.ready = null;
  state.readyBucket = null;
  state.requestedBucket = requestedBucket;
  state.pending = null;
  state.preparingStartedMs = Date.now();
  notifyLeagueClipState(state);
  let response: Response;
  try {
    response = await fetchImpl(
      `/api/league-runs/${encodeURIComponent(state.runKey)}/clips`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn: requestedTurn }),
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
  if (
    status === null ||
    (state.requestedBucket !== null && status.bucket !== state.requestedBucket)
  ) {
    applyLeagueClipFailure(state, "failed");
    return;
  }
  if (status.state === "ready") {
    clearLeagueClipPoll(state);
    state.status = "ready";
    state.ready = status.ready;
    state.readyBucket = status.bucket;
    state.requestedBucket = null;
    state.pending = null;
    state.preparingStartedMs = null;
    notifyLeagueClipState(state);
    return;
  }
  if (status.state === "pending") {
    state.status = "preparing";
    state.ready = null;
    state.readyBucket = null;
    state.requestedBucket = status.bucket;
    state.pending = status.pending;
    notifyLeagueClipState(state);
    scheduleLeagueClipPoll(state);
    return;
  }
  applyLeagueClipFailure(state, "failed");
}

type ParsedLeagueClipStatus =
  | {
      state: "pending";
      bucket: number;
      pending: LeagueClipPendingView | null;
    }
  | { state: "absent"; bucket: number }
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
    const pending = parseLeagueClipPending(value.pending);
    if (
      value.pending !== undefined &&
      value.pending !== null &&
      pending === null
    ) {
      return null;
    }
    return { state: "pending", bucket, pending };
  }
  if (value.state === "absent" && value.ready === null) {
    return { state: "absent", bucket };
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

function parseLeagueClipPending(value: unknown): LeagueClipPendingView | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    (value.phase !== "queued" && value.phase !== "rendering") ||
    !Number.isSafeInteger(value.jobsAhead) ||
    Number(value.jobsAhead) < 0
  ) {
    return null;
  }
  return {
    phase: value.phase,
    jobsAhead: Number(value.jobsAhead),
  };
}

function scheduleLeagueClipPoll(state: LeagueClipState): void {
  clearLeagueClipPoll(state);
  if (state.subscribers.size === 0) return;
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    void pollLeagueClipStatus(state);
  }, LEAGUE_CLIP_POLL_MS);
}

async function pollLeagueClipStatus(state: LeagueClipState): Promise<void> {
  if (state.status !== "preparing" || state.requestedBucket === null) return;
  let response: Response;
  try {
    response = await state.fetchImpl(
      `/api/league-runs/${encodeURIComponent(state.runKey)}/clips/${state.requestedBucket}?progress=1`,
    );
  } catch {
    notifyLeagueClipState(state);
    scheduleLeagueClipPoll(state);
    return;
  }
  if (response.status === 404) {
    applyLeagueClipFailure(state, "failed");
    return;
  }
  if (!response.ok) {
    notifyLeagueClipState(state);
    scheduleLeagueClipPoll(state);
    return;
  }
  try {
    applyLeagueClipStatus(state, await response.json());
  } catch {
    notifyLeagueClipState(state);
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
  state.readyBucket = null;
  state.requestedBucket = null;
  state.pending = null;
  state.preparingStartedMs = null;
  notifyLeagueClipState(state);
}

function clearLeagueClipPoll(state: LeagueClipState): void {
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function clipBucketRange(
  state: LeagueClipState,
): { minBucket: number; maxBucket: number } | null {
  if (state.renderableThroughTurn !== null) {
    const maxBucket = Math.floor(
      (state.renderableThroughTurn - LEAGUE_CLIP_BUCKET_CENTER_OFFSET) /
        LEAGUE_CLIP_BUCKET_TURNS,
    );
    return maxBucket < LEAGUE_CLIP_MIN_BUCKET
      ? null
      : { minBucket: LEAGUE_CLIP_MIN_BUCKET, maxBucket };
  }
  const observedMaxBucket = Math.floor(
    (state.currentTick - LEAGUE_CLIP_BUCKET_CENTER_OFFSET) /
      LEAGUE_CLIP_BUCKET_TURNS,
  );
  return observedMaxBucket < LEAGUE_CLIP_MIN_BUCKET
    ? null
    : {
        minBucket: LEAGUE_CLIP_MIN_BUCKET,
        maxBucket: observedMaxBucket,
      };
}

function bucketForSelectableTurn(
  state: LeagueClipState,
  turn: number,
): number | null {
  const range = clipBucketRange(state);
  if (range === null) return null;
  return clamp(
    Math.floor(turn / LEAGUE_CLIP_BUCKET_TURNS),
    range.minBucket,
    range.maxBucket,
  );
}

function representativeTurn(bucket: number): number {
  return bucket * LEAGUE_CLIP_BUCKET_TURNS + LEAGUE_CLIP_BUCKET_CENTER_OFFSET;
}

function formatReplayTime(turn: number): string {
  const totalTenths = turn;
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
