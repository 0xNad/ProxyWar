import {
  decodePremiereAuthoritativeResult,
  verifyPremiereAuthoritativeResultBytes,
  type PremiereCanonicalAuthoritativeResult,
  type PremiereWinnerTuple,
} from "./ReplayPremiereAuthoritativeResult";
import type { PremiereSourceKind } from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type { ReplayPremiereHttpTarget } from "./ReplayPremiereHttp";
import {
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  REPLAY_PREMIERE_REACTION_KINDS,
  type ReplayPremiereReactionKind,
} from "./ReplayPremiereInteractions";

export const REPLAY_PREMIERE_RESULT_SUMMARY_KIND =
  "replay_premiere_result_summary_v1" as const;

/** The summary keeps at most this many notable markers (top by count then turn). */
export const REPLAY_PREMIERE_MAX_SUMMARY_MARKERS = 24;

export type PremiereResultTerminalState =
  | "revealed"
  | "archived"
  | "failed"
  | "cancelled";

/**
 * A revealed premiere's outcome. `winner === null` is a void (no unambiguous
 * winner). Standings carry only the public per-seat win flag; there is no rank.
 */
export interface PremiereResultSummaryWinner {
  category: "player" | "team" | "nation";
  groupLabel: string | null;
  seatIds: string[];
}

export interface PremiereResultSummaryStanding {
  seatId: string;
  displayName: string;
  won: boolean;
}

export interface PremiereResultSummaryOutcome {
  winner: PremiereResultSummaryWinner | null;
  turnCount: number;
  completedAt: string;
  standings: PremiereResultSummaryStanding[];
}

export interface PremiereResultSummaryPredictionOption {
  seatId: string;
  count: number;
}

export interface PremiereResultSummaryPrediction {
  checkpointId: string;
  sequence: number;
  totalPredictions: number;
  /** Ordered exactly like the checkpoint's option seats; each carries a tally. */
  options: PremiereResultSummaryPredictionOption[];
  /** Count of predictions that named the actual winner; null when void. */
  correctPredictions: number | null;
}

export interface PremiereResultSummaryMarker {
  kind: ReplayPremiereReactionKind;
  turn: number;
  count: number;
}

/**
 * The tiny, durable, aggregate-only artifact that outlives a premiere's bulk.
 * It is written post-reveal only (outcome is null for failed/cancelled), and
 * carries NO per-session, per-participant, or per-request data.
 */
export interface PremiereResultSummaryV1 {
  schemaVersion: 1;
  summaryKind: typeof REPLAY_PREMIERE_RESULT_SUMMARY_KIND;
  premiereId: string;
  sourceRunId: string;
  sourceKind: PremiereSourceKind;
  publicationCommitmentHash: string;
  terminalState: PremiereResultTerminalState;
  revealedAt: string | null;
  reclaimedAt: string;
  outcome: PremiereResultSummaryOutcome | null;
  predictions: PremiereResultSummaryPrediction[];
  markers: PremiereResultSummaryMarker[];
  /**
   * Public, non-viewer match metadata (the same pre-reveal labels the /league
   * contract card already exposes). Optional and additive: legacy summaries
   * built before these fields existed carry neither, so every consumer must
   * tolerate their absence. When present they are covered by `summaryHash`.
   */
  mapLabel?: string;
  formatLabel?: string;
  summaryHash: string;
}

type PremiereResultSummaryPreimage = Omit<
  PremiereResultSummaryV1,
  "summaryHash"
>;

/**
 * Field-name fragments that only ever belong to per-viewer records. If any of
 * these appears as a key (or as a recognizable id value) anywhere in a summary,
 * the aggregate-only guarantee has been violated and the summary is rejected.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  "participant",
  "session",
  "cookie",
  "idempotency",
  "requesthash",
  "requestbucket",
  "requester",
  "attribution",
  "heartbeat",
  "createdby",
  "clientaddress",
  "remoteaddress",
  "guesthmac",
] as const;

const PER_VIEWER_ID_VALUE =
  /^(?:guest_[a-z0-9]{16,}|sess_[a-z0-9]{16,}|ip_[a-f0-9]{32,64})$/;

export interface PremiereResultSummaryInput {
  premiereId: string;
  sourceRunId: string;
  sourceKind: PremiereSourceKind;
  publicationCommitmentHash: string;
  terminalState: PremiereResultTerminalState;
  revealedAt: string | null;
  reclaimedAt: string;
  outcome: PremiereResultSummaryOutcome | null;
  predictions: PremiereResultSummaryPrediction[];
  markers: PremiereResultSummaryMarker[];
  /** Optional public match labels (see PremiereResultSummaryV1). */
  mapLabel?: string;
  formatLabel?: string;
}

