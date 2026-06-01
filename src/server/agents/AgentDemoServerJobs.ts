import path from "path";
import { defaultProxyWarActiveRosterDir } from "./ProxyWarNationRegistry";

export type AgentDemoJobKind = "demo" | "evaluation" | "tournament";

export type AgentDemoBrain =
  | "rule"
  | "mock-llm"
  | "planner"
  | "codex-cli"
  | "planner-codex-cli"
  | "external-http";

export type AgentDemoScenario = "normal" | "actions" | "attack" | "stepped";
export type AgentDemoRoster = "default" | "manifest" | "saved";
export type AgentDemoMatchLength = "showcase" | "full";

export interface AgentDemoJobRequest {
  kind: AgentDemoJobKind;
  brain: AgentDemoBrain;
  scenario: AgentDemoScenario;
  roster?: AgentDemoRoster;
  maxSavedNations?: number;
  matchLength?: AgentDemoMatchLength;
  runs?: number;
  maxSteps?: number;
  maxTurns?: number;
  turnsPerDecision?: number;
  bots?: number;
  nations?: number;
  replayTailTurns?: number;
  externalAgentEndpointUrl?: string;
  externalAgentTimeoutMs?: number;
}

export interface AgentDemoJobCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
  label: string;
}

export interface BuildAgentDemoJobCommandOptions {
  artifactID?: string;
}

export type AgentDemoJobStatus = "queued" | "running" | "completed" | "failed";

export interface AgentDemoJobRecord {
  jobID: string;
  artifactID?: string;
  label: string;
  request: AgentDemoJobRequest;
  status: AgentDemoJobStatus;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  outputTail: string;
  latestRunID?: string;
  latestTournamentID?: string;
  latestEvaluationID?: string;
  errorSummary?: string;
}

const jobKinds: readonly AgentDemoJobKind[] = [
  "demo",
  "evaluation",
  "tournament",
];
const brains: readonly AgentDemoBrain[] = [
  "rule",
  "mock-llm",
  "planner",
  "codex-cli",
  "planner-codex-cli",
  "external-http",
];
const houseAgentBrains: readonly AgentDemoBrain[] = [
  "codex-cli",
  "planner-codex-cli",
];
const scenarios: readonly AgentDemoScenario[] = [
  "normal",
  "actions",
  "attack",
  "stepped",
];
const rosters: readonly AgentDemoRoster[] = ["default", "manifest", "saved"];
const matchLengths: readonly AgentDemoMatchLength[] = ["showcase", "full"];
const defaultManifestDir = path.join(
  process.cwd(),
  "docs",
  "ai-league-agent-manifests",
);
const fullMatchDecisionSchedule = "25x20,100x30,250x40,500x150";

export const proxyWarTesterSavedRosterJobDefaults = {
  kind: "demo",
  scenario: "actions",
  roster: "saved",
  matchLength: "showcase",
  maxSavedNations: 1,
  maxSteps: 12,
  bots: 0,
  nations: 0,
  replayTailTurns: 500,
} as const;

