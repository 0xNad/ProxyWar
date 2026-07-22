import { createHash } from "node:crypto";
import {
  createPremiereSuppressionContract,
  type PremiereSuppressionContract,
  type PremiereSuppressionHold,
} from "../agents/CoworldLeaguePremiereSuppression";
import type { PremierePlaybackRate } from "./ReplayPremiereContracts";

/**
 * Pure decision core for the bounded Replay Premiere watcher loop (Phase 2).
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
 * round is ever claimed. Everything else publishes once its blanket
 * quarantine window expires (see {@link buildLoopSuppressionContract}). The
 * standing contract lets the loop win the publish race; the post-reveal
 * cooldown deliberately skips intervening rounds so a completed premiere
 * remains resident through terminal reclamation.
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
 * scheduledAt + this, even if the premiere never revealed. Never extended.
 *
 * Derivation (2026-07-22 real-speed retune): the 5-minute schedule lead sits
 * BEFORE scheduledAt, so this window must cover the worst admitted show plus
 * margin — 60 min of playback (36,000 turns at 1x real speed; the 60,000-turn
 * cap at 2x is 50 min) + ~2 min of checkpoint intermissions + up to a minute
 * of client presentation trail + reveal/publication margin ≈ 75 minutes.
 *
 * History: 35 min while premieres free-ran at ~1 ms/turn nominal offsets and
 * the whole show fit inside one 30-minute round. At real speed a premiere
 * intentionally spans multiple rounds: while one plays, newly-completed rounds
 * publish ordinarily at quarantine expiry (skipped_busy). After release, the
 * post-reveal cooldown lets the prior audience window and reclamation grace
 * complete before a later fresh round can be claimed.
 */
export const PREMIERE_LOOP_HOLD_WINDOW_MS = 75 * 60_000;

/**
 * Keep a revealed premiere resident through the terminal-reclamation grace
 * before another controlled restart can replace it. The reclaimer's default
 * grace is 30 minutes; five additional minutes cover the minute loop cadence
 * and the next reclamation sweep without coupling the pure loop core to the
 * storage implementation.
 *
 * This also gives each premiere one bounded audience window instead of
 * immediately displacing it with the next completed Coworld round.
 */
export const PREMIERE_LOOP_POST_REVEAL_COOLDOWN_MS = 35 * 60_000;

/**
 * Coarse cold-start / gap-recovery seal window. A completed round older than
 * this can no longer be sealed: the mirror publishes a completed round on its
 * next cycle (~5 min) unless a suppression contract already covers it, so once
 * a round is that old its outcome is long public. Claiming such a round wastes
 * a download and, worse, drives the admission leak collector to fetch the
 * multi-MB public replay and abort it mid-stream. This is the deterministic
 * no-network fast path; the precise "is it actually public right now" decision
 * is the per-episode deployment-origin probe in the loop orchestrator. Fresh
 * rounds (completed within the window) are never affected.
 *
 * Deliberately NOT aliased to PREMIERE_LOOP_HOLD_WINDOW_MS: claim freshness
 * (how stale a completed round may be and still be worth sealing) is governed
 * by the mirror publish cadence and quarantine, and stays ~35 min; the hold
 * window above is playback duration and grew to 75 min with real-speed
 * playback.
 */
export const PREMIERE_LOOP_SEAL_WINDOW_MS = 35 * 60_000;

/**
 * Startup projection budget: episodes longer than this are skipped (the loop
 * tries a shorter episode of the round first).
 *
 * History: while premiere registration only had the server's 8 s boot budget
 * (`maxStartupMs: 8_000`), this cap was calibrated to 24,000 turns (26,900
 * assembled in time — round 642; 32,300 did not — round 646's activation
 * zombie). Fresh admissions now get the deferred 90 s assembly lane
 * (`DEFAULT_DEFERRED_FRESH_ASSEMBLY_BUDGET_MS`) plus activation
 * verify → one retry → terminal `activation_lost`, so the binding constraint
 * is the 90 s lane (~11× the window that fit 26,900 turns), not the 8 s boot
 * pass. 60,000 admits the real league's large World episodes (observed up to
 * 50,400) while still excluding pathological outliers; an over-budget
 * assembly fails BOUNDED (deferred timeout → one spaced retry →
 * activation_lost, feed publishes at quarantine expiry).
 */
export const PREMIERE_LOOP_TURN_STARTUP_BUDGET = 60_000;

