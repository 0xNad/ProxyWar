import express from "express";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs, type StatsFs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AiLeagueRunClips,
  aiLeagueRunClipErrorBody,
  createAiLeagueRunClipDocumentRouter,
  type AiLeagueRunClipsOptions,
} from "../../src/server/agents/AiLeagueRunClips";
import {
  matchProxyWarLeagueClipReadPath,
  matchProxyWarLeagueClipWritePath,
} from "../../src/server/agents/ProxyWarPublicArtifacts";
import { ReplayPremiereClips } from "../../src/server/replay-premiere/ReplayPremiereClips";
import { controlledSourceBytes } from "./replay-premiere/ReplayPremiereFixtures";

const RUN_KEY = "league-coworld-ereq-1234abcd";
const ATTRIBUTION = "Game art from OpenFront (openfront.io), CC BY-SA 4.0.";
const NO_ENDORSEMENT = "Proxy War is an independent fork.";
const CONTROLLED_SOURCE = JSON.parse(
  controlledSourceBytes().toString("utf8"),
) as {
  gameRecord: Record<string, unknown> & { info: Record<string, unknown> };
};
const RECORD_BYTES = Buffer.from(
  JSON.stringify({
    ...CONTROLLED_SOURCE.gameRecord,
    info: {
      ...CONTROLLED_SOURCE.gameRecord.info,
      num_turns: 1_000,
      winner: undefined,
    },
    turns: [],
  }),
);
const RECORD_SHA = createHash("sha256").update(RECORD_BYTES).digest("hex");

type FakeChild = EventEmitter & {
  kill(signal?: string): boolean;
  exitCode: number | null;
};

