import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coworldInlineRunArtifacts } from "./coworld-run-artifact-bundle.ts";

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function artifactPaths(includeLedger: boolean) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "coworld-run-artifacts-"),
  );
  scratchDirs.push(directory);
  const paths = {
    decisionsPath: path.join(directory, "decisions.jsonl"),
    summaryPath: path.join(directory, "match-summary.json"),
    spectatorTelemetryPath: path.join(directory, "spectator-telemetry.json"),
    ...(includeLedger
      ? { dealLedgerPath: path.join(directory, "deal-ledger.json") }
      : {}),
  };
  await Promise.all([
    fs.writeFile(paths.decisionsPath, '{"sequence":1}\n'),
    fs.writeFile(paths.summaryPath, '{"decisionCount":1}\n'),
    fs.writeFile(paths.spectatorTelemetryPath, '{"events":[]}\n'),
    ...(paths.dealLedgerPath === undefined
      ? []
      : [
          fs.writeFile(
            paths.dealLedgerPath,
            '{"schemaVersion":1,"deals":[],"events":[]}\n',
          ),
        ]),
  ]);
  return paths;
}

describe("Coworld inline run-artifact bundle", () => {
  it("includes the finalized deal ledger as its own replay artifact", async () => {
    const artifacts = await coworldInlineRunArtifacts({
      gameRecord: { info: { gameID: "DEAL_BUNDLE" } },
      artifacts: await artifactPaths(true),
    });

    expect(Object.keys(artifacts)).toEqual([
      "game-record.json",
      "decisions.jsonl",
      "deal-ledger.json",
      "match-summary.json",
      "spectator-telemetry.json",
    ]);
    expect(artifacts["deal-ledger.json"]).toBe(
      '{"schemaVersion":1,"deals":[],"events":[]}\n',
    );
  });

  it("keeps the deals-off bundle byte-shape unchanged", async () => {
    const artifacts = await coworldInlineRunArtifacts({
      gameRecord: { info: { gameID: "NO_DEALS" } },
      artifacts: await artifactPaths(false),
    });

    expect(Object.keys(artifacts)).toEqual([
      "game-record.json",
      "decisions.jsonl",
      "match-summary.json",
      "spectator-telemetry.json",
    ]);
    expect(artifacts).not.toHaveProperty("deal-ledger.json");
  });
});
