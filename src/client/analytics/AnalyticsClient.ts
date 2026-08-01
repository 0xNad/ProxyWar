import type { AnalyticsBatch, AnalyticsEvent, AnalyticsEventContext, AnalyticsEventName } from "./AnalyticsEvents";
import { ANALYTICS_SCHEMA_VERSION } from "./AnalyticsEvents";
import { loadOrCreateVisitorIdentity, type VisitorIdentity } from "./VisitorId";

/**
 * Tiny, dependency-free client emitter for the Phase 7 product-analytics
 * event stream. Deliberately not the module that validates event shape —
 * see `AnalyticsEvents.ts`'s doc for why there's no zod here — every method
 * is wrapped so a caller can never observe an exception from this module,
 * and every network attempt is fire-and-forget (`.catch(() => undefined)`,
 * never awaited for correctness by any call site).
 *
 * No page imports this yet (Season Zero Phase 7 ships the collector before
 * the instrumentation pass); `export const analytics` is the singleton the
 * later pass will import and call `.trackVisitStart()` / `.track(...)`
 * from. Nothing here is started until the first `track`/`trackVisitStart`
 * call, so merely importing this module (e.g. transitively, or in a test)
 * has zero side effects — no timer, no listener.
 */

const DEFAULT_ENDPOINT = "/api/analytics/events";
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
/** Matches the server's per-batch cap (`AnalyticsBatchSchema`'s `events.max(25)`) — no point buffering past what one flush can ever send. */
const DEFAULT_MAX_QUEUE_SIZE = 25;

export interface AnalyticsClientOptions {
  endpoint?: string;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  /** Injectable for tests; defaults to `window.localStorage` via VisitorId.ts. */
  storage?: Storage;
}

export class AnalyticsClient {
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly storage: Storage | undefined;
  private readonly available: boolean;

  private queue: AnalyticsEvent[] = [];
  private visitor: VisitorIdentity | undefined;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  private pagehideListener: (() => void) | undefined;
  private visibilityListener: (() => void) | undefined;

  constructor(options: AnalyticsClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.storage = options.storage;
    this.available =
      typeof window !== "undefined" && typeof fetch === "function" && typeof window.location === "object";
  }

  /** Records a page view and, when the visitor id already existed before this call, a returning-visitor event. `authenticated` is supplied by the caller — this module never infers login state itself. */
  trackVisitStart(options: { authenticated?: boolean } = {}): void {
    this.track("page_viewed");
    const visitor = this.ensureStarted();
    if (visitor?.isReturning === true) {
      this.track(options.authenticated ? "returning_authenticated_visitor" : "returning_anonymous_visitor");
    }
  }

  track(name: AnalyticsEventName, context?: AnalyticsEventContext): void {
    if (!this.available) {
      return;
    }
    try {
      this.ensureStarted();
      if (this.queue.length >= this.maxQueueSize) {
        // Bounded buffer: drop rather than grow. A burst of untracked events
        // is an acceptable loss; unbounded memory growth is not.
        return;
      }
      const event: AnalyticsEvent = {
        name,
        occurredAt: new Date().toISOString(),
        route: window.location.pathname,
        ...(context !== undefined ? { context } : {}),
      };
      this.queue.push(event);
    } catch {
      // Analytics must never throw into caller code.
    }
  }

  flush(useBeacon = false): void {
    if (!this.available || this.queue.length === 0 || this.visitor === undefined) {
      return;
    }
    const events = this.queue;
    this.queue = [];
    try {
      const batch: AnalyticsBatch = {
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        visitorId: this.visitor.id,
        events,
      };
      const body = JSON.stringify(batch);
      if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const sent = navigator.sendBeacon(this.endpoint, new Blob([body], { type: "application/json" }));
        if (sent) {
          return;
        }
      }
      void fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Analytics must never throw into caller code.
    }
  }

  /** Stops the flush interval and detaches listeners. Only needed by tests and hot-reload teardown; a real page never calls this. */
  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    if (this.available) {
      if (this.pagehideListener !== undefined) {
        window.removeEventListener("pagehide", this.pagehideListener);
      }
      if (this.visibilityListener !== undefined) {
        document.removeEventListener("visibilitychange", this.visibilityListener);
      }
    }
    this.pagehideListener = undefined;
    this.visibilityListener = undefined;
  }

  private ensureStarted(): VisitorIdentity | undefined {
    if (!this.available) {
      return undefined;
    }
    if (this.visitor !== undefined) {
      return this.visitor;
    }
    this.visitor = loadOrCreateVisitorIdentity(this.storage);
    this.intervalHandle = setInterval(() => this.flush(false), this.flushIntervalMs);
    this.pagehideListener = () => this.flush(true);
    this.visibilityListener = () => {
      if (document.visibilityState === "hidden") {
        this.flush(true);
      }
    };
    window.addEventListener("pagehide", this.pagehideListener);
    document.addEventListener("visibilitychange", this.visibilityListener);
    return this.visitor;
  }
}

export const analytics = new AnalyticsClient();