/**
 * Builds the durable result summary from a terminal premiere's live runtime and
 * interaction aggregates. Outcome, predictions, and markers are populated only
 * when the premiere has a committed reveal; failed/cancelled premieres yield a
 * spoiler-neutral summary with a null outcome and no aggregates.
 */
export function buildPremiereResultSummaryFromTarget(options: {
  target: ReplayPremiereHttpTarget;
  terminalState: PremiereResultTerminalState;
  reclaimedAt: string;
}): PremiereResultSummaryV1 {
  const { target } = options;
  assertCanonicalTimestamp(options.reclaimedAt, "reclaimedAt");
  const bootstrap = target.runtime.readBootstrap();
  const reveal =
    options.terminalState === "revealed" || options.terminalState === "archived"
      ? target.runtime.readReveal()
      : null;

  let outcome: PremiereResultSummaryOutcome | null = null;
  let predictions: PremiereResultSummaryPrediction[] = [];
  let markers: PremiereResultSummaryMarker[] = [];
  let revealedAt: string | null = null;

  if (reveal !== null) {
    if (reveal.premiereId !== bootstrap.premiereId) {
      throw summaryIntegrity("summary_reveal_identity_mismatch");
    }
    const resultBytes = decodePremiereAuthoritativeResult(
      reveal.authoritativeResult,
    );
    const canonical = verifyPremiereAuthoritativeResultBytes({
      eligibilityRecord: reveal.eligibilityRecord,
      resultBytes,
    });
    outcome = summarizeOutcome(canonical);
    predictions = summarizePredictions(target);
    markers = summarizeMarkers(target);
    revealedAt = reveal.revealedAt;
  }

  // The public definition carries the same spoiler-neutral map/format labels the
  // /league contract card shows. Read defensively: a malformed or legacy runtime
  // that lacks the definition simply omits the (optional, cosmetic) labels rather
  // than failing the reclamation path.
  const definition = bootstrap.publicDefinition;
  return buildPremiereResultSummary({
    premiereId: bootstrap.premiereId,
    sourceRunId: bootstrap.provenance.sourceRunId,
    sourceKind: bootstrap.provenance.sourceKind,
    publicationCommitmentHash: bootstrap.publicationCommitmentHash,
    terminalState: options.terminalState,
    revealedAt,
    reclaimedAt: options.reclaimedAt,
    outcome,
    predictions,
    markers,
    mapLabel: optionalPublicLabel(definition?.map?.label),
    formatLabel: optionalPublicLabel(definition?.matchFormat?.label),
  });
}

/** Accepts a non-empty string label, otherwise omits the optional field. */
function optionalPublicLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Pure builder: hashes and freezes an already-derived aggregate summary. */
export function buildPremiereResultSummary(
  input: PremiereResultSummaryInput,
): PremiereResultSummaryV1 {
  const preimage: PremiereResultSummaryPreimage = {
    schemaVersion: 1,
    summaryKind: REPLAY_PREMIERE_RESULT_SUMMARY_KIND,
    premiereId: input.premiereId,
    sourceRunId: input.sourceRunId,
    sourceKind: input.sourceKind,
    publicationCommitmentHash: input.publicationCommitmentHash,
    terminalState: input.terminalState,
    revealedAt: input.revealedAt,
    reclaimedAt: input.reclaimedAt,
    outcome: input.outcome,
    predictions: input.predictions,
    markers: input.markers,
  };
  // Additive optional fields are only ever written when present, never as
  // `undefined` (canonical hashing rejects undefined). A summary without labels
  // therefore hashes byte-identically to the legacy 12-field form.
  if (input.mapLabel !== undefined) {
    preimage.mapLabel = input.mapLabel;
  }
  if (input.formatLabel !== undefined) {
    preimage.formatLabel = input.formatLabel;
  }
  validateSummaryPreimage(preimage);
  const summary: PremiereResultSummaryV1 = {
    ...preimage,
    summaryHash: hashReplayPremiereJson(asJson(preimage)),
  };
  const frozen = cloneAndFreezeReplayPremiereValue(summary, "premiere summary");
  assertPremiereResultSummaryAggregateOnly(frozen);
  return frozen;
}

function summarizeOutcome(
  canonical: PremiereCanonicalAuthoritativeResult,
): PremiereResultSummaryOutcome {
  return {
    winner: summarizeWinner(canonical.winner),
    turnCount: canonical.turnCount,
    completedAt: canonical.completedAt,
    standings: canonical.seats.map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      won: seat.won,
    })),
  };
}

function summarizeWinner(
  winner: PremiereWinnerTuple | null,
): PremiereResultSummaryWinner | null {
  if (winner === null) return null;
  const [category, ...rest] = winner;
  if (category === "player") {
    return { category, groupLabel: null, seatIds: [...rest] };
  }
  const [groupLabel, ...seatIds] = rest;
  return { category, groupLabel, seatIds: [...seatIds] };
}

