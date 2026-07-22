import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs, type StatsFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clipFileName,
  composePremiereClipSocialText,
  killPremiereClipWorkerTree,
  ReplayPremiereClips,
  type ReplayPremiereClipsOptions,
  selectPrerenderBuckets,
} from "../../../src/server/replay-premiere/ReplayPremiereClips";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import {
  premiereClipBucketForTurn,
  premiereClipRepresentativeAnchorTurn,
} from "../../../src/server/replay-premiere/ReplayPremiereContracts";

const ATTRIBUTION =
  "Game art from OpenFront (openfront.io), CC BY-SA 4.0; footage shared under the same license.";
const NO_ENDORSEMENT =
  "Proxy War is an independent fork — not affiliated with or endorsed by OpenFront.";
const SHA = "a".repeat(64);
const PREMIERE = "prem_0123456789abcdef";

type FakeChild = EventEmitter & {
  kill(signal?: string): boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

/** A worker that writes a valid clip + manifest and exits 0 on next tick. */
function fastFakeSpawn(
  bytesFor: (anchorTurn: number) => Buffer = (t) => Buffer.alloc(100, t % 251),
): ReplayPremiereClipsOptions["spawnWorker"] {
  return (jobSpecPath) => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    setImmediate(() => {
      void (async () => {
        try {
          const spec = JSON.parse(await fs.readFile(jobSpecPath, "utf8"));
          const bytes = bytesFor(spec.anchorTurn);
          await fs.writeFile(path.join(spec.outDir, "clip.mp4"), bytes);
          await fs.writeFile(
            path.join(spec.outDir, "render-manifest.json"),
            JSON.stringify({
              premiereId: spec.premiereId,
              sourceReplaySha256: spec.expectedBundleSha256,
              anchorTurn: spec.anchorTurn,
              clipVersion: spec.clipVersion,
              frameShape: "square",
              frameWidth: 1080,
              frameHeight: 1080,
              outSha256: createHash("sha256").update(bytes).digest("hex"),
              outBytes: bytes.length,
              generatedAt: new Date().toISOString(),
            }),
          );
          child.exitCode = 0;
          child.emit("exit", 0);
        } catch (error) {
          child.emit("error", error);
        }
      })();
    });
    return child as never;
  };
}

/** A worker that never finishes (used to test admission before completion). */
function hangingSpawn(): ReplayPremiereClipsOptions["spawnWorker"] {
  return () => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.exitCode = -1;
      child.emit("exit", null);
      return true;
    };
    return child as never;
  };
}

function statfsFree(bytes: number): (p: string) => Promise<StatsFs> {
  return async () => ({ bavail: bytes, bsize: 1 }) as unknown as StatsFs;
}

let root: string;
let clipsRoot: string;
let sourcePath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pw-clips-test-"));
  clipsRoot = path.join(root, "clips-v1");
  sourcePath = path.join(root, "sources", "sha256", "aa", `${SHA}.replay`);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "fixture replay");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function makeClips(
  overrides: Partial<ReplayPremiereClipsOptions> = {},
): ReplayPremiereClips {
  return new ReplayPremiereClips({
    clipsRoot,
    sourceBundleRoot: root,
    staticDir: path.join(root, "static"),
    workerModulePath: path.join(root, "worker.ts"),
    publicOrigin: "https://beta.proxywar.xyz",
    licenseStrings: { attribution: ATTRIBUTION, noEndorsement: NO_ENDORSEMENT },
    storageStatePath: path.join(root, "state.json"),
    statfs: statfsFree(100 * 1024 ** 3),
    spawnWorker: fastFakeSpawn(),
    ...overrides,
  });
}

async function waitReady(
  clips: ReplayPremiereClips,
  premiereId: string,
  bucket: number,
  lifecycleState: PremiereState = "revealed",
) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = clips.readStatus({ premiereId, lifecycleState, bucket });
    if (status.state === "ready") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`clip ${premiereId}:${bucket} never became ready`);
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const revealedRequest = (
  premiereId: string,
  anchorTurn: number,
  participantId: string | null,
) => ({
  premiereId,
  lifecycleState: "revealed" as PremiereState,
  anchorTurn,
  participantId,
  sourceReplaySha256: SHA,
});

