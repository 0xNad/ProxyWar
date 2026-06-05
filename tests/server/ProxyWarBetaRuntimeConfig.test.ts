import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("Proxy War beta runtime config", () => {
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
      expect(script, scriptName).not.toContain("AI_LEAGUE_LLM_PROVIDER=codex-cli");
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
