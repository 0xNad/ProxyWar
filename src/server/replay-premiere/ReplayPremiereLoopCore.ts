import { createHash } from "node:crypto";
import {
  createPremiereSuppressionContract,
  type PremiereSuppressionContract,
  type PremiereSuppressionHold,
} from "../agents/CoworldLeaguePremiereSuppression";
import type { PremierePlaybackRate } from "./ReplayPremiereContracts";

/**
 * Pure decision core for the premiere-by-default watcher loop (Phase 2).
 *
 * Everything here is deterministic and side-effect free so the loop's real
 * decisions — round detection/diff, episode ordering, supersede/skip rules,
 * hold arithmetic, contract construction, opaque premiere-id derivation,
 * playback/checkpoint/definition builders, journal folding, and the
 * shadow-mode side-effect gate — can be exhaustively unit-tested without any
 * Coworld reads, filesystem, or server restart. The orchestration script
 * (`src/scripts/replay-premiere-loop.ts`) owns all I/O and calls into these.
 *
 * The single hard invariant this module encodes is ONLY-LATEST: at most one
 * episode is ever held at a time, and only the freshest completed unpremiered
 * round is ever claimed. Everything else publishes ordinarily.
 */

/** Public league the loop watches (read-only). */
export const PREMIERE_LOOP_LEAGUE_ID =
  "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42" as const;
/** Competition division whose replays feed the loop. */
export const PREMIERE_LOOP_DIVISION_ID =
  "div_b54268ee-6b2f-4156-9c2a-8542645e31bc" as const;

/** Lead time from "now" to the scheduled reveal window (ceil-to-minute). */
export const PREMIERE_LOOP_SCHEDULE_LEAD_MS = 5 * 60_000;
/**
 * Hard per-episode availability valve: an episode auto-publishes at
 * scheduledAt + this, even if the premiere never revealed. Must stay below the
 * round interval (~30 min) and above the maximum play time. Never extended.
 */
export const PREMIERE_LOOP_HOLD_WINDOW_MS = 35 * 60_000;

/**
 * Coarse cold-start / gap-recovery seal window. A completed round older than
 * this can no longer be sealed: the mirror publishes a completed round on its
 * next cycle (~5 min) unless a suppression contract already covers it, so once a
 * round is older than the loop's own hold window its outcome is long public.
 * Claiming such a round wastes a download and, worse, drives the admission leak
 * collector to fetch the multi-MB public replay and abort it mid-stream. This
 * is the deterministic no-network fast path; the precise "is it actually public
 * right now" decision is the per-episode deployment-origin probe in the loop
 * orchestrator. Fresh rounds (completed within the window) are never affected.
 */
export const PREMIERE_LOOP_SEAL_WINDOW_MS = PREMIERE_LOOP_HOLD_WINDOW_MS;

/**
 * Startup projection budget: episodes longer than this risk exceeding the
 * server's ~10s premiere-registration budget on very long World episodes, so
 * they are skipped (the loop tries a shorter episode of the round first).
 */
export const PREMIERE_LOOP_TURN_STARTUP_BUDGET = 34_000;

/** At most this many raw replays are downloaded while selecting a claim. */
export const PREMIERE_LOOP_MAX_REPLAY_DOWNLOADS = 3;
/** At most this many full pipeline attempts (claim→activate) per round. */
export const PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS = 2;
/** At most this many raw replays kept in the bounded fetch cache. */
export const PREMIERE_LOOP_MAX_RAW_REPLAY_CACHE = 3;
/** At most this many controlled-restart activation attempts across ticks. */
export const PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS = 3;

/**
 * The public run key the mirror derives for a Coworld episode bundle:
 * `league-<sourceRunId>`. The retention-pin manifest validates pins against
 * exactly this pattern, so an invalid key would break the mirror's pin read;
 * {@link isManagedPublicRunKey} is checked before any pin is written.
 */