/** Records every job spec it receives, then completes with a valid clip. */
function capturingSpawn(
  specs: unknown[],
): AiLeagueRunClipsOptions["spawnWorker"] {
  return (jobSpecPath) => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.kill = () => true;
    setImmediate(() => {
      void (async () => {
        try {
          const spec = JSON.parse(await fs.readFile(jobSpecPath, "utf8"));
          specs.push(spec);
          const bytes = Buffer.alloc(96, 5);
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

let root: string;
let runsRoot: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pw-run-clips-"));
  runsRoot = path.join(root, "ai-league-runs");
  await fs.mkdir(path.join(runsRoot, RUN_KEY), { recursive: true });
  await fs.writeFile(
    path.join(runsRoot, RUN_KEY, "game-record.json"),
    RECORD_BYTES,
  );
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function makeRunClips(
  overrides: Partial<AiLeagueRunClipsOptions> = {},
  captured: unknown[] = [],
): AiLeagueRunClips {
  return new AiLeagueRunClips({
    runsRootDir: runsRoot,
    clipsRoot: path.join(root, "league-clips-v1"),
    staticDir: path.join(root, "static"),
    workerModulePath: path.join(root, "worker.ts"),
    publicOrigin: "https://beta.proxywar.xyz",
    licenseStrings: { attribution: ATTRIBUTION, noEndorsement: NO_ENDORSEMENT },
    storageStatePath: path.join(root, "state.json"),
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }) as StatsFs,
    spawnWorker: capturingSpawn(captured),
    ...overrides,
  });
}

async function waitReady(
  clips: AiLeagueRunClips,
  runKey: string,
  bucket: number,
) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await clips.readRunClipStatus({ runKey, bucket });
    if (status.state === "ready") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run clip ${runKey}:${bucket} never became ready`);
}

// ---------------------------------------------------------------------------
// Route matchers
// ---------------------------------------------------------------------------

describe("league clip route matchers", () => {
  test("accepts the exact read/write shapes and flags public league keys", () => {
    expect(
      matchProxyWarLeagueClipReadPath(`/api/league-runs/${RUN_KEY}/clips/60`),
    ).toEqual({
      kind: "clip_status",
      runKey: RUN_KEY,
      bucket: 60,
      publicLeague: true,
    });
    expect(
      matchProxyWarLeagueClipReadPath(
        `/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
      ),
    ).toEqual({
      kind: "clip_file",
      runKey: RUN_KEY,
      bucket: 60,
      publicLeague: true,
    });
    expect(
      matchProxyWarLeagueClipWritePath(`/api/league-runs/${RUN_KEY}/clips`),
    ).toEqual({ kind: "clip_request", runKey: RUN_KEY, publicLeague: true });
    // Non-mirror keys match but are NOT public-league (beta-session only).
    expect(
      matchProxyWarLeagueClipWritePath("/api/league-runs/local-run-1/clips"),
    ).toEqual({
      kind: "clip_request",
      runKey: "local-run-1",
      publicLeague: false,
    });
  });

  test("rejects traversal and malformed grammar", () => {
    for (const bad of [
      "/api/league-runs/../clips",
      "/api/league-runs/..%2Fsecret/clips",
      "/api/league-runs/a/b/clips",
      `/api/league-runs/${RUN_KEY}/clips/007`,
      `/api/league-runs/${RUN_KEY}/clips/-1`,
      `/ai-league-runs/${RUN_KEY}/clip-v2-60.mp4`,
      "/ai-league-runs/../clip-v1-60.mp4",
      `/ai-league-runs/${RUN_KEY}/game-record.json`,
    ]) {
      expect(matchProxyWarLeagueClipReadPath(bad)).toBeNull();
      expect(matchProxyWarLeagueClipWritePath(bad)).toBeNull();
    }
    // ".." alone is regex-charset-legal but rejected as a path segment.
    expect(
      matchProxyWarLeagueClipReadPath("/api/league-runs/../clips/60"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

describe("AiLeagueRunClips", () => {
  test("canary scope rejects every other run, bucket, source, and expired read before quota or spawn", async () => {
    const captured: unknown[] = [];
    let now = Date.parse("2026-07-23T20:00:00.000Z");
    const clips = makeRunClips(
      {
        now: () => now,
        limits: { maxRendersPerPremierePerDay: 1 },
        canaryScope: {
          runKey: RUN_KEY,
          bucket: 60,
          sourceReplaySha256: RECORD_SHA,
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
          isAuthorized: () => true,
        },
      },
      captured,
    );
    const otherRun = "league-coworld-other-canary";
    await fs.mkdir(path.join(runsRoot, otherRun), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, otherRun, "game-record.json"),
      RECORD_BYTES,
    );

    await expect(
      clips.requestRunClip({ runKey: otherRun, anchorTurn: 605 }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "league_clip_canary_scope_refused",
    });
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 705 }),
    ).rejects.toMatchObject({
      operatorCode: "league_clip_canary_scope_refused",
    });
    await expect(
      clips.readRunClipStatus({ runKey: RUN_KEY, bucket: 70 }),
    ).rejects.toMatchObject({
      operatorCode: "league_clip_canary_scope_refused",
    });
    expect(
      await clips.resolveRunClipFile({ runKey: otherRun, bucket: 60 }),
    ).toBeNull();
    expect(captured).toHaveLength(0);

    expect(
      (await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 })).state,
    ).toBe("pending");
    await waitReady(clips, RUN_KEY, 60);
    expect(captured).toHaveLength(1);

    now += 10 * 60_000;
    await expect(
      clips.readRunClipStatus({ runKey: RUN_KEY, bucket: 60 }),
    ).rejects.toMatchObject({
      operatorCode: "league_clip_canary_scope_refused",
    });
    expect(
      await clips.resolveRunClipFile({ runKey: RUN_KEY, bucket: 60 }),
    ).toBeNull();
    await clips.close();
  });

  test("armed or failed-claim authorization cannot read cached bytes or enqueue, while claimed restart only reads", async () => {
    const seedCaptured: unknown[] = [];
    const seed = makeRunClips({}, seedCaptured);
    await seed.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitReady(seed, RUN_KEY, 60);
    await seed.close();
    expect(seedCaptured).toHaveLength(1);

    let authorized = false;
    const postRestartSpawns: unknown[] = [];
    const scoped = makeRunClips(
      {
        canaryScope: {
          runKey: RUN_KEY,
          bucket: 60,
          sourceReplaySha256: RECORD_SHA,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          isAuthorized: () => authorized,
        },
      },
      postRestartSpawns,
    );
    await scoped.rebuildIndex();

    // Armed startup still needs source/range/SHA validation before claim.
    await expect(
      scoped.resolveRetainedRunSource(RUN_KEY),
    ).resolves.toMatchObject({
      sourceReplaySha256: RECORD_SHA,
      renderableThroughTurn: 1_000,
    });
    // But a failed/unreached claim leaves every action and cached read closed.
    expect(scoped.allowsCanaryRead(RUN_KEY, 60)).toBe(false);
    await expect(
      scoped.readRunClipStatus({ runKey: RUN_KEY, bucket: 60 }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "league_clip_canary_scope_refused",
    });
    await expect(
      scoped.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "league_clip_canary_scope_refused",
    });
    expect(
      await scoped.resolveRunClipFile({ runKey: RUN_KEY, bucket: 60 }),
    ).toBeNull();
    const baseUrl = await documentHarness(scoped);
    expect(
      (await fetch(`${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`))
        .status,
    ).toBe(404);
    expect(postRestartSpawns).toHaveLength(0);

    // A claimed restart initializes authorization true. Rebuild/read serves
    // the exact existing cache but never calls requestRunClip or spawns.
    authorized = true;
    expect(scoped.allowsCanaryRead(RUN_KEY, 60)).toBe(true);
    expect(
      (await scoped.readRunClipStatus({ runKey: RUN_KEY, bucket: 60 })).state,
    ).toBe("ready");
    const claimedFile = await scoped.resolveRunClipFile({
      runKey: RUN_KEY,
      bucket: 60,
    });
    expect(claimedFile).toMatchObject({ byteLength: 96 });
    await claimedFile?.fileHandle.close();
    const claimedRead = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
    );
    expect(claimedRead.status).toBe(200);
    expect(claimedRead.headers.get("cache-control")).toBe(
      "no-store, max-age=0",
    );
    expect(postRestartSpawns).toHaveLength(0);
    await scoped.close();
  });

  test("renders a clip from the run's game-record.json and serves run-shaped urls", async () => {
    const captured: unknown[] = [];
    const clips = makeRunClips({}, captured);
    const first = await clips.requestRunClip({
      runKey: RUN_KEY,
      anchorTurn: 605,
    });
    expect(first.state).toBe("pending");
    expect(first).not.toHaveProperty("pending");
    const ready = await waitReady(clips, RUN_KEY, 60);
    expect(ready).not.toHaveProperty("pending");
    await expect(
      clips.readRunClipStatus({
        runKey: RUN_KEY,
        bucket: 60,
        includeProgress: true,
      }),
    ).resolves.toMatchObject({ state: "ready", pending: null });
    expect(ready.ready?.clipUrl).toBe(
      `/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
    );
    // The social reply points at the ordinary league replay page.
    expect(ready.ready?.social.firstReply).toContain(
      `https://beta.proxywar.xyz/ai-league-replay/${RUN_KEY}`,
    );
    // The worker rendered from the run's record, hash-pinned to its bytes.
    const spec = captured[0] as {
      premiereId: string;
      bundlePath: string;
      expectedBundleSha256: string;
    };
    expect(spec.premiereId).toBe(RUN_KEY);
    expect(spec.bundlePath).toBe(
      path.join(runsRoot, RUN_KEY, "game-record.json"),
    );
    expect(spec.expectedBundleSha256).toBe(RECORD_SHA);
    await clips.close();
  });

  test("404s a run whose replay bundle is absent (aged-off retention)", async () => {
    const clips = makeRunClips();
    await expect(
      clips.requestRunClip({ runKey: "league-gone-run", anchorTurn: 605 }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "league_clip_replay_absent",
    });
    // The refused request consumed no render quota: a valid one still admits.
    expect(
      (await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 })).state,
    ).toBe("pending");
    await clips.close();
  });

  test("invalidates a cached bucket when the retained replay bytes change", async () => {
    const captured: unknown[] = [];
    const clips = makeRunClips({}, captured);
    await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitReady(clips, RUN_KEY, 60);

    const replacement = Buffer.from(
      JSON.stringify({
        ...CONTROLLED_SOURCE.gameRecord,
        gitCommit: "b".repeat(40),
        info: {
          ...CONTROLLED_SOURCE.gameRecord.info,
          num_turns: 1_200,
          winner: undefined,
        },
        turns: [],
      }),
    );
    const replacementSha = createHash("sha256")
      .update(replacement)
      .digest("hex");
    await fs.writeFile(
      path.join(runsRoot, RUN_KEY, "game-record.json"),
      replacement,
    );

    // The run key and bucket are unchanged, but the immutable source is not.
    // Neither status nor the document route may serve the stale artifact.
    expect(
      (await clips.readRunClipStatus({ runKey: RUN_KEY, bucket: 60 })).state,
    ).toBe("absent");
    expect(
      await clips.resolveRunClipFile({ runKey: RUN_KEY, bucket: 60 }),
    ).toBeNull();

    expect(
      (await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 })).state,
    ).toBe("pending");
    await waitReady(clips, RUN_KEY, 60);
    expect(captured).toHaveLength(2);
    expect(
      (captured[1] as { expectedBundleSha256: string }).expectedBundleSha256,
    ).toBe(replacementSha);
    await clips.close();
  });

  test("rejects anchors outside the retained replay's supported range", async () => {
    const clips = makeRunClips();
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 1_001 }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      operatorCode: "clip_anchor_outside_retained_range",
    });
    await clips.close();
  });

  test("rejects symlinked, malformed, and compacted sources before quota admission", async () => {
    const clips = makeRunClips({
      limits: { maxRendersPerPremierePerDay: 1 },
    });
    const recordPath = path.join(runsRoot, RUN_KEY, "game-record.json");
    const outsidePath = path.join(root, "outside-game-record.json");
    await fs.writeFile(outsidePath, RECORD_BYTES);
    await fs.rm(recordPath);
    await fs.symlink(outsidePath, recordPath);
    expect(await clips.resolveRetainedRunSource(RUN_KEY)).toBeNull();
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "league_clip_replay_absent",
    });

    await fs.rm(recordPath);
    await fs.writeFile(recordPath, Buffer.from("not-json"));
    expect(await clips.resolveRetainedRunSource(RUN_KEY)).toBeNull();
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 }),
    ).rejects.toMatchObject({ httpStatus: 404 });

    await fs.writeFile(
      recordPath,
      JSON.stringify({
        compacted: true,
        info: { num_turns: 1_000 },
        turns: [],
      }),
    );
    expect(await clips.resolveRetainedRunSource(RUN_KEY)).toBeNull();
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 }),
    ).rejects.toMatchObject({ httpStatus: 404 });

    // All three refusals precede admission; the one-render daily allowance is
    // still available after a valid retained artifact is restored.
    await fs.writeFile(recordPath, RECORD_BYTES);
    expect(
      (await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 })).state,
    ).toBe("pending");
    await clips.close();
  });

  test("rejects a schema-invalid retained record before quota or worker spawn", async () => {
    const captured: unknown[] = [];
    const clips = makeRunClips(
      { limits: { maxRendersPerPremierePerDay: 1 } },
      captured,
    );
    const recordPath = path.join(runsRoot, RUN_KEY, "game-record.json");
    // Superficially render-shaped, but not a canonical GameRecord: it lacks
    // the full analytics/start/config/player contract the replay client uses.
    await fs.writeFile(
      recordPath,
      JSON.stringify({ info: { num_turns: 1_000 }, turns: [] }),
    );
    expect(await clips.resolveRetainedRunSource(RUN_KEY)).toBeNull();
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      operatorCode: "league_clip_replay_absent",
    });
    expect(captured).toHaveLength(0);

    // The refusal consumed neither the one-render quota nor a worker slot.
    await fs.writeFile(recordPath, RECORD_BYTES);
    expect(
      (await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 })).state,
    ).toBe("pending");
    await waitReady(clips, RUN_KEY, 60);
    expect(captured).toHaveLength(1);
    await clips.close();
  });

  test("enforces per-participant quota across distinct archived replay buckets", async () => {
    const clips = makeRunClips({
      limits: {
        maxQueueDepth: 8,
        maxRendersPerParticipantPerPremiere: 3,
      },
    });
    for (const anchorTurn of [605, 705, 805]) {
      expect(
        (
          await clips.requestRunClip({
            runKey: RUN_KEY,
            anchorTurn,
            participantId: "opaque-requester-bucket",
          })
        ).state,
      ).toBe("pending");
    }
    await expect(
      clips.requestRunClip({
        runKey: RUN_KEY,
        anchorTurn: 905,
        participantId: "opaque-requester-bucket",
      }),
    ).rejects.toMatchObject({
      httpStatus: 429,
      operatorCode: "clip_participant_quota_exceeded",
    });
    await clips.close();
  });

  test("rejects malformed run keys and anchors before touching disk", async () => {
    const clips = makeRunClips();
    for (const runKey of ["..", "a/b", "a\\b", "", "x".repeat(181)]) {
      await expect(
        clips.requestRunClip({ runKey, anchorTurn: 605 }),
      ).rejects.toMatchObject({ httpStatus: 400 });
    }
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: -1 }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      operatorCode: "league_clip_anchor_invalid",
    });
    await expect(
      clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 2_000_000 }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await clips.close();
  });

  test("never collides with the premiere clip cache, even for the same id", async () => {
    // Same id string cached by BOTH services: separate trees, separate keys.
    const sharedId = "league-coworld-shared01";
    await fs.mkdir(path.join(runsRoot, sharedId), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, sharedId, "game-record.json"),
      RECORD_BYTES,
    );
    const runClips = makeRunClips();
    const premiereClips = new ReplayPremiereClips({
      clipsRoot: path.join(root, "clips-v1"),
      sourceBundleRoot: root,
      staticDir: path.join(root, "static"),
      workerModulePath: path.join(root, "worker.ts"),
      publicOrigin: "https://beta.proxywar.xyz",
      licenseStrings: {
        attribution: ATTRIBUTION,
        noEndorsement: NO_ENDORSEMENT,
      },
      storageStatePath: path.join(root, "state.json"),
      statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }) as StatsFs,
      spawnWorker: capturingSpawn([]),
    });

    await runClips.requestRunClip({ runKey: sharedId, anchorTurn: 605 });
    await waitReady(runClips, sharedId, 60);

    // The run clip landed in league-clips-v1, not the premiere tree.
    await fs.stat(
      path.join(root, "league-clips-v1", sharedId, "clip-v1-60.mp4"),
    );
    await expect(
      fs.stat(path.join(root, "clips-v1", sharedId, "clip-v1-60.mp4")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The premiere service (its own tree) sees nothing for that id...
    await premiereClips.rebuildIndex();
    expect(
      premiereClips.readStatus({
        premiereId: sharedId,
        lifecycleState: "revealed",
        bucket: 60,
        sourceReplaySha256: RECORD_SHA,
      }).state,
    ).toBe("absent");
    // ...and the run service still serves it after ITS index rebuild.
    await runClips.rebuildIndex();
    expect(
      (await runClips.readRunClipStatus({ runKey: sharedId, bucket: 60 }))
        .state,
    ).toBe("ready");
    await runClips.close();
    await premiereClips.close();
  });

  test("repairs every archive-relevant run beyond 256 unrelated cache ids", async () => {
    const seed = makeRunClips();
    await seed.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitReady(seed, RUN_KEY, 60);
    await seed.close();

    const cacheRoot = path.join(root, "league-clips-v1");
    const unrelatedBytes = Buffer.from("unrelated-cache-entry");
    const unrelatedSha = createHash("sha256")
      .update(unrelatedBytes)
      .digest("hex");
    // These ids sort before RUN_KEY and reproduce the old lexical slice(0,256)
    // starvation. Their ready callbacks must not run.
    for (let index = 0; index < 257; index++) {
      const runKey = `aaa-unrelated-${String(index).padStart(3, "0")}`;
      const directory = path.join(cacheRoot, runKey);
      await fs.mkdir(directory, { recursive: true });
      const clipPath = path.join(directory, "clip-v1-60.mp4");
      await fs.writeFile(clipPath, unrelatedBytes);
      await fs.writeFile(
        clipPath.replace(/\.mp4$/, ".render-manifest.json"),
        JSON.stringify({
          premiereId: runKey,
          sourceReplaySha256: RECORD_SHA,
          anchorTurn: 605,
          clipVersion: 1,
          frameShape: "square",
          frameWidth: 1080,
          frameHeight: 1080,
          outSha256: unrelatedSha,
          outBytes: unrelatedBytes.byteLength,
          generatedAt: "2026-07-23T20:00:00.000Z",
        }),
      );
    }
    // A higher stale-source bucket for the relevant run must not suppress its
    // lower current-source bucket during best-artifact selection.
    const staleBytes = Buffer.from("stale-relevant-source");
    const stalePath = path.join(cacheRoot, RUN_KEY, "clip-v1-70.mp4");
    await fs.writeFile(stalePath, staleBytes);
    await fs.writeFile(
      stalePath.replace(/\.mp4$/, ".render-manifest.json"),
      JSON.stringify({
        premiereId: RUN_KEY,
        sourceReplaySha256: "a".repeat(64),
        anchorTurn: 705,
        clipVersion: 1,
        frameShape: "square",
        frameWidth: 1080,
        frameHeight: 1080,
        outSha256: createHash("sha256").update(staleBytes).digest("hex"),
        outBytes: staleBytes.byteLength,
        generatedAt: "2026-07-23T20:00:00.000Z",
      }),
    );

    const repaired: Array<{ runKey: string; bucket: number }> = [];
    const restarted = makeRunClips({
      shouldRepairRunClipOnIndexRebuild: (runKey) => runKey === RUN_KEY,
      onRunClipReady: (ready) => {
        repaired.push({ runKey: ready.runKey, bucket: ready.bucket });
      },
    });
    await restarted.rebuildIndex();
    expect(repaired).toEqual([{ runKey: RUN_KEY, bucket: 60 }]);
    await restarted.close();
  });

  test("maps service errors to the public league clip error body", () => {
    expect(aiLeagueRunClipErrorBody(new Error("boom"))).toEqual({
      status: 503,
      body: { error: { code: "LEAGUE_CLIP_UNAVAILABLE" } },
    });
  });

  test("admits the first render on a FRESH cache tree with a REAL disk-floor probe", async () => {
    // Regression (found live): the render-admission disk floor statfs's the
    // cache root, which used to not exist until the first promote — so every
    // render on a fresh tree 503'd clip_disk_floor_unreadable forever.
    // rebuildIndex now creates the root; use the real statfs (no injection)
    // with a tiny floor so the probe itself is exercised.
    const clips = makeRunClips({
      statfs: undefined,
      limits: { minFreeBytes: 1 },
    });
    await clips.rebuildIndex();
    expect(
      (await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 })).state,
    ).toBe("pending");
    await clips.close();
  });
});

