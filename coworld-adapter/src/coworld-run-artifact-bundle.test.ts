import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coworldInlineRunArtifacts,
  coworldPublicReplayPayload,
} from "./coworld-run-artifact-bundle.ts";

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
    fs.writeFile(
      paths.summaryPath,
      '{"decisionCount":1,"runtimeModes":{"local-policy-baseline":1}}\n',
    ),
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
      "deal-ledger.json",
      "match-summary.json",
      "spectator-telemetry.json",
    ]);
    expect(artifacts["deal-ledger.json"]).toBe(
      '{"schemaVersion":1,"deals":[],"events":[]}\n',
    );
  });

  it("keeps private decisions server-side when deals are disabled", async () => {
    const paths = await artifactPaths(false);
    const artifacts = await coworldInlineRunArtifacts({
      gameRecord: { info: { gameID: "NO_DEALS" } },
      artifacts: paths,
    });

    expect(Object.keys(artifacts)).toEqual([
      "game-record.json",
      "match-summary.json",
      "spectator-telemetry.json",
    ]);
    expect(artifacts).not.toHaveProperty("deal-ledger.json");
    expect(artifacts).not.toHaveProperty("decisions.jsonl");
    expect(JSON.parse(artifacts["match-summary.json"])).toMatchObject({
      runtimeModes: { "local-policy-baseline": 1 },
    });
    expect(await fs.readFile(paths.decisionsPath, "utf8")).toBe(
      '{"sequence":1}\n',
    );
  });

  it("strips private and unknown inline artifacts from legacy viewer replays", () => {
    const projected = coworldPublicReplayPayload({
      schemaVersion: 1,
      config: {
        players: ["one", "two"],
        tokens: ["private-token-one", "private-token-two"],
      },
      inlineRunArtifacts: {
        "game-record.json": '{"messages":[]}',
        "deal-ledger.json": '{"deals":[]}',
        "decisions.jsonl":
          '{"rawLlmPrompt":"private-prompt","rawLlmOutput":"private-output"}\n',
        "provider-output.json": '{"completion":"private-provider-output"}',
      },
    }) as Record<string, unknown>;

    expect(projected.config).toEqual({
      players: ["one", "two"],
      player_count: 2,
    });
    expect(projected.inlineRunArtifacts).toEqual({
      "game-record.json": '{"messages":[]}',
      "deal-ledger.json": '{"deals":[]}',
    });
    expect(JSON.stringify(projected)).not.toContain("private-");
  });

  it("sanitizes legacy inline artifacts even when the replay has no config", () => {
    expect(
      coworldPublicReplayPayload({
        inlineRunArtifacts: {
          "match-summary.json": '{"decisionCount":1}',
          "decisions.jsonl": '{"rawLlmPrompt":"private"}\n',
        },
      }),
    ).toEqual({
      inlineRunArtifacts: {
        "match-summary.json": '{"decisionCount":1}',
      },
    });
  });
});