const MANAGED_RUN_KEY_PATTERN = /^league-coworld-[A-Za-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Opaque identifiers, playback, checkpoints, hold arithmetic
// ---------------------------------------------------------------------------

/**
 * Derive the public premiere id from the episode request id. The result is an
 * opaque token — `prem_` + the first 24 hex chars of sha256(episodeRequestId)
 * — that by construction never contains the episode request id, run id, player
 * names, or outcome, and matches `PREMIERE_ID_PATTERN` in
 * ReplayPremiereContracts (`prem_[a-z0-9]{16,32}`).
 */
export function derivePremiereId(episodeRequestId: string): string {
  const digest = createHash("sha256")
    .update(episodeRequestId, "utf8")
    .digest("hex");
  return `prem_${digest.slice(0, 24)}`;
}

/**
 * Deterministic, stable checkpoint id for a given episode + checkpoint index.
 * Stable across retries so an exact re-admission of the same episode reuses the
 * same publication commitment instead of colliding.
 */
export function deriveCheckpointId(
  episodeRequestId: string,
  index: 0 | 1,
): string {
  const digest = createHash("sha256")
    .update(`${episodeRequestId}:premiere-checkpoint:${index}`, "utf8")
    .digest("hex");
  return `cp_${digest.slice(0, 12)}`;
}

/**
 * Playback-rate heuristic keyed on turn count. Admission only accepts 1, 2, or
 * 4; longer games play faster so the reveal window stays bounded.
 */
export function playbackRateForTurnCount(
  turnCount: number,
): PremierePlaybackRate {
  if (turnCount > 30_000) {
    return 4;
  }
  if (turnCount >= 10_000) {
    return 2;
  }
  return 1;
}

/** Checkpoint sequences at 0.35× and 0.65× the turn count (rounded). */
export function checkpointSequencesForTurnCount(
  turnCount: number,
): [number, number] {
  return [Math.round(0.35 * turnCount), Math.round(0.65 * turnCount)];
}

/** Whether an episode's turn count fits the startup projection budget. */
export function isTurnCountWithinStartupBudget(
  turnCount: number,
  budget: number = PREMIERE_LOOP_TURN_STARTUP_BUDGET,
): boolean {
  return Number.isFinite(turnCount) && turnCount > 0 && turnCount <= budget;
}

/** Round a millisecond instant UP to the next whole minute, as an ISO string. */
export function ceilToMinuteIso(instantMs: number): string {
  return new Date(Math.ceil(instantMs / 60_000) * 60_000).toISOString();
}

/** scheduledAt = ceil-to-minute(now + lead). */
export function scheduledAtForClaim(
  now: Date,
  leadMs: number = PREMIERE_LOOP_SCHEDULE_LEAD_MS,
): string {
  return ceilToMinuteIso(now.getTime() + leadMs);
}

/** holdExpiresAt = scheduledAt + hold window (the hard availability valve). */
export function holdExpiresAtForScheduled(
  scheduledAtIso: string,
  windowMs: number = PREMIERE_LOOP_HOLD_WINDOW_MS,
): string {
  return new Date(Date.parse(scheduledAtIso) + windowMs).toISOString();
}

/** The `league-<sourceRunId>` public run key the mirror unpacks a bundle to. */
export function publicRunKeyForSourceRunId(sourceRunId: string): string {
  return `league-${sourceRunId}`;
}

/** Whether a public run key is a safe managed key the retention pin will accept. */
export function isManagedPublicRunKey(publicRunKey: string): boolean {
  return (
    MANAGED_RUN_KEY_PATTERN.test(publicRunKey) &&
    !publicRunKey.includes("/") &&
    !publicRunKey.includes("\\")
  );
}

/**
 * Map label for the spoiler-safe league card. Coworld `replays` rows no longer
 * carry `game_config` (verified 2026-07-22), so the map comes from
 * `variant_name` — e.g. "Tournament 12P - Pangaea" -> "Pangaea".
 */
export function mapLabelFromVariantName(variantName: string | null): string {
  if (variantName === null) {
    return "Unknown map";
  }
  const trimmed = variantName.trim();
  if (trimmed.length === 0) {
    return "Unknown map";
  }
  const separator = trimmed.lastIndexOf(" - ");
  const label = separator >= 0 ? trimmed.slice(separator + 3).trim() : trimmed;
  return label.length > 0 ? label : "Unknown map";
}

// ---------------------------------------------------------------------------
// Coworld read parsing (tolerant; unwraps the `{entries: []}` CLI shape)
// ---------------------------------------------------------------------------

export interface LoopRound {
  id: string;
  roundNumber: number | null;
  status: string;
  completedAt: string | null;
}

export interface LoopReplayRow {
  episodeRequestId: string;
  roundId: string | null;
  status: string;
  completedAt: string | null;
  replayUrl: string | null;
  variantName: string | null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.entries)) {
    return value.entries;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const SAFE_EPISODE_REQUEST_ID = /^ereq_[A-Za-z0-9_-]+$/;

/** Parse `coworld rounds` output into loop rounds; drops rows without an id. */
export function parseLoopRounds(raw: unknown): LoopRound[] {
  const rounds: LoopRound[] = [];
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = asString(entry.id);
    if (id === null) {
      continue;
    }
    rounds.push({
      id,
      roundNumber: asNumber(entry.round_number),
      status: asString(entry.status) ?? "unknown",
      completedAt: asString(entry.completed_at),
    });
  }
  return rounds;
}

