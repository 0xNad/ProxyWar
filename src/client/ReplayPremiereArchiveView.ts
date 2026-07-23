import {
  mountReplayScopedLeagueClipControl,
  type ReplayScopedLeagueClipControlHandle,
} from "./ReplayClipControl";
import {
  mountReplayPremiereOverlay,
  type ReplayPremiereCheckpointView,
  type ReplayPremiereMarkerKind,
  type ReplayPremiereOverlayHandle,
  type ReplayPremiereOverlayModel,
  type ReplayPremierePolicyView,
  type ReplayPremierePublicState,
  type ReplayPremiereResultsPredictionView,
  type ReplayPremiereResultsSummaryView,
  type ReplayPremiereRevealView,
} from "./ReplayPremiereOverlay";
import { translateText } from "./Utils";

const ARCHIVE_DATA_ELEMENT_ID = "proxywar-premiere-archive";
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const MARKER_KINDS: readonly ReplayPremiereMarkerKind[] = [
  "turning_point",
  "smart",
  "mistake",
  "betrayal",
  "clip_this",
];

interface ArchiveSummaryStanding {
  seatId: string;
  displayName: string;
  won: boolean;
}

interface ArchiveSummaryOutcome {
  winner: unknown;
  turnCount: number;
  completedAt: string;
  standings: ArchiveSummaryStanding[];
}

interface ArchiveSummaryPredictionOption {
  seatId: string;
  count: number;
}

interface ArchiveSummaryPrediction {
  checkpointId: string;
  sequence: number;
  totalPredictions: number;
  correctPredictions: number | null;
  options: ArchiveSummaryPredictionOption[];
}

interface ArchiveSummaryMarker {
  kind: string;
  turn: number;
  count: number;
}

interface ArchiveSummary {
  premiereId: string;
  sourceRunId: string;
  sourceKind: "controlled_exhibition" | "rated_coworld";
  terminalState: "revealed" | "archived" | "failed" | "cancelled";
  revealedAt: string | null;
  outcome: ArchiveSummaryOutcome | null;
  predictions: ArchiveSummaryPrediction[];
  markers: ArchiveSummaryMarker[];
  /** Optional public labels; legacy summaries built before them carry neither. */
  mapLabel: string | null;
  formatLabel: string | null;
}

export interface ReplayPremiereArchiveClip {
  /** Same-origin durable download route (`/premiere/<id>/clip.mp4`). */
  url: string;
  byteLength: number;
}

export interface ReplayPremiereArchiveClipGenerationTarget {
  kind: "league_run";
  replayRunKey: string;
}

export interface ReplayPremiereArchivePayload {
  premiereId: string;
  sourceRunId: string;
  sourceKind: "controlled_exhibition" | "rated_coworld";
  terminalState: "revealed" | "archived" | "failed" | "cancelled";
  revealedAt: string | null;
  replayRunKey: string | null;
  /** Retained replay identity authorized by the archive router for generation. */
  clipGenerationTarget: ReplayPremiereArchiveClipGenerationTarget | null;
  /** Durable archived clip; null (or absent in older payloads) => no section. */
  clip: ReplayPremiereArchiveClip | null;
  summary: ArchiveSummary;
}

/**
 * Reads the archived-premiere payload injected as a non-executing JSON island by
 * the archive router. Returns null when absent or malformed, so the caller falls
 * back to the ordinary live premiere flow.
 */
export function readReplayPremiereArchivePayload(
  documentRef: Document = document,
): ReplayPremiereArchivePayload | null {
  const element = documentRef.getElementById(ARCHIVE_DATA_ELEMENT_ID);
  if (element === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(element.textContent ?? "");
  } catch {
    return null;
  }
  return parseArchivePayload(raw);
}

export function mountArchivedReplayPremiereOverlay(
  payload: ReplayPremiereArchivePayload,
  ambient = false,
): ReplayPremiereOverlayHandle {
  const model = { ...buildArchivedOverlayModel(payload), ambient };
  let clipControl: ReplayScopedLeagueClipControlHandle | null = null;
  const overlayHandle = mountReplayPremiereOverlay(model, {
    // The archived page is read-only, but the ambient toggle must still work:
    // re-mount the same summary with the ambient flag flipped. This gives the
    // archived surface a real compact mode so the league replay behind it is
    // watchable, instead of a live-looking button that silently no-ops.
    onAmbientChange: (request): void => {
      clipControl?.dispose();
      overlayHandle.dispose();
      mountArchivedReplayPremiereOverlay(payload, request.ambient);
    },
  });
  // The read-only archived model drops the whole share card, leaving only the
  // ambient toggle and an undiscoverable replay. Add back just two actions the
  // durable page needs — copy the premiere link, and a loud "watch" entry into
  // ambient mode when the underlying league replay exists — without resurrecting
  // the full share surface. They render outside the overlay's own body markup
  // (which this batch does not modify), so they are re-added on each mount.
  clipControl = augmentArchivedOverlayActions(
    overlayHandle.element,
    payload,
    ambient,
  );
  return {
    element: overlayHandle.element,
    hydrate: (nextModel): void => overlayHandle.hydrate(nextModel),
    dispose(): void {
      clipControl?.dispose();
      overlayHandle.dispose();
    },
  };
}

