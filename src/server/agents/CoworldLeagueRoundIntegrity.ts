import { createHash } from "node:crypto";

/**
 * Coworld round-integrity monitoring is deliberately separate from the replay
 * feed. Rankings are written from episode-request score rows; a missing replay
 * can make a battle temporarily unwatchable without invalidating its score,
 * while a nominally completed request with no executed episode cannot support
 * a ranking even if the round itself says `completed`.
 *
 * This module is the repository-owned, pure detector boundary. The league
 * mirror uses it now, and the machine-local league sentinel can import/copy the
 * same tested contract when its installer is next revised. Do not duplicate
 * these predicates in the sentinel.
 */

export const COWORLD_ROUND_INTEGRITY_CONFIRMATION_MS = 60_000;
export const COWORLD_ROUND_INTEGRITY_HISTORY_LIMIT = 10;

type UnknownRecord = Record<string, unknown>;

export interface CoworldLadderIntegritySettings {
  expectedEpisodesPerRound: number;
  roundIntervalMinutes: number;
  allowedFailureRate: number;
  allowedFailureCount: number;
}

export type CoworldRoundIntegrityFailureKind =
  | "phantom_completed_request"
  | "other_effective_failure";

export interface CoworldRoundIntegrityAssessment {
  roundId: string;
  roundNumber: number;
  completedAt: string;
  expectedEpisodeCount: number;
  observedEpisodeCount: number;
  scoreBearingCount: number;
  effectiveFailureCount: number;
  phantomFailureCount: number;
  otherFailureCount: number;
  allowedFailureCount: number;
  allowedFailureRate: number;
  verdict: "healthy" | "breach";
  evidenceHash: string;
}

export type CoworldRoundIntegrityEvaluation =
  | {
      kind: "ignored";
      reason: "round_not_terminal_completed" | "round_identity_missing";
    }
  | {
      kind: "incomplete";
      roundId: string;
      roundNumber: number;
      expectedEpisodeCount: number;
      observedEpisodeCount: number;
      reason:
        | "episode_count_incomplete"
        | "episode_count_unexpected"
        | "episode_identity_incomplete"
        | "episode_round_mismatch"
        | "episode_still_in_progress";
    }
  | {
      kind: "assessed";
      assessment: CoworldRoundIntegrityAssessment;
    };

export interface CoworldRoundIntegrityBreachObservation {
  roundId: string;
  evidenceHash: string;
  firstObservedAt: string;
}

export interface CoworldRoundIntegrityState {
  status: "healthy" | "confirmation_pending" | "degraded";
  checkedAt: string;
  settings: CoworldLadderIntegritySettings;
  latestCompletedRound: CoworldRoundIntegrityAssessment;
  lastConfirmedBreach: CoworldRoundIntegrityAssessment | null;
  breachObservations: CoworldRoundIntegrityBreachObservation[];
}

export interface CoworldRoundIntegrityCriticalSignal {
  class: "round_incomplete_execution";
  key: string;
  severity: "critical";
  detail: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.entries)) return record.entries;
  if (record && Array.isArray(record.episodes)) return record.episodes;
  if (record && Array.isArray(record.rounds)) return record.rounds;
  return [];
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function positiveInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0
    ? number
    : null;
}

/**
 * Parses the current Observatory league contract. These values moved out of
 * `commissioner_config`: the authoritative shape is now
 * `settings.ladder.scheduler.num_episodes`,
 * `settings.round_interval_minutes`, and
 * `settings.ladder.fulfillment.allowed_failures`.
 */
export function parseCoworldLadderIntegritySettings(
  value: unknown,
): CoworldLadderIntegritySettings | null {
  const direct = asRecord(value);
  const league =
    direct !== null && nonemptyString(direct.id) !== null
      ? direct
      : (asRecord(asArray(value)[0]) ?? null);
  const settings = asRecord(league?.settings);
  const ladder = asRecord(settings?.ladder);
  const scheduler = asRecord(ladder?.scheduler);
  const fulfillment = asRecord(ladder?.fulfillment);
  const expectedEpisodesPerRound = positiveInteger(scheduler?.num_episodes);
  const roundIntervalMinutes = finiteNumber(settings?.round_interval_minutes);
  const allowedFailureRate = finiteNumber(fulfillment?.allowed_failures);
  if (
    expectedEpisodesPerRound === null ||
    roundIntervalMinutes === null ||
    roundIntervalMinutes <= 0 ||
    allowedFailureRate === null ||
    allowedFailureRate < 0 ||
    allowedFailureRate > 1
  ) {
    return null;
  }
  return {
    expectedEpisodesPerRound,
    roundIntervalMinutes,
    allowedFailureRate,
    // A fractional episode is not an allowed failure. At 25 × 0.05 this is
    // one: 24/25 is inside tolerance, while 23/25 is a breach.
    allowedFailureCount: Math.floor(
      expectedEpisodesPerRound * allowedFailureRate + Number.EPSILON,
    ),
  };
}

function policyVersionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.map(nonemptyString);
  if (ids.some((id) => id === null)) return null;
  const strings = ids as string[];
  return new Set(strings).size === strings.length ? strings : null;
}

/**
 * A score-bearing run must prove that an episode actually ran and that every
 * scheduled policy has exactly one finite numeric score. `status=completed`
 * alone is not evidence: Coworld's phantom requests have that status while
 * carrying no episode id, no running timestamp, and no scores.
 */
export function isCoworldScoreBearingEpisode(value: unknown): boolean {
  const episode = asRecord(value);
  if (
    episode === null ||
    episode.status !== "completed" ||
    nonemptyString(episode.episode_id) === null ||
    nonemptyString(episode.running_at) === null ||
    !isNullish(episode.error)
  ) {
    return false;
  }
  const expectedPolicyIds = policyVersionIds(episode.policy_version_ids);
  if (expectedPolicyIds === null || !Array.isArray(episode.scores)) {
    return false;
  }
  const scoreIds: string[] = [];
  for (const value of episode.scores) {
    const score = asRecord(value);
    const policyVersionId = nonemptyString(score?.policy_version_id);
    if (policyVersionId === null || finiteNumber(score?.score) === null) {
      return false;
    }
    scoreIds.push(policyVersionId);
  }
  if (
    scoreIds.length === 0 ||
    scoreIds.length !== expectedPolicyIds.length ||
    new Set(scoreIds).size !== scoreIds.length
  ) {
    return false;
  }
  const expected = new Set(expectedPolicyIds);
  return scoreIds.every((id) => expected.has(id));
}

/** Exact production signature observed in rounds 1884 and 1897. */
export function isCoworldPhantomCompletedEpisode(value: unknown): boolean {
  const episode = asRecord(value);
  return (
    episode !== null &&
    episode.status === "completed" &&
    isNullish(episode.episode_id) &&
    isNullish(episode.running_at) &&
    isNullish(episode.error) &&
    Array.isArray(episode.scores) &&
    episode.scores.length === 0
  );
}

const terminalEpisodeStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "timed_out",
  "timeout",
  "error",
]);

function episodeEvidenceClass(
  value: unknown,
): "score_bearing" | CoworldRoundIntegrityFailureKind {
  if (isCoworldScoreBearingEpisode(value)) return "score_bearing";
  if (isCoworldPhantomCompletedEpisode(value)) {
    return "phantom_completed_request";
  }
  return "other_effective_failure";
}