describe("bucketing", () => {
  test("floors anchor turns into 10-turn buckets and back to a center anchor", () => {
    expect(premiereClipBucketForTurn(600)).toBe(60);
    expect(premiereClipBucketForTurn(609)).toBe(60);
    expect(premiereClipBucketForTurn(610)).toBe(61);
    expect(premiereClipRepresentativeAnchorTurn(60)).toBe(605);
  });
});

describe("cache hit / miss and render", () => {
  test("miss enqueues (pending), renders, then serves the same bucket from cache", async () => {
    const clips = makeClips();
    const first = await clips.requestClip(
      revealedRequest(PREMIERE, 605, "p_a"),
    );
    expect(first.state).toBe("pending");
    const ready = await waitReady(clips, PREMIERE, 60);
    expect(ready.state).toBe("ready");
    expect(ready.ready?.clipUrl).toBe(`/premiere/${PREMIERE}/clip-v1-60.mp4`);
    expect(ready.ready?.byteLength).toBe(100);

    // Same bucket (any anchor 600-609) is a cache hit, no new render.
    const hit = await clips.requestClip(revealedRequest(PREMIERE, 601, "p_b"));
    expect(hit.state).toBe("ready");
    await clips.close();
  });

  test("a second request for an in-flight bucket joins without a new render", async () => {
    const clips = makeClips({ spawnWorker: hangingSpawn() });
    const first = await clips.requestClip(
      revealedRequest(PREMIERE, 605, "p_a"),
    );
    const join = await clips.requestClip(revealedRequest(PREMIERE, 605, "p_a"));
    expect(first.state).toBe("pending");
    expect(join.state).toBe("pending");
    await clips.close();
  });
});

describe("quotas → 429", () => {
  test("per-participant (3 / premiere) exhausts on the 4th distinct bucket", async () => {
    const clips = makeClips({
      spawnWorker: hangingSpawn(),
      limits: { maxQueueDepth: 100 },
    });
    for (const turn of [600, 700, 800]) {
      expect(
        (await clips.requestClip(revealedRequest(PREMIERE, turn, "p_a"))).state,
      ).toBe("pending");
    }
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 900, "p_a")),
    ).rejects.toMatchObject({ httpStatus: 429 });
    await clips.close();
  });

  test("per-premiere (30 / day) exhausts across participants", async () => {
    const clips = makeClips({
      spawnWorker: hangingSpawn(),
      limits: { maxRendersPerPremierePerDay: 3, maxQueueDepth: 100 },
    });
    for (const [i, turn] of [600, 700, 800].entries()) {
      await clips.requestClip(revealedRequest(PREMIERE, turn, `p_${i}`));
    }
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 900, "p_z")),
    ).rejects.toMatchObject({ httpStatus: 429 });
    await clips.close();
  });

  test("global (12 / hour) exhausts across premieres", async () => {
    const clips = makeClips({
      spawnWorker: hangingSpawn(),
      limits: { maxRendersGlobalPerHour: 3, maxQueueDepth: 100 },
    });
    const premiereIds = [
      "prem_1111111111111111",
      "prem_2222222222222222",
      "prem_3333333333333333",
    ];
    for (const premiereId of premiereIds) {
      await clips.requestClip(revealedRequest(premiereId, 605, "p_a"));
    }
    await expect(
      clips.requestClip(revealedRequest("prem_4444444444444444", 605, "p_a")),
    ).rejects.toMatchObject({ httpStatus: 429 });
    await clips.close();
  });

  test("a full queue rejects with 429", async () => {
    const clips = makeClips({
      spawnWorker: hangingSpawn(),
      limits: { maxQueueDepth: 1, maxRendersPerParticipantPerPremiere: 100 },
    });
    // 1 running + 1 queued fills the depth-1 queue; the 3rd is refused.
    await clips.requestClip(revealedRequest(PREMIERE, 600, "p_a"));
    await clips.requestClip(revealedRequest(PREMIERE, 700, "p_a"));
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 800, "p_a")),
    ).rejects.toMatchObject({ httpStatus: 429 });
    await clips.close();
  });
});

