import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
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

export type CodexCliTransport = "app-server" | "exec";

export interface CodexAppServerCompletionInput {
  command: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  idleCloseMs: number;
  model?: string;
  reasoningEffort?: string;
  profile?: string;
  outputSchema: "decision" | "planner" | "researcher";
  schema: unknown;
}

export interface CodexAppServerCompletionClient {
  complete(input: CodexAppServerCompletionInput): Promise<string>;
  close?(): void;
}

export interface CodexCliLlmProviderConfig {
  command: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  reasoningEffort?: string;
  profile?: string;
  outputSchema?: "decision" | "planner" | "researcher";
  transport?: CodexCliTransport;
  commandRunner?: CodexCliCommandRunner;
  appServerClient?: CodexAppServerCompletionClient;
  appServerFallbackToExec?: boolean;
  appServerIdleCloseMs?: number;
}

// Locked in-house Codex agent model per beta operator direction.
export const DEFAULT_CODEX_PLANNER_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_PLANNER_REASONING_EFFORT = "medium";
export const DEFAULT_CODEX_RESEARCHER_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_RESEARCHER_REASONING_EFFORT = "high";

const bundledCodexCliPath = "/Applications/Codex.app/Contents/Resources/codex";
export const DEFAULT_CODEX_APP_SERVER_IDLE_CLOSE_MS = 30 * 60 * 1_000;

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
  private readonly configuredAppServerClient: CodexAppServerCompletionClient | null;
  private appServerClient: CodexAppServerCompletionClient | null = null;
  private appServerDisabledReason: string | null = null;

  constructor(private readonly config: CodexCliLlmProviderConfig) {
    this.commandRunner = config.commandRunner ?? runCodexCliCommand;
    this.configuredAppServerClient = config.appServerClient ?? null;
  }

  async complete(prompt: string): Promise<string> {
    if (this.transport() === "app-server" && this.appServerDisabledReason === null) {
      try {
        return await this.completeViaAppServer(prompt);
      } catch (error) {
        if (!this.shouldFallbackToExec()) {
          throw error;
        }
        this.appServerDisabledReason =
          error instanceof Error ? error.message : String(error);
        this.close();
      }
    }

    return await this.completeViaExec(prompt);
  }

  close(): void {
    this.configuredAppServerClient?.close?.();
    this.appServerClient?.close?.();
    this.appServerClient = null;
  }

  private async completeViaAppServer(prompt: string): Promise<string> {
    const finalText = await this.codexAppServerClient().complete({
      command: this.config.command,
      prompt: codexPrompt(prompt, this.config.outputSchema ?? "decision"),
      cwd: this.config.cwd,
      timeoutMs: this.config.timeoutMs,
      idleCloseMs:
        this.config.appServerIdleCloseMs ??
        DEFAULT_CODEX_APP_SERVER_IDLE_CLOSE_MS,
      ...(this.config.model !== undefined ? { model: this.config.model } : {}),
      ...(this.config.reasoningEffort !== undefined
        ? { reasoningEffort: this.config.reasoningEffort }
        : {}),
      ...(this.config.profile !== undefined
        ? { profile: this.config.profile }
        : {}),
      outputSchema: this.config.outputSchema ?? "decision",
      schema: this.outputSchema(),
    });
    if (finalText.trim() === "") {
      throw new Error("Codex app-server returned an empty final message");
    }
    return finalText.trim();
  }

  private codexAppServerClient(): CodexAppServerCompletionClient {
    if (this.configuredAppServerClient !== null) {
      return this.configuredAppServerClient;
    }
    if (this.appServerClient === null) {
      this.appServerClient = new StdioCodexAppServerCompletionClient();
    }
    return this.appServerClient;
  }

  private async completeViaExec(prompt: string): Promise<string> {
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

  private transport(): CodexCliTransport {
    if (this.config.transport !== undefined) {
      return this.config.transport;
    }
    return this.config.commandRunner !== undefined ? "exec" : "app-server";
  }

  private shouldFallbackToExec(): boolean {
    return this.config.appServerFallbackToExec ?? true;
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
    transport: codexCliTransportFromEnv(env),
    appServerFallbackToExec:
      optionalNonEmpty(env.AI_LEAGUE_CODEX_APP_SERVER_FALLBACK)?.toLowerCase() !==
      "false",
    appServerIdleCloseMs: positiveIntegerEnv(
      env,
      "AI_LEAGUE_CODEX_APP_SERVER_IDLE_CLOSE_MS",
      DEFAULT_CODEX_APP_SERVER_IDLE_CLOSE_MS,
    ),
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

type JsonRpcID = number;

interface PendingJsonRpcRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutID: ReturnType<typeof setTimeout>;
}

interface PendingCodexAppServerTurn {
  threadID: string;
  turnID: string | null;
  text: string;
  settled: boolean;
  timeoutID: ReturnType<typeof setTimeout>;
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

class StdioCodexAppServerCompletionClient
  implements CodexAppServerCompletionClient
{
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private stdoutBuffer = "";
  private nextID = 1;
  private command: string | null = null;
  private idleCloseMs = DEFAULT_CODEX_APP_SERVER_IDLE_CLOSE_MS;
  private idleCloseID: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingRequests = new Map<JsonRpcID, PendingJsonRpcRequest>();
  private readonly pendingTurns = new Map<string, PendingCodexAppServerTurn>();
  private exitHookInstalled = false;

  async complete(input: CodexAppServerCompletionInput): Promise<string> {
    if (input.profile !== undefined) {
      throw new Error(
        "Codex app-server transport does not support AI_LEAGUE_CODEX_PROFILE; set AI_LEAGUE_CODEX_TRANSPORT=exec for profile-based runs.",
      );
    }

    await this.ensureStarted(input);
    this.idleCloseMs = input.idleCloseMs;
    const threadID = await this.startThread(input);
    const pendingTurn = this.createPendingTurn(threadID, input.timeoutMs);
    this.pendingTurns.set(threadID, pendingTurn);

    try {
      const turn = await this.request(
        "turn/start",
        {
          threadId: threadID,
          input: [
            {
              type: "text",
              text: input.prompt,
              text_elements: [],
            },
          ],
          cwd: input.cwd,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.reasoningEffort !== undefined
            ? { effort: input.reasoningEffort }
            : {}),
          outputSchema: input.schema,
        },
        input.timeoutMs,
      );
      pendingTurn.turnID = stringAtPath(turn, ["turn", "id"]);
      return await pendingTurn.promise;
    } finally {
      this.settlePendingTurn(
        pendingTurn,
        pendingTurn.settled
          ? null
          : new Error("Codex app-server turn ended before completion."),
      );
      await this.archiveThread(threadID);
      this.scheduleIdleClose();
    }
  }

  close(): void {
    if (this.idleCloseID !== null) {
      clearTimeout(this.idleCloseID);
      this.idleCloseID = null;
    }
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.rejectAll(new Error("Codex app-server transport closed."));
    child?.kill("SIGTERM");
  }

  private async ensureStarted(input: CodexAppServerCompletionInput): Promise<void> {
    if (this.idleCloseID !== null) {
      clearTimeout(this.idleCloseID);
      this.idleCloseID = null;
    }
    if (this.child !== null && this.command === input.command) {
      if (this.startPromise !== null) {
        await this.startPromise;
      }
      return;
    }

    this.close();
    this.command = input.command;
    this.child = spawn(input.command, ["app-server", "--listen", "stdio://"], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", () => {
      // Codex app-server writes operational warnings to stderr. Keep them out of
      // beta artifacts unless the JSON-RPC request itself fails.
    });
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      this.rejectAll(
        errorWithCause(appServerStartErrorMessage(input.command, error), error),
      );
    });
    this.child.on("close", (exitCode) => {
      this.child = null;
      this.startPromise = null;
      this.rejectAll(
        new Error(`Codex app-server exited with code ${exitCode ?? "unknown"}.`),
      );
    });
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.once("exit", () => this.child?.kill("SIGTERM"));
    }
    this.startPromise = this.request(
      "initialize",
      {
        clientInfo: {
          name: "proxywar-codex-house-agent",
          version: "1.0.0",
        },
        capabilities: null,
      },
      input.timeoutMs,
    ).then(() => undefined);
    await this.startPromise;
  }

  private async startThread(
    input: CodexAppServerCompletionInput,
  ): Promise<string> {
    const result = await this.request(
      "thread/start",
      {
        ...(input.model !== undefined ? { model: input.model } : {}),
        cwd: input.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        baseInstructions:
          "You are running inside Codex app-server for private AI Nations League testing. Return final JSON only.",
        developerInstructions:
          "Do not run shell commands. Do not inspect files. Do not use tools.",
        config: { mcp_servers: {} },
      },
      input.timeoutMs,
    );
    const threadID = stringAtPath(result, ["thread", "id"]);
    if (threadID === null) {
      throw new Error("Codex app-server did not return a thread id.");
    }
    return threadID;
  }

  private createPendingTurn(
    threadID: string,
    timeoutMs: number,
  ): PendingCodexAppServerTurn {
    let resolveTurn!: (value: string) => void;
    let rejectTurn!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const pendingTurn: PendingCodexAppServerTurn = {
      threadID,
      turnID: null,
      text: "",
      settled: false,
      timeoutID: setTimeout(() => {
        this.settlePendingTurn(
          pendingTurn,
          new Error(
            `Codex app-server timed out after ${timeoutMs}ms; no decision was accepted.`,
          ),
        );
        this.close();
      }, timeoutMs),
      promise,
      resolve: (value) => resolveTurn(value),
      reject: (error) => rejectTurn(error),
    };
    return pendingTurn;
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.child === null || this.child.stdin.destroyed) {
      throw new Error("Codex app-server is not running.");
    }
    const id = this.nextID++;
    const request = { jsonrpc: "2.0", id, method, params };
    return await new Promise<unknown>((resolve, reject) => {
      const timeoutID = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Codex app-server request ${method} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeoutID });
      this.child?.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error !== undefined && error !== null) {
          clearTimeout(timeoutID);
          this.pendingRequests.delete(id);
          reject(errorWithCause("Codex app-server request write failed.", error));
        }
      });
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line !== "") {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message === null || typeof message !== "object") {
      return;
    }
    const value = message as Record<string, unknown>;
    if (typeof value.id === "number") {
      this.handleResponse(value.id, value);
      return;
    }
    if (typeof value.method === "string") {
      this.handleNotification(value.method, value.params);
    }
  }

  private handleResponse(id: number, value: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    clearTimeout(pending.timeoutID);
    if (value.error !== undefined) {
      pending.reject(
        new Error(`Codex app-server error: ${jsonSummary(value.error)}`),
      );
      return;
    }
    pending.resolve(value.result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "item/agentMessage/delta") {
      const threadID = stringAtPath(params, ["threadId"]);
      const turnID = stringAtPath(params, ["turnId"]);
      const delta = stringAtPath(params, ["delta"]);
      const pendingTurn =
        threadID === null ? undefined : this.pendingTurns.get(threadID);
      if (
        pendingTurn !== undefined &&
        delta !== null &&
        (pendingTurn.turnID === null ||
          turnID === null ||
          pendingTurn.turnID === turnID)
      ) {
        pendingTurn.text += delta;
      }
      return;
    }

    if (method !== "turn/completed") {
      return;
    }

    const threadID = stringAtPath(params, ["threadId"]);
    const pendingTurn =
      threadID === null ? undefined : this.pendingTurns.get(threadID);
    if (pendingTurn === undefined) {
      return;
    }
    const turn = valueAtPath(params, ["turn"]);
    const status = stringAtPath(turn, ["status"]);
    const completedTurnID = stringAtPath(turn, ["id"]);
    if (
      pendingTurn.turnID !== null &&
      completedTurnID !== null &&
      pendingTurn.turnID !== completedTurnID
    ) {
      return;
    }
    pendingTurn.turnID = completedTurnID;
    if (status !== "completed") {
      this.settlePendingTurn(
        pendingTurn,
        new Error(
          `Codex app-server turn ${status ?? "failed"}: ${turnError(turn)}`,
        ),
      );
      return;
    }

    this.settlePendingTurn(
      pendingTurn,
      null,
      pendingTurn.text || agentMessageFromTurn(turn),
    );
  }

  private settlePendingTurn(
    pendingTurn: PendingCodexAppServerTurn,
    error: Error | null,
    value = "",
  ): void {
    if (pendingTurn.settled) {
      return;
    }
    pendingTurn.settled = true;
    clearTimeout(pendingTurn.timeoutID);
    this.pendingTurns.delete(pendingTurn.threadID);
    if (error !== null) {
      pendingTurn.reject(error);
      return;
    }
    pendingTurn.resolve(value);
  }

  private async archiveThread(threadID: string): Promise<void> {
    try {
      await this.request("thread/archive", { threadId: threadID }, 2_000);
    } catch {
      try {
        await this.request("thread/unsubscribe", { threadId: threadID }, 2_000);
      } catch {
        // Ephemeral thread cleanup is best-effort.
      }
    }
  }

  private scheduleIdleClose(): void {
    if (
      this.child === null ||
      this.pendingRequests.size > 0 ||
      this.pendingTurns.size > 0
    ) {
      return;
    }
    if (this.idleCloseID !== null) {
      clearTimeout(this.idleCloseID);
    }
    this.idleCloseID = setTimeout(() => {
      this.idleCloseID = null;
      this.close();
    }, this.idleCloseMs);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutID);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
    for (const pendingTurn of this.pendingTurns.values()) {
      this.settlePendingTurn(pendingTurn, error);
    }
  }
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

