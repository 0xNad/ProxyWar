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
}

export interface ReplayPremiereArchivePayload {
  premiereId: string;
  sourceRunId: string;
  sourceKind: "controlled_exhibition" | "rated_coworld";
  terminalState: "revealed" | "archived" | "failed" | "cancelled";
  revealedAt: string | null;
  replayRunKey: string | null;
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
): ReplayPremiereOverlayHandle {
  return mountReplayPremiereOverlay(buildArchivedOverlayModel(payload), {});
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
  return {
    premiereId: payload.premiereId,
    state: archivedOverlayState(payload.terminalState, outcome !== null),
    title: translateText("replay_premiere.results_page_title"),
    description: translateText("replay_premiere.archived_description"),
    sourceKind: payload.sourceKind,
    publicLabel: "premiere",
    scheduledAt: timestamp,
    actualStartAt: timestamp,
    authoritativeNow: timestamp,
    playbackRate: 1,
    mapName: "",
    matchFormat: "",
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
  return {
    premiereId: raw.premiereId,
    sourceRunId: raw.sourceRunId,
    sourceKind: raw.sourceKind,
    terminalState: raw.terminalState,
    revealedAt: raw.revealedAt === null ? null : String(raw.revealedAt),
    replayRunKey: raw.replayRunKey === null ? null : String(raw.replayRunKey),
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
    },
  };
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
