import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildOpenFrontierMatchPackage,
  openFrontierMatchPackageHtml,
  writeOpenFrontierMatchPackageArtifacts,
} from "../../src/server/agents/OpenFrontierMatchPackage";

describe("OpenFrontierMatchPackage", () => {
  it("builds a shareable package around replay, telemetry, logs, comms, and coaching artifacts", () => {
    const matchPackage = buildOpenFrontierMatchPackage(
      {
        runID: "public-run",
        matchID: "MATCH1",
        scenario: "actions",
        brainMode: "planner",
        runnerMode: "step-locked",
        decisionCount: 12,
        acceptedCount: 11,
        rejectedCount: 1,
        fallbackCount: 0,
        parseFailureCount: 0,
        postSpawnNonHoldActionCount: 9,
        objectiveScore: 74,
        objectiveScoreGrade: "B",
        objectiveScorecardMarkdownPath: "objective-scorecard.md",
        externalAgentCount: 1,
        externalAgentReadyForDeveloperReview: true,
        externalAgentFeedbackMarkdownPath: "external-agent-feedback.md",
        matchStoryMarkdownPath: "match-story.md",
        spectatorTelemetryPath: "spectator-telemetry.json",
        spectator: {
          snapshotCount: 4,
          spectatorPath: "spectator.html",
          spectatorReplayPath: "spectator-replay.json",
          spectatorTelemetryPath: "spectator-telemetry.json",
          gameRecordPath: "game-record.json",
          openFrontReplayUrl: "/ai-league-replay/public-run",
        },
        matchStory: {
          entertainmentScore: 82,
          grade: "A",
          summary: "A readable test match.",
          spectatorHighlights: ["Iron Coast turned pressure into a border win."],
          boringnessWarnings: [],
          improvementSuggestions: ["Make diplomacy more visible."],
        },
      },
      new Date("2026-05-24T10:00:00.000Z"),
    );

    expect(matchPackage).toMatchObject({
      schemaVersion: 1,
      packageKind: "open-frontier-match-package",
      generatedAt: "2026-05-24T10:00:00.000Z",
      runID: "public-run",
      routes: {
        renderedReplayUrl: "/ai-league-replay/public-run",
        demoHubReplayUrl: "/openfront-replay/public-run",
      },
      metrics: {
        decisionCount: 12,
        acceptedCount: 11,
        externalAgentCount: 1,
        entertainmentScore: 82,
      },
    });
    expect(matchPackage.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "rendered_replay",
        "telemetry",
        "decision_log",
        "match_story",
        "external_agent_feedback",
      ]),
    );
    expect(
      matchPackage.artifacts.find((artifact) => artifact.kind === "decision_log"),
    ).toMatchObject({
      href: "decisions.jsonl",
      audience: "technical",
      present: true,
    });
    expect(matchPackage.protocolBoundary).toContain("LegalAction.id");
    const html = openFrontierMatchPackageHtml(matchPackage);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Open Frontier Match Package");
    expect(html).toContain("Watch rendered replay");
    expect(html).toContain("Package Artifacts");
  });

  it("writes JSON, Markdown, and HTML package files", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "match-package-"));
    try {
      const paths = await writeOpenFrontierMatchPackageArtifacts({
        directory: rootDir,
        now: new Date("2026-05-24T10:00:00.000Z"),
        summary: {
          runID: "package-run",
          matchID: "MATCH2",
          decisionCount: 3,
          acceptedCount: 3,
          matchStoryMarkdownPath: "match-story.md",
          spectator: { gameRecordPath: "game-record.json" },
        },
      });

      await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain(
        '"packageKind": "open-frontier-match-package"',
      );
      const markdown = await fs.readFile(paths.markdownPath, "utf8");
      expect(markdown).toContain("Watch rendered replay");
      expect(markdown).toContain("Package Artifacts");
      expect(markdown).toContain("Protocol Boundary");
      const html = await fs.readFile(paths.htmlPath, "utf8");
      expect(html).toContain("Run Metrics");
      expect(html).toContain("Package Artifacts");
      expect(html).toContain("Protocol Boundary");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
