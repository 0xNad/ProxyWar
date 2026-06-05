import type {
  ProxyWarPublicReadinessCheckStatus,
  ProxyWarPublicReadinessReport,
  ProxyWarPublicReadinessStatus,
} from "./ProxyWarPublicReadiness";

export interface ProxyWarHostedBetaReadinessCheck {
  id: string;
  label: string;
  status: ProxyWarPublicReadinessCheckStatus;
  message: string;
}

export interface ProxyWarHostedBetaReadinessReport {
  status: ProxyWarPublicReadinessStatus;
  generatedAt: string;
  shareUrl: string;
  gitCommit: string | null;
  checks: ProxyWarHostedBetaReadinessCheck[];
  nextActions: string[];
  publicReadiness: ProxyWarPublicReadinessReport;
}

export interface ProxyWarHostedBetaReadinessInput {
  publicReadiness: ProxyWarPublicReadinessReport;
  publicUrl: string | null;
  allowPrivateAgentEndpoints: boolean;
  houseAgentBrain: string;
  codexCli: {
    required: boolean;
    command: string | null;
    available: boolean;
  };
  externalAgentDecisionTimeoutMs: number;
  maxQueuedJobs: number;
  rateLimits: Record<string, number>;
  paths: {
    artifactsWritable: boolean;
    jobsWritable: boolean;
    feedbackWritable: boolean;
    secretsWritable: boolean;
    backupWritable: boolean;
    backupRootConfigured: boolean;
  };
  requiredFiles: {
    publicDocs: string[];
    externalAgentExamples: string[];
    deploymentFiles: string[];
  };
  git: {
    commit: string | null;
    originUrl: string | null;
  };
  now?: Date;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ProxyWarLivePublicReadinessFetchOptions {
  publicUrl: string;
  inviteCode: string;
  timeoutMs?: number;
  fetchFn?: FetchLike;
}

export function buildProxyWarHostedBetaReadinessReport(
  input: ProxyWarHostedBetaReadinessInput,
): ProxyWarHostedBetaReadinessReport {
  const checks: ProxyWarHostedBetaReadinessCheck[] = [
    publicReadinessCheck(input.publicReadiness),
    hostedUrlCheck(input.publicUrl),
    privateEndpointLockCheck(input.allowPrivateAgentEndpoints),
    houseAgentBrainCheck(input.houseAgentBrain),
    codexCliCheck(input.codexCli),
    externalAgentDecisionTimeoutCheck(input.externalAgentDecisionTimeoutMs),
    queueLimitCheck(input.maxQueuedJobs),
    rateLimitCheck(input.rateLimits),
    persistenceCheck(input.paths),
    backupCheck(input.paths),
    onboardingFilesCheck(input.requiredFiles),
    deploymentFilesCheck(input.requiredFiles),
    rollbackCheck(input.git),
  ];
  const status = overallStatus(checks);
  return {
    status,
    generatedAt: (input.now ?? new Date()).toISOString(),
    shareUrl: input.publicReadiness.shareUrl,
    gitCommit: input.git.commit,
    checks,
    nextActions: nextActions(checks, input.publicReadiness),
    publicReadiness: input.publicReadiness,
  };
}

export function formatProxyWarHostedBetaReadinessReport(
  report: ProxyWarHostedBetaReadinessReport,
): string {
  return [
    `Proxy War hosted beta readiness: ${report.status}`,
    `Share URL: ${report.shareUrl}`,
    `Git commit: ${report.gitCommit ?? "unknown"}`,
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

export function hostedBetaReadinessExitCode(
  report: ProxyWarHostedBetaReadinessReport,
  options: { allowWarnings?: boolean } = {},
): number {
  if (report.status === "ready") return 0;
  if (report.status === "warning" && options.allowWarnings === true) return 0;
  return 1;
}

export async function fetchProxyWarLivePublicReadinessReport(
  options: ProxyWarLivePublicReadinessFetchOptions,
): Promise<ProxyWarPublicReadinessReport> {
  const publicUrl = normalizeHostedPublicUrl(options.publicUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchFn = options.fetchFn ?? fetch;
  const loginResponse = await fetchWithTimeout(fetchFn, publicUrl, "/api/beta/login", {
    timeoutMs,
    init: {
      method: "POST",
      body: new URLSearchParams({
        inviteCode: options.inviteCode,
        returnTo: "/public",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    },
  });
  if (loginResponse.status !== 302 && loginResponse.status !== 303) {
    throw new Error(
      `invite login returned HTTP ${loginResponse.status} instead of a redirect`,
    );
  }
  const cookie = cookieHeaderFromSetCookie(loginResponse.headers.get("set-cookie"));
  if (cookie === null) {
    throw new Error("invite login did not return a beta session cookie");
  }

  const readinessResponse = await fetchWithTimeout(
    fetchFn,
    publicUrl,
    "/api/public-readiness",
    {
      timeoutMs,
      init: {
        method: "GET",
        headers: { cookie },
        redirect: "manual",
      },
    },
  );
  if (readinessResponse.status !== 200) {
    throw new Error(
      `/api/public-readiness returned HTTP ${readinessResponse.status}`,
    );
  }
  const parsed = (await readinessResponse.json()) as unknown;
  if (!isProxyWarPublicReadinessReport(parsed)) {
    throw new Error("/api/public-readiness did not return a readiness report");
  }
  return parsed;
}

export function buildProxyWarLivePublicReadinessFailureReport(input: {
  publicUrl: string | null;
  message: string;
  now?: Date;
}): ProxyWarPublicReadinessReport {
  const shareUrl =
    input.publicUrl === null
      ? "<missing>/public"
      : `${normalizeHostedPublicUrl(input.publicUrl)}/public`;
  return {
    status: "blocked",
    generatedAt: (input.now ?? new Date()).toISOString(),
    mode: input.publicUrl === null ? "local-dev" : "remote-beta",
    shareUrl,
    checks: [
      {
        id: "live_public_readiness",
        label: "Live public readiness",
        status: "fail",
        message: input.message,
      },
    ],
    nextActions: [input.message],
  };
}

function publicReadinessCheck(
  publicReadiness: ProxyWarPublicReadinessReport,
): ProxyWarHostedBetaReadinessCheck {
  if (publicReadiness.status === "blocked") {
    const details = publicReadiness.nextActions.slice(0, 3).join("; ");
    return {
      id: "public_readiness",
      label: "Public readiness",
      status: "fail",
      message:
        details === ""
          ? "The base public readiness report is blocked."
          : `The base public readiness report is blocked: ${details}`,
    };
  }
  if (publicReadiness.status === "warning") {
    const details = publicReadiness.nextActions.slice(0, 3).join("; ");
    return {
      id: "public_readiness",
      label: "Public readiness",
      status: "warn",
      message:
        details === ""
          ? "The base public readiness report has warnings."
          : `The base public readiness report has warnings: ${details}`,
    };
  }
  return {
    id: "public_readiness",
    label: "Public readiness",
    status: "pass",
    message: "Invite gate, replay, queue, and artifact checks passed.",
  };
}

function hostedUrlCheck(
  publicUrl: string | null,
): ProxyWarHostedBetaReadinessCheck {
  if (publicUrl === null) {
    return {
      id: "hosted_url",
      label: "Hosted URL",
      status: "fail",
      message: "Set PROXYWAR_PUBLIC_URL to the HTTPS beta domain.",
    };
  }
  if (!publicUrl.startsWith("https://")) {
    return {
      id: "hosted_url",
      label: "Hosted URL",
      status: "fail",
      message: "The hosted beta URL must use HTTPS.",
    };
  }
  if (publicUrl.includes("example.") || publicUrl.includes("your-beta-url")) {
    return {
      id: "hosted_url",
      label: "Hosted URL",
      status: "fail",
      message: "Replace the placeholder public URL with the real beta domain.",
    };
  }
  return {
    id: "hosted_url",
    label: "Hosted URL",
    status: "pass",
    message: "A concrete HTTPS beta URL is configured.",
  };
}

function privateEndpointLockCheck(
  allowPrivateAgentEndpoints: boolean,
): ProxyWarHostedBetaReadinessCheck {
  return allowPrivateAgentEndpoints
    ? {
        id: "private_endpoint_lock",
        label: "External endpoint lock",
        status: "fail",
        message:
          "Disable PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS for hosted testers.",
      }
    : {
        id: "private_endpoint_lock",
        label: "External endpoint lock",
        status: "pass",
        message: "Hosted testers must use public HTTPS external-agent endpoints.",
      };
}

function houseAgentBrainCheck(
  houseAgentBrain: string,
): ProxyWarHostedBetaReadinessCheck {
  if (houseAgentBrain === "planner-codex-cli") {
    return {
      id: "house_agent_brain",
      label: "House agent brain",
      status: "pass",
      message:
        "Tester matches default to Codex CLI planner house agents; the server only enforces the legal-action boundary.",
    };
  }
  if (houseAgentBrain === "codex-cli") {
    return {
      id: "house_agent_brain",
      label: "House agent brain",
      status: "warn",
      message:
        "Codex direct-action mode is enabled. This is LLM-backed, but planner mode is preferred for the beta.",
    };
  }
  return {
    id: "house_agent_brain",
    label: "House agent brain",
    status: "fail",
    message:
      "House agents must be LLM-backed. Note: Codex CLI is being deprecated for the house agent due to ChatGPT-account model/quota limits; a Claude-CLI house brain is the planned replacement once available. Until then, set PROXYWAR_HOUSE_AGENT_BRAIN to an LLM-backed brain before sharing the beta.",
  };
}

function codexCliCheck(input: {
  required: boolean;
  command: string | null;
  available: boolean;
}): ProxyWarHostedBetaReadinessCheck {
  if (!input.required) {
    return {
      id: "codex_cli",
      label: "Codex CLI",
      status: "pass",
      message: "Codex CLI is not required by the configured house-agent brain.",
    };
  }
  if (!input.available) {
    return {
      id: "codex_cli",
      label: "Codex CLI",
      status: "fail",
      message:
        "Codex-powered house agents are enabled, but Codex CLI was not found. Install Codex CLI or set AI_LEAGUE_CODEX_COMMAND.",
    };
  }
  return {
    id: "codex_cli",
    label: "Codex CLI",
    status: "pass",
    message: `Codex CLI command is available: ${input.command ?? "codex"}.`,
  };
}

function externalAgentDecisionTimeoutCheck(
  timeoutMs: number,
): ProxyWarHostedBetaReadinessCheck {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    return {
      id: "external_agent_timeout",
      label: "External agent timeout",
      status: "fail",
      message:
        "Set PROXYWAR_EXTERNAL_AGENT_DECISION_TIMEOUT_MS to an integer of at least 1000ms.",
    };
  }
  if (timeoutMs > 20_000) {
    return {
      id: "external_agent_timeout",
      label: "External agent timeout",
      status: "warn",
      message:
        "External tester-agent decisions can hold a checkpoint for more than 20s. Use 15000 for hosted beta unless intentionally testing slow agents.",
    };
  }
  return {
    id: "external_agent_timeout",
    label: "External agent timeout",
    status: "pass",
    message:
      "External tester-agent decisions are capped separately from Codex house-agent decisions.",
  };
}

function queueLimitCheck(maxQueuedJobs: number): ProxyWarHostedBetaReadinessCheck {
  if (!Number.isInteger(maxQueuedJobs) || maxQueuedJobs < 0) {
    return {
      id: "queue_limit",
      label: "Queue limit",
      status: "fail",
      message: "PROXYWAR_MAX_QUEUED_JOBS must be a non-negative integer.",
    };
  }
  if (maxQueuedJobs > 1) {
    return {
      id: "queue_limit",
      label: "Queue limit",
      status: "warn",
      message:
        "For first testers, set PROXYWAR_MAX_QUEUED_JOBS=1 so match jobs cannot pile up.",
    };
  }
  return {
    id: "queue_limit",
    label: "Queue limit",
    status: "pass",
    message: "Queue capacity is small enough for a private tester release.",
  };
}

function rateLimitCheck(
  rateLimits: Record<string, number>,
): ProxyWarHostedBetaReadinessCheck {
  const disabled = Object.entries(rateLimits).filter(
    ([, value]) => !Number.isFinite(value) || value <= 0,
  );
  if (disabled.length > 0) {
    return {
      id: "rate_limits",
      label: "Rate limits",
      status: "fail",
      message: `Rate limits must be enabled for: ${disabled
        .map(([name]) => name)
        .join(", ")}.`,
    };
  }
  return {
    id: "rate_limits",
    label: "Rate limits",
    status: "pass",
    message: "Invite, job, nation, endpoint-check, and feedback limits are enabled.",
  };
}

function persistenceCheck(
  paths: ProxyWarHostedBetaReadinessInput["paths"],
): ProxyWarHostedBetaReadinessCheck {
  const failed = [
    ["artifacts", paths.artifactsWritable],
    ["jobs", paths.jobsWritable],
    ["feedback", paths.feedbackWritable],
    ["external-agent secrets", paths.secretsWritable],
  ].filter(([, ok]) => ok !== true);
  if (failed.length > 0) {
    return {
      id: "persistence",
      label: "Persistence",
      status: "fail",
      message: `Hosted beta data is not writable for: ${failed
        .map(([name]) => name)
        .join(", ")}.`,
    };
  }
  return {
    id: "persistence",
    label: "Persistence",
    status: "pass",
    message: "Artifacts, jobs, feedback, and external-agent secrets are writable.",
  };
}

function backupCheck(
  paths: ProxyWarHostedBetaReadinessInput["paths"],
): ProxyWarHostedBetaReadinessCheck {
  if (!paths.backupWritable) {
    return {
      id: "backup",
      label: "Backup",
      status: "fail",
      message: "The beta backup directory is not writable.",
    };
  }
  if (!paths.backupRootConfigured) {
    return {
      id: "backup",
      label: "Backup",
      status: "warn",
      message:
        "Backups can use the default local directory. Set PROXYWAR_BACKUP_DIR on a hosted server.",
    };
  }
  return {
    id: "backup",
    label: "Backup",
    status: "pass",
    message: "A writable hosted backup directory is configured.",
  };
}

function onboardingFilesCheck(
  requiredFiles: ProxyWarHostedBetaReadinessInput["requiredFiles"],
): ProxyWarHostedBetaReadinessCheck {
  const missing = [
    ...requiredFiles.publicDocs,
    ...requiredFiles.externalAgentExamples,
  ].filter((file) => file.startsWith("missing:"));
  if (missing.length > 0) {
    return {
      id: "tester_onboarding",
      label: "Tester onboarding",
      status: "fail",
      message: `Missing tester onboarding files: ${missing
        .map((file) => file.slice("missing:".length))
        .join(", ")}.`,
    };
  }
  return {
    id: "tester_onboarding",
    label: "Tester onboarding",
    status: "pass",
    message: "Connect-agent docs and examples are present.",
  };
}

function deploymentFilesCheck(
  requiredFiles: ProxyWarHostedBetaReadinessInput["requiredFiles"],
): ProxyWarHostedBetaReadinessCheck {
  const missing = requiredFiles.deploymentFiles.filter((file) =>
    file.startsWith("missing:"),
  );
  if (missing.length > 0) {
    return {
      id: "deployment_files",
      label: "Deployment files",
      status: "fail",
      message: `Missing deployment files: ${missing
        .map((file) => file.slice("missing:".length))
        .join(", ")}.`,
    };
  }
  return {
    id: "deployment_files",
    label: "Deployment files",
    status: "pass",
    message: "Environment, service, and reverse-proxy templates are present.",
  };
}

function rollbackCheck(
  git: ProxyWarHostedBetaReadinessInput["git"],
): ProxyWarHostedBetaReadinessCheck {
  if (git.commit === null || git.originUrl === null) {
    return {
      id: "rollback",
      label: "Rollback path",
      status: "warn",
      message: "Git commit or origin remote could not be detected for rollback.",
    };
  }
  return {
    id: "rollback",
    label: "Rollback path",
    status: "pass",
    message: "Current commit and origin remote are available for rollback.",
  };
}

function overallStatus(
  checks: ProxyWarHostedBetaReadinessCheck[],
): ProxyWarPublicReadinessStatus {
  if (checks.some((check) => check.status === "fail")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "warning";
  return "ready";
}

function nextActions(
  checks: ProxyWarHostedBetaReadinessCheck[],
  publicReadiness: ProxyWarPublicReadinessReport,
): string[] {
  const actions = [
    ...publicReadiness.nextActions,
    ...checks
      .filter(
        (check) => check.status !== "pass" && check.id !== "public_readiness",
      )
      .map((check) => check.message),
  ].filter((action, index, all) => all.indexOf(action) === index);
  return actions.length === 0
    ? [
        "Run the hosted smoke test, then share the /public URL and invite code with testers.",
      ]
    : actions;
}

async function fetchWithTimeout(
  fetchFn: FetchLike,
  publicUrl: string,
  path: string,
  options: { timeoutMs: number; init: RequestInit },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetchFn(`${publicUrl}${path}`, {
      ...options.init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`${path} timed out after ${options.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeHostedPublicUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("publicUrl must be a valid URL");
  }
  if (parsed.pathname === "/public") {
    parsed.pathname = "";
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function cookieHeaderFromSetCookie(setCookie: string | null): string | null {
  if (setCookie === null || setCookie.trim() === "") return null;
  const first = setCookie.split(",").find((part) => part.includes("="));
  const cookiePair = first?.split(";")[0]?.trim();
  return cookiePair === undefined || cookiePair === "" ? null : cookiePair;
}

function isProxyWarPublicReadinessReport(
  value: unknown,
): value is ProxyWarPublicReadinessReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const report = value as Partial<ProxyWarPublicReadinessReport>;
  return (
    (report.status === "ready" ||
      report.status === "warning" ||
      report.status === "blocked") &&
    typeof report.generatedAt === "string" &&
    (report.mode === "remote-beta" ||
      report.mode === "invite-local" ||
      report.mode === "local-dev") &&
    typeof report.shareUrl === "string" &&
    Array.isArray(report.checks) &&
    Array.isArray(report.nextActions)
  );
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.includes("aborted");
  }
  if (error !== null && typeof error === "object") {
    return (error as { name?: unknown }).name === "AbortError";
  }
  return false;
}
