import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import {
  loadAgentManifestsFromDirectory,
} from "../server/agents/AgentManifest";
import {
  AgentTournamentRunArtifact,
  writeAgentTournamentArtifacts,
} from "../server/agents/AgentTournamentReport";

type TournamentBrain =
  | "rule"
  | "mock-llm"
  | "planner"
  | "codex-cli"
  | "planner-codex-cli";
type TournamentScenario = "normal" | "actions" | "attack" | "stepped";

const args = process.argv.slice(2);
const brain = enumArg<TournamentBrain>(args, "--brain=", [
  "mock-llm",
  "rule",
  "planner",
  "codex-cli",
  "planner-codex-cli",
]);
const scenario = enumArg<TournamentScenario>(args, "--scenario=", [
  "actions",
  "normal",
  "attack",
  "stepped",
]);
const runs = positiveIntegerArg(args, "--runs=", 2);
const manifestDir =
  stringArg(args, "--agent-manifest-dir=") ??
  path.join(process.cwd(), "docs", "ai-league-agent-manifests");
const smokeArgs = smokeArgsFromTournamentArgs(args);
const tournamentID =
  stringArg(args, "--tournament-id=") ??
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenario}-${brain}-${randomUUID().slice(0, 8)}`;
const startedAt = Date.now();
const manifests = await loadAgentManifestsFromDirectory(manifestDir);
const artifacts: AgentTournamentRunArtifact[] = [];

for (let index = 0; index < runs; index += 1) {
  const runID = `${tournamentID}-run-${index + 1}`;
  await runSmoke({ brain, scenario, runID, manifestDir, smokeArgs });
  artifacts.push(runArtifact(runID));
}

const paths = await writeAgentTournamentArtifacts({
  tournamentID,
  scenario,
  brain,
  startedAt,
  completedAt: Date.now(),
  manifests,
  runs: artifacts,
});

console.log("Proxy War tournament result", {
  tournamentID,
  brain,
  scenario,
  runs,
  manifestDir,
  artifacts: paths,
});

async function runSmoke(input: {
  brain: TournamentBrain;
  scenario: TournamentScenario;
  runID: string;
  manifestDir: string;
  smokeArgs: string[];
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
    if (!hasArg(input.smokeArgs, "--runner=") && !input.smokeArgs.includes("--step-locked")) {
      smokeArgs.push("--runner=step-locked");
    }
  }
  if (input.brain === "codex-cli" || input.brain === "planner-codex-cli") {
    if (!input.smokeArgs.includes("--disable-alliance-actions")) {
      smokeArgs.push("--disable-alliance-actions");
    }
    if (!hasArg(input.smokeArgs, "--max-decision-ms=")) {
      smokeArgs.push(`--max-decision-ms=${process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ?? "180000"}`);
    }
  }
  if (!hasArg(input.smokeArgs, "--max-steps=")) {
    smokeArgs.push("--max-steps=2");
  }
  smokeArgs.push(...input.smokeArgs);
  smokeArgs.push(`--run-id=${input.runID}`);
  smokeArgs.push(`--agent-manifest-dir=${input.manifestDir}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(localBin("tsx"), smokeArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GAME_ENV: "dev",
        ...(input.brain === "codex-cli" || input.brain === "planner-codex-cli"
          ? {
              AI_LEAGUE_LLM_PROVIDER: "codex-cli",
              AI_LEAGUE_CODEX_TIMEOUT_MS:
                process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ?? "180000",
            }
          : {}),
      },
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
        return;
      }
      reject(
        new Error(
          `tournament run ${input.runID} exited with code ${code}:\n${Buffer.concat(
            stderr,
          ).toString("utf8")}\n${Buffer.concat(stdout).toString("utf8")}`,
        ),
      );
    });
  });
}

function smokeArgsFromTournamentArgs(args: string[]): string[] {
  const passThroughPrefixes = [
    "--max-steps=",
    "--turns-per-decision-step=",
    "--replay-tail-turns=",
    "--bots=",
    "--nations=",
    "--map=",
    "--map-size=",
    "--difficulty=",
    "--max-decision-ms=",
    "--runner=",
  ];
  const passThroughFlags = new Set([
    "--vary-spawns",
    "--disable-alliance-actions",
    "--no-mirror-catchup",
    "--step-locked",
  ]);
  return args.filter(
    (arg) =>
      passThroughFlags.has(arg) ||
      passThroughPrefixes.some((prefix) => arg.startsWith(prefix)),
  );
}

function hasArg(args: string[], prefix: string): boolean {
  return args.some((arg) => arg.startsWith(prefix));
}

function runArtifact(runID: string): AgentTournamentRunArtifact {
  const directory = path.join(process.cwd(), "artifacts", "ai-league-runs", runID);
  return {
    runID,
    directory,
    summaryPath: path.join(directory, "match-summary.json"),
    reportPath: path.join(directory, "match-report.md"),
    visualReportPath: path.join(directory, "visual-report.html"),
    scorecardJsonPath: path.join(directory, "objective-scorecard.json"),
  };
}

function localBin(name: string): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
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
