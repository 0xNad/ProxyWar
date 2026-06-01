import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildHumanReplayAnalysis,
  buildHumanReplayCorpusReport,
  HumanReplayRecord,
  openFrontReplayUrl,
  productionWorkerPath,
  writeHumanReplayAnalysisArtifacts,
  writeHumanReplayCorpusArtifacts,
} from "../../src/server/agents/HumanReplayAnalysis";

describe("HumanReplayAnalysis", () => {
  it("ranks the winner first and extracts human tactic timing", () => {
    const report = buildHumanReplayAnalysis({
      record: sampleReplayRecord(),
      generatedAt: Date.UTC(2026, 0, 1),
      topCandidateCount: 2,
    });

    expect(report.gameID).toBe("human-sample");
    expect(report.winner).toMatchObject({
      username: "Winner",
      winner: true,
      rank: 1,
    });
    expect(report.topCandidates.map((player) => player.username)).toEqual([
      "Winner",
      "Pressure",
    ]);
    expect(
      report.topCandidates[0].actionProfile.firstActionMinute,
    ).toMatchObject({
      attack: 0.5,
      boat: 0.8,
      build_unit: 1.8,
    });
    expect(
      report.topCandidates[0].actionProfile.phaseCounts.opening,
    ).toMatchObject({
      attack: 2,
      boat: 1,
      build_unit: 1,
    });
    expect(report.topCandidates[0].tacticTags).toContain("fast_opening");
    expect(report.topCandidates[0].tacticTags).toContain("trade_economy");
    expect(report.topCandidates[0].tacticTags).toContain("targeted_pressure");
    expect(report.humanBaselines).toMatchObject({
      topPlayerCount: 2,
      medianFirstAttackMinute: 0.5,
      medianFirstBoatMinute: 0.9,
      medianOpeningAttackCount: 1.5,
    });
    expect(report.tacticSignals.map((signal) => signal.tacticID)).toContain(
      "transport_troop_banking",
    );
    expect(report.skillGuidelineCandidates[0].guideline).toContain("opening");
    expect(report.replay.exactFinalLeaderboardAvailable).toBe(false);
  });

  it("writes JSON and Markdown artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "human-replay-"));
    const paths = await writeHumanReplayAnalysisArtifacts({
      record: sampleReplayRecord(),
      directory,
      generatedAt: Date.UTC(2026, 0, 1),
    });

    const json = JSON.parse(await fs.readFile(paths.jsonPath, "utf8"));
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    expect(json.winner.username).toBe("Winner");
    expect(markdown).toContain("Human Replay Analysis: human-sample");
    expect(markdown).toContain("Top Human Candidates");
    expect(markdown).toContain("LLM Review Packet");
  });

  it("builds a corpus report with replay link generation details", async () => {
    const analysis = buildHumanReplayAnalysis({
      record: sampleReplayRecord(),
      generatedAt: Date.UTC(2026, 0, 1),
      topCandidateCount: 2,
    });
    const report = buildHumanReplayCorpusReport({
      corpusID: "sample-corpus",
      source: "test",
      analyses: [analysis],
      generatedAt: Date.UTC(2026, 0, 1),
    });

    expect(productionWorkerPath("human-sample")).toMatch(/^w\d+$/);
    expect(openFrontReplayUrl("human-sample")).toContain(
      "/game/human-sample?replay",
    );
    expect(report.replayLinks[0]).toMatchObject({
      gameID: "human-sample",
      replayUrl: openFrontReplayUrl("human-sample"),
    });
    expect(report.linkGeneration.workerPathRule).toContain("simpleHash");
    expect(report.aggregateBaselines.medianFirstAttackMinute).toBe(0.5);
    expect(report.winnerBaselines.topPlayerCount).toBe(1);
    expect(report.winnerTacticFrequencies.fast_opening).toBe(1);
    expect(report.winnerPlayers[0]).toMatchObject({
      gameID: "human-sample",
      username: "Winner",
      winner: true,
    });
    expect(report.tacticFrequencies.fast_opening).toBe(2);
    expect(report.agentBehaviorRecommendations[0].guideline).toContain(
      "safe neutral growth",
    );
  });

  it("writes corpus JSON and Markdown artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "human-corpus-"));
    const paths = await writeHumanReplayCorpusArtifacts({
      corpusID: "sample-corpus",
      source: "test",
      analyses: [
        buildHumanReplayAnalysis({
          record: sampleReplayRecord(),
          generatedAt: Date.UTC(2026, 0, 1),
        }),
      ],
      directory,
      generatedAt: Date.UTC(2026, 0, 1),
    });

    const json = JSON.parse(await fs.readFile(paths.jsonPath, "utf8"));
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    expect(json.corpusID).toBe("sample-corpus");
    expect(markdown).toContain("Link Generation");
    expect(markdown).toContain("Winner-Only Baselines");
    expect(markdown).toContain("Agent Behavior Recommendations");
  });
});