/**
 * Appends the copy-link / watch-replay actions into the mounted overlay body.
 * Only in the expanded (non-ambient) view: ambient is a clean compact watch
 * surface, so the extra chrome stays out of it.
 */
function augmentArchivedOverlayActions(
  overlayElement: HTMLElement,
  payload: ReplayPremiereArchivePayload,
  ambient: boolean,
): ReplayScopedLeagueClipControlHandle | null {
  if (ambient) return null;
  const body = overlayElement.querySelector(".rp-body");
  if (body === null) return null;

  const actions = document.createElement("section");
  actions.className = "rp-section rp-archived-actions";
  // Inline layout only: the overlay stylesheet (a separate file) is untouched
  // this batch, so these two buttons are laid out here without new CSS.
  actions.style.display = "grid";
  actions.style.gap = "8px";

  if (payload.replayRunKey !== null) {
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "rp-button rp-button-primary";
    watch.textContent = translateText("replay_premiere.watch_full_replay");
    watch.addEventListener("click", () => {
      mountArchivedReplayPremiereOverlay(payload, true);
    });
    actions.append(watch);
  }

  // Durable social clip: present only when the server statted a real artifact.
  // Absent clip => no element at all — the durable page never shows a broken
  // or disabled download affordance for old archives without a clip. The `??`
  // tolerates payloads built before the field existed.
  const clip = payload.clip ?? null;
  if (clip !== null) {
    const downloadClip = document.createElement("a");
    downloadClip.className =
      "rp-button rp-button-primary rp-archived-clip-download";
    downloadClip.href = clip.url;
    downloadClip.setAttribute("download", "");
    downloadClip.textContent = translateText(
      "replay_premiere.archived_clip_download",
    );
    actions.append(downloadClip);
  }

  // A retained rated replay may generate any additional moment through the
  // ordinary league-run clip path, but playback identity alone is not
  // generation authority. The server's explicit generation target must match
  // that playback run exactly. Missing, malformed, or mismatched targets hide
  // the control without probing capability. This path is replay-scoped: it
  // never bootstraps a Premiere interaction session and deliberately coexists
  // with the promoted-download fast path.
  let clipControl: ReplayScopedLeagueClipControlHandle | null = null;
  const clipGenerationRunKey = validatedClipGenerationRunKey(payload);
  if (clipGenerationRunKey !== null) {
    const clipGenerator = document.createElement("section");
    clipGenerator.className = "rp-archived-clip-generation ai-league-clip";
    clipGenerator.dataset.aiLeagueClip = "";
    actions.append(clipGenerator);
    clipControl = mountReplayScopedLeagueClipControl({
      container: clipGenerator,
      runKey: clipGenerationRunKey,
    });
  }

  const copyLink = document.createElement("button");
  copyLink.type = "button";
  copyLink.className = "rp-button rp-button-quiet";
  copyLink.textContent = translateText("replay_premiere.copy_link");
  copyLink.addEventListener("click", () => {
    const url = `${window.location.origin}/premiere/${payload.premiereId}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  });
  actions.append(copyLink);

  // Placed right after the first body card (the archived header / winner reveal)
  // so the watch CTA sits high, above the detailed results.
  body.insertBefore(actions, body.children[1] ?? null);
  return clipControl;
}

function buildArchivedOverlayModel(
  payload: ReplayPremiereArchivePayload,
): ReplayPremiereOverlayModel {
  const summary = payload.summary;
  const outcome = summary.outcome;
  const standings = outcome?.standings ?? [];
  const nameOf = (seatId: string): string =>
    standings.find((standing) => standing.seatId === seatId)?.displayName ??
    seatId;
  const wonSeats = standings.filter((standing) => standing.won);
  const results: ReplayPremiereResultsSummaryView | null =
    outcome === null
      ? null
      : {
          turnCount: outcome.turnCount,
          standings: standings.map((standing) => ({
            seatId: standing.seatId,
            displayName: standing.displayName,
            won: standing.won,
          })),
          predictions: summary.predictions.map(
            (prediction): ReplayPremiereResultsPredictionView => ({
              checkpointId: prediction.checkpointId,
              sequence: prediction.sequence,
              correctPercent:
                prediction.correctPredictions !== null &&
                prediction.totalPredictions > 0
                  ? (prediction.correctPredictions /
                      prediction.totalPredictions) *
                    100
                  : null,
              accuracyStatus:
                prediction.correctPredictions === null
                  ? "void"
                  : prediction.totalPredictions === 0
                    ? "no_predictions"
                    : "scored",
              totalPredictions: prediction.totalPredictions,
              options: prediction.options.map((option) => ({
                seatId: option.seatId,
                displayName: nameOf(option.seatId),
                percent:
                  prediction.totalPredictions > 0
                    ? (option.count / prediction.totalPredictions) * 100
                    : 0,
              })),
            }),
          ),
          markers: summary.markers
            .filter(
              (
                marker,
              ): marker is ArchiveSummaryMarker & {
                kind: ReplayPremiereMarkerKind;
              } =>
                MARKER_KINDS.includes(marker.kind as ReplayPremiereMarkerKind),
            )
            .map((marker) => ({
              kind: marker.kind,
              turn: marker.turn,
              count: marker.count,
            })),
        };
  const reveal: ReplayPremiereRevealView | null =
    outcome === null
      ? null
      : wonSeats.length === 1
        ? { outcome: "winner", winnerSeatId: wonSeats[0].seatId, results }
        : { outcome: "void", winnerSeatId: null, results };
  const timestamp = payload.revealedAt ?? new Date().toISOString();
  const soleWinner = wonSeats.length === 1 ? wonSeats[0] : null;
  const mapLabel =
    typeof summary.mapLabel === "string" && summary.mapLabel.length > 0
      ? summary.mapLabel
      : null;
  return {
    premiereId: payload.premiereId,
    state: archivedOverlayState(payload.terminalState, outcome !== null),
    // Winner-led identity once revealed: the header H1 names the winner (or
    // "Results" for a void), so the durable page is not a generic "Premiere
    // replay". Outcome-free archives keep the generic title.
    title: archivedTitle(outcome !== null, soleWinner),
    description: archivedIdentitySubline(
      outcome !== null,
      standings.length,
      mapLabel,
      timestamp,
    ),
    sourceKind: payload.sourceKind,
    publicLabel: "premiere",
    scheduledAt: timestamp,
    actualStartAt: timestamp,
    authoritativeNow: timestamp,
    playbackRate: 1,
    mapName: mapLabel ?? "",
    matchFormat:
      typeof summary.formatLabel === "string" && summary.formatLabel.length > 0
        ? summary.formatLabel
        : "",
    policies: standings.map(
      (standing): ReplayPremierePolicyView => ({
        seatId: standing.seatId,
        displayName: standing.displayName,
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: standing.displayName,
          declaredVersion: "",
          manifestSha256: "",
          contentSha256: "",
        },
      }),
    ),
    releasedSequence: 0,
    currentTurn: outcome?.turnCount ?? null,
    checkpoints: buildArchivedCheckpoints(summary.predictions, nameOf),
    activeCheckpointId: null,
    leaders: [],
    headlineEvent: null,
    markerPolicySeatId: null,
    share: null,
    reveal,
    recovery: null,
    highlightedMoment: null,
    revealPending: false,
    failureCode: null,
    ambient: false,
    canPredict: false,
    canMark: false,
    canShare: false,
    canExportCounterChallenge: false,
    clip: null,
    canRequestClip: false,
  };
}

/**
 * The archived page is always read-only, so an outcome-bearing terminal uses the
 * archived presentation (archived heading + reveal payoff + results, no live
 * marker/ambient controls). An outcome-free terminal falls back to the neutral
 * ended presentation for its exact state.
 */
function archivedOverlayState(
  terminalState: ReplayPremiereArchivePayload["terminalState"],
  hasOutcome: boolean,
): ReplayPremierePublicState {
  if (hasOutcome) return "archived";
  return terminalState === "cancelled" ? "cancelled" : "failed";
}

function archivedTitle(
  hasOutcome: boolean,
  soleWinner: ArchiveSummaryStanding | null,
): string {
  if (!hasOutcome) return translateText("replay_premiere.results_page_title");
  if (soleWinner === null)
    return translateText("replay_premiere.results_heading");
  return translateText("replay_premiere.archived_winner_heading", {
    name: soleWinner.displayName,
  });
}

function archivedIdentitySubline(
  hasOutcome: boolean,
  agents: number,
  mapLabel: string | null,
  timestamp: string,
): string {
  if (!hasOutcome) return translateText("replay_premiere.archived_description");
  const date = formatArchivedDate(timestamp);
  return mapLabel === null
    ? translateText("replay_premiere.archived_identity_subline_no_map", {
        agents,
        date,
      })
    : translateText("replay_premiere.archived_identity_subline", {
        map: mapLabel,
        agents,
        date,
      });
}

function formatArchivedDate(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildArchivedCheckpoints(
  predictions: readonly ArchiveSummaryPrediction[],
  nameOf: (seatId: string) => string,
): readonly [ReplayPremiereCheckpointView, ReplayPremiereCheckpointView] {
  const toView = (
    prediction: ArchiveSummaryPrediction | undefined,
    index: number,
  ): ReplayPremiereCheckpointView => {
    if (prediction === undefined) {
      return {
        id: `cp_archivepad_${index}`,
        sequence: 0,
        state: "closed",
        closesAt: null,
        options: [],
        selectedSeatId: null,
      };
    }
    const total = prediction.totalPredictions;
    return {
      id: prediction.checkpointId,
      sequence: prediction.sequence,
      state: "closed",
      closesAt: null,
      options: prediction.options.map((option) => ({
        seatId: option.seatId,
        displayName: nameOf(option.seatId),
      })),
      selectedSeatId: null,
      distribution:
        total > 0
          ? prediction.options.map((option) => ({
              seatId: option.seatId,
              percent: Math.round((option.count / total) * 100),
            }))
          : undefined,
    };
  };
  return [toView(predictions[0], 0), toView(predictions[1], 1)];
}

function parseArchivePayload(
  raw: unknown,
): ReplayPremiereArchivePayload | null {
  if (!isRecord(raw) || !isRecord(raw.summary)) return null;
  const summary = raw.summary;
  if (
    !isPremiereId(raw.premiereId) ||
    raw.premiereId !== summary.premiereId ||
    typeof raw.sourceRunId !== "string" ||
    !isSourceKind(raw.sourceKind) ||
    !isTerminalState(raw.terminalState) ||
    (raw.replayRunKey !== null && typeof raw.replayRunKey !== "string") ||
    (raw.revealedAt !== null && typeof raw.revealedAt !== "string") ||
    !isSourceKind(summary.sourceKind) ||
    !isTerminalState(summary.terminalState) ||
    !Array.isArray(summary.predictions) ||
    !Array.isArray(summary.markers)
  ) {
    return null;
  }
  const outcome = parseOutcome(summary.outcome);
  if (outcome === undefined) return null;
  const predictions: ArchiveSummaryPrediction[] = [];
  for (const entry of summary.predictions) {
    const prediction = parsePrediction(entry);
    if (prediction === null) return null;
    predictions.push(prediction);
  }
  const markers: ArchiveSummaryMarker[] = [];
  for (const entry of summary.markers) {
    if (
      !isRecord(entry) ||
      typeof entry.kind !== "string" ||
      !Number.isFinite(entry.turn) ||
      !Number.isFinite(entry.count)
    ) {
      return null;
    }
    markers.push({
      kind: entry.kind,
      turn: Number(entry.turn),
      count: Number(entry.count),
    });
  }
  const replayRunKey =
    raw.replayRunKey === null ? null : String(raw.replayRunKey);
  return {
    premiereId: raw.premiereId,
    sourceRunId: raw.sourceRunId,
    sourceKind: raw.sourceKind,
    terminalState: raw.terminalState,
    revealedAt: raw.revealedAt === null ? null : String(raw.revealedAt),
    replayRunKey,
    clipGenerationTarget: parseClipGenerationTarget(
      raw.clipGenerationTarget,
      replayRunKey,
    ),
    clip: parseArchiveClip(raw.clip, raw.premiereId),
    summary: {
      premiereId: raw.premiereId,
      sourceRunId: String(summary.sourceRunId ?? raw.sourceRunId),
      sourceKind: summary.sourceKind,
      terminalState: summary.terminalState,
      revealedAt:
        summary.revealedAt === null || summary.revealedAt === undefined
          ? null
          : String(summary.revealedAt),
      outcome,
      predictions,
      markers,
      mapLabel: optionalLabel(summary.mapLabel),
      formatLabel: optionalLabel(summary.formatLabel),
    },
  };
}

/**
 * Optional generation authority is tolerant for legacy archives, but strict
 * when present: only a league target matching the page's exact playback run
 * can reach the shared clip controller.
 */
function parseClipGenerationTarget(
  value: unknown,
  replayRunKey: string | null,
): ReplayPremiereArchiveClipGenerationTarget | null {
  if (
    replayRunKey === null ||
    !isRecord(value) ||
    value.kind !== "league_run" ||
    value.replayRunKey !== replayRunKey
  ) {
    return null;
  }
  return { kind: "league_run", replayRunKey };
}

/** Revalidates direct callers too; parsing is not the only construction path. */
function validatedClipGenerationRunKey(
  payload: ReplayPremiereArchivePayload,
): string | null {
  const target = payload.clipGenerationTarget ?? null;
  return target !== null &&
    target.kind === "league_run" &&
    payload.replayRunKey !== null &&
    target.replayRunKey === payload.replayRunKey
    ? target.replayRunKey
    : null;
}

/** Tolerant read of an optional public label; anything non-string becomes null. */
function optionalLabel(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Tolerant clip parse: the clip is auxiliary, so anything malformed (or a
 * pre-clip payload with no field at all) renders as "no clip section", never a
 * rejected page. The url must be EXACTLY this premiere's same-origin durable
 * clip route — nothing else is ever linked.
 */
function parseArchiveClip(
  value: unknown,
  premiereId: string,
): ReplayPremiereArchiveClip | null {
  if (!isRecord(value)) return null;
  const expectedUrl = `/premiere/${premiereId}/clip.mp4`;
  if (value.url !== expectedUrl) return null;
  if (
    typeof value.byteLength !== "number" ||
    !Number.isFinite(value.byteLength) ||
    value.byteLength <= 0
  ) {
    return null;
  }
  return { url: expectedUrl, byteLength: Math.floor(value.byteLength) };
}

function parseOutcome(raw: unknown): ArchiveSummaryOutcome | null | undefined {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !Number.isFinite(raw.turnCount) ||
    typeof raw.completedAt !== "string" ||
    !Array.isArray(raw.standings)
  ) {
    return undefined;
  }
  const standings: ArchiveSummaryStanding[] = [];
  for (const entry of raw.standings) {
    if (
      !isRecord(entry) ||
      typeof entry.seatId !== "string" ||
      typeof entry.displayName !== "string" ||
      typeof entry.won !== "boolean"
    ) {
      return undefined;
    }
    standings.push({
      seatId: entry.seatId,
      displayName: entry.displayName,
      won: entry.won,
    });
  }
  return {
    winner: raw.winner ?? null,
    turnCount: Number(raw.turnCount),
    completedAt: raw.completedAt,
    standings,
  };
}

function parsePrediction(raw: unknown): ArchiveSummaryPrediction | null {
  if (
    !isRecord(raw) ||
    typeof raw.checkpointId !== "string" ||
    !Number.isFinite(raw.sequence) ||
    !Number.isFinite(raw.totalPredictions) ||
    (raw.correctPredictions !== null &&
      !Number.isFinite(raw.correctPredictions)) ||
    !Array.isArray(raw.options)
  ) {
    return null;
  }
  const options: ArchiveSummaryPredictionOption[] = [];
  for (const entry of raw.options) {
    if (
      !isRecord(entry) ||
      typeof entry.seatId !== "string" ||
      !Number.isFinite(entry.count)
    ) {
      return null;
    }
    options.push({ seatId: entry.seatId, count: Number(entry.count) });
  }
  return {
    checkpointId: raw.checkpointId,
    sequence: Number(raw.sequence),
    totalPredictions: Number(raw.totalPredictions),
    correctPredictions:
      raw.correctPredictions === null ? null : Number(raw.correctPredictions),
    options,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPremiereId(value: unknown): value is string {
  return typeof value === "string" && PREMIERE_ID_PATTERN.test(value);
}

function isSourceKind(
  value: unknown,
): value is "controlled_exhibition" | "rated_coworld" {
  return value === "controlled_exhibition" || value === "rated_coworld";
}

function isTerminalState(
  value: unknown,
): value is "revealed" | "archived" | "failed" | "cancelled" {
  return (
    value === "revealed" ||
    value === "archived" ||
    value === "failed" ||
    value === "cancelled"
  );
}