describe("disk-floor refusal", () => {
  test("free space below the floor refuses with 503", async () => {
    const clips = makeClips({ statfs: statfsFree(1) });
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 605, "p_a")),
    ).rejects.toMatchObject({ httpStatus: 503 });
    await clips.close();
  });

  test("a critical storage watermark refuses with 503", async () => {
    const statePath = path.join(root, "state.json");
    await fs.writeFile(statePath, JSON.stringify({ watermark: "critical" }));
    const clips = makeClips({ storageStatePath: statePath });
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 605, "p_a")),
    ).rejects.toMatchObject({ httpStatus: 503 });
    await clips.close();
  });
});

describe("source preflight", () => {
  test("a missing/non-file source fails closed before disk, quota, queue, or spawn", async () => {
    await fs.rm(sourcePath);
    let statfsCalls = 0;
    let spawnCalls = 0;
    const spawn = fastFakeSpawn();
    const clips = makeClips({
      statfs: async (p) => {
        statfsCalls += 1;
        return statfsFree(100 * 1024 ** 3)(p);
      },
      spawnWorker: (...args) => {
        spawnCalls += 1;
        return spawn!(...args);
      },
      limits: { maxRendersPerParticipantPerPremiere: 1 },
    });

    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 605, "p_a")),
    ).rejects.toMatchObject({
      httpStatus: 404,
      publicCode: "PREMIERE_UNAVAILABLE",
      operatorCode: "clip_source_bundle_unavailable",
    });
    expect(statfsCalls).toBe(0);
    expect(spawnCalls).toBe(0);

    // A directory at the expected path is not a renderable source either.
    await fs.mkdir(sourcePath);
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 605, "p_a")),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "clip_source_bundle_unavailable",
    });
    await fs.rm(sourcePath, { recursive: true });
    expect(statfsCalls).toBe(0);
    expect(spawnCalls).toBe(0);

    // The refusal did not consume the participant's single render quota.
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "fixture replay");
    await expect(
      clips.requestClip(revealedRequest(PREMIERE, 605, "p_a")),
    ).resolves.toMatchObject({ state: "pending" });
    await waitReady(clips, PREMIERE, 60);
    expect(statfsCalls).toBe(1);
    expect(spawnCalls).toBe(1);
    await clips.close();
  });
});

describe("LRU eviction", () => {
  test("evicts the least-recently-accessed clip past the global byte cap", async () => {
    // A monotonic injected clock makes the access ordering deterministic.
    let clock = 1000;
    const clips = makeClips({
      limits: { maxTotalBytes: 250 }, // holds 2 x 100 bytes
      now: () => clock,
    });
    clock = 1000;
    await clips.requestClip(revealedRequest(PREMIERE, 600, "p_a"));
    await waitReady(clips, PREMIERE, 60);
    clock = 2000;
    await clips.requestClip(revealedRequest(PREMIERE, 700, "p_a"));
    await waitReady(clips, PREMIERE, 70);
    // Touch bucket 60 so it is more-recently-used than 70.
    clock = 3000;
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 60,
      }).state,
    ).toBe("ready");
    clock = 4000;
    await clips.requestClip(revealedRequest(PREMIERE, 800, "p_a"));
    await waitReady(clips, PREMIERE, 80);
    // 70 was the LRU -> evicted; 60 and 80 remain (250-byte cap holds 2).
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 70,
      }).state,
    ).toBe("absent");
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 80,
      }).state,
    ).toBe("ready");
    await expect(
      fs.stat(path.join(clipsRoot, PREMIERE, clipFileName(70))),
    ).rejects.toBeTruthy();
    await clips.close();
  });

  test("enforces the per-premiere clip cap", async () => {
    const clips = makeClips({ limits: { maxClipsPerPremiere: 2 } });
    for (const turn of [600, 700, 800]) {
      await clips.requestClip(revealedRequest(PREMIERE, turn, "p_a"));
      await waitReady(clips, PREMIERE, premiereClipBucketForTurn(turn));
    }
    const readyCount = [60, 70, 80].filter(
      (bucket) =>
        clips.readStatus({
          premiereId: PREMIERE,
          lifecycleState: "revealed",
          bucket,
        }).state === "ready",
    ).length;
    expect(readyCount).toBe(2);
    await clips.close();
  });
});