/** Parse `coworld replays` output; drops rows with an unsafe episode id. */
export function parseLoopReplayRows(raw: unknown): LoopReplayRow[] {
  const rows: LoopReplayRow[] = [];
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) {
      continue;
    }
    const episodeRequestId = asString(entry.id);
    if (
      episodeRequestId === null ||
      !SAFE_EPISODE_REQUEST_ID.test(episodeRequestId)
    ) {
      continue;
    }
    rows.push({
      episodeRequestId,
      roundId: asString(entry.round_id),
      status: asString(entry.status) ?? "unknown",
      completedAt: asString(entry.completed_at),
      replayUrl: asString(entry.replay_url),
      variantName:
        typeof entry.variant_name === "string" ? entry.variant_name : null,
    });
  }
  return rows;
}

/**
 * Newest-first ordering of an already-completed round's admissible episodes.
 * Only completed episodes of THIS round with a replay URL and a safe id are
 * candidates; the caller downloads them in order (bounded) and claims the first
 * one that fits the startup budget.
 */
export function orderEpisodesForClaim(
  round: LoopRound,
  replays: readonly LoopReplayRow[],
): LoopReplayRow[] {
  return replays
    .filter(
      (row) =>
        row.roundId === round.id &&
        row.status === "completed" &&
        row.replayUrl !== null &&
        SAFE_EPISODE_REQUEST_ID.test(row.episodeRequestId),
    )
    .slice()
    .sort((left, right) =>
      (right.completedAt ?? "").localeCompare(left.completedAt ?? ""),
    );
}

// ---------------------------------------------------------------------------
// Loop hold state, journal, and folding
// ---------------------------------------------------------------------------

export type LoopHoldPhase = "claimed" | "admitted" | "activated" | "live";

/**
 * The loop's private per-episode hold record. A superset of the spoiler-safe
 * {@link PremiereSuppressionHold} the mirror consumes; the extra fields
 * (publicRunKey, phase, attempt counters, and the values needed to re-run
 * ingest/admit on a resumed tick) never leave the loop's private journal.
 */
