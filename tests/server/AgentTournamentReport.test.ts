import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  agentManifestToSpec,
  proxyWarGameUsernameMaxLength,
  validateAgentManifest,
} from "../../src/server/agents/AgentManifest";
import { writeAgentTournamentArtifacts } from "../../src/server/agents/AgentTournamentReport";

describe("Agent tournament artifacts", () => {
  it("validates manifest-defined agents without arbitrary code", () => {
    const manifest = validateAgentManifest({
      schemaVersion: 1,
      agentName: "Manifest Diplomat",
      profile: "diplomatic",
      brainType: "planner",
      personality: "Build alliances.",
      observationPolicy: "default",
      skillPreferences: { diplomacy: 1 },
      provider: { provider: "mock-llm" },
    });

    expect(manifest).toMatchObject({
      agentName: "Manifest Diplomat",
      profile: "diplomatic",
      plannerExecutorMode: true,
    });
    expect(agentManifestToSpec(manifest)).toMatchObject({
      username: "Manifest Diplomat",
      profile: "diplomatic",
    });
    expect(() =>
      validateAgentManifest({
        schemaVersion: 1,
        agentName: "Bad Agent",
        profile: "wizard",
        brainType: "planner",
      }),
    ).toThrow(/profile is invalid/);
  });

  it("validates external-agent manifests with env token references", () => {
    const manifest = validateAgentManifest({
      schemaVersion: 1,
      agentName: "Endpoint Nation",
      profile: "opportunistic",
      brainType: "external-http",
      provider: {
        provider: "external-http",
        endpointUrl: "https://agent.example.test/decide",
        tokenEnv: "PROXYWAR_AGENT_TOKEN",
      },
    });

    expect(manifest.provider).toMatchObject({
      provider: "external-http",
      tokenEnv: "PROXYWAR_AGENT_TOKEN",
    });
    expect(() =>
      validateAgentManifest({
        schemaVersion: 1,
        agentName: "Endpoint Nation",
        profile: "opportunistic",
        brainType: "external-http",
        provider: {
          provider: "external-http",
          endpointUrl: "https://agent.example.test/decide",
          token: "secret",
          tokenEnv: "PROXYWAR_AGENT_TOKEN",
        },
      }),
    ).toThrow(/only one/);
  });

  it("keeps full manifest names but uses OpenFront-safe game usernames", () => {
    const longName = "ProxyWar Reliability Test Agent";
    const manifest = validateAgentManifest({
      schemaVersion: 1,
      agentName: longName,
      profile: "opportunistic",
      brainType: "external-http",
      provider: {
        provider: "external-http",
        endpointUrl: "https://agent.example.test/decide",
      },
    });

    expect(manifest.agentName).toBe(longName);
    expect(agentManifestToSpec(manifest).username).toBe(
      longName.slice(0, proxyWarGameUsernameMaxLength),
    );
    expect(agentManifestToSpec(manifest).username).toHaveLength(
      proxyWarGameUsernameMaxLength,
    );
  });

  it("writes leaderboard and tournament reports from run scorecards", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tournament-"));
    const runDir = path.join(rootDir, "run-1");
    await fs.mkdir(runDir);
    await fs.writeFile(
      path.join(runDir, "match-summary.json"),
      JSON.stringify({
        runID: "run-1",
        scenario: "actions",
        brainMode: "planner-executor",
        runnerMode: "step-locked",
        decisionCount: 4,
        acceptedCount: 4,
        rejectedCount: 0,
        fallbackCount: 0,
        parseFailureCount: 0,
        postSpawnNonHoldActionCount: 2,
        confirmedEffectCount: 1,
        unknownEffectCount: 1,
        failedEffectCount: 0,
        actionCounts: { build: 1, alliance_request: 1, spawn: 2 },
        spectator: {
          openFrontReplayUrl: "/ai-league-replay/run-1",
        },
        matchStory: {
          entertainmentScore: 74,
          grade: "lively",
          summary: "A lively match.",
          spectatorHighlights: [
            "Manifest Diplomat secured an alliance before pressure arrived.",
          ],
          boringnessWarnings: [],
          improvementSuggestions: ["Add more pressure after alliance setup."],
        },
      }),
    );
    await fs.writeFile(path.join(runDir, "match-report.md"), "# run");
    await fs.writeFile(path.join(runDir, "visual-report.html"), "<html></html>");
    await fs.writeFile(
      path.join(runDir, "objective-scorecard.json"),
      JSON.stringify({
        aggregate: {
          username: "All agents",
          profile: "opportunistic",
          totalObjectiveScore: 82,
          objectiveAlignmentRate: 0.75,
          acceptedIntentRate: 1,
          auditedEffectRate: 0.5,
          nonHoldRate: 0.5,
          fallbackCount: 0,
          parserFailureCount: 0,
          rejectedCount: 0,
          confirmedAuditCount: 1,
          unknownAuditCount: 1,
          failedAuditCount: 0,
        },
        agents: [
          {
            username: "Manifest Diplomat",
            profile: "diplomatic",
            totalObjectiveScore: 82,
            objectiveAlignmentRate: 0.75,
            acceptedIntentRate: 1,
            auditedEffectRate: 0.5,
            nonHoldRate: 0.5,
            fallbackCount: 0,
            parserFailureCount: 0,
            rejectedCount: 0,
            confirmedAuditCount: 1,
            unknownAuditCount: 1,
            failedAuditCount: 0,
          },
        ],
      }),
    );

    try {
      const paths = await writeAgentTournamentArtifacts({
        rootDir,
        tournamentID: "tournament-1",
        scenario: "actions",
        brain: "planner",
        startedAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        manifests: [
          validateAgentManifest({
            schemaVersion: 1,
            agentName: "Manifest Diplomat",
            profile: "diplomatic",
            brainType: "planner",
            personality: "Build alliances and stay useful.",
            skillPreferences: { diplomacy: 1, support_ally: 0.8 },
          }),
        ],
        runs: [
          {
            runID: "run-1",
            directory: runDir,
            summaryPath: path.join(runDir, "match-summary.json"),
            reportPath: path.join(runDir, "match-report.md"),
            visualReportPath: path.join(runDir, "visual-report.html"),
            scorecardJsonPath: path.join(runDir, "objective-scorecard.json"),
          },
        ],
      });

      await expect(fs.readFile(paths.summaryPath, "utf8")).resolves.toContain(
        '"showcase"',
      );
      await expect(fs.readFile(paths.reportPath, "utf8")).resolves.toContain(
        "Manifest Diplomat",
      );
      await expect(fs.readFile(paths.reportPath, "utf8")).resolves.toContain(
        "Watchability",
      );
      await expect(fs.readFile(paths.reportPath, "utf8")).resolves.toContain(
        "/ai-league-replay/run-1",
      );
      await expect(fs.readFile(paths.reportPath, "utf8")).resolves.toContain(
        "/runs/run-1/visual-report.html",
      );
      await expect(fs.readFile(paths.reportPath, "utf8")).resolves.not.toContain(
        rootDir,
      );
      await expect(
        fs.readFile(paths.leaderboardPath, "utf8"),
      ).resolves.toContain("totalScore");
      await expect(
        fs.readFile(paths.leaderboardHtmlPath, "utf8"),
      ).resolves.toContain("Watch best replay");
      await expect(
        fs.readFile(paths.leaderboardHtmlPath, "utf8"),
      ).resolves.not.toContain("tournament-summary.json");
      await expect(
        fs.readFile(paths.leaderboardHtmlPath, "utf8"),
      ).resolves.not.toContain(rootDir);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
