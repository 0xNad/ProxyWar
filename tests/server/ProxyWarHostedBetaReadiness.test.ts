import { describe, expect, it } from "vitest";
import {
  buildProxyWarLivePublicReadinessFailureReport,
  buildProxyWarHostedBetaReadinessReport,
  fetchProxyWarLivePublicReadinessReport,
  formatProxyWarHostedBetaReadinessReport,
  hostedBetaReadinessExitCode,
} from "../../src/server/agents/ProxyWarHostedBetaReadiness";
import type { ProxyWarPublicReadinessReport } from "../../src/server/agents/ProxyWarPublicReadiness";

describe("ProxyWarHostedBetaReadiness", () => {
  it("marks a fully configured hosted tester release as ready", () => {
    const report = buildProxyWarHostedBetaReadinessReport({
      publicReadiness: publicReport("ready"),
      publicUrl: "https://beta.proxywar.example",
      allowPrivateAgentEndpoints: false,
      houseAgentBrain: "planner-codex-cli",
      codexCli: {
        required: true,
        command: "/Applications/Codex.app/Contents/Resources/codex",
        available: true,
      },
      externalAgentDecisionTimeoutMs: 15_000,
      maxQueuedJobs: 1,
      rateLimits: {
        betaLogin: 20,
        jobs: 8,
        nations: 24,
        externalCheck: 40,
        feedback: 20,
      },
      paths: {
        artifactsWritable: true,
        jobsWritable: true,
        feedbackWritable: true,
        secretsWritable: true,
        backupWritable: true,
        backupRootConfigured: true,
      },
      requiredFiles: {
        publicDocs: ["PROXYWAR_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["proxywar-beta.env.example"],
      },
      git: {
        commit: "abc123",
        originUrl: "git@github.com:0xNad/ProxyWar.git",
      },
      now: new Date("2026-05-25T10:00:00.000Z"),
    });

    expect(report.status).toBe("ready");
    expect(report.generatedAt).toBe("2026-05-25T10:00:00.000Z");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(formatProxyWarHostedBetaReadinessReport(report)).toContain(
      "Proxy War hosted beta readiness: ready",
    );
    expect(hostedBetaReadinessExitCode(report)).toBe(0);
  });

  it("blocks placeholder domains, private endpoints, disabled limits, and missing files", () => {
    const report = buildProxyWarHostedBetaReadinessReport({
      publicReadiness: publicReport("blocked", [
        "Set PROXYWAR_BETA_CODE before inviting testers.",
        "Delete the stale saved agent.",
      ]),
      publicUrl: "https://your-beta-url.example",
      allowPrivateAgentEndpoints: true,
      houseAgentBrain: "planner-codex-cli",
      codexCli: {
        required: true,
        command: "missing-codex",
        available: false,
      },
      externalAgentDecisionTimeoutMs: 0,
      maxQueuedJobs: 5,
      rateLimits: {
        betaLogin: 0,
        jobs: 8,
        nations: 24,
        externalCheck: 40,
        feedback: 20,
      },
      paths: {
        artifactsWritable: true,
        jobsWritable: false,
        feedbackWritable: true,
        secretsWritable: true,
        backupWritable: false,
        backupRootConfigured: false,
      },
      requiredFiles: {
        publicDocs: ["missing:PROXYWAR_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["missing:Caddyfile.example"],
      },
      git: {
        commit: null,
        originUrl: null,
      },
    });

    expect(report.status).toBe("blocked");
    expect(check(report, "public_readiness").status).toBe("fail");
    expect(check(report, "public_readiness").message).toContain(
      "Set PROXYWAR_BETA_CODE",
    );
    expect(report.nextActions).toContain(
      "Set PROXYWAR_BETA_CODE before inviting testers.",
    );
    expect(report.nextActions).toContain("Delete the stale saved agent.");
    expect(check(report, "hosted_url").status).toBe("fail");
    expect(check(report, "private_endpoint_lock").status).toBe("fail");
    expect(check(report, "house_agent_brain").status).toBe("pass");
    expect(check(report, "codex_cli").status).toBe("fail");
    expect(check(report, "external_agent_timeout").status).toBe("fail");
    expect(check(report, "rate_limits").status).toBe("fail");
    expect(check(report, "persistence").status).toBe("fail");
    expect(check(report, "backup").status).toBe("fail");
    expect(check(report, "tester_onboarding").status).toBe("fail");
    expect(check(report, "deployment_files").status).toBe("fail");
    expect(hostedBetaReadinessExitCode(report)).toBe(1);
  });

  it("treats default local backup and larger queue as warnings", () => {
    const report = buildProxyWarHostedBetaReadinessReport({
      publicReadiness: publicReport("ready"),
      publicUrl: "https://beta.proxywar.example",
      allowPrivateAgentEndpoints: false,
      houseAgentBrain: "planner-codex-cli",
      codexCli: {
        required: true,
        command: "/Applications/Codex.app/Contents/Resources/codex",
        available: true,
      },
      externalAgentDecisionTimeoutMs: 45_000,
      maxQueuedJobs: 3,
      rateLimits: {
        betaLogin: 20,
        jobs: 8,
        nations: 24,
        externalCheck: 40,
        feedback: 20,
      },
      paths: {
        artifactsWritable: true,
        jobsWritable: true,
        feedbackWritable: true,
        secretsWritable: true,
        backupWritable: true,
        backupRootConfigured: false,
      },
      requiredFiles: {
        publicDocs: ["PROXYWAR_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["proxywar-beta.env.example"],
      },
      git: {
        commit: "abc123",
        originUrl: "git@github.com:0xNad/ProxyWar.git",
      },
    });

    expect(report.status).toBe("warning");
    expect(check(report, "house_agent_brain").status).toBe("pass");
    expect(check(report, "codex_cli").status).toBe("pass");
    expect(check(report, "external_agent_timeout").status).toBe("warn");
    expect(check(report, "queue_limit").status).toBe("warn");
    expect(check(report, "backup").status).toBe("warn");
    expect(hostedBetaReadinessExitCode(report)).toBe(1);
    expect(hostedBetaReadinessExitCode(report, { allowWarnings: true })).toBe(0);
  });

  it("blocks non-LLM house-agent brains for tester releases", () => {
    const report = buildProxyWarHostedBetaReadinessReport({
      publicReadiness: publicReport("ready"),
      publicUrl: "https://beta.proxywar.example",
      allowPrivateAgentEndpoints: false,
      houseAgentBrain: "planner",
      codexCli: {
        required: false,
        command: null,
        available: false,
      },
      externalAgentDecisionTimeoutMs: 15_000,
      maxQueuedJobs: 1,
      rateLimits: {
        betaLogin: 20,
        jobs: 8,
        nations: 24,
        externalCheck: 40,
        feedback: 20,
      },
      paths: {
        artifactsWritable: true,
        jobsWritable: true,
        feedbackWritable: true,
        secretsWritable: true,
        backupWritable: true,
        backupRootConfigured: true,
      },
      requiredFiles: {
        publicDocs: ["PROXYWAR_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["proxywar-beta.env.example"],
      },
      git: {
        commit: "abc123",
        originUrl: "git@github.com:0xNad/ProxyWar.git",
      },
    });

    expect(report.status).toBe("blocked");
    expect(check(report, "house_agent_brain").status).toBe("fail");
    expect(formatProxyWarHostedBetaReadinessReport(report)).toContain(
      "House agents must be LLM-backed",
    );
  });

  it("fetches live public readiness through the invite gate", async () => {
    const liveReport = publicReport("blocked", [
      "Rerun the /agent-start.sh bootstrap command.",
    ]);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://beta.proxywar.example/api/beta/login") {
        return new Response("", {
          status: 302,
          headers: {
            "set-cookie":
              "proxywar_beta_session=session-token; Path=/; Secure; HttpOnly",
          },
        });
      }
      if (url === "https://beta.proxywar.example/api/public-readiness") {
        return Response.json(liveReport);
      }
      return new Response("missing", { status: 404 });
    };

    const report = await fetchProxyWarLivePublicReadinessReport({
      publicUrl: "https://beta.proxywar.example/public",
      inviteCode: "friends-only",
      fetchFn,
    });

    expect(report.status).toBe("blocked");
    expect(report.nextActions).toContain(
      "Rerun the /agent-start.sh bootstrap command.",
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://beta.proxywar.example/api/beta/login",
      "https://beta.proxywar.example/api/public-readiness",
    ]);
    expect(String(calls[0].init.body)).toContain("inviteCode=friends-only");
    expect(calls[1].init.headers).toMatchObject({
      cookie: "proxywar_beta_session=session-token",
    });
  });

  it("builds a blocking report when live public readiness cannot be fetched", () => {
    const report = buildProxyWarLivePublicReadinessFailureReport({
      publicUrl: "https://beta.proxywar.example",
      message: "Live /api/public-readiness check failed: timeout.",
      now: new Date("2026-06-02T12:00:00.000Z"),
    });

    expect(report.status).toBe("blocked");
    expect(report.shareUrl).toBe("https://beta.proxywar.example/public");
    expect(report.generatedAt).toBe("2026-06-02T12:00:00.000Z");
    expect(report.checks[0]).toMatchObject({
      id: "live_public_readiness",
      status: "fail",
    });
  });
});

function publicReport(
  status: ProxyWarPublicReadinessReport["status"],
  nextActions: string[] = [],
): ProxyWarPublicReadinessReport {
  return {
    status,
    generatedAt: "2026-05-25T09:00:00.000Z",
    mode: status === "ready" ? "remote-beta" : "local-dev",
    shareUrl: "https://beta.proxywar.example/public",
    checks: [],
    nextActions,
  };
}

function check(
  report: ReturnType<typeof buildProxyWarHostedBetaReadinessReport>,
  id: string,
) {
  const found = report.checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}
