import os from "os";
import { messageBeatsDisplayEnabled } from "./AgentTunables";

/**
 * The page global `BroadcastBeats.ts` reads before curating MESSAGE beats.
 * Kept here beside the injector so the server and the client agree on one
 * name by construction (the client re-declares it literally; a shared import
 * would drag server code into the bundle).
 */
export const MESSAGE_BEATS_DISPLAY_GLOBAL_NAME =
  "__PROXYWAR_MESSAGE_BEATS_DISPLAY__";

/**
 * Applies the public display kill switch (blocker 5,
 * `PROXYWAR_TUNE_MESSAGE_BEATS_DISPLAY` — see
 * `AgentTunables.messageBeatsDisplayEnabled`) to a served replay app-shell
 * document. With the switch ON (the default) the document passes through
 * byte-identical. With it OFF, one inline script stamping the page global
 * `false` is injected before `</head>`, and the client's beat curation skips
 * MESSAGE beats. Display only: the artifacts the page fetches are untouched.
 *
 * The replay route this feeds sets no Content-Security-Policy header (the
 * nonce'd CSP lives on `/account`-family routes, which never render beats),
 * so a plain inline script is deliverable here; if that route ever gains a
 * nonce'd CSP, pass the nonce through `scriptNonce`.
 */
export function withMessageBeatsDisplayFlag(
  html: string,
  options: { scriptNonce?: string } = {},
): string {
  if (messageBeatsDisplayEnabled()) {
    return html;
  }
  const nonceAttr =
    options.scriptNonce === undefined ? "" : ` nonce="${options.scriptNonce}"`;
  const stamp = `<script${nonceAttr}>window.${MESSAGE_BEATS_DISPLAY_GLOBAL_NAME}=false;</script>`;
  const headEnd = html.indexOf("</head>");
  if (headEnd === -1) {
    return stamp + html;
  }
  return html.slice(0, headEnd) + stamp + html.slice(headEnd);
}

export interface ProxyWarDemoServerNetworkConfig {
  host: string;
  port: number;
  publicUrl: string | null;
}

export interface ProxyWarDemoServerUrls {
  listenUrl: string;
  localUrl: string;
  lanUrls: string[];
  publicUrl: string | null;
}

export function loadProxyWarDemoServerNetworkConfig(
  env: Record<string, string | undefined> = process.env,
): ProxyWarDemoServerNetworkConfig {
  return {
    host: normalizeHost(env.AI_LEAGUE_DEMO_HOST),
    port: positiveInt(env.AI_LEAGUE_DEMO_PORT, 8787),
    publicUrl: normalizeBaseUrl(
      firstNonEmpty(env.PROXYWAR_PUBLIC_URL),
    ),
  };
}

export function buildProxyWarDemoServerUrls(
  config: ProxyWarDemoServerNetworkConfig,
  networkInterfaces = os.networkInterfaces(),
): ProxyWarDemoServerUrls {
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
    warnings.push("PROXYWAR_BETA_CODE is required for remote beta access.");
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
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