function summarizePredictions(
  target: ReplayPremiereHttpTarget,
): PremiereResultSummaryPrediction[] {
  // participantId=null yields the aggregate view with zero per-viewer fields.
  return target.interactions.readCheckpoints(null).map((checkpoint) => ({
    checkpointId: checkpoint.id,
    sequence: checkpoint.sequence,
    totalPredictions: checkpoint.totalPredictions ?? 0,
    options: checkpoint.optionSeatIds.map((seatId) => ({
      seatId,
      count: checkpoint.distribution?.[seatId] ?? 0,
    })),
    correctPredictions: checkpoint.crowdAccuracy?.correctPredictions ?? null,
  }));
}

function summarizeMarkers(
  target: ReplayPremiereHttpTarget,
): PremiereResultSummaryMarker[] {
  // Markers have no aggregate read API, so the per-viewer reaction records are
  // grouped here by (kind, turn) and every participant id is dropped in the
  // process. Only the resulting tallies enter the summary.
  const tallies = new Map<string, PremiereResultSummaryMarker>();
  for (const reaction of target.interactions.readState().reactions) {
    const key = `${reaction.kind} ${reaction.turn}`;
    const existing = tallies.get(key);
    if (existing === undefined) {
      tallies.set(key, {
        kind: reaction.kind,
        turn: reaction.turn,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }
  return [...tallies.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.turn - right.turn ||
        left.kind.localeCompare(right.kind),
    )
    .slice(0, REPLAY_PREMIERE_MAX_SUMMARY_MARKERS);
}

export function parsePremiereResultSummary(
  bytes: Uint8Array,
): PremiereResultSummaryV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw summaryIntegrity("summary_invalid_json", error);
  }
  if (!isRecord(value) || typeof value.summaryHash !== "string") {
    throw summaryIntegrity("summary_not_object");
  }
  const { summaryHash, ...preimage } = value as Record<string, unknown>;
  validateSummaryPreimage(preimage as unknown as PremiereResultSummaryPreimage);
  if (
    !isSha256Hex(summaryHash) ||
    hashReplayPremiereJson(asJson(preimage)) !== summaryHash
  ) {
    throw summaryIntegrity("summary_hash_mismatch");
  }
  const summary = cloneAndFreezeReplayPremiereValue(
    value as unknown as PremiereResultSummaryV1,
    "parsed premiere summary",
  );
  assertPremiereResultSummaryAggregateOnly(summary);
  return summary;
}

/**
 * Fails closed if the summary carries any per-viewer identifier. This is a
 * defense-in-depth belt over the aggregate-only builder: it walks every key and
 * value and rejects participant/session/cookie/idempotency/attribution fields
 * or recognizable guest/session/ip id values. The additive public labels
 * (`mapLabel`/`formatLabel`) carry no per-viewer data — they are the same
 * spoiler-neutral labels the /league contract card exposes — so they pass.
 */
export function assertPremiereResultSummaryAggregateOnly(
  summary: PremiereResultSummaryV1,
): void {
  const scan = (value: ReplayPremiereJsonValue): void => {
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase();
        if (
          FORBIDDEN_KEY_FRAGMENTS.some((fragment) =>
            normalizedKey.includes(fragment),
          )
        ) {
          throw summaryIntegrity("summary_contains_per_viewer_field");
        }
        scan(entry);
      }
      return;
    }
    if (typeof value === "string" && PER_VIEWER_ID_VALUE.test(value)) {
      throw summaryIntegrity("summary_contains_per_viewer_identifier");
    }
  };
  scan(asJson(summary));
}

function validateSummaryPreimage(
  preimage: PremiereResultSummaryPreimage,
): void {
  if (!isRecord(preimage))
    throw summaryIntegrity("summary_preimage_not_object");
  assertExactKeys(
    preimage as Record<string, unknown>,
    [
      "schemaVersion",
      "summaryKind",
      "premiereId",
      "sourceRunId",
      "sourceKind",
      "publicationCommitmentHash",
      "terminalState",
      "revealedAt",
      "reclaimedAt",
      "outcome",
      "predictions",
      "markers",
    ],
    // Additive public labels: allowed but not required, so both legacy summaries
    // (which lack them) and current ones (which carry them) validate.
    ["mapLabel", "formatLabel"],
  );
  const value = preimage as unknown as PremiereResultSummaryPreimage;
  if (
    value.schemaVersion !== 1 ||
    value.summaryKind !== REPLAY_PREMIERE_RESULT_SUMMARY_KIND ||
    !/^prem_[a-z0-9]{16,32}$/.test(value.premiereId) ||
    typeof value.sourceRunId !== "string" ||
    value.sourceRunId.length === 0 ||
    value.sourceRunId.length > 256 ||
    (value.sourceKind !== "controlled_exhibition" &&
      value.sourceKind !== "rated_coworld") ||
    !isSha256Hex(value.publicationCommitmentHash) ||
    !isTerminalState(value.terminalState) ||
    (value.revealedAt !== null &&
      canonicalTimestampOrNull(value.revealedAt) === null) ||
    canonicalTimestampOrNull(value.reclaimedAt) === null ||
    !Array.isArray(value.predictions) ||
    !Array.isArray(value.markers) ||
    !isOptionalLabel(value.mapLabel) ||
    !isOptionalLabel(value.formatLabel)
  ) {
    throw summaryIntegrity("summary_contract_invalid");
  }
  const outcomeAllowed =
    value.terminalState === "revealed" || value.terminalState === "archived";
  if (!outcomeAllowed && value.outcome !== null) {
    // Spoiler safety: only a revealed/archived premiere may carry an outcome.
    throw summaryIntegrity("summary_outcome_without_reveal");
  }
  if (value.outcome !== null) validateSummaryOutcome(value.outcome);
  for (const prediction of value.predictions) {
    validateSummaryPrediction(prediction);
  }
  for (const marker of value.markers) validateSummaryMarker(marker);
}

