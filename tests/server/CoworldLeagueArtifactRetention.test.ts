import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CoworldLeagueDiskReserveError,
  coworldLeagueReplayCachePath,
  ensureSafeCoworldLeagueRunDirectory,
  minimumAvailableDiskBytes,
  pruneCoworldLeagueMirrorArtifacts,
  publicRunKeyFromFullRenderHref,
  publicRunKeyFromWatchHref,
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

describe("CoworldLeagueArtifactRetention", () => {
  let temporaryRoot: string;
  let runsRootDir: string;
  let cacheDir: string;
  let siteDir: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-retention-"),
    );
    runsRootDir = path.join(temporaryRoot, "runs");
    cacheDir = path.join(temporaryRoot, "cache");
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

  test("preserves published, newest, and safety-window artifacts", async () => {
    const nowMs = Date.parse("2026-07-17T12:00:00Z");
    const ids = ["a", "b", "c", "d", "e"];
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const runKey = `league-coworld-2026-07-17-${id}`;
      const episodeRequestId = `ereq_${id}`;
      const runDir = path.join(runsRootDir, runKey);
      const cachePath = path.join(cacheDir, `${episodeRequestId}.replay`);
      await fs.mkdir(runDir);
      await fs.writeFile(path.join(runDir, "game-record.json"), id);
      await fs.writeFile(cachePath, id);
      const ageHours = id === "e" ? 0.5 : 10 - index;
      const modifiedAt = new Date(nowMs - ageHours * 60 * 60 * 1000);
      await fs.utimes(runDir, modifiedAt, modifiedAt);
      await fs.utimes(cachePath, modifiedAt, modifiedAt);
    }
    await fs.mkdir(path.join(runsRootDir, "manual-run"));
    await fs.writeFile(path.join(cacheDir, "notes.txt"), "keep");
    const outside = path.join(temporaryRoot, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(runsRootDir, "league-coworld-symlink"));

    const references = retentionReferencesFromEpisodes([
      episode("ereq_a", "league-coworld-2026-07-17-a"),
    ]);
    const options = {
      cacheDir,
      runsRootDir,
      protectedEpisodeRequestIds: references.episodeRequestIds,
      protectedPublicRunKeys: references.publicRunKeys,
      maxRetainedArtifacts: 3,
      minimumRetentionAgeMs: 60 * 60 * 1000,
      nowMs,
    };
    const dryRun = await pruneCoworldLeagueMirrorArtifacts({
      ...options,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      cacheFilesFound: 5,
      cacheFilesPruned: 1,
      runDirectoriesFound: 5,
      runDirectoriesPruned: 1,
    });
    await expect(
      fs.readFile(path.join(cacheDir, "ereq_b.replay"), "utf8"),
    ).resolves.toBe("b");

    const pruned = await pruneCoworldLeagueMirrorArtifacts(options);
    expect(pruned.cacheFilesPruned).toBe(1);
    expect(pruned.runDirectoriesPruned).toBe(1);
    for (const id of ["a", "c", "d", "e"]) {
      await expect(
        fs.stat(path.join(runsRootDir, `league-coworld-2026-07-17-${id}`)),
      ).resolves.toBeDefined();
      await expect(
        fs.readFile(path.join(cacheDir, `ereq_${id}.replay`), "utf8"),
      ).resolves.toBe(id);
    }
    for (const id of ["b"]) {
      await expect(
        fs.stat(path.join(runsRootDir, `league-coworld-2026-07-17-${id}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.stat(path.join(cacheDir, `ereq_${id}.replay`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      fs.stat(path.join(runsRootDir, "league")),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(runsRootDir, "manual-run")),
    ).resolves.toBeDefined();
    await expect(
      fs.lstat(path.join(runsRootDir, "league-coworld-symlink")),
    ).resolves.toMatchObject({});
    await expect(
      fs.readFile(path.join(cacheDir, "notes.txt"), "utf8"),
    ).resolves.toBe("keep");

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

  test("requires the league site to be a direct child of the runs root", () => {
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(siteDir, runsRootDir),
    ).not.toThrow();
    expect(() =>
      requireSafeCoworldLeagueRetentionLayout(
        path.join(runsRootDir, "nested", "league"),
        runsRootDir,
      ),
    ).toThrow("direct league child");
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
