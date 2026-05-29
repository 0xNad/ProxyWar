import type { AgentDemoHubModel } from "./AgentDemoHub";
import type { OpenFrontierBetaAccessConfig } from "./OpenFrontierBetaAccess";
import type { OpenFrontierDemoServerNetworkConfig } from "./OpenFrontierDemoServerConfig";

export type OpenFrontierPublicReadinessStatus = "ready" | "warning" | "blocked";
export type OpenFrontierPublicReadinessCheckStatus = "pass" | "warn" | "fail";

export interface OpenFrontierPublicReadinessCheck {
  id: string;
  label: string;
  status: OpenFrontierPublicReadinessCheckStatus;
  message: string;
}

export interface OpenFrontierPublicReadinessReport {
  status: OpenFrontierPublicReadinessStatus;
  generatedAt: string;
  mode: "remote-beta" | "invite-local" | "local-dev";
  shareUrl: string;
  checks: OpenFrontierPublicReadinessCheck[];
  nextActions: string[];
}

export interface OpenFrontierPublicReadinessInput {
  beta: OpenFrontierBetaAccessConfig;
  network: OpenFrontierDemoServerNetworkConfig;
  hub: AgentDemoHubModel;
  runningJobID: string | null;
  queuedJobCount: number;
  maxQueuedJobs: number;
  allowPrivateAgentEndpoints: boolean;
  adminEnabled: boolean;
  now?: Date;
}

export function buildOpenFrontierPublicReadinessReport(
  input: OpenFrontierPublicReadinessInput,
): OpenFrontierPublicReadinessReport {
  const checks = [
    inviteGateCheck(input.beta),
    publicUrlCheck(input.network),
    cookieCheck(input.beta, input.network),
    privateEndpointCheck(input.allowPrivateAgentEndpoints, input.network),
    savedExternalEndpointCheck(input.hub, input.network),
    showcaseCheck(input.hub),
    renderedReplayCheck(input.hub),
    artifactSafetyCheck(input.beta),
    queueCheck(input.runningJobID, input.queuedJobCount, input.maxQueuedJobs),
    adminExposureCheck(input.beta, input.adminEnabled),
  ];
  const status = overallStatus(checks);
  return {
    status,
    generatedAt: (input.now ?? new Date()).toISOString(),
    mode: readinessMode(input.beta, input.network),
    shareUrl: shareUrl(input.network),
    checks,
    nextActions: nextActions(checks),
  };
}

function savedExternalEndpointCheck(
  hub: AgentDemoHubModel,
  network: OpenFrontierDemoServerNetworkConfig,
): OpenFrontierPublicReadinessCheck {
  const externalNations = hub.savedNations.filter(
    (nation) => nation.provider?.provider === "external-http",
  );
  if (externalNations.length === 0) {
    return {
      id: "saved_external_agents",
      label: "Saved external agents",
      status: "pass",
      message:
        "No saved external-agent endpoints are configured yet. New tester endpoints will be checked before use.",
    };
  }

  const invalid = externalNations.flatMap((nation) => {
    const provider = nation.provider;
    if (provider?.provider !== "external-http") return [];
    const issue = savedExternalEndpointIssue(provider.endpointUrl, network);
    return issue === null ? [] : [`${nation.agentName}: ${issue}`];
  });
  if (invalid.length > 0) {
    return {
      id: "saved_external_agents",
      label: "Saved external agents",
      status: "fail",
      message: `Fix or delete saved external-agent endpoints before sharing: ${invalid
        .slice(0, 3)
        .join("; ")}${invalid.length > 3 ? `; +${invalid.length - 3} more` : ""}.`,
    };
  }

  return {
    id: "saved_external_agents",
    label: "Saved external agents",
    status: "pass",
    message:
      "Saved external-agent endpoints are HTTPS and do not use obvious local/private hosts.",
  };
}

function savedExternalEndpointIssue(
  endpointUrl: string,
  network: OpenFrontierDemoServerNetworkConfig,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return "endpoint URL is invalid";
  }
  if (network.publicUrl !== null && parsed.protocol !== "https:") {
    return "public beta requires HTTPS";
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isClearlyPrivateOrLocalHost(hostname)) {
    return "endpoint is local/private/reserved";
  }
  return null;
}

function isClearlyPrivateOrLocalHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4 === null) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

