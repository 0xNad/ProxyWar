/**
 * Proves the live-visibility mechanism wagering binds orders to:
 * `ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence` /
 * `readLiveProjection` are computed fresh from the authoritative release
 * clock on every call, independent of the coarse chunk-release batching
 * (`REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS`, ~60s). The chunk store stays
 * exactly as before (see ReplayPremiereChunks/ReplayPremiereLongRuntime
 * tests, unmodified); this file only tests the new fine-grained read path.
 */
import express from "express";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayPremiereAdmissionCatalog } from "../../../../src/server/replay-premiere/ReplayPremiereCatalog";
import { freezeReplayPremiereCheckpointProjection } from "../../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { ReplayPremiereAnonymousWriteLimiter } from "../../../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereGuestSecurity } from "../../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  ReplayPremiereHttpRegistry,
} from "../../../../src/server/replay-premiere/ReplayPremiereHttp";
import { ReplayPremiereRuntimeRegistry } from "../../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import {
  startReplayPremiereProduction,
  type ReplayPremiereProductionService,
} from "../../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  NOW,
  PREMIERE_ID,
  verifiedRealtimeLongPublicationFixture,
} from "../ReplayPremiereFixtures";

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
      async project({ gate }: Parameters<
        Parameters<typeof startReplayPremiereProduction>[0]["checkpointProjector"]["project"]
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

describe("ReplayPremiereRuntimeCoordinator live visibility", () => {
  let root: string;
  const services: ReplayPremiereProductionService[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-live-vis-"));
    vi.useFakeTimers({ now: NOW.getTime() });
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never returns a record ahead of the authoritative clock, and stays live mid-chunk (before that chunk ever chunk-releases)", async () => {
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
    const runtime = context.runtimeRegistry.get(PREMIERE_ID)!;
    expect(runtime).not.toBeNull();

    // Immediately after start: elapsed ~= 0. Only the turn-0 record (the
    // one whose presentationOffsetMs is exactly 0) is due yet.
    expect(runtime.readLiveVisibleSequence()).toBe(0);
    expect(runtime.readLiveProjection(-1)).toEqual([
      expect.objectContaining({ sequence: 0, presentationOffsetMs: 0 }),
    ]);

    // Advance the WALL clock by 30s — well inside the first chunk's ~60s
    // span — WITHOUT re-running synchronize(). The scheduled supervisor
    // timer is a real setTimeout under fake timers, so it never fires from
    // vi.setSystemTime alone: chunk 0 genuinely never chunk-releases here.
    vi.setSystemTime(NOW.getTime() + 30_000);

    const liveSequence = runtime.readLiveVisibleSequence();
    // 30,000ms / 100ms-per-turn = turn 300 (sequence 300), give or take the
    // fixture's exact turn/sequence alignment — must be substantially into
    // the match, not stuck at -1 or artificially capped.
    expect(liveSequence).toBeGreaterThan(250);
    expect(liveSequence).toBeLessThan(310);

    const projection = runtime.readLiveProjection(-1);
    expect(projection.length).toBeGreaterThan(0);
    expect(projection.at(-1)!.sequence).toBe(liveSequence);
    // The core anti-read-ahead invariant: never a record whose presentation
    // time is later than the authoritative clock right now.
    for (const record of projection) {
      expect(record.presentationOffsetMs).toBeLessThanOrEqual(30_000);
    }
    // Sequences are contiguous and strictly increasing from the start.
    projection.forEach((record, index) => expect(record.sequence).toBe(index));

    // This all happened mid-chunk: the coarse chunk-release mechanism has
    // not fired at all — readReleasedContext confirms nothing is released
    // through the OLD, chunk-batch-based path at this same wall-clock
    // moment, proving the live path is a genuinely independent, finer read.
    expect(runtime.readReleasedContext(0)).toBeNull();

    // A second call to readLiveProjection with a later `afterSequence`
    // cursor returns only the delta — the incremental polling contract a
    // real client uses.
    const delta = runtime.readLiveProjection(liveSequence - 5);
    expect(delta).toHaveLength(5);
    expect(delta.map((record) => record.sequence)).toEqual([
      liveSequence - 4,
      liveSequence - 3,
      liveSequence - 2,
      liveSequence - 1,
      liveSequence,
    ]);

    // Advancing further (past the first chunk's ~60s span) only grows the
    // live-visible sequence monotonically — never regresses, never jumps
    // ahead of the new elapsed time either.
    vi.setSystemTime(NOW.getTime() + 90_000);
    const laterSequence = runtime.readLiveVisibleSequence();
    expect(laterSequence).toBeGreaterThan(liveSequence);
    for (const record of runtime.readLiveProjection(-1)) {
      expect(record.presentationOffsetMs).toBeLessThanOrEqual(90_000);
    }
  });

  it("GET /live-projection: total transmitted content never exceeds the authoritative clock at any polled instant", async () => {
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
      // Simulate a real polling client: total received content accumulates
      // across several requests spread over simulated time, each using the
      // previous response's own cursor — never re-fetching from the start.
      let cursor = -1;
      let maxTransmittedOffsetMs = -1;
      const elapsedSamplesMs = [0, 15_000, 45_000, 75_000, 150_000];
      for (const elapsedMs of elapsedSamplesMs) {
        vi.setSystemTime(NOW.getTime() + elapsedMs);
        const response = await fetch(
          `${baseUrl}/api/premieres/${PREMIERE_ID}/live-projection?after=${cursor}`,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          schemaVersion: 1;
          liveVisibleSequence: number;
          records: { sequence: number; presentationOffsetMs: number }[];
        };
        // The core assertion: what was ACTUALLY TRANSMITTED over the wire
        // in this response never exceeds the authoritative clock at the
        // instant of the request — not what a client renders, what it
        // received.
        for (const record of body.records) {
          expect(record.presentationOffsetMs).toBeLessThanOrEqual(elapsedMs);
          maxTransmittedOffsetMs = Math.max(
            maxTransmittedOffsetMs,
            record.presentationOffsetMs,
          );
        }
        expect(maxTransmittedOffsetMs).toBeLessThanOrEqual(elapsedMs);
        if (body.records.length > 0) {
          cursor = body.records.at(-1)!.sequence;
        }
        expect(cursor).toBe(body.liveVisibleSequence);
      }
      // Real content was actually delivered across the run, not an
      // accidentally-empty tap.
      expect(cursor).toBeGreaterThan(1_000);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });
});
