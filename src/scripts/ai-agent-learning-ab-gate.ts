import { spawn } from "child_process";

interface LearningAbGateConfig {
  gateID: string;
  tactic:
    | "transport-banking"
    | "opening-expansion-tempo"
    | "economy-cadence"
    | "frontier-finish-pressure"
    | "naval-control"
    | "late-game-strike-targeting"
    | "personality-diplomacy-pressure"
    | "profile-differentiation";
  baselineID: string;
  candidateID: string;
  comparisonID: string;
  runs: number;
  requireWins: number;
  startIndex: number;
  nations: number;
  bots: number;
  difficulty: string;
  map: string;
  mapSize: string;
  maxTurns: number;
  turnsPerDecision: number;
  planEveryDecisionSteps: number;
  brain: string;
  profile: string;
  fullMatch: boolean;
  writeReplay: boolean;
}

async function run() {
  const config = configFromArgs(process.argv.slice(2));
  const commonArgs = benchmarkArgs(config);
  const baselineTacticArgs = tacticArgs(config.tactic, false);
  const candidateTacticArgs = tacticArgs(config.tactic, true);

  await runTsx("src/scripts/ai-agent-frontier-benchmark.ts", [
    ...commonArgs,
    `--run-id=${config.baselineID}`,
    ...baselineTacticArgs,
  ]);
  await runTsx("src/scripts/ai-agent-frontier-benchmark.ts", [
    ...commonArgs,
    `--run-id=${config.candidateID}`,
    ...candidateTacticArgs,
  ]);
  await runTsx("src/scripts/ai-agent-learning-compare.ts", [
    `--baseline-id=${config.baselineID}`,
    `--candidate-id=${config.candidateID}`,
    `--comparison-id=${config.comparisonID}`,
    `--tactic=${config.tactic}`,
  ]);

  console.log("Agent learning A/B gate complete", {
    gateID: config.gateID,
    tactic: config.tactic,
    baselineID: config.baselineID,
    candidateID: config.candidateID,
    comparisonID: config.comparisonID,
    report: `artifacts/ai-learning-comparisons/${config.comparisonID}/ab-comparison.md`,
  });
}

function benchmarkArgs(config: LearningAbGateConfig): string[] {
  return [
    `--brain=${config.brain}`,
    ...(config.fullMatch ? ["--full-match"] : []),
    `--runs=${config.runs}`,
    `--require-wins=${config.requireWins}`,
    `--start-index=${config.startIndex}`,
    `--nations=${config.nations}`,
    `--bots=${config.bots}`,
    `--difficulty=${config.difficulty}`,
    `--map=${config.map}`,
    `--map-size=${config.mapSize}`,
    `--max-turns=${config.maxTurns}`,
    `--turns-per-decision=${config.turnsPerDecision}`,
    `--plan-every-decision-steps=${config.planEveryDecisionSteps}`,
    `--profile=${config.profile}`,
    ...(config.writeReplay ? ["--write-replay"] : []),
  ];
}

function configFromArgs(args: string[]): LearningAbGateConfig {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const gateID = stringArg(args, "--gate-id=", `learning-ab-gate-${timestamp}`);
  const runs = positiveIntegerArg(args, "--runs=", 3);
  const tactic = tacticArg(args);
  return {
    gateID,
    tactic,
    baselineID: stringArg(args, "--baseline-id=", `${gateID}-baseline`),
    candidateID: stringArg(args, "--candidate-id=", `${gateID}-candidate`),
    comparisonID: stringArg(args, "--comparison-id=", gateID),
    runs,
    requireWins: positiveIntegerArg(args, "--require-wins=", runs),
    startIndex: positiveIntegerArg(args, "--start-index=", 1),
    nations: positiveIntegerArg(args, "--nations=", 5),
    bots: nonNegativeIntegerArg(args, "--bots=", 0),
    difficulty: stringArg(args, "--difficulty=", "Hard"),
    map: stringArg(args, "--map=", "Pangaea"),
    mapSize: stringArg(args, "--map-size=", "Compact"),
    maxTurns: positiveIntegerArg(args, "--max-turns=", 90_000),
    turnsPerDecision: positiveIntegerArg(args, "--turns-per-decision=", 25),
    planEveryDecisionSteps: positiveIntegerArg(
      args,
      "--plan-every-decision-steps=",
      3,
    ),
    brain: stringArg(args, "--brain=", "planner"),
    profile: stringArg(
      args,
      "--profile=",
      tactic === "profile-differentiation" ? "all" : "aggressive",
    ),
    fullMatch: !args.includes("--quick"),
    writeReplay: args.includes("--write-replay"),
  };
}