/** At most this many raw replays are downloaded while selecting a claim. */
export const PREMIERE_LOOP_MAX_REPLAY_DOWNLOADS = 3;
/** At most this many full pipeline attempts (claim→activate) per round. */
export const PREMIERE_LOOP_MAX_PIPELINE_ATTEMPTS = 2;
/** At most this many raw replays kept in the bounded fetch cache. */
export const PREMIERE_LOOP_MAX_RAW_REPLAY_CACHE = 3;
/** At most this many controlled-restart activation attempts across ticks. */
export const PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS = 3;

/**
 * Bounded post-activation registration verification window (~2 loop ticks).
 * A successful controlled restart proves a fresh server process accepted
 * traffic — it does NOT prove the premiere registered: the server's startup
 * recovery has its own total assembly budget (`maxStartupMs`, ~8s) and can
 * reject a freshly admitted premiere with `startup_deadline_exceeded`
 * (2026-07-22 round-644 activation zombie). The loop therefore verifies the
 * premiere's public surface after activation and only trusts registration it
 * can observe.
 */
export const PREMIERE_LOOP_ACTIVATION_VERIFY_MS = 120_000;
/**
 * Exactly one fresh controlled-restart re-activation after a failed
 * verification. A retry boots a process whose startup scan is guaranteed to
 * see the admission (it was written long before the restart) with a full
 * startup budget; if registration still fails, the hold is released as
 * `activation_lost` so the episode publishes ordinarily — never zombie-tracked
 * to `holdExpiresAt`.
 */
export const PREMIERE_LOOP_MAX_REACTIVATION_ATTEMPTS = 1;
/**
 * Minimum spacing between controlled-restart activation attempts after a
 * helper REFUSAL (~2 ticks). 2026-07-22 round-649 outage: while the beta was
 * crash-looping on a poisoned catalog, the loop re-fired the refused restart
 * every 60s tick, killing each just-booted process again and deepening the
 * public outage. A refusal now arms a backoff window; the attempt ceiling
 * (`PREMIERE_LOOP_MAX_ACTIVATION_ATTEMPTS`) is unchanged, so the worst case
 * is the same bounded release — just spaced instead of hammered.
 */
export const PREMIERE_LOOP_ACTIVATION_BACKOFF_MS = 120_000;

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
 *
 * 2026-07-22 retune #3 (real match speed): premieres now pace from the real
 * 100 ms game turn interval (PREMIERE_REAL_TURN_INTERVAL_MS), i.e. 10 turns/s
 * at 1×. That makes 10,000 turns ≈ 16.7 min, 20k ≈ 33 min, 36k = 60 min at
 * 1×; the 60,000-turn admission cap at 2× = 50 min. Typical rounds (≤36k)
 * play at true match speed; only outsized shows compress to 2× so the worst
 * case still reveals inside the 75-minute hold valve.
 *
 * History — retuned twice earlier on 2026-07-22 while nominal offsets were
 * ~1 ms/turn and the sim free-ran: first to minimize the on-air window, then
 * (operator: premieres ARE the live product surface) to maximize it with
 * ≤32k → 1×. Those bands were calibrated to free-run throughput measurements
 * (~30-60 released turns/s — round 651: 17,000 turns live in ~6 min; round
 * 637: 22,600 ≈ 6.5 min) and are obsolete now that 1× means real speed.
 */
export function playbackRateForTurnCount(
  turnCount: number,
): PremierePlaybackRate {
  if (turnCount > 36_000) {
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
  /**
   * Earliest instant the next activation attempt may fire after a helper
   * refusal. Null when no backoff is armed — and on records journaled before
   * this field existed; {@link foldLoopJournal} normalizes those.
   */
  activationBackoffUntil: string | null;
  /**
   * When the loop last confirmed a controlled restart for this hold (initial
   * activation or the single re-activation). Starts the bounded registration
   * verification window. Null until activated — and on records journaled
   * before this field existed; {@link foldLoopJournal} normalizes those, and
   * the tracker stamps the window start on first observation.
   */
  activatedAt: string | null;
  /** Re-activation restarts consumed after a failed verification (0 or 1). */
  reactivationAttempts: number;
  createdAt: string;
}

/** A round the loop journals as skipped (never premiered). */
export interface LoopRoundRef {
  id: string;
  roundNumber: number | null;
}

export type LoopSkipReason =
  | "skipped_busy"
  | "skipped_post_reveal_cooldown"
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
  /**
   * The controlled restart reported success but the premiere never became
   * observable (e.g. the server's startup recovery rejected the admission on
   * its own deadline) and the single re-activation retry did not fix it. The
   * hold is released immediately so the episode publishes at quarantine
   * expiry instead of zombie-tracking to holdExpiresAt.
   */
  | "activation_lost"
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
  /** Most recent successful reveal release observed in the durable journal. */
  lastRevealedAt: string | null;
}