export function formatOpenFrontierPublicReadinessReport(
  report: OpenFrontierPublicReadinessReport,
): string {
  return [
    `Open Frontier public readiness: ${report.status}`,
    `Mode: ${report.mode}`,
    `Share URL: ${report.shareUrl}`,
    `Generated: ${report.generatedAt}`,
    "",
    "Checks:",
    ...report.checks.map(
      (check) =>
        `- ${check.status.toUpperCase()} ${check.label}: ${check.message}`,
    ),
    "",
    "Next actions:",
    ...report.nextActions.map((action) => `- ${action}`),
  ].join("\n");
}

export function publicReadinessExitCode(
  report: OpenFrontierPublicReadinessReport,
  options: { allowWarnings?: boolean } = {},
): number {
  if (report.status === "ready") return 0;
  if (report.status === "warning" && options.allowWarnings === true) return 0;
  return 1;
}

function inviteGateCheck(
  beta: OpenFrontierBetaAccessConfig,
): OpenFrontierPublicReadinessCheck {
  if (!beta.enabled) {
    return {
      id: "invite_gate",
      label: "Invite gate",
      status: "fail",
      message: "Enable closed beta mode before sharing a public link.",
    };
  }
  if (beta.inviteCode === null) {
    return {
      id: "invite_gate",
      label: "Invite gate",
      status: "fail",
      message: "Set OPEN_FRONTIER_BETA_CODE before inviting testers.",
    };
  }
  if (beta.inviteCode.length < 8) {
    return {
      id: "invite_gate",
      label: "Invite gate",
      status: "warn",
      message: "Use an invite code with at least 8 characters.",
    };
  }
  return {
    id: "invite_gate",
    label: "Invite gate",
    status: "pass",
    message: "Closed beta invite gate is configured.",
  };
}

function publicUrlCheck(
  network: OpenFrontierDemoServerNetworkConfig,
): OpenFrontierPublicReadinessCheck {
  if (network.publicUrl === null) {
    return {
      id: "public_url",
      label: "Share URL",
      status: "warn",
      message:
        "OPEN_FRONTIER_PUBLIC_URL is not set. This is okay for local/LAN tests; remote tunnels should share their HTTPS /public URL.",
    };
  }
  if (!network.publicUrl.startsWith("https://")) {
    return {
      id: "public_url",
      label: "Share URL",
      status: "fail",
      message: "Public shared URLs must use HTTPS.",
    };
  }
  return {
    id: "public_url",
    label: "Share URL",
    status: "pass",
    message: "Public HTTPS URL is configured.",
  };
}

function cookieCheck(
  beta: OpenFrontierBetaAccessConfig,
  network: OpenFrontierDemoServerNetworkConfig,
): OpenFrontierPublicReadinessCheck {
  if (network.publicUrl?.startsWith("https://") && !beta.secureCookie) {
    return {
      id: "secure_cookie",
      label: "Beta cookie",
      status: "fail",
      message: "HTTPS public beta should set a Secure invite cookie.",
    };
  }
  if (beta.secureCookie) {
    return {
      id: "secure_cookie",
      label: "Beta cookie",
      status: "pass",
      message: "Invite cookie will be marked Secure.",
    };
  }
  return {
    id: "secure_cookie",
    label: "Beta cookie",
    status: "warn",
    message: "Invite cookie is not Secure because this looks like local HTTP.",
  };
}

function privateEndpointCheck(
  allowPrivateAgentEndpoints: boolean,
  network: OpenFrontierDemoServerNetworkConfig,
): OpenFrontierPublicReadinessCheck {
  if (allowPrivateAgentEndpoints && network.publicUrl !== null) {
    return {
      id: "private_agent_endpoints",
      label: "External agents",
      status: "fail",
      message: "Disable private/local external-agent endpoints before sharing a public URL.",
    };
  }
  if (allowPrivateAgentEndpoints) {
    return {
      id: "private_agent_endpoints",
      label: "External agents",
      status: "warn",
      message: "Private endpoints are enabled for local testing only.",
    };
  }
  return {
    id: "private_agent_endpoints",
    label: "External agents",
    status: "pass",
    message: "External-agent endpoints must be public HTTPS.",
  };
}

