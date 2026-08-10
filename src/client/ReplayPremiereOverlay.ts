import type {
  AnalystActionKindCount,
  AnalystEventRow,
  CuratedWarRoomEvent,
  MatchStateStripInput,
  TimelineMarker,
} from "./BroadcastComposition";
import { translateText } from "./Utils";

/**
 * HEADLESS premiere view (2026-08-10). The premiere drama skin — countdown
 * page, checkpoints, war feed, reaction row, reveal ceremony, results panels
 * — is retired: watch surfaces show the plain OpenFront in-game HUD only.
 *
 * What remains here is the premiere view CONTRACT: the model/callback/handle
 * types the lifecycle brain (`ReplayPremiereRuntime.ts`) still builds and
 * drives, `warEventText` (the runtime uses it for curated headline labels),
 * and a no-op `mountReplayPremiereOverlay` that satisfies the handle so the
 * runtime and its dependency-injection seam (`overlayFactory`) stay intact.
 * Pre-live, failed, and cancelled surfaces are owned by `Main.ts`'s loading
 * veil handling; endings are the game's own WinModal.
 */

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
  /** Accepted mark to anchor the next timestamp share to, when present. */
  sourceReactionId?: string | null;
  sourceReactionSequence?: number | null;
  sourceReactionTurn?: number | null;
  /** Server-validated URL retained only when automatic clipboard delivery fails. */
  manualCopyUrl?: string | null;
  /** Clipboard stage that forced the validated URL into the manual-copy UI. */
  manualCopyReason?: ReplayPremiereShareManualCopyReason | null;
}

export type ReplayPremiereShareManualCopyReason =
  | "clipboard_rejected"
  | "clipboard_unavailable";

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
  /** Share that named the winner; null for void or zero submissions. */
  correctPercent: number | null;
  /** Distinguishes a void outcome from a scored checkpoint with zero votes. */
  accuracyStatus: "scored" | "no_predictions" | "void";
  /** Total predictions, when known (archived summary); omitted live. */
  totalPredictions?: number | null;
  options: readonly ReplayPremiereResultsPredictionOptionView[];
  /** Session-private selection; omitted on anonymous archived summaries. */
  selectedSeatId?: string | null;
}

export interface ReplayPremiereResultsMarkerView {
  kind: ReplayPremiereMarkerKind;
  turn: number;
  count: number;
}

/**
 * Results the post-reveal panel used to render. Archived summaries contain
 * only aggregates; the live runtime may attach the current session's sealed
 * picks so that viewer receives an immediate personal verdict after reveal.
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

export type ReplayPremiereWarEventKindView =
  | "attack"
  | "alliance"
  | "betrayal"
  | "nuke"
  | "conquest"
  | "emote"
  | "chat";

/**
 * One spoiler-safe live war-narrative entry (attack launched, alliance
 * formed/broken, nuke flying, emote/quick-chat). Derived client-side from the
 * simulation updates already on screen — carries no outcome information.
 */
export interface ReplayPremiereWarEventView {
  kind: ReplayPremiereWarEventKindView;
  actor: string;
  target: string | null;
  detail: string | null;
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
  /** Newest-first live war narrative shown during sealed playback. */
  warEvents?: readonly ReplayPremiereWarEventView[];
  /** Public accepted-mark aggregates per kind (0 when absent). */
  markerCounts?: Partial<Record<ReplayPremiereMarkerKind, number>>;
  /** The viewer's own accepted marks, kept separate from the public counters. */
  ownMarkerCounts?: Partial<Record<ReplayPremiereMarkerKind, number>>;
  /** Distinct viewers represented by the public mark aggregate. */
  markerParticipantCount?: number;
  /** False when exact-v1 fallback preserved only a last-known aggregate. */
  markerAggregateFresh?: boolean;
  /** Clip marks stay hidden unless server capability is explicitly proven. */
  clipMarkerAvailable?: boolean;
  /** The most recent server-accepted mark, for the confirmation line. */
  markerConfirmation?: { kind: ReplayPremiereMarkerKind; turn: number } | null;
  headlineEvent?: string | null;
  markerPolicySeatId?: string | null;
  share?: ReplayPremiereShareView | null;
  reveal?: ReplayPremiereRevealView | null;
  recovery?: ReplayPremiereRecoveryView | null;
  highlightedMoment?: ReplayPremiereHighlightedMomentView | null;
  revealPending?: boolean;
  failureCode?: ReplayPremiereFailureCode | string | null;
  ambient: boolean;
  /** Dispatcher starved of released content (frontier stall / network). */
  buffering?: boolean;
  canPredict?: boolean;
  canMark?: boolean;
  canShare?: boolean;
  canExportCounterChallenge?: boolean;
  /** Canonical clip state; live surfaces expose it only when requestable. */
  clip?: ReplayPremiereClipView | null;
  canRequestClip?: boolean;
  /**
   * Per-seat facts for the broadcast composition's competitor rail, already
   * bounded to what the caller can see: for a live Premiere that means data
   * derived from frames up to `releasedSequence` only, never anything that
   * knows the ending. This array carries only gameplay facts.
   */
  competitorRailSeats: readonly ReplayPremiereRailSeatView[];
  /** Curated ALLIANCE / FIRST STRIKE / BETRAYAL / ELIMINATION headlines, already bounded the same way. */
  warRoomEvents: readonly CuratedWarRoomEvent[];
  /** Spawn/alliance/first-strike/lead-change/betrayal/nuke/elimination/finish markers, already bounded the same way. */
  timelineMarkers: readonly TimelineMarker[];
  /** Turn span the timeline track represents. */
  totalTurns: number;
  /**
   * Highest turn a timeline click may target. Live Premiere playback has no
   * user-controlled seek at all, so this is the current released turn
   * boundary (never `null`) purely to keep every marker beyond the live edge
   * inert by construction; an archived/revealed rewatch has no more spoiler
   * concern and passes `null` (unrestricted, Full-Replay behavior).
   */
  maxSeekableTurn: number | null;
  /**
   * Already-public bounded per-turn events reused unfiltered from the SAME
   * curated War Room source (`warRoomEvents` above) — never a wider/
   * different data source. A sealed Premiere never curates `plan_change`, so
   * this can only ever surface alliance/first_strike/betrayal/elimination
   * rows, same as the War Room feed.
   */
  analystEvents: readonly AnalystEventRow[];
  /** Count of each curated War Room kind observed so far, from the same bounded source as `analystEvents`. */
  analystActionKindCounts: readonly AnalystActionKindCount[];
  /**
   * Always `"premiere_sealed"` for this view, live or archived: a sealed
   * Premiere never exposes decision-log telemetry, and the durable archive
   * summary carries no per-turn decision log either — the gap is permanent,
   * not "still mid-premiere."
   */
  analystDecisionsUnavailableReason: "premiere_sealed";
  /**
   * Always `null` for this view. `match-state-series.json` is a whole-match
   * artifact; fetching it at all during sealed live playback would put the
   * ENTIRE match's future state into client memory the instant it's fetched
   * — a genuine spoiler/integrity leak no render-time windowing can undo.
   */
  matchStateStrip: MatchStateStripInput | null;
}