/**
 * Normalize a journaled hold to the current schema. Records appended before
 * the activation-verification fields existed lack `activatedAt` /
 * `reactivationAttempts`; treat those (and any invalid value) as "window not
 * started / no retries consumed" so the tracker starts a fresh bounded window
 * rather than releasing early or zombie-tracking.
 */
export function normalizeLoopHoldState(hold: LoopHoldState): LoopHoldState {
  const activatedAtMs =
    typeof hold.activatedAt === "string"
      ? Date.parse(hold.activatedAt)
      : Number.NaN;
  const backoffUntilMs =
    typeof hold.activationBackoffUntil === "string"
      ? Date.parse(hold.activationBackoffUntil)
      : Number.NaN;
  const reactivationAttempts =
    typeof hold.reactivationAttempts === "number" &&
    Number.isSafeInteger(hold.reactivationAttempts) &&
    hold.reactivationAttempts >= 0
      ? hold.reactivationAttempts
      : 0;
  return {
    ...hold,
    activatedAt: Number.isFinite(activatedAtMs) ? hold.activatedAt : null,
    activationBackoffUntil: Number.isFinite(backoffUntilMs)
      ? hold.activationBackoffUntil
      : null,
    reactivationAttempts,
  };
}

/**
 * Whether a helper-refusal backoff is still holding activation attempts.
 * Fail-open: no stamp or an invalid stamp means no backoff (the attempt
 * ceiling still bounds total attempts either way).
 */
