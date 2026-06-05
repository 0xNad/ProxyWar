import { describe, expect, it } from "vitest";
import {
  agentDemoBrainUsesCodex,
  buildAgentDemoJobCommand,
  loadProxyWarHouseAgentBrain,
  normalizeAgentDemoJobRequest,
  proxyWarTesterSavedRosterJobDefaults,
} from "../../src/server/agents/AgentDemoServerJobs";

describe("AgentDemoServerJobs", () => {
  it("builds a safe step-locked demo command", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      scenario: "actions",
      maxSteps: "4",
      bots: "4",
    });
    const command = buildAgentDemoJobCommand(request);

    expect(command.label).toContain("planner-claude-cli demo");
    expect(command.args).toContain("src/scripts/ai-agent-league-smoke.ts");
    expect(command.args).toContain("--brain=planner-claude-cli");
    expect(command.args).toContain("--runner=step-locked");
    expect(command.args).toContain("--scenario=actions");
    expect(command.args).toContain("--max-steps=4");
    expect(command.args).toContain("--bots=4");
    expect(command.args).toContain("--nations=5");
    expect(command.args).toContain("--vary-spawns");
    expect(command.args).toContain("--map=Pangaea");
  });

  it("passes deterministic artifact ids into child commands", () => {
    const demo = buildAgentDemoJobCommand(
      normalizeAgentDemoJobRequest({
        kind: "demo",
        brain: "planner",
        scenario: "actions",
      }),
      { artifactID: "job-demo-1" },
    );
    const evaluation = buildAgentDemoJobCommand(
      normalizeAgentDemoJobRequest({
        kind: "evaluation",
        brain: "mock-llm",
        scenario: "actions",
      }),
      { artifactID: "job-eval-1" },
    );
    const tournament = buildAgentDemoJobCommand(
      normalizeAgentDemoJobRequest({
        kind: "tournament",
        brain: "planner",
        scenario: "actions",
      }),
      { artifactID: "job-tournament-1" },
    );

    expect(demo.args).toContain("--run-id=job-demo-1");
    expect(evaluation.args).toContain("--eval-id=job-eval-1");
    expect(tournament.args).toContain("--tournament-id=job-tournament-1");
  });

  it("allows longer planner demos for objective-following scorecards", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner",
      scenario: "actions",
      maxSteps: "30",
    });
    const command = buildAgentDemoJobCommand(request);

    expect(command.args).toContain("--max-steps=30");
  });

  it("can launch full demo matches through the multi-agent house roster runner", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner-codex-cli",
      scenario: "actions",
      matchLength: "full",
      roster: "saved",
      bots: "0",
      nations: "0",
      maxTurns: "90000",
      turnsPerDecision: "100",
    });
    const command = buildAgentDemoJobCommand(request, {
      artifactID: "full-demo-1",
    });

    expect(command.label).toContain("planner-codex-cli full match");
    expect(command.args).toContain("src/scripts/ai-agent-league-smoke.ts");
    expect(command.args).toContain("--runner=step-locked");
    expect(command.args).toContain("--scenario=actions");
    expect(command.args).toContain("--max-steps=900");
    expect(command.args).toContain("--require-winner");
    expect(command.args).toContain("--external-agent-max-decision-ms=15000");
    expect(command.args).toContain("--turns-per-decision-step=100");
    expect(command.args).toContain(
      "--turns-per-decision-schedule=25x20,100x30,250x40,500x150,100x160",
    );
    expect(command.args).toContain("--nations=disabled");
    expect(command.args).toContain("--bots=0");
    expect(command.args.some((arg) => arg.includes("active-roster"))).toBe(
      true,
    );
    expect(command.args).toContain("--run-id=full-demo-1");
  });

  it("locks the tester-facing beta run to saved tester agents plus one Codex house agent and Easy nations", () => {
    const request = normalizeAgentDemoJobRequest({
      ...proxyWarTesterSavedRosterJobDefaults,
      brain: "planner-codex-cli",
    });
    const command = buildAgentDemoJobCommand(request, {
      artifactID: "tester-beta-1",
    });

    expect(request.matchLength).toBe("full");
    expect(request.roster).toBe("saved");
    expect(request.maxSavedNations).toBe(1);
    expect(request.fillSavedRoster).toBe(false);
    expect(request.agents).toBe(1);
    expect(request.maxSteps).toBe(700);
    expect(request.requireWinner).toBe(true);
    expect(request.nations).toBe(2);
    expect(request.difficulty).toBe("Easy");
    expect(command.label).toContain("planner-codex-cli full match");
    expect(command.args).toContain("--agents=1");
    expect(command.args).toContain("--max-steps=700");
    expect(command.args).toContain("--require-winner");
    expect(command.args).toContain("--external-agent-max-decision-ms=15000");
    expect(command.args).toContain("--bots=0");
    expect(command.args).toContain("--nations=2");
    expect(command.args).toContain("--difficulty=Easy");
    expect(command.env.AI_LEAGUE_CODEX_TIMEOUT_MS).toBe("45000");
    expect(command.env.AI_LEAGUE_CODEX_TRANSPORT).toBe("app-server");
    expect(command.env.AI_LEAGUE_CODEX_APP_SERVER_FALLBACK).toBe("false");
    expect(command.env.AI_LEAGUE_CODEX_APP_SERVER_IDLE_CLOSE_MS).toBe("1800000");
    expect(command.args.some((arg) => arg.includes("active-roster"))).toBe(
      true,
    );
    expect(command.args).toContain(
      "--turns-per-decision-schedule=25x20,100x30,250x40,500x150,100x160",
    );
  });

  it("rejects direct external-http demo jobs because external agents enter through saved manifests", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "external-http",
      matchLength: "full",
      externalAgentEndpointUrl: "https://agent.example.com/proxywar/decide",
      externalAgentTimeoutMs: "30000",
    });

    expect(() => buildAgentDemoJobCommand(request)).toThrow(
      "External agents enter beta matches through saved roster manifests",
    );
  });

  it("can launch manifest-defined demo rosters without accepting arbitrary paths", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner",
      scenario: "actions",
      roster: "manifest",
    });
    const command = buildAgentDemoJobCommand(request);

    expect(
      command.args.some((arg) => arg.startsWith("--agent-manifest-dir=")),
    ).toBe(true);
  });

  it("can launch saved Proxy War nation rosters", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner",
      scenario: "actions",
      roster: "saved",
    });
    const command = buildAgentDemoJobCommand(request);

    expect(command.args).toContainEqual(
      expect.stringContaining("artifacts/proxywar/active-roster"),
    );
  });

  it("adds Codex CLI env and safety args only for Codex jobs", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner-codex-cli",
      scenario: "actions",
    });
    const command = buildAgentDemoJobCommand(request);

    expect(command.env.AI_LEAGUE_LLM_PROVIDER).toBe("codex-cli");
    expect(command.env.AI_LEAGUE_CODEX_MODEL).toBe("gpt-5.5");
    expect(command.env.AI_LEAGUE_CODEX_REASONING_EFFORT).toBe("medium");
    expect(command.env.AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS).toBe("true");
    expect(command.env.AI_LEAGUE_CODEX_TIMEOUT_MS).toBe("45000");
    expect(command.env.AI_LEAGUE_CODEX_APP_SERVER_FALLBACK).toBe("false");
    expect(command.args).toContain("--disable-alliance-actions");
    expect(command.args).toContain("--max-decision-ms=45000");
  });

  it("adds Claude CLI env and safety args without an LLM provider override for Claude jobs", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner-claude-cli",
      scenario: "actions",
    });
    const command = buildAgentDemoJobCommand(request);

    // The smoke runner builds the Claude provider from --brain=planner-claude-cli
    // via createClaudeCliLlmProviderFromEnv(); it ignores AI_LEAGUE_LLM_PROVIDER,
    // so the job command must NOT set it (setting it would mislead).
    expect(command.env.AI_LEAGUE_LLM_PROVIDER).toBeUndefined();
    expect(command.env.AI_LEAGUE_CLAUDE_TIMEOUT_MS).toBe("60000");
    expect(command.env.AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS).toBe("true");
    expect(command.args).toContain("--brain=planner-claude-cli");
    expect(command.args).toContain("--disable-alliance-actions");
    expect(command.args).toContain("--max-decision-ms=60000");
  });

  it("loads the hosted house-agent brain from a controlled env value", () => {
    expect(loadProxyWarHouseAgentBrain({})).toBe("planner-claude-cli");
    expect(
      loadProxyWarHouseAgentBrain({
        PROXYWAR_HOUSE_AGENT_BRAIN: "planner-claude-cli",
      }),
    ).toBe("planner-claude-cli");
    expect(
      loadProxyWarHouseAgentBrain({
        PROXYWAR_HOUSE_AGENT_BRAIN: "planner-codex-cli",
      }),
    ).toBe("planner-codex-cli");
    expect(
      loadProxyWarHouseAgentBrain({
        PROXYWAR_HOUSE_AGENT_BRAIN: "codex-cli",
      }),
    ).toBe("codex-cli");
    expect(agentDemoBrainUsesCodex("planner-codex-cli")).toBe(true);
    expect(agentDemoBrainUsesCodex("planner-claude-cli")).toBe(false);
    expect(agentDemoBrainUsesCodex("planner")).toBe(false);
    expect(() =>
      loadProxyWarHouseAgentBrain({
        PROXYWAR_HOUSE_AGENT_BRAIN: "planner",
      }),
    ).toThrow(
      /must be one of codex-cli, planner-codex-cli, claude-cli, planner-claude-cli/,
    );
    expect(() =>
      loadProxyWarHouseAgentBrain({
        PROXYWAR_HOUSE_AGENT_BRAIN: "planner; rm -rf /",
      }),
    ).toThrow(/must be one of/);
  });

  it("rejects arbitrary brain/scenario values before building commands", () => {
    expect(() =>
      normalizeAgentDemoJobRequest({
        kind: "demo",
        brain: "planner; rm -rf /",
      }),
    ).toThrow(/must be one of/);
    expect(() =>
      normalizeAgentDemoJobRequest({
        kind: "demo",
        scenario: "../runs",
      }),
    ).toThrow(/must be one of/);
  });

  it("builds fixed evaluation and tournament commands", () => {
    const evaluation = buildAgentDemoJobCommand(
      normalizeAgentDemoJobRequest({
        kind: "evaluation",
        brain: "mock-llm",
        scenario: "actions",
        runs: "2",
      }),
    );
    const tournament = buildAgentDemoJobCommand(
      normalizeAgentDemoJobRequest({
        kind: "tournament",
        brain: "planner",
        scenario: "actions",
        runs: "2",
      }),
    );

    expect(evaluation.args).toEqual([
      "src/scripts/ai-agent-evaluate.ts",
      "--brain=mock-llm",
      "--scenario=actions",
      "--runs=2",
    ]);
    expect(tournament.args).toEqual([
      "src/scripts/ai-agent-tournament.ts",
      "--brain=planner",
      "--scenario=actions",
      "--runs=2",
      expect.stringContaining("--agent-manifest-dir="),
      "--max-steps=5",
      "--turns-per-decision-step=25",
      "--replay-tail-turns=350",
      "--bots=4",
      "--nations=4",
      "--map=Pangaea",
      "--map-size=Compact",
      "--vary-spawns",
    ]);
  });
});