export interface ReplayPremiereRailSeatView {
  seatId: string;
  /** Raw Coworld player name — matched against `PublicAgent.playerName` (exact match only) to resolve identity. */
  playerName: string;
  territoryPercent: number | null;
  inMatchRank: number | null;
  alive: boolean | null;
  /** Other seats' `playerName`s this seat is currently allied with. */
  allies: readonly string[];
  /** Other seats' `playerName`s this seat is currently at war with. */
  wars: readonly string[];
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
  sourceReactionId?: string | null;
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
  /** War Room "jump to turn" — only wired where the underlying map can actually seek (e.g. an archived rewatch); a live Premiere leaves this unset. */
  onJumpToTurn?: (turn: number, sequence: number) => void;
  /** Timeline marker click — same seek-availability caveat as `onJumpToTurn`. */
  onSeek?: (turn: number) => void;
}

export interface ReplayPremiereOverlayHandle {
  readonly element: HTMLElement;
  hydrate(model: ReplayPremiereOverlayModel): void;
  dispose(): void;
}

const OVERLAY_ID = "replay-premiere-overlay";

let activeOverlay: ReplayPremiereOverlayHandle | null = null;

/**
 * No-op view mount. The runtime keeps building models and calling
 * `hydrate` on every frame/state change; nothing renders. The element is
 * created (id preserved) but never attached to the document.
 */
export function mountReplayPremiereOverlay(
  initialModel: ReplayPremiereOverlayModel,
  callbacks: ReplayPremiereOverlayCallbacks = {},
): ReplayPremiereOverlayHandle {
  void initialModel;
  void callbacks;
  activeOverlay?.dispose();

  const element = document.createElement("aside");
  element.id = OVERLAY_ID;

  let disposed = false;
  const handle: ReplayPremiereOverlayHandle = {
    element,
    hydrate(model: ReplayPremiereOverlayModel) {
      void model;
      if (disposed) return;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      element.remove();
      if (activeOverlay === handle) {
        activeOverlay = null;
      }
    },
  };

  activeOverlay = handle;
  return handle;
}

export function warEventText(event: ReplayPremiereWarEventView): string {
  const actor = safeDisplay(event.actor);
  const target = event.target === null ? null : safeDisplay(event.target);
  switch (event.kind) {
    case "attack":
      return translateText("replay_premiere.war_attack", {
        actor,
        target: target ?? "",
      });
    case "alliance":
      return translateText("replay_premiere.war_alliance", {
        actor,
        target: target ?? "",
      });
    case "betrayal":
      return translateText("replay_premiere.war_betrayal", {
        actor,
        target: target ?? "",
      });
    case "nuke":
      return translateText("replay_premiere.war_nuke", { actor });
    case "conquest":
      return translateText("replay_premiere.war_conquest", {
        actor,
        target: target ?? "",
      });
    case "emote": {
      const detail = safeDisplay(event.detail ?? "");
      return target === null
        ? translateText("replay_premiere.war_emote_all", { actor, detail })
        : translateText("replay_premiere.war_emote", {
            actor,
            target,
            detail,
          });
    }
    case "chat": {
      // detail carries the quick-chat "{category}.{key}" suffix; translate
      // through the canonical chat phrase table.
      const phrase =
        event.detail === null
          ? ""
          : translateText(`chat.${safeDisplay(event.detail)}`);
      return target === null
        ? translateText("replay_premiere.war_chat_all", {
            actor,
            message: phrase,
          })
        : translateText("replay_premiere.war_chat", {
            actor,
            target,
            message: phrase,
          });
    }
  }
}

function safeDisplay(value: unknown): string {
  return typeof value === "string" ? value : "";
}