function showcaseCheck(
  hub: AgentDemoHubModel,
): OpenFrontierPublicReadinessCheck {
  const showcase = hub.tournaments.find(
    (tournament) =>
      tournament.showcase?.bestRunID !== undefined &&
      tournament.showcase.bestRunID !== null,
  );
  if (showcase === undefined) {
    return {
      id: "showcase",
      label: "Agent showcase",
      status: "fail",
      message: "Generate an Agent League Showcase before inviting testers.",
    };
  }
  if (showcase.showcase?.status !== "showcase-ready") {
    return {
      id: "showcase",
      label: "Agent showcase",
      status: "warn",
      message: "A showcase exists, but its watchability score is not ready yet.",
    };
  }
  return {
    id: "showcase",
    label: "Agent showcase",
    status: "pass",
    message: "A showcase-ready tournament is available.",
  };
}

function renderedReplayCheck(
  hub: AgentDemoHubModel,
): OpenFrontierPublicReadinessCheck {
  const hasReplay =
    hub.runs.some((run) => run.hasOpenFrontReplay) ||
    hub.tournaments.some(
      (tournament) =>
        tournament.showcase?.bestRunID !== undefined &&
        tournament.showcase.bestRunID !== null,
    );
  return hasReplay
    ? {
        id: "rendered_replay",
        label: "Rendered replay",
        status: "pass",
        message: "At least one rendered replay route is available.",
      }
    : {
        id: "rendered_replay",
        label: "Rendered replay",
        status: "fail",
        message: "Generate a run with game-record.json before sharing the page.",
      };
}

function artifactSafetyCheck(
  beta: OpenFrontierBetaAccessConfig,
): OpenFrontierPublicReadinessCheck {
  return beta.enabled
    ? {
        id: "artifact_safety",
        label: "Artifact exposure",
        status: "pass",
        message: "Beta mode serves only allowlisted docs, runs, and tournament artifacts.",
      }
    : {
        id: "artifact_safety",
        label: "Artifact exposure",
        status: "warn",
        message: "Local dev mode serves broader artifacts for operators.",
      };
}

function queueCheck(
  runningJobID: string | null,
  queuedJobCount: number,
  maxQueuedJobs: number,
): OpenFrontierPublicReadinessCheck {
  if (runningJobID === null && queuedJobCount === 0) {
    return {
      id: "queue",
      label: "Match queue",
      status: "pass",
      message: "No match generation job is currently running.",
    };
  }
  if (maxQueuedJobs <= 0 && queuedJobCount > 0) {
    return {
      id: "queue",
      label: "Match queue",
      status: "fail",
      message: "The queue is full. Wait for the current job to finish.",
    };
  }
  return {
    id: "queue",
    label: "Match queue",
    status: "warn",
    message: "A match job is running or queued. Share after it finishes.",
  };
}

function adminExposureCheck(
  beta: OpenFrontierBetaAccessConfig,
  adminEnabled: boolean,
): OpenFrontierPublicReadinessCheck {
  if (beta.enabled && adminEnabled) {
    return {
      id: "admin_surface",
      label: "Admin surface",
      status: "warn",
      message: "Admin is enabled in beta mode. Keep this for operator-only tests.",
    };
  }
  return {
    id: "admin_surface",
    label: "Admin surface",
    status: "pass",
    message: beta.enabled
      ? "Admin page is hidden in shared beta mode."
      : "Admin page is available for local development.",
  };
}

function readinessMode(
  beta: OpenFrontierBetaAccessConfig,
  network: OpenFrontierDemoServerNetworkConfig,
): OpenFrontierPublicReadinessReport["mode"] {
  if (beta.enabled && network.publicUrl !== null) return "remote-beta";
  if (beta.enabled) return "invite-local";
  return "local-dev";
}

function shareUrl(network: OpenFrontierDemoServerNetworkConfig): string {
  return `${network.publicUrl ?? `http://127.0.0.1:${network.port}`}/public`;
}

function overallStatus(
  checks: OpenFrontierPublicReadinessCheck[],
): OpenFrontierPublicReadinessStatus {
  if (checks.some((check) => check.status === "fail")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "warning";
  return "ready";
}

function nextActions(checks: OpenFrontierPublicReadinessCheck[]): string[] {
  const actions = checks
    .filter((check) => check.status !== "pass")
    .map((check) => check.message);
  return actions.length === 0
    ? ["Share the /public URL and invite code with testers."]
    : actions;
}