export function normalizeAgentDemoJobRequest(
  raw: Record<string, unknown>,
): AgentDemoJobRequest {
  const kind = enumValue(raw.kind, jobKinds, "demo");
  const matchLength = enumValue(raw.matchLength, matchLengths, "showcase");
  const maxTurns = boundedInteger(raw.maxTurns, 1_000, 90_000, 90_000);
  const turnsPerDecision = boundedInteger(raw.turnsPerDecision, 25, 500, 100);
  const fullMatchStepCap = Math.min(
    240,
    Math.max(30, Math.ceil(maxTurns / turnsPerDecision)),
  );
  return {
    kind,
    brain: enumValue(
      raw.brain,
      brains,
      kind === "demo" ? "planner-codex-cli" : "mock-llm",
    ),
    scenario: enumValue(raw.scenario, scenarios, "actions"),
    roster: enumValue(
      raw.roster,
      rosters,
      kind === "demo" ? "default" : "manifest",
    ),
    maxSavedNations: boundedOptionalInteger(raw.maxSavedNations, 0, 8),
    matchLength,
    runs: boundedInteger(raw.runs, 1, 5, kind === "evaluation" ? 2 : 1),
    maxSteps: boundedInteger(
      raw.maxSteps,
      1,
      matchLength === "full" ? 240 : 30,
      kind === "demo" ? (matchLength === "full" ? fullMatchStepCap : 12) : 5,
    ),
    maxTurns,
    turnsPerDecision,
    bots: boundedInteger(
      raw.bots,
      0,
      12,
      kind === "demo" ? (matchLength === "full" ? 0 : 5) : 4,
    ),
    nations: boundedInteger(
      raw.nations,
      0,
      12,
      kind === "demo"
        ? matchLength === "full"
          ? 0
          : 5
        : kind === "tournament"
          ? 4
          : 0,
    ),
    replayTailTurns: boundedInteger(raw.replayTailTurns, 0, 1_500, 350),
    externalAgentEndpointUrl:
      typeof raw.externalAgentEndpointUrl === "string" &&
      raw.externalAgentEndpointUrl.trim() !== ""
        ? raw.externalAgentEndpointUrl.trim()
        : undefined,
    externalAgentTimeoutMs: boundedInteger(
      raw.externalAgentTimeoutMs,
      250,
      180_000,
      30_000,
    ),
  };
}

export function loadProxyWarHouseAgentBrain(
  env: NodeJS.ProcessEnv = process.env,
): AgentDemoBrain {
  return enumValue(
    env.PROXYWAR_HOUSE_AGENT_BRAIN,
    houseAgentBrains,
    "planner-codex-cli",
  );
}

export function agentDemoBrainUsesCodex(brain: AgentDemoBrain): boolean {
  return usesCodex(brain);
}

export function buildAgentDemoJobCommand(
  request: AgentDemoJobRequest,
  options: BuildAgentDemoJobCommandOptions = {},
): AgentDemoJobCommand {
  const env = {
    GAME_ENV: "dev",
    ...(usesCodex(request.brain)
      ? {
          AI_LEAGUE_LLM_PROVIDER: "codex-cli",
          AI_LEAGUE_CODEX_TIMEOUT_MS:
            process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ?? "180000",
          AI_LEAGUE_CODEX_MODEL:
            process.env.AI_LEAGUE_CODEX_MODEL ??
            process.env.AI_LEAGUE_LLM_MODEL ??
            "gpt-5.4",
          AI_LEAGUE_CODEX_REASONING_EFFORT:
            process.env.AI_LEAGUE_CODEX_REASONING_EFFORT ??
            process.env.AI_LEAGUE_LLM_REASONING_EFFORT ??
            "medium",
          AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS: "true",
        }
      : {}),
  };

  if (request.kind === "evaluation") {
    return {
      executable: localBin("tsx"),
      args: [
        "src/scripts/ai-agent-evaluate.ts",
        `--brain=${request.brain}`,
        `--scenario=${request.scenario}`,
        `--runs=${request.runs ?? 1}`,
        ...(options.artifactID !== undefined
          ? [`--eval-id=${options.artifactID}`]
          : []),
      ],
      env,
      label: `${request.brain} evaluation (${request.scenario})`,
    };
  }

  if (request.kind === "tournament") {
    return {
      executable: localBin("tsx"),
      args: [
        "src/scripts/ai-agent-tournament.ts",
        `--brain=${request.brain}`,
        `--scenario=${request.scenario}`,
        `--runs=${request.runs ?? 1}`,
        ...(options.artifactID !== undefined
          ? [`--tournament-id=${options.artifactID}`]
          : []),
        `--agent-manifest-dir=${defaultManifestDir}`,
        `--max-steps=${request.maxSteps ?? 5}`,
        "--turns-per-decision-step=25",
        `--replay-tail-turns=${request.replayTailTurns ?? 350}`,
        `--bots=${request.bots ?? 4}`,
        `--nations=${nationsArgValue(request.nations)}`,
        "--map=Pangaea",
        "--map-size=Compact",
        "--vary-spawns",
      ],
      env,
      label: `${request.brain} tournament (${request.scenario})`,
    };
  }

  if (request.brain === "external-http") {
    throw new Error(
      "External agents enter beta matches through saved roster manifests. Use brain=planner-codex-cli with roster=saved.",
    );
  }

  return {
    executable: localBin("tsx"),
    args:
      request.matchLength === "full"
        ? fullAgentLeagueDemoArgs(request, options.artifactID)
        : demoArgs(request, options.artifactID),
    env,
    label:
      request.matchLength === "full"
        ? `${request.brain} full match (${request.scenario})`
        : `${request.brain} demo (${request.scenario})`,
  };
}

