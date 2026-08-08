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
    ) => Promise<Record<string, any>>;
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
    const values: Record<string, string> = {
      config: `${JSON.stringify({
        seed: 424242,
        map: "Europe",
        episodeIndex: 0,
        max_decision_steps: 30,
        turns_per_decision_step: 25,
        players: ["keeper", "defector", "skeptic", "deal blind"].map(
          (name) => ({ name: `Social ${name}` }),
        ),
      })}\n`,
      results: `${JSON.stringify({
        game_id: "PWSAYDPA",
        seed: 424242,
        scores: [1, 0, 0, 0],
        winner_slot: 0,
        decision_count: 1,
        accepted_decision_count: 1,
        fallback_count: 0,
        degraded_count: 0,
      })}\n`,
      replay: `${JSON.stringify({
        matchID: "PWSAYDPA",
        results: { game_id: "PWSAYDPA", seed: 424242 },
      })}\n`,
      decisions: `${JSON.stringify({
        username: "Social keeper",
        turnNumber: 25,
        selectedLegalActionId: "hold",
        selectedActionKind: "hold",
        result: { accepted: true },
        fallbackUsed: false,
        llmPlannerDegraded: false,
        legalActionIDsByKind: {},
      })}\n`,
      telemetry: "{}\n",
    };
    const artifactPaths: Record<string, string | null> = {};
    const hashes: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) {
      const file = path.join(root, `${key}.json`);
      await writeFile(file, value);
      artifactPaths[key] = file;
      hashes[key] = crypto.createHash("sha256").update(value).digest("hex");
    }
    artifactPaths.dealLedger = null;
    hashes.dealLedger = null;
    values.replay = `${JSON.stringify({
      matchID: "PWSAYDPA",
      results: { game_id: "PWSAYDPA", seed: 424242 },
      proxyWarArtifacts: {
        decisionsPath: artifactPaths.decisions,
        spectatorTelemetryPath: artifactPaths.telemetry,
      },
    })}\n`;
    await writeFile(artifactPaths.replay!, values.replay);
    hashes.replay = crypto
      .createHash("sha256")
      .update(values.replay)
      .digest("hex");
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
      byProfile: { keeper: { obligations: { fulfilled: 999 } } },
      nonInterferenceSignature: "forged",
    };
    const rebuilt = await validateCachedRun(cached, cell, {
      maxDecisionSteps: 30,
      turnsPerDecisionStep: 25,
    });
    expect(rebuilt.byProfile.keeper.obligations.fulfilled).toBe(0);
    expect(rebuilt.nonInterferenceSignature).not.toBe("forged");

    async function cachedWithArtifact(
      key: "config" | "results" | "replay",
      value: string,
    ) {
      await writeFile(artifactPaths[key]!, value);
      const next = structuredClone(cached);
      next.sha256[key] = crypto
        .createHash("sha256")
        .update(value)
        .digest("hex");
      return next;
    }

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

    const mismatchedConfig = `${JSON.stringify({
      ...JSON.parse(values.config),
      seed: 1,
    })}\n`;
    const configMismatch = await cachedWithArtifact("config", mismatchedConfig);
    await expect(
      validateCachedRun(configMismatch, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).rejects.toThrow("cached config mismatch");
    await writeFile(artifactPaths.config!, values.config);

    const mismatchedResults = `${JSON.stringify({
      ...JSON.parse(values.results),
      seed: 1,
    })}\n`;
    const resultsMismatch = await cachedWithArtifact(
      "results",
      mismatchedResults,
    );
    await expect(
      validateCachedRun(resultsMismatch, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).rejects.toThrow("cached results provenance mismatch");
    await writeFile(artifactPaths.results!, values.results);

    const mismatchedReplay = `${JSON.stringify({
      ...JSON.parse(values.replay),
      matchID: "PWSAAAAA",
    })}\n`;
    const replayMismatch = await cachedWithArtifact("replay", mismatchedReplay);
    await expect(
      validateCachedRun(replayMismatch, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).rejects.toThrow("cached replay provenance mismatch");
    await writeFile(artifactPaths.replay!, values.replay);

    await writeFile(artifactPaths.results!, "tampered\n");
    await expect(
      validateCachedRun(cached, cell, {
        maxDecisionSteps: 30,
        turnsPerDecisionStep: 25,
      }),
    ).rejects.toThrow("cached results hash mismatch");
  });
});