describe("caption + first-reply composition", () => {
  test("caption carries both license lines and NO url; url lives in the reply", () => {
    const watchUrl = "https://beta.proxywar.xyz/premiere/prem_0123456789abcdef";
    const social = composePremiereClipSocialText({
      attribution: ATTRIBUTION,
      noEndorsement: NO_ENDORSEMENT,
      watchUrl,
      anchorTurn: 605,
    });
    expect(social.caption).toContain(ATTRIBUTION);
    expect(social.caption).toContain(NO_ENDORSEMENT);
    expect(social.caption).not.toContain(watchUrl);
    expect(social.caption).not.toContain("https://");
    expect(social.caption).not.toContain("beta.proxywar.xyz/premiere");
    expect(social.firstReply).toContain(watchUrl);
  });

  test("a ready status exposes the same license-bearing caption", async () => {
    const clips = makeClips();
    await clips.requestClip(revealedRequest(PREMIERE, 605, "p_a"));
    const ready = await waitReady(clips, PREMIERE, 60);
    expect(ready.ready?.social.caption).toContain(ATTRIBUTION);
    expect(ready.ready?.social.caption).toContain(NO_ENDORSEMENT);
    expect(ready.ready?.social.caption).not.toContain("https://");
    expect(ready.ready?.social.firstReply).toContain(
      `https://beta.proxywar.xyz/premiere/${PREMIERE}`,
    );
    await clips.close();
  });
});

describe("pre-render selection", () => {
  test("selects the densest clip_this buckets, ignoring other kinds", () => {
    const buckets = selectPrerenderBuckets(
      [
        { kind: "clip_this", sequence: 1, turn: 600 },
        { kind: "clip_this", sequence: 2, turn: 603 },
        { kind: "clip_this", sequence: 3, turn: 608 }, // bucket 60 x3
        { kind: "clip_this", sequence: 4, turn: 701 },
        { kind: "clip_this", sequence: 5, turn: 705 }, // bucket 70 x2
        { kind: "clip_this", sequence: 6, turn: 802 }, // bucket 80 x1
        { kind: "turning_point", sequence: 7, turn: 905 }, // ignored
        { kind: "smart", sequence: 8, turn: 30 }, // too early, ignored
      ],
      3,
    );
    expect(buckets).toEqual([60, 70, 80]);
  });

  test("enqueues the selected buckets as system renders (no participant quota)", async () => {
    const clips = makeClips();
    const enqueued = await clips.prerenderTopReactionBuckets({
      premiereId: PREMIERE,
      lifecycleState: "revealed",
      reactions: [
        { kind: "clip_this", sequence: 1, turn: 600 },
        { kind: "clip_this", sequence: 2, turn: 605 },
        { kind: "clip_this", sequence: 3, turn: 705 },
      ],
      sourceReplaySha256: SHA,
    });
    expect(enqueued).toEqual([60, 70]);
    await waitReady(clips, PREMIERE, 60);
    await waitReady(clips, PREMIERE, 70);
    await clips.close();
  });
});

describe("index rebuild from a synthetic cache dir", () => {
  test("adopts on-disk clips with valid sidecars and ignores mismatched ones", async () => {
    const dir = path.join(clipsRoot, PREMIERE);
    await fs.mkdir(dir, { recursive: true });
    const bytes = Buffer.alloc(100, 9);
    await fs.writeFile(path.join(dir, clipFileName(60)), bytes);
    await fs.writeFile(
      path.join(dir, "clip-v1-60.render-manifest.json"),
      JSON.stringify({
        premiereId: PREMIERE,
        sourceReplaySha256: SHA,
        anchorTurn: 605,
        clipVersion: 1,
        frameShape: "square",
        frameWidth: 1080,
        frameHeight: 1080,
        outSha256: createHash("sha256").update(bytes).digest("hex"),
        outBytes: 100,
        generatedAt: new Date().toISOString(),
      }),
    );
    // A clip whose sidecar size disagrees with the file must be ignored.
    await fs.writeFile(path.join(dir, clipFileName(70)), Buffer.alloc(100, 1));
    await fs.writeFile(
      path.join(dir, "clip-v1-70.render-manifest.json"),
      JSON.stringify({
        premiereId: PREMIERE,
        sourceReplaySha256: SHA,
        anchorTurn: 705,
        clipVersion: 1,
        frameShape: "square",
        frameWidth: 1080,
        frameHeight: 1080,
        outSha256: "deadbeef",
        outBytes: 999, // != 100
        generatedAt: new Date().toISOString(),
      }),
    );

    const clips = makeClips();
    await clips.rebuildIndex();
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 60,
      }).state,
    ).toBe("ready");
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 70,
      }).state,
    ).toBe("absent");
    await clips.close();
  });
});

