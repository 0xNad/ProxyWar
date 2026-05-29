import { execFileSync } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { loadAgentDemoHubModel } from "../server/agents/AgentDemoHub";
import {
  agentDemoBrainUsesCodex,
  loadOpenFrontierHouseAgentBrain,
  type AgentDemoBrain,
  type AgentDemoJobRecord,
} from "../server/agents/AgentDemoServerJobs";
import { resolveCodexCliCommand } from "../server/agents/CodexCliLlmProvider";
import { defaultExternalAgentSecretStorePath } from "../server/agents/ExternalAgentSecrets";
import {
  defaultOpenFrontierNationsDir,
} from "../server/agents/OpenFrontierNationRegistry";
import {
  buildOpenFrontierHostedBetaReadinessReport,
  formatOpenFrontierHostedBetaReadinessReport,
  hostedBetaReadinessExitCode,
} from "../server/agents/OpenFrontierHostedBetaReadiness";
import { loadOpenFrontierBetaAccessConfig } from "../server/agents/OpenFrontierBetaAccess";
import { loadOpenFrontierDemoServerNetworkConfig } from "../server/agents/OpenFrontierDemoServerConfig";
import {
  openFrontierPublicDocs,
  openFrontierPublicExternalAgentExamples,
} from "../server/agents/OpenFrontierPublicArtifacts";
import {
  buildOpenFrontierPublicReadinessReport,
} from "../server/agents/OpenFrontierPublicReadiness";

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
    process.env.OPEN_FRONTIER_NATIONS_DIR ??
    defaultOpenFrontierNationsDir,
  feedback: path.join(cwd, "artifacts", "open-frontier", "beta-feedback"),
  readiness: path.join(cwd, "artifacts", "open-frontier", "hosted-beta-readiness"),
  backups:
    stringArg(args, "--backup-dir=") ??
    process.env.OPEN_FRONTIER_BACKUP_DIR ??
    path.join(cwd, "artifacts", "open-frontier", "backups"),
};

const jobs = await readJobHistory(path.join(roots.jobs, "jobs.json"));
const runningJobID = jobs.find((job) => job.status === "running")?.jobID ?? null;
const queuedJobCount = jobs.filter((job) => job.status === "queued").length;
const network = loadOpenFrontierDemoServerNetworkConfig(process.env);
const beta = loadOpenFrontierBetaAccessConfig(process.env);
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
const maxQueuedJobs = positiveInt(process.env.OPEN_FRONTIER_MAX_QUEUED_JOBS, 3);
const rateLimits = {
  betaLogin: positiveInt(process.env.OPEN_FRONTIER_RATE_LIMIT_BETA_LOGIN, 20),
  jobs: positiveInt(process.env.OPEN_FRONTIER_RATE_LIMIT_JOBS, 12),
  nations: positiveInt(process.env.OPEN_FRONTIER_RATE_LIMIT_NATIONS, 30),
  externalCheck: positiveInt(process.env.OPEN_FRONTIER_RATE_LIMIT_EXTERNAL_CHECK, 60),
  feedback: positiveInt(process.env.OPEN_FRONTIER_RATE_LIMIT_FEEDBACK, 30),
};
const publicReadiness = buildOpenFrontierPublicReadinessReport({
  beta,
  network,
  hub,
  runningJobID,
  queuedJobCount,
  maxQueuedJobs,
  allowPrivateAgentEndpoints:
    process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
  adminEnabled: process.env.OPEN_FRONTIER_BETA_ADMIN_ENABLED === "true",
});
const report = buildOpenFrontierHostedBetaReadinessReport({
  publicReadiness,
  publicUrl: network.publicUrl,
  allowPrivateAgentEndpoints:
    process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
  houseAgentBrain: houseAgentBrain.value,
  codexCli: {
    required:
      houseAgentBrain.parsed !== null &&
      agentDemoBrainUsesCodex(houseAgentBrain.parsed),
    command: codexCommand,
    available: commandAvailable(codexCommand),
  },
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
      (process.env.OPEN_FRONTIER_BACKUP_DIR?.trim() ?? "") !== "",
  },
  requiredFiles: {
    publicDocs: await requiredFiles(
      path.join(cwd, "docs"),
      openFrontierPublicDocs,
    ),
    externalAgentExamples: await requiredFiles(
      path.join(cwd, "examples", "external-agent"),
      openFrontierPublicExternalAgentExamples,
    ),
    deploymentFiles: await requiredFiles(path.join(cwd, "deploy"), [
      "README.md",
      "open-frontier-beta.env.example",
      "open-frontier-beta.service",
      "Caddyfile.example",
      "cloudflare-tunnel.yml.example",
      path.join("mac", "open-frontier-beta.env.example"),
      path.join("mac", "start-open-frontier-beta.zsh"),
      path.join("mac", "start-open-frontier-cloudflared.zsh"),
      path.join("mac", "backup-open-frontier-beta.zsh"),
      path.join("mac", "com.openfrontier.beta.plist.example"),
      path.join("mac", "com.openfrontier.cloudflared.plist.example"),
      path.join("mac", "com.openfrontier.beta-backup.plist.example"),
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
  process.stdout.write(`${formatOpenFrontierHostedBetaReadinessReport(report)}\n`);
  process.stdout.write(`\nReport written to ${path.relative(cwd, roots.readiness)}\n`);
}

if (requireReady) {
  process.exitCode = hostedBetaReadinessExitCode(report, { allowWarnings });
}

async function writeReportArtifacts(
  report: ReturnType<typeof buildOpenFrontierHostedBetaReadinessReport>,
): Promise<void> {
  await fs.mkdir(roots.readiness, { recursive: true });
  await fs.writeFile(
    path.join(roots.readiness, "hosted-beta-readiness-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(roots.readiness, "hosted-beta-readiness-report.md"),
    `${formatOpenFrontierHostedBetaReadinessReport(report)}\n`,
  );
}

async function writableDirectory(directory: string): Promise<boolean> {
  try {
    await fs.mkdir(directory, { recursive: true });
    const probe = path.join(directory, `.open-frontier-write-test-${process.pid}`);
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

function loadHouseAgentBrainForReadiness(env: NodeJS.ProcessEnv): {
  value: string;
  parsed: AgentDemoBrain | null;
} {
  try {
    const parsed = loadOpenFrontierHouseAgentBrain(env);
    return { value: parsed, parsed };
  } catch {
    const raw = env.OPEN_FRONTIER_HOUSE_AGENT_BRAIN;
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
