import { translateText } from "./Utils";

export type ReplayPremierePublicState =
  | "scheduled"
  | "playing"
  | "checkpoint"
  | "revealed"
  | "failed"
  | "cancelled"
  | "archived";

export type ReplayPremiereMarkerKind =
  | "turning_point"
  | "smart"
  | "mistake"
  | "betrayal"
  | "clip_this";

export type ReplayPremiereFailureCode =
  | "integrity_failure"
  | "outage_exceeded"
  | "runtime_failure"
  | "source_ineligible"
  | "cancelled_by_operator";

export type ReplayPremierePolicyIdentityView =
  | {
      namespace: "softmax_policy_version";
      policyVersionId: string;
      policyName: string;
      serverAssignedVersion: string;
    }
  | {
      namespace: "local_manifest";
      manifestName: string;
      declaredVersion: string;
      manifestSha256: string;
      contentSha256: string;
    };

export interface ReplayPremierePolicyView {
  seatId: string;
  displayName: string;
  policyIdentity: ReplayPremierePolicyIdentityView;
}

export interface ReplayPremiereLeaderView {
  seatId: string;
  displayName: string;
  territoryPercent?: number | null;
}

export interface ReplayPremiereCheckpointOptionView {
  seatId: string;
  displayName: string;
}

export interface ReplayPremiereCheckpointDistributionView {
  seatId: string;
  percent: number;
}

export interface ReplayPremiereCheckpointView {
  id: string;
  sequence: number;
  state: "pending" | "open" | "submitted" | "closed";
  closesAt?: string | null;
  options: readonly ReplayPremiereCheckpointOptionView[];
  selectedSeatId?: string | null;
  distribution?: readonly ReplayPremiereCheckpointDistributionView[];
}

export type ReplayPremiereCheckpointPair = readonly [
  ReplayPremiereCheckpointView,
  ReplayPremiereCheckpointView,
];

export interface ReplayPremiereShareView {
  canonicalUrl: string;
  timestampUrl?: string | null;
  suggestedCaption: string;
}

export type ReplayPremiereClipStatus =
  | "idle"
  | "preparing"
  | "ready"
  | "failed"
  | "busy";

export interface ReplayPremiereClipReadyView {
  /** Same-origin attachment route for the rendered mp4. */
  downloadUrl: string;
}

export interface ReplayPremiereClipView {
  status: ReplayPremiereClipStatus;
  ready?: ReplayPremiereClipReadyView | null;
}

export interface ReplayPremiereRevealView {
  outcome: "winner" | "void";
  winnerSeatId?: string | null;
  summary?: string | null;
}

export interface ReplayPremiereRecoveryView {
  attempt: number;
  retryInMs: number;
}

export interface ReplayPremiereHighlightedMomentView {
  sequence: number;
  turn: number;
}

export interface ReplayPremiereOverlayModel {
  premiereId: string;
  state: ReplayPremierePublicState;
  title: string;
  description: string;
  sourceKind: "controlled_exhibition" | "rated_coworld";
  publicLabel: "premiere" | "spoiler_resistant_premiere";
  scheduledAt: string;
  actualStartAt?: string | null;
  authoritativeNow: string;
  playbackRate: 1 | 2 | 4;
  mapName: string;
  matchFormat: string;
  policies: readonly ReplayPremierePolicyView[];
  releasedSequence: number;
  currentTurn?: number | null;
  checkpoints: ReplayPremiereCheckpointPair;
  activeCheckpointId?: string | null;
  leaders?: readonly ReplayPremiereLeaderView[];
  headlineEvent?: string | null;
  markerPolicySeatId?: string | null;
  share?: ReplayPremiereShareView | null;
  reveal?: ReplayPremiereRevealView | null;
  recovery?: ReplayPremiereRecoveryView | null;
  highlightedMoment?: ReplayPremiereHighlightedMomentView | null;
  revealPending?: boolean;
  failureCode?: ReplayPremiereFailureCode | string | null;
  ambient: boolean;
  canPredict?: boolean;
  canMark?: boolean;
  canShare?: boolean;
  canExportCounterChallenge?: boolean;
  /** Present only on the revealed/archived surface; absent otherwise. */
  clip?: ReplayPremiereClipView | null;
  canRequestClip?: boolean;
}

export interface ReplayPremierePredictionRequest {
  premiereId: string;
  checkpointId: string;
  selectedSeatId: string;
}

export interface ReplayPremiereReminderRequest {
  premiereId: string;
  title: string;
  scheduledAt: string;
  canonicalUrl: string | null;
}

export interface ReplayPremiereAmbientChangeRequest {
  premiereId: string;
  ambient: boolean;
}

export interface ReplayPremiereMarkerRequest {
  premiereId: string;
  kind: ReplayPremiereMarkerKind;
  sequence: number;
  turn: number | null;
  policySeatId: string | null;
}

export interface ReplayPremiereShareRequest {
  premiereId: string;
  kind: "canonical" | "timestamp";
  url: string;
  sequence: number | null;
  turn: number | null;
}

export interface ReplayPremiereCaptionRequest {
  premiereId: string;
  caption: string;
  sequence: number | null;
  turn: number | null;
}

export interface ReplayPremiereCounterChallengeRequest {
  premiereId: string;
  replayUrl: string;
  sequence: number;
  turn: number | null;
  policySeatId: string | null;
  mapName: string;
  matchFormat: string;
  policies: readonly ReplayPremierePolicyView[];
}

export interface ReplayPremiereClipRequest {
  premiereId: string;
  sequence: number;
  turn: number | null;
}

export interface ReplayPremiereClipCopyRequest {
  premiereId: string;
  /** "caption" (license lines, no url) or "reply" (the watch url). */
  part: "caption" | "reply";
}

type ReplayPremiereCallbackResult = void | Promise<void>;

export interface ReplayPremiereOverlayCallbacks {
  onAddReminder?: (
    request: ReplayPremiereReminderRequest,
  ) => ReplayPremiereCallbackResult;
  onAmbientChange?: (
    request: ReplayPremiereAmbientChangeRequest,
  ) => ReplayPremiereCallbackResult;
  onPrediction?: (
    request: ReplayPremierePredictionRequest,
  ) => ReplayPremiereCallbackResult;
  onMarker?: (
    request: ReplayPremiereMarkerRequest,
  ) => ReplayPremiereCallbackResult;
  onShare?: (
    request: ReplayPremiereShareRequest,
  ) => ReplayPremiereCallbackResult;
  onCopySuggestedCaption?: (
    request: ReplayPremiereCaptionRequest,
  ) => ReplayPremiereCallbackResult;
  onExportCounterChallenge?: (
    request: ReplayPremiereCounterChallengeRequest,
  ) => ReplayPremiereCallbackResult;
  onRequestClip?: (
    request: ReplayPremiereClipRequest,
  ) => ReplayPremiereCallbackResult;
  onCopyClipText?: (
    request: ReplayPremiereClipCopyRequest,
  ) => ReplayPremiereCallbackResult;
}

export interface ReplayPremiereOverlayHandle {
  readonly element: HTMLElement;
  hydrate(model: ReplayPremiereOverlayModel): void;
  dispose(): void;
}

const OVERLAY_ID = "replay-premiere-overlay";
const AMBIENT_BODY_CLASS = "replay-premiere-ambient-mode";