describe("archived semantics", () => {
  test("reads are allowed when archived; writes are 410", async () => {
    const clips = makeClips();
    await clips.requestClip(revealedRequest(PREMIERE, 605, "p_a"));
    await waitReady(clips, PREMIERE, 60);
    // Read while archived -> still ready.
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "archived",
        bucket: 60,
      }).state,
    ).toBe("ready");
    const file = await clips.resolveReadyClip({
      premiereId: PREMIERE,
      lifecycleState: "archived",
      bucket: 60,
    });
    expect(file).not.toBeNull();
    // Write while archived -> 410.
    await expect(
      clips.requestClip({
        premiereId: PREMIERE,
        lifecycleState: "archived",
        anchorTurn: 705,
        participantId: "p_a",
        sourceReplaySha256: SHA,
      }),
    ).rejects.toMatchObject({ httpStatus: 410 });
    await clips.close();
  });

  test("pre-reveal reads are absent and writes are a fail-closed 404", async () => {
    const clips = makeClips();
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "playing",
        bucket: 60,
      }).state,
    ).toBe("absent");
    await expect(
      clips.requestClip({
        premiereId: PREMIERE,
        lifecycleState: "playing",
        anchorTurn: 605,
        participantId: "p_a",
        sourceReplaySha256: SHA,
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    await clips.close();
  });
});

