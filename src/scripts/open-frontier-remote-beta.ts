import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { loadAgentDemoHubModel } from "../server/agents/AgentDemoHub";
import {
  buildOpenFrontierDemoServerUrls,
  loadOpenFrontierDemoServerNetworkConfig,
  validateRemoteBetaInviteConfig,
} from "../server/agents/OpenFrontierDemoServerConfig";
import { loadOpenFrontierBetaAccessConfig } from "../server/agents/OpenFrontierBetaAccess";
import { defaultOpenFrontierNationsDir } from "../server/agents/OpenFrontierNationRegistry";
import {
  buildOpenFrontierPublicReadinessReport,
  formatOpenFrontierPublicReadinessReport,
  publicReadinessExitCode,
} from "../server/agents/OpenFrontierPublicReadiness";

type TunnelProvider = "cloudflared" | "none";

interface RemoteBetaOptions {
  provider: TunnelProvider;
  checkOnly: boolean;
}

const options = parseArgs(process.argv.slice(2));
const betaConfig = loadOpenFrontierBetaAccessConfig({
  ...process.env,
  OPEN_FRONTIER_BETA_ENABLED: "true",
  ...(options.provider === "cloudflared"
    ? { OPEN_FRONTIER_BETA_COOKIE_SECURE: "true" }
    : {}),
});
const networkConfig = loadOpenFrontierDemoServerNetworkConfig(process.env);
const urls = buildOpenFrontierDemoServerUrls(networkConfig);
const inviteWarnings = validateRemoteBetaInviteConfig({
  inviteCode: betaConfig.inviteCode,
  allowDefaultCode: process.env.OPEN_FRONTIER_ALLOW_DEFAULT_BETA_CODE === "true",
});

if (inviteWarnings.length > 0) {
  console.error(inviteWarnings.map((warning) => `Remote beta setup: ${warning}`).join("\n"));
  process.exit(1);
}

if (options.checkOnly) {
  const tunnelReady =
    options.provider === "none" ? true : await commandExists(options.provider);
  const readiness = await loadRemoteReadinessReport();
  console.log("Open Frontier remote beta check");
  console.log(`Local URL: ${urls.localUrl}/public`);
  console.log(`Tunnel provider: ${options.provider}`);
  console.log(`Tunnel command available: ${tunnelReady ? "yes" : "no"}`);
  console.log("");
  console.log(formatOpenFrontierPublicReadinessReport(readiness));
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
    OPEN_FRONTIER_BETA_ENABLED: "true",
    AI_LEAGUE_DEMO_RENDERER: process.env.AI_LEAGUE_DEMO_RENDERER ?? "true",
    OPEN_FRONTIER_MAX_QUEUED_JOBS:
      process.env.OPEN_FRONTIER_MAX_QUEUED_JOBS ?? "0",
    ...(options.provider === "cloudflared"
      ? { OPEN_FRONTIER_BETA_COOKIE_SECURE: "true" }
      : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
children.push(server);
server.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
server.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
server.on("error", (error) => {
  console.error(`Open Frontier beta server failed to start: ${error.message}`);
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
    process.env.OPEN_FRONTIER_TUNNEL_PROVIDER === "none" ? "none" : "cloudflared";
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
    nationsDir: defaultOpenFrontierNationsDir,
    closedBeta: { enabled: true, label: betaConfig.label },
  });
  return buildOpenFrontierPublicReadinessReport({
    beta: betaConfig,
    network: networkConfig,
    hub,
    runningJobID: null,
    queuedJobCount: 0,
    maxQueuedJobs: 0,
    allowPrivateAgentEndpoints:
      process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
    adminEnabled: process.env.OPEN_FRONTIER_BETA_ADMIN_ENABLED === "true",
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
