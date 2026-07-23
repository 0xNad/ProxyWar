import express from "express";
import { EventEmitter } from "node:events";
import { promises as fs, type StatsFs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiLeagueRunClips,
  type AiLeagueRunClipsOptions,
} from "../../../src/server/agents/AiLeagueRunClips";
import { proxyWarLeagueContentSecurityPolicy } from "../../../src/server/agents/ProxyWarPublicArtifacts";
import { ReplayPremiereArchivedClipPromoter } from "../../../src/server/replay-premiere/ReplayPremiereArchivedClipPromoter";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { createReplayPremiereArchiveRouter } from "../../../src/server/replay-premiere/ReplayPremiereArchiveRouter";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { buildPremiereResultSummary } from "../../../src/server/replay-premiere/ReplayPremiereResultSummary";
import { controlledSourceBytes } from "./ReplayPremiereFixtures";

const PREMIERE_ID = "prem_leaguearchive0001";
const SECOND_PREMIERE_ID = "prem_leaguearchive0002";
const FAILED_ID = "prem_leaguearchivefail1";
const CANCELLED_ID = "prem_leaguearchivecan01";
const UNREVEALED_ID = "prem_leaguearchivenr001";
const OTHER_RUN_ID = "prem_leaguearchiveoth01";
const SOURCE_RUN_ID = "coworld-archive-001";
const RUN_KEY = `league-${SOURCE_RUN_ID}`;
const RECORD_SOURCE = JSON.parse(controlledSourceBytes().toString("utf8")) as {
  gameRecord: Record<string, unknown> & { info: Record<string, unknown> };
};
const RECORD_BYTES = Buffer.from(
  JSON.stringify({
    ...RECORD_SOURCE.gameRecord,
    info: {
      ...RECORD_SOURCE.gameRecord.info,
      num_turns: 1_000,
      winner: undefined,
    },
    turns: [],
  }),
);
const RECORD_SHA = sha256Hex(RECORD_BYTES);
const ORIGINAL_ADMISSION_SHA = sha256Hex("original-admission-replay-bundle");
const APP_SHELL =
  '<!doctype html><html><head><title>Proxy War</title></head><body><main id="app"></main></body></html>';

type FakeChild = EventEmitter & {
  kill(signal?: string): boolean;
  exitCode: number | null;
};

let root: string;
let runsRoot: string;
let store: ReplayPremiereArchiveStore;
let promoter: ReplayPremiereArchivedClipPromoter;
const services: AiLeagueRunClips[] = [];
const servers: http.Server[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pw-archive-promote-"));
  runsRoot = path.join(root, "ai-league-runs");
  await fs.mkdir(path.join(runsRoot, RUN_KEY), { recursive: true });
  await fs.writeFile(
    path.join(runsRoot, RUN_KEY, "game-record.json"),
    RECORD_BYTES,
  );
  store = await ReplayPremiereArchiveStore.open({ privateStateRoot: root });
  promoter = new ReplayPremiereArchivedClipPromoter({
    privateStateRoot: root,
    archiveStore: store,
  });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await fs.rm(root, { recursive: true, force: true });
});

