import fs from "fs/promises";
import path from "path";
import { loadAgentDemoHubModel } from "../server/agents/AgentDemoHub";
import type { AgentDemoJobRecord } from "../server/agents/AgentDemoServerJobs";
import { loadOpenFrontierBetaAccessConfig } from "../server/agents/OpenFrontierBetaAccess";
import { loadOpenFrontierDemoServerNetworkConfig } from "../server/agents/OpenFrontierDemoServerConfig";
import {
  buildOpenFrontierPublicReadinessReport,
  formatOpenFrontierPublicReadinessReport,
  publicReadinessExitCode,
} from "../server/agents/OpenFrontierPublicReadiness";
import { defaultOpenFrontierNationsDir } from "../server/agents/OpenFrontierNationRegistry";

const args = process.argv.slice(2);
const json = args.includes("--json");
const requireReady = args.includes("--require-ready");
const allowWarnings = args.includes("--allow-warnings");
const rendererBaseUrl =
  stringArg(args, "--renderer-base-url=") ??
  process.env.AI_LEAGUE_RENDERER_BASE_URL ??
  "http://127.0.0.1:9000";
const jobs = await readJobHistory();
const runningJobID =
  jobs.find((job) => job.status === "running")?.jobID ?? null;
const queuedJobCount = jobs.filter((job) => job.status === "queued").length;
const hub = await loadAgentDemoHubModel({
  runsRootDir: path.join(process.cwd(), "artifacts", "ai-league-runs"),
  tournamentsRootDir: path.join(process.cwd(), "artifacts", "ai-league-tournaments"),
  evaluationsRootDir: path.join(process.cwd(), "artifacts", "ai-league-evals"),
  rendererBaseUrl,
  jobs,
  nationsDir: defaultOpenFrontierNationsDir,
});
const report = buildOpenFrontierPublicReadinessReport({
  beta: loadOpenFrontierBetaAccessConfig(process.env),
  network: loadOpenFrontierDemoServerNetworkConfig(process.env),
  hub,
  runningJobID,
  queuedJobCount,
  maxQueuedJobs: positiveInt(process.env.OPEN_FRONTIER_MAX_QUEUED_JOBS, 3),
  allowPrivateAgentEndpoints:
    process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
  adminEnabled: process.env.OPEN_FRONTIER_BETA_ADMIN_ENABLED === "true",
});

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${formatOpenFrontierPublicReadinessReport(report)}\n`);
}

if (requireReady) {
  process.exitCode = publicReadinessExitCode(report, { allowWarnings });
}

async function readJobHistory(): Promise<AgentDemoJobRecord[]> {
  const jobsPath = path.join(
    process.cwd(),
    "artifacts",
    "ai-league-demo-jobs",
    "jobs.json",
  );
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

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
