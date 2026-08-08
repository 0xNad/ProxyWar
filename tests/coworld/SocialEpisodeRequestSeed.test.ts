import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const generator = path.join(
  repoRoot,
  "coworld-adapter/testing/make-social-episode-request.mjs",
);
const manifest = path.join(
  repoRoot,
  "coworld-adapter/coworld/coworld_manifest.json",
);

describe("social episode request seed provenance", () => {
  let outputRoot: string;

  beforeEach(async () => {
    outputRoot = await mkdtemp(path.join(os.tmpdir(), "proxywar-social-seed-"));
  });

  afterEach(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  it("writes the requested simulation seed into config and immutable tags", async () => {
    const output = path.join(outputRoot, "active.json");
    execFileSync(
      process.execPath,
      [generator, manifest, "active", output, "30", "424242"],
      { cwd: repoRoot, stdio: "pipe" },
    );

    const request = JSON.parse(await readFile(output, "utf8"));
    expect(request.game_config).toMatchObject({
      seed: 424242,
      episodeIndex: 0,
      max_decision_steps: 30,
    });
    expect(request.episode_tags).toMatchObject({
      experiment_id: "social-seed-424242",
      seed: "424242",
    });
  });
});