describe("worker diagnostics and shutdown", () => {
  test("the default spawn drains bounded stdout/stderr tails into a failed-render log", async () => {
    const workerPath = path.join(root, "failing-worker.mjs");
    await fs.writeFile(
      workerPath,
      [
        'process.stdout.write("x".repeat(12_000));',
        'console.log("\\n[clip-worker] park: tick 50300 / 50350");',
        'process.stderr.write("y".repeat(12_000));',
        'console.error("\\n[clip-worker] FAILED: Runtime.evaluate timed out at tick 50300");',
        "process.exitCode = 1;",
      ].join("\n"),
    );
    const logs: string[] = [];
    const clips = makeClips({
      spawnWorker: undefined,
      workerModulePath: workerPath,
      logger: (line) => logs.push(line),
    });

    await clips.requestClip(revealedRequest(PREMIERE, 605, null));
    await waitUntil(
      () => logs.some((line) => line.includes("clip render failed")),
      "failed-worker diagnostic",
    );
    const failure = logs.find((line) => line.includes("clip render failed"));
    expect(failure).toContain("park: tick 50300 / 50350");
    expect(failure).toContain("Runtime.evaluate timed out at tick 50300");
    expect(failure!.length).toBeLessThan(9_000);
    await clips.close();
  });

  test("close waits for the killed worker's exit event", async () => {
    let notifySpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      notifySpawned = resolve;
    });
    const clips = makeClips({
      spawnWorker: () => {
        const child = new EventEmitter() as FakeChild;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {
          setTimeout(() => {
            child.signalCode = "SIGKILL";
            child.emit("exit", null, "SIGKILL");
          }, 75);
          return true;
        };
        notifySpawned();
        return child as never;
      },
      limits: { workerExitGraceMs: 500 },
    });
    await clips.requestClip(revealedRequest(PREMIERE, 605, null));
    await spawned;

    let resolved = false;
    const startedAt = Date.now();
    const closing = clips.close().then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    await closing;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
  });

  test("close force-settles after a bounded grace when a child emits no exit", async () => {
    let notifySpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      notifySpawned = resolve;
    });
    const logs: string[] = [];
    const clips = makeClips({
      spawnWorker: () => {
        const child = new EventEmitter() as FakeChild;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;
        notifySpawned();
        return child as never;
      },
      limits: { workerExitGraceMs: 50 },
      logger: (line) => logs.push(line),
    });
    await clips.requestClip(revealedRequest(PREMIERE, 605, null));
    await spawned;

    const startedAt = Date.now();
    await clips.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(logs).toContain(
      "clip worker did not report exit within 50ms after SIGKILL",
    );
  });

  test("close during the asynchronous pre-spawn prelude prevents a late spawn", async () => {
    let spawnCalls = 0;
    const spawn = hangingSpawn()!;
    const clips = makeClips({
      spawnWorker: (...args) => {
        spawnCalls += 1;
        return spawn(...args);
      },
    });
    const status = await clips.requestClip(
      revealedRequest(PREMIERE, 605, null),
    );
    expect(status.state).toBe("pending");
    await clips.close();
    expect(spawnCalls).toBe(0);
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 60,
      }).state,
    ).toBe("absent");
  });

  test("an injected worker ordinary exit is never treated as an owned detached PGID", async () => {
    const injectedPid = 2_000_000_000;
    const killSpy = vi.spyOn(process, "kill");
    const logs: string[] = [];
    const clips = makeClips({
      spawnWorker: () => {
        const child = new EventEmitter() as FakeChild & { pid: number };
        child.pid = injectedPid;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;
        setImmediate(() => {
          child.exitCode = 19;
          child.emit("exit", 19);
        });
        return child as never;
      },
      logger: (line) => logs.push(line),
    });
    try {
      await clips.requestClip(revealedRequest(PREMIERE, 605, null));
      await waitUntil(
        () => logs.some((line) => line.includes("exit=19")),
        "injected worker exit",
      );
      expect(killSpy).not.toHaveBeenCalledWith(-injectedPid, "SIGKILL");
    } finally {
      await clips.close();
      killSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Worker process-group reaping (2026-07-22 orphaned-Chrome incident)
// ---------------------------------------------------------------------------

describe("worker process-group reaping", () => {
  async function pidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForPidsDead(pids: number[], label: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const alive = await Promise.all(pids.map(pidAlive));
      if (alive.every((isAlive) => !isAlive)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label}: pids still alive: ${pids.join(", ")}`);
  }

  async function processGroupId(pid: number): Promise<number> {
    const { execFile } = await import("node:child_process");
    return await new Promise<number>((resolve, reject) => {
      execFile("ps", ["-o", "pgid=", "-p", String(pid)], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Number(stdout.trim()));
      });
    });
  }

  test("killPremiereClipWorkerTree reaps a detached worker AND its children", async () => {
    const { spawn } = await import("node:child_process");
    // Mirror the service's default spawn shape: a detached node process that
    // spawns its own long-lived child (Chrome/ffmpeg stand-in).
    const worker = spawn(
      process.execPath,
      [
        "-e",
        "const cp=require('node:child_process');const c=cp.spawn('sleep',['300'],{stdio:'ignore'});console.log('CHILD='+c.pid);setInterval(()=>{},1000);",
      ],
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    const childPid = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("fixture never reported its child pid")),
        10_000,
      );
      worker.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = /CHILD=(\d+)/.exec(buffer);
        if (match !== null) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    // The detached worker leads its OWN process group — never the server's —
    // so a SIGKILL'd render can no longer strand Chrome inside the beta PGID.
    expect(await processGroupId(worker.pid!)).toBe(worker.pid);
    expect(await processGroupId(worker.pid!)).not.toBe(
      await processGroupId(process.pid),
    );
    killPremiereClipWorkerTree(worker);
    await waitForPidsDead([worker.pid!, childPid], "direct group kill");
  });

  test("killPremiereClipWorkerTree falls back to a plain kill for non-leaders", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    killPremiereClipWorkerTree(child);
    await waitForPidsDead([child.pid!], "fallback kill");
  });

  test("a REAL timed-out render leaves neither the worker nor its child behind", async () => {
    // End-to-end through the service's actual default spawn: a fixture worker
    // (spawns a long-lived child, reports pids, hangs) is SIGKILL'd by the job
    // timeout; the whole tree must be gone afterwards.
    const scratchDir = path.join(root, "orphan-scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    const clips = makeClips({
      spawnWorker: undefined, // the real default spawn path
      workerModulePath: path.join(
        __dirname,
        "fixtures",
        "orphaning-clip-worker.mjs",
      ),
      scratchDir,
      limits: { jobTimeoutMs: 2_500 },
    });
    const status = await clips.requestClip(
      revealedRequest(PREMIERE, 605, null),
    );
    expect(status.state).toBe("pending");

    const pidsPath = path.join(scratchDir, "orphan-pids.txt");
    const pids = await (async () => {
      for (let attempt = 0; attempt < 400; attempt++) {
        try {
          const raw = await fs.readFile(pidsPath, "utf8");
          const [workerPid, childPid] = raw.trim().split(/\s+/).map(Number);
          if (
            Number.isSafeInteger(workerPid) &&
            Number.isSafeInteger(childPid)
          ) {
            return { workerPid, childPid };
          }
        } catch {
          // Fixture still booting.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("orphan fixture never reported pids");
    })();
    // Own group, outside the server's group, while still alive.
    expect(await processGroupId(pids.workerPid)).toBe(pids.workerPid);
    expect(await processGroupId(pids.workerPid)).not.toBe(
      await processGroupId(process.pid),
    );
    // The job timeout must reap the ENTIRE tree.
    await waitForPidsDead(
      [pids.workerPid, pids.childPid],
      "service timeout reap",
    );
    // The failed job is fully released (no pending latch).
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        clips.readStatus({
          premiereId: PREMIERE,
          lifecycleState: "revealed",
          bucket: 60,
        }).state === "absent"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: 60,
      }).state,
    ).toBe("absent");
    await clips.close();
  });

  test("a REAL default worker nonzero exit reaps its reparented grandchild before the job timeout", async () => {
    const scratchDir = path.join(root, "exiting-orphan-scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    const logs: string[] = [];
    const clips = makeClips({
      spawnWorker: undefined,
      workerModulePath: path.join(
        __dirname,
        "fixtures",
        "exiting-orphaning-clip-worker.mjs",
      ),
      scratchDir,
      limits: { jobTimeoutMs: 30_000 },
      logger: (line) => logs.push(line),
    });
    let grandchildPid: number | null = null;
    try {
      const startedAt = Date.now();
      const status = await clips.requestClip(
        revealedRequest(PREMIERE, 605, null),
      );
      expect(status.state).toBe("pending");

      const pidsPath = path.join(scratchDir, "exiting-orphan-pids.txt");
      const pids = await (async () => {
        for (let attempt = 0; attempt < 400; attempt++) {
          try {
            const raw = await fs.readFile(pidsPath, "utf8");
            const [workerPid, childPid] = raw.trim().split(/\s+/).map(Number);
            if (
              Number.isSafeInteger(workerPid) &&
              Number.isSafeInteger(childPid)
            ) {
              return { workerPid, childPid };
            }
          } catch {
            // Fixture still booting.
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("exiting orphan fixture never reported pids");
      })();
      grandchildPid = pids.childPid;

      await waitUntil(
        () => logs.some((line) => line.includes("exit=17")),
        "ordinary failed-worker completion",
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await waitForPidsDead(
        [pids.workerPid, pids.childPid],
        "ordinary exit group reap",
      );
      await waitUntil(
        () =>
          clips.readStatus({
            premiereId: PREMIERE,
            lifecycleState: "revealed",
            bucket: 60,
          }).state === "absent",
        "ordinary failed-worker release",
      );
      expect(
        clips.readStatus({
          premiereId: PREMIERE,
          lifecycleState: "revealed",
          bucket: 60,
        }).state,
      ).toBe("absent");
    } finally {
      await clips.close();
      if (grandchildPid !== null && (await pidAlive(grandchildPid))) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });
});
