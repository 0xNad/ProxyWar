import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import {
  AgentEvaluationRunArtifact,
  writeAgentEvaluationArtifacts,
} from "../server/agents/AgentEvaluationReport";
import { AgentBrainType } from "../server/agents/AgentTypes";

type EvalBrain = "rule" | "mock-llm" | "planner" | "codex-cli" | "planner-codex-cli";
type EvalScenario = "normal" | "actions" | "attack" | "stepped";

async function run() {
  const args = process.argv.slice(2);
  const brain = enumArg<EvalBrain>(args, "--brain=", [
    "rule",
    "mock-llm",
    "planner",
    "codex-cli",
    "planner-codex-cli",
  ]);
  const scenario = enumArg<EvalScenario>(args, "--scenario=", [
    "normal",
    "actions",
    "attack",
    "stepped",
  ]);
  const runs = positiveIntegerArg(args, "--runs=", 1);
  const evalID =
    stringArg(args, "--eval-id=") ??
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenario}-${brain}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const artifacts: AgentEvaluationRunArtifact[] = [];

  for (let index = 0; index < runs; index++) {
    const runID = `${evalID}-run-${index + 1}`;
    await runSmoke({
      brain,
      scenario,
      runID,
    });
    artifacts.push(runArtifact(runID));
  }

  const paths = await writeAgentEvaluationArtifacts({
    evalID,
    brain: evaluationBrainType(brain),
    scenario,
    startedAt,
    completedAt: Date.now(),
    runs: artifacts,
  });

  console.log("Proxy War evaluation result", {
    evalID,
    brain,
    scenario,
    runs,
    artifacts: paths,
  });
}

function evaluationBrainType(brain: EvalBrain): AgentBrainType {
  return brain === "planner" || brain === "planner-codex-cli"
    ? "planner-executor"
    : (brain as AgentBrainType);
}

async function runSmoke(input: {
  brain: EvalBrain;
  scenario: EvalScenario;
  runID: string;
}): Promise<void> {
  const smokeArgs = ["src/scripts/ai-agent-league-smoke.ts"];
  if (input.brain !== "rule") {
    smokeArgs.push(`--brain=${input.brain}`);
  }

  if (input.scenario === "attack" || input.scenario === "actions") {
    smokeArgs.push(`--scenario=${input.scenario}`);
  }

  if (
    input.scenario === "stepped" ||
    input.brain === "codex-cli" ||
    input.brain === "planner" ||
    input.brain === "planner-codex-cli"
  ) {
    smokeArgs.push("--runner=step-locked");
  }
  if (input.brain === "planner-codex-cli") {
    smokeArgs.push("--disable-alliance-actions");
  }

  smokeArgs.push(`--run-id=${input.runID}`);

  const env = {
    ...process.env,
    GAME_ENV: "dev",
    ...(input.brain === "codex-cli" || input.brain === "planner-codex-cli"
      ? {
          AI_LEAGUE_LLM_PROVIDER: "codex-cli",
          AI_LEAGUE_CODEX_TIMEOUT_MS:
            process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ?? "180000",
        }
      : {}),
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(localBin("tsx"), smokeArgs, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `evaluation smoke run ${input.runID} exited with code ${code}:\n${Buffer.concat(
              stderr,
            ).toString("utf8")}\n${Buffer.concat(stdout).toString("utf8")}`,
          ),
        );
      }
    });
  });
}

function localBin(name: string): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function runArtifact(runID: string): AgentEvaluationRunArtifact {
  const directory = path.join(process.cwd(), "artifacts", "ai-league-runs", runID);
  return {
    runID,
    directory,
    decisionsPath: path.join(directory, "decisions.jsonl"),
    summaryPath: path.join(directory, "match-summary.json"),
    reportPath: path.join(directory, "match-report.md"),
    visualReportPath: path.join(directory, "visual-report.html"),
    scorecardJsonPath: path.join(directory, "objective-scorecard.json"),
    scorecardMarkdownPath: path.join(directory, "objective-scorecard.md"),
  };
}

function enumArg<T extends string>(
  args: string[],
  prefix: string,
  values: readonly T[],
): T {
  const raw = stringArg(args, prefix);
  if (raw === null) {
    return values[0]!;
  }
  if ((values as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(`${prefix}${raw} must be one of ${values.join(", ")}`);
}

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = stringArg(args, prefix);
  if (raw === null || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

await run();
