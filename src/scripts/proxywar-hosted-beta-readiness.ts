import { execFileSync } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { loadAgentDemoHubModel } from "../server/agents/AgentDemoHub";
import {
  agentDemoBrainUsesCodex,
  loadProxyWarHouseAgentBrain,
  type AgentDemoBrain,
  type AgentDemoJobRecord,
} from "../server/agents/AgentDemoServerJobs";
import { resolveCodexCliCommand } from "../server/agents/CodexCliLlmProvider";
import { defaultExternalAgentSecretStorePath } from "../server/agents/ExternalAgentSecrets";
import {
  defaultProxyWarNationsDir,
} from "../server/agents/ProxyWarNationRegistry";
import {
  buildProxyWarLivePublicReadinessFailureReport,
  buildProxyWarHostedBetaReadinessReport,
  fetchProxyWarLivePublicReadinessReport,
  formatProxyWarHostedBetaReadinessReport,
  hostedBetaReadinessExitCode,
} from "../server/agents/ProxyWarHostedBetaReadiness";
import { loadProxyWarBetaAccessConfig } from "../server/agents/ProxyWarBetaAccess";
import { loadProxyWarDemoServerNetworkConfig } from "../server/agents/ProxyWarDemoServerConfig";
import {
  proxyWarPublicDocs,
  proxyWarPublicExternalAgentExamples,
} from "../server/agents/ProxyWarPublicArtifacts";
import {
  buildProxyWarPublicReadinessReport,
} from "../server/agents/ProxyWarPublicReadiness";
import { checkProxyWarActiveRosterExternalEndpoints } from "../server/agents/ProxyWarActiveRosterHealth";

const args = process.argv.slice(2);
const json = args.includes("--json");
const requireReady = args.includes("--require-ready");
const allowWarnings = args.includes("--allow-warnings");
const cwd = process.cwd();
const rendererBaseUrl =
  stringArg(args, "--renderer-base-url=") ??
  process.env.AI_LEAGUE_RENDERER_BASE_URL ??
  "http://127.0.0.1:9000";

const roots = {
  runs: path.join(cwd, "artifacts", "ai-league-runs"),
  tournaments: path.join(cwd, "artifacts", "ai-league-tournaments"),
  evaluations: path.join(cwd, "artifacts", "ai-league-evals"),
  jobs: path.join(cwd, "artifacts", "ai-league-demo-jobs"),
  nations:
    stringArg(args, "--nations-dir=") ??
    process.env.PROXYWAR_NATIONS_DIR ??
    defaultProxyWarNationsDir,
  feedback: path.join(cwd, "artifacts", "proxywar", "beta-feedback"),
  readiness: path.join(cwd, "artifacts", "proxywar", "hosted-beta-readiness"),
  backups:
    stringArg(args, "--backup-dir=") ??
    process.env.PROXYWAR_BACKUP_DIR ??
    path.join(cwd, "artifacts", "proxywar", "backups"),
};

const jobs = await readJobHistory(path.join(roots.jobs, "jobs.json"));
const runningJobID = jobs.find((job) => job.status === "running")?.jobID ?? null;
const queuedJobCount = jobs.filter((job) => job.status === "queued").length;
const network = loadProxyWarDemoServerNetworkConfig(process.env);
const beta = loadProxyWarBetaAccessConfig(process.env);
const houseAgentBrain = loadHouseAgentBrainForReadiness(process.env);
const codexCommand = resolveCodexCliCommand(process.env);
const hub = await loadAgentDemoHubModel({
  runsRootDir: roots.runs,
  tournamentsRootDir: roots.tournaments,
  evaluationsRootDir: roots.evaluations,
  rendererBaseUrl,
  jobs,
  nationsDir: roots.nations,
  houseAgentBrain: houseAgentBrain.parsed ?? "planner-codex-cli",
});
const maxQueuedJobs = positiveInt(process.env.PROXYWAR_MAX_QUEUED_JOBS, 3);
const externalAgentDecisionTimeoutMs = positiveInt(
  process.env.PROXYWAR_EXTERNAL_AGENT_DECISION_TIMEOUT_MS,
  15_000,
);
const rateLimits = {
  betaLogin: positiveInt(process.env.PROXYWAR_RATE_LIMIT_BETA_LOGIN, 20),
  jobs: positiveInt(process.env.PROXYWAR_RATE_LIMIT_JOBS, 12),
  nations: positiveInt(process.env.PROXYWAR_RATE_LIMIT_NATIONS, 30),
  externalCheck: positiveInt(process.env.PROXYWAR_RATE_LIMIT_EXTERNAL_CHECK, 60),
  feedback: positiveInt(process.env.PROXYWAR_RATE_LIMIT_FEEDBACK, 30),
};
const localPublicReadiness = buildProxyWarPublicReadinessReport({
  beta,
  network,
  hub,
  runningJobID,
  queuedJobCount,
  maxQueuedJobs,
  allowPrivateAgentEndpoints:
    process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
  adminEnabled: process.env.PROXYWAR_BETA_ADMIN_ENABLED === "true",
  savedExternalEndpointHealth:
    await checkProxyWarActiveRosterExternalEndpoints(
      hub.savedNations
        .filter(
          (nation) =>
            nation.provider?.provider === "external-http" ||
            nation.provider?.provider === "external-relay",
        )
        .slice(0, 1),
    ),
});
const publicReadiness = await livePublicReadinessReport({
  localPublicReadiness,
  publicUrl: network.publicUrl,
  inviteCode: beta.inviteCode,
});
const report = buildProxyWarHostedBetaReadinessReport({
  publicReadiness,
  publicUrl: network.publicUrl,
  allowPrivateAgentEndpoints:
    process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
  houseAgentBrain: houseAgentBrain.value,
  codexCli: {
    required:
      houseAgentBrain.parsed !== null &&
      agentDemoBrainUsesCodex(houseAgentBrain.parsed),
    command: codexCommand,
    available: commandAvailable(codexCommand),
  },
  externalAgentDecisionTimeoutMs,
  maxQueuedJobs,
  rateLimits,
  paths: {
    artifactsWritable: await writableDirectory(path.join(cwd, "artifacts")),
    jobsWritable: await writableDirectory(roots.jobs),
    feedbackWritable: await writableDirectory(roots.feedback),
    secretsWritable: await writableDirectory(
      path.dirname(defaultExternalAgentSecretStorePath),
    ),
    backupWritable: await writableDirectory(roots.backups),
    backupRootConfigured:
      stringArg(args, "--backup-dir=") !== null ||
      (process.env.PROXYWAR_BACKUP_DIR?.trim() ?? "") !== "",
  },
  requiredFiles: {
    publicDocs: await requiredFiles(
      path.join(cwd, "docs"),
      proxyWarPublicDocs,
    ),
    externalAgentExamples: await requiredFiles(
      path.join(cwd, "examples", "external-agent"),
      proxyWarPublicExternalAgentExamples,
    ),
    deploymentFiles: await requiredFiles(path.join(cwd, "deploy"), [
      "README.md",
      "proxywar-beta.env.example",
      "proxywar-beta.service",
      "Caddyfile.example",
      "cloudflare-tunnel.yml.example",
      path.join("mac", "proxywar-beta.env.example"),
      path.join("mac", "start-proxywar-beta.zsh"),
      path.join("mac", "start-proxywar-cloudflared.zsh"),
      path.join("mac", "backup-proxywar-beta.zsh"),
      path.join("mac", "com.proxywar.beta.plist.example"),
      path.join("mac", "com.proxywar.cloudflared.plist.example"),
      path.join("mac", "com.proxywar.beta-backup.plist.example"),
    ]),
  },
  git: {
    commit: git(["rev-parse", "HEAD"]),
    originUrl: git(["config", "--get", "remote.origin.url"]),
  },
});

