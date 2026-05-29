import { describe, expect, it } from "vitest";
import {
  agentDemoBrainUsesCodex,
  buildAgentDemoJobCommand,
  loadOpenFrontierHouseAgentBrain,
  normalizeAgentDemoJobRequest,
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

    expect(command.label).toContain("planner-codex-cli demo");
    expect(command.args).toContain("src/scripts/ai-agent-league-smoke.ts");
    expect(command.args).toContain("--brain=planner-codex-cli");
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
    expect(command.args).toContain("--max-steps=240");
    expect(command.args).toContain("--turns-per-decision-step=100");
    expect(command.args).toContain("--nations=disabled");
    expect(command.args).toContain("--bots=0");
    expect(command.args.some((arg) => arg.includes("active-roster"))).toBe(
      true,
    );
    expect(command.args).toContain("--run-id=full-demo-1");
  });

  it("rejects direct external-http demo jobs because external agents enter through saved manifests", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "external-http",
      matchLength: "full",
      externalAgentEndpointUrl: "https://agent.example.com/open-frontier/decide",
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

  it("can launch saved Open Frontier nation rosters", () => {
    const request = normalizeAgentDemoJobRequest({
      kind: "demo",
      brain: "planner",
      scenario: "actions",
      roster: "saved",
    });
    const command = buildAgentDemoJobCommand(request);

    expect(command.args).toContainEqual(
      expect.stringContaining("artifacts/open-frontier/active-roster"),
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
    expect(command.env.AI_LEAGUE_CODEX_MODEL).toBe("gpt-5.4");
    expect(command.env.AI_LEAGUE_CODEX_REASONING_EFFORT).toBe("medium");
    expect(command.env.AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS).toBe("true");
    expect(command.args).toContain("--disable-alliance-actions");
    expect(
      command.args.some((arg) => arg.startsWith("--max-decision-ms=")),
    ).toBe(true);
  });

  it("loads the hosted house-agent brain from a controlled env value", () => {
    expect(loadOpenFrontierHouseAgentBrain({})).toBe("planner-codex-cli");
    expect(
      loadOpenFrontierHouseAgentBrain({
        OPEN_FRONTIER_HOUSE_AGENT_BRAIN: "planner-codex-cli",
      }),
    ).toBe("planner-codex-cli");
    expect(
      loadOpenFrontierHouseAgentBrain({
        OPEN_FRONTIER_HOUSE_AGENT_BRAIN: "codex-cli",
      }),
    ).toBe("codex-cli");
    expect(agentDemoBrainUsesCodex("planner-codex-cli")).toBe(true);
    expect(agentDemoBrainUsesCodex("planner")).toBe(false);
    expect(() =>
      loadOpenFrontierHouseAgentBrain({
        OPEN_FRONTIER_HOUSE_AGENT_BRAIN: "planner",
      }),
    ).toThrow(/must be one of codex-cli, planner-codex-cli/);
    expect(() =>
      loadOpenFrontierHouseAgentBrain({
        OPEN_FRONTIER_HOUSE_AGENT_BRAIN: "planner; rm -rf /",
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
