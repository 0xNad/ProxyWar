import { describe, expect, it } from "vitest";
import {
  type ClaudeCliCommandInput,
  type ClaudeCliCommandRunner,
  ClaudeCliLlmProvider,
  createClaudeCliLlmProviderFromEnv,
  DEFAULT_CLAUDE_DISALLOWED_TOOLS,
  DEFAULT_CLAUDE_TIMEOUT_MS,
  loadClaudeCliLlmProviderConfig,
  runClaudeCliCommand,
} from "../../src/server/agents/ClaudeCliLlmProvider";

// Records every command invocation and returns a canned result, so the
// provider's argument construction and fail-loud branches can be tested
// without spawning the real `claude` CLI.
function recordingRunner(result: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timedOut?: boolean;
}): { runner: ClaudeCliCommandRunner; calls: ClaudeCliCommandInput[] } {
  const calls: ClaudeCliCommandInput[] = [];
  const runner: ClaudeCliCommandRunner = async (input) => {
    calls.push(input);
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
      timedOut: result.timedOut ?? false,
    };
  };
  return { runner, calls };
}

describe("ClaudeCliLlmProvider", () => {
  it("exposes providerType claude-cli", () => {
    const provider = new ClaudeCliLlmProvider({
      commandRunner: recordingRunner({ stdout: "ok" }).runner,
    });
    expect(provider.providerType).toBe("claude-cli");
  });

  it("shells out to `claude -p` in one-turn headless mode and returns trimmed stdout", async () => {
    const { runner, calls } = recordingRunner({
      stdout:
        '  {"selectedLegalActionId":"hold","reason":"Safe.","confidence":0.5}  \n',
    });
    const provider = new ClaudeCliLlmProvider({
      command: "claude-test",
      cwd: "/tmp/project",
      timeoutMs: 2_000,
      commandRunner: runner,
    });

    await expect(provider.complete("decide please")).resolves.toBe(
      '{"selectedLegalActionId":"hold","reason":"Safe.","confidence":0.5}',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude-test");
    expect(calls[0].cwd).toBe("/tmp/project");
    expect(calls[0].timeoutMs).toBe(2_000);
    expect(calls[0].stdin).toBe("decide please");
    expect(calls[0].args).toEqual([
      "-p",
      "--max-turns",
      "1",
      "--disallowedTools",
      DEFAULT_CLAUDE_DISALLOWED_TOOLS,
      "--setting-sources=",
    ]);
    // No --model unless one is configured.
    expect(calls[0].args).not.toContain("--model");
  });

  it("passes --model when configured and honors a custom disallowedTools list", async () => {
    const { runner, calls } = recordingRunner({ stdout: "ok" });
    const provider = new ClaudeCliLlmProvider({
      command: "claude",
      model: "claude-sonnet-4-6",
      disallowedTools: "Bash,Read",
      commandRunner: runner,
    });

    await expect(provider.complete("p")).resolves.toBe("ok");
    expect(calls[0].args).toEqual([
      "-p",
      "--max-turns",
      "1",
      "--disallowedTools",
      "Bash,Read",
      "--setting-sources=",
      "--model",
      "claude-sonnet-4-6",
    ]);
  });

  it("passes an exact no-tools policy and sanitized child environment", async () => {
    const { runner, calls } = recordingRunner({ stdout: "ok" });
    const env = { HOME: "/tmp/sealed-home", PATH: "/opt/bin" };
    const provider = new ClaudeCliLlmProvider({
      command: "/opt/bin/claude",
      model: "claude-fable-5-20260821",
      allowedTools: [],
      env,
      commandRunner: runner,
    });

    await expect(provider.complete("p")).resolves.toBe("ok");
    expect(calls[0].env).toBe(env);
    expect(calls[0].args).toContain("--tools");
    expect(calls[0].args[calls[0].args.indexOf("--tools") + 1]).toBe("");
  });

  it("defaults the command and timeout when none are provided", async () => {
    const { runner, calls } = recordingRunner({ stdout: "ok" });
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    await expect(provider.complete("p")).resolves.toBe("ok");
    expect(calls[0].command).toBe("claude");
    expect(calls[0].timeoutMs).toBe(DEFAULT_CLAUDE_TIMEOUT_MS);
  });

  it("throws clearly on timeout", async () => {
    const { runner } = recordingRunner({ timedOut: true });
    const provider = new ClaudeCliLlmProvider({
      timeoutMs: 10,
      commandRunner: runner,
    });
    await expect(provider.complete("p")).rejects.toThrow(
      /timed out after 10ms/,
    );
  });

  it("kills a timed-out subprocess below the provider boundary", async () => {
    const result = await runClaudeCliCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      stdin: "",
      timeoutMs: 50,
      env: process.env,
    });

    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("aborts a slow request, releases the global lock, and lets the next request succeed", async () => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const runner: ClaudeCliCommandRunner = (input) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 2) {
        active -= 1;
        return Promise.resolve({
          stdout: "next succeeded",
          stderr: "",
          code: 0,
          timedOut: false,
        });
      }
      return new Promise((resolve) => {
        const finish = () => {
          active -= 1;
          resolve({
            stdout: "",
            stderr: "",
            code: null,
            timedOut: false,
            aborted: true,
          });
        };
        if (input.signal?.aborted === true) finish();
        else input.signal?.addEventListener("abort", finish, { once: true });
      });
    };
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    const controller = new AbortController();
    const first = provider.complete("slow", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(first).rejects.toThrow(/request aborted/);
    await expect(provider.complete("next")).resolves.toBe("next succeeded");
    expect(calls).toBe(2);
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
  });

  it("reports a not-logged-in CLI clearly from stderr (before the exit-code branch)", async () => {
    const { runner } = recordingRunner({
      code: 1,
      stderr: "Not logged in · Please run /login",
    });
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    await expect(provider.complete("p")).rejects.toThrow(/claude login/);
  });

  it("reports a not-logged-in CLI clearly from stdout", async () => {
    const { runner } = recordingRunner({
      code: 0,
      stdout: "Please run /login first",
    });
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    await expect(provider.complete("p")).rejects.toThrow(/not logged in/i);
  });

  it("throws on a non-zero exit code", async () => {
    const { runner } = recordingRunner({
      code: 2,
      stdout: "partial",
      stderr: "boom",
    });
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    await expect(provider.complete("p")).rejects.toThrow(/exited with code 2/);
  });

  it("never carries raw provider diagnostics into planner metadata or logs", async () => {
    const sentinel = "PRIVATE_CLAUDE_STDERR_SENTINEL_8f32";
    const { runner } = recordingRunner({
      code: 2,
      stdout: `partial ${sentinel}`,
      stderr: `failure ${sentinel}`,
    });
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    const error = await provider.complete("p").catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("diagnosticSha256=");
    expect((error as Error).message).toContain("diagnosticBytes=");
    expect((error as Error).message).not.toContain(sentinel);
    expect((error as Error).message).not.toContain("partial");
    expect((error as Error).message).not.toContain("failure");
  });

  it("throws on empty output", async () => {
    const { runner } = recordingRunner({ code: 0, stdout: "   \n  " });
    const provider = new ClaudeCliLlmProvider({ commandRunner: runner });
    await expect(provider.complete("p")).rejects.toThrow(/empty response/);
  });

  it("loads default config from an empty environment (no provider flag required)", () => {
    const config = loadClaudeCliLlmProviderConfig({}, "/tmp/project");
    expect(config).toMatchObject({
      command: "claude",
      cwd: "/tmp/project",
      timeoutMs: DEFAULT_CLAUDE_TIMEOUT_MS,
      disallowedTools: DEFAULT_CLAUDE_DISALLOWED_TOOLS,
    });
    expect(config.model).toBeUndefined();
  });

  it("reads claude-specific env overrides", () => {
    const config = loadClaudeCliLlmProviderConfig(
      {
        AI_LEAGUE_CLAUDE_COMMAND: "claude-test",
        AI_LEAGUE_CLAUDE_MODEL: "claude-x",
        AI_LEAGUE_CLAUDE_TIMEOUT_MS: "1234",
        AI_LEAGUE_CLAUDE_DISALLOWED_TOOLS: "Bash",
      },
      "/tmp/project",
    );
    expect(config).toMatchObject({
      command: "claude-test",
      model: "claude-x",
      timeoutMs: 1234,
      disallowedTools: "Bash",
    });
  });

  it("falls back to the shared AI_LEAGUE_LLM_* model and timeout", () => {
    const config = loadClaudeCliLlmProviderConfig(
      { AI_LEAGUE_LLM_MODEL: "shared-model", AI_LEAGUE_LLM_TIMEOUT_MS: "999" },
      "/tmp/project",
    );
    expect(config.model).toBe("shared-model");
    expect(config.timeoutMs).toBe(999);
  });

  it("ignores a non-numeric timeout and uses the default", () => {
    const config = loadClaudeCliLlmProviderConfig(
      { AI_LEAGUE_CLAUDE_TIMEOUT_MS: "not-a-number" },
      "/tmp/project",
    );
    expect(config.timeoutMs).toBe(DEFAULT_CLAUDE_TIMEOUT_MS);
  });

  it("createClaudeCliLlmProviderFromEnv returns a claude-cli provider", () => {
    const provider = createClaudeCliLlmProviderFromEnv({}, "/tmp/project");
    expect(provider.providerType).toBe("claude-cli");
  });
});
