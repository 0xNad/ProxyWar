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

const RUN_KEY = "league-coworld-ereq-1234abcd";
const ATTRIBUTION = "Game art from OpenFront (openfront.io), CC BY-SA 4.0.";
const NO_ENDORSEMENT = "Proxy War is an independent fork.";
const RECORD_BYTES = Buffer.from(
  JSON.stringify({ info: { gitCommit: "test" }, turns: [] }),
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
    const status = clips.readRunClipStatus({ runKey, bucket });
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
  test("renders a clip from the run's game-record.json and serves run-shaped urls", async () => {
    const captured: unknown[] = [];
    const clips = makeRunClips({}, captured);
    const first = await clips.requestRunClip({
      runKey: RUN_KEY,
      anchorTurn: 605,
    });
    expect(first.state).toBe("pending");
    const ready = await waitReady(clips, RUN_KEY, 60);
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
      }).state,
    ).toBe("absent");
    // ...and the run service still serves it after ITS index rebuild.
    await runClips.rebuildIndex();
    expect(
      runClips.readRunClipStatus({ runKey: sharedId, bucket: 60 }).state,
    ).toBe("ready");
    await runClips.close();
    await premiereClips.close();
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
