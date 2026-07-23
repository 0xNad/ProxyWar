import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("Proxy War beta runtime config", () => {
  it("keeps the direct premiere-loop wrapper in the package projector environment", async () => {
    const [packageJson, wrapper] = await Promise.all([
      fs
        .readFile(path.join(root, "package.json"), "utf8")
        .then(
          (source) => JSON.parse(source) as { scripts: Record<string, string> },
        ),
      fs.readFile(
        path.join(root, "deploy", "mac", "start-proxywar-premiere-loop.zsh"),
        "utf8",
      ),
    ]);

    expect(packageJson.scripts["premiere:loop"]).toContain("GAME_ENV=dev");
    const gameEnvironment = wrapper.indexOf("export GAME_ENV=dev");
    const directNode = wrapper.indexOf(
      'exec "$NODE_BIN" --import tsx src/scripts/replay-premiere-loop.ts',
    );
    expect(gameEnvironment).toBeGreaterThanOrEqual(0);
    expect(directNode).toBeGreaterThan(gameEnvironment);
  });

  it("keeps the archived Clip canary master override explicit and bounded to the server wrapper", async () => {
    const [wrapper, runbook] = await Promise.all([
      fs.readFile(
        path.join(root, "deploy", "mac", "start-proxywar-beta.zsh"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "docs", "PROXYWAR_ARCHIVED_CLIP_CANARY.md"),
        "utf8",
      ),
    ]);

    expect(wrapper).toContain(
      'ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE="${PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE:-false}"',
    );
    expect(wrapper).toContain(
      'if [[ "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" ]]',
    );
    expect(wrapper).toContain("export PROXYWAR_CLIPS_ENABLED=true");
    expect(wrapper).toContain(
      "unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE",
    );
    expect(runbook).toContain(
      "launchctl setenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE true",
    );
    expect(runbook).toContain(
      "launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE",
    );
  });

  it("bounds Claude planner waits in the live beta scripts without shortening the match", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    // The live house brain is the Claude CLI planner; these scripts must bound
    // its per-decision wait and must not carry the deprecated Codex tuners.
    const claudeBetaScripts = [
      "agent:closed-beta",
      "agent:beta",
      "agent:closed-beta:lan",
      "agent:closed-beta:remote",
      "agent:closed-beta:prod",
    ];

    for (const scriptName of claudeBetaScripts) {
      const script = packageJson.scripts[scriptName];
      expect(script, scriptName).toContain(
        "PROXYWAR_HOUSE_AGENT_BRAIN=planner-claude-cli",
      );
      expect(script, scriptName).toContain("AI_LEAGUE_CLAUDE_TIMEOUT_MS=60000");
      expect(script, scriptName).toContain(
        "AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS=true",
      );
      expect(script, scriptName).not.toContain(
        "AI_LEAGUE_LLM_PROVIDER=codex-cli",
      );
      expect(script, scriptName).not.toContain(
        "AI_LEAGUE_CLAUDE_TIMEOUT_MS=180000",
      );
    }
  });

  it("keeps the Codex fallback beta script bounded without shortening the match", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const script = packageJson.scripts["agent:closed-beta:codex"];

    expect(script).toContain("PROXYWAR_HOUSE_AGENT_BRAIN=planner-codex-cli");
    expect(script).toContain("AI_LEAGUE_CODEX_TIMEOUT_MS=45000");
    expect(script).toContain("AI_LEAGUE_CODEX_APP_SERVER_FALLBACK=false");
    expect(script).not.toContain("AI_LEAGUE_CODEX_TIMEOUT_MS=180000");
  });
});
