/**
 * Proves the betting page's content-source switch end to end, through the
 * REAL client class (`ReplayPremiereNetworkController` with
 * `contentSource: "tap"`) against a REAL running server — not a mock of
 * either side. This is the client-side half of the anti-read-ahead
 * property; `tests/server/replay-premiere/wagering/ReplayPremiereLiveVisibility.test.ts`
 * already proves the wire-level route itself never transmits a record
 * ahead of the authoritative clock. This file proves the CLIENT that
 * consumes it — the actual code path the betting page ships — never asks
 * for more than it should, never accidentally falls back to chunk
 * delivery, and every record it actually received (not rendered — RECEIVED,
 * captured straight off the HTTP response body) obeys the same clock
 * bound at the instant of that specific request.
 */
import compression from "compression";
import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReplayPremiereNetworkController,
  type ReplayPremiereNetworkCallbacks,
} from "../../src/client/ReplayPremiereNetwork";
import { ReplayPremierePlaybackController } from "../../src/client/ReplayPremierePlayback";
import { ReplayPremiereAnonymousWriteLimiter } from "../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereAdmissionCatalog } from "../../src/server/replay-premiere/ReplayPremiereCatalog";
import { freezeReplayPremiereCheckpointProjection } from "../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { PREMIERE_REAL_TURN_INTERVAL_MS } from "../../src/server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereGuestSecurity } from "../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  ReplayPremiereHttpRegistry,
} from "../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  MAX_LIVE_PROJECTION_RECORDS,
  ReplayPremiereRuntimeRegistry,
} from "../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import {
  startReplayPremiereProduction,
  type ReplayPremiereProductionService,
} from "../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  NOW,
  PREMIERE_ID,
  verifiedRealtimeLongPublicationFixture,
} from "../server/replay-premiere/ReplayPremiereFixtures";

const ORIGIN = "https://beta.proxywar.xyz";
const COLLECTOR_LIMITS = {
  maxTargets: 256,
  maxTargetUrlBytes: 4_096,
  maxBodyBytesPerTarget: 1_000_000,
  maxTotalBodyBytes: 8_000_000,
  maxHeaderBytesPerTarget: 16_384,
  maxHeaderCountPerTarget: 64,
  requestTimeoutMs: 1_000,
  totalTimeoutMs: 10_000,
} as const;

function startupContext() {
  const now = () => new Date();
  const security = new ReplayPremiereGuestSecurity({
    hmacKey: new Uint8Array(32).fill(7),
    expectedOrigin: ORIGIN,
    production: true,
    now,
  });
  const limiter = new ReplayPremiereAnonymousWriteLimiter({ now });
  return {
    security,
    httpRegistry: new ReplayPremiereHttpRegistry(limiter.admit),
    runtimeRegistry: new ReplayPremiereRuntimeRegistry(),
    checkpointProjector: {
      async project({
        gate,
      }: Parameters<
        Parameters<
          typeof startReplayPremiereProduction
        >[0]["checkpointProjector"]["project"]
      >[0]) {
        const definition = gate.publicDefinition();
        const optionSeatIds = definition.provenance.seats.map(
          (seat) => seat.seatId,
        );
        return freezeReplayPremiereCheckpointProjection({
          premiereId: gate.premiereId,
          publicationCommitmentHash: gate.publicationCommitmentHash,
          checkpoints: [
            { ...definition.checkpoints[0], optionSeatIds },
            { ...definition.checkpoints[1], optionSeatIds },
          ],
        });
      },
    },
    publicOrigin: ORIGIN,
    clock: { now },
  };
}

/**
 * Shared boot for the two tests below: an admitted realtime-long fixture
 * behind a REAL HTTP server running the exact same
 * `createReplayPremiereRouter` wiring as `ai-agent-demo-server.ts`, with
 * `compression()` mounted the same way the production script mounts it —
 * so a test hitting this server observes the real on-the-wire behavior a
 * browser would, not a compression-less stand-in.
 */
