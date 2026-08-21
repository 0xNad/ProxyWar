import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findPlayerStats,
  readAgentStatsArtifact,
} from "../../src/server/agents/AgentStatsArtifact";

function validSlice() {
  return {
    episodeCount: 3,
    fingerprint: {
      aggression: null,
      diplomacyInitiated: null,
      economicFocus: null,
      territory: {
        share: null,
        absoluteTiles: { mean: 42, sampleSize: 3 },
        meanRank: { value: 1.5, sampleSize: 3 },
      },
      armyStrength: null,
      reliability: null,
    },
    social: {
      alliancesInitiated: null,
      allianceAcceptanceRate: null,
      betrayalCount: null,
      frequentAllies: [{ name: "Ally", count: 2 }],
      primaryAdversaries: [{ name: "Rival", count: 4 }],
      treatyDuration: null,
    },
  };
}

async function writeArtifact(value: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-stats-artifact-"));
  const filePath = path.join(root, "agent-stats.json");
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

describe("AgentStatsArtifact", () => {
  it("accepts a valid artifact and finds a player by exact name", async () => {
    const artifact = {
      schemaVersion: 1,
      generatedAt: "2026-08-21T17:00:00.000Z",
      episodesScanned: 3,
      players: [
        {
          playerName: "Builder Agent",
          career: validSlice(),
          currentVersion: {
            ...validSlice(),
            versionLabel: "v2",
          },
        },
      ],
    };

    const parsed = await readAgentStatsArtifact(await writeArtifact(artifact));

    expect(parsed).not.toBeNull();
    expect(findPlayerStats(parsed, "Builder Agent")?.currentVersion?.versionLabel).toBe(
      "v2",
    );
    expect(findPlayerStats(parsed, "builder agent")).toBeNull();
  });

  it("rejects parse-valid player rows that would crash stats consumers", async () => {
    const malformed = {
      schemaVersion: 1,
      generatedAt: "2026-08-21T17:00:00.000Z",
      episodesScanned: 3,
      players: [
        {
          playerName: "Builder Agent",
          career: {},
          currentVersion: null,
        },
      ],
    };

    expect(
      await readAgentStatsArtifact(await writeArtifact(malformed)),
    ).toBeNull();
  });

  it("rejects malformed nested metrics instead of exposing invalid data", async () => {
    const career = validSlice();
    const malformed = {
      schemaVersion: 1,
      generatedAt: "2026-08-21T17:00:00.000Z",
      episodesScanned: 3,
      players: [
        {
          playerName: "Builder Agent",
          career: {
            ...career,
            social: {
              ...career.social,
              frequentAllies: [{ name: "Ally", count: "two" }],
            },
          },
          currentVersion: null,
        },
      ],
    };

    expect(
      await readAgentStatsArtifact(await writeArtifact(malformed)),
    ).toBeNull();
  });

  it("degrades missing and malformed JSON files to null", async () => {
    expect(
      await readAgentStatsArtifact("/definitely/missing/agent-stats.json"),
    ).toBeNull();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-stats-artifact-"));
    const filePath = path.join(root, "agent-stats.json");
    await fs.writeFile(filePath, "{not-json", "utf8");

    expect(await readAgentStatsArtifact(filePath)).toBeNull();
  });
});
