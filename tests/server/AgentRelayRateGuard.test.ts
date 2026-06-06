import fs from "fs/promises";
import http from "http";
import path from "path";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  AgentRelayRateGuard,
  type AgentRelayRateGuardResponse,
} from "../../src/server/agents/AgentRelayRateGuard";
import { ProxyWarRateLimiter } from "../../src/server/agents/ProxyWarRateLimit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startApp(
  app: express.Express,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Keys requests by the first x-forwarded-for hop so a test can simulate
// distinct external clients hitting the loopback test server.
function forwardedKey(req: express.Request): string {
  const xff = req.headers["x-forwarded-for"];
  const value = Array.isArray(xff) ? xff[0] : xff;
  const first = value?.split(",")[0]?.trim();
  return first !== undefined && first !== ""
    ? `xff:${first}`
    : (req.socket.remoteAddress ?? "test");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface FakeResponse extends AgentRelayRateGuardResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

function createFakeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

// Mounts the three managed-relay route shapes with the same guard wiring the
// live demo server uses (rate limit on all three; concurrency cap on poll),
// with trivial downstream handlers so the test isolates the guard.
function mountRelayRoutes(
  guard: AgentRelayRateGuard<express.Request>,
  pollHandler: (req: express.Request, res: express.Response) => unknown = (
    _req,
    res,
  ) => res.json({ ok: true, status: "idle" }),
): express.Express {
  const app = express();
  app.use(express.json());
  app.get("/api/agent-relay/sessions/:sessionID/poll", async (req, res) => {
    if (!guard.enforceRequestRate(req, res)) {
      return;
    }
    const release = guard.acquirePollSlot(req, res);
    if (release === null) {
      return;
    }
    try {
      await pollHandler(req, res);
    } finally {
      release();
    }
  });
  app.post("/api/agent-relay/sessions/:sessionID/decisions", (req, res) => {
    if (!guard.enforceRequestRate(req, res)) {
      return;
    }
    res.json({ ok: true });
  });
  app.post("/api/agent-relay/sessions/:sessionID/requests", (req, res) => {
    if (!guard.enforceRequestRate(req, res)) {
      return;
    }
    res.json({ ok: true });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Request-rate limit (the headline DoS protection)
// ---------------------------------------------------------------------------

describe("AgentRelayRateGuard request-rate limit", () => {
  it("returns 429 on all three relay routes once the per-IP limit is exceeded", async () => {
    const guard = new AgentRelayRateGuard<express.Request>({
      rateLimiter: new ProxyWarRateLimiter({ windowMs: 60_000 }),
      requestsPerWindow: 3,
      maxConcurrentPolls: 50,
      key: forwardedKey,
      isTrusted: () => false,
    });
    const { baseUrl, close } = await startApp(mountRelayRoutes(guard));
    const sessionUrl = (suffix: string) =>
      `${baseUrl}/api/agent-relay/sessions/relay_abc/${suffix}`;
    const headers = { "x-forwarded-for": "203.0.113.7" };
    try {
      // Three GET polls are allowed (count 1..3 <= limit 3); the fourth is 429.
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await fetch(sessionUrl("poll"), { headers });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);

      // The scope is shared across all three routes for the same IP, so the
      // already-exhausted bucket also rejects POST /decisions and /requests.
      const decisions = await fetch(sessionUrl("decisions"), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      expect(decisions.status).toBe(429);
      expect(decisions.headers.get("retry-after")).not.toBeNull();
      expect(((await decisions.json()) as { code?: string }).code).toBe(
        "relay_rate_limited",
      );

      const requests = await fetch(sessionUrl("requests"), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      expect(requests.status).toBe(429);

      // A different client IP has an independent bucket and is still allowed.
      const otherClient = await fetch(sessionUrl("poll"), {
        headers: { "x-forwarded-for": "198.51.100.9" },
      });
      expect(otherClient.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("sets rate-limit headers on an allowed request", async () => {
    const guard = new AgentRelayRateGuard<express.Request>({
      rateLimiter: new ProxyWarRateLimiter({ windowMs: 60_000 }),
      requestsPerWindow: 5,
      maxConcurrentPolls: 50,
      key: forwardedKey,
      isTrusted: () => false,
    });
    const { baseUrl, close } = await startApp(mountRelayRoutes(guard));
    try {
      const res = await fetch(
        `${baseUrl}/api/agent-relay/sessions/relay_abc/poll`,
        { headers: { "x-forwarded-for": "203.0.113.7" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-limit")).toBe("5");
      expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
      expect(res.headers.get("x-ratelimit-reset")).not.toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent long-poll cap (socket-exhaustion protection)
// ---------------------------------------------------------------------------

describe("AgentRelayRateGuard concurrent-poll cap", () => {
  it("returns 429 on the poll route once the concurrent long-poll cap is exceeded", async () => {
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const guard = new AgentRelayRateGuard<express.Request>({
      rateLimiter: new ProxyWarRateLimiter({ windowMs: 60_000 }),
      requestsPerWindow: 0, // isolate the concurrency cap from the rate check
      maxConcurrentPolls: 2,
      key: forwardedKey,
      isTrusted: () => false,
    });
    const app = mountRelayRoutes(guard, async (_req, res) => {
      await barrier; // hold the poll slot open until the test releases it
      res.json({ ok: true, status: "idle" });
    });
    const { baseUrl, close } = await startApp(app);
    const url = `${baseUrl}/api/agent-relay/sessions/relay_abc/poll`;
    const headers = { "x-forwarded-for": "203.0.113.7" };
    try {
      const held1 = fetch(url, { headers });
      const held2 = fetch(url, { headers });
      await waitFor(() => guard.concurrentPolls("xff:203.0.113.7") === 2);

      // Both slots are held, so a third concurrent poll is rejected.
      const rejected = await fetch(url, { headers });
      expect(rejected.status).toBe(429);
      expect(((await rejected.json()) as { code?: string }).code).toBe(
        "relay_too_many_concurrent_polls",
      );

      releaseBarrier();
      const [r1, r2] = await Promise.all([held1, held2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Completing the held polls frees their slots.
      await waitFor(() => guard.concurrentPolls("xff:203.0.113.7") === 0);
    } finally {
      releaseBarrier();
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Unit behaviour (trusted bypass, release semantics)
// ---------------------------------------------------------------------------

describe("AgentRelayRateGuard unit behaviour", () => {
  it("bypasses both limits for trusted callers", () => {
    const guard = new AgentRelayRateGuard<{ key: string; trusted: boolean }>({
      rateLimiter: new ProxyWarRateLimiter({ windowMs: 60_000 }),
      requestsPerWindow: 1,
      maxConcurrentPolls: 1,
      key: (req) => req.key,
      isTrusted: (req) => req.trusted,
    });
    const req = { key: "trusted-ip", trusted: true };
    for (let i = 0; i < 25; i += 1) {
      expect(guard.enforceRequestRate(req, createFakeResponse())).toBe(true);
    }
    const r1 = guard.acquirePollSlot(req, createFakeResponse());
    const r2 = guard.acquirePollSlot(req, createFakeResponse());
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    // Trusted polls never consume a tracked slot.
    expect(guard.concurrentPolls("trusted-ip")).toBe(0);
  });

  it("caps tracked poll slots and frees them with an idempotent release", () => {
    const guard = new AgentRelayRateGuard<{ key: string }>({
      rateLimiter: new ProxyWarRateLimiter({ windowMs: 60_000 }),
      requestsPerWindow: 0,
      maxConcurrentPolls: 2,
      key: (req) => req.key,
      isTrusted: () => false,
    });
    const req = { key: "ip1" };
    const r1 = guard.acquirePollSlot(req, createFakeResponse());
    const r2 = guard.acquirePollSlot(req, createFakeResponse());
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(guard.concurrentPolls("ip1")).toBe(2);

    const capped = createFakeResponse();
    const r3 = guard.acquirePollSlot(req, capped);
    expect(r3).toBeNull();
    expect(capped.statusCode).toBe(429);
    expect((capped.body as { code?: string }).code).toBe(
      "relay_too_many_concurrent_polls",
    );

    r1?.();
    expect(guard.concurrentPolls("ip1")).toBe(1);
    // A previously-capped client can poll again once a slot frees.
    const r4 = guard.acquirePollSlot(req, createFakeResponse());
    expect(r4).not.toBeNull();
    expect(guard.concurrentPolls("ip1")).toBe(2);
    // Releasing the same slot twice is a no-op (safe in a finally block).
    r1?.();
    expect(guard.concurrentPolls("ip1")).toBe(2);
  });

  it("returns true without consuming when the rate limit is disabled", () => {
    let consumed = 0;
    const guard = new AgentRelayRateGuard<{ key: string }>({
      rateLimiter: {
        consume: () => {
          consumed += 1;
          return {
            allowed: true,
            limit: 0,
            remaining: 0,
            resetAt: 0,
            retryAfterMs: 0,
          };
        },
      },
      requestsPerWindow: 0,
      maxConcurrentPolls: 8,
      key: (req) => req.key,
    });
    expect(guard.enforceRequestRate({ key: "ip" }, createFakeResponse())).toBe(
      true,
    );
    expect(consumed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wiring: the live demo server applies the guard to all three relay routes
// ---------------------------------------------------------------------------

describe("ai-agent-demo-server relay route wiring", () => {
  it("guards all three managed-relay routes", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "scripts", "ai-agent-demo-server.ts"),
      "utf8",
    );
    expect(source).toContain("new AgentRelayRateGuard");
    expect(source).toContain(
      'firstConfiguredEnv("PROXYWAR_RATE_LIMIT_AGENT_RELAY")',
    );
    expect(source).toContain("PROXYWAR_AGENT_RELAY_MAX_CONCURRENT_POLLS");
    expect(source).toContain("isTrustedLocalRelayRequest");
    // All three relay routes enforce the request-rate limit...
    const enforceCalls =
      source.match(/agentRelayGuard\.enforceRequestRate/g) ?? [];
    expect(enforceCalls.length).toBeGreaterThanOrEqual(3);
    // ...and the long-poll route additionally caps concurrent polls.
    expect(source).toContain("agentRelayGuard.acquirePollSlot");
  });
});