async function bootTapServer(root: string): Promise<{
  baseUrl: string;
  server: http.Server;
  service: ReplayPremiereProductionService;
}> {
  const fixture = await verifiedRealtimeLongPublicationFixture(root);
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
  });
  try {
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: fixture.chunkBuildLimits,
      collectorLimits: COLLECTOR_LIMITS,
    });
  } finally {
    await catalog.close();
  }

  const context = startupContext();
  const started = await startReplayPremiereProduction({
    ...context,
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
    wageringEnabled: true,
  });

  const app = express();
  app.use(compression());
  app.use(
    createReplayPremiereRouter({
      registry: context.httpRegistry,
      security: context.security,
      resolveClientAddress: () => "127.0.0.1",
    }),
  );
  const server = http.createServer(app);
  // `new Promise(executor)`, not `Promise.withResolvers` — this project
  // targets an ES2022 lib (see tsconfig.json).
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind an address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    service: started.service,
  };
}

/** Raw (non-`fetch`-decompressed) GET — measures actual on-the-wire bytes. */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ headers: http.IncomingHttpHeaders; bytes: number }> {
  // `new Promise(executor)`, not `Promise.withResolvers` — this project
  // targets an ES2022 lib (see tsconfig.json).
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      res.on("end", () => resolve({ headers: res.headers, bytes }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ReplayPremiereNetworkController content-source=tap", () => {
  let root: string;
  const services: ReplayPremiereProductionService[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-tap-client-"));
    vi.useFakeTimers({ now: NOW.getTime() });
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("polls live-projection incrementally and never receives a transmitted record ahead of the clock at request time — never falls back to chunk delivery", async () => {
    const fixture = await verifiedRealtimeLongPublicationFixture(root);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    try {
      await catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: fixture.chunkBuildLimits,
        collectorLimits: COLLECTOR_LIMITS,
      });
    } finally {
      await catalog.close();
    }

    const context = startupContext();
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      wageringEnabled: true,
    });
    services.push(started.service);

    const app = express();
    app.use(
      createReplayPremiereRouter({
        registry: context.httpRegistry,
        security: context.security,
        resolveClientAddress: () => "127.0.0.1",
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind an address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const requestedPaths: string[] = [];
      const transmitted: Array<{
        elapsedMsAtRequest: number;
        records: readonly { sequence: number; presentationOffsetMs: number }[];
      }> = [];
      // Wraps real `fetch`: resolves the client's same-origin-relative
      // paths against the test server, and — the load-bearing part of this
      // test — records exactly what came back over the wire for every
      // live-projection response, tagged with the wall-clock elapsed at
      // the moment THAT SPECIFIC request went out. This is the client's
      // real, unmodified `fetchImpl` seam; nothing about the network
      // layer is faked.
      const fetchImpl: typeof fetch = async (input, init) => {
        const relative = typeof input === "string" ? input : input.toString();
        const absolute = relative.startsWith("http")
          ? relative
          : `${baseUrl}${relative}`;
        requestedPaths.push(relative);
        const elapsedMsAtRequest = Date.now() - NOW.getTime();
        const response = await fetch(absolute, init);
        if (relative.includes("/live-projection")) {
          const body = (await response.clone().json()) as {
            records: readonly {
              sequence: number;
              presentationOffsetMs: number;
            }[];
          };
          transmitted.push({ elapsedMsAtRequest, records: body.records });
        }
        return response;
      };

      const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
      const callbacks: ReplayPremiereNetworkCallbacks = { onReady: () => {} };
      const network = new ReplayPremiereNetworkController({
        premiereId: PREMIERE_ID,
        playback,
        callbacks,
        fetchImpl,
        contentSource: "tap",
      });

      // Same sample points as the server-side wire test: several distinct
      // instants well inside the 50-minute match, each a fresh sync tick —
      // exactly how the betting page's runLoop drives this in production,
      // just invoked directly instead of waiting out real poll intervals.
      const elapsedSamplesMs = [0, 15_000, 45_000, 75_000, 150_000];
      for (const elapsedMs of elapsedSamplesMs) {
        vi.setSystemTime(NOW.getTime() + elapsedMs);
        await network.syncOnce();
      }

      // The content-source switch is real, not cosmetic: this client never
      // once asked for a storage chunk.
      expect(requestedPaths.some((p) => p.includes("/chunks/"))).toBe(false);
      expect(requestedPaths.some((p) => p.includes("/live-projection"))).toBe(
        true,
      );
      // Cursor-based incremental polling, never re-fetching from the top:
      // every live-projection request's `after=` strictly increases (or
      // repeats while caught up), never resets to -1 after the first call.
      const afterValues = requestedPaths
        .filter((p) => p.includes("/live-projection"))
        .map((p) => Number(new URL(p, baseUrl).searchParams.get("after")));
      for (let i = 1; i < afterValues.length; i += 1) {
        expect(afterValues[i]).toBeGreaterThanOrEqual(afterValues[i - 1]);
      }

      // The core acceptance assertion: what was ACTUALLY TRANSMITTED to
      // this client over the wire — captured straight off the response
      // body, not read back off rendered state — never exceeded the
      // authoritative clock at the instant of that specific request.
      let maxTransmittedOffsetMs = -1;
      let totalRecordsTransmitted = 0;
      for (const { elapsedMsAtRequest, records } of transmitted) {
        for (const record of records) {
          expect(record.presentationOffsetMs).toBeLessThanOrEqual(
            elapsedMsAtRequest,
          );
          maxTransmittedOffsetMs = Math.max(
            maxTransmittedOffsetMs,
            record.presentationOffsetMs,
          );
        }
        totalRecordsTransmitted += records.length;
      }
      expect(maxTransmittedOffsetMs).toBeLessThanOrEqual(150_000);
      // Real content actually moved — not an accidentally-empty tap.
      expect(totalRecordsTransmitted).toBeGreaterThan(1_000);

      // Playback itself is exactly as fresh as the clock allowed at the
      // final sample — never held back (this is what makes the betting
      // page's live rendering and trade gate track the same frontier) and
      // never further than what the last request's own elapsed time
      // permitted.
      const state = playback.state();
      expect(state.releasedThroughSequence).not.toBeNull();
      expect(state.releasedThroughSequence!).toBeGreaterThan(1_000);
      expect(state.releasedThroughSequence!).toBeLessThanOrEqual(
        Math.floor(150_000 / PREMIERE_REAL_TURN_INTERVAL_MS),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
    // Wall-clock test against a real server and real timers; the 5s default
    // cannot hold on a loaded machine. Assertions unchanged.
  }, 60_000);

  it("seeks a late join straight to the trailed frontier — never paces turn 0 forward against the live clock", async () => {
    // The regression this pins: a client joining well after match start
    // used to only request forward catch-up once steady-state drift
    // exceeded a 90s convenience threshold measured from a `dispatched`
    // baseline of zero — so a fresh join within that window instead paced
    // turn 0 forward in lockstep with the SAME real-time clock the live
    // match itself advances on, a gap that mathematically never closes
    // (every real second spent catching up is a real second the match
    // plays further ahead). This test joins directly at 150s in — a single
    // sync tick, no earlier samples — and proves the very first tick
    // requests a forward catch-up close to the live frontier rather than
    // leaving the viewer to free-run from sequence 0.
    const fixture = await verifiedRealtimeLongPublicationFixture(root);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    try {
      await catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: fixture.chunkBuildLimits,
        collectorLimits: COLLECTOR_LIMITS,
      });
    } finally {
      await catalog.close();
    }

    const context = startupContext();
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      wageringEnabled: true,
    });
    services.push(started.service);

    const app = express();
    app.use(
      createReplayPremiereRouter({
        registry: context.httpRegistry,
        security: context.security,
        resolveClientAddress: () => "127.0.0.1",
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind an address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const relative = typeof input === "string" ? input : input.toString();
        const absolute = relative.startsWith("http")
          ? relative
          : `${baseUrl}${relative}`;
        return fetch(absolute, init);
      };

      const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
      const catchUps: number[] = [];
      playback.subscribe((event) => {
        if (event.type === "catch-up") catchUps.push(event.targetSequence);
      });
      const callbacks: ReplayPremiereNetworkCallbacks = { onReady: () => {} };
      const network = new ReplayPremiereNetworkController({
        premiereId: PREMIERE_ID,
        playback,
        callbacks,
        fetchImpl,
        contentSource: "tap",
      });

      // A true late join: skip straight to 60s in — a gap the OLD
      // dispatched-baseline-zero threshold check (90s) would NOT have
      // treated as "behind enough" to catch up on, leaving the viewer to
      // free-run turn 0 forward in lockstep with the live clock forever.
      // One sync tick — no earlier samples ever establish a `dispatched`
      // baseline.
      vi.setSystemTime(NOW.getTime() + 60_000);
      await network.syncOnce();

      const state = playback.state();
      expect(state.releasedThroughSequence).not.toBeNull();
      const released = state.releasedThroughSequence!;
      expect(released).toBeGreaterThan(400);

      // The fix: a catch-up was requested on this very first tick despite
      // the 60s gap sitting under the old 90s convenience threshold — a
      // fresh join never defers to it.
      expect(catchUps.length).toBeGreaterThan(0);
      const target = catchUps[0];
      // Anti-read-ahead, proven at the seek itself: the target can only
      // ever move toward the present, never past what the network has
      // actually verified as released (itself already clock-bound — see
      // the sibling test in this file).
      expect(target).toBeLessThanOrEqual(released);
      // And it lands close to the live frontier — within one presentation
      // trail's worth of records — not near the start of the match.
      const oneTrailRecords = Math.ceil(
        45_000 / PREMIERE_REAL_TURN_INTERVAL_MS,
      );
      expect(released - target).toBeLessThanOrEqual(oneTrailRecords);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  }, 60_000);

  it("gzip-compresses a real catch-up response — the client's actual on-the-wire download shrinks, not just the in-memory JSON", async () => {
    // Regression coverage for the P0: a live QA trace on a real ~20 min-old
    // match found a single `after=-1` catch-up response alone reaching
    // ~4.7 MB and never completing within the client's per-request budget.
    // `ai-agent-demo-server.ts` now mounts `compression()` in front of the
    // exact same router this test boots — proves the wiring actually
    // shrinks the bytes a real browser would have to download, not just
    // that the route still returns 200.
    const { baseUrl, server, service } = await bootTapServer(root);
    services.push(service);
    try {
      // Five minutes in: several thousand records exist — comfortably past
      // one MAX_LIVE_PROJECTION_RECORDS-capped response, same order of
      // magnitude as the live QA trace's ~20 min mark.
      vi.setSystemTime(NOW.getTime() + 300_000);
      const url = `${baseUrl}/api/premieres/${PREMIERE_ID}/live-projection?after=-1`;
      const uncompressed = await rawGet(url, { "accept-encoding": "identity" });
      const compressed = await rawGet(url, { "accept-encoding": "gzip" });
      expect(uncompressed.headers["content-encoding"]).toBeUndefined();
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect(uncompressed.bytes).toBeGreaterThan(1_000);
      // Real Turn-JSON is repetitive (same keys, small numeric deltas) —
      // gzip should meaningfully shrink it, not merely avoid expanding it.
      expect(compressed.bytes).toBeLessThan(uncompressed.bytes * 0.5);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  }, 60_000);

  it("a failed catch-up poll resumes from its own cursor on retry — never re-requests from -1 — and the anti-read-ahead boundary still holds across the retry", async () => {
    // Regression coverage for the other half of the P0: the old 2 s
    // per-request ceiling aborted a real catch-up response before it could
    // land, and every retry re-requested the SAME oversized response —
    // structurally unable to ever converge. This proves the actual
    // mechanism a real retry depends on: a failed poll's PRIOR successful
    // polls already committed to playback (never unwound), so the very
    // next attempt resumes from that cursor instead of restarting cold.
    const { baseUrl, server, service } = await bootTapServer(root);
    services.push(service);
    try {
      vi.setSystemTime(NOW.getTime() + 300_000);
      let liveProjectionCalls = 0;
      const FAIL_ON_CALL = 3;
      const requestedAfterValues: number[] = [];
      const transmitted: Array<{
        elapsedMsAtRequest: number;
        records: readonly { sequence: number; presentationOffsetMs: number }[];
      }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const relative = typeof input === "string" ? input : input.toString();
        const absolute = relative.startsWith("http")
          ? relative
          : `${baseUrl}${relative}`;
        if (!relative.includes("/live-projection")) {
          return fetch(absolute, init);
        }
        liveProjectionCalls += 1;
        requestedAfterValues.push(
          Number(new URL(absolute).searchParams.get("after")),
        );
        if (liveProjectionCalls === FAIL_ON_CALL) {
          throw new Error("simulated transient network failure");
        }
        const elapsedMsAtRequest = Date.now() - NOW.getTime();
        const response = await fetch(absolute, init);
        const body = (await response.clone().json()) as {
          records: readonly {
            sequence: number;
            presentationOffsetMs: number;
          }[];
        };
        transmitted.push({ elapsedMsAtRequest, records: body.records });
        return response;
      };

      const playback = new ReplayPremierePlaybackController(PREMIERE_ID);
      const callbacks: ReplayPremiereNetworkCallbacks = { onReady: () => {} };
      const network = new ReplayPremiereNetworkController({
        premiereId: PREMIERE_ID,
        playback,
        callbacks,
        fetchImpl,
        contentSource: "tap",
      });

      // First tick: two polls succeed (MAX_LIVE_PROJECTION_RECORDS each),
      // the injected third fails — the whole sync tick must surface that
      // failure, never silently swallow it.
      await expect(network.syncOnce()).rejects.toMatchObject({
        code: "request_failed",
        recoverable: true,
      });
      expect(liveProjectionCalls).toBe(FAIL_ON_CALL);

      // The progress from the two successful polls before the failure
      // survives it — each poll commits straight to playback, so a later
      // failure cannot unwind already-accepted content.
      const cursorAfterFailure = playback.state().releasedThroughSequence;
      expect(cursorAfterFailure).not.toBeNull();
      expect(cursorAfterFailure).toBe(2 * MAX_LIVE_PROJECTION_RECORDS - 1);
      // The failed request itself already asked to resume, not restart —
      // it targeted the post-second-poll cursor, never -1.
      expect(requestedAfterValues.at(-1)).toBe(cursorAfterFailure);

      // Retry (what runLoop's own recoverable-error handling does in
      // production): the very next live-projection request must resume
      // from that exact cursor.
      const requestsBeforeRetry = requestedAfterValues.length;
      await network.syncOnce();
      expect(requestedAfterValues[requestsBeforeRetry]).toBe(cursorAfterFailure);

      // The boundary invariant survives the retry too: nothing actually
      // transmitted, on either tick, ever carried a presentation time
      // ahead of the authoritative clock at the moment of that request.
      for (const { elapsedMsAtRequest, records } of transmitted) {
        for (const record of records) {
          expect(record.presentationOffsetMs).toBeLessThanOrEqual(
            elapsedMsAtRequest,
          );
        }
      }
      expect(playback.state().releasedThroughSequence!).toBeGreaterThan(
        cursorAfterFailure!,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  }, 60_000);
});