function fullAgentLeagueDemoArgs(
  request: AgentDemoJobRequest,
  artifactID: string | undefined,
): string[] {
  if (request.brain === "external-http") {
    throw new Error(
      "External agents enter full beta matches through saved roster manifests. Use brain=planner-codex-cli with roster=saved.",
    );
  }
  return [
    "src/scripts/ai-agent-league-smoke.ts",
    `--brain=${request.brain}`,
    "--runner=step-locked",
    "--scenario=actions",
    `--max-steps=${request.maxSteps ?? 120}`,
    `--turns-per-decision-step=${request.turnsPerDecision ?? 100}`,
    `--turns-per-decision-schedule=${fullMatchDecisionSchedule}`,
    "--max-spawn-advance-turns=3000",
    `--replay-tail-turns=${request.replayTailTurns ?? 500}`,
    `--bots=${request.bots ?? 0}`,
    `--nations=${nationsArgValue(request.nations)}`,
    "--map=Pangaea",
    "--map-size=Compact",
    "--vary-spawns",
    ...(usesCodex(request.brain)
      ? [
          "--disable-alliance-actions",
          `--max-decision-ms=${process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ?? "180000"}`,
        ]
      : []),
    ...(request.roster === "manifest" || request.roster === "saved"
      ? [
          `--agent-manifest-dir=${
            request.roster === "saved"
              ? defaultProxyWarActiveRosterDir
              : defaultManifestDir
          }`,
        ]
      : []),
    ...(artifactID !== undefined ? [`--run-id=${artifactID}`] : []),
  ];
}

function demoArgs(
  request: AgentDemoJobRequest,
  artifactID: string | undefined,
): string[] {
  const args = [
    "src/scripts/ai-agent-league-smoke.ts",
    `--brain=${request.brain}`,
    "--runner=step-locked",
    `--max-steps=${request.maxSteps ?? 12}`,
    "--turns-per-decision-step=25",
    `--replay-tail-turns=${request.replayTailTurns ?? 350}`,
    `--bots=${request.bots ?? 4}`,
    `--nations=${nationsArgValue(request.nations)}`,
    "--map=Pangaea",
    "--map-size=Compact",
    "--vary-spawns",
    ...(artifactID !== undefined ? [`--run-id=${artifactID}`] : []),
  ];

  if (request.scenario === "actions" || request.scenario === "attack") {
    args.push(`--scenario=${request.scenario}`);
  }
  if (usesCodex(request.brain)) {
    args.push("--disable-alliance-actions");
    args.push(
      `--max-decision-ms=${process.env.AI_LEAGUE_CODEX_TIMEOUT_MS ?? "180000"}`,
    );
  }
  if (request.roster === "manifest" || request.roster === "saved") {
    args.push(
      `--agent-manifest-dir=${
        request.roster === "saved"
          ? defaultProxyWarActiveRosterDir
          : defaultManifestDir
      }`,
    );
  }

  return args;
}

function nationsArgValue(value: number | undefined): string {
  return value === undefined || value === 0 ? "disabled" : String(value);
}

function usesCodex(brain: AgentDemoBrain): boolean {
  return brain === "codex-cli" || brain === "planner-codex-cli";
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw new Error(`${String(value)} must be one of ${allowed.join(", ")}`);
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${String(value)} must be an integer from ${min} to ${max}`,
    );
  }
  return parsed;
}

function boundedOptionalInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return boundedInteger(value, min, max, min);
}

function localBin(name: string): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}
