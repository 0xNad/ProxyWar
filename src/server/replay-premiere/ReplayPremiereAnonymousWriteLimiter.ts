import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type {
  ReplayPremiereAnonymousWriteAdmission,
  ReplayPremiereAnonymousWriteAdmissionRequest,
} from "./ReplayPremiereInteractions";

export interface ReplayPremiereAnonymousWriteLimiterOptions {
  windowMs?: number;
  maxGlobalAttemptsPerWindow?: number;
  maxPremiereAttemptsPerWindow?: number;
  maxBucketAttemptsPerWindow?: number;
  maxParticipantAttemptsPerWindow?: number;
  maxSessionAttemptsPerWindow?: number;
  maxTrackedKeys?: number;
  now?: () => Date;
}

interface Counter {
  window: number;
  count: number;
}

/**
 * Synchronous process-wide admission for every anonymous write attempt. One
 * instance must be shared by all registered premieres in a server process.
 * Keys contain only opaque HMAC buckets and public premiere/session/guest IDs.
 */
export class ReplayPremiereAnonymousWriteLimiter {
  readonly admit: ReplayPremiereAnonymousWriteAdmission;

  private readonly windowMs: number;
  private readonly limits: {
    global: number;
    premiere: number;
    bucket: number;
    participant: number;
    session: number;
  };
  private readonly maxTrackedKeys: number;
  private readonly now: () => Date;
  private global: Counter = { window: -1, count: 0 };
  private readonly premieres = new Map<string, Counter>();
  private readonly buckets = new Map<string, Counter>();
  private readonly participants = new Map<string, Counter>();
  private readonly sessions = new Map<string, Counter>();

  constructor(options: ReplayPremiereAnonymousWriteLimiterOptions = {}) {
    this.windowMs = bounded(
      options.windowMs ?? 60_000,
      1_000,
      60 * 60 * 1_000,
      "invalid_anonymous_window",
    );
    this.limits = {
      global: bounded(
        options.maxGlobalAttemptsPerWindow ?? 20_000,
        1,
        1_000_000,
        "invalid_global_attempt_limit",
      ),
      premiere: bounded(
        options.maxPremiereAttemptsPerWindow ?? 10_000,
        1,
        1_000_000,
        "invalid_premiere_attempt_limit",
      ),
      bucket: bounded(
        options.maxBucketAttemptsPerWindow ?? 240,
        1,
        100_000,
        "invalid_bucket_attempt_limit",
      ),
      participant: bounded(
        options.maxParticipantAttemptsPerWindow ?? 180,
        1,
        100_000,
        "invalid_participant_attempt_limit",
      ),
      session: bounded(
        options.maxSessionAttemptsPerWindow ?? 120,
        1,
        100_000,
        "invalid_session_attempt_limit",
      ),
    };
    this.maxTrackedKeys = bounded(
      options.maxTrackedKeys ?? 50_000,
      100,
      1_000_000,
      "invalid_tracked_key_limit",
    );
    this.now = options.now ?? (() => new Date());
    this.admit = (request) => this.admitAttempt(request);
  }

  readTrackedKeyCount(): number {
    return (
      this.premieres.size +
      this.buckets.size +
      this.participants.size +
      this.sessions.size
    );
  }

  private admitAttempt(
    request: ReplayPremiereAnonymousWriteAdmissionRequest,
  ): void {
    const nowMs = this.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw rejected("anonymous_limiter_clock_invalid", 503);
    }
    const window = Math.floor(nowMs / this.windowMs);
    if (this.global.window > window) {
      throw rejected("anonymous_limiter_clock_regressed", 503);
    }
    if (this.global.window !== window) {
      this.global = { window, count: 0 };
    }
    this.compact(window);
    if (this.global.count >= this.limits.global) {
      throw rejected("anonymous_global_attempt_limit", 429);
    }
    const descriptors: Array<{
      map: Map<string, Counter>;
      key: string;
      limit: number;
      code: string;
    }> = [
      {
        map: this.premieres,
        key: request.premiereId,
        limit: this.limits.premiere,
        code: "anonymous_premiere_attempt_limit",
      },
      {
        map: this.buckets,
        key: request.requesterBucketId,
        limit: this.limits.bucket,
        code: "anonymous_bucket_attempt_limit",
      },
      {
        map: this.participants,
        key: request.participantId,
        limit: this.limits.participant,
        code: "anonymous_participant_attempt_limit",
      },
    ];
    if (request.sessionId !== null) {
      descriptors.push({
        map: this.sessions,
        key: request.sessionId,
        limit: this.limits.session,
        code: "anonymous_session_attempt_limit",
      });
    }
    const exceeded = descriptors.find(
      ({ map, key, limit }) => this.currentCount(map, key, window) >= limit,
    );
    if (exceeded !== undefined) throw rejected(exceeded.code, 429);
    const newKeyCount = descriptors.filter(
      ({ map, key }) => !this.hasCurrentCounter(map, key, window),
    ).length;
    if (this.readTrackedKeyCount() + newKeyCount > this.maxTrackedKeys) {
      throw rejected("anonymous_limiter_key_capacity", 429);
    }
    const counters = descriptors.map(({ map, key }) =>
      this.counter(map, key, window),
    );
    this.global.count += 1;
    for (const counter of counters) counter.count += 1;
  }

  private currentCount(
    map: Map<string, Counter>,
    key: string,
    window: number,
  ): number {
    const counter = map.get(key);
    return counter?.window === window ? counter.count : 0;
  }

  private hasCurrentCounter(
    map: Map<string, Counter>,
    key: string,
    window: number,
  ): boolean {
    const counter = map.get(key);
    return counter !== undefined && counter.window === window;
  }

  private counter(
    map: Map<string, Counter>,
    key: string,
    window: number,
  ): Counter {
    const existing = map.get(key);
    if (existing !== undefined) {
      if (existing.window !== window) {
        existing.window = window;
        existing.count = 0;
      }
      return existing;
    }
    if (
      this.premieres.size +
        this.buckets.size +
        this.participants.size +
        this.sessions.size >=
      this.maxTrackedKeys
    ) {
      throw rejected("anonymous_limiter_key_capacity", 429);
    }
    const created = { window, count: 0 };
    map.set(key, created);
    return created;
  }

  private compact(window: number): void {
    if (
      this.premieres.size +
        this.buckets.size +
        this.participants.size +
        this.sessions.size <
      this.maxTrackedKeys / 2
    ) {
      return;
    }
    for (const map of [
      this.premieres,
      this.buckets,
      this.participants,
      this.sessions,
    ]) {
      for (const [key, counter] of map) {
        if (counter.window !== window) map.delete(key);
      }
    }
  }
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  operatorCode: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw rejected(operatorCode, 500);
  }
  return value;
}

function rejected(operatorCode: string, status: number): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    status === 429 ? "PREMIERE_CAPACITY_EXCEEDED" : "PREMIERE_UNAVAILABLE",
    status,
    `Replay Premiere anonymous write rejected: ${operatorCode}`,
  );
}
