import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CoworldLeagueDiskReserveError,
  coworldLeagueReplayCachePath,
  ensureSafeCoworldLeagueRunDirectory,
  minimumAvailableDiskBytes,
  parseCoworldLeagueRetentionPins,
  pruneCoworldLeagueMirrorArtifacts,
  publicRunKeyFromFullRenderHref,
  publicRunKeyFromWatchHref,
  readCoworldLeagueRetentionPins,
  requireMinimumDiskSpace,
  requireSafeCoworldLeagueRetentionLayout,
  retentionReferencesFromEpisodes,
} from "../../src/server/agents/CoworldLeagueArtifactRetention";
import {
  coworldLeagueMirrorOperationLockPath,
  withCoworldLeagueMirrorOperationLock,
} from "../../src/server/agents/CoworldLeagueMirrorOperationLock";
import type { CoworldLeagueEpisodeRow } from "../../src/server/agents/CoworldLeagueSiteWriter";

function episode(
  episodeRequestId: string,
  publicRunKey: string,
): CoworldLeagueEpisodeRow {
  return {
    episodeRequestId,
    shortId: episodeRequestId.slice(-8),
    roundNumber: 1,
    completedAt: "2026-07-17T10:00:00Z",
    map: "Pangaea",
    mapSize: "Compact",
    difficulty: "Easy",
    turnCount: 400,
    decisionCount: 10,
    degradedCount: 0,
    winnerName: "Auri",
    players: [],
    watchHref: `/ai-league-runs/${publicRunKey}/spectator.html`,
    fullRenderHref: `/ai-league-replay/${publicRunKey}`,
  };
}

function runID(hour: number, suffix: string): string {
  return `coworld-2026-07-17T${hour.toString().padStart(2, "0")}-00-00-000Z-${suffix}`;
}

function publicRunKey(hour: number, suffix: string): string {
  return `league-${runID(hour, suffix)}`;
}

