import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  archivedGameRecordArchivePath,
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
  resolveArchivedEpisodeReplayHrefs,
  resolveArchivedPublicRunKey,
  resolveCoworldLeagueSummaryArchiveDir,
  restoreArchivedGameRecord,
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

describe("full-replay-retention fix: durable archive fallback", () => {
  let temporaryRoot: string;
  let runsRootDir: string;
  let cacheDir: string;
  let summaryArchiveDir: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-archive-fallback-"),
    );
    runsRootDir = path.join(temporaryRoot, "runs");
    cacheDir = path.join(temporaryRoot, "cache");
    summaryArchiveDir = path.join(temporaryRoot, "summaries");
    await Promise.all([
      fs.mkdir(runsRootDir, { recursive: true }),
      fs.mkdir(cacheDir, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  /** Prunes a real replay + run bundle into the archive with a real `pruneCoworldLeagueMirrorArtifacts` pass — reuses the REAL archive format, not a hand-crafted stand-in. */
  async function archiveOneEpisode(options: {
    episodeRequestId: string;
    hour: number;
    suffix: string;
  }): Promise<{ publicRunKey: string }> {
    const key = publicRunKey(options.hour, options.suffix);
    const oldMtime = new Date(Date.parse("2026-07-18T00:00:00Z"));
    const newMtime = new Date(Date.parse("2026-07-19T00:00:00Z"));
    await writeRunBundle({ runsRootDir, publicRunKey: key, modifiedAt: oldMtime });
    await writeReplay({
      cacheDir,
      episodeRequestId: options.episodeRequestId,
      runID: runID(options.hour, options.suffix),
      marker: options.suffix,
      modifiedAt: oldMtime,
    });
    // A newer, unrelated sibling so maxRetained=1 evicts ONLY the target above.
    const filler = publicRunKey(options.hour + 100, `${options.suffix}-filler`);
    await writeRunBundle({ runsRootDir, publicRunKey: filler, modifiedAt: newMtime });
    await writeReplay({
      cacheDir,
      episodeRequestId: `ereq_${options.suffix}_filler`,
      runID: runID(options.hour + 100, `${options.suffix}-filler`),
      marker: `${options.suffix}-filler`,
      modifiedAt: newMtime,
    });
    await pruneCoworldLeagueMirrorArtifacts({
      cacheDir,
      runsRootDir,
      summaryArchiveDir,
      protectedEpisodeRequestIds: new Set(),
      protectedPublicRunKeys: new Set(),
      maxRetainedCacheFiles: 1,
      maxRetainedRunDirectories: 1,
    });
    // Confirm the fixture actually rotated out, not just that we asked it to.
    await expect(fs.stat(path.join(runsRootDir, key))).rejects.toMatchObject({
      code: "ENOENT",
    });
    return { publicRunKey: key };
  }

  test("resolveArchivedPublicRunKey resolves the run key from durable evidence once the episode has rotated out of the live mirror window", async () => {
    const episodeRequestId = "ereq_rotated1";
    const { publicRunKey: expectedKey } = await archiveOneEpisode({
      episodeRequestId,
      hour: 1,
      suffix: "rot1",
    });
    await expect(
      resolveArchivedPublicRunKey(summaryArchiveDir, episodeRequestId),
    ).resolves.toBe(expectedKey);
  });

  test("resolveArchivedPublicRunKey returns null (never fabricated) when no archive exists at all", async () => {
    await expect(
      resolveArchivedPublicRunKey(summaryArchiveDir, "ereq_never_archived"),
    ).resolves.toBeNull();
  });

  test("resolveArchivedPublicRunKey returns null for a corrupt/malformed archive without throwing", async () => {
    await fs.mkdir(summaryArchiveDir, { recursive: true });
    await fs.writeFile(
      path.join(summaryArchiveDir, "ereq_corrupt.replay-summary.json.gz"),
      Buffer.from("not actually gzip"),
    );
    await expect(
      resolveArchivedPublicRunKey(summaryArchiveDir, "ereq_corrupt"),
    ).resolves.toBeNull();
  });

  test("resolveArchivedPublicRunKey returns null for an oversized archive without reading it", async () => {
    await fs.mkdir(summaryArchiveDir, { recursive: true });
    const oversizedPath = path.join(
      summaryArchiveDir,
      "ereq_oversized.replay-summary.json.gz",
    );
    await fs.writeFile(oversizedPath, gzipSync(JSON.stringify({ runID: "coworld-x" })));
    await fs.truncate(oversizedPath, 2 * 1024 * 1024);
    await expect(
      resolveArchivedPublicRunKey(summaryArchiveDir, "ereq_oversized"),
    ).resolves.toBeNull();
  });

  test("resolveArchivedPublicRunKey returns null (never throws) for a SMALL-compressed archive that decompresses past the decompressed-size cap — a real zip-bomb guard via zlib's own maxOutputLength, not just the pre-decompression compressed-size check", async () => {
    await fs.mkdir(summaryArchiveDir, { recursive: true });
    const bombPath = path.join(
      summaryArchiveDir,
      "ereq_decompress_bomb.replay-summary.json.gz",
    );
    // Highly compressible payload: ~6 MiB of a repeated character
    // decompresses well past the 4 MiB cap, yet gzips down to well under
    // the 1 MiB COMPRESSED cap — proving the compressed-size stat check
    // alone is not a real bound on decompressed memory, and that the
    // decompressed cap actually catches what it misses.
    const bomb = gzipSync(
      JSON.stringify({
        runID: "coworld-bomb",
        padding: "a".repeat(6 * 1024 * 1024),
      }),
    );
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    await fs.writeFile(bombPath, bomb);
    await expect(
      resolveArchivedPublicRunKey(summaryArchiveDir, "ereq_decompress_bomb"),
    ).resolves.toBeNull();
  });

  test("resolveArchivedPublicRunKey returns null when the archived runID does not survive the managed run key pattern", async () => {
    await fs.mkdir(summaryArchiveDir, { recursive: true });
    await fs.writeFile(
      path.join(summaryArchiveDir, "ereq_unsafe.replay-summary.json.gz"),
      gzipSync(JSON.stringify({ runID: "../../etc/passwd" })),
    );
    await expect(
      resolveArchivedPublicRunKey(summaryArchiveDir, "ereq_unsafe"),
    ).resolves.toBeNull();
  });

  test("resolveArchivedEpisodeReplayHrefs exposes fullRenderHref only when the exact game-record archive exists; watchHref is always null", async () => {
    const episodeRequestId = "ereq_rotated2";
    const { publicRunKey: key } = await archiveOneEpisode({
      episodeRequestId,
      hour: 2,
      suffix: "rot2",
    });
    await expect(
      resolveArchivedEpisodeReplayHrefs(summaryArchiveDir, episodeRequestId),
    ).resolves.toEqual({
      watchHref: null,
      fullRenderHref: `/ai-league-replay/${key}`,
    });

    // Remove just the game-record archive: the run key still resolves (the
    // compact replay summary is untouched), but fullRenderHref must now be
    // honest-null too — nothing durable actually backs a render.
    await fs.rm(archivedGameRecordArchivePath(summaryArchiveDir, key) as string);
    await expect(
      resolveArchivedEpisodeReplayHrefs(summaryArchiveDir, episodeRequestId),
    ).resolves.toEqual({ watchHref: null, fullRenderHref: null });
  });

  test("resolveArchivedEpisodeReplayHrefs returns null when nothing is archived for the episode", async () => {
    await expect(
      resolveArchivedEpisodeReplayHrefs(summaryArchiveDir, "ereq_absent"),
    ).resolves.toBeNull();
  });

  test("neither archive lookup ever scans the archive directory — always a direct, bounded, per-episode/per-key lookup", async () => {
    const episodeRequestId = "ereq_rotated3";
    const { publicRunKey: key } = await archiveOneEpisode({
      episodeRequestId,
      hour: 3,
      suffix: "rot3",
    });
    const readdirSpy = vi.spyOn(fs, "readdir");
    try {
      await expect(
        resolveArchivedPublicRunKey(summaryArchiveDir, episodeRequestId),
      ).resolves.toBe(key);
      await expect(
        resolveArchivedEpisodeReplayHrefs(summaryArchiveDir, episodeRequestId),
      ).resolves.not.toBeNull();
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      readdirSpy.mockRestore();
    }
  });

  test("restoreArchivedGameRecord lazily rehydrates a missing live game-record.json from its durable archive, byte-identical, without mutating the archive", async () => {
    const episodeRequestId = "ereq_rotated4";
    const { publicRunKey: key } = await archiveOneEpisode({
      episodeRequestId,
      hour: 4,
      suffix: "rot4",
    });
    const archivePath = archivedGameRecordArchivePath(summaryArchiveDir, key) as string;
    const archiveBytesBefore = await fs.readFile(archivePath);

    const restoredPath = await restoreArchivedGameRecord({
      runsRootDir,
      summaryArchiveDir,
      publicRunKey: key,
    });
    expect(restoredPath).toBe(path.join(runsRootDir, key, "game-record.json"));
    const restored = await fs.readFile(restoredPath as string);
    expect(restored).toEqual(gunzipSync(archiveBytesBefore));
    // Read-only: the archive's own bytes are untouched.
    await expect(fs.readFile(archivePath)).resolves.toEqual(archiveBytesBefore);
  });

  test("restoreArchivedGameRecord returns null and creates NOTHING for an unknown publicRunKey", async () => {
    const bogusKey = "league-coworld-2026-07-01T00-00-00-000Z-bogus";
    await expect(
      restoreArchivedGameRecord({ runsRootDir, summaryArchiveDir, publicRunKey: bogusKey }),
    ).resolves.toBeNull();
    await expect(fs.stat(path.join(runsRootDir, bogusKey))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("restoreArchivedGameRecord is idempotent: an already-live file is returned unchanged, and concurrent restores of the SAME run converge on identical content", async () => {
    const episodeRequestId = "ereq_rotated5";
    const { publicRunKey: key } = await archiveOneEpisode({
      episodeRequestId,
      hour: 5,
      suffix: "rot5",
    });
    const [first, second] = await Promise.all([
      restoreArchivedGameRecord({ runsRootDir, summaryArchiveDir, publicRunKey: key }),
      restoreArchivedGameRecord({ runsRootDir, summaryArchiveDir, publicRunKey: key }),
    ]);
    expect(first).toBe(second);
    const restored = await fs.readFile(first as string, "utf8");
    expect(restored).toBe(`game:${key}\n`);

    // Re-running once the live file already exists must not touch the archive again.
    const archivePath = archivedGameRecordArchivePath(summaryArchiveDir, key) as string;
    const beforeStat = await fs.stat(archivePath);
    await restoreArchivedGameRecord({ runsRootDir, summaryArchiveDir, publicRunKey: key });
    const afterStat = await fs.stat(archivePath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("restoreArchivedGameRecord enforces a bounded compressed-size cap (null, never throws) and a bounded decompressed-size cap (throws, never silently truncates)", async () => {
    const episodeRequestId = "ereq_rotated6";
    const { publicRunKey: key } = await archiveOneEpisode({
      episodeRequestId,
      hour: 6,
      suffix: "rot6",
    });
    await expect(
      restoreArchivedGameRecord({
        runsRootDir,
        summaryArchiveDir,
        publicRunKey: key,
        maxCompressedBytes: 1,
      }),
    ).resolves.toBeNull();
    await expect(
      fs.stat(path.join(runsRootDir, key, "game-record.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      restoreArchivedGameRecord({
        runsRootDir,
        summaryArchiveDir,
        publicRunKey: key,
        maxDecompressedBytes: 1,
      }),
    ).rejects.toThrow("decompression limit");
    await expect(
      fs.stat(path.join(runsRootDir, key, "game-record.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("resolveCoworldLeagueSummaryArchiveDir mirrors coworld-league-mirror.ts's own default and env override", () => {
    const artifactsRoot = "/tmp/example-artifacts";
    expect(resolveCoworldLeagueSummaryArchiveDir(artifactsRoot, {})).toBe(
      path.join(artifactsRoot, "coworld-league-mirror", "summaries"),
    );
    expect(
      resolveCoworldLeagueSummaryArchiveDir(artifactsRoot, {
        PROXYWAR_LEAGUE_SUMMARY_ARCHIVE_DIR: "/custom/summaries",
      }),
    ).toBe("/custom/summaries");
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
