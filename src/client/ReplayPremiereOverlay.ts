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

export interface ReplayPremiereResultsStandingView {
  seatId: string;
  displayName: string;
  won: boolean;
}

export interface ReplayPremiereResultsPredictionOptionView {
  seatId: string;
  displayName: string;
  percent: number;
}

export interface ReplayPremiereResultsPredictionView {
  checkpointId: string;
  sequence: number;
  /** Share of predictions that named the actual winner; null when void. */
  correctPercent: number | null;
  /** Total predictions, when known (archived summary); omitted live. */
  totalPredictions?: number | null;
  options: readonly ReplayPremiereResultsPredictionOptionView[];
}

export interface ReplayPremiereResultsMarkerView {
  kind: ReplayPremiereMarkerKind;
  turn: number;
  count: number;
}

/**
 * Aggregate-only results the post-reveal panel renders. It carries no
 * per-viewer data — every field is a seat identity, a public display name, or a
 * tally — so it is safe to persist and re-serve on the archived premiere page.
 */
export interface ReplayPremiereResultsSummaryView {
  turnCount?: number | null;
  standings: readonly ReplayPremiereResultsStandingView[];
  predictions: readonly ReplayPremiereResultsPredictionView[];
  markers: readonly ReplayPremiereResultsMarkerView[];
}

