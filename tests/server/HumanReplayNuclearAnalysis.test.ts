import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { HumanReplayRecord } from "../../src/server/agents/HumanReplayAnalysis";
import {
  buildHumanReplayNuclearReport,
  writeHumanReplayNuclearArtifacts,
} from "../../src/server/agents/HumanReplayNuclearAnalysis";

describe("HumanReplayNuclearAnalysis", () => {
  it("extracts nuclear timing and winner deterrence profile", () => {
    const report = buildHumanReplayNuclearReport({
      records: [sampleNuclearReplayRecord()],
      generatedAt: Date.UTC(2026, 0, 1),
    });

    expect(report.gameCount).toBe(1);
    expect(report.nuclearEventCount).toBe(5);
    expect(report.units["Missile Silo"]).toMatchObject({
      count: 2,
      firstMinuteP50: 5,
      winnerFirstMinuteP50: 5,
    });
    expect(report.units["SAM Launcher"]).toMatchObject({
      count: 1,
      firstMinuteP50: 6,
      winnerFirstMinuteP50: 6,
    });
    expect(report.units["Hydrogen Bomb"]).toMatchObject({
      count: 1,
      firstMinuteP50: 9,
      winnerFirstMinuteP50: 9,
    });
    expect(report.winners).toMatchObject({
      count: 1,
      withSiloShare: 1,
      withSamShare: 1,
      withNukeShare: 1,
      medianFirstSiloMinute: 5,
      medianFirstSamMinute: 6,
      medianFirstNukeMinute: 8,
    });
    expect(report.agentRecommendations.join(" ")).toContain("missile silo");
    expect(report.agentRecommendations.join(" ")).toContain("SAM");
  });

  it("writes nuclear JSON and Markdown artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nuclear-"));
    const paths = await writeHumanReplayNuclearArtifacts({
      records: [sampleNuclearReplayRecord()],
      directory,
      generatedAt: Date.UTC(2026, 0, 1),
    });

    const json = JSON.parse(await fs.readFile(paths.jsonPath, "utf8"));
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    expect(json.schemaVersion).toBe(1);
    expect(markdown).toContain("Human Nuclear Replay Report");
    expect(markdown).toContain("Agent Recommendations");
  });
});

function sampleNuclearReplayRecord(): HumanReplayRecord {
  return {
    version: "v0.0.2",
    domain: "openfront.io",
    info: {
      gameID: "nuclear-sample",
      duration: 1_200,
      num_turns: 12_000,
      winner: ["player", "winner-client"],
      players: [
        {
          clientID: "winner-client",
          username: "Winner",
          stats: {
            bombs: {
              abomb: ["1", "1"],
              hbomb: ["1", "1"],
            },
            gold: ["100", "200", "300"],
            units: {
              city: ["4"],
              fact: ["2"],
              port: ["1"],
              silo: ["1"],
              saml: ["1"],
            },
          },
        },
        {
          clientID: "rival-client",
          username: "Rival",
          stats: {
            bombs: {
              abomb: ["1"],
            },
            units: {
              silo: ["1"],
            },
          },
        },
      ],
    },
    turns: [
      {
        turnNumber: 3_000,
        intents: [
          {
            type: "build_unit",
            clientID: "winner-client",
            unit: "Missile Silo",
            tile: 101,
          },
        ],
      },
      {
        turnNumber: 3_600,
        intents: [
          {
            type: "build_unit",
            clientID: "winner-client",
            unit: "SAM Launcher",
            tile: 102,
          },
        ],
      },
      {
        turnNumber: 4_800,
        intents: [
          {
            type: "build_unit",
            clientID: "winner-client",
            unit: "Atom Bomb",
            tile: 201,
          },
          {
            type: "build_unit",
            clientID: "rival-client",
            unit: "Missile Silo",
            tile: 301,
          },
        ],
      },
      {
        turnNumber: 5_400,
        intents: [
          {
            type: "build_unit",
            clientID: "winner-client",
            unit: "Hydrogen Bomb",
            tile: 202,
          },
        ],
      },
    ],
  };
}
