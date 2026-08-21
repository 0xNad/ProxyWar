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
      // Own process group so a timeout can kill the WHOLE claude subprocess tree.
      // The claude CLI forks children that hold the stdio pipes; killing only the
      // parent leaves them running (they keep an API call open, burning the
      // subscription) and "close" never fires.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const settle = (result: ClaudeCliCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killTree = (): void => {
      try {
        if (typeof child.pid === "number") {
          process.kill(-child.pid, "SIGKILL"); // negative pid => the process group
          return;
        }
      } catch {
        // group gone or unsupported — fall through to the single-process kill
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Resolve NOW instead of waiting for "close": a wedged claude subprocess tree
      // may never emit close, and claude calls are serialized (withClaudeCliLock),
      // so a hung call would block EVERY later Commander call and stall the whole
      // game (the watchdog then kills it). Returning timedOut lets the planner fall
      // back for this one decision and the game continues.
      settle({ stdout, stderr, code: null, timedOut: true });
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      settle({ stdout, stderr, code, timedOut });
    });
    child.stdin.write(input.stdin);
    child.stdin.end();
  });

// Serialize ALL Claude CLI invocations process-wide. Concurrent `claude -p` subprocesses
// (e.g. multiple house agents deciding in the same game tick) cause CLI timeouts -> parse
// failures -> silent fallback to the rule executor, which would quietly turn a model agent
// into a heuristic bot. One subprocess at a time keeps every agent genuinely model-driven.
// Single-agent runs are unaffected (no contention).
let claudeCliChain: Promise<unknown> = Promise.resolve();
function withClaudeCliLock<T>(task: () => Promise<T>): Promise<T> {
  const result = claudeCliChain.then(task, task);
  claudeCliChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export class ClaudeCliLlmProvider implements LlmProvider {
  readonly providerType = "claude-cli";
  readonly model: string | null;
  private readonly commandRunner: ClaudeCliCommandRunner;

  constructor(private readonly config: ClaudeCliLlmProviderConfig = {}) {
    const configuredModel = config.model?.trim();
    this.model =
      configuredModel === undefined || configuredModel === ""
        ? null
        : configuredModel;
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
      // Ignore the host's personal settings (CLAUDE.md, a global effortLevel like xhigh,
      // MCP servers) so every game decision runs at the CLI's fast default effort and isn't
      // biased by the operator's coding-agent config. Per-decision latency dropped from
      // ~30s to ~8s in testing.
      "--setting-sources=",
    ];
    const model = (this.config.model ?? "").trim();
    if (model !== "") {
      args.push("--model", model);
    }

    const result = await withClaudeCliLock(() =>
      this.commandRunner({
        command: this.config.command ?? "claude",
        args,
        stdin: prompt,
        cwd: this.config.cwd,
        timeoutMs,
      }),
    );

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
