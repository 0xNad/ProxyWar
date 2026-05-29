import { spawn } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { legalActionKinds } from "./AgentTypes";
import { LlmProvider, LlmProviderConfigError } from "./LlmProvider";

export interface CodexCliCommandInput {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
}

export interface CodexCliCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

export type CodexCliCommandRunner = (
  input: CodexCliCommandInput,
) => Promise<CodexCliCommandResult>;

export interface CodexCliLlmProviderConfig {
  command: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  reasoningEffort?: string;
  profile?: string;
  outputSchema?: "decision" | "planner" | "researcher";
  commandRunner?: CodexCliCommandRunner;
}

export const DEFAULT_CODEX_PLANNER_MODEL = "gpt-5.4";
export const DEFAULT_CODEX_PLANNER_REASONING_EFFORT = "medium";
export const DEFAULT_CODEX_RESEARCHER_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_RESEARCHER_REASONING_EFFORT = "high";

const bundledCodexCliPath = "/Applications/Codex.app/Contents/Resources/codex";

const codexDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selectedLegalActionId", "reason", "confidence"],
  properties: {
    selectedLegalActionId: {
      type: "string",
      minLength: 1,
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 280,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
} as const;

const codexPlannerSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "objective",
    "turnIntent",
    "rationale",
    "maxDecisionCycles",
    "preferredActionKinds",
    "enabledModules",
    "targetPlayerId",
    "tacticalSettings",
  ],
  properties: {
    objective: {
      type: "string",
      enum: [
        "choose_spawn",
        "expand_territory",
        "secure_economy",
        "fortify_border",
        "pressure_rival",
        "build_alliance",
        "survive",
      ],
    },
    turnIntent: {
      type: "string",
      enum: [
        "spawn",
        "growth",
        "build",
        "fortify",
        "pressure",
        "survive",
        "diplomacy",
        "naval",
      ],
    },
    rationale: {
      type: "string",
      minLength: 1,
      maxLength: 280,
    },
    maxDecisionCycles: {
      type: "number",
      minimum: 1,
      maximum: 8,
    },
    preferredActionKinds: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "string",
        enum: legalActionKinds,
      },
    },
    enabledModules: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "string",
        enum: [
          "emergency_survival",
          "spawn_opening",
          "expansion",
          "defense",
          "economy",
          "diplomacy",
          "combat",
          "naval",
          "nuclear_endgame",
          "utility_social",
        ],
      },
    },
    targetPlayerId: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    tacticalSettings: {
      type: "object",
      additionalProperties: false,
      required: [
        "reserveRatio",
        "triggerRatio",
        "expansionRatio",
        "maxConcurrentWars",
        "retreatThreshold",
        "maxActionsPerDecision",
      ],
      properties: {
        reserveRatio: { type: "number", minimum: 0.1, maximum: 0.8 },
        triggerRatio: { type: "number", minimum: 0.2, maximum: 1 },
        expansionRatio: { type: "number", minimum: 0.05, maximum: 0.4 },
        maxConcurrentWars: { type: "number", minimum: 1, maximum: 3 },
        retreatThreshold: { type: "number", minimum: 0.1, maximum: 0.8 },
        maxActionsPerDecision: { type: "number", minimum: 1, maximum: 8 },
      },
    },
  },
} as const;

const codexResearcherSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "failurePattern",
    "evidence",
    "hypothesis",
    "plannerControls",
    "proposal",
    "abBenchmark",
    "canonicalCompliance",
    "missingObservationFields",
    "riskNotes",
  ],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 800 },
    failurePattern: { type: "string", minLength: 1, maxLength: 800 },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "artifact",
          "run",
          "turn",
          "selectedActionId",
          "metric",
          "claim",
        ],
        properties: {
          artifact: { type: "string", minLength: 1, maxLength: 160 },
          run: { anyOf: [{ type: "string" }, { type: "null" }] },
          turn: { anyOf: [{ type: "number" }, { type: "null" }] },
          selectedActionId: { anyOf: [{ type: "string" }, { type: "null" }] },
          metric: { anyOf: [{ type: "string" }, { type: "null" }] },
          claim: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    hypothesis: { type: "string", minLength: 1, maxLength: 800 },
    plannerControls: {
      type: "object",
      additionalProperties: false,
      required: [
        "objective",
        "preferredActionKinds",
        "enabledModules",
        "tacticalSettingsChange",
      ],
      properties: {
        objective: {
          anyOf: [
            {
              type: "string",
              enum: [
                "choose_spawn",
                "expand_territory",
                "secure_economy",
                "fortify_border",
                "pressure_rival",
                "build_alliance",
                "survive",
              ],
            },
            { type: "null" },
          ],
        },
        preferredActionKinds: {
          type: "array",
          maxItems: 5,
          items: { type: "string", enum: legalActionKinds },
        },
        enabledModules: {
          type: "array",
          maxItems: 6,
          items: {
            type: "string",
            enum: [
              "emergency_survival",
              "spawn_opening",
              "expansion",
              "defense",
              "economy",
              "diplomacy",
              "combat",
              "naval",
              "nuclear_endgame",
              "utility_social",
            ],
          },
        },
        tacticalSettingsChange: {
          type: "string",
          minLength: 1,
          maxLength: 500,
        },
      },
    },
    proposal: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "change",
        "allowedFiles",
        "expectedMetricMovement",
        "rejectCriteria",
      ],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        change: { type: "string", minLength: 1, maxLength: 1000 },
        allowedFiles: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        expectedMetricMovement: {
          type: "string",
          minLength: 1,
          maxLength: 500,
        },
        rejectCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: { type: "string", minLength: 1, maxLength: 240 },
        },
      },
    },
    abBenchmark: {
      type: "object",
      additionalProperties: false,
      required: ["baselineCommand", "candidateCommand", "metrics"],
      properties: {
        baselineCommand: { type: "string", minLength: 1, maxLength: 500 },
        candidateCommand: { type: "string", minLength: 1, maxLength: 500 },
        metrics: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
    },
    canonicalCompliance: {
      type: "object",
      additionalProperties: false,
      required: [
        "usesExistingLegalActionIds",
        "rawIntentPathRequired",
        "newRunnerRequired",
        "newActionSchemaRequired",
        "newValidatorRequired",
        "newObjectiveKindRequired",
        "coreChangesRequired",
      ],
      properties: {
        usesExistingLegalActionIds: { type: "boolean" },
        rawIntentPathRequired: { type: "boolean" },
        newRunnerRequired: { type: "boolean" },
        newActionSchemaRequired: { type: "boolean" },
        newValidatorRequired: { type: "boolean" },
        newObjectiveKindRequired: { type: "boolean" },
        coreChangesRequired: { type: "boolean" },
      },
    },
    missingObservationFields: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    riskNotes: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
  },
} as const;

export class CodexCliLlmProvider implements LlmProvider {
  readonly providerType = "codex-cli";
  private readonly commandRunner: CodexCliCommandRunner;

  constructor(private readonly config: CodexCliLlmProviderConfig) {
    this.commandRunner = config.commandRunner ?? runCodexCliCommand;
  }

  async complete(prompt: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-codex-cli-"));
    const schemaPath = path.join(tempDir, "decision.schema.json");
    const outputPath = path.join(tempDir, "last-message.txt");

    try {
      await fs.writeFile(
        schemaPath,
        `${JSON.stringify(this.outputSchema(), null, 2)}\n`,
      );

      const result = await this.commandRunner({
        command: this.config.command,
        args: this.codexArgs(schemaPath, outputPath),
        stdin: codexPrompt(prompt, this.config.outputSchema ?? "decision"),
        cwd: this.config.cwd,
        timeoutMs: this.config.timeoutMs,
      });
      this.assertCommandSucceeded(result);

      const finalText = await readFinalMessage(outputPath, result.stdout);
      if (finalText.trim() === "") {
        throw new Error("Codex CLI returned an empty final message");
      }
      return finalText.trim();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private codexArgs(schemaPath: string, outputPath: string): string[] {
    return [
      "exec",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--cd",
      this.config.cwd,
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.reasoningEffort
        ? ["-c", `model_reasoning_effort="${this.config.reasoningEffort}"`]
        : []),
      ...(this.config.profile ? ["--profile", this.config.profile] : []),
      "-",
    ];
  }

  private outputSchema() {
    switch (this.config.outputSchema) {
      case "planner":
        return codexPlannerSchema;
      case "researcher":
        return codexResearcherSchema;
      default:
        return codexDecisionSchema;
    }
  }

  private assertCommandSucceeded(result: CodexCliCommandResult): void {
    if (result.timedOut) {
      throw new Error(
        `Codex CLI timed out after ${this.config.timeoutMs}ms; no decision was accepted.`,
      );
    }

    if (result.error !== undefined) {
      if (result.error.code === "ENOENT") {
        throw new Error(
          `Codex CLI binary "${this.config.command}" was not found. Install Codex CLI or set AI_LEAGUE_CODEX_COMMAND.`,
        );
      }
      throw errorWithCause(
        `Codex CLI failed to start: ${result.error.message}`,
        result.error,
      );
    }

    if (result.exitCode !== 0) {
      const stderr = sanitizeCodexOutput(result.stderr);
      if (looksLikeAuthFailure(stderr)) {
        throw new Error(
          `Codex CLI is not logged in. Run "codex login" before using AI_LEAGUE_LLM_PROVIDER=codex-cli. ${stderr}`,
        );
      }
      throw new Error(
        `Codex CLI exited with code ${result.exitCode ?? "unknown"}: ${stderr}`,
      );
    }
  }
}

export function loadCodexCliLlmProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CodexCliLlmProviderConfig {
  const provider = env.AI_LEAGUE_LLM_PROVIDER?.trim().toLowerCase();
  if (provider !== "codex-cli") {
    throw new LlmProviderConfigError(
      "Codex CLI smoke requires AI_LEAGUE_LLM_PROVIDER=codex-cli.",
    );
  }

  const model =
    optionalNonEmpty(env.AI_LEAGUE_CODEX_MODEL) ??
    optionalNonEmpty(env.AI_LEAGUE_LLM_MODEL) ??
    DEFAULT_CODEX_PLANNER_MODEL;
  const reasoningEffort =
    optionalNonEmpty(env.AI_LEAGUE_CODEX_REASONING_EFFORT) ??
    optionalNonEmpty(env.AI_LEAGUE_LLM_REASONING_EFFORT) ??
    DEFAULT_CODEX_PLANNER_REASONING_EFFORT;

  return {
    command: resolveCodexCliCommand(env),
    cwd,
    timeoutMs: positiveIntegerEnv(env, "AI_LEAGUE_CODEX_TIMEOUT_MS", 120_000),
    model,
    reasoningEffort,
    profile: optionalNonEmpty(env.AI_LEAGUE_CODEX_PROFILE),
  };
}

export function resolveCodexCliCommand(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const explicitCommand = optionalNonEmpty(env.AI_LEAGUE_CODEX_COMMAND);
  if (explicitCommand !== undefined) {
    return explicitCommand;
  }
  return exists(bundledCodexCliPath) ? bundledCodexCliPath : "codex";
}

export function createCodexCliLlmProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CodexCliLlmProvider {
  return new CodexCliLlmProvider(loadCodexCliLlmProviderConfig(env, cwd));
}

async function runCodexCliCommand(
  input: CodexCliCommandInput,
): Promise<CodexCliCommandResult> {
  return await new Promise<CodexCliCommandResult>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let forceKillID: ReturnType<typeof setTimeout> | undefined;
    const timeoutID = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillID = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, input.timeoutMs);

