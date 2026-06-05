import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import {
  checkExternalAgentEndpoint,
  normalizeExternalAgentHealthCheckInput,
} from "../server/agents/ExternalAgentHealthCheck";
import {
  buildExternalAgentDryRunSmokeArgs,
  parseExternalAgentDryRunSmokeOutput,
  writeExternalAgentDryRunManifests,
} from "../server/agents/ExternalAgentDryRun";

interface DryRunOptions {
  endpointUrl: string | null;
  port: number;
  timeoutMs: number;
  maxSteps: number;
  turnsPerDecisionStep: number;
  replayTailTurns: number;
}

const options = parseArgs(process.argv.slice(2));
const dryRunID = new Date().toISOString().replace(/[:.]/g, "-");
const dryRunDir = path.join(
  process.cwd(),
  "artifacts",
  "proxywar",
  "external-agent-dry-runs",
  dryRunID,
);
const manifestDir = path.join(dryRunDir, "manifests");
const endpointUrl =
  options.endpointUrl ??
  `http://127.0.0.1:${options.port}/proxywar/decide`;
const children: ChildProcess[] = [];

process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS =
  process.env.PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS ?? "true";

try {
  await fs.mkdir(dryRunDir, { recursive: true });

  if (options.endpointUrl === null) {
    if (process.env.OPENROUTER_API_KEY === undefined) {
      throw new Error(
        "OPENROUTER_API_KEY is required to start the bundled LLM starter agent. Pass --endpoint-url=... to test an already-running agent instead.",
      );
    }
    children.push(startExampleAgent(options.port));
    await waitForHealthyEndpoint(endpointUrl, options.timeoutMs);
  }

  const health = await checkExternalAgentEndpoint(
    normalizeExternalAgentHealthCheckInput({
      endpointUrl,
      timeoutMs: options.timeoutMs,
    }),
  );
  if (!health.ok) {
    throw new Error(
      `External agent health check failed: ${health.failureReason ?? "unknown"}`,
    );
  }

  const manifestPaths = await writeExternalAgentDryRunManifests({
    directory: manifestDir,
    endpointUrl,
    timeoutMs: options.timeoutMs,
  });

  const smokeArgs = buildExternalAgentDryRunSmokeArgs({
    manifestDir,
    maxSteps: options.maxSteps,
    turnsPerDecisionStep: options.turnsPerDecisionStep,
    replayTailTurns: options.replayTailTurns,
  });
  const smoke = await runChild(localBin("tsx"), smokeArgs, {
    ...process.env,
    GAME_ENV: "dev",
    PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS: "true",
  });
  const parsed = parseExternalAgentDryRunSmokeOutput(smoke.output);
  const summary = {
    dryRunID,
    endpointUrl,
    health,
    manifestDir,
    manifestPaths,
    smokeExitCode: smoke.exitCode,
    ...parsed,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(dryRunDir, "external-agent-dry-run-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log("Proxy War external-agent dry run passed", summary);
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

function startExampleAgent(port: number): ChildProcess {
  const child = spawn(process.execPath, ["examples/external-agent/simple-agent.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXYWAR_AGENT_HOST: "127.0.0.1",
      PROXYWAR_AGENT_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.on("error", (error) => {
    console.error(`Example external agent failed to start: ${error.message}`);
  });
  return child;
}

async function waitForHealthyEndpoint(
  endpointUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastFailure = "endpoint did not respond";
  while (Date.now() < deadline) {
    const result = await checkExternalAgentEndpoint(
      normalizeExternalAgentHealthCheckInput({
        endpointUrl,
        timeoutMs: Math.min(timeoutMs, 1_000),
      }),
    );
    if (result.ok) return;
    lastFailure = result.failureReason ?? lastFailure;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Example external agent was not healthy: ${lastFailure}`);
}

async function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        reject(new Error(`dry-run league smoke exited with ${exitCode}`));
        return;
      }
      resolve({ exitCode, output });
    });
  });
}

function parseArgs(args: string[]): DryRunOptions {
  return {
    endpointUrl: stringArg(args, "--endpoint-url="),
    port: positiveIntegerArg(args, "--port=", 7777),
    timeoutMs: positiveIntegerArg(args, "--timeout-ms=", 5_000),
    maxSteps: positiveIntegerArg(args, "--max-steps=", 2),
    turnsPerDecisionStep: positiveIntegerArg(args, "--turns-per-decision-step=", 50),
    replayTailTurns: nonNegativeIntegerArg(args, "--replay-tail-turns=", 100),
  };
}

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const value = nonNegativeIntegerArg(args, prefix, defaultValue);
  if (value <= 0) {
    throw new Error(`${prefix} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = stringArg(args, prefix);
  if (raw === null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${prefix}${raw} must be a non-negative integer`);
  }
  return value;
}

function localBin(name: string): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

export const externalAgentDryRunScriptUrl = pathToFileURL(import.meta.url).href;
