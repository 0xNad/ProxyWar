/**
 * End-to-end proof (product overhaul spec Stage 3 item 7, user-requested
 * acceptance test): a retention/reclamation pass over a fixture tree
 * preserves the pinned featured run/premiere and still reclaims an
 * unpinned sibling; cancelling removes the pin and the NEXT pass may
 * reclaim it too. Exercises the REAL consumer
 * (`pruneCoworldLeagueMirrorArtifacts`) against pins written by the REAL
 * `syncFeaturedMatchRetentionPin`/`removeFeaturedMatchRetentionPin`
 * functions — not a mock of either side.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneCoworldLeagueMirrorArtifacts,
  readCoworldLeagueRetentionPins,
} from "../../src/server/agents/CoworldLeagueArtifactRetention";
import {
  removeFeaturedMatchRetentionPin,
  syncFeaturedMatchRetentionPin,
} from "../../src/server/agents/FeaturedMatchRetentionPin";
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

function replayBytes(marker: string): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        replayKind: "proxywar-coworld-local-poc",
        runID: `coworld-run-${marker}`,
        matchID: `match-${marker}`,
        gameID: `game-${marker}`,
        seed: marker,
        config: { map: "Pangaea" },
        results: { winner_slot: 0 },
        finalState: { phase: "winner:Auri" },
        spectatorSnapshotCount: 1,
        spectatorReplay: { snapshots: [{ tick: 1 }] },
      },
      null,
      2,
    )}\n`,
  );
}

async function writeReplay(
  cacheDir: string,
  episodeRequestId: string,
  marker: string,
  modifiedAt: Date,
): Promise<void> {
  const replayPath = path.join(cacheDir, `${episodeRequestId}.replay`);
  await fs.writeFile(replayPath, replayBytes(marker));
  await fs.utimes(replayPath, modifiedAt, modifiedAt);
}

async function writeRunBundle(
  runsRootDir: string,
  publicRunKey: string,
  modifiedAt: Date,
): Promise<void> {
  const runDir = path.join(runsRootDir, publicRunKey);
  await fs.mkdir(runDir);
  await fs.writeFile(path.join(runDir, ".mirror-bundle-version"), "2\n");
  await fs.writeFile(
    path.join(runDir, "match-summary.json"),
    `summary:${publicRunKey}\n`,
  );
  await fs.writeFile(
    path.join(runDir, "game-record.json"),
    `game:${publicRunKey}\n`,
  );
  await fs.writeFile(
    path.join(runDir, "spectator-telemetry.json"),
    `telemetry:${publicRunKey}\n`,
  );
  await fs.utimes(runDir, modifiedAt, modifiedAt);
}

let temporaryRoot: string;
let runsRootDir: string;
let cacheDir: string;
let summaryArchiveDir: string;
let artifactsRoot: string;
let pinManifestPath: string;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "featured-match-retention-integration-"),
  );
  runsRootDir = path.join(temporaryRoot, "runs");
  cacheDir = path.join(temporaryRoot, "cache");
  summaryArchiveDir = path.join(temporaryRoot, "summaries");
  artifactsRoot = path.join(temporaryRoot, "artifacts");
  pinManifestPath = path.join(temporaryRoot, "retention-pins.json");
  await Promise.all([
    fs.mkdir(runsRootDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
  ]);
});

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

async function seedMirror(episodes: CoworldLeagueEpisodeRow[]): Promise<void> {
  const dir = path.join(artifactsRoot, "ai-league-runs", "league");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "data.json"),
    JSON.stringify({ episodes }),
    "utf8",
  );
}

async function loadProtectedSets() {
  try {
    return await readCoworldLeagueRetentionPins(pinManifestPath);
  } catch {
    return {
      episodeRequestIds: new Set<string>(),
      publicRunKeys: new Set<string>(),
      publicRunKeyByEpisodeRequestId: new Map<string, string>(),
    };
  }
}

describe("FeaturedMatch retention pins — real reclamation pass", () => {
  it("a featured (pinned) run survives a reclamation pass that would otherwise prune it, while an unpinned sibling is reclaimed", async () => {
    const featuredEpisode = "ereq_featured01";
    const featuredRunKey = "league-coworld-featured01";
    const siblingEpisode = "ereq_sibling001";
    const siblingRunKey = "league-coworld-sibling001";
    const newestEpisode = "ereq_newest0001";
    const newestRunKey = "league-coworld-newest0001";

    const baseMtime = Date.parse("2026-07-18T00:00:00Z");
    // maxRetained=1 always keeps whichever ONE item is newest regardless of
    // pins — "newest" exists purely so that fact doesn't accidentally save
    // "featured" too. "featured" is older than both — WITHOUT its pin it
    // would be pruned exactly like "sibling"; the pin is the only reason
    // it survives.
    await writeRunBundle(runsRootDir, featuredRunKey, new Date(baseMtime));
    await writeRunBundle(runsRootDir, siblingRunKey, new Date(baseMtime + 1_000));
    await writeRunBundle(runsRootDir, newestRunKey, new Date(baseMtime + 2_000));
    await writeReplay(cacheDir, featuredEpisode, "featured01", new Date(baseMtime));
    await writeReplay(cacheDir, siblingEpisode, "sibling001", new Date(baseMtime + 1_000));
    await writeReplay(cacheDir, newestEpisode, "newest0001", new Date(baseMtime + 2_000));

    await seedMirror([
      episode(featuredEpisode, featuredRunKey),
      episode(siblingEpisode, siblingRunKey),
      episode(newestEpisode, newestRunKey),
    ]);

    // The operator features one match — premiere:publish's own success
    // path calls exactly this.
    const pinned = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_a", episodeRequestId: featuredEpisode },
      { artifactsRoot, pinManifestPath },
    );
    expect(pinned).toBe(true);

    const references = await loadProtectedSets();
    const result = await pruneCoworldLeagueMirrorArtifacts({
      cacheDir,
      runsRootDir,
      summaryArchiveDir,
      protectedEpisodeRequestIds: references.episodeRequestIds,
      protectedPublicRunKeys: references.publicRunKeys,
      maxRetainedCacheFiles: 1,
      maxRetainedRunDirectories: 1,
    });

    expect(result.runDirectoryCandidates).toContain(siblingRunKey);
    expect(result.runDirectoryCandidates).not.toContain(featuredRunKey);
    expect(result.runDirectoryCandidates).not.toContain(newestRunKey);
    expect(result.cacheFileCandidates).toContain(`${siblingEpisode}.replay`);
    expect(result.cacheFileCandidates).not.toContain(`${featuredEpisode}.replay`);

    // Physically verify: the featured run bundle and cache file are still
    // on disk (pin); the naturally-newest survives too (age); the
    // unprotected, non-newest sibling is gone.
    await expect(fs.access(path.join(runsRootDir, featuredRunKey))).resolves.toBeUndefined();
    await expect(fs.access(path.join(runsRootDir, newestRunKey))).resolves.toBeUndefined();
    await expect(fs.access(path.join(runsRootDir, siblingRunKey))).rejects.toThrow();
    await expect(
      fs.access(path.join(cacheDir, `${featuredEpisode}.replay`)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(cacheDir, `${siblingEpisode}.replay`)),
    ).rejects.toThrow();
  });

  it("cancelling the featured match removes its pin, and the NEXT reclamation pass may then reclaim it — never deleted directly by the cancel itself", async () => {
    const featuredEpisode = "ereq_tocancel01";
    const featuredRunKey = "league-coworld-tocancel01";
    const newestEpisode = "ereq_newestcanc1";
    const newestRunKey = "league-coworld-newestcanc1";
    const baseMtime = Date.parse("2026-07-18T00:00:00Z");
    // "newest" is the filler that always wins the single maxRetained=1
    // slot on age alone, so "featured"'s survival in the first pass is
    // due ONLY to its pin, not to being naturally newest.
    await writeRunBundle(runsRootDir, featuredRunKey, new Date(baseMtime));
    await writeRunBundle(runsRootDir, newestRunKey, new Date(baseMtime + 1_000));
    await writeReplay(cacheDir, featuredEpisode, "tocancel01", new Date(baseMtime));
    await writeReplay(cacheDir, newestEpisode, "newestcanc1", new Date(baseMtime + 1_000));
    await seedMirror([
      episode(featuredEpisode, featuredRunKey),
      episode(newestEpisode, newestRunKey),
    ]);

    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_b", episodeRequestId: featuredEpisode },
      { artifactsRoot, pinManifestPath },
    );

    // First pass: still pinned, still survives.
    const stillPinned = await loadProtectedSets();
    const firstPass = await pruneCoworldLeagueMirrorArtifacts({
      cacheDir,
      runsRootDir,
      summaryArchiveDir,
      protectedEpisodeRequestIds: stillPinned.episodeRequestIds,
      protectedPublicRunKeys: stillPinned.publicRunKeys,
      maxRetainedCacheFiles: 1,
      maxRetainedRunDirectories: 1,
    });
    expect(firstPass.runDirectoryCandidates).not.toContain(featuredRunKey);
    await expect(
      fs.access(path.join(runsRootDir, featuredRunKey)),
    ).resolves.toBeUndefined();

    // premiere:cancel's own success path: remove the pin, never touch the
    // artifact directly.
    const removed = await removeFeaturedMatchRetentionPin("feat_b", {
      artifactsRoot,
      pinManifestPath,
    });
    expect(removed).toBe(true);
    // Still on disk immediately after cancel — cancel never deletes.
    await expect(
      fs.access(path.join(runsRootDir, featuredRunKey)),
    ).resolves.toBeUndefined();

    // Second pass: no longer protected, and no longer the natural newest
    // (that's still "newest"), so it is now reclaimable.
    const afterCancel = await loadProtectedSets();
    expect(afterCancel.episodeRequestIds.has(featuredEpisode)).toBe(false);
    const secondPass = await pruneCoworldLeagueMirrorArtifacts({
      cacheDir,
      runsRootDir,
      summaryArchiveDir,
      protectedEpisodeRequestIds: afterCancel.episodeRequestIds,
      protectedPublicRunKeys: afterCancel.publicRunKeys,
      maxRetainedCacheFiles: 1,
      maxRetainedRunDirectories: 1,
    });
    expect(secondPass.runDirectoryCandidates).toContain(featuredRunKey);
    await expect(
      fs.access(path.join(runsRootDir, featuredRunKey)),
    ).rejects.toThrow();
  });
});