function replayBytes(value: { runID: string; marker: string }): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        replayKind: "proxywar-coworld-local-poc",
        runID: value.runID,
        matchID: `match-${value.marker}`,
        gameID: `game-${value.marker}`,
        seed: value.marker,
        config: { map: "Pangaea" },
        results: { winner_slot: 0 },
        finalState: { phase: "winner:Auri" },
        spectatorSnapshotCount: 7,
        spectatorReplay: { snapshots: [{ tick: 1 }] },
        largeFieldThatMustNotBeArchived: "discard-me",
      },
      null,
      2,
    )}\n`,
  );
}

async function writeReplay(options: {
  cacheDir: string;
  episodeRequestId: string;
  runID: string;
  marker: string;
  modifiedAt: Date;
}): Promise<Buffer> {
  const contents = replayBytes({
    runID: options.runID,
    marker: options.marker,
  });
  const replayPath = path.join(
    options.cacheDir,
    `${options.episodeRequestId}.replay`,
  );
  await fs.writeFile(replayPath, contents);
  await fs.utimes(replayPath, options.modifiedAt, options.modifiedAt);
  return contents;
}

async function writeRunBundle(options: {
  runsRootDir: string;
  publicRunKey: string;
  markerVersion?: string;
  modifiedAt: Date;
  omitGameRecord?: boolean;
}): Promise<{
  gameRecord: Buffer;
  matchSummary: Buffer;
  spectatorTelemetry: Buffer;
}> {
  const runDir = path.join(options.runsRootDir, options.publicRunKey);
  const matchSummary = Buffer.from(`summary:${options.publicRunKey}\n`);
  const gameRecord = Buffer.from(`game:${options.publicRunKey}\n`);
  const spectatorTelemetry = Buffer.from(`telemetry:${options.publicRunKey}\n`);
  await fs.mkdir(runDir);
  await fs.writeFile(
    path.join(runDir, ".mirror-bundle-version"),
    `${options.markerVersion ?? "2"}\n`,
  );
  await fs.writeFile(path.join(runDir, "match-summary.json"), matchSummary);
  if (options.omitGameRecord !== true) {
    await fs.writeFile(path.join(runDir, "game-record.json"), gameRecord);
  }
  await fs.writeFile(
    path.join(runDir, "spectator-telemetry.json"),
    spectatorTelemetry,
  );
  await fs.utimes(runDir, options.modifiedAt, options.modifiedAt);
  return { gameRecord, matchSummary, spectatorTelemetry };
}

describe("CoworldLeagueArtifactRetention", () => {
  let temporaryRoot: string;
  let runsRootDir: string;
  let cacheDir: string;
  let summaryArchiveDir: string;
  let siteDir: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-retention-"),
    );
    runsRootDir = path.join(temporaryRoot, "runs");
    cacheDir = path.join(temporaryRoot, "cache");
    summaryArchiveDir = path.join(temporaryRoot, "summaries");
    siteDir = path.join(runsRootDir, "league");
    await Promise.all([
      fs.mkdir(runsRootDir, { recursive: true }),
      fs.mkdir(cacheDir, { recursive: true }),
      fs.mkdir(siteDir, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  test("uses separate semantic newest windows and unions protected artifacts", async () => {
    const replaySources = new Map<string, Buffer>();
    const bundleSources = new Map<
      string,
      {
        gameRecord: Buffer;
        matchSummary: Buffer;
        spectatorTelemetry: Buffer;
      }
    >();
    const baseMtime = Date.parse("2026-07-18T00:00:00Z");
    for (let hour = 1; hour <= 6; hour++) {
      const suffix = `item${hour}`;
      const modifiedAt = new Date(baseMtime + (7 - hour) * 1_000);
      const key = publicRunKey(hour, suffix);
      bundleSources.set(
        key,
        await writeRunBundle({
          runsRootDir,
          publicRunKey: key,
          modifiedAt,
        }),
      );
      if (hour <= 5) {
        const episodeRequestId = `ereq_item${hour}`;
        replaySources.set(
          episodeRequestId,
          await writeReplay({
            cacheDir,
            episodeRequestId,
            runID: runID(hour, suffix),
            marker: suffix,
            modifiedAt,
          }),
        );
      }
    }

    const protectedEpisodeRequestId = "ereq_item1";
    const protectedRunKey = publicRunKey(1, "item1");
    const references = retentionReferencesFromEpisodes([
      episode(protectedEpisodeRequestId, protectedRunKey),
    ]);
    const options = {
      cacheDir,
      runsRootDir,
      summaryArchiveDir,
      protectedEpisodeRequestIds: references.episodeRequestIds,
      protectedPublicRunKeys: references.publicRunKeys,
      maxRetainedCacheFiles: 2,
      maxRetainedRunDirectories: 3,
    };
    const dryRun = await pruneCoworldLeagueMirrorArtifacts({
      ...options,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      cacheFilesFound: 5,
      cacheFilesPruned: 2,
      cacheFileCandidates: ["ereq_item3.replay", "ereq_item2.replay"],
      runDirectoriesFound: 6,
      runDirectoriesPruned: 2,
      runDirectoryCandidates: [
        publicRunKey(3, "item3"),
        publicRunKey(2, "item2"),
      ],
    });
    await expect(fs.stat(summaryArchiveDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(cacheDir, "ereq_item2.replay")),
    ).resolves.toBeDefined();

    const pruned = await pruneCoworldLeagueMirrorArtifacts(options);
    expect(pruned.cacheFilesPruned).toBe(2);
    expect(pruned.runDirectoriesPruned).toBe(2);
    for (const hour of [1, 4, 5]) {
      await expect(
        fs.stat(path.join(cacheDir, `ereq_item${hour}.replay`)),
      ).resolves.toBeDefined();
    }
    for (const hour of [1, 4, 5, 6]) {
      await expect(
        fs.stat(path.join(runsRootDir, publicRunKey(hour, `item${hour}`))),
      ).resolves.toBeDefined();
    }
    for (const hour of [2, 3]) {
      await expect(
        fs.stat(path.join(cacheDir, `ereq_item${hour}.replay`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(runsRootDir, publicRunKey(hour, `item${hour}`))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }

    const archivedReplay = JSON.parse(
      gunzipSync(
        await fs.readFile(
          path.join(summaryArchiveDir, "ereq_item2.replay-summary.json.gz"),
        ),
      ).toString("utf8"),
    );
    const replaySource = replaySources.get("ereq_item2");
    expect(replaySource).toBeDefined();
    expect(archivedReplay).toMatchObject({
      episodeRequestId: "ereq_item2",
      sha256: createHash("sha256").update(replaySource!).digest("hex"),
      bytes: replaySource!.byteLength,
      schemaVersion: 1,
      replayKind: "proxywar-coworld-local-poc",
      runID: runID(2, "item2"),
      matchID: "match-item2",
      gameID: "game-item2",
      seed: "item2",
      config: { map: "Pangaea" },
      results: { winner_slot: 0 },
      finalState: { phase: "winner:Auri" },
      spectatorSnapshotCount: 7,
    });
    expect(archivedReplay).not.toHaveProperty(
      "largeFieldThatMustNotBeArchived",
    );

    const runKey = publicRunKey(2, "item2");
    const bundleSource = bundleSources.get(runKey);
    expect(bundleSource).toBeDefined();
    expect(
      gunzipSync(
        await fs.readFile(
          path.join(summaryArchiveDir, `${runKey}.match-summary.json.gz`),
        ),
      ),
    ).toEqual(bundleSource!.matchSummary);
    expect(
      gunzipSync(
        await fs.readFile(
          path.join(summaryArchiveDir, `${runKey}.game-record.json.gz`),
        ),
      ),
    ).toEqual(bundleSource!.gameRecord);
    expect(
      gunzipSync(
        await fs.readFile(
          path.join(summaryArchiveDir, `${runKey}.spectator-telemetry.json.gz`),
        ),
      ),
    ).toEqual(bundleSource!.spectatorTelemetry);

    await expect(
      pruneCoworldLeagueMirrorArtifacts(options),
    ).resolves.toMatchObject({
      cacheFilesPruned: 0,
      runDirectoriesPruned: 0,
    });
  });

  test("rejects unsafe or conflicting published references", () => {
    expect(
      publicRunKeyFromFullRenderHref("/ai-league-replay/league-coworld-%2Ftmp"),
    ).toBeNull();
    expect(
      publicRunKeyFromWatchHref(
        "/ai-league-runs/league-coworld-%2E%2E%2Ftmp/spectator.html",
      ),
    ).toBeNull();
    expect(() =>
      retentionReferencesFromEpisodes([
        {
          ...episode("ereq_safe", "league-coworld-safe"),
          fullRenderHref: "/ai-league-replay/league-coworld-other",
        },
      ]),
    ).toThrow("different run bundles");
    expect(() =>
      retentionReferencesFromEpisodes([
        episode("../unsafe", "league-coworld-safe"),
      ]),
    ).toThrow("Unsafe Coworld episode request id");
  });

  test("reads and strictly validates retention pins", async () => {
    const pinManifest = {
      schemaVersion: 1,
      pins: [
        {
          episodeRequestId: "ereq_evidence-a",
          publicRunKey: publicRunKey(1, "evidence-a"),
          reason: "Cited in the RSI report",
        },
      ],
    };
    const manifestPath = path.join(temporaryRoot, "retention-pins.json");
    await fs.writeFile(manifestPath, JSON.stringify(pinManifest));

    const references = await readCoworldLeagueRetentionPins(manifestPath);
    expect([...references.episodeRequestIds]).toEqual(["ereq_evidence-a"]);
    expect([...references.publicRunKeys]).toEqual([
      publicRunKey(1, "evidence-a"),
    ]);
    expect(
      references.publicRunKeyByEpisodeRequestId.get("ereq_evidence-a"),
    ).toBe(publicRunKey(1, "evidence-a"));

    expect(() =>
      parseCoworldLeagueRetentionPins({
        ...pinManifest,
        ignoredTypo: true,
      }),
    ).toThrow("must contain exactly");
    expect(() =>
      parseCoworldLeagueRetentionPins({
        schemaVersion: 1,
        pins: [
          pinManifest.pins[0],
          {
            ...pinManifest.pins[0],
            publicRunKey: publicRunKey(2, "different-run"),
          },
        ],
      }),
    ).toThrow("duplicates an episodeRequestId");
    expect(() =>
      parseCoworldLeagueRetentionPins({
        schemaVersion: 1,
        pins: [
          pinManifest.pins[0],
          {
            ...pinManifest.pins[0],
            episodeRequestId: "ereq_evidence-b",
          },
        ],
      }),
    ).toThrow("duplicates a publicRunKey");
    expect(() =>
      parseCoworldLeagueRetentionPins({
        schemaVersion: 1,
        pins: [{ ...pinManifest.pins[0], reason: " " }],
      }),
    ).toThrow("reason must be a non-empty string");
    await fs.writeFile(manifestPath, "not-json");
    await expect(readCoworldLeagueRetentionPins(manifestPath)).rejects.toThrow(
      "is not valid JSON",
    );
  });

  test("contains cache paths and rejects unsafe episode request ids", () => {
    expect(coworldLeagueReplayCachePath(cacheDir, "ereq_safe-123")).toBe(
      path.join(cacheDir, "ereq_safe-123.replay"),
    );
    for (const episodeRequestId of [
      "../victim",
      "ereq_../../victim",
      "ereq_bad/value",
      "ereq_bad\\value",
    ]) {
      expect(() =>
        coworldLeagueReplayCachePath(cacheDir, episodeRequestId),
      ).toThrow("Unsafe Coworld episode request id");
    }
  });

  test("does not delete any candidate when one archive cannot be built", async () => {
    const oldReplayPath = path.join(cacheDir, "ereq_old.replay");
    await writeReplay({
      cacheDir,
      episodeRequestId: "ereq_old",
      runID: runID(1, "old"),
      marker: "old",
      modifiedAt: new Date("2026-07-17T01:00:00Z"),
    });
    await writeReplay({
      cacheDir,
      episodeRequestId: "ereq_new",
      runID: runID(2, "new"),
      marker: "new",
      modifiedAt: new Date("2026-07-17T02:00:00Z"),
    });
    const incompleteRunKey = publicRunKey(1, "incomplete");
    await writeRunBundle({
      runsRootDir,
      publicRunKey: incompleteRunKey,
      modifiedAt: new Date("2026-07-17T01:00:00Z"),
      omitGameRecord: true,
    });
    await writeRunBundle({
      runsRootDir,
      publicRunKey: publicRunKey(2, "complete"),
      modifiedAt: new Date("2026-07-17T02:00:00Z"),
    });

    await expect(
      pruneCoworldLeagueMirrorArtifacts({
        cacheDir,
        runsRootDir,
        summaryArchiveDir,
        protectedEpisodeRequestIds: new Set(),
        protectedPublicRunKeys: new Set(),
        maxRetainedCacheFiles: 1,
        maxRetainedRunDirectories: 1,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(fs.stat(oldReplayPath)).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(runsRootDir, incompleteRunKey)),
    ).resolves.toBeDefined();
    await expect(fs.readdir(summaryArchiveDir)).resolves.toEqual([]);
  });

  test("uses mtime for legacy IDs and ignores unmarked bundles and symlinks", async () => {
    const oldMtime = new Date("2026-07-17T01:00:00Z");
    const newMtime = new Date("2026-07-17T02:00:00Z");
    for (const [label, modifiedAt] of [
      ["old", oldMtime],
      ["new", newMtime],
    ] as const) {
      await writeReplay({
        cacheDir,
        episodeRequestId: `ereq_legacy_${label}`,
        runID: `legacy-${label}`,
        marker: label,
        modifiedAt,
      });
      await writeRunBundle({
        runsRootDir,
        publicRunKey: `league-coworld-legacy-${label}`,
        markerVersion: "2",
        modifiedAt,
      });
    }

    const unmarked = path.join(runsRootDir, "league-coworld-unmarked");
    await fs.mkdir(unmarked);
    const outsideDir = path.join(temporaryRoot, "outside-dir");
    await fs.mkdir(outsideDir);
    await fs.symlink(
      outsideDir,
      path.join(runsRootDir, "league-coworld-directory-symlink"),
    );
    const markerSymlinkRun = path.join(
      runsRootDir,
      "league-coworld-marker-symlink",
    );
    await fs.mkdir(markerSymlinkRun);
    const outsideMarker = path.join(temporaryRoot, "outside-marker");
    await fs.writeFile(outsideMarker, "2\n");
    await fs.symlink(
      outsideMarker,
      path.join(markerSymlinkRun, ".mirror-bundle-version"),
    );
    const outsideReplay = path.join(temporaryRoot, "outside.replay");
    await fs.writeFile(outsideReplay, "outside");
    await fs.symlink(outsideReplay, path.join(cacheDir, "ereq_symlink.replay"));

    await expect(
      pruneCoworldLeagueMirrorArtifacts({
        cacheDir,
        runsRootDir,
        summaryArchiveDir,
        protectedEpisodeRequestIds: new Set(),
        protectedPublicRunKeys: new Set(),
        maxRetainedCacheFiles: 1,
        maxRetainedRunDirectories: 1,
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      cacheFilesFound: 2,
      cacheFileCandidates: ["ereq_legacy_old.replay"],
      runDirectoriesFound: 2,
      runDirectoryCandidates: ["league-coworld-legacy-old"],
    });
    await expect(fs.readFile(outsideReplay, "utf8")).resolves.toBe("outside");
    await expect(fs.readFile(outsideMarker, "utf8")).resolves.toBe("2\n");
  });

  test("refuses to write a managed run through a symlink", async () => {
    const outside = path.join(temporaryRoot, "outside-run");
    const publicRunKey = "league-coworld-symlink-target";
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(runsRootDir, publicRunKey));

    await expect(
      ensureSafeCoworldLeagueRunDirectory(runsRootDir, publicRunKey),
    ).rejects.toThrow("Unsafe Coworld run directory");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  test("checks every distinct storage path for the minimum free space", async () => {
    const inspected: string[] = [];
    const minimum = await minimumAvailableDiskBytes(
      [cacheDir, runsRootDir, cacheDir],
      async (candidatePath) => {
        inspected.push(candidatePath);
        return candidatePath === path.resolve(cacheDir) ? 100 : 200;
      },
    );

    expect(minimum).toBe(100);
    expect(inspected.sort()).toEqual(
      [path.resolve(cacheDir), path.resolve(runsRootDir)].sort(),
    );
  });

  test("reserves pending-write headroom before allowing a disk write", async () => {
    await expect(
      requireMinimumDiskSpace(cacheDir, 100, 25, async () => 124),
    ).rejects.toBeInstanceOf(CoworldLeagueDiskReserveError);
    await expect(
      requireMinimumDiskSpace(cacheDir, 100, 25, async () => 125),
    ).resolves.toBeUndefined();
  });

  test("requires the canonical retention storage layout", () => {
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(siteDir, runsRootDir),
    ).not.toThrow();
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(
        path.join(runsRootDir, "nested", "league"),
        runsRootDir,
      ),
    ).toThrow("direct league child");

    const artifactRoot = path.join(temporaryRoot, "artifacts");
    const canonicalRunsRoot = path.join(artifactRoot, "ai-league-runs");
    const canonicalSiteDir = path.join(canonicalRunsRoot, "league");
    const canonicalCacheDir = path.join(
      artifactRoot,
      "coworld-league-mirror",
      "replays",
    );
    const canonicalArchiveDir = path.join(
      artifactRoot,
      "coworld-league-mirror",
      "summaries",
    );
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(
        canonicalSiteDir,
        canonicalRunsRoot,
        canonicalCacheDir,
        canonicalArchiveDir,
      ),
    ).not.toThrow();
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(
        canonicalSiteDir,
        canonicalRunsRoot,
        path.join(temporaryRoot, "arbitrary-cache"),
        canonicalArchiveDir,
      ),
    ).toThrow("canonical artifact layout");
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(
        canonicalSiteDir,
        canonicalRunsRoot,
        canonicalCacheDir,
      ),
    ).toThrow("together");
  });
});

describe("CoworldLeagueMirrorOperationLock", () => {
  let temporaryRoot: string;
  let siteDir: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-lock-"));
    siteDir = path.join(temporaryRoot, "runs", "league");
    await fs.mkdir(siteDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  test("rejects overlap and releases after success or failure", async () => {
    await withCoworldLeagueMirrorOperationLock(siteDir, async () => {
      await expect(
        withCoworldLeagueMirrorOperationLock(siteDir, async () => undefined),
      ).rejects.toThrow("already running");
    });
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => {
        throw new Error("expected failure");
      }),
    ).rejects.toThrow("expected failure");
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "released"),
    ).resolves.toBe("released");
  });

  test("reclaims a lock owned by a dead process", async () => {
    const lockPath = coworldLeagueMirrorOperationLockPath(siteDir);
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "dead-owner",
        createdAt: "2026-07-17T00:00:00Z",
      })}\n`,
    );
    await expect(
      withCoworldLeagueMirrorOperationLock(siteDir, async () => "reclaimed"),
    ).resolves.toBe("reclaimed");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