export interface ReplayPremiereRevealView {
  outcome: "winner" | "void";
  winnerSeatId?: string | null;
  summary?: string | null;
  /** The durable results summary; augments the reveal payoff post-reveal. */
  results?: ReplayPremiereResultsSummaryView | null;
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
    // Text-presentation glyphs only (trailing U+FE0E where a glyph could
    // otherwise render as color emoji), so the reactions read as a consistent
    // legible set across platforms rather than mismatched emoji.
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
    symbol: "†",
  },
  {
    kind: "clip_this",
    translationKey: "replay_premiere.marker_clip_this",
    symbol: "✂︎",
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
  let lastWindowPhase: ReplayPremiereWindowPhase | null = null;

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
    const nowMs = authoritativeTime();
    updateCountdowns(overlay, model, nowMs);
    announceWindowTransition(nowMs);
  };

  const authoritativeTime = () => {
    if (serverClockMs === null) {
      return null;
    }
    return serverClockMs + Math.max(0, Date.now() - localClockMs);
  };

  // Announces prediction-window and start transitions once each, on change.
  const announceWindowTransition = (nowMs: number | null) => {
    const region = overlay.querySelector<HTMLElement>(
      "[data-premiere-window-status]",
    );
    if (region === null) {
      return;
    }
    const phase = premiereWindowPhase(model, nowMs);
    if (phase === lastWindowPhase) {
      return;
    }
    lastWindowPhase = phase;
    const key = windowPhaseAnnouncementKey(phase);
    region.textContent = key === null ? "" : translateText(key);
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
  // A visually-hidden live region that announces only meaningful lifecycle
  // transitions (prediction window open/close, "starting when ready") exactly
  // once. It replaces the per-tick aria-live on the countdown elements, which
  // spammed screen readers.
  const windowStatus = element("p", "rp-sr-only");
  windowStatus.dataset.premiereWindowStatus = "";
  windowStatus.setAttribute("role", "status");
  windowStatus.setAttribute("aria-live", "polite");
  shell.append(windowStatus);
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
  // Mirror every other control: when the host wires no ambient handler the
  // toggle is a visible no-op, so disable it instead of looking live-but-dead.
  ambient.disabled = callbacks.onAmbientChange === undefined;
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
      // The prediction card is the interactive beat, so it leads. On the tight
      // mobile sheet the playing-status card is hidden via CSS in this state,
      // guaranteeing the question/options land above the fold. The LIVE pulse
      // still reads through the checkpoint timer pill.
      body.append(renderCheckpoint(model, callbacks, safeRun));
      body.append(renderPlaying(model));
      body.append(renderAmbientEvidence(model));
      body.append(renderMarkers(model, callbacks, safeRun));
      body.append(renderShare(model, callbacks, safeRun, captionState));
      break;
    case "revealed":
      if (!isVerifiedRevealView(model)) {
        body.append(renderSanitizedFailure("integrity_failure"));
        appendOptional(body, renderFrozenPosition(model));
        break;
      }
      // Post-reveal, the final standings are the truth; the mid-game leader
      // scoreboard (renderAmbientEvidence) is intentionally dropped so stale
      // "current leaders" percentages cannot sit under and contradict the
      // final results.
      body.append(renderReveal(model, model.reveal));
      body.append(
        renderResultsSummary(model.reveal, model.mapName, model.matchFormat),
      );
      body.append(renderMarkers(model, callbacks, safeRun));
      body.append(renderShare(model, callbacks, safeRun, captionState));
      body.append(renderCounterChallenge(model, callbacks, safeRun));
      break;
    case "failed":
      body.append(renderSanitizedFailure(model.failureCode));
      appendOptional(body, renderFrozenPosition(model));
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
      body.append(
        renderResultsSummary(model.reveal, model.mapName, model.matchFormat),
      );
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
  // The heading demotes to the small eyebrow treatment so the countdown below
  // is the hero of the card; it stays an <h3> with the id the section is
  // labelled by, preserving the accessible name and heading semantics.
  const heading = element(
    "h3",
    "rp-eyebrow rp-scheduled-eyebrow",
    translateText("replay_premiere.scheduled_heading"),
  );
  heading.id = "replay-premiere-scheduled-heading";
  const countdown = element("p", "rp-countdown");
  countdown.dataset.premiereCountdown = "start";
  // No aria-live here: updateCountdowns rewrites this element every 250ms, which
  // would spam a screen reader. Meaningful transitions ("Starting when ready")
  // are announced once through the dedicated window-status live region instead.
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
  section.append(metadata);

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
  // The reminder / copy-link CTAs sit ABOVE the participant roster so they never
  // depend on roster length — with a 12-agent field the provenance list would
  // otherwise push the CTAs far below the fold.
  section.append(actions, renderPolicies(model.policies));
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
    item.append(name, version, kind);
    // Full-length provenance (long IDs + 64-char SHA-256 hashes) is collapsed
    // behind a "Verification details" disclosure so the roster stays scannable
    // even with a 12-agent field. Hashes render truncated with the full value
    // preserved in the title attribute for verification-minded viewers.
    const details = element("details", "rp-policy-details");
    details.append(
      element(
        "summary",
        "rp-policy-summary",
        translateText("replay_premiere.verification_details"),
      ),
    );
    if (policy.policyIdentity.namespace === "softmax_policy_version") {
      details.append(
        policyReferenceLine(
          translateText("replay_premiere.softmax_policy_name", {
            name: safeDisplay(policy.policyIdentity.policyName),
          }),
        ),
        policyReferenceLine(
          translateText("replay_premiere.policy_version_id", {
            id: safeDisplay(policy.policyIdentity.policyVersionId),
          }),
        ),
      );
    } else {
      const manifestSha = safeDisplay(policy.policyIdentity.manifestSha256);
      const contentSha = safeDisplay(policy.policyIdentity.contentSha256);
      details.append(
        policyReferenceLine(
          translateText("replay_premiere.manifest_name", {
            name: safeDisplay(policy.policyIdentity.manifestName),
          }),
        ),
        policyReferenceLine(
          translateText("replay_premiere.manifest_sha", {
            hash: truncateHash(manifestSha),
          }),
          translateText("replay_premiere.manifest_sha", { hash: manifestSha }),
        ),
        policyReferenceLine(
          translateText("replay_premiere.content_sha", {
            hash: truncateHash(contentSha),
          }),
          translateText("replay_premiere.content_sha", { hash: contentSha }),
        ),
      );
    }
    item.append(details);
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

// A prominent LIVE indicator for the only two truly-live lifecycle states.
// This helper is rendered exclusively from `renderPlaying`, which `renderStateBody`
// invokes ONLY for the `playing` and `checkpoint` cases — so the badge is
// structurally gated to live states and can never appear for `scheduled`
// (still counting down), `revealed`/`archived` (the live moment has passed), or
// any failure/cancel state. It reflects the authoritative lifecycle state the
// page already renders; nothing about live-ness is invented here.
function renderLiveNowBadge(): HTMLElement {
  const badge = element("div", "rp-live-now");
  // role=img + aria-label exposes a single, stable accessible name ("Premiere is
  // live") without live-region churn, while sighted users still read "LIVE".
  badge.setAttribute("role", "img");
  badge.setAttribute(
    "aria-label",
    translateText("replay_premiere.live_status"),
  );
  const dot = element("span", "rp-live-now-dot");
  dot.setAttribute("aria-hidden", "true");
  const text = element(
    "span",
    "rp-live-now-text",
    translateText("replay_premiere.live_badge"),
  );
  badge.append(dot, text);
  return badge;
}

// The "shared playback" explainer is a first-contact orientation, so it only
// rides the opening stretch of released sequences and then retires. Gating on
// the released-sequence count keeps it deterministic (no per-tick churn, no
// per-mount flag) and identical for everyone watching the same moment.
const SHARED_PLAYBACK_EXPLAINER_SEQUENCES = 60;

function renderPlaying(model: ReplayPremiereOverlayModel): HTMLElement {
  const section = element("section", "rp-section rp-playing-status");
  // The red LIVE pill is the single hero live signal; the playback rate rides
  // the same row as a quiet chip. The LIVE badge stays first.
  const liveHeader = element("div", "rp-live-header");
  const rate = element(
    "span",
    "rp-rate",
    translateText("replay_premiere.rate_value", {
      rate: model.playbackRate,
    }),
  );
  liveHeader.append(renderLiveNowBadge(), rate);
  section.append(liveHeader);
  // Only during the opening sequences: the "Shared playback / everyone is
  // watching the same moment" first-contact explainer. Past that it retires so
  // it is not a permanent status line, while the LIVE pill and the turn below
  // stay for the whole premiere.
  if (
    Math.floor(model.releasedSequence) < SHARED_PLAYBACK_EXPLAINER_SEQUENCES
  ) {
    section.append(
      element(
        "span",
        "rp-live-badge",
        translateText("replay_premiere.shared_playback"),
      ),
      element(
        "p",
        "rp-shared-status",
        translateText("replay_premiere.shared_status"),
      ),
    );
  }
  section.append(
    element(
      "p",
      "rp-position",
      positionLabel(model.currentTurn, model.releasedSequence),
    ),
    renderCheckpointProgress(model),
  );
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
    // A quiet expectation-setting cue on the still-to-come prediction so viewers
    // know a second window is coming, without faking an exact turn.
    if (checkpoint.state === "pending") {
      item.title = translateText("replay_premiere.prediction_upcoming_hint");
    }
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
  // No aria-live here (see renderScheduled): the per-tick countdown must not be
  // announced. Window open/close is announced once via the window-status region.
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
    const selected = checkpoint.selectedSeatId === option.seatId;
    optionButton.dataset.selected = String(selected);
    optionButton.setAttribute("aria-pressed", String(selected));
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
    // Crowd share drives a horizontal fill behind each row (CSS reads
    // --rp-share) so the resolution reads at a glance, not as bare numbers.
    const pct = boundedPercent(row.percent);
    item.style.setProperty("--rp-share", String(pct));
    if (row.seatId === checkpoint.selectedSeatId) {
      item.classList.add("rp-distribution-mine");
    }
    item.append(
      element("span", "rp-distribution-name", safeDisplay(option.displayName)),
      element(
        "span",
        "rp-distribution-pct",
        translateText("replay_premiere.percent", { percent: pct }),
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
  const leadersHeading = element(
    "h3",
    "rp-subheading",
    translateText("replay_premiere.current_leaders"),
  );
  // This percentage is each leader's share of CLAIMED land (denominator is the
  // sum of players' owned tiles), while the in-game leaderboard on the same
  // screen shows share of the whole map. They are different measures, so the
  // two panels legitimately print different numbers for what looks like one
  // stat — worst in the early game, when most of the map is still unclaimed.
  // Until the frame carries a map total we cannot align the denominators, so
  // name the measure instead of letting it read as a contradiction.
  leadersHeading.title = translateText("replay_premiere.current_leaders_tip");
  leaders.append(leadersHeading);
  leaders.append(
    element(
      "p",
      "rp-leaders-basis",
      translateText("replay_premiere.current_leaders_basis"),
    ),
  );
  const leaderList = element("ol", "rp-leader-list");
  for (const leader of (model.leaders ?? []).slice(0, 3)) {
    const item = element("li", "rp-leader");
    const name = element(
      "span",
      "rp-leader-name",
      safeDisplay(leader.displayName),
    );
    item.append(name);
    if (
      leader.territoryPercent !== null &&
      leader.territoryPercent !== undefined
    ) {
      // Territory share drives a thin proportion bar under the row (CSS reads
      // --rp-share), turning the leader list into a live scoreboard.
      const pct = boundedPercent(leader.territoryPercent);
      item.classList.add("rp-leader-ranked");
      item.style.setProperty("--rp-share", String(pct));
      item.append(
        element(
          "span",
          "rp-leader-share",
          translateText("replay_premiere.percent", { percent: pct }),
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
  // Post-reveal, the clip download is the single loudest action, so the
  // timestamp-share button demotes to quiet on the revealed/archived surface.
  // While live it remains the primary share affordance.
  const timestampPrimary =
    model.state !== "revealed" && model.state !== "archived";
  const timestamp = button(
    "replay_premiere.copy_timestamp",
    `rp-button ${
      timestampPrimary ? "rp-button-primary" : "rp-button-quiet"
    } rp-timestamp-share`,
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
  const heading = element(
    "h4",
    "rp-subheading rp-clip-heading",
    translateText("replay_premiere.clip_heading"),
  );
  const anchorTurn = finiteIntegerOrNull(model.currentTurn);
  const ready = clip.ready ?? null;
  const isReady = clip.status === "ready" && ready !== null;
  // Once the rendered file exists, the download anchor below becomes the loud
  // payoff and this button demotes to a quiet "Re-render clip" so it can never
  // be mistaken for the download and trigger an accidental re-render.
  const request = button(
    isReady
      ? "replay_premiere.clip_rerender"
      : "replay_premiere.clip_download_button",
    `rp-button ${
      isReady ? "rp-button-quiet" : "rp-button-primary"
    } rp-clip-request`,
  );
  request.dataset.focusKey = "clip-request";
  const canRequest =
    callbacks.onRequestClip !== undefined &&
    model.canRequestClip === true &&
    anchorTurn !== null;
  // A render already in flight must not accept another request.
  request.disabled = !canRequest || clip.status === "preparing";
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

  const statusKey = clipStatusText(clip.status);
  let status: HTMLElement | null = null;
  if (statusKey !== null) {
    status = element("p", "rp-clip-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.clipStatus = clip.status;
    // A pulsing dot signals an in-flight render (static under reduced motion).
    if (clip.status === "preparing") {
      const dot = element("span", "rp-clip-dot");
      dot.setAttribute("aria-hidden", "true");
      status.append(dot);
    }
    status.append(translateText(statusKey));
  }

  let downloadRow: HTMLElement[] | null = null;
  if (ready !== null) {
    const download = element(
      "a",
      "rp-button rp-button-primary rp-clip-download",
    ) as HTMLAnchorElement;
    download.textContent = translateText("replay_premiere.clip_download_file");
    download.href = ready.downloadUrl;
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
    downloadRow = [download, copyCaption, copyReply];
  }

  wrapper.append(heading);
  if (isReady) {
    // Ready payoff order: the "clip is ready" status line, then the loud
    // Download MP4 button, the copy-caption / copy-watch-link row, and finally
    // the quiet "Re-render clip" so the download is unmistakably the primary.
    if (status !== null) {
      wrapper.append(status);
    }
    if (downloadRow !== null) {
      wrapper.append(...downloadRow);
    }
    wrapper.append(request);
  } else {
    // Idle/preparing states keep the request (download) button first as the
    // primary call to action, above any status line or retained download.
    wrapper.append(request);
    if (status !== null) {
      wrapper.append(status);
    }
    if (downloadRow !== null) {
      wrapper.append(...downloadRow);
    }
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
  const isWinner = reveal.outcome === "winner";
  const section = element(
    "section",
    `rp-section rp-reveal ${isWinner ? "rp-reveal-win" : "rp-reveal-void"}`,
  );
  section.setAttribute("aria-live", "polite");
  // "Final reveal" becomes a small eyebrow so the winner line is the payoff.
  const heading = element(
    "h3",
    "rp-reveal-eyebrow",
    translateText("replay_premiere.reveal_heading"),
  );
  section.append(heading);
  if (isWinner) {
    const winner = model.policies.find(
      (policy) => policy.seatId === reveal.winnerSeatId,
    );
    // Decorative victory crest — purely presentational, hidden from assistive
    // tech, and gated to the verified winner outcome.
    const crest = element("div", "rp-reveal-crest", "★");
    crest.setAttribute("aria-hidden", "true");
    section.append(
      crest,
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

// Shared terminal-state reassurance. The product's core promise is that nothing
// was spoiled, and a stopped/cancelled premiere should not be a dead end — so
// both the failure and cancelled renderers (which also back the archived
// no-outcome page) state the outcome stays sealed and offer a way back to the
// league.
function appendSealedExit(section: HTMLElement): void {
  section.append(
    element(
      "p",
      "rp-sealed",
      translateText("replay_premiere.outcome_still_sealed"),
    ),
  );
  const back = element(
    "a",
    "rp-button rp-button-quiet rp-back-to-league",
  ) as HTMLAnchorElement;
  back.href = "/league";
  back.textContent = translateText("replay_premiere.back_to_league");
  back.dataset.focusKey = "back-to-league";
  section.append(back);
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
  appendSealedExit(section);
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

// The frozen marker now speaks in viewer language (the turn playback stopped on)
// rather than the internal released-sequence counter. When no turn is known
// there is nothing meaningful to say, so nothing is rendered.
function renderFrozenPosition(
  model: ReplayPremiereOverlayModel,
): HTMLElement | null {
  const turn = finiteIntegerOrNull(model.currentTurn);
  if (turn === null) {
    return null;
  }
  return element(
    "p",
    "rp-frozen-position",
    translateText("replay_premiere.playback_stopped_at_turn", { turn }),
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
  appendSealedExit(section);
  return section;
}

// The two-column standings grid keeps the full 12-seat FFA field compact, so we
// show the whole field rather than truncating it to a "+N more agents" tail.
const RESULTS_STANDINGS_LIMIT = 12;
const RESULTS_MARKERS_LIMIT = 12;

/**
 * The durable post-reveal results panel: final standings, per-checkpoint crowd
 * prediction accuracy, and notable community markers. It renders nothing when
 * no results summary is attached, so it stays fail-closed on an absent reveal.
 */
function renderResultsSummary(
  reveal: ReplayPremiereRevealView,
  mapLabel: string,
  formatLabel: string,
): HTMLElement {
  const section = element("section", "rp-section rp-results");
  const results = reveal.results;
  if (results === null || results === undefined) {
    section.hidden = true;
    return section;
  }
  const titleId = "rp-results-title";
  section.setAttribute("aria-labelledby", titleId);
  const heading = element(
    "h3",
    "rp-section-title",
    translateText("replay_premiere.results_heading"),
  );
  heading.id = titleId;
  section.append(heading);
  // One-line match context under the heading: "{map} · {format} · {n} turns".
  // Each segment is dropped when its label is absent so a legacy summary (empty
  // map/format) never renders a bare "·" or "undefined".
  const metaParts: string[] = [];
  const mapText = safeDisplay(mapLabel);
  if (mapText.length > 0) {
    metaParts.push(mapText);
  }
  const formatText = safeDisplay(formatLabel);
  if (formatText.length > 0) {
    metaParts.push(formatText);
  }
  if (
    typeof results.turnCount === "number" &&
    Number.isFinite(results.turnCount) &&
    results.turnCount > 0
  ) {
    metaParts.push(
      translateText("replay_premiere.results_turn_count", {
        turns: Math.trunc(results.turnCount),
      }),
    );
  }
  if (metaParts.length > 0) {
    section.append(element("p", "rp-results-meta", metaParts.join(" · ")));
  }
  const winnerSeatIds = new Set(
    results.standings
      .filter((standing) => standing.won)
      .map((standing) => standing.seatId),
  );
  section.append(renderResultsStandings(results.standings));
  if (results.predictions.length > 0) {
    section.append(
      renderResultsPredictions(results.predictions, winnerSeatIds),
    );
  }
  if (results.markers.length > 0) {
    section.append(renderResultsMarkers(results.markers));
  }
  return section;
}

function renderResultsStandings(
  standings: readonly ReplayPremiereResultsStandingView[],
): HTMLElement {
  const group = element("div", "rp-results-group");
  group.append(
    element(
      "h4",
      "rp-subheading",
      translateText("replay_premiere.results_standings"),
    ),
  );
  const ordered = [...standings].sort(
    (left, right) => Number(right.won) - Number(left.won),
  );
  const shown = ordered.slice(0, RESULTS_STANDINGS_LIMIT);
  const list = element("ul", "rp-results-standings");
  list.setAttribute("role", "list");
  for (const standing of shown) {
    const item = element(
      "li",
      `rp-results-standing${standing.won ? " rp-results-win" : ""}`,
    );
    item.append(
      element(
        "span",
        "rp-results-standing-name",
        safeDisplay(standing.displayName),
      ),
    );
    if (standing.won) {
      item.append(
        element(
          "span",
          "rp-results-badge",
          translateText("replay_premiere.results_winner_badge"),
        ),
      );
    }
    list.append(item);
  }
  group.append(list);
  const remaining = ordered.length - shown.length;
  if (remaining > 0) {
    group.append(
      element(
        "p",
        "rp-muted rp-results-more",
        translateText("replay_premiere.results_more_agents", {
          count: remaining,
        }),
      ),
    );
  }
  return group;
}

function renderResultsPredictions(
  predictions: readonly ReplayPremiereResultsPredictionView[],
  winnerSeatIds: ReadonlySet<string>,
): HTMLElement {
  const group = element("div", "rp-results-group");
  group.append(
    element(
      "h4",
      "rp-subheading",
      translateText("replay_premiere.results_predictions"),
    ),
  );
  predictions.forEach((prediction, index) => {
    const block = element("div", "rp-results-prediction");
    block.append(
      element(
        "p",
        "rp-results-prediction-title",
        translateText("replay_premiere.checkpoint_number", {
          number: index + 1,
        }),
      ),
    );
    if (prediction.correctPercent !== null) {
      block.append(
        element(
          "p",
          "rp-results-accuracy",
          translateText("replay_premiere.results_accuracy", {
            percent: boundedPercent(prediction.correctPercent),
          }),
        ),
      );
    } else {
      block.append(
        element(
          "p",
          "rp-muted",
          translateText("replay_premiere.results_accuracy_void"),
        ),
      );
    }
    for (const option of prediction.options) {
      const pct = boundedPercent(option.percent);
      const row = element(
        "div",
        `rp-distribution-row${
          winnerSeatIds.has(option.seatId) ? " rp-distribution-mine" : ""
        }`,
      );
      row.style.setProperty("--rp-share", String(pct));
      row.append(
        element(
          "span",
          "rp-distribution-name",
          safeDisplay(option.displayName),
        ),
      );
      row.append(
        element(
          "span",
          "rp-distribution-pct",
          translateText("replay_premiere.percent", { percent: pct }),
        ),
      );
      block.append(row);
    }
    if (
      typeof prediction.totalPredictions === "number" &&
      Number.isFinite(prediction.totalPredictions) &&
      prediction.totalPredictions >= 0
    ) {
      block.append(
        element(
          "p",
          "rp-muted rp-results-votes",
          translateText("replay_premiere.results_vote_count", {
            count: Math.trunc(prediction.totalPredictions),
          }),
        ),
      );
    }
    group.append(block);
  });
  return group;
}

function renderResultsMarkers(
  markers: readonly ReplayPremiereResultsMarkerView[],
): HTMLElement {
  const group = element("div", "rp-results-group");
  group.append(
    element(
      "h4",
      "rp-subheading",
      translateText("replay_premiere.results_markers"),
    ),
  );
  const list = element("ul", "rp-results-markers");
  list.setAttribute("role", "list");
  for (const marker of markers.slice(0, RESULTS_MARKERS_LIMIT)) {
    const meta = MARKERS.find((entry) => entry.kind === marker.kind);
    const item = element("li", "rp-results-marker");
    item.dataset.kind = marker.kind;
    const symbol = element(
      "span",
      "rp-results-marker-symbol",
      meta?.symbol ?? "•",
    );
    symbol.setAttribute("aria-hidden", "true");
    item.append(
      symbol,
      element(
        "span",
        "rp-results-marker-label",
        meta === undefined ? "" : translateText(meta.translationKey),
      ),
      element(
        "span",
        "rp-results-marker-detail",
        translateText("replay_premiere.results_marker_detail", {
          turn: marker.turn,
          count: marker.count,
        }),
      ),
    );
    list.append(item);
  }
  group.append(list);
  return group;
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
  // The honest identity subline (map · agents · Premiered {date}) is composed by
  // the archive-view model builder and carried in model.description. Render it so
  // the durable archived page shows real match context, not just a generic
  // sentence. It already includes the premiered date, so the separate
  // "Premiered {date}" line is dropped to avoid duplicating it; if the subline is
  // ever absent, fall back to the dated line.
  const identitySubline = safeDisplay(model.description);
  if (identitySubline.length > 0) {
    section.append(element("p", "rp-archived-premiered", identitySubline));
  } else if (parseTime(model.scheduledAt) !== null) {
    section.append(
      element(
        "p",
        "rp-archived-premiered",
        translateText("replay_premiere.archived_premiered", {
          date: formatDateTime(model.scheduledAt),
        }),
      ),
    );
  }
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
  // A quiet bordered group so the counter-challenge copy + button read as one
  // deliberate card instead of an orphaned helper line floating under the share
  // controls.
  const group = element("div", "rp-quiet-group");
  group.append(
    element(
      "p",
      "rp-counter-copy",
      translateText("replay_premiere.counter_challenge_description"),
    ),
    exportButton,
  );
  section.append(group);
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

type ReplayPremiereWindowPhase = "open" | "closed" | "starting" | "idle";

// Derives the announcement-worthy lifecycle phase from the authoritative model.
// Prediction-window open/close reads the active checkpoint's own state; the
// scheduled "starting" phase fires once the scheduled instant has passed.
function premiereWindowPhase(
  model: ReplayPremiereOverlayModel,
  nowMs: number | null,
): ReplayPremiereWindowPhase {
  if (model.state === "checkpoint") {
    const checkpoint = model.checkpoints.find(
      (entry) => entry.id === model.activeCheckpointId,
    );
    if (checkpoint?.state === "open") {
      return "open";
    }
    if (checkpoint?.state === "closed") {
      return "closed";
    }
    return "idle";
  }
  if (model.state === "scheduled") {
    const scheduledMs = parseTime(model.scheduledAt);
    if (nowMs !== null && scheduledMs !== null && scheduledMs <= nowMs) {
      return "starting";
    }
    return "idle";
  }
  return "idle";
}

function windowPhaseAnnouncementKey(
  phase: ReplayPremiereWindowPhase,
): string | null {
  switch (phase) {
    case "open":
      return "replay_premiere.window_open";
    case "closed":
      return "replay_premiere.window_closed";
    case "starting":
      return "replay_premiere.starting_when_ready";
    case "idle":
      return null;
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

const POLICY_HASH_DISPLAY_LENGTH = 12;

// Truncate a long provenance hash to a scannable prefix + ellipsis. The caller
// carries the full value in a title attribute so nothing is lost.
function truncateHash(hash: string): string {
  if (hash.length <= POLICY_HASH_DISPLAY_LENGTH + 1) {
    return hash;
  }
  return `${hash.slice(0, POLICY_HASH_DISPLAY_LENGTH)}…`;
}

// A collapsed provenance line. `fullText`, when it differs from the visible
// text (i.e. a hash was truncated), is exposed via the title attribute.
function policyReferenceLine(text: string, fullText?: string): HTMLElement {
  const line = element("span", "rp-policy-reference", text);
  if (fullText !== undefined && fullText !== text) {
    line.title = fullText;
  }
  return line;
}

function appendDefinition(
  list: HTMLDListElement,
  term: string,
  value: string,
): void {
  list.append(element("dt", "", term), element("dd", "", value));
}

function appendOptional(parent: HTMLElement, child: HTMLElement | null): void {
  if (child !== null) {
    parent.append(child);
  }
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
  /* ---- Design tokens. Dark is the default (the overlay floats over the dark
     game canvas). A host that opts into a light surface via
     :root[data-theme="light"] gets a remapped light palette — production never
     sets that attribute, so the dark default is what ships. ---- */
  #${OVERLAY_ID} {
    --rp-bg: rgba(10, 15, 28, 0.96);
    --rp-bg-solid: #0a0f1c;
    --rp-surface: rgba(18, 26, 43, 0.82);
    --rp-surface-2: rgba(30, 41, 59, 0.8);
    --rp-surface-3: rgba(51, 65, 85, 0.72);
    --rp-line: rgba(148, 163, 184, 0.2);
    --rp-line-strong: rgba(148, 163, 184, 0.34);
    --rp-text: #f1f5f9;
    --rp-text-dim: #cbd5e1;
    --rp-muted: #9fb0c3;
    --rp-accent: #56c7f5;
    --rp-accent-strong: #0ea5e9;
    --rp-accent-soft: rgba(56, 189, 248, 0.16);
    --rp-accent-ink: #04121e;
    --rp-live: #ef4444;
    --rp-live-soft: rgba(239, 68, 68, 0.17);
    --rp-live-border: rgba(248, 113, 113, 0.62);
    --rp-live-text: #fecaca;
    --rp-positive: #34d399;
    --rp-positive-soft: rgba(16, 185, 129, 0.18);
    --rp-positive-text: #a7f3d0;
    --rp-on-positive: #052015;
    --rp-caution: #fbbf24;
    --rp-caution-soft: rgba(251, 191, 36, 0.14);
    --rp-caution-text: #fde68a;
    --rp-danger: #f87171;
    --rp-danger-soft: rgba(239, 68, 68, 0.16);
    --rp-controlled: #a78bfa;
    --rp-mk-turning: #a78bfa;
    --rp-mk-turning-soft: rgba(167, 139, 250, 0.18);
    --rp-mk-smart: #34d399;
    --rp-mk-smart-soft: rgba(52, 211, 153, 0.18);
    --rp-mk-mistake: #fbbf24;
    --rp-mk-mistake-soft: rgba(251, 191, 36, 0.18);
    --rp-mk-betrayal: #f87171;
    --rp-mk-betrayal-soft: rgba(248, 113, 113, 0.18);
    --rp-mk-clip: #56c7f5;
    --rp-mk-clip-soft: rgba(56, 199, 245, 0.18);
    --rp-shadow: 0 26px 74px rgba(0, 0, 0, 0.52);
    --rp-focus: #38bdf8;
    --rp-r-xl: 18px;
    --rp-r-lg: 14px;
    --rp-r-md: 11px;
    --rp-r-sm: 9px;
    --rp-r-xs: 7px;
    --rp-r-pill: 999px;

    position: fixed;
    z-index: 51000;
    top: 12px;
    right: 12px;
    width: min(376px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--rp-line-strong);
    border-radius: var(--rp-r-xl);
    background: var(--rp-bg);
    color: var(--rp-text);
    box-shadow: var(--rp-shadow);
    backdrop-filter: blur(18px) saturate(1.15);
    font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums;
  }
  :root[data-theme="light"] #${OVERLAY_ID} {
    --rp-bg: rgba(255, 255, 255, 0.92);
    --rp-bg-solid: #f8fafc;
    --rp-surface: rgba(241, 245, 249, 0.92);
    --rp-surface-2: rgba(226, 232, 240, 0.86);
    --rp-surface-3: rgba(203, 213, 225, 0.78);
    --rp-line: rgba(15, 23, 42, 0.12);
    --rp-line-strong: rgba(15, 23, 42, 0.2);
    --rp-text: #0f172a;
    --rp-text-dim: #334155;
    --rp-muted: #5b6b80;
    --rp-accent: #0284c7;
    --rp-accent-strong: #0369a1;
    --rp-accent-soft: rgba(2, 132, 199, 0.12);
    --rp-accent-ink: #ffffff;
    --rp-live: #dc2626;
    --rp-live-soft: rgba(220, 38, 38, 0.1);
    --rp-live-border: rgba(220, 38, 38, 0.42);
    --rp-live-text: #b91c1c;
    --rp-positive: #059669;
    --rp-positive-soft: rgba(5, 150, 105, 0.12);
    --rp-positive-text: #047857;
    --rp-on-positive: #ffffff;
    --rp-caution: #b45309;
    --rp-caution-soft: rgba(217, 119, 6, 0.12);
    --rp-caution-text: #92400e;
    --rp-danger: #dc2626;
    --rp-danger-soft: rgba(220, 38, 38, 0.1);
    --rp-controlled: #7c3aed;
    --rp-mk-turning: #7c3aed;
    --rp-mk-turning-soft: rgba(124, 58, 237, 0.12);
    --rp-mk-smart: #059669;
    --rp-mk-smart-soft: rgba(5, 150, 105, 0.12);
    --rp-mk-mistake: #b45309;
    --rp-mk-mistake-soft: rgba(180, 83, 9, 0.12);
    --rp-mk-betrayal: #dc2626;
    --rp-mk-betrayal-soft: rgba(220, 38, 38, 0.12);
    --rp-mk-clip: #0284c7;
    --rp-mk-clip-soft: rgba(2, 132, 199, 0.12);
    --rp-shadow: 0 20px 54px rgba(15, 23, 42, 0.2);
    --rp-focus: #0284c7;
  }

  #${OVERLAY_ID} * { box-sizing: border-box; }
  #${OVERLAY_ID} [hidden] { display: none !important; }
  #${OVERLAY_ID} .rp-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  #${OVERLAY_ID} button,
  #${OVERLAY_ID} textarea { font: inherit; }
  #${OVERLAY_ID} button { transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease; }
  #${OVERLAY_ID} button:focus-visible,
  #${OVERLAY_ID} textarea:focus-visible {
    outline: 3px solid var(--rp-focus);
    outline-offset: 2px;
  }
  #${OVERLAY_ID} button:disabled { cursor: not-allowed; opacity: 0.46; }

  /* ---- Shell + header ---- */
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
    border-bottom: 1px solid var(--rp-line);
    background: var(--rp-bg-solid);
  }
  #${OVERLAY_ID} .rp-title-group { min-width: 0; display: grid; gap: 7px; }
  #${OVERLAY_ID} .rp-title {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 17px;
    line-height: 1.22;
    letter-spacing: -0.01em;
  }
  #${OVERLAY_ID} .rp-label {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 3px 9px;
    border: 1px solid transparent;
    border-radius: var(--rp-r-pill);
    background: var(--rp-accent-soft);
    color: var(--rp-accent);
    font-size: 10px;
    font-weight: 800;
    line-height: 1.3;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} .rp-label-caution { background: var(--rp-caution-soft); color: var(--rp-caution-text); border-color: rgba(251, 191, 36, 0.36); }
  #${OVERLAY_ID} .rp-label-controlled { background: rgba(167, 139, 250, 0.16); color: var(--rp-controlled); }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-label-controlled { background: rgba(124, 58, 237, 0.12); }
  #${OVERLAY_ID} .rp-ambient-toggle {
    flex: 0 0 auto;
    min-height: 34px;
    padding: 7px 11px;
    border: 1px solid var(--rp-line-strong);
    border-radius: var(--rp-r-sm);
    background: var(--rp-surface-2);
    color: var(--rp-text);
    font-weight: 650;
    cursor: pointer;
  }
  #${OVERLAY_ID} .rp-ambient-toggle:hover { border-color: var(--rp-accent); color: var(--rp-accent); }

  /* ---- Body + section shells ---- */
  #${OVERLAY_ID} .rp-body { display: grid; gap: 10px; padding: 12px; }
  #${OVERLAY_ID} .rp-section,
  #${OVERLAY_ID} .rp-ambient-evidence {
    border: 1px solid var(--rp-line);
    border-radius: var(--rp-r-lg);
    background: var(--rp-surface);
    padding: 13px;
  }
  #${OVERLAY_ID} .rp-runtime-status {
    display: flex;
    gap: 8px;
    align-items: center;
    border: 1px solid rgba(56, 189, 248, 0.36);
    border-radius: var(--rp-r-sm);
    background: rgba(12, 74, 110, 0.36);
    color: #bae6fd;
    padding: 9px 11px;
    font-size: 12px;
    font-weight: 600;
  }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-runtime-status { background: rgba(2, 132, 199, 0.1); color: #075985; border-color: rgba(2, 132, 199, 0.3); }
  #${OVERLAY_ID} .rp-recovery { border-color: rgba(251, 191, 36, 0.44); background: var(--rp-caution-soft); color: var(--rp-caution-text); }

  /* ---- Typography ---- */
  #${OVERLAY_ID} .rp-section-title,
  #${OVERLAY_ID} .rp-subheading,
  #${OVERLAY_ID} .rp-question { margin: 0; }
  #${OVERLAY_ID} .rp-section-title { font-size: 16px; letter-spacing: -0.01em; }
  #${OVERLAY_ID} .rp-leaders-basis {
    margin: 1px 0 0;
    color: var(--rp-muted);
    font-size: 10px;
    font-weight: 600;
    opacity: 0.8;
  }
  #${OVERLAY_ID} .rp-subheading {
    color: var(--rp-muted);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} p { margin: 6px 0 0; }
  #${OVERLAY_ID} .rp-description,
  #${OVERLAY_ID} .rp-muted,
  #${OVERLAY_ID} .rp-start-time,
  #${OVERLAY_ID} .rp-shared-status { color: var(--rp-text-dim); }
  #${OVERLAY_ID} .rp-muted { color: var(--rp-muted); }

  /* ---- Scheduled / countdown ---- */
  #${OVERLAY_ID} .rp-scheduled { background: linear-gradient(180deg, var(--rp-accent-soft), transparent 46%), var(--rp-surface); }
  #${OVERLAY_ID} .rp-countdown {
    margin-top: 8px;
    color: var(--rp-accent);
    font-size: 40px;
    font-weight: 900;
    line-height: 1.05;
    letter-spacing: -0.01em;
  }
  #${OVERLAY_ID} .rp-start-time { margin-top: 3px; font-size: 12.5px; }
  #${OVERLAY_ID} .rp-metadata {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 12px;
    margin: 13px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--rp-line);
  }
  #${OVERLAY_ID} .rp-metadata dt { color: var(--rp-muted); font-weight: 600; }
  #${OVERLAY_ID} .rp-metadata dd { margin: 0; overflow-wrap: anywhere; text-align: right; font-weight: 650; }
  #${OVERLAY_ID} .rp-participants { margin-top: 13px; }
  #${OVERLAY_ID} .rp-policy-list,
  #${OVERLAY_ID} .rp-leader-list,
  #${OVERLAY_ID} .rp-distribution-list {
    display: grid;
    gap: 7px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  #${OVERLAY_ID} .rp-policy {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 8px;
    padding: 9px 10px;
    border: 1px solid var(--rp-line);
    border-radius: var(--rp-r-sm);
    background: var(--rp-surface-2);
  }
  #${OVERLAY_ID} .rp-policy-name { min-width: 0; overflow-wrap: anywhere; font-weight: 750; }
  #${OVERLAY_ID} .rp-policy-version { color: var(--rp-accent); font-weight: 700; font-size: 12px; text-align: right; }
  #${OVERLAY_ID} .rp-policy-kind { grid-column: 1 / -1; margin-top: 2px; color: var(--rp-muted); font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  #${OVERLAY_ID} .rp-policy-reference { display: block; color: var(--rp-muted); overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.35; }
  #${OVERLAY_ID} .rp-policy-details { grid-column: 1 / -1; margin-top: 3px; }
  #${OVERLAY_ID} .rp-policy-details > .rp-policy-reference { margin-top: 5px; }
  #${OVERLAY_ID} .rp-policy-summary {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    width: max-content;
    color: var(--rp-muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    list-style: none;
  }
  #${OVERLAY_ID} .rp-policy-summary::-webkit-details-marker { display: none; }
  #${OVERLAY_ID} .rp-policy-summary::before {
    content: "›";
    display: inline-block;
    font-size: 12px;
    line-height: 1;
    transition: transform 0.12s ease;
  }
  #${OVERLAY_ID} .rp-policy-details[open] .rp-policy-summary::before { transform: rotate(90deg); }
  #${OVERLAY_ID} .rp-policy-summary:focus-visible { outline: 3px solid var(--rp-focus); outline-offset: 2px; border-radius: var(--rp-r-xs); }

  /* ---- Buttons ---- */
  #${OVERLAY_ID} .rp-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; }
  #${OVERLAY_ID} .rp-button {
    min-height: 38px;
    padding: 9px 13px;
    border: 1px solid transparent;
    border-radius: var(--rp-r-sm);
    cursor: pointer;
    font-weight: 750;
  }
  #${OVERLAY_ID} .rp-button-primary { background: var(--rp-accent-strong); color: var(--rp-accent-ink); }
  #${OVERLAY_ID} .rp-button-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(14, 165, 233, 0.28); }
  #${OVERLAY_ID} .rp-button-quiet {
    border-color: var(--rp-line-strong);
    background: var(--rp-surface-2);
    color: var(--rp-text);
  }
  #${OVERLAY_ID} .rp-button-quiet:hover:not(:disabled) { border-color: var(--rp-accent); color: var(--rp-accent); }

  /* ---- Live playing ---- */
  #${OVERLAY_ID} .rp-live-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  #${OVERLAY_ID} .rp-live-now {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 4px 12px 4px 10px;
    border: 1px solid var(--rp-live-border);
    border-radius: var(--rp-r-pill);
    background: var(--rp-live-soft);
    color: var(--rp-live-text);
    font-size: 11px;
    font-weight: 850;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} .rp-live-now-dot {
    width: 9px;
    height: 9px;
    border-radius: var(--rp-r-pill);
    background: var(--rp-live);
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7);
    animation: rp-live-now-pulse 1.6s ease-out infinite;
  }
  @keyframes rp-live-now-pulse {
    0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55); }
    70% { box-shadow: 0 0 0 7px rgba(239, 68, 68, 0); }
    100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
  }
  #${OVERLAY_ID} .rp-rate {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border: 1px solid var(--rp-line-strong);
    border-radius: var(--rp-r-pill);
    background: var(--rp-surface-2);
    color: var(--rp-accent);
    font-size: 12px;
    font-weight: 800;
  }
  #${OVERLAY_ID} .rp-live-badge {
    display: block;
    margin-top: 10px;
    color: var(--rp-text-dim);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} .rp-position {
    display: inline-flex;
    margin-top: 6px;
    padding: 4px 9px;
    border-radius: var(--rp-r-xs);
    background: var(--rp-surface-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 700;
  }
  #${OVERLAY_ID} .rp-checkpoint-progress {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }
  #${OVERLAY_ID} .rp-checkpoint-step {
    position: relative;
    padding: 6px 8px 6px 22px;
    border: 1px solid var(--rp-line);
    border-radius: var(--rp-r-xs);
    background: var(--rp-surface-2);
    color: var(--rp-muted);
    font-size: 11px;
    font-weight: 650;
  }
  #${OVERLAY_ID} .rp-checkpoint-step::before {
    content: "";
    position: absolute;
    left: 9px;
    top: 50%;
    transform: translateY(-50%);
    width: 7px;
    height: 7px;
    border-radius: var(--rp-r-pill);
    background: var(--rp-line-strong);
  }
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="open"] { border-color: rgba(56, 189, 248, 0.5); color: var(--rp-accent); }
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="open"]::before { background: var(--rp-accent); }
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="submitted"],
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="closed"] { color: var(--rp-positive-text); }
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="submitted"]::before,
  #${OVERLAY_ID} .rp-checkpoint-step[data-state="closed"]::before { background: var(--rp-positive); }

  /* ---- Prediction / checkpoint ---- */
  #${OVERLAY_ID} .rp-checkpoint {
    border-color: rgba(56, 189, 248, 0.55);
    background: linear-gradient(150deg, rgba(12, 74, 110, 0.6), var(--rp-surface) 62%);
    box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.12), 0 12px 30px rgba(8, 47, 73, 0.4);
  }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-checkpoint { background: linear-gradient(150deg, rgba(2, 132, 199, 0.12), var(--rp-surface) 62%); }
  #${OVERLAY_ID} .rp-eyebrow { margin: 0; color: var(--rp-accent); font-size: 11px; font-weight: 850; letter-spacing: 0.08em; text-transform: uppercase; }
  #${OVERLAY_ID} .rp-question { margin-top: 6px; font-size: 20px; line-height: 1.15; letter-spacing: -0.01em; }
  #${OVERLAY_ID} .rp-checkpoint-timer {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 10px;
    padding: 5px 11px 5px 10px;
    border: 1px solid rgba(56, 189, 248, 0.4);
    border-radius: var(--rp-r-pill);
    background: var(--rp-accent-soft);
    color: var(--rp-accent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.01em;
  }
  #${OVERLAY_ID} .rp-checkpoint-timer::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: var(--rp-r-pill);
    background: var(--rp-accent);
    animation: rp-live-now-pulse 1.6s ease-out infinite;
  }
  #${OVERLAY_ID} .rp-prediction-options { display: grid; gap: 8px; margin-top: 12px; }
  #${OVERLAY_ID} .rp-prediction-button {
    position: relative;
    min-height: 44px;
    padding: 10px 12px 10px 42px;
    overflow-wrap: anywhere;
    border: 1px solid rgba(125, 211, 252, 0.42);
    border-radius: var(--rp-r-md);
    background: rgba(8, 47, 73, 0.5);
    color: var(--rp-text);
    cursor: pointer;
    text-align: left;
    font-weight: 750;
  }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-prediction-button { background: rgba(2, 132, 199, 0.08); }
  #${OVERLAY_ID} .rp-prediction-button::before {
    content: "";
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border-radius: var(--rp-r-pill);
    border: 2px solid var(--rp-line-strong);
    background: transparent;
  }
  #${OVERLAY_ID} .rp-prediction-button:hover:not(:disabled) { transform: translateY(-1px); border-color: var(--rp-accent); box-shadow: 0 6px 16px rgba(8, 47, 73, 0.4); }
  #${OVERLAY_ID} .rp-prediction-button:hover:not(:disabled)::before { border-color: var(--rp-accent); }
  #${OVERLAY_ID} .rp-prediction-button[data-selected="true"] { border-color: var(--rp-positive); background: var(--rp-positive-soft); color: var(--rp-text); }
  #${OVERLAY_ID} .rp-prediction-button[data-selected="true"]::before { border-color: var(--rp-positive); background: var(--rp-positive); }
  #${OVERLAY_ID} .rp-prediction-button[data-selected="true"]::after {
    content: "✓";
    position: absolute;
    left: 16.5px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    font-weight: 900;
    color: var(--rp-on-positive);
  }
  /* Once the pick is locked every option disables, but the just-confirmed choice
     must stay full-strength (the global button:disabled fade would otherwise dim
     the confirmation as much as the rejected options). */
  #${OVERLAY_ID} .rp-prediction-button:disabled[data-selected="true"] { opacity: 1; }
  #${OVERLAY_ID} .rp-locked { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; color: var(--rp-positive-text); font-weight: 700; font-size: 12.5px; }
  #${OVERLAY_ID} .rp-locked::before { content: "✓"; color: var(--rp-positive); font-weight: 900; }
  #${OVERLAY_ID} .rp-distribution { margin-top: 13px; }
  #${OVERLAY_ID} .rp-distribution-row {
    position: relative;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--rp-r-xs);
    background: var(--rp-surface-2);
    overflow: hidden;
    font-weight: 600;
  }
  #${OVERLAY_ID} .rp-distribution-row::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--rp-share, 0) * 1%);
    background: var(--rp-accent-soft);
  }
  #${OVERLAY_ID} .rp-distribution-row.rp-distribution-mine { box-shadow: inset 0 0 0 1px var(--rp-positive); }
  #${OVERLAY_ID} .rp-distribution-row.rp-distribution-mine::before { background: var(--rp-positive-soft); }
  /* Light theme only: the crowd-share fill sits at the soft-token alpha (0.12),
     which is nearly invisible over the light row surface, so the minority option
     reads as empty. Deepen both fills just enough that both rows read; the text
     stays above the fill (z-index) and dark theme keeps its brighter tokens. */
  :root[data-theme="light"] #${OVERLAY_ID} .rp-distribution-row::before { background: rgba(2, 132, 199, 0.22); }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-distribution-row.rp-distribution-mine::before { background: rgba(5, 150, 105, 0.2); }
  #${OVERLAY_ID} .rp-distribution-name,
  #${OVERLAY_ID} .rp-distribution-pct { position: relative; z-index: 1; }
  #${OVERLAY_ID} .rp-distribution-pct { font-variant-numeric: tabular-nums; font-weight: 750; }

  /* ---- Leaders + headline ---- */
  #${OVERLAY_ID} .rp-ambient-evidence { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
  #${OVERLAY_ID} .rp-headline { min-width: 0; }
  #${OVERLAY_ID} .rp-headline p { overflow-wrap: anywhere; color: var(--rp-text-dim); }
  #${OVERLAY_ID} .rp-leader {
    position: relative;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 4px 0 8px;
    font-weight: 650;
  }
  #${OVERLAY_ID} .rp-leader-name { overflow-wrap: anywhere; }
  #${OVERLAY_ID} .rp-leader-ranked::after {
    content: "";
    position: absolute;
    left: 0;
    bottom: 2px;
    height: 3px;
    border-radius: var(--rp-r-pill);
    width: calc(var(--rp-share, 0) * 1%);
    background: linear-gradient(90deg, var(--rp-accent), var(--rp-positive));
  }
  #${OVERLAY_ID} .rp-leader-share { color: var(--rp-accent); font-variant-numeric: tabular-nums; font-weight: 750; }

  /* ---- Reactions / markers ---- */
  #${OVERLAY_ID} .rp-marker-list { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 9px; }
  #${OVERLAY_ID} .rp-marker-button {
    --rp-mk: var(--rp-accent);
    --rp-mk-soft: var(--rp-accent-soft);
    min-width: 0;
    min-height: 56px;
    padding: 7px 3px 6px;
    border: 1px solid var(--rp-line-strong);
    border-radius: var(--rp-r-sm);
    background: var(--rp-surface-2);
    color: var(--rp-text);
    cursor: pointer;
    box-shadow: inset 0 2px 0 var(--rp-mk);
  }
  #${OVERLAY_ID} .rp-marker-button[data-kind="turning_point"] { --rp-mk: var(--rp-mk-turning); --rp-mk-soft: var(--rp-mk-turning-soft); }
  #${OVERLAY_ID} .rp-marker-button[data-kind="smart"] { --rp-mk: var(--rp-mk-smart); --rp-mk-soft: var(--rp-mk-smart-soft); }
  #${OVERLAY_ID} .rp-marker-button[data-kind="mistake"] { --rp-mk: var(--rp-mk-mistake); --rp-mk-soft: var(--rp-mk-mistake-soft); }
  #${OVERLAY_ID} .rp-marker-button[data-kind="betrayal"] { --rp-mk: var(--rp-mk-betrayal); --rp-mk-soft: var(--rp-mk-betrayal-soft); }
  #${OVERLAY_ID} .rp-marker-button[data-kind="clip_this"] { --rp-mk: var(--rp-mk-clip); --rp-mk-soft: var(--rp-mk-clip-soft); }
  #${OVERLAY_ID} .rp-marker-button:hover:not(:disabled) { transform: translateY(-1px); border-color: var(--rp-mk); background: var(--rp-mk-soft); }
  #${OVERLAY_ID} .rp-marker-button:active:not(:disabled) { transform: translateY(0); }
  #${OVERLAY_ID} .rp-marker-symbol { display: block; color: var(--rp-mk); font-size: 19px; font-weight: 850; line-height: 1; }
  #${OVERLAY_ID} .rp-marker-label { display: block; margin-top: 4px; overflow-wrap: break-word; hyphens: manual; font-size: 10px; font-weight: 650; line-height: 1.12; }

  /* ---- Share ---- */
  #${OVERLAY_ID} .rp-share { display: grid; gap: 9px; }
  #${OVERLAY_ID} .rp-caption-label { color: var(--rp-text-dim); font-size: 12px; font-weight: 700; }
  #${OVERLAY_ID} .rp-caption {
    width: 100%;
    min-height: 58px;
    resize: vertical;
    padding: 9px;
    border: 1px solid var(--rp-line-strong);
    border-radius: var(--rp-r-sm);
    background: var(--rp-surface-3);
    color: var(--rp-text);
  }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-caption { background: #ffffff; }
  #${OVERLAY_ID} .rp-caption:focus-visible { outline: 3px solid var(--rp-focus); outline-offset: 1px; }

  /* ---- Social clip (revealed / archived only) ---- */
  #${OVERLAY_ID} .rp-clip {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 2px;
    padding-top: 11px;
    border-top: 1px solid var(--rp-line);
  }
  #${OVERLAY_ID} .rp-clip-heading {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--rp-mk-clip);
  }
  #${OVERLAY_ID} .rp-clip-request { grid-column: 1 / -1; }
  #${OVERLAY_ID} .rp-clip-status {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    color: var(--rp-accent);
    font-size: 12px;
    font-weight: 600;
  }
  #${OVERLAY_ID} .rp-clip-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: var(--rp-r-pill);
    background: var(--rp-accent);
    box-shadow: 0 0 0 0 rgba(56, 199, 245, 0.6);
    animation: rp-live-now-pulse 1.6s ease-out infinite;
  }
  #${OVERLAY_ID} .rp-clip-status[data-clip-status="failed"] { color: var(--rp-danger); }
  #${OVERLAY_ID} .rp-clip-status[data-clip-status="busy"] { color: var(--rp-caution-text); }
  #${OVERLAY_ID} .rp-clip-download {
    grid-column: 1 / -1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-decoration: none;
  }

  /* ---- Reveal payoff ---- */
  #${OVERLAY_ID} .rp-reveal {
    border-color: rgba(52, 211, 153, 0.55);
    background: radial-gradient(120% 120% at 50% -10%, rgba(52, 211, 153, 0.28), transparent 60%), linear-gradient(180deg, rgba(20, 83, 45, 0.5), var(--rp-surface));
    box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.16), 0 16px 40px rgba(6, 60, 34, 0.4);
    text-align: center;
    animation: rp-reveal-pop 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  :root[data-theme="light"] #${OVERLAY_ID} .rp-reveal { background: radial-gradient(120% 120% at 50% -10%, rgba(5, 150, 105, 0.16), transparent 60%), linear-gradient(180deg, rgba(5, 150, 105, 0.1), var(--rp-surface)); }
  #${OVERLAY_ID} .rp-reveal-void { border-color: var(--rp-line-strong); background: var(--rp-surface); box-shadow: none; }
  @keyframes rp-reveal-pop {
    0% { opacity: 0; transform: scale(0.96) translateY(6px); }
    100% { opacity: 1; transform: none; }
  }
  #${OVERLAY_ID} .rp-reveal-eyebrow {
    margin: 0;
    color: var(--rp-positive-text);
    font-size: 11px;
    font-weight: 850;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} .rp-reveal-void .rp-reveal-eyebrow { color: var(--rp-muted); }
  #${OVERLAY_ID} .rp-reveal-crest {
    margin: 8px auto 2px;
    color: #fcd34d;
    font-size: 34px;
    line-height: 1;
    text-shadow: 0 3px 16px rgba(252, 211, 77, 0.45);
    animation: rp-crest-rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes rp-crest-rise {
    0% { opacity: 0; transform: translateY(6px) scale(0.7); }
    100% { opacity: 1; transform: none; }
  }
  #${OVERLAY_ID} .rp-winner { margin: 6px 0 0; color: var(--rp-positive-text); font-size: 26px; font-weight: 850; line-height: 1.15; letter-spacing: -0.01em; }
  #${OVERLAY_ID} .rp-reveal-void .rp-winner { color: var(--rp-text); font-size: 17px; }
  #${OVERLAY_ID} .rp-reveal-summary { color: var(--rp-text-dim); }

  /* ---- Results summary (durable post-reveal panel) ---- */
  #${OVERLAY_ID} .rp-results { display: grid; gap: 12px; animation: rp-results-rise 0.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
  #${OVERLAY_ID} .rp-results-meta { margin: 0; color: var(--rp-text-dim); font-weight: 650; }
  #${OVERLAY_ID} .rp-results-group { display: grid; gap: 7px; }
  #${OVERLAY_ID} .rp-results-standings { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  #${OVERLAY_ID} .rp-results-standing.rp-results-win { grid-column: 1 / -1; }
  #${OVERLAY_ID} .rp-results-standing {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 7px 11px;
    border: 1px solid var(--rp-line);
    border-radius: var(--rp-r-sm);
    background: var(--rp-surface-2);
    font-weight: 650;
  }
  #${OVERLAY_ID} .rp-results-standing.rp-results-win { border-color: var(--rp-positive); background: var(--rp-positive-soft); color: var(--rp-positive-text); }
  #${OVERLAY_ID} .rp-results-standing-name { min-width: 0; overflow-wrap: anywhere; }
  #${OVERLAY_ID} .rp-results-badge {
    flex: none;
    padding: 2px 9px;
    border-radius: var(--rp-r-pill);
    background: var(--rp-positive);
    color: var(--rp-on-positive);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  #${OVERLAY_ID} .rp-results-more { margin: 0; font-size: 12px; }
  #${OVERLAY_ID} .rp-results-prediction {
    display: grid;
    gap: 5px;
    padding: 9px 11px;
    border: 1px solid var(--rp-line);
    border-radius: var(--rp-r-md);
    background: var(--rp-surface);
  }
  #${OVERLAY_ID} .rp-results-prediction-title { margin: 0; font-weight: 750; }
  #${OVERLAY_ID} .rp-results-accuracy { margin: 0; color: var(--rp-positive-text); font-weight: 800; }
  #${OVERLAY_ID} .rp-results-votes { margin: 1px 0 0; font-size: 11px; }
  #${OVERLAY_ID} .rp-results-markers { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
  #${OVERLAY_ID} .rp-results-marker {
    --rp-mk: var(--rp-accent);
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 11px;
    border: 1px solid var(--rp-line);
    border-left: 3px solid var(--rp-mk);
    border-radius: var(--rp-r-sm);
    background: var(--rp-surface-2);
  }
  #${OVERLAY_ID} .rp-results-marker[data-kind="turning_point"] { --rp-mk: var(--rp-mk-turning); }
  #${OVERLAY_ID} .rp-results-marker[data-kind="smart"] { --rp-mk: var(--rp-mk-smart); }
  #${OVERLAY_ID} .rp-results-marker[data-kind="mistake"] { --rp-mk: var(--rp-mk-mistake); }
  #${OVERLAY_ID} .rp-results-marker[data-kind="betrayal"] { --rp-mk: var(--rp-mk-betrayal); }
  #${OVERLAY_ID} .rp-results-marker[data-kind="clip_this"] { --rp-mk: var(--rp-mk-clip); }
  #${OVERLAY_ID} .rp-results-marker-symbol { flex: none; color: var(--rp-mk); font-size: 16px; font-weight: 850; line-height: 1; }
  #${OVERLAY_ID} .rp-results-marker-label { font-weight: 700; overflow-wrap: anywhere; }
  #${OVERLAY_ID} .rp-results-marker-detail { margin-left: auto; color: var(--rp-muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  @keyframes rp-results-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  /* ---- Failure / cancelled / frozen / counter ---- */
  #${OVERLAY_ID} .rp-failure { border-color: rgba(248, 113, 113, 0.5); background: var(--rp-danger-soft); }
  #${OVERLAY_ID} .rp-failure .rp-section-title { color: var(--rp-danger); }
  #${OVERLAY_ID} .rp-cancelled { border-color: rgba(251, 191, 36, 0.46); background: var(--rp-caution-soft); }
  #${OVERLAY_ID} .rp-sealed { color: var(--rp-text-dim); font-weight: 600; }
  /* Anchor styled as a quiet button (mirrors .rp-clip-download) so the terminal
     states offer a real way back to the league instead of dead-ending. */
  #${OVERLAY_ID} .rp-back-to-league {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 12px;
    text-decoration: none;
  }
  #${OVERLAY_ID} .rp-frozen-position { margin: 8px 0 0; padding: 6px 9px; border-radius: var(--rp-r-xs); background: var(--rp-surface-2); color: var(--rp-text-dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  #${OVERLAY_ID} .rp-counter { display: grid; gap: 9px; }
  #${OVERLAY_ID} .rp-quiet-group {
    display: grid;
    gap: 9px;
    padding: 11px 12px;
    border: 1px solid var(--rp-line);
    border-radius: var(--rp-r-md);
    background: var(--rp-surface-2);
  }
  #${OVERLAY_ID} .rp-counter-copy { margin: 0; color: var(--rp-text-dim); font-size: 12.5px; }
  #${OVERLAY_ID} .rp-action-status { min-height: 0; margin: 0; padding: 0 12px 10px; color: var(--rp-danger); font-weight: 600; }
  #${OVERLAY_ID} .rp-action-status:empty { display: none; }

  /* ---- Ambient ---- */
  #${OVERLAY_ID}[data-ambient="true"] {
    top: auto;
    right: 10px;
    bottom: 10px;
    width: min(320px, calc(100vw - 20px));
    max-height: min(288px, calc(100vh - 20px));
  }
  #${OVERLAY_ID}[data-ambient="true"] .rp-header { padding: 9px 10px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-title { max-width: 190px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-label,
  #${OVERLAY_ID}[data-ambient="true"] .rp-live-badge,
  #${OVERLAY_ID}[data-ambient="true"] .rp-shared-status,
  #${OVERLAY_ID}[data-ambient="true"] .rp-checkpoint-progress,
  #${OVERLAY_ID}[data-ambient="true"] .rp-secondary,
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-heading { display: none; }
  /* Ambient stacks in a single column so the leaders and the full 5-reaction
     row are never clipped by the compact pane. */
  #${OVERLAY_ID}[data-ambient="true"] .rp-body { grid-template-columns: 1fr; gap: 7px; padding: 8px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-playing-status,
  #${OVERLAY_ID}[data-ambient="true"] .rp-ambient-evidence,
  #${OVERLAY_ID}[data-ambient="true"] .rp-markers { padding: 8px 9px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-playing-status { grid-column: 1 / -1; }
  /* In an ambient checkpoint the compact pane belongs to the vote card; the LIVE
     playing-status row would otherwise clip against the pane's bottom edge, so
     it is dropped the same way the mobile sheet drops it during a checkpoint. */
  #${OVERLAY_ID}[data-ambient="true"][data-state="checkpoint"] .rp-playing-status { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-position { margin-top: 5px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-ambient-evidence { grid-column: 1 / -1; grid-template-columns: 1fr; gap: 0; }
  /* Compact the leader scoreboard so the full 5-reaction row still fits the
     pane underneath it. */
  #${OVERLAY_ID}[data-ambient="true"] .rp-leaders .rp-subheading { font-size: 10px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-leaders-basis { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-leader-list { gap: 3px; margin-top: 5px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-leader { padding: 1px 0 5px; font-size: 13px; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-headline { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-leader:nth-child(n + 3) { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-markers { grid-column: 1 / -1; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-list { grid-template-columns: repeat(5, 30px); gap: 5px; margin: 0; justify-content: space-between; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-button { min-height: 30px; height: 30px; width: 30px; padding: 1px; box-shadow: inset 0 2px 0 var(--rp-mk); }
  #${OVERLAY_ID}[data-ambient="true"] .rp-marker-symbol { font-size: 14px; }
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
    max-height: 188px;
    overflow: auto;
  }
  #${OVERLAY_ID}[data-ambient="true"] .rp-checkpoint .rp-eyebrow { display: none; }
  #${OVERLAY_ID}[data-ambient="true"] .rp-checkpoint .rp-question { font-size: 16px; }

  /* ---- Mobile ---- */
  @media (max-width: 700px), (max-height: 430px) {
    #${OVERLAY_ID}:not([data-ambient="true"]) {
      top: auto;
      right: 8px;
      bottom: 8px;
      left: 8px;
      width: auto;
      max-height: min(58vh, 380px);
      border-radius: var(--rp-r-lg);
    }
    /* During the 15s prediction window, hide the playing-status card so the
       (reordered) prediction card is guaranteed above the fold on the tight
       sheet. LIVE still reads through the checkpoint timer pill. */
    #${OVERLAY_ID}:not([data-ambient="true"])[data-state="checkpoint"] .rp-playing-status { display: none; }
    /* Terminal + scheduled states carry the payoff/results and the CTAs, so give
       them a taller sheet. playing/checkpoint keep 58vh so the game canvas stays
       visible behind the overlay. */
    #${OVERLAY_ID}:not([data-ambient="true"])[data-state="scheduled"],
    #${OVERLAY_ID}:not([data-ambient="true"])[data-state="revealed"],
    #${OVERLAY_ID}:not([data-ambient="true"])[data-state="archived"],
    #${OVERLAY_ID}:not([data-ambient="true"])[data-state="failed"],
    #${OVERLAY_ID}:not([data-ambient="true"])[data-state="cancelled"] { max-height: min(82vh, 660px); }
    /* A sticky bottom fade scrim as a "more below" affordance when the sheet
       content overflows. */
    #${OVERLAY_ID}:not([data-ambient="true"]) .rp-shell::after {
      content: "";
      position: sticky;
      bottom: 0;
      height: 28px;
      margin-top: -28px;
      background: linear-gradient(transparent, var(--rp-bg-solid));
      pointer-events: none;
    }
    #${OVERLAY_ID} .rp-marker-label { font-size: 9px; }
    /* The hero countdown eases down one step on the narrow sheet. */
    #${OVERLAY_ID} .rp-countdown { font-size: 36px; }
  }

  /* ---- Reduced motion ---- */
  @media (prefers-reduced-motion: reduce) {
    #${OVERLAY_ID} * { scroll-behavior: auto !important; transition: none !important; }
    #${OVERLAY_ID} .rp-live-now-dot,
    #${OVERLAY_ID} .rp-checkpoint-timer::before,
    #${OVERLAY_ID} .rp-clip-dot,
    #${OVERLAY_ID} .rp-reveal,
    #${OVERLAY_ID} .rp-results,
    #${OVERLAY_ID} .rp-reveal-crest { animation: none !important; }
    #${OVERLAY_ID} button:hover { transform: none !important; }
  }

  /* ---- Pre-reveal host suppression (unchanged) ---- */
  body.replay-premiere-pre-reveal replay-panel,
  body.replay-premiere-pre-reveal game-right-sidebar div:has(> img[alt="replay"]),
  body.replay-premiere-pre-reveal game-right-sidebar div:has(> img[alt="play/pause"]) {
    display: none !important;
  }
`;
