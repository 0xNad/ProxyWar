import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  removeFeaturedMatchRetentionPin,
  syncFeaturedMatchRetentionPin,
} from "../../src/server/agents/FeaturedMatchRetentionPin";
import { readCoworldLeagueRetentionPinManifest } from "../../src/server/agents/CoworldLeagueArtifactRetention";
import type { CoworldLeagueEpisodeRow } from "../../src/server/agents/CoworldLeagueSiteWriter";

let scratch: string;
let artifactsRoot: string;
let pinManifestPath: string;

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

async function seedMirrorEpisodes(
  episodes: CoworldLeagueEpisodeRow[],
): Promise<void> {
  const dir = path.join(artifactsRoot, "ai-league-runs", "league");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "data.json"),
    JSON.stringify({ episodes }),
    "utf8",
  );
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), "featured-match-retention-pin-"),
  );
  artifactsRoot = path.join(scratch, "artifacts");
  pinManifestPath = path.join(scratch, "retention-pins.json");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

const options = () => ({ artifactsRoot, pinManifestPath });

describe("syncFeaturedMatchRetentionPin", () => {
  it("no-ops when episodeRequestId is null", async () => {
    const changed = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: null },
      options(),
    );
    expect(changed).toBe(false);
    await expect(fs.access(pinManifestPath)).rejects.toThrow();
  });

  it("no-ops when the mirror has no data.json yet (episode not derivable)", async () => {
    const changed = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    expect(changed).toBe(false);
  });

  it("no-ops when the mirror exists but has no matching episode", async () => {
    await seedMirrorEpisodes([episode("ereq_other", "league-coworld-other")]);
    const changed = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    expect(changed).toBe(false);
  });

  it("writes a fresh pin once the episode is derivable from the mirror", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    const changed = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    expect(changed).toBe(true);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([
      {
        episodeRequestId: "ereq_x",
        publicRunKey: "league-coworld-abc",
        reason: "featured-match:feat_x",
      },
    ]);
  });

  it("is idempotent — a second sync with the same match is a no-op", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    const changed = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    expect(changed).toBe(false);
  });

  it("appends its tag to an existing pin from another owner (e.g. a live premiere hold) rather than creating a duplicate entry", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    // Simulate a pre-existing premiere-hold pin, exactly as
    // replay-premiere-loop.ts's own pinHoldArtifacts would have written.
    await fs.mkdir(path.dirname(pinManifestPath), { recursive: true });
    await fs.writeFile(
      pinManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pins: [
          {
            episodeRequestId: "ereq_x",
            publicRunKey: "league-coworld-abc",
            reason: "premiere-hold:prem_abc",
          },
        ],
      }),
      "utf8",
    );

    const changed = await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    expect(changed).toBe(true);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toHaveLength(1);
    expect(manifest.pins[0].reason).toBe(
      "featured-match:feat_x;premiere-hold:prem_abc",
    );
  });

  it("cooperative ownership survives the OTHER owner's own removal logic (mirrors unpinHoldArtifacts' startsWith('premiere-hold') filter)", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    await fs.mkdir(path.dirname(pinManifestPath), { recursive: true });
    await fs.writeFile(
      pinManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pins: [
          {
            episodeRequestId: "ereq_x",
            publicRunKey: "league-coworld-abc",
            reason: "premiere-hold:prem_abc",
          },
        ],
      }),
      "utf8",
    );
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );

    // Simulate replay-premiere-loop.ts's unpinHoldArtifacts firing on hold
    // release: it only strips a pin whose reason STARTS WITH
    // "premiere-hold" for this episodeRequestId. After the append above,
    // the combined reason no longer satisfies that prefix check.
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    const PREMIERE_PIN_REASON_PREFIX = "premiere-hold";
    const remaining = manifest.pins.filter(
      (pin) =>
        !(
          pin.episodeRequestId === "ereq_x" &&
          pin.reason.startsWith(PREMIERE_PIN_REASON_PREFIX)
        ),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].reason).toContain("featured-match:feat_x");
  });
});

describe("removeFeaturedMatchRetentionPin", () => {
  it("no-ops when no pin exists at all", async () => {
    const changed = await removeFeaturedMatchRetentionPin("feat_x", options());
    expect(changed).toBe(false);
  });

  it("removes the whole pin entry when it is the only owner", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    const changed = await removeFeaturedMatchRetentionPin("feat_x", options());
    expect(changed).toBe(true);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([]);
  });

  it("strips only its own tag when the pin is co-owned, leaving the other owner's protection intact", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    await fs.mkdir(path.dirname(pinManifestPath), { recursive: true });
    await fs.writeFile(
      pinManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        pins: [
          {
            episodeRequestId: "ereq_x",
            publicRunKey: "league-coworld-abc",
            reason: "premiere-hold:prem_abc",
          },
        ],
      }),
      "utf8",
    );
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );

    const changed = await removeFeaturedMatchRetentionPin("feat_x", options());
    expect(changed).toBe(true);
    const manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toEqual([
      {
        episodeRequestId: "ereq_x",
        publicRunKey: "league-coworld-abc",
        reason: "premiere-hold:prem_abc",
      },
    ]);
  });

  it("never deletes any artifact directly — only ever writes the pin manifest JSON", async () => {
    await seedMirrorEpisodes([episode("ereq_x", "league-coworld-abc")]);
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_x", episodeRequestId: "ereq_x" },
      options(),
    );
    const runDir = path.join(artifactsRoot, "ai-league-runs", "league");
    const beforeEntries = await fs.readdir(runDir);
    await removeFeaturedMatchRetentionPin("feat_x", options());
    const afterEntries = await fs.readdir(runDir);
    expect(afterEntries).toEqual(beforeEntries);
  });

  it("full round trip stays schema-valid throughout (readable by readCoworldLeagueRetentionPinManifest, which validates on read)", async () => {
    await seedMirrorEpisodes([
      episode("ereq_a", "league-coworld-aaa"),
      episode("ereq_b", "league-coworld-bbb"),
    ]);
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_a", episodeRequestId: "ereq_a" },
      options(),
    );
    await syncFeaturedMatchRetentionPin(
      { matchId: "feat_b", episodeRequestId: "ereq_b" },
      options(),
    );
    let manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toHaveLength(2);

    await removeFeaturedMatchRetentionPin("feat_a", options());
    manifest = await readCoworldLeagueRetentionPinManifest(pinManifestPath);
    expect(manifest.pins).toHaveLength(1);
    expect(manifest.pins[0].episodeRequestId).toBe("ereq_b");
  });
});
