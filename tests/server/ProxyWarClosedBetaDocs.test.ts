import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Proxy War closed beta docs and commands", () => {
  it("documents the closed beta launch command that package.json exposes", async () => {
    const [packageJson, readinessDoc, remoteDoc, publicDemoDoc, aiLeagueDoc] =
      await Promise.all([
        fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
        fs.readFile(
          path.join(process.cwd(), "docs", "CLOSED_BETA_READINESS.md"),
          "utf8",
        ),
        fs.readFile(
          path.join(process.cwd(), "docs", "REMOTE_FRIENDS_BETA.md"),
          "utf8",
        ),
        fs.readFile(
          path.join(process.cwd(), "docs", "PROXYWAR_PUBLIC_DEMO.md"),
          "utf8",
        ),
        fs.readFile(
          path.join(process.cwd(), "docs", "AI_NATIONS_LEAGUE.md"),
          "utf8",
        ),
      ]);
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts["agent:closed-beta"]).toContain("PROXYWAR_BETA_ENABLED");
    expect(scripts["agent:closed-beta"]).toContain(
      "PROXYWAR_HOUSE_AGENT_BRAIN=planner-claude-cli",
    );
    expect(scripts["agent:closed-beta"]).toContain(
      "AI_LEAGUE_CLAUDE_TIMEOUT_MS=60000",
    );
    expect(scripts["agent:closed-beta"]).not.toContain(
      "AI_LEAGUE_LLM_PROVIDER=codex-cli",
    );
    expect(scripts["agent:closed-beta"]).not.toContain("frontier-beta");
    expect(scripts["agent:beta"]).toBe(scripts["agent:closed-beta"]);
    expect(scripts["agent:closed-beta:codex"]).toContain(
      "PROXYWAR_HOUSE_AGENT_BRAIN=planner-codex-cli",
    );
    expect(scripts["agent:closed-beta:codex"]).toContain(
      "AI_LEAGUE_LLM_PROVIDER=codex-cli",
    );
    expect(scripts["agent:closed-beta:lan"]).toContain("AI_LEAGUE_DEMO_HOST=0.0.0.0");
    expect(scripts["agent:closed-beta:remote"]).toContain(
      "proxywar-remote-beta.ts",
    );
    expect(scripts["agent:public-readiness"]).toContain(
      "proxywar-public-readiness.ts",
    );
    expect(scripts["agent:public-readiness:strict"]).toContain(
      "--require-ready",
    );
    expect(scripts["agent:league-demo:planner:codex-medium"]).toContain(
      "AI_LEAGUE_CODEX_MODEL=gpt-5.4",
    );
    expect(scripts["agent:benchmark:bots:full:codex-medium"]).toContain(
      "AI_LEAGUE_CODEX_REASONING_EFFORT=medium",
    );
    for (const doc of [readinessDoc, publicDemoDoc, aiLeagueDoc]) {
      expect(doc).toContain("npm run agent:closed-beta");
      expect(doc).toContain("PROXYWAR_BETA_CODE");
    }
    for (const doc of [readinessDoc, remoteDoc, publicDemoDoc, aiLeagueDoc]) {
      expect(doc).toContain("agent:closed-beta:remote");
      expect(doc).toContain("agent:closed-beta:lan");
    }
    expect(readinessDoc).toContain("artifacts/proxywar/beta-feedback");
    expect(readinessDoc).toContain("agent:public-readiness:strict");
    expect(remoteDoc).toContain("cloudflared");
    expect(remoteDoc).toContain("--check");
    expect(remoteDoc).toContain("agent:public-readiness:strict");
    expect(remoteDoc).toContain("agent:benchmark:bots:full:codex-medium");
    expect(remoteDoc).toContain("There is no built-in default invite code");
  });
});
