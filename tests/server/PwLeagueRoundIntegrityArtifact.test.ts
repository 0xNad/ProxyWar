import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("builds the exact tested detector as a standalone sentinel-importable module", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "proxywar-round-integrity-artifact-"),
  );
  temporaryDirectories.push(directory);
  const outputPath = path.join(directory, "pw-league-round-integrity.mjs");
  const scriptPath = path.resolve(
    "scripts/build-pw-league-round-integrity.mjs",
  );
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--output",
    outputPath,
  ]);
  expect(JSON.parse(stdout)).toMatchObject({
    outputPath,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });

  const settings = {
    expectedEpisodesPerRound: 25,
    roundIntervalMinutes: 25,
    allowedFailureRate: 0.05,
    allowedFailureCount: 1,
  };
  const rows = Array.from({ length: 25 }, (_, index) =>
    index < 11
      ? {
          id: `ereq_${index}`,
          round_id: "round_1897",
          status: "completed",
          episode_id: `episode_${index}`,
          running_at: "2026-08-21T19:15:31.000Z",
          error: null,
          policy_version_ids: [`policy_${index}`],
          scores: [{ policy_version_id: `policy_${index}`, score: 1 }],
        }
      : {
          id: `ereq_${index}`,
          round_id: "round_1897",
          status: "completed",
          episode_id: null,
          running_at: null,
          error: null,
          policy_version_ids: [`policy_${index}`],
          scores: [],
        },
  );
  const round = {
    id: "round_1897",
    round_number: 1897,
    status: "completed",
    completed_at: "2026-08-21T19:19:43.947983Z",
  };
  // Execute in a plain Node ESM process, the same runtime boundary the
  // machine-local sentinel uses (Vitest rewrites dynamic imports itself).
  const smokeSource = [
    `import * as detector from ${JSON.stringify(pathToFileURL(outputPath).href)};`,
    `const evaluation = detector.evaluateCoworldRoundIntegrity(${JSON.stringify({ round, episodeRows: rows, settings })});`,
    `if (evaluation.kind !== "assessed") throw new Error("expected assessment");`,
    `process.stdout.write(JSON.stringify({assessment:evaluation.assessment,signal:detector.coworldRoundIntegrityCriticalSignal(evaluation.assessment)}));`,
  ].join("\n");
  const smoke = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        smokeSource,
      ])
    ).stdout,
  );
  expect(smoke.assessment).toMatchObject({
    scoreBearingCount: 11,
    effectiveFailureCount: 14,
    phantomFailureCount: 14,
    verdict: "breach",
  });
  expect(smoke.signal).toMatchObject({
    class: "round_incomplete_execution",
    key: "round_1897",
    severity: "critical",
  });
});
