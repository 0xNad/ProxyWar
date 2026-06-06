import type { ProxyWarRateLimiter } from "./ProxyWarRateLimit";

/**
 * Minimal response surface the guard writes to. Both an Express `Response` and
 * a plain test double satisfy it structurally, so the guard can be unit-tested
 * without HTTP and reused verbatim on the live relay routes.
 */
export interface AgentRelayRateGuardResponse {
  setHeader(name: string, value: string): void;
  status(code: number): AgentRelayRateGuardResponse;
  json(body: unknown): void;
}

export interface AgentRelayRateGuardOptions<Req> {
  /** Shared limiter instance (so relay buckets persist with every other scope). */
  rateLimiter: Pick<ProxyWarRateLimiter, "consume">;
  /** Max requests per limiter window, per IP key. `<= 0` disables the rate check. */
  requestsPerWindow: number;
  /** Max simultaneously-held long polls per IP key. `<= 0` disables the cap. */
  maxConcurrentPolls: number;
  /** Derives the per-client key (usually the client IP) from a request. */
  key: (req: Req) => string;
  /**
   * Trusted callers bypass both the rate check and the concurrency cap. This is
   * how the loopback game subprocess and local self-tests stay unthrottled while
   * tunnelled external callers (the real DoS surface) are limited. Defaults to
   * treating every request as untrusted.
   */
  isTrusted?: (req: Req) => boolean;
  /** Invoked after each counted consume so the caller can persist limiter state. */
  onConsume?: () => void;
  /** Rate-limit scope name; defaults to "agent-relay". */
  scope?: string;
}

/**
 * DoS / resource-amplification guard for the managed-relay HTTP routes
 * (`/api/agent-relay/sessions/:id/{poll,decisions,requests}`), which sit ahead
 * of the beta invite gate and are reachable with only a Bearer token.
 *
 * Two independent protections:
 *  - `enforceRequestRate` bounds requests-per-window per IP (caps invalid-token
 *    hammering and general flooding).
 *  - `acquirePollSlot` bounds the number of concurrently-held long polls per IP
 *    (caps socket exhaustion via the up-to-30s `poll` long-poll), which the
 *    request-rate limit alone does not constrain.
 *
 * Token authentication and all relay behaviour remain the relay store's job;
 * this guard only decides whether a request is allowed to reach it.
 */
export class AgentRelayRateGuard<Req> {
  private readonly scope: string;
  private readonly inFlightPolls = new Map<string, number>();

  constructor(private readonly options: AgentRelayRateGuardOptions<Req>) {
    this.scope = options.scope ?? "agent-relay";
  }

  /**
   * Enforces the per-IP request-rate limit. Returns `true` when the request may
   * proceed; when it returns `false` it has already written a 429 response.
   */
  enforceRequestRate(req: Req, res: AgentRelayRateGuardResponse): boolean {
    if (this.options.requestsPerWindow <= 0 || this.options.isTrusted?.(req)) {
      return true;
    }
    const result = this.options.rateLimiter.consume({
      scope: this.scope,
      key: this.options.key(req),
      limit: this.options.requestsPerWindow,
    });
    this.options.onConsume?.();
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", new Date(result.resetAt).toISOString());
    if (result.allowed) {
      return true;
    }
    res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1_000)));
    res.status(429).json({
      ok: false,
      error:
        "Too many Proxy War managed relay requests. Slow the worker poll loop and try again.",
      code: "relay_rate_limited",
    });
    return false;
  }

  /**
   * Reserves a concurrent long-poll slot for the request's IP key. Returns a
   * release callback to call when the poll completes, or `null` when the client
   * already holds the maximum number of concurrent polls (a 429 was written).
   * The release callback is idempotent, so it is safe to call from a `finally`.
   */
  acquirePollSlot(
    req: Req,
    res: AgentRelayRateGuardResponse,
  ): (() => void) | null {
    if (this.options.maxConcurrentPolls <= 0 || this.options.isTrusted?.(req)) {
      return noop;
    }
    const key = this.options.key(req);
    const current = this.inFlightPolls.get(key) ?? 0;
    if (current >= this.options.maxConcurrentPolls) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        ok: false,
        error:
          "Too many concurrent Proxy War managed relay polls from your client. Let the in-flight poll finish before starting another.",
        code: "relay_too_many_concurrent_polls",
      });
      return null;
    }
    this.inFlightPolls.set(key, current + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = (this.inFlightPolls.get(key) ?? 1) - 1;
      if (next <= 0) {
        this.inFlightPolls.delete(key);
      } else {
        this.inFlightPolls.set(key, next);
      }
    };
  }

  /** Currently-held poll slots for a key (introspection / tests). */
  concurrentPolls(key: string): number {
    return this.inFlightPolls.get(key) ?? 0;
  }
}

function noop(): void {}
