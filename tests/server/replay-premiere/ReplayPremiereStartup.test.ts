import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReplayPremiereAnonymousWriteLimiter } from "../../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereAdmissionCatalog } from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
import {
  freezeReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjector,
} from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { buildPremiereChunks } from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import {
  createReplayPremiereRouter,
  ReplayPremiereHttpRegistry,
  type ReplayPremiereHttpTarget,
} from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  importControlledPremiereSourceForPublication,
  VerifiedPremiereEligibilityGate,
} from "../../../src/server/replay-premiere/ReplayPremierePublication";
import { ReplayPremiereRuntimeRegistry } from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import {
  DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
  startReplayPremiereProduction,
  type ReplayPremiereProductionService,
} from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  NOW,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

const ORIGIN = "https://beta.proxywar.xyz";
const CHUNK_LIMITS = {
  maxChunkBytes: 100_000,
  maxTotalBytes: 1_000_000,
  maxRecordsPerChunk: 20,
  maxPresentationSpanMs: 1_000,
} as const;
const PLAYING_CHUNK_LIMITS = {
  ...CHUNK_LIMITS,
  maxRecordsPerChunk: 1,
} as const;
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

describe("ReplayPremiere production startup", () => {
  let root: string;
  const services: ReplayPremiereProductionService[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-startup-"));
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("keeps the sole bounded production recovery before demo-server listen", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "scripts", "ai-agent-demo-server.ts"),
      "utf8",
    );
    const callMarker = "startReplayPremiereProduction({";
    expect(source.match(/startReplayPremiereProduction\(\{/g)).toHaveLength(1);
    const callStart = source.indexOf(callMarker);
    const callEnd = source.indexOf("\n});", callStart);
    expect(callStart).toBeGreaterThanOrEqual(0);
    expect(callEnd).toBeGreaterThan(callStart);
    expect(source.slice(callStart, callEnd)).toContain("maxStartupMs: 8_000,");
    const listenStart = source.indexOf("const server = app.listen(");
    expect(callStart).toBeLessThan(listenStart);
    expect(source).not.toContain("startDeferredHydration");
  });

  test("reconstructs, synchronizes, and registers a clean admission", async () => {
    await writeAdmission(root);
    const context = startupContext();

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.diagnostics).toEqual([]);
    expect(started.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(context.httpRegistry.get(PREMIERE_ID)).not.toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).not.toBeNull();

    await Promise.all([started.service.close(), started.service.close()]);
    services.splice(services.indexOf(started.service), 1);
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
  });

  test.each(["maxEventBytes", "maxSnapshotBytes"] as const)(
    "quarantines an admission when %s cannot hold its reveal envelope",
    async (limitedField) => {
      const caseRoot = path.join(root, limitedField);
      await writeAdmission(caseRoot);
      const context = startupContext();
      const started = await startReplayPremiereProduction({
        ...context,
        privateStateRoot: path.join(caseRoot, "private"),
        servedRoots: [path.join(caseRoot, "served")],
        eventStoreLimits: {
          ...DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
          [limitedField]: 1,
        },
      });
      services.push(started.service);

      expect(started.registeredPremiereIds).toEqual([]);
      expect(started.diagnostics).toEqual([
        {
          target: `${PREMIERE_ID}.admission.json`,
          premiereId: PREMIERE_ID,
          operatorCode: "startup_reveal_capacity_incompatible",
        },
      ]);
    },
  );

  test("releases the catalog writer after bootstrap while the registered runtime remains live", async () => {
    await writeAdmission(root);
    const context = startupContext();
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    const operatorCatalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    expect((await operatorCatalog.readAll()).entries).toHaveLength(1);
    expect(context.httpRegistry.get(PREMIERE_ID)).not.toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).not.toBeNull();
    await operatorCatalog.close();

    await started.service.close();
    services.splice(services.indexOf(started.service), 1);
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
  });

  test("never exposes control-bearing catalog filenames to operator diagnostics", async () => {
    await writeAdmission(root);
    const maliciousName = `${"x".repeat(170)}\nforged\u0001.admission.json`;
    await fs.writeFile(
      path.join(root, "private", "catalog-v1", "entries", maliciousName),
      "{",
      { mode: 0o400 },
    );
    const context = startupContext();
    const operatorLines: string[] = [];

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      onDiagnostic: (diagnostic) => {
        operatorLines.push(
          `Replay Premiere recovery rejected ${diagnostic.target}: ${diagnostic.operatorCode}`,
        );
      },
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(started.diagnostics).toHaveLength(1);
    expect(started.diagnostics[0].premiereId).toBeNull();
    expect(started.diagnostics[0].target).toMatch(
      /^catalog_entry_[a-f0-9]{64}$/,
    );
    expect(started.diagnostics[0].target).not.toContain("\n");
    expect(operatorLines).toHaveLength(1);
    expect(operatorLines[0].split("\n")).toHaveLength(1);
  });

  test("keeps unknown IDs public-404 after registry population", async () => {
    await writeAdmission(root);
    const context = startupContext();
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    await withHttpApp(
      createReplayPremiereRouter({
        registry: context.httpRegistry,
        security: context.security,
        resolveClientAddress: () => "127.0.0.1",
      }),
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/premieres/prem_fedcba9876543210/bootstrap`,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_UNAVAILABLE" },
        });
      },
    );
  });

  test.each(["failed", "cancelled"] as const)(
    "routes a real archived %s runtime as its sanitized terminal presentation and rejects writes",
    async (terminalPresentationState) => {
      await writeAdmission(root);
      let nowMs = NOW.getTime() - 120_000;
      const context = startupContext(() => new Date(nowMs));
      const started = await startReplayPremiereProduction({
        ...context,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
      });
      services.push(started.service);
      const runtime = context.runtimeRegistry.get(PREMIERE_ID)!;
      expect(runtime.readLifecycleState()).toBe("scheduled");

      if (terminalPresentationState === "cancelled") {
        await runtime.cancel();
      } else {
        nowMs = NOW.getTime();
        await runtime.synchronize();
        expect(runtime.readLifecycleState()).toBe("playing");
        await runtime.beginOutage();
        nowMs += 60_001;
        await runtime.synchronize();
      }
      expect(runtime.readLifecycleState()).toBe(terminalPresentationState);
      await runtime.archive();
      expect(runtime.readLifecycleState()).toBe("archived");

      await withHttpApp(
        createReplayPremiereRouter({
          registry: context.httpRegistry,
          security: context.security,
          resolveClientAddress: () => "127.0.0.1",
        }),
        async (baseUrl) => {
          const manifest = await fetch(
            `${baseUrl}/api/premieres/${PREMIERE_ID}/manifest`,
          );
          expect(manifest.status).toBe(200);
          expect(await manifest.json()).toMatchObject({
            state: terminalPresentationState,
          });

          const reveal = await fetch(
            `${baseUrl}/api/premieres/${PREMIERE_ID}/reveal`,
          );
          expect(reveal.status).toBe(404);
          expect(await reveal.json()).toEqual({
            error: { code: "PREMIERE_UNAVAILABLE" },
          });

          for (const suffix of ["predictions", "reactions"]) {
            const response = await fetch(
              `${baseUrl}/api/premieres/${PREMIERE_ID}/${suffix}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              },
            );
            expect(response.status).toBe(410);
            expect(await response.json()).toEqual({
              error: { code: "PREMIERE_INVALID_REQUEST" },
            });
          }
        },
      );
    },
  );

  test("quarantines one self-consistent commitment mismatch without registration", async () => {
    await writeAdmission(root);
    const entryPath = path.join(
      root,
      "private",
      "catalog-v1",
      "entries",
      `${PREMIERE_ID}.admission.json`,
    );
    const record = JSON.parse(await fs.readFile(entryPath, "utf8")) as Record<
      string,
      unknown
    >;
    const { recordHash: _recordHash, ...preimage } = record;
    preimage.expectedPublicationCommitmentHash = "f".repeat(64);
    const modified = {
      ...preimage,
      recordHash: hashReplayPremiereJson(
        preimage as unknown as ReplayPremiereJsonValue,
      ),
    };
    await fs.chmod(entryPath, 0o600);
    await fs.writeFile(
      entryPath,
      `${canonicalReplayPremiereJson(modified as ReplayPremiereJsonValue)}\n`,
    );
    await fs.chmod(entryPath, 0o400);
    const context = startupContext();

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        premiereId: PREMIERE_ID,
        operatorCode: "startup_publication_commitment_mismatch",
      },
    ]);
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
  });

  test("quarantines an internally valid admission audited against a decoy origin", async () => {
    await writeAdmission(root, "https://decoy.invalid");
    const context = startupContext();

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        premiereId: PREMIERE_ID,
        operatorCode: "startup_leak_audit_origin_mismatch",
      },
    ]);
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(started.service.readActiveTimerCount()).toBe(0);
  });

  test("cleanly recovers when the runtime journal is the latest durable state", async () => {
    await writeAdmission(root);
    const firstContext = startupContext();
    const first = await startReplayPremiereProduction({
      ...firstContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(first.service);
    await first.service.close();
    services.splice(services.indexOf(first.service), 1);

    const secondContext = startupContext();
    const second = await startReplayPremiereProduction({
      ...secondContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(second.service);

    expect(second.diagnostics).toEqual([]);
    expect(second.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(secondContext.httpRegistry.get(PREMIERE_ID)).not.toBeNull();
  });

  test.each([
    ["initialized", "premiere_runtime_initialized", "scheduled"],
    ["started", "premiere_runtime_started", "playing"],
    ["chunk-playing", "premiere_runtime_chunk_released", "playing"],
    ["chunk-checkpoint", "premiere_runtime_chunk_released", "checkpoint"],
    ["checkpoint-resumed", "premiere_runtime_checkpoint_resumed", "playing"],
    ["outage-started", "premiere_runtime_outage_started", "playing"],
    ["outage-recovered", "premiere_runtime_outage_recovered", "playing"],
    ["failed", "premiere_runtime_failed", "failed"],
    ["cancelled", "premiere_runtime_cancelled", "cancelled"],
    ["terminal-archived", "premiere_runtime_terminal_archived", "archived"],
    ["revealed", "premiere_reveal_committed", "revealed"],
    ["revealed-archived", "premiere_runtime_archived", "archived"],
  ] as const)(
    "accepts the canonical %s latest-event envelope on restart",
    async (scenario, expectedEventType, expectedState) => {
      if (scenario === "chunk-playing") {
        await writeAdmissionWithChunkLimits(root, PLAYING_CHUNK_LIMITS);
      } else {
        await writeAdmission(root);
      }
      const beforeSchedule = NOW.getTime() - 120_000;
      const startsBeforeSchedule =
        scenario === "initialized" ||
        scenario === "cancelled" ||
        scenario === "terminal-archived";
      vi.useFakeTimers({
        now: startsBeforeSchedule ? beforeSchedule : NOW.getTime(),
      });
      const firstContext = startupContext(() => new Date());
      const first = await startReplayPremiereProduction({
        ...firstContext,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
      });
      services.push(first.service);
      const runtime = firstContext.runtimeRegistry.get(PREMIERE_ID)!;

      if (scenario === "chunk-checkpoint") {
        vi.setSystemTime(NOW.getTime() + 100);
        await runtime.synchronize();
      } else if (scenario === "checkpoint-resumed") {
        vi.setSystemTime(NOW.getTime() + 100);
        await runtime.synchronize();
        vi.setSystemTime(NOW.getTime() + 15_100);
        await runtime.synchronize();
      } else if (scenario === "outage-started") {
        await runtime.beginOutage();
      } else if (scenario === "outage-recovered") {
        await runtime.beginOutage();
        vi.setSystemTime(NOW.getTime() + 1);
        await runtime.endOutage();
      } else if (scenario === "failed") {
        await runtime.beginOutage();
        vi.setSystemTime(NOW.getTime() + 60_001);
        await runtime.synchronize();
      } else if (scenario === "cancelled") {
        await runtime.cancel();
      } else if (scenario === "terminal-archived") {
        await runtime.cancel();
        await runtime.archive();
      } else if (scenario === "revealed" || scenario === "revealed-archived") {
        await driveRuntimeToReveal(runtime);
        if (scenario === "revealed-archived") await runtime.archive();
      }
      expect(runtime.readLifecycleState()).toBe(expectedState);
      await first.service.close();
      services.splice(services.indexOf(first.service), 1);

      const store = await ReplayPremiereEventStore.open({
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
      });
      const latest = store.recovered.events
        .filter((event) => event.aggregateId === PREMIERE_ID)
        .at(-1);
      expect(latest?.eventType).toBe(expectedEventType);
      expect(
        (latest?.payload as { lifecycle?: { state?: unknown } }).lifecycle
          ?.state,
      ).toBe(expectedState);
      await store.close();

      const recoveredContext = startupContext(() => new Date());
      const recovered = await startReplayPremiereProduction({
        ...recoveredContext,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
      });
      services.push(recovered.service);
      expect(recovered.diagnostics).toEqual([]);
      expect(recovered.registeredPremiereIds).toEqual([PREMIERE_ID]);
      expect(recoveredContext.httpRegistry.get(PREMIERE_ID)).not.toBeNull();
    },
  );

  test("recovers the nearest scheduled target without probing retained terminal history", async () => {
    const terminalPremiereId = "prem_fedcba9876543210";
    await writeAlternateAdmission(root, terminalPremiereId);
    const beforeSchedule = NOW.getTime() - 120_000;
    const firstContext = startupContext(() => new Date(beforeSchedule));
    const first = await startReplayPremiereProduction({
      ...firstContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(first.service);
    const terminal = firstContext.runtimeRegistry.get(terminalPremiereId)!;
    await terminal.cancel();
    await terminal.archive();
    await first.service.close();
    services.splice(services.indexOf(first.service), 1);

    await writeAdmission(root);
    const attempts: string[] = [];
    const context = startupContext(() => new Date(beforeSchedule));
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      beforeTargetRecovery: async ({ record }) => {
        attempts.push(record.premiereId);
      },
    });
    services.push(started.service);

    expect(attempts).toEqual([PREMIERE_ID]);
    expect(started.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(context.runtimeRegistry.get(PREMIERE_ID)).not.toBeNull();
    expect(context.runtimeRegistry.get(terminalPremiereId)).toBeNull();
    expect(context.httpRegistry.get(terminalPremiereId)).toBeNull();
    expect(started.diagnostics).toEqual([]);
  });

  test("recovers exactly the newest terminal when every admitted target is terminal", async () => {
    vi.useFakeTimers({ now: NOW.getTime() - 120_000 });
    const olderPremiereId = "prem_fedcba9876543210";
    await writeAlternateAdmission(root, olderPremiereId);
    const olderContext = startupContext(() => new Date());
    const older = await startReplayPremiereProduction({
      ...olderContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(older.service);
    const olderRuntime = olderContext.runtimeRegistry.get(olderPremiereId)!;
    await olderRuntime.cancel();
    await olderRuntime.archive();
    await older.service.close();
    services.splice(services.indexOf(older.service), 1);

    await writeAdmission(root);
    vi.setSystemTime(NOW.getTime());
    const latestContext = startupContext(() => new Date());
    const latest = await startReplayPremiereProduction({
      ...latestContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(latest.service);
    const latestRuntime = latestContext.runtimeRegistry.get(PREMIERE_ID)!;
    expect(latestRuntime.readLifecycleState()).toBe("playing");
    await driveRuntimeToReveal(latestRuntime);
    await latestRuntime.archive();
    await latest.service.close();
    services.splice(services.indexOf(latest.service), 1);

    const attempts: string[] = [];
    const restartedContext = startupContext(() => new Date());
    const restarted = await startReplayPremiereProduction({
      ...restartedContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      beforeTargetRecovery: async ({ record }) => {
        attempts.push(record.premiereId);
      },
    });
    services.push(restarted.service);

    expect(attempts).toEqual([PREMIERE_ID]);
    expect(restarted.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(
      restartedContext.runtimeRegistry.get(PREMIERE_ID)?.readLifecycleState(),
    ).toBe("archived");
    expect(restartedContext.httpRegistry.get(PREMIERE_ID)).not.toBeNull();
    expect(restartedContext.runtimeRegistry.get(olderPremiereId)).toBeNull();
    expect(restartedContext.httpRegistry.get(olderPremiereId)).toBeNull();
  });

  test("does not probe a second scheduled target before listen", async () => {
    const premiereIds = await writeTwoAdmissions(root);
    const beforeSchedule = NOW.getTime() - 120_000;
    const context = startupContext(() => new Date(beforeSchedule));
    const attempts: string[] = [];
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      beforeTargetRecovery: async ({ record }) => {
        attempts.push(record.premiereId);
      },
    });
    services.push(started.service);

    expect(attempts).toEqual([premiereIds.primary]);
    expect(started.registeredPremiereIds).toEqual([premiereIds.primary]);
    expect(context.runtimeRegistry.get(premiereIds.primary)).not.toBeNull();
    expect(context.runtimeRegistry.get(premiereIds.alternate)).toBeNull();
    expect(context.httpRegistry.get(premiereIds.alternate)).toBeNull();
  });

  test("recovers every active target and globally fences the remainder after an active timeout", async () => {
    const alternatePremiereId = "prem_fedcba9876543210";
    await writeAdmission(root);
    const primaryContext = startupContext(() => new Date(NOW));
    const primary = await startReplayPremiereProduction({
      ...primaryContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(primary.service);
    expect(
      primaryContext.runtimeRegistry.get(PREMIERE_ID)?.readLifecycleState(),
    ).toMatch(/^(playing|checkpoint)$/);
    await primary.service.close();
    services.splice(services.indexOf(primary.service), 1);

    const primaryAdmissionPath = admissionPath(root, PREMIERE_ID);
    const heldPrimaryAdmissionPath = path.join(
      root,
      "held-primary-admission.json",
    );
    await fs.rename(primaryAdmissionPath, heldPrimaryAdmissionPath);
    try {
      await writeAlternateAdmission(root, alternatePremiereId);
      const alternateContext = startupContext(() => new Date(NOW));
      const alternate = await startReplayPremiereProduction({
        ...alternateContext,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
      });
      services.push(alternate.service);
      expect(
        alternateContext.runtimeRegistry
          .get(alternatePremiereId)
          ?.readLifecycleState(),
      ).toMatch(/^(playing|checkpoint)$/);
      await alternate.service.close();
      services.splice(services.indexOf(alternate.service), 1);
    } finally {
      await fs.rename(heldPrimaryAdmissionPath, primaryAdmissionPath);
    }

    const allActiveContext = startupContext(() => new Date(NOW));
    const allActiveAttempts: string[] = [];
    const allActive = await startReplayPremiereProduction({
      ...allActiveContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      beforeTargetRecovery: async ({ record }) => {
        allActiveAttempts.push(record.premiereId);
      },
    });
    services.push(allActive.service);
    expect(new Set(allActiveAttempts)).toEqual(
      new Set([PREMIERE_ID, alternatePremiereId]),
    );
    expect(new Set(allActive.registeredPremiereIds)).toEqual(
      new Set([PREMIERE_ID, alternatePremiereId]),
    );
    for (const premiereId of [PREMIERE_ID, alternatePremiereId]) {
      expect(
        allActiveContext.runtimeRegistry.get(premiereId)?.readLifecycleState(),
      ).toMatch(/^(playing|checkpoint)$/);
    }
    await allActive.service.close();
    services.splice(services.indexOf(allActive.service), 1);

    vi.useFakeTimers({ now: NOW });
    const timeoutContext = startupContext(() => new Date());
    const timeoutAttempts: string[] = [];
    let releaseBlockedActive: (() => void) | undefined;
    let markBlockedActiveEntered: (() => void) | undefined;
    const blockedActive = new Promise<void>((resolve) => {
      releaseBlockedActive = resolve;
    });
    const blockedActiveEntered = new Promise<void>((resolve) => {
      markBlockedActiveEntered = resolve;
    });
    const starting = startReplayPremiereProduction({
      ...timeoutContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      maxStartupMs: 100,
      beforeTargetRecovery: async ({ record }) => {
        timeoutAttempts.push(record.premiereId);
        markBlockedActiveEntered?.();
        await blockedActive;
      },
    });
    await blockedActiveEntered;
    expect(timeoutAttempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    const timedOut = await starting;
    services.push(timedOut.service);
    const blockedPremiereId = timeoutAttempts[0];
    const remainingPremiereId = [PREMIERE_ID, alternatePremiereId].find(
      (premiereId) => premiereId !== blockedPremiereId,
    )!;

    expect(timedOut.registeredPremiereIds).toEqual([]);
    expect(timedOut.diagnostics).toEqual([
      {
        target: `${blockedPremiereId}.admission.json`,
        premiereId: blockedPremiereId,
        operatorCode: "startup_deadline_exceeded",
      },
      {
        target: `${remainingPremiereId}.admission.json`,
        premiereId: remainingPremiereId,
        operatorCode: "startup_deadline_exceeded",
      },
    ]);
    expect(timeoutContext.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(timeoutContext.runtimeRegistry.get(alternatePremiereId)).toBeNull();
    const eventsPath = path.join(
      root,
      "private",
      "event-store-v1",
      "events.jsonl",
    );
    const bytesAtReturn = (await fs.stat(eventsPath)).size;
    releaseBlockedActive?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timeoutAttempts).toHaveLength(1);
    expect(timeoutContext.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(timeoutContext.runtimeRegistry.get(alternatePremiereId)).toBeNull();
    expect((await fs.stat(eventsPath)).size).toBe(bytesAtReturn);
    expect(timedOut.service.readActiveTimerCount()).toBe(0);
  });

  test("quarantines an invalid lifecycle projection without starving a valid target", async () => {
    const premiereIds = await writeTwoAdmissions(root);
    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
    });
    await store.append({
      aggregateId: premiereIds.alternate,
      eventType: "premiere_runtime_initialized",
      occurredAt: NOW.toISOString(),
      payload: { forged: true },
    });
    await store.close();
    const context = startupContext();

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([premiereIds.primary]);
    expect(started.diagnostics).toEqual([
      {
        target: `${premiereIds.alternate}.admission.json`,
        premiereId: premiereIds.alternate,
        operatorCode: "startup_runtime_projection_missing_lifecycle",
      },
    ]);
    expect(context.runtimeRegistry.get(premiereIds.primary)).not.toBeNull();
    expect(context.runtimeRegistry.get(premiereIds.alternate)).toBeNull();
  });

  test("quarantines a commitment-mismatched active envelope before priority recovery", async () => {
    const premiereIds = {
      primary: PREMIERE_ID,
      alternate: "prem_fedcba9876543210",
    };
    await writeAlternateAdmission(root, premiereIds.alternate);
    const beforeSchedule = NOW.getTime() - 120_000;
    const firstContext = startupContext(() => new Date(beforeSchedule));
    const first = await startReplayPremiereProduction({
      ...firstContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(first.service);
    await first.service.close();
    services.splice(services.indexOf(first.service), 1);
    await writeAdmission(root);

    const store = await ReplayPremiereEventStore.open({
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
    });
    const initialized = store.recovered.events.find(
      (event) =>
        event.aggregateId === premiereIds.alternate &&
        event.eventType === "premiere_runtime_initialized",
    );
    expect(initialized).toBeDefined();
    const forged = structuredClone(initialized!.payload) as Record<
      string,
      unknown
    >;
    const forgedLifecycle = forged.lifecycle as Record<string, unknown>;
    const wrongCommitment = "f".repeat(64);
    forged.publicationCommitmentHash = wrongCommitment;
    forged.actualStartAt = NOW.toISOString();
    forged.lastObservedAt = NOW.toISOString();
    forgedLifecycle.state = "playing";
    forgedLifecycle.publicationCommitmentHash = wrongCommitment;
    forgedLifecycle.version = Number(forgedLifecycle.version) + 1;
    forgedLifecycle.updatedAt = NOW.toISOString();
    const forgedJson = forged as unknown as ReplayPremiereJsonValue;
    await store.appendAndSnapshot({
      event: {
        aggregateId: premiereIds.alternate,
        eventType: "premiere_runtime_started",
        occurredAt: NOW.toISOString(),
        payload: forgedJson,
      },
      state: forgedJson,
      idempotencyKey: `runtime:start:${wrongCommitment}`,
    });
    await store.close();

    const context = startupContext(() => new Date(beforeSchedule));
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([premiereIds.primary]);
    expect(started.diagnostics).toEqual([
      {
        target: `${premiereIds.alternate}.admission.json`,
        premiereId: premiereIds.alternate,
        operatorCode: "startup_runtime_projection_envelope_invalid",
      },
    ]);
    expect(context.httpRegistry.get(premiereIds.primary)).not.toBeNull();
    expect(context.httpRegistry.get(premiereIds.alternate)).toBeNull();
    expect(context.runtimeRegistry.get(premiereIds.alternate)).toBeNull();
  });

  test.each([
    ["unknown type", "premiere_runtime_future", "runtime:future:"],
    ["type/state mismatch", "premiere_runtime_started", "runtime:start:"],
  ] as const)(
    "quarantines a hash-consistent %s projection envelope",
    async (_scenario, eventType, idempotencyPrefix) => {
      await writeAdmission(root);
      const beforeSchedule = NOW.getTime() - 120_000;
      const firstContext = startupContext(() => new Date(beforeSchedule));
      const first = await startReplayPremiereProduction({
        ...firstContext,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
      });
      services.push(first.service);
      await first.service.close();
      services.splice(services.indexOf(first.service), 1);

      const store = await ReplayPremiereEventStore.open({
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
      });
      const initialized = store.recovered.events.at(-1)!;
      const forged = structuredClone(initialized.payload) as Record<
        string,
        unknown
      >;
      const lifecycle = forged.lifecycle as Record<string, unknown>;
      forged.lastObservedAt = NOW.toISOString();
      lifecycle.updatedAt = NOW.toISOString();
      const commitment = String(forged.publicationCommitmentHash);
      const forgedJson = forged as unknown as ReplayPremiereJsonValue;
      await store.appendAndSnapshot({
        event: {
          aggregateId: PREMIERE_ID,
          eventType,
          occurredAt: NOW.toISOString(),
          payload: forgedJson,
        },
        state: forgedJson,
        idempotencyKey: `${idempotencyPrefix}${commitment}`,
      });
      await store.close();

      const context = startupContext(() => new Date(beforeSchedule));
      const started = await startReplayPremiereProduction({
        ...context,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
      });
      services.push(started.service);
      expect(started.registeredPremiereIds).toEqual([]);
      expect(started.diagnostics).toEqual([
        {
          target: `${PREMIERE_ID}.admission.json`,
          premiereId: PREMIERE_ID,
          operatorCode: "startup_runtime_projection_envelope_invalid",
        },
      ]);
      expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
      expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    },
  );

  test("aborts a delayed recovery at the deadline without late registration or timers", async () => {
    await writeAdmission(root);
    const context = startupContext();
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      maxStartupMs: 100,
      beforeTargetRecovery: async () => barrier,
    });

    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        premiereId: PREMIERE_ID,
        operatorCode: "startup_deadline_exceeded",
      },
    ]);
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(started.service.readActiveTimerCount()).toBe(0);

    releaseBarrier?.();
    await started.service.close();
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(started.service.readActiveTimerCount()).toBe(0);
    expect(
      await fs.readFile(
        path.join(root, "private", "event-store-v1", "events.jsonl"),
        "utf8",
      ),
    ).toBe("");
    await expect(
      fs.stat(path.join(root, "private", "catalog-v1", "write-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(root, "private", "event-store-v1", "write-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const restartedContext = startupContext();
    const restarted = await startReplayPremiereProduction({
      ...restartedContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(restarted.service);
    expect(restarted.registeredPremiereIds).toEqual([PREMIERE_ID]);
  });

  test("waits for an in-flight journal commit before reporting a startup timeout", async () => {
    await writeAdmission(root);
    vi.useFakeTimers({ now: NOW });
    const context = startupContext(() => new Date());
    const originalAppendAndSnapshot =
      ReplayPremiereEventStore.prototype.appendAndSnapshot;
    let firstAppend = true;
    let resolveAppendEntered: (() => void) | undefined;
    let releaseAppend: (() => void) | undefined;
    const appendEntered = new Promise<void>((resolve) => {
      resolveAppendEntered = resolve;
    });
    const appendBarrier = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.spyOn(
      ReplayPremiereEventStore.prototype,
      "appendAndSnapshot",
    ).mockImplementation(async function (
      this: ReplayPremiereEventStore,
      options,
    ) {
      if (firstAppend) {
        firstAppend = false;
        resolveAppendEntered?.();
        await appendBarrier;
      }
      return originalAppendAndSnapshot.call(this, options);
    });

    let settled = false;
    const startup = startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      maxStartupMs: 100,
    }).finally(() => {
      settled = true;
    });
    await appendEntered;
    await vi.advanceTimersByTimeAsync(100);
    const settledWhileAppendWasBlocked = settled;
    releaseAppend?.();
    const started = await startup;
    services.push(started.service);

    expect(settledWhileAppendWasBlocked).toBe(false);
    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        premiereId: PREMIERE_ID,
        operatorCode: "startup_deadline_exceeded",
      },
    ]);
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(started.service.readActiveTimerCount()).toBe(0);

    const eventsPath = path.join(
      root,
      "private",
      "event-store-v1",
      "events.jsonl",
    );
    const bytesAtReturn = (await fs.stat(eventsPath)).size;
    expect(bytesAtReturn).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await fs.stat(eventsPath)).size).toBe(bytesAtReturn);
  });

  test("rolls runtime registration back when HTTP registration rejects", async () => {
    await writeAdmission(root);
    const context = startupContext();
    const rejectingRegistry = new RejectingReplayPremiereHttpRegistry(
      context.httpRegistry.admitAnonymousWrite,
    );

    const started = await startReplayPremiereProduction({
      ...context,
      httpRegistry: rejectingRegistry,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        premiereId: PREMIERE_ID,
        operatorCode: "test_http_registration_rejected",
      },
    ]);
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
    expect(rejectingRegistry.get(PREMIERE_ID)).toBeNull();
    expect(started.service.readActiveTimerCount()).toBe(0);
  });

  test("fails a bad nearest target closed without probing another scheduled target", async () => {
    const premiereIds = await writeTwoAdmissions(root);
    const badPath = admissionPath(root, premiereIds.primary);
    const badRecord = JSON.parse(await fs.readFile(badPath, "utf8")) as Record<
      string,
      unknown
    >;
    const { recordHash: _recordHash, ...preimage } = badRecord;
    preimage.expectedPublicationCommitmentHash = "e".repeat(64);
    await writeAdmissionObject(badPath, preimage);
    const context = startupContext();

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics).toEqual([
      {
        target: `${premiereIds.primary}.admission.json`,
        premiereId: premiereIds.primary,
        operatorCode: "startup_publication_commitment_mismatch",
      },
    ]);
    expect(context.httpRegistry.get(premiereIds.primary)).toBeNull();
    expect(context.runtimeRegistry.get(premiereIds.primary)).toBeNull();
    expect(context.httpRegistry.get(premiereIds.alternate)).toBeNull();
    expect(context.runtimeRegistry.get(premiereIds.alternate)).toBeNull();
  });

  test("rejects self-consistent authoritative-result and stored-receipt drift", async () => {
    await writeAdmission(root);
    const resultPath = admissionPath(root, PREMIERE_ID);
    const resultRecord = JSON.parse(
      await fs.readFile(resultPath, "utf8"),
    ) as Record<string, unknown>;
    const resultPreimage = withoutRecordHash(resultRecord);
    const changedResult = Buffer.from("{}", "utf8");
    resultPreimage.authoritativeResult = {
      ...(resultPreimage.authoritativeResult as Record<string, unknown>),
      bytes: changedResult.toString("base64"),
      sha256: sha256Hex(changedResult),
    };
    await writeAdmissionObject(resultPath, resultPreimage);
    const resultContext = startupContext();
    const rejectedResult = await startReplayPremiereProduction({
      ...resultContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(rejectedResult.service);
    expect(rejectedResult.registeredPremiereIds).toEqual([]);
    expect(rejectedResult.diagnostics[0].operatorCode).not.toBe(
      "startup_target_recovery_failed",
    );
    await rejectedResult.service.close();
    services.splice(services.indexOf(rejectedResult.service), 1);

    await fs.rm(path.join(root, "private", "catalog-v1"), {
      recursive: true,
      force: true,
    });
    await writeAdmission(root);
    const receiptPath = admissionPath(root, PREMIERE_ID);
    const receiptRecord = JSON.parse(
      await fs.readFile(receiptPath, "utf8"),
    ) as Record<string, unknown>;
    const receiptPreimage = withoutRecordHash(receiptRecord);
    receiptPreimage.leakAuditReceipt = {
      ...(receiptPreimage.leakAuditReceipt as Record<string, unknown>),
      checkedAt: "2026-07-20T18:00:00.001Z",
    };
    await writeAdmissionObject(receiptPath, receiptPreimage);
    const receiptContext = startupContext();
    const rejectedReceipt = await startReplayPremiereProduction({
      ...receiptContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(rejectedReceipt.service);
    expect(rejectedReceipt.registeredPremiereIds).toEqual([]);
    expect(rejectedReceipt.diagnostics[0].operatorCode).toBe(
      "premiere_leak_stored_leak_audit_receipt_binding_mismatch",
    );
  });

  test("rejects staged source drift before either registration", async () => {
    await writeAdmission(root);
    const record = JSON.parse(
      await fs.readFile(admissionPath(root, PREMIERE_ID), "utf8"),
    ) as Record<string, unknown>;
    const stagedSource = record.stagedSource as Record<string, unknown>;
    const sourcePath = path.join(
      root,
      "private",
      ...String(stagedSource.relativePath).split("/"),
    );
    await fs.chmod(sourcePath, 0o600);
    await fs.appendFile(sourcePath, " ");
    await fs.chmod(sourcePath, 0o400);
    const context = startupContext();

    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);

    expect(started.registeredPremiereIds).toEqual([]);
    expect(started.diagnostics[0].operatorCode).not.toBe(
      "startup_target_recovery_failed",
    );
    expect(context.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(context.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
  });

  test("recovers when an interaction transition is the global journal tip", async () => {
    await writeAdmission(root);
    const firstContext = startupContext();
    const first = await startReplayPremiereProduction({
      ...firstContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    const target = firstContext.httpRegistry.get(PREMIERE_ID);
    expect(target).not.toBeNull();
    await target!.interactions.createViewerSession({
      participantId: `guest_${"a".repeat(32)}`,
      requesterBucketId: `ip_${"b".repeat(32)}`,
      idempotencyKey: "session:interaction-latest",
      visible: true,
      observedSequence: -1,
      excludedAsOperator: false,
      excludedAsBot: false,
      incomingAttribution: null,
    });
    await first.service.close();

    const secondContext = startupContext();
    const second = await startReplayPremiereProduction({
      ...secondContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(second.service);

    expect(second.diagnostics).toEqual([]);
    expect(second.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(
      secondContext.httpRegistry.get(PREMIERE_ID)!.interactions.readState()
        .sessions,
    ).toHaveLength(1);
  });

  test("rejects a forged interaction snapshot anchor before either registration", async () => {
    await writeAdmission(root);
    const firstContext = startupContext();
    const first = await startReplayPremiereProduction({
      ...firstContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    await firstContext.httpRegistry
      .get(PREMIERE_ID)!
      .interactions.createViewerSession({
        participantId: `guest_${"c".repeat(32)}`,
        requesterBucketId: `ip_${"d".repeat(32)}`,
        idempotencyKey: "session:forged-anchor",
        visible: true,
        observedSequence: -1,
        excludedAsOperator: false,
        excludedAsBot: false,
        incomingAttribution: null,
      });
    await first.service.close();
    const snapshotPath = path.join(
      root,
      "private",
      "event-store-v1",
      "snapshots",
      `interaction:${PREMIERE_ID}.snapshot.json`,
    );
    const snapshot = JSON.parse(
      await fs.readFile(snapshotPath, "utf8"),
    ) as Record<string, unknown>;
    snapshot.state = {
      ...(snapshot.state as Record<string, unknown>),
      sessions: [],
    };
    snapshot.stateHash = hashReplayPremiereJson(
      snapshot.state as ReplayPremiereJsonValue,
    );
    await fs.writeFile(
      snapshotPath,
      `${canonicalReplayPremiereJson(snapshot as ReplayPremiereJsonValue)}\n`,
      { mode: 0o600 },
    );
    const secondContext = startupContext();

    const second = await startReplayPremiereProduction({
      ...secondContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(second.service);

    expect(second.registeredPremiereIds).toEqual([]);
    expect(second.diagnostics[0].operatorCode).toBe(
      "interaction_snapshot_commitment_mismatch",
    );
    expect(secondContext.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(secondContext.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
  });

  test("rejects a forged runtime snapshot anchor before either registration", async () => {
    await writeAdmission(root);
    const firstContext = startupContext();
    const first = await startReplayPremiereProduction({
      ...firstContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    await first.service.close();
    const snapshotPath = path.join(
      root,
      "private",
      "event-store-v1",
      "snapshots",
      `${PREMIERE_ID}.snapshot.json`,
    );
    const snapshot = JSON.parse(
      await fs.readFile(snapshotPath, "utf8"),
    ) as Record<string, unknown>;
    snapshot.state = {
      ...(snapshot.state as Record<string, unknown>),
      scheduleShiftMs:
        Number((snapshot.state as Record<string, unknown>).scheduleShiftMs) + 1,
    };
    snapshot.stateHash = hashReplayPremiereJson(
      snapshot.state as ReplayPremiereJsonValue,
    );
    await fs.writeFile(
      snapshotPath,
      `${canonicalReplayPremiereJson(snapshot as ReplayPremiereJsonValue)}\n`,
      { mode: 0o600 },
    );
    const secondContext = startupContext();

    const second = await startReplayPremiereProduction({
      ...secondContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(second.service);

    expect(second.registeredPremiereIds).toEqual([]);
    expect(second.diagnostics[0].operatorCode).toBe(
      "premiere_runtime_snapshot_anchor_mismatch",
    );
    expect(secondContext.httpRegistry.get(PREMIERE_ID)).toBeNull();
    expect(secondContext.runtimeRegistry.get(PREMIERE_ID)).toBeNull();
  });

  test("backs persistent runtime failures off without growing startup diagnostics or logs", async () => {
    vi.useFakeTimers({ now: NOW });
    await writeAdmission(root);
    const context = startupContext(() => new Date());
    const liveDiagnostics: Array<{
      target: string;
      premiereId: string | null;
      operatorCode: string;
    }> = [];
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      onDiagnostic: (diagnostic) => liveDiagnostics.push(diagnostic),
    });
    services.push(started.service);
    const runtime = context.runtimeRegistry.get(PREMIERE_ID)!;
    const synchronize = vi
      .spyOn(runtime, "synchronize")
      .mockRejectedValue(
        new ReplayPremiereError(
          "test_persistent_runtime_failure",
          "PREMIERE_UNAVAILABLE",
          503,
          "Injected persistent runtime failure",
        ),
      );

    await vi.advanceTimersByTimeAsync(100);
    await started.service.waitForRuntimeTimersIdle();
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(liveDiagnostics).toEqual([
      {
        target: `${PREMIERE_ID}.runtime`,
        premiereId: PREMIERE_ID,
        operatorCode: "test_persistent_runtime_failure",
      },
    ]);
    expect(started.diagnostics).toEqual([]);
    expect(Object.isFrozen(started.diagnostics)).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await started.service.waitForRuntimeTimersIdle();
    expect(synchronize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(synchronize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await started.service.waitForRuntimeTimersIdle();
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(liveDiagnostics).toHaveLength(1);
    expect(started.diagnostics).toEqual([]);
    expect(started.service.readActiveTimerCount()).toBe(1);

    await started.service.close();
    services.splice(services.indexOf(started.service), 1);
    expect(started.service.readActiveTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(liveDiagnostics).toHaveLength(1);
  });

  test("advances checkpoints and reveal on authoritative timers without viewer reads", async () => {
    vi.useFakeTimers({ now: NOW });
    await writeAdmission(root);
    const context = startupContext(() => new Date());
    const started = await startReplayPremiereProduction({
      ...context,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(started.service);
    const runtime = context.runtimeRegistry.get(PREMIERE_ID)!;
    expect(runtime.readLifecycleState()).toBe("playing");

    await vi.advanceTimersByTimeAsync(100);
    await started.service.waitForRuntimeTimersIdle();
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    await vi.advanceTimersByTimeAsync(15_000);
    await started.service.waitForRuntimeTimersIdle();
    expect(runtime.readLifecycleState()).toBe("playing");
    await vi.advanceTimersByTimeAsync(100);
    await started.service.waitForRuntimeTimersIdle();
    expect(runtime.readLifecycleState()).toBe("checkpoint");
    await vi.advanceTimersByTimeAsync(15_000);
    await started.service.waitForRuntimeTimersIdle();
    expect(runtime.readLifecycleState()).toBe("playing");
    await vi.advanceTimersByTimeAsync(50);
    await started.service.waitForRuntimeTimersIdle();

    expect(runtime.readLifecycleState()).toBe("revealed");
    expect(runtime.readReveal()).not.toBeNull();
    expect(started.service.readActiveTimerCount()).toBe(0);

    await started.service.close();
    services.splice(services.indexOf(started.service), 1);
    const revealedContext = startupContext(() => new Date());
    const revealed = await startReplayPremiereProduction({
      ...revealedContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(revealed.service);
    expect(revealed.diagnostics).toEqual([]);
    expect(revealed.registeredPremiereIds).toEqual([PREMIERE_ID]);
    const revealedRuntime = revealedContext.runtimeRegistry.get(PREMIERE_ID)!;
    expect(revealedRuntime.readLifecycleState()).toBe("revealed");

    await revealedRuntime.archive();
    await revealed.service.close();
    services.splice(services.indexOf(revealed.service), 1);
    const archivedContext = startupContext(() => new Date());
    const archived = await startReplayPremiereProduction({
      ...archivedContext,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
    });
    services.push(archived.service);
    expect(archived.diagnostics).toEqual([]);
    expect(archived.registeredPremiereIds).toEqual([PREMIERE_ID]);
    expect(
      archivedContext.runtimeRegistry.get(PREMIERE_ID)?.readLifecycleState(),
    ).toBe("archived");
  });
});

async function writeAdmission(root: string, origin?: string): Promise<void> {
  const fixture = await verifiedPublicationFixture(root, { origin });
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
  });
  try {
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
  } finally {
    await catalog.close();
  }
}

async function writeAdmissionWithChunkLimits(
  root: string,
  chunkLimits: typeof PLAYING_CHUNK_LIMITS,
): Promise<void> {
  const fixture = await verifiedPublicationFixture(root);
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: fixture.verificationOptions.verifiedSource.copyBytes(),
    eligibilityRecord: fixture.verificationOptions.eligibilityRecord,
    authoritativeResultBytes:
      fixture.verificationOptions.authoritativeResultBytes,
    replayImportLimits: fixture.verificationOptions.replayImportLimits,
  });
  const drafts = buildPremiereChunks({
    premiereId: PREMIERE_ID,
    records: imported.records,
    playbackRate: fixture.verificationOptions.publicDefinition.playbackRate,
    checkpointSequences:
      fixture.verificationOptions.publicDefinition.checkpoints.map(
        (checkpoint) => checkpoint.sequence,
      ),
    ...chunkLimits,
  });
  const verification = {
    ...fixture.verificationOptions,
    draftChunks: drafts,
  };
  const gate = VerifiedPremiereEligibilityGate.verify(verification);
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
  });
  try {
    await catalog.writeVerifiedAdmission({
      gate,
      verification,
      chunkBuildLimits: chunkLimits,
      collectorLimits: COLLECTOR_LIMITS,
    });
  } finally {
    await catalog.close();
  }
}

async function driveRuntimeToReveal(
  runtime: NonNullable<ReturnType<ReplayPremiereRuntimeRegistry["get"]>>,
): Promise<void> {
  vi.setSystemTime(NOW.getTime() + 100);
  await runtime.synchronize();
  vi.setSystemTime(NOW.getTime() + 15_100);
  await runtime.synchronize();
  vi.setSystemTime(NOW.getTime() + 15_200);
  await runtime.synchronize();
  vi.setSystemTime(NOW.getTime() + 30_200);
  await runtime.synchronize();
  vi.setSystemTime(NOW.getTime() + 30_250);
  await runtime.synchronize();
}

function startupContext(now: () => Date = () => new Date(NOW)): {
  security: ReplayPremiereGuestSecurity;
  httpRegistry: ReplayPremiereHttpRegistry;
  runtimeRegistry: ReplayPremiereRuntimeRegistry;
  checkpointProjector: ReplayPremiereCheckpointProjector;
  publicOrigin: string;
  clock: { now(): Date };
} {
  const security = new ReplayPremiereGuestSecurity({
    hmacKey: new Uint8Array(32).fill(7),
    expectedOrigin: ORIGIN,
    production: true,
    now,
  });
  const limiter = new ReplayPremiereAnonymousWriteLimiter({
    now,
  });
  return {
    security,
    httpRegistry: new ReplayPremiereHttpRegistry(limiter.admit),
    runtimeRegistry: new ReplayPremiereRuntimeRegistry(),
    checkpointProjector: {
      async project({ gate }) {
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

async function withHttpApp(
  router: express.Router,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind an address");
  }
  try {
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
}

class RejectingReplayPremiereHttpRegistry extends ReplayPremiereHttpRegistry {
  override register(_target: ReplayPremiereHttpTarget): void {
    throw new ReplayPremiereError(
      "test_http_registration_rejected",
      "PREMIERE_UNAVAILABLE",
      503,
      "Injected registry rejection",
    );
  }
}

async function writeTwoAdmissions(root: string): Promise<{
  primary: string;
  alternate: string;
}> {
  const fixture = await verifiedPublicationFixture(root);
  const alternatePremiereId = "prem_fedcba9876543210";
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: fixture.verificationOptions.verifiedSource.copyBytes(),
    eligibilityRecord: fixture.verificationOptions.eligibilityRecord,
    authoritativeResultBytes:
      fixture.verificationOptions.authoritativeResultBytes,
    replayImportLimits: fixture.verificationOptions.replayImportLimits,
  });
  const alternateDrafts = buildPremiereChunks({
    premiereId: alternatePremiereId,
    records: imported.records,
    playbackRate: fixture.verificationOptions.publicDefinition.playbackRate,
    checkpointSequences:
      fixture.verificationOptions.publicDefinition.checkpoints.map(
        (checkpoint) => checkpoint.sequence,
      ),
    ...CHUNK_LIMITS,
  });
  const alternateVerification = {
    ...fixture.verificationOptions,
    premiereId: alternatePremiereId,
    draftChunks: alternateDrafts,
  };
  const alternateGate = VerifiedPremiereEligibilityGate.verify(
    alternateVerification,
  );
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
  });
  try {
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    await catalog.writeVerifiedAdmission({
      gate: alternateGate,
      verification: alternateVerification,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
  } finally {
    await catalog.close();
  }
  return { primary: PREMIERE_ID, alternate: alternatePremiereId };
}

async function writeAlternateAdmission(
  root: string,
  alternatePremiereId: string,
): Promise<void> {
  const fixture = await verifiedPublicationFixture(root);
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: fixture.verificationOptions.verifiedSource.copyBytes(),
    eligibilityRecord: fixture.verificationOptions.eligibilityRecord,
    authoritativeResultBytes:
      fixture.verificationOptions.authoritativeResultBytes,
    replayImportLimits: fixture.verificationOptions.replayImportLimits,
  });
  const alternateDrafts = buildPremiereChunks({
    premiereId: alternatePremiereId,
    records: imported.records,
    playbackRate: fixture.verificationOptions.publicDefinition.playbackRate,
    checkpointSequences:
      fixture.verificationOptions.publicDefinition.checkpoints.map(
        (checkpoint) => checkpoint.sequence,
      ),
    ...CHUNK_LIMITS,
  });
  const alternateVerification = {
    ...fixture.verificationOptions,
    premiereId: alternatePremiereId,
    draftChunks: alternateDrafts,
  };
  const alternateGate = VerifiedPremiereEligibilityGate.verify(
    alternateVerification,
  );
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
  });
  try {
    await catalog.writeVerifiedAdmission({
      gate: alternateGate,
      verification: alternateVerification,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
  } finally {
    await catalog.close();
  }
}

function admissionPath(root: string, premiereId: string): string {
  return path.join(
    root,
    "private",
    "catalog-v1",
    "entries",
    `${premiereId}.admission.json`,
  );
}

function withoutRecordHash(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { recordHash: _recordHash, ...preimage } = record;
  return preimage;
}

async function writeAdmissionObject(
  filePath: string,
  preimage: Record<string, unknown>,
): Promise<void> {
  const record = {
    ...preimage,
    recordHash: hashReplayPremiereJson(
      preimage as unknown as ReplayPremiereJsonValue,
    ),
  };
  await fs.chmod(filePath, 0o600);
  await fs.writeFile(
    filePath,
    `${canonicalReplayPremiereJson(record as ReplayPremiereJsonValue)}\n`,
  );
  await fs.chmod(filePath, 0o400);
}
