import {
  AgentManifest,
  AgentManifestProvider,
} from "./AgentManifest";
import {
  checkExternalAgentEndpoint,
  ExternalAgentHealthCheckResult,
  NormalizedExternalAgentHealthCheckInput,
  normalizeExternalAgentHealthCheckInput,
} from "./ExternalAgentHealthCheck";

type ExternalHttpProvider = Extract<
  AgentManifestProvider,
  { provider: "external-http" }
>;
type ExternalRelayProvider = Extract<
  AgentManifestProvider,
  { provider: "external-relay" }
>;

export interface ProxyWarActiveRosterHealthIssue {
  agentName: string;
  endpoint: string;
  failureReason: string;
  fixHint?: string;
}

export interface ProxyWarActiveRosterHealthReport {
  ok: boolean;
  checkedExternalAgentCount: number;
  issues: ProxyWarActiveRosterHealthIssue[];
}

export type ProxyWarActiveRosterHealthChecker = (
  input: NormalizedExternalAgentHealthCheckInput,
) => Promise<ExternalAgentHealthCheckResult>;

export interface ProxyWarActiveRosterHealthOptions {
  checkEndpoint?: ProxyWarActiveRosterHealthChecker;
  tokenForProvider?: (provider: ExternalHttpProvider) => string | undefined;
  relaySessionExists?: (sessionID: string, provider: ExternalRelayProvider) => boolean;
}

export class ProxyWarActiveRosterHealthError extends Error {
  constructor(readonly report: ProxyWarActiveRosterHealthReport) {
    super(proxyWarActiveRosterHealthErrorMessage(report));
    this.name = "ProxyWarActiveRosterHealthError";
  }
}

export async function assertProxyWarActiveRosterExternalEndpointsHealthy(
  roster: AgentManifest[],
  options: ProxyWarActiveRosterHealthOptions = {},
): Promise<void> {
  const report = await checkProxyWarActiveRosterExternalEndpoints(
    roster,
    options,
  );
  if (!report.ok) {
    throw new ProxyWarActiveRosterHealthError(report);
  }
}

export async function checkProxyWarActiveRosterExternalEndpoints(
  roster: AgentManifest[],
  options: ProxyWarActiveRosterHealthOptions = {},
): Promise<ProxyWarActiveRosterHealthReport> {
  const externalAgents = roster.flatMap((agent) => {
    const provider = agent.provider;
    return provider?.provider === "external-http" ? [{ agent, provider }] : [];
  });
  const relayAgents = roster.flatMap((agent) => {
    const provider = agent.provider;
    return provider?.provider === "external-relay" ? [{ agent, provider }] : [];
  });
  const checkEndpoint = options.checkEndpoint ?? checkExternalAgentEndpoint;
  const tokenForProvider =
    options.tokenForProvider ?? proxyWarProviderTokenInput;
  const endpointIssues = (
    await Promise.all(
      externalAgents.map(async ({ agent, provider }) => {
        try {
          const result = await checkEndpoint(
            normalizeExternalAgentHealthCheckInput({
              endpointUrl: provider.endpointUrl,
              token: tokenForProvider(provider),
              timeoutMs: provider.timeoutMs,
              allowTokenReferences: true,
            }),
          );
          if (result.ok) {
            return null;
          }
          return {
            agentName: agent.agentName,
            endpoint: result.endpoint,
            failureReason:
              result.failureReason ?? "external agent health check failed",
            ...(result.fixHint !== undefined ? { fixHint: result.fixHint } : {}),
          };
        } catch (error) {
          return {
            agentName: agent.agentName,
            endpoint: safeEndpointLabel(provider.endpointUrl),
            failureReason:
              error instanceof Error ? error.message : "endpoint check failed",
            fixHint: defaultRosterHealthFixHint,
          };
        }
      }),
    )
  ).filter((issue): issue is ProxyWarActiveRosterHealthIssue => issue !== null);
  const relayIssues =
    options.relaySessionExists === undefined
      ? []
      : relayAgents.flatMap(({ agent, provider }) =>
          options.relaySessionExists?.(provider.sessionID, provider) === true
            ? []
            : [
                {
                  agentName: agent.agentName,
                  endpoint: relayEndpointLabel(provider),
                  failureReason: "managed relay session is not active",
                  fixHint:
                    "Rerun the /agent-start.sh bootstrap command so the tester worker creates a fresh relay session.",
                },
              ],
        );
  const issues = [...endpointIssues, ...relayIssues];
  return {
    ok: issues.length === 0,
    checkedExternalAgentCount:
      externalAgents.length +
      (options.relaySessionExists === undefined ? 0 : relayAgents.length),
    issues,
  };
}

export function proxyWarProviderTokenInput(
  provider: ExternalHttpProvider,
): string | undefined {
  if (provider.token !== undefined) return provider.token;
  if (provider.tokenEnv !== undefined) return `env:${provider.tokenEnv}`;
  if (provider.tokenSecret !== undefined) return `secret:${provider.tokenSecret}`;
  return undefined;
}

function proxyWarActiveRosterHealthErrorMessage(
  report: ProxyWarActiveRosterHealthReport,
): string {
  const first = report.issues[0];
  if (first === undefined) {
    return "Saved external agent health check failed";
  }
  const suffix =
    report.issues.length > 1 ? ` (${report.issues.length} saved agents failed)` : "";
  const fixHint = first.fixHint ?? defaultRosterHealthFixHint;
  return `Saved external agent "${first.agentName}" did not pass connection health check: ${first.failureReason}. Fix: ${fixHint}${suffix}`;
}

function safeEndpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}

const defaultRosterHealthFixHint =
  "Open the tester dashboard health check, delete stale saved endpoints, or re-import a healthy Agent Card.";

function relayEndpointLabel(provider: ExternalRelayProvider): string {
  try {
    const url = new URL(
      `/api/agent-relay/sessions/${encodeURIComponent(provider.sessionID)}`,
      provider.relayBaseUrl,
    );
    return url.toString();
  } catch {
    return `managed relay session ${provider.sessionID}`;
  }
}