function validateSummaryOutcome(outcome: PremiereResultSummaryOutcome): void {
  if (
    !isRecord(outcome) ||
    !Number.isSafeInteger(outcome.turnCount) ||
    outcome.turnCount < 0 ||
    canonicalTimestampOrNull(outcome.completedAt) === null ||
    !Array.isArray(outcome.standings)
  ) {
    throw summaryIntegrity("summary_outcome_invalid");
  }
  if (outcome.winner !== null) {
    const winner = outcome.winner;
    if (
      !isRecord(winner) ||
      (winner.category !== "player" &&
        winner.category !== "team" &&
        winner.category !== "nation") ||
      (winner.category === "player"
        ? winner.groupLabel !== null
        : typeof winner.groupLabel !== "string") ||
      !Array.isArray(winner.seatIds) ||
      winner.seatIds.length === 0 ||
      winner.seatIds.some((seatId) => typeof seatId !== "string")
    ) {
      throw summaryIntegrity("summary_winner_invalid");
    }
  }
  for (const standing of outcome.standings) {
    if (
      !isRecord(standing) ||
      typeof standing.seatId !== "string" ||
      typeof standing.displayName !== "string" ||
      typeof standing.won !== "boolean"
    ) {
      throw summaryIntegrity("summary_standing_invalid");
    }
  }
}

function validateSummaryPrediction(
  prediction: PremiereResultSummaryPrediction,
): void {
  if (
    !isRecord(prediction) ||
    typeof prediction.checkpointId !== "string" ||
    !Number.isSafeInteger(prediction.sequence) ||
    prediction.sequence < 0 ||
    !Number.isSafeInteger(prediction.totalPredictions) ||
    prediction.totalPredictions < 0 ||
    !Array.isArray(prediction.options) ||
    (prediction.correctPredictions !== null &&
      (!Number.isSafeInteger(prediction.correctPredictions) ||
        prediction.correctPredictions < 0))
  ) {
    throw summaryIntegrity("summary_prediction_invalid");
  }
  for (const option of prediction.options) {
    if (
      !isRecord(option) ||
      typeof option.seatId !== "string" ||
      !Number.isSafeInteger(option.count) ||
      option.count < 0
    ) {
      throw summaryIntegrity("summary_prediction_option_invalid");
    }
  }
}

function validateSummaryMarker(marker: PremiereResultSummaryMarker): void {
  if (
    !isRecord(marker) ||
    !REPLAY_PREMIERE_REACTION_KINDS.includes(
      marker.kind as ReplayPremiereReactionKind,
    ) ||
    !Number.isSafeInteger(marker.turn) ||
    marker.turn < 0 ||
    !Number.isSafeInteger(marker.count) ||
    marker.count < 1
  ) {
    throw summaryIntegrity("summary_marker_invalid");
  }
}

function isTerminalState(value: unknown): value is PremiereResultTerminalState {
  return (
    value === "revealed" ||
    value === "archived" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function assertCanonicalTimestamp(value: string, field: string): void {
  if (canonicalTimestampOrNull(value) === null) {
    throw summaryIntegrity(`summary_invalid_${field}_timestamp`);
  }
}

function canonicalTimestampOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? value
    : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...required, ...optional]);
  const hasAllRequired = required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  const hasNoUnknown = Object.keys(value).every((key) => allowed.has(key));
  if (!hasAllRequired || !hasNoUnknown) {
    throw summaryIntegrity("summary_unknown_or_missing_fields");
  }
}

/** An optional label is either absent or a bounded, non-empty string. */
function isOptionalLabel(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= 512)
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  return value as ReplayPremiereJsonValue;
}

function summaryIntegrity(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere result summary failed integrity validation: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}