    const finish = (
      result: Omit<CodexCliCommandResult, "stdout" | "stderr" | "timedOut">,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutID);
      if (forceKillID !== undefined) {
        clearTimeout(forceKillID);
      }
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, error });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode });
    });
    child.stdin.end(input.stdin);
  });
}

async function readFinalMessage(
  outputPath: string,
  fallbackStdout: string,
): Promise<string> {
  try {
    const fileOutput = await fs.readFile(outputPath, "utf8");
    if (fileOutput.trim() !== "") {
      return fileOutput;
    }
  } catch {
    // Fall back to stdout for tests or older CLI behavior.
  }
  return fallbackStdout;
}

function codexPrompt(
  prompt: string,
  outputSchema: NonNullable<CodexCliLlmProviderConfig["outputSchema"]>,
): string {
  const schemaInstruction = codexSchemaInstruction(outputSchema);
  return [
    prompt,
    "",
    "You are running inside Codex CLI for private AI Nations League testing.",
    "Do not run shell commands. Do not inspect files.",
    schemaInstruction,
    "Return only the JSON object that matches the provided output schema.",
  ].join("\n");
}

function codexSchemaInstruction(
  outputSchema: NonNullable<CodexCliLlmProviderConfig["outputSchema"]>,
): string {
  switch (outputSchema) {
    case "planner":
      return "Do not choose a LegalAction.id. Return only a strategic planner JSON object with objective, turnIntent, rationale, maxDecisionCycles, preferredActionKinds, enabledModules, targetPlayerId, and full tacticalSettings.";
    case "researcher":
      return "Do not choose actions, do not invent planner objective names, and do not propose raw game intents. Return only a post-match researcher JSON object with evidence, existing planner controls, one bounded proposal, canonical compliance flags, an A/B benchmark, missing observation fields, and risk notes.";
    default:
      return "Do not run shell commands. Do not inspect files. Choose exactly one listed LegalAction.id. Include confidence as a number from 0 to 1 because this Codex CLI schema requires it.";
  }
}

function positiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LlmProviderConfigError(
      `${name} must be a positive integer; received ${raw}.`,
    );
  }
  return value;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function looksLikeAuthFailure(stderr: string): boolean {
  return /login|logged in|auth|authenticate|unauthorized|sign in/i.test(stderr);
}

function sanitizeCodexOutput(value: string): string {
  const cleaned = value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .trim();
  if (cleaned.length <= 2_000) {
    return cleaned;
  }
  return `${cleaned.slice(0, 1_000)}\n...\n${cleaned.slice(-1_000)}`;
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}
