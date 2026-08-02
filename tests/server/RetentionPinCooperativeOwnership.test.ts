/**
 * Dedicated cross-writer ownership matrix (fixing a real bug found by
 * review of the retention-pin work): `pinHoldArtifacts`/`unpinHoldArtifacts`
 * (replay-premiere-loop.ts, the live premiere hold's own claim) and
 * `syncFeaturedMatchRetentionPin`/`removeFeaturedMatchRetentionPin`
 * (FeaturedMatchRetentionPin.ts, a Featured Match's independent claim) can
 * both protect the SAME artifact at different, overlapping times. Both now
 * go through the same shared, atomic, exact-owner-tag primitive
 * (`addRetentionPinOwner`/`removeRetentionPinOwner` in
 * CoworldLeagueArtifactRetention.ts) instead of each running its own
 * bespoke read-modify-write. This file proves it: both ownership orders x
 * both release orders, plus idempotent double-add/double-remove per owner,
 * asserting the artifact survives until the LAST owner releases and the
 * manifest ends empty in every case. Exercises the REAL production
 * functions from both modules — not a simulation of either.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCoworldLeagueRetentionPinManifest,
} from "../../src/server/agents/CoworldLeagueArtifactRetention";
import {
  removeFeaturedMatchRetentionPin,
  syncFeaturedMatchRetentionPin,
} from "../../src/server/agents/FeaturedMatchRetentionPin";
import {
  pinHoldArtifacts,
  unpinHoldArtifacts,
} from "../../src/scripts/replay-premiere-loop";
import type { CoworldLeagueEpisodeRow } from "../../src/server/agents/CoworldLeagueSiteWriter";

const EPISODE_REQUEST_ID = "ereq_matrix0001";
const PUBLIC_RUN_KEY = "league-coworld-matrix0001";
const PREMIERE_ID = "prem_matrix00000000001";
const MATCH_ID = "feat_matrix0001matrix";

let scratch: string;
let artifactsRoot: string;
let pinManifestPath: string;

function episode(): CoworldLeagueEpisodeRow {
  return {
    episodeRequestId: EPISODE_REQUEST_ID,
    shortId: "matrix01",
    roundNumber: 1,
    completedAt: "2026-07-17T10:00:00Z",
    map: "Pangaea",
    mapSize: "Compact",
    turnCount: 400,
    decisionCount: 10,
    degradedCount: 0,
    winnerName: "Auri",
    players: [],
    watchHref: `/ai-league-runs/${PUBLIC_RUN_KEY}/spectator.html`,
    fullRenderHref: `/ai-league-replay/${PUBLIC_RUN_KEY}`,
  };
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "retention-pin-ownership-matrix-"),
  );
  artifactsRoot = path.join(scratch, "artifacts");
  pinManifestPath = path.join(scratch, "retention-pins.json");
  const mirrorDir = path.join(artifactsRoot, "ai-league-runs", "league");
  await fs.mkdir(mirrorDir, { recursive: true });
  await fs.writeFile(
    path.join(mirrorDir, "data.json"),
    JSON.stringify({ episodes: [episode()] }),
    "utf8",
  );
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function pinHold(): Promise<void> {
  await pinHoldArtifacts(
    {
      publicRunKey: PUBLIC_RUN_KEY,
      episodeRequestId: EPISODE_REQUEST_ID,
      premiereId: PREMIERE_ID,
    },
    { pinManifestPath },
  );
}

async function unpinHold(): Promise<void> {
  await unpinHoldArtifacts(
    {
      publicRunKey: PUBLIC_RUN_KEY,
      episodeRequestId: EPISODE_REQUEST_ID,
      premiereId: PREMIERE_ID,
    },
    { pinManifestPath },
  );
}

async function pinFeatured(): Promise<boolean> {
  return syncFeaturedMatchRetentionPin(
    { matchId: MATCH_ID, episodeRequestId: EPISODE_REQUEST_ID },
    { artifactsRoot, pinManifestPath },
  );
}

async function unpinFeatured(): Promise<boolean> {
  return removeFeaturedMatchRetentionPin(MATCH_ID, {
    artifactsRoot,
    pinManifestPath,
  });
}

async function readOwnerTags(): Promise<string[]> {
  const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
  const pin = manifest.pins.find(
    (candidate) => candidate.episodeRequestId === EPISODE_REQUEST_ID,
  );
  return pin === undefined
    ? []
    : pin.reason.split(";").map((tag) => tag.trim());
}

const HOLD_TAG = `premiere-hold:${PREMIERE_ID}`;
const FEATURED_TAG = `featured-match:${MATCH_ID}`;

describe("retention pin cooperative ownership — full matrix", () => {
  it("order 1: hold pins, featured pins, featured releases first, hold releases last — survives until the last release, manifest ends empty", async () => {
    await pinHold();
    expect(await readOwnerTags()).toEqual([HOLD_TAG]);

    await pinFeatured();
    expect(await readOwnerTags()).toEqual(
      expect.arrayContaining([HOLD_TAG, FEATURED_TAG]),
    );

    await unpinFeatured();
    // Hold's own claim survives — artifact still protected.
    expect(await readOwnerTags()).toEqual([HOLD_TAG]);

    await unpinHold();
    expect(await readOwnerTags()).toEqual([]);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });

  it("order 2: hold pins, featured pins, hold releases first, featured releases last — survives until the last release, manifest ends empty", async () => {
    await pinHold();
    await pinFeatured();
    expect(await readOwnerTags()).toEqual(
      expect.arrayContaining([HOLD_TAG, FEATURED_TAG]),
    );

    await unpinHold();
    // Featured match's own claim survives — artifact still protected.
    expect(await readOwnerTags()).toEqual([FEATURED_TAG]);

    await unpinFeatured();
    expect(await readOwnerTags()).toEqual([]);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });

  it("order 3: featured pins, hold pins, featured releases first, hold releases last — survives until the last release, manifest ends empty", async () => {
    await pinFeatured();
    expect(await readOwnerTags()).toEqual([FEATURED_TAG]);

    await pinHold();
    expect(await readOwnerTags()).toEqual(
      expect.arrayContaining([HOLD_TAG, FEATURED_TAG]),
    );

    await unpinFeatured();
    expect(await readOwnerTags()).toEqual([HOLD_TAG]);

    await unpinHold();
    expect(await readOwnerTags()).toEqual([]);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });

  it("order 4: featured pins, hold pins, hold releases first, featured releases last — survives until the last release, manifest ends empty", async () => {
    await pinFeatured();
    await pinHold();
    expect(await readOwnerTags()).toEqual(
      expect.arrayContaining([HOLD_TAG, FEATURED_TAG]),
    );

    await unpinHold();
    expect(await readOwnerTags()).toEqual([FEATURED_TAG]);

    await unpinFeatured();
    expect(await readOwnerTags()).toEqual([]);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });

  it("idempotent double-pin per owner: pinning the same owner twice never duplicates its tag", async () => {
    await pinHold();
    await pinHold();
    expect(await readOwnerTags()).toEqual([HOLD_TAG]);

    const firstFeatured = await pinFeatured();
    const secondFeatured = await pinFeatured();
    expect(firstFeatured).toBe(true);
    expect(secondFeatured).toBe(false); // already owned — no-op
    const tags = await readOwnerTags();
    expect(tags.filter((tag) => tag === FEATURED_TAG)).toHaveLength(1);
  });

  it("idempotent double-release per owner: releasing an already-released owner is a safe no-op", async () => {
    await pinHold();
    await pinFeatured();

    await unpinFeatured();
    const removedAgain = await unpinFeatured();
    expect(removedAgain).toBe(false); // already gone — no-op, never throws
    // The hold's own tag is completely unaffected by the redundant release.
    expect(await readOwnerTags()).toEqual([HOLD_TAG]);

    await unpinHold();
    const unpinnedAgain = await unpinHold().then(() => true).catch(() => false);
    expect(unpinnedAgain).toBe(true); // unpinHoldArtifacts never throws either
    expect(await readOwnerTags()).toEqual([]);
  });

  it("a solo owner (only one ever pins) still round-trips to an empty manifest on its own release", async () => {
    await pinFeatured();
    expect(await readOwnerTags()).toEqual([FEATURED_TAG]);
    await unpinFeatured();
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });
});
