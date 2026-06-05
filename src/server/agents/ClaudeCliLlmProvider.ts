import { spawn } from "node:child_process";

import { LlmProvider } from "./LlmProvider";

// Claude CLI house-agent provider. Shells out to the headless `claude -p` print
// mode (one turn, all tools disallowed) and returns the model's text response,
// which the planner/decision parser handles exactly like any other LLM output.
// Mirrors the proven invocation in examples/external-agent (defaultClaudeCommandArgs).
//
// Not a deterministic-sim concern: this lives in src/server, never src/core.

export interface ClaudeCliCommandInput {
  command: string;
  args: string[];
  stdin: string;
  cwd?: string;
  timeoutMs: number;
}

export interface ClaudeCliCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type ClaudeCliCommandRunner = (
  input: ClaudeCliCommandInput,
) => Promise<ClaudeCliCommandResult>;

export const DEFAULT_CLAUDE_DISALLOWED_TOOLS =
  "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch";
export const DEFAULT_CLAUDE_TIMEOUT_MS = 60_000;

export interface ClaudeCliLlmProviderConfig {
  command?: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  disallowedTools?: string;
  commandRunner?: ClaudeCliCommandRunner;
}

export const runClaudeCliCommand: ClaudeCliCommandRunner = (input) =>
  new Promise<ClaudeCliCommandResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.write(input.stdin);
    child.stdin.end();
  });

export class ClaudeCliLlmProvider implements LlmProvider {
  readonly providerType = "claude-cli";
  private readonly commandRunner: ClaudeCliCommandRunner;

  constructor(private readonly config: ClaudeCliLlmProviderConfig = {}) {
    this.commandRunner = config.commandRunner ?? runClaudeCliCommand;
  }

  async complete(prompt: string): Promise<string> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
    const args = [
      "-p",
      "--max-turns",
      "1",
      "--disallowedTools",
      this.config.disallowedTools ?? DEFAULT_CLAUDE_DISALLOWED_TOOLS,
    ];
    const model = (this.config.model ?? "").trim();
    if (model !== "") {
      args.push("--model", model);
    }

    const result = await this.commandRunner({
      command: this.config.command ?? "claude",
      args,
      stdin: prompt,
      cwd: this.config.cwd,
      timeoutMs,
    });

    if (result.timedOut) {
      throw new Error(`Claude CLI timed out after ${timeoutMs}ms`);
    }
    const text = result.stdout.trim();
    if (/Not logged in|Please run \/login/i.test(text || result.stderr)) {
      throw new Error(
        `Claude CLI is not logged in. Run "claude login" before using AI_LEAGUE_LLM_PROVIDER=claude-cli. ${result.stderr || text}`.trim(),
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `Claude CLI exited with code ${result.code}: ${result.stderr || text}`.trim(),
      );
    }
    if (text === "") {
      throw new Error("Claude CLI returned an empty response");
    }
    return text;
  }
}

export function loadClaudeCliLlmProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ClaudeCliLlmProviderConfig {
  const timeoutRaw =
    env.AI_LEAGUE_CLAUDE_TIMEOUT_MS ?? env.AI_LEAGUE_LLM_TIMEOUT_MS;
  const parsedTimeout = timeoutRaw === undefined ? NaN : Number(timeoutRaw);
  return {
    command: env.AI_LEAGUE_CLAUDE_COMMAND?.trim() || "claude",
    model:
      env.AI_LEAGUE_CLAUDE_MODEL?.trim() ||
      env.AI_LEAGUE_LLM_MODEL?.trim() ||
      undefined,
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_CLAUDE_TIMEOUT_MS,
    cwd,
    disallowedTools:
      env.AI_LEAGUE_CLAUDE_DISALLOWED_TOOLS?.trim() ||
      DEFAULT_CLAUDE_DISALLOWED_TOOLS,
  };
}

export function createClaudeCliLlmProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ClaudeCliLlmProvider {
  return new ClaudeCliLlmProvider(loadClaudeCliLlmProviderConfig(env, cwd));
}
