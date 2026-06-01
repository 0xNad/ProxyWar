import fs from "fs/promises";
import path from "path";
import {
  AgentManifestProvider,
} from "./AgentManifest";
import {
  checkExternalAgentEndpoint,
  ExternalAgentHealthCheckResult,
  NormalizedExternalAgentHealthCheckInput,
  normalizeExternalAgentHealthCheckInput,
} from "./ExternalAgentHealthCheck";
import {
  defaultProxyWarActiveRosterDir,
  defaultProxyWarNationsDir,
  listProxyWarNations,
  ProxyWarNationEntry,
  syncProxyWarActiveRoster,
} from "./ProxyWarNationRegistry";
import { proxyWarProviderTokenInput } from "./ProxyWarActiveRosterHealth";

type ExternalHttpProvider = Extract<
  AgentManifestProvider,
  { provider: "external-http" }
>;

export interface ProxyWarSavedAgentMaintenanceOptions {
  nationsDir?: string;
  activeRosterDir?: string;
  archiveDir?: string;
  archiveFailed?: boolean;
  now?: Date;
  checkEndpoint?: (
    input: NormalizedExternalAgentHealthCheckInput,
  ) => Promise<ExternalAgentHealthCheckResult>;
}

export interface ProxyWarSavedExternalAgentCheck {
  nationID: string;
  agentName: string;
  fileName: string;
  endpoint: string;
  ok: boolean;
  failureReason?: string;
  fixHint?: string;
  archivedFilePath?: string;
}

export interface ProxyWarSavedAgentMaintenanceReport {
  checkedAt: string;
  checkedExternalAgentCount: number;
  failedExternalAgentCount: number;
  archivedExternalAgentCount: number;
  checks: ProxyWarSavedExternalAgentCheck[];
}

export async function maintainProxyWarSavedExternalAgents(
  options: ProxyWarSavedAgentMaintenanceOptions = {},
): Promise<ProxyWarSavedAgentMaintenanceReport> {
  const nationsDir = options.nationsDir ?? defaultProxyWarNationsDir;
  const activeRosterDir =
    options.activeRosterDir ?? defaultProxyWarActiveRosterDir;
  const archiveDir =
    options.archiveDir ??
    path.join(process.cwd(), "artifacts", "proxywar", "nations-archive");
  const checkedAt = (options.now ?? new Date()).toISOString();
  const savedNations = await listProxyWarNations(nationsDir);
  const externalNations = savedNations.flatMap((nation) => {
    const provider = nation.provider;
    return provider?.provider === "external-http" ? [{ nation, provider }] : [];
  });
  const checks: ProxyWarSavedExternalAgentCheck[] = [];
  for (const { nation, provider } of externalNations) {
    const check = await checkSavedExternalAgent(nation, provider, options);
    if (options.archiveFailed === true && !check.ok) {
      check.archivedFilePath = await archiveSavedNationFile({
        nation,
        nationsDir,
        archiveDir,
        checkedAt,
      });
    }
    checks.push(check);
  }
  if (options.archiveFailed === true && checks.some((check) => check.archivedFilePath)) {
    await syncProxyWarActiveRoster({ nationsDir, activeRosterDir });
  }
  return {
    checkedAt,
    checkedExternalAgentCount: checks.length,
    failedExternalAgentCount: checks.filter((check) => !check.ok).length,
    archivedExternalAgentCount: checks.filter(
      (check) => check.archivedFilePath !== undefined,
    ).length,
    checks,
  };
}

export function formatProxyWarSavedAgentMaintenanceReport(
  report: ProxyWarSavedAgentMaintenanceReport,
): string {
  const lines = [
    `ProxyWar saved external-agent health: ${report.failedExternalAgentCount === 0 ? "ready" : "needs cleanup"}`,
    `Checked: ${report.checkedExternalAgentCount}`,
    `Failed: ${report.failedExternalAgentCount}`,
    `Archived: ${report.archivedExternalAgentCount}`,
    `Generated: ${report.checkedAt}`,
  ];
  if (report.checks.length === 0) {
    return [...lines, "", "No saved external agents found."].join("\n");
  }
  const body = [
    ...lines,
    "",
    "Saved external agents:",
    ...report.checks.map((check) =>
      [
        `- ${check.ok ? "PASS" : "FAIL"} ${check.agentName} (${check.nationID})`,
        `  Endpoint: ${check.endpoint}`,
        check.failureReason === undefined
          ? ""
          : `  Failure: ${check.failureReason}`,
        check.fixHint === undefined ? "" : `  Fix: ${check.fixHint}`,
        check.archivedFilePath === undefined
          ? ""
          : `  Archived: ${check.archivedFilePath}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ];
  if (
    report.failedExternalAgentCount > 0 &&
    report.archivedExternalAgentCount === 0
  ) {
    body.push(
      "",
      "Run again with -- --archive-failed to move failed saved agents out of the active roster.",
    );
  }
  return body.join("\n");
}

async function checkSavedExternalAgent(
  nation: ProxyWarNationEntry,
  provider: ExternalHttpProvider,
  options: ProxyWarSavedAgentMaintenanceOptions,
): Promise<ProxyWarSavedExternalAgentCheck> {
  try {
    const result = await (options.checkEndpoint ?? checkExternalAgentEndpoint)(
      normalizeExternalAgentHealthCheckInput({
        endpointUrl: provider.endpointUrl,
        token: proxyWarProviderTokenInput(provider),
        timeoutMs: provider.timeoutMs,
        allowTokenReferences: true,
      }),
    );
    return {
      nationID: nation.nationID,
      agentName: nation.agentName,
      fileName: nation.fileName,
      endpoint: result.endpoint,
      ok: result.ok,
      ...(result.failureReason !== undefined
        ? { failureReason: result.failureReason }
        : {}),
      ...(result.fixHint !== undefined ? { fixHint: result.fixHint } : {}),
    };
  } catch (error) {
    return {
      nationID: nation.nationID,
      agentName: nation.agentName,
      fileName: nation.fileName,
      endpoint: safeEndpointLabel(provider.endpointUrl),
      ok: false,
      failureReason:
        error instanceof Error ? error.message : "saved agent health check failed",
      fixHint:
        "Delete this saved agent, or re-import an Agent Card after the endpoint is reachable.",
    };
  }
}

async function archiveSavedNationFile(input: {
  nation: ProxyWarNationEntry;
  nationsDir: string;
  archiveDir: string;
  checkedAt: string;
}): Promise<string> {
  const resolvedNationsDir = path.resolve(input.nationsDir);
  const resolvedFilePath = path.resolve(input.nation.filePath);
  if (
    resolvedFilePath !== resolvedNationsDir &&
    !resolvedFilePath.startsWith(`${resolvedNationsDir}${path.sep}`)
  ) {
    throw new Error("Saved nation path is outside the nations directory");
  }
  const archiveBatchDir = path.join(
    input.archiveDir,
    input.checkedAt.replace(/[:.]/g, "-"),
  );
  await fs.mkdir(archiveBatchDir, { recursive: true });
  const archivedFilePath = path.join(archiveBatchDir, input.nation.fileName);
  await fs.rename(resolvedFilePath, archivedFilePath);
  return archivedFilePath;
}

function safeEndpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}