await writeReportArtifacts(report);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatProxyWarHostedBetaReadinessReport(report)}\n`);
  process.stdout.write(`\nReport written to ${path.relative(cwd, roots.readiness)}\n`);
}

if (requireReady) {
  process.exitCode = hostedBetaReadinessExitCode(report, { allowWarnings });
}

async function writeReportArtifacts(
  report: ReturnType<typeof buildProxyWarHostedBetaReadinessReport>,
): Promise<void> {
  await fs.mkdir(roots.readiness, { recursive: true });
  await fs.writeFile(
    path.join(roots.readiness, "hosted-beta-readiness-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(roots.readiness, "hosted-beta-readiness-report.md"),
    `${formatProxyWarHostedBetaReadinessReport(report)}\n`,
  );
}

async function writableDirectory(directory: string): Promise<boolean> {
  try {
    await fs.mkdir(directory, { recursive: true });
    const probe = path.join(directory, `.proxywar-write-test-${process.pid}`);
    await fs.writeFile(probe, "ok\n");
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

async function requiredFiles(
  rootDir: string,
  fileNames: readonly string[],
): Promise<string[]> {
  const results: string[] = [];
  for (const fileName of fileNames) {
    const filePath = path.join(rootDir, fileName);
    try {
      const stat = await fs.stat(filePath);
      results.push(stat.isFile() ? fileName : `missing:${fileName}`);
    } catch {
      results.push(`missing:${fileName}`);
    }
  }
  return results;
}

async function readJobHistory(jobsPath: string): Promise<AgentDemoJobRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(jobsPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isJobRecord);
  } catch {
    return [];
  }
}

function isJobRecord(value: unknown): value is AgentDemoJobRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<AgentDemoJobRecord>;
  return (
    typeof record.jobID === "string" &&
    typeof record.label === "string" &&
    (record.status === "queued" ||
      record.status === "running" ||
      record.status === "completed" ||
      record.status === "failed") &&
    typeof record.startedAt === "string" &&
    record.request !== undefined
  );
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function commandAvailable(command: string): boolean {
  if (command.includes("/") || command.startsWith(".")) {
    return existsSync(command);
  }
  try {
    execFileSync("which", [command], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function livePublicReadinessReport(input: {
  localPublicReadiness: ReturnType<typeof buildProxyWarPublicReadinessReport>;
  publicUrl: string | null;
  inviteCode: string | null;
}): Promise<ReturnType<typeof buildProxyWarPublicReadinessReport>> {
  if (input.publicUrl === null || input.inviteCode === null) {
    return input.localPublicReadiness;
  }
  try {
    return await fetchProxyWarLivePublicReadinessReport({
      publicUrl: input.publicUrl,
      inviteCode: input.inviteCode,
    });
  } catch (error) {
    return buildProxyWarLivePublicReadinessFailureReport({
      publicUrl: input.publicUrl,
      message: `Live /api/public-readiness check failed: ${errorMessage(error)}.`,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadHouseAgentBrainForReadiness(env: NodeJS.ProcessEnv): {
  value: string;
  parsed: AgentDemoBrain | null;
} {
  try {
    const parsed = loadProxyWarHouseAgentBrain(env);
    return { value: parsed, parsed };
  } catch {
    const raw = env.PROXYWAR_HOUSE_AGENT_BRAIN;
    return {
      value:
        typeof raw === "string" && raw.trim() !== ""
          ? raw.trim()
          : "<invalid>",
      parsed: null,
    };
  }
}

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