const MARKERS: readonly {
  kind: ReplayPremiereMarkerKind;
  translationKey: string;
  symbol: string;
}[] = [
  {
    kind: "turning_point",
    translationKey: "replay_premiere.marker_turning_point",
    symbol: "↻",
  },
  {
    kind: "smart",
    translationKey: "replay_premiere.marker_smart",
    symbol: "✦",
  },
  {
    kind: "mistake",
    translationKey: "replay_premiere.marker_mistake",
    symbol: "!",
  },
  {
    kind: "betrayal",
    translationKey: "replay_premiere.marker_betrayal",
    symbol: "⚔",
  },
  {
    kind: "clip_this",
    translationKey: "replay_premiere.marker_clip_this",
    symbol: "◉",
  },
] as const;

const FAILURE_TRANSLATIONS: Record<ReplayPremiereFailureCode, string> = {
  integrity_failure: "replay_premiere.failure_integrity",
  outage_exceeded: "replay_premiere.failure_interrupted",
  runtime_failure: "replay_premiere.failure_runtime",
  source_ineligible: "replay_premiere.failure_source",
  cancelled_by_operator: "replay_premiere.cancelled_operator",
};

let activeOverlay: ReplayPremiereOverlayHandle | null = null;

export function mountReplayPremiereOverlay(
  initialModel: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks = {},
): ReplayPremiereOverlayHandle {
  activeOverlay?.dispose();

  const overlay = document.createElement("aside");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "complementary");
  overlay.setAttribute(
    "aria-label",
    translateText("replay_premiere.overlay_label"),
  );
  document.body.appendChild(overlay);

  let model = initialModel;
  let disposed = false;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let serverClockMs = parseTime(initialModel.authoritativeNow);
  let localClockMs = Date.now();
  let captionDraft = initialModel.share?.suggestedCaption ?? "";
  let captionTouched = false;
  let lastSuggestedCaption = captionDraft;

  const safeRun = (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => {
    if (action === undefined || button.disabled) {
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    clearActionStatus(overlay);
    Promise.resolve()
      .then(action)
      .catch(() => {
        const status = overlay.querySelector<HTMLElement>(
          "[data-premiere-action-status]",
        );
        if (status !== null) {
          status.textContent = translateText(
            "replay_premiere.action_unavailable",
          );
        }
      })
      .finally(() => {
        if (!disposed && button.isConnected) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
  };

  const updateClock = () => {
    if (disposed) {
      return;
    }
    updateCountdowns(overlay, model, authoritativeTime());
  };

  const authoritativeTime = () => {
    if (serverClockMs === null) {
      return null;
    }
    return serverClockMs + Math.max(0, Date.now() - localClockMs);
  };

  const render = () => {
    if (disposed) {
      return;
    }
    const focusKey = focusKeyFor(document.activeElement, overlay);
    overlay.dataset.state = model.state;
    overlay.dataset.ambient = String(model.ambient);
    document.body.classList.toggle(AMBIENT_BODY_CLASS, model.ambient);
    overlay.replaceChildren(
      createStyle(),
      renderOverlay(model, callbacks, safeRun, {
        captionDraft,
        setCaptionDraft(nextCaption: string) {
          captionDraft = nextCaption;
          captionTouched = true;
        },
      }),
    );
    restoreFocus(overlay, focusKey);
    updateClock();
  };

  const handle: ReplayPremiereOverlayHandle = {
    element: overlay,
    hydrate(nextModel: ReplayPremiereOverlayModel) {
      if (disposed) {
        return;
      }
      if (
        !captionTouched ||
        nextModel.share?.suggestedCaption !== lastSuggestedCaption
      ) {
        captionDraft = nextModel.share?.suggestedCaption ?? "";
        captionTouched = false;
      }
      lastSuggestedCaption = nextModel.share?.suggestedCaption ?? "";
      model = nextModel;
      serverClockMs = parseTime(nextModel.authoritativeNow);
      localClockMs = Date.now();
      render();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (clockTimer !== null) {
        clearInterval(clockTimer);
      }
      overlay.remove();
      document.body.classList.remove(AMBIENT_BODY_CLASS);
      if (activeOverlay === handle) {
        activeOverlay = null;
      }
    },
  };

  activeOverlay = handle;
  render();
  clockTimer = setInterval(updateClock, 250);
  return handle;
}

interface CaptionDraftState {
  captionDraft: string;
  setCaptionDraft(nextCaption: string): void;
}

function renderOverlay(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
  captionState: CaptionDraftState,
): HTMLElement {
  const shell = element("div", "rp-shell");
  shell.append(
    renderHeader(model, callbacks, safeRun),
    renderStateBody(model, callbacks, safeRun, captionState),
  );
  const actionStatus = element("p", "rp-action-status");
  actionStatus.dataset.premiereActionStatus = "";
  actionStatus.setAttribute("role", "status");
  actionStatus.setAttribute("aria-live", "polite");
  shell.append(actionStatus);
  return shell;
}

function renderHeader(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
): HTMLElement {
  const header = element("header", "rp-header");
  const titleGroup = element("div", "rp-title-group");
  const label = element(
    "span",
    `rp-label rp-label-${labelTone(model)}`,
    publicLabel(model),
  );
  const title = element("h2", "rp-title", safeDisplay(model.title));
  titleGroup.append(label, title);

  const ambient = button(
    model.ambient
      ? "replay_premiere.exit_ambient"
      : "replay_premiere.enter_ambient",
    "rp-ambient-toggle",
  );
  ambient.dataset.focusKey = "ambient";
  ambient.setAttribute("aria-pressed", String(model.ambient));
  ambient.addEventListener("click", () => {
    safeRun(
      ambient,
      callbacks.onAmbientChange === undefined
        ? undefined
        : () =>
            callbacks.onAmbientChange?.({
              premiereId: model.premiereId,
              ambient: !model.ambient,
            }),
    );
  });
  header.append(titleGroup, ambient);
  return header;
}

function renderStateBody(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
  captionState: CaptionDraftState,
): HTMLElement {
  const body = element("div", "rp-body");
  if (!hasExactlyTwoCheckpoints(model.checkpoints)) {
    body.append(renderSanitizedFailure("integrity_failure"));
    return body;
  }

  if (model.recovery !== null && model.recovery !== undefined) {
    body.append(renderRecovery());
  }
  if (model.revealPending === true) {
    body.append(renderRevealPending());
  }
  if (
    model.highlightedMoment !== null &&
    model.highlightedMoment !== undefined
  ) {
    body.append(renderHighlightedMoment(model));
  }

  switch (model.state) {
    case "scheduled":
      body.append(renderScheduled(model, callbacks, safeRun));
      break;
    case "playing":
      body.append(renderPlaying(model));
      body.append(renderAmbientEvidence(model));
      body.append(renderMarkers(model, callbacks, safeRun));
      body.append(renderShare(model, callbacks, safeRun, captionState));
      break;
    case "checkpoint":
      body.append(renderPlaying(model));
      body.append(renderCheckpoint(model, callbacks, safeRun));
      body.append(renderAmbientEvidence(model));
      body.append(renderMarkers(model, callbacks, safeRun));
      body.append(renderShare(model, callbacks, safeRun, captionState));
      break;
    case "revealed":
      if (!isVerifiedRevealView(model)) {
        body.append(renderSanitizedFailure("integrity_failure"));
        body.append(renderFrozenPosition(model));
        break;
      }
      body.append(renderReveal(model, model.reveal));
      body.append(renderAmbientEvidence(model));
      body.append(renderMarkers(model, callbacks, safeRun));
      body.append(renderShare(model, callbacks, safeRun, captionState));
      body.append(renderCounterChallenge(model, callbacks, safeRun));
      break;
    case "failed":
      body.append(renderSanitizedFailure(model.failureCode));
      body.append(renderFrozenPosition(model));
      break;
    case "cancelled":
      body.append(renderCancelled(model.failureCode));
      break;
    case "archived":
      body.append(renderArchive(model));
      if (!isVerifiedRevealView(model)) {
        body.append(renderSanitizedFailure("integrity_failure"));
        break;
      }
      body.append(renderShare(model, callbacks, safeRun, captionState));
      body.append(renderCounterChallenge(model, callbacks, safeRun));
      break;
    default:
      body.append(renderSanitizedFailure("integrity_failure"));
      break;
  }
  return body;
}

function renderScheduled(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
): HTMLElement {
  const section = element("section", "rp-section rp-scheduled");
  section.setAttribute("aria-labelledby", "replay-premiere-scheduled-heading");
  const heading = element(
    "h3",
    "rp-section-title",
    translateText("replay_premiere.scheduled_heading"),
  );
  heading.id = "replay-premiere-scheduled-heading";
  const countdown = element("p", "rp-countdown");
  countdown.dataset.premiereCountdown = "start";
  countdown.setAttribute("aria-live", "polite");
  const start = element(
    "p",
    "rp-start-time",
    formatDateTime(model.scheduledAt),
  );
  const description = element(
    "p",
    "rp-description",
    safeDisplay(model.description),
  );
  section.append(heading, countdown, start, description);

  const metadata = element("dl", "rp-metadata");
  appendDefinition(
    metadata,
    translateText("replay_premiere.map"),
    safeDisplay(model.mapName),
  );
  appendDefinition(
    metadata,
    translateText("replay_premiere.match_format"),
    safeDisplay(model.matchFormat),
  );
  appendDefinition(
    metadata,
    translateText("replay_premiere.premiere_rate"),
    translateText("replay_premiere.rate_value", {
      rate: model.playbackRate,
    }),
  );
  section.append(metadata, renderPolicies(model.policies));

  const actions = element("div", "rp-actions rp-secondary");
  const reminder = button(
    "replay_premiere.add_reminder",
    "rp-button rp-button-primary",
  );
  reminder.dataset.focusKey = "reminder";
  reminder.disabled = callbacks.onAddReminder === undefined;
  reminder.addEventListener("click", () => {
    safeRun(
      reminder,
      callbacks.onAddReminder === undefined
        ? undefined
        : () =>
            callbacks.onAddReminder?.({
              premiereId: model.premiereId,
              title: model.title,
              scheduledAt: model.scheduledAt,
              canonicalUrl: model.share?.canonicalUrl ?? null,
            }),
    );
  });
  actions.append(reminder);
  if (model.share !== null && model.share !== undefined) {
    const copyLink = button(
      "replay_premiere.copy_link",
      "rp-button rp-button-quiet",
    );
    copyLink.dataset.focusKey = "canonical-share";
    copyLink.disabled = callbacks.onShare === undefined;
    copyLink.addEventListener("click", () => {
      safeRun(
        copyLink,
        callbacks.onShare === undefined
          ? undefined
          : () =>
              callbacks.onShare?.({
                premiereId: model.premiereId,
                kind: "canonical",
                url: model.share?.canonicalUrl ?? "",
                sequence: null,
                turn: null,
              }),
      );
    });
    actions.append(copyLink);
  }
  section.append(actions);
  return section;
}

function renderPolicies(
  policies: readonly ReplayPremierePolicyView[],
): HTMLElement {
  const section = element("section", "rp-participants rp-secondary");
  const heading = element(
    "h4",
    "rp-subheading",
    translateText("replay_premiere.participants"),
  );
  const list = element("ul", "rp-policy-list");
  for (const policy of policies) {
    const item = element("li", "rp-policy");
    const name = element(
      "span",
      "rp-policy-name",
      safeDisplay(policy.displayName),
    );
    const version = element(
      "span",
      "rp-policy-version",
      translateText("replay_premiere.policy_version", {
        version: policyVersion(policy),
      }),
    );
    const kind = element(
      "span",
      "rp-policy-kind",
      translateText(
        policy.policyIdentity.namespace === "softmax_policy_version"
          ? "replay_premiere.identity_softmax"
          : "replay_premiere.identity_local",
      ),
    );
    const identityName = element(
      "span",
      "rp-policy-reference",
      policy.policyIdentity.namespace === "softmax_policy_version"
        ? translateText("replay_premiere.softmax_policy_name", {
            name: safeDisplay(policy.policyIdentity.policyName),
          })
        : translateText("replay_premiere.manifest_name", {
            name: safeDisplay(policy.policyIdentity.manifestName),
          }),
    );
    item.append(name, version, kind, identityName);
    if (policy.policyIdentity.namespace === "softmax_policy_version") {
      item.append(
        element(
          "span",
          "rp-policy-reference",
          translateText("replay_premiere.policy_version_id", {
            id: safeDisplay(policy.policyIdentity.policyVersionId),
          }),
        ),
      );
    } else {
      item.append(
        element(
          "span",
          "rp-policy-reference",
          translateText("replay_premiere.manifest_sha", {
            hash: safeDisplay(policy.policyIdentity.manifestSha256),
          }),
        ),
        element(
          "span",
          "rp-policy-reference",
          translateText("replay_premiere.content_sha", {
            hash: safeDisplay(policy.policyIdentity.contentSha256),
          }),
        ),
      );
    }
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function renderPlaying(model: ReplayPremiereOverlayModel): HTMLElement {
  const section = element("section", "rp-section rp-playing-status");
  const liveRow = element("div", "rp-live-row");
  const live = element(
    "span",
    "rp-live-badge",
    translateText("replay_premiere.shared_playback"),
  );
  const rate = element(
    "span",
    "rp-rate",
    translateText("replay_premiere.rate_value", {
      rate: model.playbackRate,
    }),
  );
  liveRow.append(live, rate);
  const status = element(
    "p",
    "rp-shared-status",
    translateText("replay_premiere.shared_status"),
  );
  const position = element(
    "p",
    "rp-position",
    positionLabel(model.currentTurn, model.releasedSequence),
  );
  section.append(liveRow, status, position, renderCheckpointProgress(model));
  return section;
}

function renderCheckpointProgress(
  model: ReplayPremiereOverlayModel,
): HTMLElement {
  const list = element("ol", "rp-checkpoint-progress");
  list.setAttribute(
    "aria-label",
    translateText("replay_premiere.prediction_progress"),
  );
  model.checkpoints.forEach((checkpoint, index) => {
    const item = element("li", "rp-checkpoint-step");
    item.dataset.state = checkpoint.state;
    item.textContent = translateText("replay_premiere.checkpoint_number", {
      number: index + 1,
    });
    list.append(item);
  });
  return list;
}

function renderCheckpoint(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
): HTMLElement {
  const checkpoint = model.checkpoints.find(
    (entry) => entry.id === model.activeCheckpointId,
  );
  if (checkpoint === undefined) {
    return renderSanitizedFailure("integrity_failure");
  }
  const section = element("section", "rp-section rp-checkpoint");
  section.setAttribute("role", "region");
  section.setAttribute("aria-labelledby", "replay-premiere-question");
  const eyebrow = element(
    "p",
    "rp-eyebrow",
    translateText("replay_premiere.checkpoint_intermission"),
  );
  const question = element(
    "h3",
    "rp-question",
    translateText("replay_premiere.who_will_win"),
  );
  question.id = "replay-premiere-question";
  const timer = element("p", "rp-checkpoint-timer");
  timer.dataset.premiereCountdown = "checkpoint";
  timer.dataset.checkpointId = checkpoint.id;
  timer.setAttribute("aria-live", "polite");
  section.append(eyebrow, question, timer);

  if (checkpoint.options.length === 0) {
    section.append(
      element(
        "p",
        "rp-muted",
        translateText("replay_premiere.prediction_unavailable"),
      ),
    );
    return section;
  }

  const hasSelection =
    checkpoint.selectedSeatId !== null &&
    checkpoint.selectedSeatId !== undefined;
  const isOpen = checkpoint.state === "open" && !hasSelection;
  const options = element("div", "rp-prediction-options");
  options.setAttribute("role", "group");
  options.setAttribute(
    "aria-label",
    translateText("replay_premiere.prediction_options"),
  );
  for (const option of checkpoint.options) {
    const optionButton = element(
      "button",
      "rp-prediction-button",
    ) as HTMLButtonElement;
    optionButton.type = "button";
    optionButton.textContent = safeDisplay(option.displayName);
    optionButton.dataset.focusKey = `prediction-${option.seatId}`;
    optionButton.dataset.selected = String(
      checkpoint.selectedSeatId === option.seatId,
    );
    optionButton.disabled =
      !isOpen ||
      model.canPredict === false ||
      callbacks.onPrediction === undefined;
    optionButton.addEventListener("click", () => {
      safeRun(
        optionButton,
        callbacks.onPrediction === undefined
          ? undefined
          : () =>
              callbacks.onPrediction?.({
                premiereId: model.premiereId,
                checkpointId: checkpoint.id,
                selectedSeatId: option.seatId,
              }),
      );
    });
    options.append(optionButton);
  }
  section.append(options);

  if (hasSelection) {
    section.append(
      element(
        "p",
        "rp-locked",
        translateText("replay_premiere.prediction_locked"),
      ),
    );
  }
  if (
    (hasSelection || checkpoint.state === "closed") &&
    checkpoint.distribution
  ) {
    section.append(renderDistribution(checkpoint));
  }
  return section;
}

function renderDistribution(
  checkpoint: ReplayPremiereCheckpointView,
): HTMLElement {
  const section = element("section", "rp-distribution");
  const heading = element(
    "h4",
    "rp-subheading",
    translateText("replay_premiere.crowd_prediction"),
  );
  const list = element("ul", "rp-distribution-list");
  for (const row of checkpoint.distribution ?? []) {
    const option = checkpoint.options.find(
      (entry) => entry.seatId === row.seatId,
    );
    if (option === undefined) {
      continue;
    }
    const item = element("li", "rp-distribution-row");
    item.append(
      element("span", "", safeDisplay(option.displayName)),
      element(
        "span",
        "",
        translateText("replay_premiere.percent", {
          percent: boundedPercent(row.percent),
        }),
      ),
    );
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function renderAmbientEvidence(model: ReplayPremiereOverlayModel): HTMLElement {
  const section = element("section", "rp-ambient-evidence");
  const leaders = element("div", "rp-leaders");
  leaders.append(
    element(
      "h3",
      "rp-subheading",
      translateText("replay_premiere.current_leaders"),
    ),
  );
  const leaderList = element("ol", "rp-leader-list");
  for (const leader of (model.leaders ?? []).slice(0, 3)) {
    const item = element("li", "rp-leader");
    const name = element("span", "", safeDisplay(leader.displayName));
    item.append(name);
    if (
      leader.territoryPercent !== null &&
      leader.territoryPercent !== undefined
    ) {
      item.append(
        element(
          "span",
          "rp-leader-share",
          translateText("replay_premiere.percent", {
            percent: boundedPercent(leader.territoryPercent),
          }),
        ),
      );
    }
    leaderList.append(item);
  }
  if (leaderList.childElementCount === 0) {
    leaderList.append(
      element(
        "li",
        "rp-muted",
        translateText("replay_premiere.leaders_waiting"),
      ),
    );
  }
  leaders.append(leaderList);

  const headline = element("div", "rp-headline");
  headline.append(
    element(
      "h3",
      "rp-subheading",
      translateText("replay_premiere.headline_event"),
    ),
    element(
      "p",
      "",
      model.headlineEvent
        ? safeDisplay(model.headlineEvent)
        : translateText("replay_premiere.headline_waiting"),
    ),
  );
  section.append(leaders, headline);
  return section;
}

function renderMarkers(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
): HTMLElement {
  const section = element("section", "rp-section rp-markers");
  const heading = element(
    "h3",
    "rp-subheading rp-marker-heading",
    translateText("replay_premiere.mark_moment"),
  );
  const list = element("div", "rp-marker-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", heading.textContent ?? "");
  const markerEnabled =
    model.canMark !== false &&
    model.releasedSequence >= 0 &&
    (model.state === "playing" ||
      model.state === "checkpoint" ||
      model.state === "revealed") &&
    callbacks.onMarker !== undefined;
  for (const marker of MARKERS) {
    const markerButton = element(
      "button",
      "rp-marker-button",
    ) as HTMLButtonElement;
    markerButton.type = "button";
    markerButton.dataset.kind = marker.kind;
    markerButton.dataset.focusKey = `marker-${marker.kind}`;
    markerButton.disabled = !markerEnabled;
    markerButton.setAttribute(
      "aria-label",
      translateText(marker.translationKey),
    );
    const symbol = element("span", "rp-marker-symbol", marker.symbol);
    symbol.setAttribute("aria-hidden", "true");
    const label = element(
      "span",
      "rp-marker-label",
      translateText(marker.translationKey),
    );
    markerButton.append(symbol, label);
    markerButton.addEventListener("click", () => {
      safeRun(
        markerButton,
        callbacks.onMarker === undefined
          ? undefined
          : () =>
              callbacks.onMarker?.({
                premiereId: model.premiereId,
                kind: marker.kind,
                sequence: model.releasedSequence,
                turn: finiteIntegerOrNull(model.currentTurn),
                policySeatId: model.markerPolicySeatId ?? null,
              }),
      );
    });
    list.append(markerButton);
  }
  section.append(heading, list);
  return section;
}

function renderShare(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
  captionState: CaptionDraftState,
): HTMLElement {
  const section = element("section", "rp-section rp-share rp-secondary");
  if (model.share === null || model.share === undefined) {
    section.hidden = true;
    return section;
  }
  const heading = element(
    "h3",
    "rp-subheading",
    translateText("replay_premiere.share_moment"),
  );
  const timestamp = button(
    "replay_premiere.copy_timestamp",
    "rp-button rp-button-primary rp-timestamp-share",
  );
  timestamp.dataset.focusKey = "timestamp-share";
  const timestampUrl = model.share.timestampUrl;
  timestamp.disabled = callbacks.onShare === undefined || !timestampUrl;
  if (model.canShare === false) {
    timestamp.disabled = true;
  }
  timestamp.addEventListener("click", () => {
    safeRun(
      timestamp,
      callbacks.onShare === undefined || !timestampUrl
        ? undefined
        : () =>
            callbacks.onShare?.({
              premiereId: model.premiereId,
              kind: "timestamp",
              url: timestampUrl,
              sequence: model.releasedSequence,
              turn: finiteIntegerOrNull(model.currentTurn),
            }),
    );
  });
  const captionLabel = element(
    "label",
    "rp-caption-label",
    translateText("replay_premiere.suggested_caption"),
  ) as HTMLLabelElement;
  captionLabel.htmlFor = "replay-premiere-caption";
  const caption = element("textarea", "rp-caption") as HTMLTextAreaElement;
  caption.id = "replay-premiere-caption";
  caption.rows = 2;
  caption.maxLength = 500;
  caption.value = captionState.captionDraft;
  caption.dataset.focusKey = "caption";
  caption.addEventListener("input", () =>
    captionState.setCaptionDraft(caption.value),
  );
  const copyCaption = button(
    "replay_premiere.copy_caption",
    "rp-button rp-button-quiet",
  );
  copyCaption.dataset.focusKey = "caption-copy";
  copyCaption.disabled = callbacks.onCopySuggestedCaption === undefined;
  copyCaption.addEventListener("click", () => {
    safeRun(
      copyCaption,
      callbacks.onCopySuggestedCaption === undefined
        ? undefined
        : () =>
            callbacks.onCopySuggestedCaption?.({
              premiereId: model.premiereId,
              caption: caption.value,
              sequence: model.releasedSequence,
              turn: finiteIntegerOrNull(model.currentTurn),
            }),
    );
  });
  section.append(heading, timestamp, captionLabel, caption, copyCaption);
  // The clip block lives in the revealed/archived share section only. It is
  // never constructed on the scheduled/playing/checkpoint surface, so the
  // download button and social-copy controls are absent from the DOM before
  // reveal.
  if (model.state === "revealed" || model.state === "archived") {
    const clip = renderClip(model, callbacks, safeRun);
    if (clip !== null) {
      section.append(clip);
    }
  }
  return section;
}

function renderClip(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
): HTMLElement | null {
  const clip = model.clip;
  if (clip === null || clip === undefined) {
    return null;
  }
  const wrapper = element("div", "rp-clip");
  wrapper.append(
    element(
      "h4",
      "rp-subheading rp-clip-heading",
      translateText("replay_premiere.clip_heading"),
    ),
  );
  const anchorTurn = finiteIntegerOrNull(model.currentTurn);
  const request = button(
    "replay_premiere.clip_download_button",
    "rp-button rp-button-primary rp-clip-request",
  );
  request.dataset.focusKey = "clip-request";
  const canRequest =
    callbacks.onRequestClip !== undefined &&
    model.canRequestClip === true &&
    anchorTurn !== null;
  request.disabled = !canRequest;
  request.addEventListener("click", () => {
    safeRun(
      request,
      !canRequest || callbacks.onRequestClip === undefined
        ? undefined
        : () =>
            callbacks.onRequestClip?.({
              premiereId: model.premiereId,
              sequence: model.releasedSequence,
              turn: anchorTurn,
            }),
    );
  });
  wrapper.append(request);

  const statusKey = clipStatusText(clip.status);
  if (statusKey !== null) {
    const status = element("p", "rp-clip-status", translateText(statusKey));
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.clipStatus = clip.status;
    wrapper.append(status);
  }

  if (clip.ready !== null && clip.ready !== undefined) {
    const download = element(
      "a",
      "rp-button rp-button-quiet rp-clip-download",
    ) as HTMLAnchorElement;
    download.textContent = translateText("replay_premiere.clip_download_file");
    download.href = clip.ready.downloadUrl;
    download.setAttribute("download", "");
    download.rel = "noopener";
    download.dataset.focusKey = "clip-download";
    const copyCaption = button(
      "replay_premiere.clip_copy_caption",
      "rp-button rp-button-quiet rp-clip-copy-caption",
    );
    copyCaption.dataset.focusKey = "clip-copy-caption";
    copyCaption.disabled = callbacks.onCopyClipText === undefined;
    copyCaption.addEventListener("click", () => {
      safeRun(
        copyCaption,
        callbacks.onCopyClipText === undefined
          ? undefined
          : () =>
              callbacks.onCopyClipText?.({
                premiereId: model.premiereId,
                part: "caption",
              }),
      );
    });
    const copyReply = button(
      "replay_premiere.clip_copy_reply",
      "rp-button rp-button-quiet rp-clip-copy-reply",
    );
    copyReply.dataset.focusKey = "clip-copy-reply";
    copyReply.disabled = callbacks.onCopyClipText === undefined;
    copyReply.addEventListener("click", () => {
      safeRun(
        copyReply,
        callbacks.onCopyClipText === undefined
          ? undefined
          : () =>
              callbacks.onCopyClipText?.({
                premiereId: model.premiereId,
                part: "reply",
              }),
      );
    });
    wrapper.append(download, copyCaption, copyReply);
  }
  return wrapper;
}

function clipStatusText(status: ReplayPremiereClipStatus): string | null {
  switch (status) {
    case "preparing":
      return "replay_premiere.clip_preparing";
    case "ready":
      return "replay_premiere.clip_ready";
    case "failed":
      return "replay_premiere.clip_failed";
    case "busy":
      return "replay_premiere.clip_busy";
    case "idle":
      return null;
  }
}

function renderReveal(
  model: ReplayPremiereOverlayModel,
  reveal: ReplayPremiereRevealView,
): HTMLElement {
  const section = element("section", "rp-section rp-reveal");
  section.setAttribute("aria-live", "polite");
  const heading = element(
    "h3",
    "rp-section-title",
    translateText("replay_premiere.reveal_heading"),
  );
  section.append(heading);
  if (reveal.outcome === "winner") {
    const winner = model.policies.find(
      (policy) => policy.seatId === reveal.winnerSeatId,
    );
    section.append(
      element(
        "p",
        "rp-winner",
        winner === undefined
          ? translateText("replay_premiere.winner_unavailable")
          : translateText("replay_premiere.winner", {
              name: safeDisplay(winner.displayName),
            }),
      ),
    );
  } else {
    section.append(
      element("p", "rp-winner", translateText("replay_premiere.result_void")),
    );
  }
  if (reveal.summary) {
    section.append(
      element("p", "rp-reveal-summary", safeDisplay(reveal.summary)),
    );
  }
  return section;
}

function renderSanitizedFailure(
  code: ReplayPremiereFailureCode | string | null | undefined,
): HTMLElement {
  const safeCode = isFailureCode(code) ? code : null;
  const section = element("section", "rp-section rp-failure");
  section.setAttribute("role", "alert");
  section.append(
    element(
      "h3",
      "rp-section-title",
      translateText("replay_premiere.failure_heading"),
    ),
    element(
      "p",
      "",
      translateText(
        safeCode === null
          ? "replay_premiere.failure_generic"
          : FAILURE_TRANSLATIONS[safeCode],
      ),
    ),
  );
  return section;
}

function renderRecovery(): HTMLElement {
  const status = element(
    "section",
    "rp-runtime-status rp-recovery",
    translateText("replay_premiere.recovering"),
  );
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  return status;
}

function renderRevealPending(): HTMLElement {
  const status = element(
    "section",
    "rp-runtime-status rp-reveal-pending",
    translateText("replay_premiere.verifying_reveal"),
  );
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  return status;
}

function renderHighlightedMoment(
  model: ReplayPremiereOverlayModel,
): HTMLElement {
  const moment = model.highlightedMoment;
  const status = element(
    "section",
    "rp-runtime-status rp-highlighted-moment",
    moment === null || moment === undefined
      ? ""
      : translateText(
          model.state === "revealed" || model.state === "archived"
            ? "replay_premiere.shared_moment_opened"
            : "replay_premiere.shared_moment_highlighted",
          { turn: moment.turn },
        ),
  );
  status.setAttribute("role", "status");
  return status;
}

function renderFrozenPosition(model: ReplayPremiereOverlayModel): HTMLElement {
  return element(
    "p",
    "rp-frozen-position",
    translateText("replay_premiere.frozen_position", {
      sequence: Math.max(0, Math.floor(model.releasedSequence)),
    }),
  );
}

function renderCancelled(
  code: ReplayPremiereFailureCode | string | null | undefined,
): HTMLElement {
  const section = element("section", "rp-section rp-cancelled");
  section.setAttribute("role", "status");
  section.append(
    element(
      "h3",
      "rp-section-title",
      translateText("replay_premiere.cancelled_heading"),
    ),
    element(
      "p",
      "",
      translateText(
        code === "cancelled_by_operator"
          ? "replay_premiere.cancelled_operator"
          : "replay_premiere.cancelled_generic",
      ),
    ),
  );
  return section;
}

function renderArchive(model: ReplayPremiereOverlayModel): HTMLElement {
  const wrapper = element("div", "rp-archive");
  const section = element("section", "rp-section");
  section.append(
    element(
      "h3",
      "rp-section-title",
      translateText("replay_premiere.archived_heading"),
    ),
    element("p", "", translateText("replay_premiere.archived_description")),
  );
  wrapper.append(section);
  if (isVerifiedRevealView(model)) {
    wrapper.append(renderReveal(model, model.reveal));
  }
  return wrapper;
}

function isVerifiedRevealView(
  model: ReplayPremiereOverlayModel,
): model is ReplayPremiereOverlayModel & {
  reveal: ReplayPremiereRevealView;
} {
  const reveal = model.reveal;
  if (
    reveal === null ||
    reveal === undefined ||
    (reveal.summary !== null &&
      reveal.summary !== undefined &&
      typeof reveal.summary !== "string")
  ) {
    return false;
  }
  if (reveal.outcome === "void") {
    return reveal.winnerSeatId === null || reveal.winnerSeatId === undefined;
  }
  return (
    reveal.outcome === "winner" &&
    typeof reveal.winnerSeatId === "string" &&
    model.policies.some((policy) => policy.seatId === reveal.winnerSeatId)
  );
}

function renderCounterChallenge(
  model: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks,
  safeRun: (
    button: HTMLButtonElement,
    action: (() => ReplayPremiereCallbackResult) | undefined,
  ) => void,
): HTMLElement {
  const section = element("section", "rp-counter rp-secondary");
  if (
    !model.canExportCounterChallenge ||
    !isVerifiedRevealView(model) ||
    model.share === null ||
    model.share === undefined ||
    (model.state !== "revealed" && model.state !== "archived")
  ) {
    section.hidden = true;
    return section;
  }
  const exportButton = button(
    "replay_premiere.copy_counter_challenge",
    "rp-button rp-button-quiet",
  );
  exportButton.dataset.focusKey = "counter-challenge";
  exportButton.disabled = callbacks.onExportCounterChallenge === undefined;
  exportButton.addEventListener("click", () => {
    safeRun(
      exportButton,
      callbacks.onExportCounterChallenge === undefined
        ? undefined
        : () =>
            callbacks.onExportCounterChallenge?.({
              premiereId: model.premiereId,
              replayUrl: model.share?.canonicalUrl ?? "",
              sequence: model.releasedSequence,
              turn: finiteIntegerOrNull(model.currentTurn),
              policySeatId: model.markerPolicySeatId ?? null,
              mapName: model.mapName,
              matchFormat: model.matchFormat,
              policies: model.policies,
            }),
    );
  });
  section.append(
    element(
      "p",
      "rp-counter-copy",
      translateText("replay_premiere.counter_challenge_description"),
    ),
    exportButton,
  );
  return section;
}

function updateCountdowns(
  overlay: HTMLElement,
  model: ReplayPremiereOverlayModel,
  nowMs: number | null,
): void {
  const startCountdown = overlay.querySelector<HTMLElement>(
    '[data-premiere-countdown="start"]',
  );
  if (startCountdown !== null) {
    const scheduledMs = parseTime(model.scheduledAt);
    if (nowMs === null || scheduledMs === null) {
      startCountdown.textContent = translateText(
        "replay_premiere.timing_unavailable",
      );
    } else if (scheduledMs <= nowMs) {
      startCountdown.textContent = translateText(
        "replay_premiere.starting_when_ready",
      );
    } else {
      startCountdown.textContent = translateText("replay_premiere.starts_in", {
        time: formatDuration(scheduledMs - nowMs),
      });
    }
  }

  const checkpointCountdown = overlay.querySelector<HTMLElement>(
    '[data-premiere-countdown="checkpoint"]',
  );
  if (checkpointCountdown !== null) {
    const checkpoint = model.checkpoints.find(
      (entry) => entry.id === checkpointCountdown.dataset.checkpointId,
    );
    const closeMs = parseTime(checkpoint?.closesAt);
    if (nowMs === null || closeMs === null) {
      checkpointCountdown.textContent = translateText(
        "replay_premiere.checkpoint_duration",
      );
    } else {
      checkpointCountdown.textContent = translateText(
        "replay_premiere.resumes_in",
        { time: formatDuration(Math.max(0, closeMs - nowMs)) },
      );
    }
  }
}

function createStyle(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  return style;
}

function publicLabel(model: ReplayPremiereOverlayModel): string {
  if (model.publicLabel === "spoiler_resistant_premiere") {
    return translateText("replay_premiere.label_spoiler_resistant");
  }
  if (model.sourceKind === "controlled_exhibition") {
    return translateText("replay_premiere.label_controlled");
  }
  return translateText("replay_premiere.label_premiere");
}

function labelTone(model: ReplayPremiereOverlayModel): string {
  if (model.publicLabel === "spoiler_resistant_premiere") {
    return "caution";
  }
  return model.sourceKind === "controlled_exhibition" ? "controlled" : "rated";
}

function positionLabel(
  turn: number | null | undefined,
  sequence: number,
): string {
  const safeTurn = finiteIntegerOrNull(turn);
  const safeSequence = Math.max(
    0,
    Math.floor(Number.isFinite(sequence) ? sequence : 0),
  );
  return safeTurn === null
    ? translateText("replay_premiere.sequence_position", {
        sequence: safeSequence,
      })
    : translateText("replay_premiere.turn_sequence_position", {
        turn: safeTurn,
        sequence: safeSequence,
      });
}

function policyVersion(policy: ReplayPremierePolicyView): string {
  return safeDisplay(
    policy.policyIdentity.namespace === "softmax_policy_version"
      ? policy.policyIdentity.serverAssignedVersion
      : policy.policyIdentity.declaredVersion,
  );
}

function appendDefinition(
  list: HTMLDListElement,
  term: string,
  value: string,
): void {
  list.append(element("dt", "", term), element("dd", "", value));
}

function button(translationKey: string, className: string): HTMLButtonElement {
  const result = element("button", className) as HTMLButtonElement;
  result.type = "button";
  result.textContent = translateText(translationKey);
  return result;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className !== "") {
    result.className = className;
  }
  if (text !== undefined) {
    result.textContent = text;
  }
  return result;
}

function parseTime(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTime(value: string): string {
  const parsed = parseTime(value);
  if (parsed === null) {
    return translateText("replay_premiere.timing_unavailable");
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(parsed));
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.ceil(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function finiteIntegerOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function boundedPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.min(100, Math.max(0, value)));
}

function safeDisplay(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasExactlyTwoCheckpoints(
  checkpoints: readonly ReplayPremiereCheckpointView[],
): checkpoints is ReplayPremiereCheckpointPair {
  return checkpoints.length === 2;
}

function isFailureCode(
  value: string | null | undefined,
): value is ReplayPremiereFailureCode {
  return (
    value !== null &&
    value !== undefined &&
    Object.prototype.hasOwnProperty.call(FAILURE_TRANSLATIONS, value)
  );
}

function clearActionStatus(overlay: HTMLElement): void {
  const status = overlay.querySelector<HTMLElement>(
    "[data-premiere-action-status]",
  );
  if (status !== null) {
    status.textContent = "";
  }
}

function focusKeyFor(
  active: Element | null,
  overlay: HTMLElement,
): string | null {
  if (!(active instanceof HTMLElement) || !overlay.contains(active)) {
    return null;
  }
  return active.dataset.focusKey ?? null;
}

function restoreFocus(overlay: HTMLElement, focusKey: string | null): void {
  if (focusKey === null) {
    return;
  }
  for (const candidate of overlay.querySelectorAll<HTMLElement>(
    "[data-focus-key]",
  )) {
    if (candidate.dataset.focusKey === focusKey) {
      candidate.focus({ preventScroll: true });
      return;
    }
  }
}

const OVERLAY_CSS = `
  #${OVERLAY_ID} {
    position: fixed;
    z-index: 51000;
    top: 12px;
    right: 12px;
    width: min(370px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid rgba(148, 163, 184, 0.34);
    border-radius: 16px;
    background: rgba(9, 14, 26, 0.94);
    color: #f8fafc;
    box-shadow: 0 24px 72px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(16px);
    font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums;
  }
  #${OVERLAY_ID} * { box-sizing: border-box; }
  #${OVERLAY_ID} [hidden] { display: none !important; }
  #${OVERLAY_ID} button,
  #${OVERLAY_ID} textarea { font: inherit; }
  #${OVERLAY_ID} button:focus-visible,
  #${OVERLAY_ID} textarea:focus-visible {
    outline: 3px solid #38bdf8;
    outline-offset: 2px;
  }
  #${OVERLAY_ID} button:disabled { cursor: not-allowed; opacity: 0.48; }
  #${OVERLAY_ID} .rp-shell { display: grid; }
  #${OVERLAY_ID} .rp-header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 14px 14px 12px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(9, 14, 26, 0.97);
  }
  #${OVERLAY_ID} .rp-title-group { min-width: 0; }
  #${OVERLAY_ID} .rp-title {
    margin: 5px 0 0;
    overflow-wrap: anywhere;
    font-size: 17px;
    line-height: 1.2;
  }
  #${OVERLAY_ID} .rp-label {
    display: inline-flex;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.16);
    color: #bae6fd;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} .rp-label-caution { background: rgba(251, 191, 36, 0.16); color: #fde68a; }
  #${OVERLAY_ID} .rp-label-controlled { background: rgba(167, 139, 250, 0.16); color: #ddd6fe; }
  #${OVERLAY_ID} .rp-ambient-toggle {
    flex: 0 0 auto;
    min-height: 36px;
    padding: 7px 10px;
    border: 1px solid rgba(148, 163, 184, 0.34);
    border-radius: 9px;
    background: rgba(30, 41, 59, 0.82);
    color: #f8fafc;
    cursor: pointer;
  }
  #${OVERLAY_ID} .rp-body { display: grid; gap: 10px; padding: 12px; }
  #${OVERLAY_ID} .rp-section,
  #${OVERLAY_ID} .rp-ambient-evidence {
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 12px;
    background: rgba(15, 23, 42, 0.78);
    padding: 12px;
  }
  #${OVERLAY_ID} .rp-runtime-status {
    border: 1px solid rgba(56, 189, 248, 0.36);
    border-radius: 9px;
    background: rgba(12, 74, 110, 0.38);
    color: #bae6fd;
    padding: 8px 10px;
    font-size: 12px;
  }
  #${OVERLAY_ID} .rp-recovery { border-color: rgba(251, 191, 36, 0.42); background: rgba(120, 53, 15, 0.34); color: #fde68a; }
  #${OVERLAY_ID} .rp-section-title,
  #${OVERLAY_ID} .rp-subheading,
  #${OVERLAY_ID} .rp-question { margin: 0; }
  #${OVERLAY_ID} .rp-section-title { font-size: 16px; }
  #${OVERLAY_ID} .rp-subheading {
    color: #cbd5e1;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} p { margin: 6px 0 0; }
  #${OVERLAY_ID} .rp-description,
  #${OVERLAY_ID} .rp-muted,
  #${OVERLAY_ID} .rp-start-time,
  #${OVERLAY_ID} .rp-shared-status { color: #cbd5e1; }
  #${OVERLAY_ID} .rp-countdown { color: #7dd3fc; font-size: 26px; font-weight: 850; }
  #${OVERLAY_ID} .rp-metadata {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 5px 12px;
    margin: 12px 0 0;
  }
  #${OVERLAY_ID} .rp-metadata dt { color: #94a3b8; }
  #${OVERLAY_ID} .rp-metadata dd { margin: 0; overflow-wrap: anywhere; text-align: right; }
  #${OVERLAY_ID} .rp-participants { margin-top: 12px; }
  #${OVERLAY_ID} .rp-policy-list,
  #${OVERLAY_ID} .rp-leader-list,
  #${OVERLAY_ID} .rp-distribution-list {
    display: grid;
    gap: 6px;
    margin: 7px 0 0;
    padding: 0;
    list-style: none;
  }
  #${OVERLAY_ID} .rp-policy {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 1px 8px;
    padding: 7px 8px;
    border-radius: 8px;
    background: rgba(30, 41, 59, 0.74);
  }
  #${OVERLAY_ID} .rp-policy-name { min-width: 0; overflow-wrap: anywhere; font-weight: 750; }
  #${OVERLAY_ID} .rp-policy-version { color: #bae6fd; }
  #${OVERLAY_ID} .rp-policy-kind { grid-column: 1 / -1; color: #94a3b8; font-size: 11px; }
  #${OVERLAY_ID} .rp-policy-reference { grid-column: 1 / -1; color: #94a3b8; overflow-wrap: anywhere; font-size: 10px; }
  #${OVERLAY_ID} .rp-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  #${OVERLAY_ID} .rp-button {
    min-height: 38px;
    padding: 8px 11px;
    border: 1px solid transparent;
    border-radius: 9px;
    cursor: pointer;
    font-weight: 750;
  }
  #${OVERLAY_ID} .rp-button-primary { background: #0ea5e9; color: #03131e; }
  #${OVERLAY_ID} .rp-button-quiet {
    border-color: rgba(148, 163, 184, 0.34);
    background: rgba(30, 41, 59, 0.82);
    color: #f8fafc;
  }
  #${OVERLAY_ID} .rp-live-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  #${OVERLAY_ID} .rp-live-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #86efac;
    font-weight: 850;
  }
  #${OVERLAY_ID} .rp-live-badge::before {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #22c55e;
    content: "";
  }
  #${OVERLAY_ID} .rp-rate { color: #bae6fd; font-weight: 750; }
  #${OVERLAY_ID} .rp-position { font-weight: 750; }
  #${OVERLAY_ID} .rp-checkpoint-progress {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
  }
  #${OVERLAY_ID} .rp-checkpoint-step {
    padding: 4px 6px;
    border-radius: 7px;
    background: rgba(51, 65, 85, 0.76);
    color: #94a3b8;
    text-align: center;
    font-size: 11px;
  }
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="open"] { background: rgba(14, 165, 233, 0.2); color: #bae6fd; }
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="submitted"],
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="closed"] { background: rgba(34, 197, 94, 0.15); color: #bbf7d0; }
  #${OVERLAY_ID} .rp-checkpoint {
    border-color: rgba(56, 189, 248, 0.62);
    background: linear-gradient(145deg, rgba(12, 74, 110, 0.84), rgba(15, 23, 42, 0.94));
  }
  #${OVERLAY_ID} .rp-eyebrow { color: #7dd3fc; font-size: 11px; font-weight: 850; letter-spacing: 0.08em; text-transform: uppercase; }
  #${OVERLAY_ID} .rp-question { margin-top: 5px; font-size: 19px; }
  #${OVERLAY_ID} .rp-checkpoint-timer { color: #e0f2fe; font-size: 24px; font-weight: 850; }
  #${OVERLAY_ID} .rp-prediction-options { display: grid; gap: 7px; margin-top: 10px; }
  #${OVERLAY_ID} .rp-prediction-button {
    min-height: 40px;
    padding: 8px 10px;
    overflow-wrap: anywhere;
    border: 1px solid rgba(125, 211, 252, 0.46);
    border-radius: 9px;
    background: rgba(8, 47, 73, 0.68);
    color: #f0f9ff;
    cursor: pointer;
    text-align: left;
    font-weight: 750;
  }
  #${OVERLAY_ID} .rp-prediction-button[data-selected="true"] { border-color: #86efac; background: rgba(20, 83, 45, 0.76); }
  #${OVERLAY_ID} .rp-locked { color: #bbf7d0; font-weight: 750; }
  #${OVERLAY_ID} .rp-distribution { margin-top: 12px; }
  #${OVERLAY_ID} .rp-distribution-row,
  #${OVERLAY_ID} .rp-leader { display: flex; justify-content: space-between; gap: 10px; }
  #${OVERLAY_ID} .rp-ambient-evidence { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  #${OVERLAY_ID} .rp-headline { min-width: 0; }
  #${OVERLAY_ID} .rp-headline p { overflow-wrap: anywhere; }
  #${OVERLAY_ID} .rp-leader-share { color: #7dd3fc; }
  #${OVERLAY_ID} .rp-marker-list { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin-top: 8px; }
  #${OVERLAY_ID} .rp-marker-button {
    min-width: 0;
    min-height: 52px;
    padding: 5px 2px;
    border: 1px solid rgba(148, 163, 184, 0.3);
    border-radius: 8px;
    background: rgba(30, 41, 59, 0.82);
    color: #f8fafc;
    cursor: pointer;
  }
  #${OVERLAY_ID} .rp-marker-symbol { display: block; color: #7dd3fc; font-size: 18px; font-weight: 850; }
  #${OVERLAY_ID} .rp-marker-label { display: block; margin-top: 2px; overflow-wrap: anywhere; font-size: 9px; line-height: 1.1; }
  #${OVERLAY_ID} .rp-share { display: grid; gap: 8px; }
  #${OVERLAY_ID} .rp-caption-label { color: #cbd5e1; font-size: 12px; font-weight: 750; }
  #${OVERLAY_ID} .rp-caption {
    width: 100%;
    min-height: 56px;
    resize: vertical;
    padding: 8px;
    border: 1px solid rgba(148, 163, 184, 0.34);
    border-radius: 8px;
    background: rgba(2, 6, 23, 0.72);
    color: #f8fafc;
  }
  #${OVERLAY_ID} .rp-clip {
    display: grid;
    gap: 8px;
    margin-top: 4px;
    padding-top: 10px;
    border-top: 1px solid rgba(148, 163, 184, 0.2);
  }
  #${OVERLAY_ID} .rp-clip-heading { margin: 0; }
  #${OVERLAY_ID} .rp-clip-status { margin: 0; color: #bae6fd; font-size: 12px; }
  #${OVERLAY_ID} .rp-clip-status[data-clip-status="failed"] { color: #fecaca; }
  #${OVERLAY_ID} .rp-clip-status[data-clip-status="busy"] { color: #fde68a; }
  #${OVERLAY_ID} .rp-clip-download {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
  #${OVERLAY_ID} .rp-reveal { border-color: rgba(34, 197, 94, 0.54); background: rgba(20, 83, 45, 0.42); }
  #${OVERLAY_ID} .rp-winner { color: #bbf7d0; font-size: 20px; font-weight: 850; }
  #${OVERLAY_ID} .rp-failure { border-color: rgba(248, 113, 113, 0.52); background: rgba(127, 29, 29, 0.34); }
  #${OVERLAY_ID} .rp-cancelled { border-color: rgba(251, 191, 36, 0.46); }
  #${OVERLAY_ID} .rp-frozen-position { margin: 0; padding: 0 4px; color: #cbd5e1; }
  #${OVERLAY_ID} .rp-counter { display: grid; gap: 8px; }
  #${OVERLAY_ID} .rp-action-status { min-height: 0; margin: 0; padding: 0 12px 10px; color: #fecaca; }
  #${OVERLAY_ID} .rp-action-status:empty { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] {
    top: auto;
    right: 10px;
    bottom: 10px;
    width: min(320px, calc(100vw - 20px));
    max-height: min(225px, calc(100vh - 20px));
  }
  #${OVERLAY_ID}[data-ambient="true"] .rp-header { padding: 8px 9px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-title { max-width: 185px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-label,
  #${OVERLAY_ID}[data-ambient="true"] .rp-shared-status,
  #${OVERLAY_ID}[data-ambient="true"] .rp-checkpoint-progress,
  #${OVERLAY_ID}[data-ambient="true"] .rp-secondary,
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-heading { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-body { grid-template-columns: 1fr auto; gap: 6px; padding: 7px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-playing-status,
  #${OVERLAY_ID}[data-ambient="true"] .rp-ambient-evidence,
  #${OVERLAY_ID}[data-ambient="true"] .rp-markers { padding: 7px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-playing-status { grid-column: 1 / -1; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-ambient-evidence { grid-column: 1; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-markers { grid-column: 2; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-list { grid-template-columns: repeat(2, 34px); margin: 0; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-button { min-height: 30px; height: 30px; padding: 1px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-symbol { font-size: 15px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }
  #${OVERLAY_ID}[data-ambient="true"] .rp-checkpoint {
    grid-column: 1 / -1;
    max-height: 185px;
    overflow: auto;
  }
  @media (max-width: 700px), (max-height: 430px) {
    #${OVERLAY_ID}:not([data-ambient="true"]) {
      top: auto;
      right: 8px;
      bottom: 8px;
      left: 8px;
      width: auto;
      max-height: min(56vh, 360px);
      border-radius: 13px;
    }
    #${OVERLAY_ID} .rp-marker-label { font-size: 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    #${OVERLAY_ID} * { scroll-behavior: auto !important; transition: none !important; }
  }
  body.replay-premiere-pre-reveal replay-panel,
  body.replay-premiere-pre-reveal game-right-sidebar div:has(> img[alt="replay"]),
  body.replay-premiere-pre-reveal game-right-sidebar div:has(> img[alt="play/pause"]) {
    display: none !important;
  }
`;