export interface LoopHoldState {
  episodeRequestId: string;
  premiereId: string;
  roundId: string | null;
  roundNumber: number | null;
  /** Fixed at claim; reused verbatim by every retry so re-admission dedups. */
  scheduledAt: string;
  /** scheduledAt + hold window; the hard availability valve. Never extended. */
  holdExpiresAt: string;
  premierePageLive: boolean;
  mapLabel: string;
  /** `league-<sourceRunId>`; the pinned public run key. */
  publicRunKey: string;
  replayUrl: string;
  variantName: string | null;
  seatCount: number;
  turnCount: number;
  playbackRate: PremierePlaybackRate;
  phase: LoopHoldPhase;
  activationAttempts: number;
  createdAt: string;
}

/** A round the loop journals as skipped (never premiered). */
export interface LoopRoundRef {
  id: string;
  roundNumber: number | null;
}

export type LoopSkipReason =
  | "skipped_busy"
  | "skipped_superseded"
  | "projection_over_budget"
  | "no_eligible_episode"
  | "too_old_to_seal"
  | "already_public"
  | "exhausted";

export type LoopReleaseOutcome =
  | "revealed"
  | "expired"
  | "leak_audit_refused"
  | "activation_refused"
  | "ingest_failed"
  | "admit_failed"
  | "failed_or_cancelled"
  | "projection_over_budget";

export type LoopJournalRecord =
  | { kind: "hold_update"; ts: string; hold: LoopHoldState }
  | {
      kind: "hold_released";
      ts: string;
      episodeRequestId: string;
      premiereId: string;
      roundId: string | null;
      outcome: LoopReleaseOutcome;
      /** true when the round must never be claimed again. */
      terminal: boolean;
    }
  | {
      kind: "round_skipped";
      ts: string;
      roundId: string;
      roundNumber: number | null;
      reason: LoopSkipReason;
    };

export interface LoopFoldedState {
  /** The one currently-held episode, or null when the loop is free. */
  activeHold: LoopHoldState | null;
  /** Rounds that must never be claimed (premiered, skipped, or exhausted). */
  terminalRoundIds: ReadonlySet<string>;
  /** Retriable pipeline attempts consumed per round. */
  attemptsByRound: ReadonlyMap<string, number>;
}

/**
 * Fold an append-only journal into current loop state. `hold_update` sets the
 * single active hold; `hold_released` clears it and either marks its round
 * terminal (success/publish outcomes) or counts a retriable attempt (and marks
 * the round terminal once the attempt ceiling is reached); `round_skipped`
 * marks a round terminal directly.
 */
export function foldLoopJournal(
  records: readonly LoopJournalRecord[],
  maxAttempts: number = PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS,
): LoopFoldedState {
  let activeHold: LoopHoldState | null = null;
  const terminalRoundIds = new Set<string>();
  const attemptsByRound = new Map<string, number>();

  for (const record of records) {
    if (record.kind === "hold_update") {
      activeHold = record.hold;
      continue;
    }
    if (record.kind === "round_skipped") {
      terminalRoundIds.add(record.roundId);
      continue;
    }
    // hold_released
    if (
      activeHold !== null &&
      activeHold.episodeRequestId === record.episodeRequestId
    ) {
      activeHold = null;
    }
    if (record.roundId === null) {
      continue;
    }
    if (record.terminal) {
      terminalRoundIds.add(record.roundId);
      continue;
    }
    const attempts = (attemptsByRound.get(record.roundId) ?? 0) + 1;
    attemptsByRound.set(record.roundId, attempts);
    if (attempts >= maxAttempts) {
      terminalRoundIds.add(record.roundId);
    }
  }

  return { activeHold, terminalRoundIds, attemptsByRound };
}

// ---------------------------------------------------------------------------
// The per-tick claim/skip/track decision (ONLY-LATEST)
// ---------------------------------------------------------------------------

export type LoopClaimDecision =
  | {
      kind: "track";
      hold: LoopHoldState;
      /** Newer completed rounds to journal `skipped_busy` (publish as usual). */
      busySkipRoundIds: LoopRoundRef[];
    }
  | {
      kind: "claim";
      round: LoopRound;
      /** Older completed rounds to journal `skipped_superseded`. */
      supersededRoundIds: LoopRoundRef[];
    }
  | { kind: "idle" };