function workerThatRenders(
  bytes: Buffer,
): AiLeagueRunClipsOptions["spawnWorker"] {
  return (jobSpecPath) => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.kill = () => true;
    setImmediate(() => {
      void (async () => {
        try {
          const spec = JSON.parse(await fs.readFile(jobSpecPath, "utf8"));
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
              outSha256: sha256Hex(bytes),
              outBytes: bytes.byteLength,
              generatedAt: "2026-07-23T12:00:00.000Z",
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

function makeRunClips(
  options: {
    callback?: boolean;
    clipBytes?: Buffer;
  } = {},
): AiLeagueRunClips {
  const service = new AiLeagueRunClips({
    runsRootDir: runsRoot,
    clipsRoot: path.join(root, "league-clips-v1"),
    staticDir: path.join(root, "static"),
    workerModulePath: path.join(root, "worker.ts"),
    publicOrigin: "https://beta.proxywar.xyz",
    licenseStrings: { attribution: "attribution", noEndorsement: "fork" },
    storageStatePath: path.join(root, "state.json"),
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }) as StatsFs,
    spawnWorker: workerThatRenders(
      options.clipBytes ?? Buffer.from("ready-league-clip"),
    ),
    onRunClipReady:
      options.callback === false
        ? undefined
        : async (ready) => {
            await promoter.promoteRatedCoworldRunClip(ready);
          },
    shouldRepairRunClipOnIndexRebuild: () => true,
  });
  services.push(service);
  return service;
}

async function archivePointer(
  options: {
    premiereId?: string;
    sourceRunId?: string;
    terminalState?: "revealed" | "archived" | "failed" | "cancelled";
    revealedAt?: string | null;
  } = {},
) {
  const premiereId = options.premiereId ?? PREMIERE_ID;
  const terminalState = options.terminalState ?? "revealed";
  const revealedAt =
    options.revealedAt === undefined
      ? terminalState === "revealed" || terminalState === "archived"
        ? "2026-07-23T11:00:00.000Z"
        : null
      : options.revealedAt;
  return await store.recordReclaimed(
    buildPremiereResultSummary({
      premiereId,
      sourceRunId: options.sourceRunId ?? SOURCE_RUN_ID,
      sourceKind: "rated_coworld",
      publicationCommitmentHash: sha256Hex(`commitment:${premiereId}`),
      terminalState,
      revealedAt,
      reclaimedAt: "2026-07-23T11:45:00.000Z",
      outcome:
        revealedAt === null
          ? null
          : {
              winner: {
                category: "player",
                groupLabel: null,
                seatIds: ["SEAT0001"],
              },
              turnCount: 1_000,
              completedAt: "2026-07-23T11:00:00.000Z",
              standings: [
                { seatId: "SEAT0001", displayName: "Alpha", won: true },
              ],
            },
      predictions: [],
      markers: [],
    }),
    ORIGINAL_ADMISSION_SHA,
  );
}

const archivedClipPath = (premiereId = PREMIERE_ID): string =>
  path.join(root, "archive-v1", "clips", `${premiereId}.mp4`);
const archivedManifestPath = (premiereId = PREMIERE_ID): string =>
  path.join(root, "archive-v1", "clips", `${premiereId}.render-manifest.json`);

async function exists(filePath: string): Promise<boolean> {
  return (await fs.lstat(filePath).catch(() => null)) !== null;
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await fs.lstat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`file never appeared: ${filePath}`);
}

async function archiveServer(): Promise<string> {
  const app = express();
  app.use(
    createReplayPremiereArchiveRouter({
      registry: { get: () => null },
      archiveStore: store,
      loadAppShell: async () => APP_SHELL,
      publicOrigin: "https://beta.proxywar.xyz",
      pageContentSecurityPolicy: proxyWarLeagueContentSecurityPolicy(),
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("archive test server did not bind");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function writeCachedArtifact(
  options: {
    bucket?: number;
    bytes?: Buffer;
    manifestRunKey?: string;
    manifestSourceSha?: string;
  } = {},
): Promise<{ bucket: number; bytes: Buffer }> {
  const bucket = options.bucket ?? 60;
  const bytes = options.bytes ?? Buffer.from("manually-ready-league-clip");
  const directory = path.join(root, "league-clips-v1", RUN_KEY);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `clip-v1-${bucket}.mp4`), bytes);
  await fs.writeFile(
    path.join(directory, `clip-v1-${bucket}.render-manifest.json`),
    JSON.stringify({
      premiereId: options.manifestRunKey ?? RUN_KEY,
      sourceReplaySha256: options.manifestSourceSha ?? RECORD_SHA,
      anchorTurn: bucket * 10 + 5,
      clipVersion: 1,
      frameShape: "square",
      frameWidth: 1080,
      frameHeight: 1080,
      outSha256: sha256Hex(bytes),
      outBytes: bytes.byteLength,
      generatedAt: "2026-07-23T12:00:00.000Z",
    }),
  );
  return { bucket, bytes };
}

async function writePremiereCachedArtifact(
  premiereId: string,
  bytes: Buffer,
): Promise<void> {
  const directory = path.join(root, "clips-v1", premiereId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "clip-v1-60.mp4"), bytes);
  await fs.writeFile(
    path.join(directory, "clip-v1-60.render-manifest.json"),
    JSON.stringify({
      premiereId,
      sourceReplaySha256: ORIGINAL_ADMISSION_SHA,
      anchorTurn: 605,
      clipVersion: 1,
      frameShape: "square",
      frameWidth: 1080,
      frameHeight: 1080,
      outSha256: sha256Hex(bytes),
      outBytes: bytes.byteLength,
      generatedAt: "2026-07-23T12:00:00.000Z",
    }),
  );
}

describe("ReplayPremiereArchivedClipPromoter", () => {
  it("promotes on league render completion without status polling and serves the reclaimed archive", async () => {
    const pointer = await archivePointer();
    expect(pointer.sourceReplaySha256).toBe(ORIGINAL_ADMISSION_SHA);
    expect(pointer.sourceReplaySha256).not.toBe(RECORD_SHA);
    const clipBytes = Buffer.from("callback-promoted-league-clip");
    const runClips = makeRunClips({ clipBytes });

    // The only client-shaped action is the render request. No status read is
    // needed: the ready callback performs durable promotion server-side.
    expect(
      (await runClips.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 }))
        .state,
    ).toBe("pending");
    await waitForFile(archivedClipPath());

    const durableManifest = JSON.parse(
      await fs.readFile(archivedManifestPath(), "utf8"),
    );
    expect(durableManifest.premiereId).toBe(RUN_KEY);
    expect(durableManifest.sourceReplaySha256).toBe(RECORD_SHA);
    expect(await fs.readFile(archivedClipPath())).toEqual(clipBytes);

    const baseUrl = await archiveServer();
    const clipResponse = await fetch(
      `${baseUrl}/premiere/${PREMIERE_ID}/clip.mp4`,
    );
    expect(clipResponse.status).toBe(200);
    expect(Buffer.from(await clipResponse.arrayBuffer())).toEqual(clipBytes);
    const pageResponse = await fetch(`${baseUrl}/premiere/${PREMIERE_ID}`);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain(
      `"url":"/premiere/${PREMIERE_ID}/clip.mp4"`,
    );
  });

  it("repairs the cache-ready crash window during bounded index rebuild", async () => {
    await archivePointer();
    const first = makeRunClips({ callback: false });
    await first.rebuildIndex();
    await first.requestRunClip({ runKey: RUN_KEY, anchorTurn: 605 });
    await waitForFile(
      path.join(root, "league-clips-v1", RUN_KEY, "clip-v1-60.mp4"),
    );
    await first.close();
    services.splice(services.indexOf(first), 1);
    expect(await fs.lstat(archivedClipPath()).catch(() => null)).toBeNull();

    const restarted = makeRunClips();
    await restarted.rebuildIndex();
    expect(await fs.readFile(archivedClipPath())).toEqual(
      Buffer.from("ready-league-clip"),
    );
  });

  it("fails closed for wrong run/hash, non-public terminals, symlinks, and missing sources", async () => {
    await archivePointer({
      premiereId: OTHER_RUN_ID,
      sourceRunId: "coworld-other-run",
    });
    await archivePointer({
      premiereId: FAILED_ID,
      terminalState: "failed",
    });
    await archivePointer({
      premiereId: CANCELLED_ID,
      terminalState: "cancelled",
    });
    await archivePointer({
      premiereId: UNREVEALED_ID,
      terminalState: "archived",
      revealedAt: null,
    });
    const artifact = await writeCachedArtifact();
    const sourceFilePath = path.join(runsRoot, RUN_KEY, "game-record.json");

    // None of the indexed pointers is both run-bound and reveal-public.
    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: artifact.bucket,
        sourceReplaySha256: RECORD_SHA,
        sourceFilePath,
      }),
    ).toBe(0);
    for (const id of [OTHER_RUN_ID, FAILED_ID, CANCELLED_ID, UNREVEALED_ID]) {
      expect(await fs.lstat(archivedClipPath(id)).catch(() => null)).toBeNull();
    }

    await archivePointer();
    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: artifact.bucket,
        sourceReplaySha256: sha256Hex("wrong-league-source"),
        sourceFilePath,
      }),
    ).toBe(0);

    const outside = path.join(root, "outside.mp4");
    await fs.writeFile(outside, artifact.bytes);
    const cachedClip = path.join(
      root,
      "league-clips-v1",
      RUN_KEY,
      "clip-v1-60.mp4",
    );
    await fs.unlink(cachedClip);
    await fs.symlink(outside, cachedClip);
    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: artifact.bucket,
        sourceReplaySha256: RECORD_SHA,
        sourceFilePath,
      }),
    ).toBe(0);

    await fs.unlink(cachedClip);
    await fs.writeFile(cachedClip, artifact.bytes);
    await fs.unlink(sourceFilePath);
    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: artifact.bucket,
        sourceReplaySha256: RECORD_SHA,
        sourceFilePath,
      }),
    ).toBe(0);
    expect(await fs.lstat(archivedClipPath()).catch(() => null)).toBeNull();
  });

  it("keeps the shared provenance manifest when a competing promoter commits the MP4", async () => {
    await archivePointer();
    const artifact = await writeCachedArtifact();
    const sourceFilePath = path.join(runsRoot, RUN_KEY, "game-record.json");
    let releaseFirst!: () => void;
    let firstReachedCommit!: () => void;
    const firstAtCommit = new Promise<void>((resolve) => {
      firstReachedCommit = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstPromoter = new ReplayPremiereArchivedClipPromoter({
      privateStateRoot: root,
      archiveStore: store,
      beforeDurableClipCommit: async () => {
        firstReachedCommit();
        await release;
      },
    });
    const secondPromoter = new ReplayPremiereArchivedClipPromoter({
      privateStateRoot: root,
      archiveStore: store,
    });
    const request = {
      runKey: RUN_KEY,
      bucket: artifact.bucket,
      sourceReplaySha256: RECORD_SHA,
      sourceFilePath,
    };

    const first = firstPromoter.promoteRatedCoworldRunClip(request);
    await firstAtCommit;
    expect(await secondPromoter.promoteRatedCoworldRunClip(request)).toBe(1);
    releaseFirst();
    expect(await first).toBe(0);

    expect(await fs.readFile(archivedClipPath())).toEqual(artifact.bytes);
    expect(
      JSON.parse(await fs.readFile(archivedManifestPath(), "utf8")),
    ).toMatchObject({
      premiereId: RUN_KEY,
      sourceReplaySha256: RECORD_SHA,
      outSha256: sha256Hex(artifact.bytes),
    });
  });

  it("removes bounded stale regular temp hardlinks but never follows temp symlinks", async () => {
    await archivePointer();
    const artifact = await writeCachedArtifact();
    const clipsDir = path.join(root, "archive-v1", "clips");
    await fs.mkdir(clipsDir, { recursive: true });
    const oldClipTemp = path.join(
      clipsDir,
      `.${PREMIERE_ID}.00000000-0000-4000-8000-000000000001.mp4.tmp`,
    );
    const oldManifestTemp = path.join(
      clipsDir,
      `.${PREMIERE_ID}.00000000-0000-4000-8000-000000000002.manifest.tmp`,
    );
    const symlinkTemp = path.join(
      clipsDir,
      `.${PREMIERE_ID}.00000000-0000-4000-8000-000000000003.mp4.tmp`,
    );
    const malformedTemp = path.join(clipsDir, ".not-a-promoter-file.mp4.tmp");
    await fs.writeFile(oldClipTemp, Buffer.alloc(1024 * 1024, 7));
    await fs.writeFile(oldManifestTemp, Buffer.from("orphan-manifest"));
    await fs.writeFile(malformedTemp, Buffer.from("unowned"));
    await fs.symlink(malformedTemp, symlinkTemp);
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(oldClipTemp, old, old);
    await fs.utimes(oldManifestTemp, old, old);

    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: artifact.bucket,
        sourceReplaySha256: RECORD_SHA,
        sourceFilePath: path.join(runsRoot, RUN_KEY, "game-record.json"),
      }),
    ).toBe(1);
    expect(await fs.lstat(oldClipTemp).catch(() => null)).toBeNull();
    expect(await fs.lstat(oldManifestTemp).catch(() => null)).toBeNull();
    expect((await fs.lstat(symlinkTemp)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(malformedTemp)).isFile()).toBe(true);
  });

  it("repairs crash temps without a promotion candidate and paginates past a full young page", async () => {
    const clipsDir = path.join(root, "archive-v1", "clips");
    await fs.mkdir(clipsDir, { recursive: true });
    const youngNames = Array.from(
      { length: 512 },
      (_, index) =>
        `.${PREMIERE_ID}.00000000-0000-4000-8000-${index
          .toString(16)
          .padStart(12, "0")}.mp4.tmp`,
    );
    await Promise.all(
      youngNames.map((name) => fs.writeFile(path.join(clipsDir, name), "y")),
    );
    // A dead owning PID is a startup-crash artifact and is recoverable
    // immediately; the 512 young legacy names ahead of it exercise pagination.
    const staleName = `.${PREMIERE_ID}.2147483647.ffffffff-ffff-4fff-8fff-ffffffffffff.mp4.tmp`;
    const stalePath = path.join(clipsDir, staleName);
    await fs.writeFile(stalePath, Buffer.alloc(256 * 1024, 4));

    expect(await promoter.repairOrphanedTemporaryFiles()).toBe(0);
    expect((await fs.lstat(stalePath)).isFile()).toBe(true);
    expect(await promoter.repairOrphanedTemporaryFiles()).toBe(1);
    expect(await fs.lstat(stalePath).catch(() => null)).toBeNull();
    expect((await fs.lstat(path.join(clipsDir, youngNames[0]))).isFile()).toBe(
      true,
    );
  });

  it("keeps monotonic provenance and refuses false eviction telemetry when an MP4 is concurrently re-linked", async () => {
    const firstPointer = await archivePointer();
    const secondPointer = await archivePointer({
      premiereId: SECOND_PREMIERE_ID,
      sourceRunId: "coworld-archive-002",
    });
    await writePremiereCachedArtifact(
      PREMIERE_ID,
      Buffer.from("first-retained-clip"),
    );
    await writePremiereCachedArtifact(
      SECOND_PREMIERE_ID,
      Buffer.from("second-retained-clip"),
    );
    const seed = new ReplayPremiereArchivedClipPromoter({
      privateStateRoot: root,
      archiveStore: store,
      maxArchivedClips: 1,
    });
    expect(await seed.promotePremiereCache(PREMIERE_ID, firstPointer)).toBe(
      true,
    );
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(archivedClipPath(), old, old);

    let releaseEviction!: () => void;
    let observedUnlink!: () => void;
    const unlinked = new Promise<void>((resolve) => {
      observedUnlink = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    const logs: string[] = [];
    const evictor = new ReplayPremiereArchivedClipPromoter({
      privateStateRoot: root,
      archiveStore: store,
      maxArchivedClips: 1,
      logger: (message) => logs.push(message),
      afterRetentionClipUnlink: async (premiereId) => {
        if (premiereId !== PREMIERE_ID) return;
        observedUnlink();
        await release;
      },
    });
    const relinker = new ReplayPremiereArchivedClipPromoter({
      privateStateRoot: root,
      archiveStore: store,
      maxArchivedClips: 2,
    });

    const eviction = evictor.promotePremiereCache(
      SECOND_PREMIERE_ID,
      secondPointer,
    );
    await unlinked;
    expect(await relinker.promotePremiereCache(PREMIERE_ID, firstPointer)).toBe(
      true,
    );
    releaseEviction();
    await expect(eviction).rejects.toMatchObject({
      operatorCode: "archived_clip_retention_target_reappeared",
    });

    expect(await exists(archivedClipPath(PREMIERE_ID))).toBe(true);
    expect(await exists(archivedManifestPath(PREMIERE_ID))).toBe(true);
    expect(await exists(archivedClipPath(SECOND_PREMIERE_ID))).toBe(true);
    expect(await exists(archivedManifestPath(SECOND_PREMIERE_ID))).toBe(true);
    expect(logs).not.toContain(
      `archived_clip_evicted ${PREMIERE_ID} retention`,
    );
  });

  it("preserves first-write no-overwrite idempotency", async () => {
    await archivePointer();
    const sourceFilePath = path.join(runsRoot, RUN_KEY, "game-record.json");
    const first = await writeCachedArtifact({
      bucket: 60,
      bytes: Buffer.from("first-durable-clip"),
    });
    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: first.bucket,
        sourceReplaySha256: RECORD_SHA,
        sourceFilePath,
      }),
    ).toBe(1);
    const second = await writeCachedArtifact({
      bucket: 70,
      bytes: Buffer.from("later-different-clip"),
    });
    expect(
      await promoter.promoteRatedCoworldRunClip({
        runKey: RUN_KEY,
        bucket: second.bucket,
        sourceReplaySha256: RECORD_SHA,
        sourceFilePath,
      }),
    ).toBe(0);
    expect(await fs.readFile(archivedClipPath())).toEqual(first.bytes);
    expect(
      JSON.parse(await fs.readFile(archivedManifestPath(), "utf8")),
    ).toMatchObject({ anchorTurn: 605, outSha256: sha256Hex(first.bytes) });
  });
});