export function isActivationBackoffActive(
  hold: LoopHoldState,
  now: Date,
): boolean {
  if (typeof hold.activationBackoffUntil !== "string") return false;
  const untilMs = Date.parse(hold.activationBackoffUntil);
  return Number.isFinite(untilMs) && now.getTime() < untilMs;
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
  let lastRevealedAt: string | null = null;

  for (const record of records) {
    if (record.kind === "hold_update") {
      activeHold = normalizeLoopHoldState(record.hold);
      continue;
    }
    if (record.kind === "round_skipped") {
      terminalRoundIds.add(record.roundId);
      continue;
    }
    // hold_released
    if (
      record.outcome === "revealed" &&
      Number.isFinite(Date.parse(record.ts)) &&
      (lastRevealedAt === null ||
        Date.parse(record.ts) > Date.parse(lastRevealedAt))
    ) {
      lastRevealedAt = record.ts;
    }
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

  return {
    activeHold,
    terminalRoundIds,
    attemptsByRound,
    lastRevealedAt,
  };
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
  | {
      kind: "post_reveal_cooldown";
      /** Completed rounds that publish normally instead of becoming premieres. */
      skippedRoundIds: LoopRoundRef[];
      nextClaimAt: string;
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
  now: Date;
  postRevealCooldownMs?: number;
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

  const now = input.now;
  const postRevealCooldownMs =
    input.postRevealCooldownMs ?? PREMIERE_LOOP_POST_REVEAL_COOLDOWN_MS;
  const lastRevealedAtMs =
    input.folded.lastRevealedAt === null
      ? Number.NaN
      : Date.parse(input.folded.lastRevealedAt);
  if (
    completedUnpremiered.length > 0 &&
    Number.isFinite(lastRevealedAtMs) &&
    Number.isSafeInteger(postRevealCooldownMs) &&
    postRevealCooldownMs >= 0 &&
    now.getTime() < lastRevealedAtMs + postRevealCooldownMs
  ) {
    return {
      kind: "post_reveal_cooldown",
      skippedRoundIds: completedUnpremiered.map(toRoundRef),
      nextClaimAt: new Date(
        lastRevealedAtMs + postRevealCooldownMs,
      ).toISOString(),
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
// Suppression contract construction (requirement #1 + the standing quarantine)
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
 * Build the suppression contract for the current holds. ZERO HOLDS IS VALID:
 * the resulting contract carries only the blanket `quarantineMs`, which defers
 * every freshly-completed episode until the loop has had its chance to claim
 * it — the standing quarantine that makes the loop win the publish race
 * before it either claims or explicitly skips a completed round.
 *
 * HISTORY — suppression reviewer requirement #4 REVERSED (2026-07-22): the
 * original review required "never write a zero-hold active contract" so an
 * idle loop could not blanket-quarantine fresh cards, and this function
 * returned null for zero holds. A later release introduced the zero-hold
 * contract so the loop wins the mirror race. The 2026-07-22 UX audit retained
 * that race protection but added a post-reveal cooldown: intervening rounds
 * are skipped and publish at quarantine expiry instead of becoming
 * back-to-back premieres. Fail-open is unchanged: if the loop dies, the
 * contract goes stale within PREMIERE_SUPPRESSION_STALE_MS (15 min) and
 * everything publishes.
 *
 * The `generatedAt` is always the caller's `now` — never a future/skewed
 * value — and the loop rewrites it every tick, satisfying requirement #1.
 */
export function buildLoopSuppressionContract(
  holds: readonly LoopHoldState[],
  now: Date,
): PremiereSuppressionContract {
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
  /** Writing the latest-revealed-premiere pointer the league mirror renders. */
  writeLatestPremierePointer: boolean;
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
 * writes the latest-premiere pointer, never pins, never admits, and never
 * restarts, so a shadow run is provably side-effect free against production
 * state.
 */
export function loopSideEffectPlan(shadow: boolean): LoopSideEffectPlan {
  return shadow
    ? {
        ingest: true,
        writeSuppressionContract: false,
        writeLatestPremierePointer: false,
        pinArtifacts: false,
        admit: false,
        restart: false,
      }
    : {
        ingest: true,
        writeSuppressionContract: true,
        writeLatestPremierePointer: true,
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

// ---------------------------------------------------------------------------
// Post-activation registration verification (the activation-zombie fix)
// ---------------------------------------------------------------------------

export type LoopActivationVerification =
  /** The premiere is observable — registration verified, keep tracking. */
  | { kind: "registered" }
  /** Not an activated-phase hold; verification does not apply. */
  | { kind: "not_applicable" }
  /** Unregistered and no window running: stamp `activatedAt` now. */
  | { kind: "start_window" }
  /** Unregistered but the bounded window is still open: wait. */
  | { kind: "wait" }
  /** Window elapsed and the single retry is unspent: re-activate once. */
  | { kind: "reactivate" }
  /** Window elapsed after the retry: release the hold as activation_lost. */
  | { kind: "activation_lost" };

/**
 * Decide what the tracker must do about an activated hold whose premiere may
 * not actually be registered. The 2026-07-22 round-644 incident proved a
 * successful controlled restart does not imply registration: the fresh
 * server's startup recovery can reject the admission on its own total budget
 * (`startup_deadline_exceeded`), leaving `/premiere/<id>` 404 while the loop
 * tracked "phase activated" for the full 40-minute hold window.
 *
 * Bounded by construction — every path terminates:
 * - `start_window` fires at most once per activation (it writes a valid
 *   `activatedAt`, after which the branch is unreachable);
 * - `wait` lasts at most `windowMs` per activation;
 * - `reactivate` is capped by `maxReactivations` (exactly one by default) and
 *   restarts the window by stamping a fresh `activatedAt`;
 * - `activation_lost` and `registered` end verification.
 * The hard `holdExpiresAt` valve in the caller still bounds everything above
 * this, and is never extended.
 */
export function decideActivationVerification(
  hold: LoopHoldState,
  premiereState: string | null,
  now: Date,
  windowMs: number = PREMIERE_LOOP_ACTIVATION_VERIFY_MS,
  maxReactivations: number = PREMIERE_LOOP_MAX_REACTIVATION_ATTEMPTS,
): LoopActivationVerification {
  if (premiereState !== null) {
    return { kind: "registered" };
  }
  if (hold.phase !== "activated") {
    return { kind: "not_applicable" };
  }
  const activatedAtMs =
    typeof hold.activatedAt === "string"
      ? Date.parse(hold.activatedAt)
      : Number.NaN;
  if (!Number.isFinite(activatedAtMs)) {
    return { kind: "start_window" };
  }
  if (now.getTime() - activatedAtMs < windowMs) {
    return { kind: "wait" };
  }
  if (hold.reactivationAttempts < maxReactivations) {
    return { kind: "reactivate" };
  }
  return { kind: "activation_lost" };
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
