import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { loadAgentDemoHubModel } from "../server/agents/AgentDemoHub";
import {
  buildProxyWarDemoServerUrls,
  loadProxyWarDemoServerNetworkConfig,
  validateRemoteBetaInviteConfig,
} from "../server/agents/ProxyWarDemoServerConfig";
import { loadProxyWarBetaAccessConfig } from "../server/agents/ProxyWarBetaAccess";
import { defaultProxyWarNationsDir } from "../server/agents/ProxyWarNationRegistry";
import { checkProxyWarActiveRosterExternalEndpoints } from "../server/agents/ProxyWarActiveRosterHealth";
import {
  buildProxyWarPublicReadinessReport,
  formatProxyWarPublicReadinessReport,
  publicReadinessExitCode,
} from "../server/agents/ProxyWarPublicReadiness";

type TunnelProvider = "cloudflared" | "none";

interface RemoteBetaOptions {
  provider: TunnelProvider;
  checkOnly: boolean;
}

const options = parseArgs(process.argv.slice(2));
const betaConfig = loadProxyWarBetaAccessConfig({
  ...process.env,
  PROXYWAR_BETA_ENABLED: "true",
  ...(options.provider === "cloudflared"
    ? { PROXYWAR_BETA_COOKIE_SECURE: "true" }
    : {}),
});
const networkConfig = loadProxyWarDemoServerNetworkConfig(process.env);
const urls = buildProxyWarDemoServerUrls(networkConfig);
const inviteWarnings = validateRemoteBetaInviteConfig({
  inviteCode: betaConfig.inviteCode,
  allowDefaultCode: process.env.PROXYWAR_ALLOW_DEFAULT_BETA_CODE === "true",
});

if (inviteWarnings.length > 0) {
  console.error(inviteWarnings.map((warning) => `Remote beta setup: ${warning}`).join("\n"));
  process.exit(1);
}

if (options.checkOnly) {
  const tunnelReady =
    options.provider === "none" ? true : await commandExists(options.provider);
  const readiness = await loadRemoteReadinessReport();
  console.log("ProxyWar remote beta check");
  console.log(`Local URL: ${urls.localUrl}/public`);
  console.log(`Tunnel provider: ${options.provider}`);
  console.log(`Tunnel command available: ${tunnelReady ? "yes" : "no"}`);
  console.log("");
  console.log(formatProxyWarPublicReadinessReport(readiness));
  if (!tunnelReady) {
    console.log(
      "Install cloudflared or run with --provider=none and start your own tunnel.",
    );
  }
  process.exit(
    tunnelReady
      ? publicReadinessExitCode(readiness, { allowWarnings: true })
      : 1,
  );
}

const children: ChildProcess[] = [];
const server = spawn(localBin("tsx"), ["src/scripts/ai-agent-demo-server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    GAME_ENV: "dev",
    PROXYWAR_BETA_ENABLED: "true",
    AI_LEAGUE_DEMO_RENDERER: process.env.AI_LEAGUE_DEMO_RENDERER ?? "true",
    PROXYWAR_MAX_QUEUED_JOBS:
      process.env.PROXYWAR_MAX_QUEUED_JOBS ?? "0",
    ...(options.provider === "cloudflared"
      ? { PROXYWAR_BETA_COOKIE_SECURE: "true" }
      : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
children.push(server);
server.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
server.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
server.on("error", (error) => {
  console.error(`ProxyWar beta server failed to start: ${error.message}`);
});

if (options.provider === "cloudflared") {
  if (!(await commandExists("cloudflared"))) {
    console.error(
      "cloudflared is not installed. Install it, or run with --provider=none and use your own tunnel.",
    );
    cleanupAndExit(1);
  }
  const tunnel = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${networkConfig.port}`],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.push(tunnel);
  tunnel.stdout.on("data", (chunk: Buffer) => handleTunnelOutput(chunk));
  tunnel.stderr.on("data", (chunk: Buffer) => handleTunnelOutput(chunk));
  tunnel.on("error", (error) => {
    console.error(`cloudflared failed: ${error.message}`);
  });
} else {
  console.log("Tunnel disabled. Start your tunnel to:");
  console.log(`${urls.localUrl}`);
}

console.log("Remote beta is starting.");
console.log(`Local beta URL: ${urls.localUrl}/public`);
console.log("Share only the tunnel/public URL and the invite code with testers.");
console.log("Press Ctrl-C to stop the beta server and tunnel.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => cleanupAndExit(0, signal));
}

function handleTunnelOutput(chunk: Buffer): void {
  const text = chunk.toString("utf8");
  process.stdout.write(text);
  const match = text.match(/https:\/\/[a-z0-9.-]+\.trycloudflare\.com/i);
  if (match !== null) {
    console.log(`\nShare this beta URL: ${match[0]}/public`);
  }
}

function parseArgs(args: string[]): RemoteBetaOptions {
  let provider: TunnelProvider =
    process.env.PROXYWAR_TUNNEL_PROVIDER === "none" ? "none" : "cloudflared";
  let checkOnly = false;
  for (const arg of args) {
    if (arg === "--check") {
      checkOnly = true;
    } else if (arg === "--provider=none") {
      provider = "none";
    } else if (arg === "--provider=cloudflared") {
      provider = "cloudflared";
    }
  }
  return { provider, checkOnly };
}

async function loadRemoteReadinessReport() {
  const hub = await loadAgentDemoHubModel({
    runsRootDir: path.join(process.cwd(), "artifacts", "ai-league-runs"),
    tournamentsRootDir: path.join(
      process.cwd(),
      "artifacts",
      "ai-league-tournaments",
    ),
    evaluationsRootDir: path.join(process.cwd(), "artifacts", "ai-league-evals"),
    rendererBaseUrl:
      process.env.AI_LEAGUE_RENDERER_BASE_URL ?? "http://127.0.0.1:9000",
    jobs: [],
    nationsDir: defaultProxyWarNationsDir,
    closedBeta: { enabled: true, label: betaConfig.label },
  });
  return buildProxyWarPublicReadinessReport({
    beta: betaConfig,
    network: networkConfig,
    hub,
    runningJobID: null,
    queuedJobCount: 0,
    maxQueuedJobs: 0,
    allowPrivateAgentEndpoints:
      process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
    adminEnabled: process.env.PROXYWAR_BETA_ADMIN_ENABLED === "true",
    savedExternalEndpointHealth:
      await checkProxyWarActiveRosterExternalEndpoints(hub.savedNations),
  });
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function cleanupAndExit(code: number, signal?: NodeJS.Signals): void {
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal ?? "SIGTERM");
  }
  process.exit(code);
}

function localBin(name: string): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}
