/**
 * Archived-premiere payload reading. The archived-results presentation that
 * used to live here is retired (2026-08-10: watch surfaces show the plain
 * OpenFront HUD); an archived premiere now opens straight into the ordinary
 * league replay when its run is still mirrored. Only the payload contract
 * survives: the archive router injects a non-executing JSON island that names
 * the premiere and (when retained) its replay run.
 */

const ARCHIVE_DATA_ELEMENT_ID = "proxywar-premiere-archive";
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;

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
