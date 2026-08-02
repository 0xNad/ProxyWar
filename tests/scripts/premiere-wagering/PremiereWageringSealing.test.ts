import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PREMIERE_WAGERING_SEALED_MANIFEST_FILE,
  PremiereWageringSealingError,
  sealPremiereWageringEpisode,
} from "../../../src/scripts/premiere-wagering/PremiereWageringSealing";

let root: string;

beforeEach(async () => {
  const realTemporaryRoot = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(path.join(realTemporaryRoot, "premiere-wagering-seal-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeBundle(
  dirName: string,
  overrides: { runID?: string; numTurns?: number } = {},
): Promise<string> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const matchSummary = {
    runID: overrides.runID ?? "coworld-2026-07-26T20-00-00-000Z-cafebabe",
    matchID: "COWRLD01",
    roster: [{ agentID: "a1", username: "one" }],
  };
  const gameRecord = {
    info: {
      gameID: "COWRLD01",
      num_turns: overrides.numTurns ?? 10500,
      config: { gameMap: "Pangaea", gameType: "Private", randomSpawn: false },
    },
  };
  await Promise.all([
    fs.writeFile(path.join(dir, "decisions.jsonl"), '{"sequence":1}\n'),
    fs.writeFile(path.join(dir, "game-record.json"), JSON.stringify(gameRecord)),
    fs.writeFile(path.join(dir, "match-summary.json"), JSON.stringify(matchSummary)),
    fs.writeFile(
      path.join(dir, "spectator-replay.json"),
      JSON.stringify({ runID: overrides.runID ?? "coworld-x" }),
    ),
  ]);
  return dir;
}

const NOW = () => new Date("2026-07-26T21:00:00.000Z");

describe("sealPremiereWageringEpisode", () => {
  test("seals a declared xp-request bundle, writing the manifest with correct checkpoints", async () => {
    const dir = await writeBundle("xpreq-coworld-fixture-1");
    const result = await sealPremiereWageringEpisode({
      bundleDir: dir,
      declaredSource: "xp_request",
      skipAlreadyPremieredCheck: true,
      now: NOW,
    });
    expect(result.manifest.sealed).toBe(true);
    expect(result.manifest.provenance.source).toBe("xp_request");
    expect(result.manifest.alreadyPremiered).toBe(false);
    expect(result.manifest.spawnPhaseTurns).toBe(300);
    expect(result.manifest.checkpointTurns).toEqual([3870, 6930]);
    expect(result.manifest.sealedAt).toBe("2026-07-26T21:00:00.000Z");
    const onDisk = JSON.parse(
      await fs.readFile(result.manifestPath, "utf8"),
    );
    expect(onDisk.sealed).toBe(true);
    expect(path.basename(result.manifestPath)).toBe(
      PREMIERE_WAGERING_SEALED_MANIFEST_FILE,
    );
  });

  test("refuses a bundle whose directory name matches the public-league mirror's managed pattern", async () => {
    const dir = await writeBundle("league-coworld-fixture-2");
    await expect(
      sealPremiereWageringEpisode({
        bundleDir: dir,
        declaredSource: "xp_request", // even declared xp-request — the pattern wins
        skipAlreadyPremieredCheck: true,
        now: NOW,
      }),
    ).rejects.toThrow(PremiereWageringSealingError);
    // No manifest should have been written for a refused seal.
    await expect(
      fs.access(path.join(dir, PREMIERE_WAGERING_SEALED_MANIFEST_FILE)),
    ).rejects.toThrow();
  });

  test("refuses a bundle with no declared source and a non-managed directory name", async () => {
    const dir = await writeBundle("mystery-bundle-3");
    await expect(
      sealPremiereWageringEpisode({
        bundleDir: dir,
        skipAlreadyPremieredCheck: true,
        now: NOW,
      }),
    ).rejects.toThrow(PremiereWageringSealingError);
  });

  test("forceUnsafeSeal overrides the refusal but the manifest still records the true unsafe provenance", async () => {
    const dir = await writeBundle("league-coworld-fixture-4");
    const result = await sealPremiereWageringEpisode({
      bundleDir: dir,
      forceUnsafeSeal: true,
      skipAlreadyPremieredCheck: true,
      now: NOW,
    });
    expect(result.manifest.sealed).toBe(true);
    expect(result.manifest.provenance.source).toBe("public_league_mirror");
    expect(result.manifest.provenance.reason).toMatch(/Observatory already publishes/);
  });

  test("a bundle is sealed exactly once — a second attempt refuses rather than overwriting", async () => {
    const dir = await writeBundle("xpreq-coworld-fixture-5");
    await sealPremiereWageringEpisode({
      bundleDir: dir,
      declaredSource: "xp_request",
      skipAlreadyPremieredCheck: true,
      now: NOW,
    });
    await expect(
      sealPremiereWageringEpisode({
        bundleDir: dir,
        declaredSource: "xp_request",
        skipAlreadyPremieredCheck: true,
        now: NOW,
      }),
    ).rejects.toThrow(/already exists/);
  });

  test("missing archive on disk fails open to 'not yet premiered' rather than erroring", async () => {
    const dir = await writeBundle("xpreq-coworld-fixture-6");
    const result = await sealPremiereWageringEpisode({
      bundleDir: dir,
      declaredSource: "xp_request",
      privateStateRoot: path.join(root, "nonexistent-state-root"),
      now: NOW,
    });
    expect(result.manifest.alreadyPremiered).toBe(false);
    expect(result.manifest.sealed).toBe(true);
  });
});
