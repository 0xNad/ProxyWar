import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const MODULE_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "testing",
  "run-social-matrix.mjs",
);

async function runnerModule() {
  return (await import(pathToFileURL(MODULE_FILE).href)) as {
    validateMatrixInputs: (input: Record<string, unknown[]>) => void;
    validateCachedRun: (
      run: Record<string, any>,
      cell: Record<string, unknown>,
      expected: Record<string, number>,
    ) => Promise<void>;
  };
}

describe("social matrix runner validation", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("rejects duplicate axes before constructing a run plan", async () => {
    const { validateMatrixInputs } = await runnerModule();
    expect(() =>
      validateMatrixInputs({
        seeds: [424242, 424242],
        maps: ["Pangaea"],
        episodeIndices: [0],
        arms: ["active"],
      }),
    ).toThrow("social matrix seeds must not contain duplicates");
  });

  it("revalidates cached coordinates, expected game identity, and every artifact hash", async () => {
    const { validateCachedRun } = await runnerModule();
    const root = await mkdtemp(path.join(os.tmpdir(), "social-cache-"));
    temporaryRoots.push(root);
    const artifactPaths: Record<string, string | null> = {};
    const hashes: Record<string, string | null> = {};
    for (const key of [
      "config",
      "results",
      "replay",
      "decisions",
      "telemetry",
    ]) {
      const file = path.join(root, `${key}.json`);
      const value = `${key}\n`;
      await writeFile(file, value);
      artifactPaths[key] = file;
      hashes[key] = crypto.createHash("sha256").update(value).digest("hex");
    }
    artifactPaths.dealLedger = null;
    hashes.dealLedger = null;
    const cell = {
      seed: 424242,
      map: "Europe",
      episodeIndex: 0,
      arm: "off",
    };
    const cached = {
      ...cell,
      gameID: "PWSAYDPA",
      resultSeed: 424242,
      maxDecisionSteps: 30,
      turnsPerDecisionStep: 25,
      artifactPaths,
      sha256: hashes,
    };
    await expect(
      validateCachedRun(cached, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).resolves.toBeUndefined();

    const missingRequiredHash = structuredClone(cached);
    missingRequiredHash.sha256.config = null;
    await expect(
      validateCachedRun(missingRequiredHash, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).rejects.toThrow("cached config hash missing");

    const missingActiveLedger = structuredClone(cached);
    missingActiveLedger.arm = "active";
    await expect(
      validateCachedRun(
        missingActiveLedger,
        { ...cell, arm: "active" },
        {
          maxDecisionSteps: 30,
          turnsPerDecisionStep: 25,
        },
      ),
    ).rejects.toThrow("cached dealLedger hash missing");

    await writeFile(artifactPaths.results!, "tampered\n");
    await expect(
      validateCachedRun(cached, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).rejects.toThrow("cached results hash mismatch");
  });
});
