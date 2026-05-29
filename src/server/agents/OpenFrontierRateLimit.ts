export interface OpenFrontierRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface OpenFrontierRateLimitSnapshot {
  schemaVersion: 1;
  savedAt: number;
  buckets: Array<{
    key: string;
    count: number;
    resetAt: number;
  }>;
}

export class OpenFrontierRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly options: {
      windowMs: number;
      initialSnapshot?: OpenFrontierRateLimitSnapshot;
      now?: number;
    },
  ) {
    const now = options.now ?? Date.now();
    for (const bucket of options.initialSnapshot?.buckets ?? []) {
      if (
        isSafeBucketKey(bucket.key) &&
        Number.isInteger(bucket.count) &&
        bucket.count > 0 &&
        Number.isInteger(bucket.resetAt) &&
        bucket.resetAt > now
      ) {
        this.buckets.set(bucket.key, {
          count: Math.min(bucket.count, 1_000_000),
          resetAt: bucket.resetAt,
        });
      }
    }
  }

  consume(input: {
    scope: string;
    key: string;
    limit: number;
    now?: number;
  }): OpenFrontierRateLimitResult {
    const now = input.now ?? Date.now();
    const bucketKey = `${input.scope}:${input.key}`;
    const existing = this.buckets.get(bucketKey);
    const bucket =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + this.options.windowMs }
        : existing;
    bucket.count += 1;
    this.buckets.set(bucketKey, bucket);
    this.prune(now);
    const allowed = bucket.count <= input.limit;
    return {
      allowed,
      limit: input.limit,
      remaining: Math.max(0, input.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterMs: Math.max(0, bucket.resetAt - now),
    };
  }

  snapshot(now = Date.now()): OpenFrontierRateLimitSnapshot {
    this.prune(now, { force: true });
    return {
      schemaVersion: 1,
      savedAt: now,
      buckets: [...this.buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, bucket]) => ({
          key,
          count: bucket.count,
          resetAt: bucket.resetAt,
        })),
    };
  }

  private prune(now: number, options: { force?: boolean } = {}): void {
    if (!options.force && this.buckets.size < 1_000) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

export function normalizeOpenFrontierRateLimitSnapshot(
  value: unknown,
): OpenFrontierRateLimitSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.buckets)) {
    return undefined;
  }
  const buckets = record.buckets
    .map((bucket): OpenFrontierRateLimitSnapshot["buckets"][number] | null => {
      if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) {
        return null;
      }
      const entry = bucket as Record<string, unknown>;
      if (
        typeof entry.key !== "string" ||
        !isSafeBucketKey(entry.key) ||
        typeof entry.count !== "number" ||
        typeof entry.resetAt !== "number"
      ) {
        return null;
      }
      return {
        key: entry.key,
        count: Math.max(0, Math.floor(entry.count)),
        resetAt: Math.floor(entry.resetAt),
      };
    })
    .filter(
      (bucket): bucket is OpenFrontierRateLimitSnapshot["buckets"][number] =>
        bucket !== null,
    );
  return {
    schemaVersion: 1,
    savedAt:
      typeof record.savedAt === "number" && Number.isFinite(record.savedAt)
        ? Math.floor(record.savedAt)
        : 0,
    buckets,
  };
}

function isSafeBucketKey(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[\r\n]/.test(value);
}
