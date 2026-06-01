import { describe, expect, it } from "vitest";
import { AgentDemoHubModel } from "../../src/server/agents/AgentDemoHub";
import { loadProxyWarBetaAccessConfig } from "../../src/server/agents/ProxyWarBetaAccess";
import {
  buildProxyWarPublicReadinessReport,
  formatProxyWarPublicReadinessReport,
  ProxyWarPublicReadinessCheck,
  publicReadinessExitCode,
} from "../../src/server/agents/ProxyWarPublicReadiness";

describe("ProxyWarPublicReadiness", () => {
  it("marks a gated HTTPS showcase beta as ready", () => {
    const report = buildProxyWarPublicReadinessReport({
      beta: loadProxyWarBetaAccessConfig({
        PROXYWAR_BETA_ENABLED: "true",
        PROXYWAR_BETA_CODE: "friends-only",
        PROXYWAR_PUBLIC_URL: "https://frontier.example.test",
      }),
      network: {
        host: "127.0.0.1",
        port: 8787,
        publicUrl: "https://frontier.example.test",
      },
      hub: readyHub(),
      runningJobID: null,
      queuedJobCount: 0,
      maxQueuedJobs: 1,
      allowPrivateAgentEndpoints: false,
      adminEnabled: false,
      now: new Date("2026-05-18T10:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "ready",
      mode: "remote-beta",
      shareUrl: "https://frontier.example.test/public",
      generatedAt: "2026-05-18T10:00:00.000Z",
    });
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("/Users/");
  });

  it("blocks public sharing when required beta and showcase pieces are missing", () => {
    const report = buildProxyWarPublicReadinessReport({
      beta: loadProxyWarBetaAccessConfig({}),
      network: { host: "127.0.0.1", port: 8787, publicUrl: null },
      hub: emptyHub(),
      runningJobID: null,
      queuedJobCount: 0,
      maxQueuedJobs: 1,
      allowPrivateAgentEndpoints: false,
      adminEnabled: false,
    });

    expect(report.status).toBe("blocked");
    expect(check(report.checks, "invite_gate").status).toBe("fail");
    expect(check(report.checks, "showcase").status).toBe("fail");
    expect(check(report.checks, "artifact_safety").status).toBe("warn");
  });

  it("blocks private external endpoints on public URLs", () => {
    const report = buildProxyWarPublicReadinessReport({
      beta: loadProxyWarBetaAccessConfig({
        PROXYWAR_BETA_ENABLED: "true",
        PROXYWAR_BETA_CODE: "friends-only",
        PROXYWAR_PUBLIC_URL: "https://frontier.example.test",
      }),
      network: {
        host: "127.0.0.1",
        port: 8787,
        publicUrl: "https://frontier.example.test",
      },
      hub: readyHub(),
      runningJobID: null,
      queuedJobCount: 0,
      maxQueuedJobs: 1,
      allowPrivateAgentEndpoints: true,
      adminEnabled: false,
    });

    expect(report.status).toBe("blocked");
    expect(check(report.checks, "private_agent_endpoints")).toMatchObject({
      status: "fail",
    });
  });

  it("blocks saved localhost external agents on public URLs", () => {
    const hub = readyHub();
    hub.savedNations = [
      {
        schemaVersion: 1,
        nationID: "qa-local-agent",
        fileName: "qa-local-agent.json",
        filePath: "/redacted/qa-local-agent.json",
        createdAt: "2026-05-18T09:00:00.000Z",
        agentName: "QA Local Agent",
        profile: "diplomatic",
        brainType: "external-http",
        plannerExecutorMode: false,
        observationPolicy: "default",
        provider: {
          provider: "external-http",
          endpointUrl: "http://127.0.0.1:7777/decide",
          timeoutMs: 10_000,
        },
      },
    ];

    const report = buildProxyWarPublicReadinessReport({
      beta: loadProxyWarBetaAccessConfig({
        PROXYWAR_BETA_ENABLED: "true",
        PROXYWAR_BETA_CODE: "friends-only",
        PROXYWAR_PUBLIC_URL: "https://frontier.example.test",
      }),
      network: {
        host: "127.0.0.1",
        port: 8787,
        publicUrl: "https://frontier.example.test",
      },
      hub,
      runningJobID: null,
      queuedJobCount: 0,
      maxQueuedJobs: 1,
      allowPrivateAgentEndpoints: false,
      adminEnabled: false,
    });

    expect(report.status).toBe("blocked");
    expect(check(report.checks, "saved_external_agents")).toMatchObject({
      status: "fail",
    });
    expect(formatProxyWarPublicReadinessReport(report)).toContain(
      "QA Local Agent",
    );
  });

  it("blocks sharing when saved external endpoint health fails", () => {
    const hub = readyHub();
    hub.savedNations = [
      {
        schemaVersion: 1,
        nationID: "qa-stale-agent",
        fileName: "qa-stale-agent.json",
        filePath: "/redacted/qa-stale-agent.json",
        createdAt: "2026-05-18T09:00:00.000Z",
        agentName: "QA Stale Agent",
        profile: "opportunistic",
        brainType: "external-http",
        plannerExecutorMode: false,
        observationPolicy: "default",
        provider: {
          provider: "external-http",
          endpointUrl: "https://stale.example.test/proxywar/decide",
          timeoutMs: 5_000,
        },
      },
    ];

    const report = buildProxyWarPublicReadinessReport({
      beta: loadProxyWarBetaAccessConfig({
        PROXYWAR_BETA_ENABLED: "true",
        PROXYWAR_BETA_CODE: "friends-only",
        PROXYWAR_PUBLIC_URL: "https://frontier.example.test",
      }),
      network: {
        host: "127.0.0.1",
        port: 8787,
        publicUrl: "https://frontier.example.test",
      },
      hub,
      runningJobID: null,
      queuedJobCount: 0,
      maxQueuedJobs: 1,
      allowPrivateAgentEndpoints: false,
      adminEnabled: false,
      savedExternalEndpointHealth: {
        ok: false,
        checkedExternalAgentCount: 1,
        issues: [
          {
            agentName: "QA Stale Agent",
            endpoint: "https://stale.example.test/proxywar/decide",
            failureReason: "getaddrinfo ENOTFOUND stale.example.test",
            fixHint: "Delete the stale saved agent.",
          },
        ],
      },
    });

    expect(report.status).toBe("blocked");
    expect(check(report.checks, "saved_external_agents")).toMatchObject({
      status: "fail",
    });
    expect(formatProxyWarPublicReadinessReport(report)).toContain(
      "QA Stale Agent",
    );
    expect(formatProxyWarPublicReadinessReport(report)).toContain(
      "Delete the stale saved agent",
    );
  });

  it("formats reports and exposes strict versus warning-tolerant exit codes", () => {
    const report = buildProxyWarPublicReadinessReport({
      beta: loadProxyWarBetaAccessConfig({
        PROXYWAR_BETA_ENABLED: "true",
        PROXYWAR_BETA_CODE: "friends-only",
      }),
      network: { host: "127.0.0.1", port: 8787, publicUrl: null },
      hub: readyHub(),
      runningJobID: null,
      queuedJobCount: 0,
      maxQueuedJobs: 1,
      allowPrivateAgentEndpoints: false,
      adminEnabled: false,
      now: new Date("2026-05-18T11:00:00.000Z"),
    });

    expect(report.status).toBe("warning");
    expect(formatProxyWarPublicReadinessReport(report)).toContain(
      "ProxyWar public readiness: warning",
    );
    expect(publicReadinessExitCode(report)).toBe(1);
    expect(publicReadinessExitCode(report, { allowWarnings: true })).toBe(0);
  });
});

function readyHub(): AgentDemoHubModel {
  return {
    ...emptyHub(),
    runs: [
      {
        runID: "public-run",
        directory: "/redacted",
        summaryPath: "/redacted/match-summary.json",
        matchReportPath: "/redacted/match-report.md",
        decisionsPath: "/redacted/decisions.jsonl",
        visualReportPath: "/redacted/visual-report.html",
        spectatorPath: "/redacted/spectator.html",
        scorecardJsonPath: "/redacted/objective-scorecard.json",
        scorecardMarkdownPath: "/redacted/objective-scorecard.md",
        externalFeedbackJsonPath: "/redacted/external-agent-feedback.json",
        externalFeedbackMarkdownPath: "/redacted/external-agent-feedback.md",
        matchStoryJsonPath: "/redacted/match-story.json",
        matchStoryMarkdownPath: "/redacted/match-story.md",
        matchPackageJsonPath: "/redacted/match-package.json",
        matchPackageMarkdownPath: "/redacted/match-package.md",
        matchPackageHtmlPath: "/redacted/match-package.html",
        matchPackageLinkFileName: "match-package.html",
        hasSpectatorReplay: true,
        hasOpenFrontReplay: true,
        hasScorecard: true,
        hasExternalFeedback: true,
        hasMatchStory: true,
        hasMatchPackage: true,
        scenario: "actions",
        brainMode: "planner",
        runnerMode: "step-locked",
        decisionCount: 12,
        acceptedCount: 12,
        rejectedCount: 0,
        fallbackCount: 0,
        parseFailureCount: 0,
        postSpawnNonHoldActionCount: 8,
        confirmedEffectCount: 4,
        unknownEffectCount: 2,
        failedEffectCount: 0,
        completedAt: "2026-05-18T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentID: "public-showcase",
        directory: "/redacted",
        summaryPath: "/redacted/tournament-summary.json",
        reportPath: "/redacted/tournament-report.md",
        leaderboardPath: "/redacted/leaderboard.json",
        leaderboardHtmlPath: "/redacted/leaderboard.html",
        scenario: "actions",
        brain: "planner",
        runCount: 1,
        acceptedCount: 12,
        rejectedCount: 0,
        fallbackCount: 0,
        parserFailureCount: 0,
        postSpawnNonHoldActionCount: 8,
        auditStats: { confirmed: 4, unknown: 2, failed: 0 },
        showcase: {
          status: "showcase-ready",
          averageEntertainmentScore: 80,
          bestRunID: "public-run",
          bestRunReplayPath: "/ai-league-replay/public-run",
          agents: [],
          highlightReel: ["Agents expanded and fought."],
          watchWarnings: [],
          nextImprovements: [],
        },
        completedAt: "2026-05-18T09:05:00.000Z",
      },
    ],
  };
}

function emptyHub(): AgentDemoHubModel {
  return {
    runsRootDir: "/redacted/runs",
    tournamentsRootDir: "/redacted/tournaments",
    evaluationsRootDir: "/redacted/evaluations",
    rendererBaseUrl: "http://127.0.0.1:9000",
    runs: [],
    tournaments: [],
    evaluations: [],
    jobs: [],
    manifests: [],
    savedNations: [],
    houseAgentBrain: "planner-codex-cli",
  };
}

function check(
  checks: ProxyWarPublicReadinessCheck[],
  id: string,
): ProxyWarPublicReadinessCheck {
  const found = checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}