function codexCliTransportFromEnv(env: NodeJS.ProcessEnv): CodexCliTransport {
  const raw = optionalNonEmpty(env.AI_LEAGUE_CODEX_TRANSPORT)?.toLowerCase();
  if (raw === undefined) {
    return "app-server";
  }
  if (raw === "app-server" || raw === "exec") {
    return raw;
  }
  throw new LlmProviderConfigError(
    `AI_LEAGUE_CODEX_TRANSPORT must be app-server or exec; received ${raw}.`,
  );
}

function valueAtPath(value: unknown, pathParts: readonly string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringAtPath(
  value: unknown,
  pathParts: readonly string[],
): string | null {
  const nested = valueAtPath(value, pathParts);
  return typeof nested === "string" ? nested : null;
}

function agentMessageFromTurn(turn: unknown): string {
  const items = valueAtPath(turn, ["items"]);
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .filter(
      (item): item is { type: string; text: string } =>
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "agentMessage" &&
        typeof (item as Record<string, unknown>).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function turnError(turn: unknown): string {
  const message = stringAtPath(turn, ["error", "message"]);
  if (message !== null) {
    return message;
  }
  const additionalDetails = stringAtPath(turn, ["error", "additionalDetails"]);
  if (additionalDetails !== null) {
    return additionalDetails;
  }
  return jsonSummary(valueAtPath(turn, ["error"]) ?? turn);
}

function jsonSummary(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return String(value);
    }
    return sanitizeCodexOutput(
      serialized.length <= 1_000
        ? serialized
        : `${serialized.slice(0, 500)}...${serialized.slice(-500)}`,
    );
  } catch {
    return sanitizeCodexOutput(String(value));
  }
}

function appServerStartErrorMessage(
  command: string,
  error: NodeJS.ErrnoException,
): string {
  if (error.code === "ENOENT") {
    return `Codex CLI binary "${command}" was not found. Install Codex CLI or set AI_LEAGUE_CODEX_COMMAND.`;
  }
  return `Codex app-server failed to start: ${error.message}`;
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
