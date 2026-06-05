import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("Proxy War beta runtime config", () => {
  it("bounds Codex planner waits in beta scripts without shortening the match", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const betaScripts = [
      "agent:closed-beta",
      "agent:closed-beta:codex",
      "agent:beta",
      "agent:closed-beta:lan",
      "agent:closed-beta:remote",
      "agent:closed-beta:prod",
    ];

    for (const scriptName of betaScripts) {
      const script = packageJson.scripts[scriptName];
      expect(script, scriptName).toContain("AI_LEAGUE_CODEX_TIMEOUT_MS=45000");
      expect(script, scriptName).toContain(
        "AI_LEAGUE_CODEX_APP_SERVER_FALLBACK=false",
      );
      expect(script, scriptName).not.toContain("AI_LEAGUE_CODEX_TIMEOUT_MS=180000");
    }
  });
});
