import { describe, expect, it } from "vitest";
import {
  buildOpenFrontierHostedBetaReadinessReport,
  formatOpenFrontierHostedBetaReadinessReport,
  hostedBetaReadinessExitCode,
} from "../../src/server/agents/OpenFrontierHostedBetaReadiness";
import type { OpenFrontierPublicReadinessReport } from "../../src/server/agents/OpenFrontierPublicReadiness";

describe("OpenFrontierHostedBetaReadiness", () => {
  it("marks a fully configured hosted tester release as ready", () => {
    const report = buildOpenFrontierHostedBetaReadinessReport({
      publicReadiness: publicReport("ready"),
      publicUrl: "https://beta.openfrontier.example",
      allowPrivateAgentEndpoints: false,
      houseAgentBrain: "planner-codex-cli",
      codexCli: {
        required: true,
        command: "/Applications/Codex.app/Contents/Resources/codex",
        available: true,
      },
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
        publicDocs: ["OPEN_FRONTIER_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["open-frontier-beta.env.example"],
      },
      git: {
        commit: "abc123",
        originUrl: "git@github.com:0xNad/OpenFrontier.git",
      },
      now: new Date("2026-05-25T10:00:00.000Z"),
    });

    expect(report.status).toBe("ready");
    expect(report.generatedAt).toBe("2026-05-25T10:00:00.000Z");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(formatOpenFrontierHostedBetaReadinessReport(report)).toContain(
      "Open Frontier hosted beta readiness: ready",
    );
    expect(hostedBetaReadinessExitCode(report)).toBe(0);
  });

  it("blocks placeholder domains, private endpoints, disabled limits, and missing files", () => {
    const report = buildOpenFrontierHostedBetaReadinessReport({
      publicReadiness: publicReport("blocked"),
      publicUrl: "https://your-beta-url.example",
      allowPrivateAgentEndpoints: true,
      houseAgentBrain: "planner-codex-cli",
      codexCli: {
        required: true,
        command: "missing-codex",
        available: false,
      },
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
        publicDocs: ["missing:OPEN_FRONTIER_START_HERE.md"],
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
    expect(check(report, "hosted_url").status).toBe("fail");
    expect(check(report, "private_endpoint_lock").status).toBe("fail");
    expect(check(report, "house_agent_brain").status).toBe("pass");
    expect(check(report, "codex_cli").status).toBe("fail");
    expect(check(report, "rate_limits").status).toBe("fail");
    expect(check(report, "persistence").status).toBe("fail");
    expect(check(report, "backup").status).toBe("fail");
    expect(check(report, "tester_onboarding").status).toBe("fail");
    expect(check(report, "deployment_files").status).toBe("fail");
    expect(hostedBetaReadinessExitCode(report)).toBe(1);
  });

  it("treats default local backup and larger queue as warnings", () => {
    const report = buildOpenFrontierHostedBetaReadinessReport({
      publicReadiness: publicReport("ready"),
      publicUrl: "https://beta.openfrontier.example",
      allowPrivateAgentEndpoints: false,
      houseAgentBrain: "planner-codex-cli",
      codexCli: {
        required: true,
        command: "/Applications/Codex.app/Contents/Resources/codex",
        available: true,
      },
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
        publicDocs: ["OPEN_FRONTIER_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["open-frontier-beta.env.example"],
      },
      git: {
        commit: "abc123",
        originUrl: "git@github.com:0xNad/OpenFrontier.git",
      },
    });

    expect(report.status).toBe("warning");
    expect(check(report, "house_agent_brain").status).toBe("pass");
    expect(check(report, "codex_cli").status).toBe("pass");
    expect(check(report, "queue_limit").status).toBe("warn");
    expect(check(report, "backup").status).toBe("warn");
    expect(hostedBetaReadinessExitCode(report)).toBe(1);
    expect(hostedBetaReadinessExitCode(report, { allowWarnings: true })).toBe(0);
  });

  it("blocks non-LLM house-agent brains for tester releases", () => {
    const report = buildOpenFrontierHostedBetaReadinessReport({
      publicReadiness: publicReport("ready"),
      publicUrl: "https://beta.openfrontier.example",
      allowPrivateAgentEndpoints: false,
      houseAgentBrain: "planner",
      codexCli: {
        required: false,
        command: null,
        available: false,
      },
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
        publicDocs: ["OPEN_FRONTIER_START_HERE.md"],
        externalAgentExamples: ["simple-agent.mjs"],
        deploymentFiles: ["open-frontier-beta.env.example"],
      },
      git: {
        commit: "abc123",
        originUrl: "git@github.com:0xNad/OpenFrontier.git",
      },
    });

    expect(report.status).toBe("blocked");
    expect(check(report, "house_agent_brain").status).toBe("fail");
    expect(formatOpenFrontierHostedBetaReadinessReport(report)).toContain(
      "House agents must be LLM-backed",
    );
  });
});

function publicReport(
  status: OpenFrontierPublicReadinessReport["status"],
): OpenFrontierPublicReadinessReport {
  return {
    status,
    generatedAt: "2026-05-25T09:00:00.000Z",
    mode: status === "ready" ? "remote-beta" : "local-dev",
    shareUrl: "https://beta.openfrontier.example/public",
    checks: [],
    nextActions: [],
  };
}

function check(
  report: ReturnType<typeof buildOpenFrontierHostedBetaReadinessReport>,
  id: string,
) {
  const found = report.checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}
