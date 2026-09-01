import { canonicalCoworldLeaguePauseTimestamp } from "./CoworldLeaguePause";

type UnknownRecord = Record<string, unknown>;

export interface CoworldLeagueSchedulerGap {
  fromRoundNumber: number;
  toRoundNumber: number;
  fromCompletedAt: string;
  toCreatedAt: string;
  gapSeconds: number;
}

export interface CoworldLeagueSchedulerHealth {
  status: "healthy" | "delayed" | "paused" | "unavailable";
  checkedAt: string;
  roundIntervalMinutes: number | null;
  delayThresholdSeconds: number | null;
  latestRoundNumber: number | null;
  latestActivityAt: string | null;
  secondsSinceLatestActivity: number | null;
  latestObservedGap: CoworldLeagueSchedulerGap | null;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return record && Array.isArray(record.entries) ? record.entries : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestamp(
  value: unknown,
): { iso: string; milliseconds: number } | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? { iso: value, milliseconds } : null;
}

function latestTimestamp(
  rows: UnknownRecord[],
): { iso: string; milliseconds: number } | null {
  let latest: { iso: string; milliseconds: number } | null = null;
  for (const row of rows) {
    for (const field of ["created_at", "started_at", "completed_at"] as const) {
      const candidate = timestamp(row[field]);
      if (
        candidate !== null &&
        candidate.milliseconds > (latest?.milliseconds ?? -1)
      ) {
        latest = candidate;
      }
    }
  }
  return latest;
}

/**
 * Read-only scheduler liveness derived from hosted round timestamps. Two hours
 * is the minimum alert window so normal episode duration and short Coworld
 * queue variance do not page the league; faster ladders still get a threshold
 * of three configured round intervals.
 */
export function evaluateCoworldLeagueSchedulerHealth(args: {
  rounds: unknown;
  roundsPausedAt: unknown;
  roundIntervalMinutes: number | null;
  checkedAt: string;
}): CoworldLeagueSchedulerHealth {
  const checkedAt = timestamp(args.checkedAt);
  const rows = asArray(args.rounds)
    .map(asRecord)
    .filter((row): row is UnknownRecord => row !== null);
  const numberedRows = rows
    .flatMap((row) => {
      const roundNumber = finiteNumber(row.round_number);
      return roundNumber === null ? [] : [{ row, roundNumber }];
    })
    .sort((left, right) => left.roundNumber - right.roundNumber);
  const interval = args.roundIntervalMinutes;
  const validInterval =
    interval !== null && Number.isFinite(interval) && interval > 0
      ? interval
      : null;
  const delayThresholdSeconds =
    validInterval === null
      ? null
      : Math.ceil(Math.max(120, validInterval * 3) * 60);
  const activity = latestTimestamp(rows);
  const secondsSinceLatestActivity =
    activity === null || checkedAt === null
      ? null
      : Math.max(
          0,
          Math.floor((checkedAt.milliseconds - activity.milliseconds) / 1_000),
        );

  let latestObservedGap: CoworldLeagueSchedulerGap | null = null;
  if (delayThresholdSeconds !== null) {
    for (let index = 1; index < numberedRows.length; index += 1) {
      const previous = numberedRows[index - 1];
      const current = numberedRows[index];
      // A bounded/listing read may omit intermediate rounds. Only adjacent
      // round numbers can prove a scheduler gap; otherwise the missing rows
      // themselves could contain the activity we are trying to measure.
      if (current.roundNumber !== previous.roundNumber + 1) continue;
      const fromCompleted = timestamp(previous.row.completed_at);
      const toCreated = timestamp(current.row.created_at);
      if (fromCompleted === null || toCreated === null) continue;
      const gapSeconds = Math.floor(
        (toCreated.milliseconds - fromCompleted.milliseconds) / 1_000,
      );
      if (gapSeconds > delayThresholdSeconds) {
        latestObservedGap = {
          fromRoundNumber: previous.roundNumber,
          toRoundNumber: current.roundNumber,
          fromCompletedAt: fromCompleted.iso,
          toCreatedAt: toCreated.iso,
          gapSeconds,
        };
      }
    }
  }

  const paused =
    canonicalCoworldLeaguePauseTimestamp(args.roundsPausedAt) !== null;
  const status: CoworldLeagueSchedulerHealth["status"] = paused
    ? "paused"
    : checkedAt === null ||
        delayThresholdSeconds === null ||
        activity === null ||
        numberedRows.length === 0
      ? "unavailable"
      : secondsSinceLatestActivity !== null &&
          secondsSinceLatestActivity > delayThresholdSeconds
        ? "delayed"
        : "healthy";
  return {
    status,
    checkedAt: args.checkedAt,
    roundIntervalMinutes: validInterval,
    delayThresholdSeconds,
    latestRoundNumber:
      numberedRows[numberedRows.length - 1]?.roundNumber ?? null,
    latestActivityAt: activity?.iso ?? null,
    secondsSinceLatestActivity,
    latestObservedGap,
  };
}