// ---------------------------------------------------------------------------
// mp4 document router
// ---------------------------------------------------------------------------

async function documentHarness(runClips: AiLeagueRunClips): Promise<string> {
  const app = express();
  app.use(createAiLeagueRunClipDocumentRouter({ runClips }));
  app.use((_request, response) => {
    response.status(404).json({ error: { code: "DOWNSTREAM_HANDLED" } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("createAiLeagueRunClipDocumentRouter", () => {
  test("serves a cached run clip (GET + HEAD) and 404s absent buckets", async () => {
    const clips = makeRunClips();
    await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitReady(clips, RUN_KEY, 60);
    const baseUrl = await documentHarness(clips);

    const response = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect((await response.arrayBuffer()).byteLength).toBe(96);

    const head = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("96");

    const absent = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-70.mp4`,
    );
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({
      error: { code: "LEAGUE_CLIP_UNAVAILABLE" },
    });
    await clips.close();
  });

  test("streams the pinned inode after a post-hash path swap and closes GET/HEAD handles", async () => {
    const clips = makeRunClips();
    await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitReady(clips, RUN_KEY, 60);
    const clipPath = path.join(
      root,
      "league-clips-v1",
      RUN_KEY,
      "clip-v1-60.mp4",
    );
    const replacement = Buffer.alloc(96, 9);
    const originalResolve = clips.resolveRunClipFile.bind(clips);
    const closeCounts: number[] = [];
    let resolveCount = 0;
    clips.resolveRunClipFile = async (request) => {
      const file = await originalResolve(request);
      if (file === null) return null;
      const closeIndex = closeCounts.push(0) - 1;
      const originalClose = file.fileHandle.close.bind(file.fileHandle);
      file.fileHandle.close = async () => {
        closeCounts[closeIndex] += 1;
        await originalClose();
      };
      resolveCount += 1;
      if (resolveCount === 2) {
        await fs.rename(clipPath, `${clipPath}.validated`);
        await fs.writeFile(clipPath, replacement);
      }
      return file;
    };
    const baseUrl = await documentHarness(clips);

    const head = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(closeCounts[0]).toBe(1);

    const get = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
    );
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(Buffer.alloc(96, 5));
    expect(await fs.readFile(clipPath)).toEqual(replacement);
    expect(closeCounts[1]).toBe(1);
    await clips.close();
  });

  test("passes ordinary run-artifact paths through untouched", async () => {
    const clips = makeRunClips();
    const baseUrl = await documentHarness(clips);
    const response = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/game-record.json`,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("DOWNSTREAM_HANDLED");
    await clips.close();
  });

  test("rejects range requests and non-GET methods on the clip route", async () => {
    const clips = makeRunClips();
    await clips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitReady(clips, RUN_KEY, 60);
    const baseUrl = await documentHarness(clips);
    const range = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
      { headers: { Range: "bytes=0-3" } },
    );
    expect(range.status).toBe(416);
    const post = await fetch(
      `${baseUrl}/ai-league-runs/${RUN_KEY}/clip-v1-60.mp4`,
      { method: "POST" },
    );
    expect(post.status).toBe(405);
    await clips.close();
  });
});