function evidenceHash(
  rows: Array<{ id: string; classification: string }>,
): string {
  const canonical = rows
    // Explicit UTF-16 code-unit order keeps the evidence identity stable
    // across host locales (unlike localeCompare).
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((row) => `${row.id}:${row.classification}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Classifies one round only after BOTH the round and its complete episode row
 * set are terminal. A completed round with 23/25 visible rows, or with a row
 * still pending/running, is incomplete evidence—not two failures.
 */
export function evaluateCoworldRoundIntegrity(args: {
  round: unknown;
  episodeRows: unknown;
  settings: CoworldLadderIntegritySettings;
}): CoworldRoundIntegrityEvaluation {
  const round = asRecord(args.round);
  const roundId = nonemptyString(round?.id);
  const roundNumber = finiteNumber(round?.round_number);
  const completedAt = nonemptyString(round?.completed_at);
  if (roundId === null || roundNumber === null) {
    return { kind: "ignored", reason: "round_identity_missing" };
  }
  if (round?.status !== "completed" || completedAt === null) {
    return { kind: "ignored", reason: "round_not_terminal_completed" };
  }
  const rows = asArray(args.episodeRows);
  const baseIncomplete = {
    kind: "incomplete" as const,
    roundId,
    roundNumber,
    expectedEpisodeCount: args.settings.expectedEpisodesPerRound,
    observedEpisodeCount: rows.length,
  };
  if (rows.length < args.settings.expectedEpisodesPerRound) {
    return { ...baseIncomplete, reason: "episode_count_incomplete" };
  }
  if (rows.length > args.settings.expectedEpisodesPerRound) {
    return { ...baseIncomplete, reason: "episode_count_unexpected" };
  }
  const ids = rows.map((row) => nonemptyString(asRecord(row)?.id));
  if (
    ids.some((id) => id === null) ||
    new Set(ids as string[]).size !== ids.length
  ) {
    return { ...baseIncomplete, reason: "episode_identity_incomplete" };
  }
  if (
    rows.some((row) => {
      const rowRoundId = nonemptyString(asRecord(row)?.round_id);
      return rowRoundId !== roundId;
    })
  ) {
    return { ...baseIncomplete, reason: "episode_round_mismatch" };
  }
  if (
    rows.some((row) => {
      const status = nonemptyString(asRecord(row)?.status);
      return status === null || !terminalEpisodeStatuses.has(status);
    })
  ) {
    return { ...baseIncomplete, reason: "episode_still_in_progress" };
  }

  const classified = rows.map((row, index) => ({
    id: (ids[index] as string) ?? "",
    classification: episodeEvidenceClass(row),
  }));
  const scoreBearingCount = classified.filter(
    (row) => row.classification === "score_bearing",
  ).length;
  const phantomFailureCount = classified.filter(
    (row) => row.classification === "phantom_completed_request",
  ).length;
  const effectiveFailureCount = rows.length - scoreBearingCount;
  const otherFailureCount = effectiveFailureCount - phantomFailureCount;
  const assessment: CoworldRoundIntegrityAssessment = {
    roundId,
    roundNumber,
    completedAt,
    expectedEpisodeCount: args.settings.expectedEpisodesPerRound,
    observedEpisodeCount: rows.length,
    scoreBearingCount,
    effectiveFailureCount,
    phantomFailureCount,
    otherFailureCount,
    allowedFailureCount: args.settings.allowedFailureCount,
    allowedFailureRate: args.settings.allowedFailureRate,
    verdict:
      effectiveFailureCount > args.settings.allowedFailureCount
        ? "breach"
        : "healthy",
    evidenceHash: evidenceHash(classified),
  };
  return { kind: "assessed", assessment };
}

export function recentTerminalCompletedRounds(
  value: unknown,
  limit = COWORLD_ROUND_INTEGRITY_HISTORY_LIMIT,
): UnknownRecord[] {
  return asArray(value)
    .map(asRecord)
    .filter(
      (round): round is UnknownRecord =>
        round !== null &&
        round.status === "completed" &&
        nonemptyString(round.completed_at) !== null,
    )
    .sort(
      (left, right) =>
        (finiteNumber(right.round_number) ?? Number.NEGATIVE_INFINITY) -
        (finiteNumber(left.round_number) ?? Number.NEGATIVE_INFINITY),
    )
    .slice(0, Math.max(0, limit));
}

export function episodeRowsByRoundId(value: unknown): Map<string, unknown[]> {
  const byRound = new Map<string, unknown[]>();
  for (const row of asArray(value)) {
    const roundId = nonemptyString(asRecord(row)?.round_id);
    if (roundId === null) continue;
    const rows = byRound.get(roundId) ?? [];
    rows.push(row);
    byRound.set(roundId, rows);
  }
  return byRound;
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function laterAssessment(
  left: CoworldRoundIntegrityAssessment | null,
  right: CoworldRoundIntegrityAssessment | null,
): CoworldRoundIntegrityAssessment | null {
  if (left === null) return right;
  if (right === null) return left;
  return right.roundNumber > left.roundNumber ? right : left;
}

/**
 * Reconciles repeated read-only observations. The first breach is surfaced as
 * confirmation-pending. The same round/evidence hash must still be present at
 * least 60 seconds later before it degrades the league. A newer healthy round
 * clears current degradation but never erases the bounded last-breach record.
 */
export function reconcileCoworldRoundIntegrity(args: {
  previous: CoworldRoundIntegrityState | null;
  settings: CoworldLadderIntegritySettings;
  assessments: CoworldRoundIntegrityAssessment[];
  checkedAt: string;
  confirmationMs?: number;
}): CoworldRoundIntegrityState | null {
  const checkedAtMs = parseTimestamp(args.checkedAt);
  if (checkedAtMs === null || args.assessments.length === 0) return null;
  const assessments = [...args.assessments].sort(
    (left, right) => right.roundNumber - left.roundNumber,
  );
  const latestCompletedRound = assessments[0];
  const previousObservations = new Map(
    (args.previous?.breachObservations ?? []).map((observation) => [
      `${observation.roundId}:${observation.evidenceHash}`,
      observation,
    ]),
  );
  const breachObservations = assessments
    .filter((assessment) => assessment.verdict === "breach")
    .map((assessment) => {
      const key = `${assessment.roundId}:${assessment.evidenceHash}`;
      return (
        previousObservations.get(key) ?? {
          roundId: assessment.roundId,
          evidenceHash: assessment.evidenceHash,
          firstObservedAt: args.checkedAt,
        }
      );
    })
    .slice(0, COWORLD_ROUND_INTEGRITY_HISTORY_LIMIT);
  const confirmationMs =
    args.confirmationMs ?? COWORLD_ROUND_INTEGRITY_CONFIRMATION_MS;
  const confirmedThisCycle = assessments.filter((assessment) => {
    if (assessment.verdict !== "breach") return false;
    const observation = breachObservations.find(
      (candidate) =>
        candidate.roundId === assessment.roundId &&
        candidate.evidenceHash === assessment.evidenceHash,
    );
    const firstObservedAt =
      observation === undefined
        ? null
        : parseTimestamp(observation.firstObservedAt);
    return (
      firstObservedAt !== null &&
      checkedAtMs - firstObservedAt >= confirmationMs
    );
  });
  let lastConfirmedBreach = args.previous?.lastConfirmedBreach ?? null;
  for (const assessment of confirmedThisCycle) {
    lastConfirmedBreach = laterAssessment(lastConfirmedBreach, assessment);
  }
  const latestStillPreviouslyConfirmed =
    latestCompletedRound.verdict === "breach" &&
    args.previous?.lastConfirmedBreach?.roundId ===
      latestCompletedRound.roundId;
  const latestConfirmed =
    latestStillPreviouslyConfirmed ||
    confirmedThisCycle.some(
      (assessment) => assessment.roundId === latestCompletedRound.roundId,
    );
  return {
    status:
      latestCompletedRound.verdict === "healthy"
        ? "healthy"
        : latestConfirmed
          ? "degraded"
          : "confirmation_pending",
    checkedAt: args.checkedAt,
    settings: args.settings,
    latestCompletedRound,
    lastConfirmedBreach,
    breachObservations,
  };
}

/** A failed/partial probe never clears a previous verified assessment. */
export function retainCoworldRoundIntegrityOnIncompleteProbe(
  previous: CoworldRoundIntegrityState | null | undefined,
): CoworldRoundIntegrityState | undefined {
  return previous ?? undefined;
}

/**
 * Adapter for `pw-league-sentinel.mjs`'s existing signal/recheck machinery.
 * The sentinel may emit this candidate immediately; its existing 60-second
 * re-collection confirms persistence before autofix/alert action. Incomplete
 * and healthy assessments deliberately emit no critical signal.
 */
export function coworldRoundIntegrityCriticalSignal(
  assessment: CoworldRoundIntegrityAssessment,
): CoworldRoundIntegrityCriticalSignal | null {
  if (assessment.verdict !== "breach") return null;
  return {
    class: "round_incomplete_execution",
    key: assessment.roundId,
    severity: "critical",
    detail: `round ${assessment.roundNumber} produced ${assessment.scoreBearingCount}/${assessment.expectedEpisodeCount} score-bearing episodes; ${assessment.effectiveFailureCount} effective failure(s) exceed the allowed ${assessment.allowedFailureCount}; ${assessment.phantomFailureCount} match the completed-without-running phantom signature`,
  };
}
