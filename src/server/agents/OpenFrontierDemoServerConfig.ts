import os from "os";

export interface OpenFrontierDemoServerNetworkConfig {
  host: string;
  port: number;
  publicUrl: string | null;
}

export interface OpenFrontierDemoServerUrls {
  listenUrl: string;
  localUrl: string;
  lanUrls: string[];
  publicUrl: string | null;
}

export function loadOpenFrontierDemoServerNetworkConfig(
  env: Record<string, string | undefined> = process.env,
): OpenFrontierDemoServerNetworkConfig {
  return {
    host: normalizeHost(env.AI_LEAGUE_DEMO_HOST),
    port: positiveInt(env.AI_LEAGUE_DEMO_PORT, 8787),
    publicUrl: normalizeBaseUrl(env.OPEN_FRONTIER_PUBLIC_URL),
  };
}

export function buildOpenFrontierDemoServerUrls(
  config: OpenFrontierDemoServerNetworkConfig,
  networkInterfaces = os.networkInterfaces(),
): OpenFrontierDemoServerUrls {
  const listenUrl = `http://${displayHost(config.host)}:${config.port}`;
  const localUrl = `http://127.0.0.1:${config.port}`;
  const lanUrls =
    config.host === "0.0.0.0" || config.host === "::"
      ? discoverLanAddresses(networkInterfaces).map(
          (address) => `http://${address}:${config.port}`,
        )
      : [];
  return {
    listenUrl,
    localUrl,
    lanUrls,
    publicUrl: config.publicUrl,
  };
}

export function validateRemoteBetaInviteConfig(input: {
  inviteCode: string | null;
  allowDefaultCode?: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.inviteCode === null) {
    warnings.push("OPEN_FRONTIER_BETA_CODE is required for remote beta access.");
    return warnings;
  }
  if (input.inviteCode.length < 8) {
    warnings.push("Use an invite code with at least 8 characters.");
  }
  if (input.inviteCode === "frontier-beta" && input.allowDefaultCode !== true) {
    warnings.push(
      "Do not use the default local invite code for remote friend access.",
    );
  }
  return warnings;
}

function discoverLanAddresses(
  networkInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  return Object.values(networkInterfaces)
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === "IPv4" && !entry.internal && entry.address.trim() !== "",
    )
    .map((entry) => entry.address)
    .sort((a, b) => a.localeCompare(b));
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeHost(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? "127.0.0.1" : trimmed;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return value.trim().replace(/\/+$/, "");
}

function displayHost(host: string): string {
  return host === "::" ? "[::]" : host;
}