function tacticArgs(
  tactic: LearningAbGateConfig["tactic"],
  candidate: boolean,
): string[] {
  if (tactic === "frontier-finish-pressure") {
    return [
      `--frontier-finish-pressure=${candidate}`,
      "--naval-control=true",
      "--late-game-strike-targeting=true",
      "--personality-diplomacy-pressure=true",
      "--profile-repair-rerank=true",
      "--opening-expansion-tempo=true",
      "--transport-troop-banking=true",
      "--human-replay-economy-cadence=true",
    ];
  }
  if (tactic === "naval-control") {
    return [
      "--frontier-finish-pressure=true",
      `--naval-control=${candidate}`,
      "--late-game-strike-targeting=true",
      "--personality-diplomacy-pressure=true",
      "--profile-repair-rerank=true",
      "--opening-expansion-tempo=true",
      "--transport-troop-banking=true",
      "--human-replay-economy-cadence=true",
    ];
  }
  if (tactic === "late-game-strike-targeting") {
    return [
      "--frontier-finish-pressure=true",
      "--naval-control=true",
      `--late-game-strike-targeting=${candidate}`,
      "--personality-diplomacy-pressure=true",
      "--profile-repair-rerank=true",
      "--opening-expansion-tempo=true",
      "--transport-troop-banking=true",
      "--human-replay-economy-cadence=true",
    ];
  }
  if (tactic === "personality-diplomacy-pressure") {
    return [
      "--frontier-finish-pressure=true",
      "--naval-control=true",
      "--late-game-strike-targeting=true",
      `--personality-diplomacy-pressure=${candidate}`,
      "--profile-repair-rerank=true",
      "--opening-expansion-tempo=true",
      "--transport-troop-banking=true",
      "--human-replay-economy-cadence=true",
    ];
  }
  if (tactic === "profile-differentiation") {
    return [
      "--frontier-finish-pressure=true",
      "--naval-control=true",
      "--late-game-strike-targeting=true",
      "--personality-diplomacy-pressure=true",
      `--profile-repair-rerank=${candidate}`,
      "--opening-expansion-tempo=true",
      "--transport-troop-banking=true",
      "--human-replay-economy-cadence=true",
    ];
  }
  if (tactic === "opening-expansion-tempo") {
    return [
      "--frontier-finish-pressure=true",
      "--naval-control=true",
      "--late-game-strike-targeting=true",
      "--personality-diplomacy-pressure=true",
      "--profile-repair-rerank=true",
      `--opening-expansion-tempo=${candidate}`,
      "--transport-troop-banking=true",
      "--human-replay-economy-cadence=true",
    ];
  }
  if (tactic === "transport-banking") {
    return [
      "--frontier-finish-pressure=true",
      "--naval-control=true",
      "--late-game-strike-targeting=true",
      "--personality-diplomacy-pressure=true",
      "--profile-repair-rerank=true",
      "--opening-expansion-tempo=false",
      `--transport-troop-banking=${candidate}`,
      "--human-replay-economy-cadence=true",
    ];
  }
  return [
    "--frontier-finish-pressure=true",
    "--naval-control=true",
    "--late-game-strike-targeting=true",
    "--personality-diplomacy-pressure=true",
    "--profile-repair-rerank=true",
    "--opening-expansion-tempo=true",
    "--transport-troop-banking=true",
    `--human-replay-economy-cadence=${candidate}`,
  ];
}

function tacticArg(args: string[]): LearningAbGateConfig["tactic"] {
  const value = stringArg(args, "--tactic=", "transport-banking");
  if (
    value === "transport-banking" ||
    value === "opening-expansion-tempo" ||
    value === "economy-cadence" ||
    value === "frontier-finish-pressure" ||
    value === "naval-control" ||
    value === "late-game-strike-targeting" ||
    value === "personality-diplomacy-pressure" ||
    value === "profile-differentiation"
  ) {
    return value;
  }
  throw new Error(
    `--tactic=${value} must be transport-banking, opening-expansion-tempo, economy-cadence, frontier-finish-pressure, naval-control, late-game-strike-targeting, personality-diplomacy-pressure, or profile-differentiation`,
  );
}

async function runTsx(script: string, args: string[]): Promise<void> {
  console.log(`Running ${script}`, args);
  await runCommand(npxCommand(), ["tsx", script, ...args], {
    ...process.env,
    GAME_ENV: process.env.GAME_ENV ?? "dev",
  });
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`,
        ),
      );
    });
  });
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function stringArg(
  args: string[],
  prefix: string,
  defaultValue: string,
): string {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ??
    defaultValue
  );
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${prefix}${raw} must be a non-negative integer`);
  }
  return value;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