function sampleReplayRecord(): HumanReplayRecord {
  return {
    version: "v0.0.2",
    gitCommit: "abc123",
    domain: "openfront.io",
    subdomain: "blue",
    info: {
      gameID: "human-sample",
      duration: 1800,
      num_turns: 18000,
      winner: ["player", "winner-client"],
      config: {
        gameMap: "Arctic",
        gameMapSize: "Normal",
        gameMode: "Free For All",
        difficulty: "Medium",
      },
      players: [
        {
          clientID: "winner-client",
          username: "Winner",
          clanTag: null,
          stats: {
            attacks: ["158000000", "24000000"],
            conquests: ["5", "3", "5"],
            boats: {
              trans: ["66", "59", "0", "2"],
              trade: ["1252", "551", "22", "11"],
            },
            bombs: {
              abomb: ["4", "5"],
              hbomb: ["9", "9"],
            },
            gold: [
              "2093900",
              "10472895",
              "163007445",
              "2450911",
              "6475000",
              "4655000",
            ],
            units: {
              city: ["20", "9", "61", "41"],
              port: ["1", "8", "32", "12"],
              fact: ["8", "1", "19", "18"],
              defp: ["11", "10", "0", "11"],
              wshp: ["11", "11", "0", "3"],
              silo: ["3", "1", "5", "4"],
              saml: ["5", "0", "8", "7"],
            },
          },
        },
        {
          clientID: "pressure-client",
          username: "Pressure",
          clanTag: "TOP",
          stats: {
            attacks: ["270000000", "162000000"],
            conquests: ["10", "4", "9"],
            boats: {
              trans: ["84", "81", "0", "2"],
              trade: ["964", "391", "76", "49"],
            },
            bombs: {
              hbomb: ["12", "14"],
            },
            gold: ["2093900", "9800293", "70403684"],
            units: {
              city: ["4", "59", "187", "191"],
              port: ["1", "18", "64", "64"],
              fact: ["3", "27", "48", "51"],
            },
          },
        },
        {
          clientID: "early-dead",
          username: "EarlyDead",
          stats: {
            killedAt: "900",
            attacks: ["150000", "360000"],
            gold: ["60000"],
          },
        },
      ],
    },
    turns: [
      {
        turnNumber: 0,
        intents: [
          { type: "mark_disconnected", clientID: "winner-client" },
          { type: "mark_disconnected", clientID: "pressure-client" },
        ],
      },
      {
        turnNumber: 120,
        intents: [{ type: "spawn", clientID: "winner-client" }],
      },
      {
        turnNumber: 300,
        intents: [
          {
            type: "attack",
            clientID: "winner-client",
            targetID: null,
            troops: 1000,
          },
          {
            type: "attack",
            clientID: "pressure-client",
            targetID: null,
            troops: 900,
          },
        ],
      },
      {
        turnNumber: 480,
        intents: [
          {
            type: "boat",
            clientID: "winner-client",
            troops: 4000,
          },
        ],
      },
      {
        turnNumber: 600,
        intents: [
          {
            type: "boat",
            clientID: "pressure-client",
            troops: 5000,
          },
        ],
      },
      {
        turnNumber: 1080,
        intents: [
          {
            type: "build_unit",
            clientID: "winner-client",
            unit: "City",
          },
        ],
      },
      {
        turnNumber: 1800,
        intents: [
          {
            type: "attack",
            clientID: "winner-client",
            targetID: "rival",
            troops: 1_000_000,
          },
        ],
      },
      {
        turnNumber: 6000,
        intents: [
          {
            type: "attack",
            clientID: "pressure-client",
            targetID: "rival",
            troops: 2_000_000,
          },
        ],
      },
    ],
  };
}