function toRoundRef(round: LoopRound): LoopRoundRef {
  return { id: round.id, roundNumber: round.roundNumber };
}

/**
 * Decide the tick's action. ONLY-LATEST: if a hold is active, keep tracking it
 * and skip every newer completed round; otherwise claim the single newest
 * completed unpremiered round and skip the rest. Exhausted rounds are already
 * terminal (folded) and never surface here.
 */
export function decideLoopClaim(input: {
  rounds: readonly LoopRound[];
  folded: LoopFoldedState;
}): LoopClaimDecision {
  const completedUnpremiered = input.rounds
    .filter(
      (round) =>
        round.status === "completed" &&
        !input.folded.terminalRoundIds.has(round.id),
    )
    .slice()
    .sort((left, right) => roundRank(right) - roundRank(left));

  if (input.folded.activeHold !== null) {
    return {
      kind: "track",
      hold: input.folded.activeHold,
      busySkipRoundIds: completedUnpremiered.map(toRoundRef),
    };
  }

  if (completedUnpremiered.length === 0) {
    return { kind: "idle" };
  }

  const [newest, ...superseded] = completedUnpremiered;
  return {
    kind: "claim",
    round: newest,
    supersededRoundIds: superseded.map(toRoundRef),
  };
}

function roundRank(round: LoopRound): number {
  return round.roundNumber ?? Number.NEGATIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Suppression contract construction (requirements #1 and #4)
// ---------------------------------------------------------------------------

function toSuppressionHold(hold: LoopHoldState): PremiereSuppressionHold {
  return {
    episodeRequestId: hold.episodeRequestId,
    premiereId: hold.premiereId,
    roundId: hold.roundId,
    roundNumber: hold.roundNumber,
    scheduledAt: hold.scheduledAt,
    holdExpiresAt: hold.holdExpiresAt,
    premierePageLive: hold.premierePageLive,
    mapLabel: hold.mapLabel,
  };
}

/**
 * Build the suppression contract for the current holds, or null when there are
 * none. Returning null (rather than a zero-hold contract) is requirement #4:
 * an active zero-hold contract would blanket-quarantine every fresh card. The
 * `generatedAt` is always the caller's `now` — never a future/skewed value —
 * and the loop rewrites it every cycle, satisfying requirement #1.
 */
export function buildLoopSuppressionContract(
  holds: readonly LoopHoldState[],
  now: Date,
): PremiereSuppressionContract | null {
  if (holds.length === 0) {
    return null;
  }
  return createPremiereSuppressionContract({
    generatedAt: now.toISOString(),
    holds: holds.map(toSuppressionHold),
  });
}

// ---------------------------------------------------------------------------
// Admission input builders (exact shapes the admit CLI validates)
// ---------------------------------------------------------------------------

export interface LoopEligibilityInput {
  schemaVersion: 1;
  eligibilityCheckVersion: string;
  externalEmbargoEvidence: never[];
  externalOutcomeMayBePublic: true;
  publicLabel: "spoiler_resistant_premiere";
}

/**
 * Eligibility input for a rated Coworld premiere. League standings publish
 * every rated outcome, so `externalOutcomeMayBePublic` is true and the only
 * honest public label is the spoiler-resistant one.
 */
export function buildLoopEligibilityInput(): LoopEligibilityInput {
  return {
    schemaVersion: 1,
    eligibilityCheckVersion: "premiere-loop/v1",
    externalEmbargoEvidence: [],
    externalOutcomeMayBePublic: true,
    publicLabel: "spoiler_resistant_premiere",
  };
}

export interface LoopPremiereDefinitionInput {
  schemaVersion: 1;
  title: string;
  spoilerNeutralDescription: string;
  map: { id: string; label: string };
  matchFormat: { id: string; label: string; seatCount: number };
  scheduledAt: string;
  playbackRate: PremierePlaybackRate;
  checkpoints: [
    { id: string; sequence: number },
    { id: string; sequence: number },
  ];
}

/**
 * Build the spoiler-neutral public definition non-interactively. The title,
 * description, and map carry no outcome; checkpoints sit at 0.35×/0.65× the
 * turn count with deterministic ids so retries stay byte-identical.
 */
export function buildLoopPremiereDefinition(input: {
  episodeRequestId: string;
  coworldName: string;
  mapLabel: string;
  variantName: string | null;
  seatCount: number;
  turnCount: number;
  scheduledAt: string;
}): LoopPremiereDefinitionInput {
  const [firstCheckpoint, secondCheckpoint] = checkpointSequencesForTurnCount(
    input.turnCount,
  );
  return {
    schemaVersion: 1,
    title: `${input.coworldName} league premiere`,
    spoilerNeutralDescription: `A rated ${input.coworldName} league episode on ${input.mapLabel}.`,
    map: { id: input.mapLabel, label: input.mapLabel },
    matchFormat: {
      id: `ffa-${input.seatCount}`,
      label: input.variantName ?? `${input.seatCount}-seat FFA`,
      seatCount: input.seatCount,
    },
    scheduledAt: input.scheduledAt,
    playbackRate: playbackRateForTurnCount(input.turnCount),
    checkpoints: [
      {
        id: deriveCheckpointId(input.episodeRequestId, 0),
        sequence: firstCheckpoint,
      },
      {
        id: deriveCheckpointId(input.episodeRequestId, 1),
        sequence: secondCheckpoint,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shadow-mode side-effect gate
// ---------------------------------------------------------------------------

export interface LoopSideEffectPlan {
  /** Ingest (parse + hash-bound bundle write) is allowed in both modes. */
  ingest: boolean;
  /** Writing the suppression contract (which suppresses cards). */
  writeSuppressionContract: boolean;
  /** Adding/removing retention pins. */
  pinArtifacts: boolean;
  /** In-process admission into the catalog. */
  admit: boolean;
  /** The controlled server restart that registers the premiere. */
  restart: boolean;
}

/**
 * The permitted side effects for the current mode. `--shadow` runs INGEST only
 * for safe live observation: it never writes a suppressing contract, never
 * pins, never admits, and never restarts, so a shadow run is provably
 * side-effect free against production state.
 */
export function loopSideEffectPlan(shadow: boolean): LoopSideEffectPlan {
  return shadow
    ? {
        ingest: true,
        writeSuppressionContract: false,
        pinArtifacts: false,
        admit: false,
        restart: false,
      }
    : {
        ingest: true,
        writeSuppressionContract: true,
        pinArtifacts: true,
        admit: true,
        restart: true,
      };
}

/**
 * Terminal availability check: a hold whose hard expiry has passed must be
 * released and the episode published, regardless of premiere progress.
 */
export function isHoldExpired(hold: LoopHoldState, now: Date): boolean {
  const expiresMs = Date.parse(hold.holdExpiresAt);
  return Number.isFinite(expiresMs) && now.getTime() >= expiresMs;
}

/**
 * Whether a completed round/episode is too old to seal into a premiere, given
 * its `completedAt` and the current time. Fail-open by construction: a null or
 * unparseable timestamp (and any not-yet-elapsed window) returns false so an
 * unknown age never blocks a fresh premiere. Only a completion strictly older
 * than the seal window returns true.
 */
export function isCompletedTooOldToSeal(
  completedAt: string | null,
  now: Date,
  sealWindowMs: number = PREMIERE_LOOP_SEAL_WINDOW_MS,
): boolean {
  if (completedAt === null) {
    return false;
  }
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs)) {
    return false;
  }
  return now.getTime() - completedMs > sealWindowMs;
}
