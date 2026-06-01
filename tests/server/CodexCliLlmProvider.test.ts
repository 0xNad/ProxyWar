import fs from "fs/promises";
import { describe, expect, it } from "vitest";
import {
  CodexCliCommandRunner,
  CodexCliLlmProvider,
  DEFAULT_CODEX_PLANNER_MODEL,
  DEFAULT_CODEX_PLANNER_REASONING_EFFORT,
  loadCodexCliLlmProviderConfig,
  resolveCodexCliCommand,
} from "../../src/server/agents/CodexCliLlmProvider";

describe("CodexCliLlmProvider", () => {
  it("loads private-testing config from environment", () => {
    const config = loadCodexCliLlmProviderConfig(
      {
        AI_LEAGUE_LLM_PROVIDER: "codex-cli",
        AI_LEAGUE_CODEX_COMMAND: "codex-test",
        AI_LEAGUE_CODEX_MODEL: "gpt-test",
        AI_LEAGUE_CODEX_REASONING_EFFORT: "medium",
        AI_LEAGUE_CODEX_TIMEOUT_MS: "1234",
        AI_LEAGUE_CODEX_PROFILE: "ai-league",
      },
      "/tmp/project",
    );

    expect(config).toMatchObject({
      command: "codex-test",
      cwd: "/tmp/project",
      model: "gpt-test",
      reasoningEffort: "medium",
      timeoutMs: 1234,
      profile: "ai-league",
    });
  });

  it("fails clearly when provider flag is missing", () => {
    expect(() => loadCodexCliLlmProviderConfig({})).toThrow(
      /AI_LEAGUE_LLM_PROVIDER=codex-cli/,
    );
  });

  it("defaults live planner config to the selected Codex planning model", () => {
    const config = loadCodexCliLlmProviderConfig(
      { AI_LEAGUE_LLM_PROVIDER: "codex-cli" },
      "/tmp/project",
    );

    expect(config).toMatchObject({
      model: DEFAULT_CODEX_PLANNER_MODEL,
      reasoningEffort: DEFAULT_CODEX_PLANNER_REASONING_EFFORT,
    });
  });

  it("prefers explicit command and can discover the bundled Codex app binary", () => {
    expect(
      resolveCodexCliCommand(
        { AI_LEAGUE_CODEX_COMMAND: "/custom/codex" },
        () => true,
      ),
    ).toBe("/custom/codex");
    expect(
      resolveCodexCliCommand(
        {},
        (candidate) =>
          candidate === "/Applications/Codex.app/Contents/Resources/codex",
      ),
    ).toBe("/Applications/Codex.app/Contents/Resources/codex");
    expect(resolveCodexCliCommand({}, () => false)).toBe("codex");
  });

  it("shells out to codex exec with read-only sandbox and output schema", async () => {
    const seenArgs: string[][] = [];
    const runner: CodexCliCommandRunner = async (input) => {
      seenArgs.push(input.args);
      expect(input.command).toBe("codex-test");
      expect(input.cwd).toBe("/tmp/project");
      expect(input.stdin).toContain("Choose exactly one listed LegalAction.id");
      expect(input.args).toEqual(
        expect.arrayContaining([
          "exec",
          "--sandbox",
          "read-only",
          "-c",
          'approval_policy="never"',
          "--ephemeral",
          "--output-schema",
          "--output-last-message",
          "--cd",
          "/tmp/project",
          "--model",
          "gpt-test",
          "-c",
          'model_reasoning_effort="medium"',
          "-",
        ]),
      );

      const schemaPath = input.args[input.args.indexOf("--output-schema") + 1];
      const outputPath =
        input.args[input.args.indexOf("--output-last-message") + 1];
      const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
      expect(schema).toMatchObject({
        additionalProperties: false,
        required: ["selectedLegalActionId", "reason", "confidence"],
        properties: {
          selectedLegalActionId: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      });
      await fs.writeFile(
        outputPath,
        '{"selectedLegalActionId":"hold","reason":"Safe hold.","confidence":0.5}',
      );
      return {
        exitCode: 0,
        stdout: "ignored stdout",
        stderr: "",
        timedOut: false,
      };
    };
    const provider = new CodexCliLlmProvider({
      command: "codex-test",
      cwd: "/tmp/project",
      timeoutMs: 2_000,
      model: "gpt-test",
      reasoningEffort: "medium",
      commandRunner: runner,
    });

    await expect(provider.complete("prompt")).resolves.toBe(
      '{"selectedLegalActionId":"hold","reason":"Safe hold.","confidence":0.5}',
    );
    expect(seenArgs).toHaveLength(1);
  });

  it("reports a missing codex binary clearly", async () => {
    const runner: CodexCliCommandRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: Object.assign(new Error("spawn codex ENOENT"), {
        code: "ENOENT",
      }),
    });
    const provider = new CodexCliLlmProvider({
      command: "missing-codex",
      cwd: "/tmp/project",
      timeoutMs: 2_000,
      commandRunner: runner,
    });

    await expect(provider.complete("prompt")).rejects.toThrow(
      /binary "missing-codex" was not found/,
    );
  });

  it("can use a planner output schema for Codex planner mode", async () => {
    const runner: CodexCliCommandRunner = async (input) => {
      expect(input.stdin).toContain("Do not choose a LegalAction.id");
      const schemaPath = input.args[input.args.indexOf("--output-schema") + 1];
      const outputPath =
        input.args[input.args.indexOf("--output-last-message") + 1];
      const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
      expect(schema).toMatchObject({
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
          objective: { enum: expect.arrayContaining(["secure_economy"]) },
          turnIntent: { enum: expect.arrayContaining(["build"]) },
          preferredActionKinds: {
            items: { enum: expect.arrayContaining(["build"]) },
          },
          enabledModules: {
            items: { enum: expect.arrayContaining(["economy"]) },
          },
        },
      });
      await fs.writeFile(
        outputPath,
        '{"objective":"secure_economy","turnIntent":"build","rationale":"Build economy.","maxDecisionCycles":3,"preferredActionKinds":["build","hold"],"enabledModules":["economy"],"targetPlayerId":null,"tacticalSettings":{"reserveRatio":0.35,"triggerRatio":0.55,"expansionRatio":0.15,"maxConcurrentWars":1,"retreatThreshold":0.35,"maxActionsPerDecision":4}}',
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    };
    const provider = new CodexCliLlmProvider({
      command: "codex-test",
      cwd: "/tmp/project",
      timeoutMs: 2_000,
      outputSchema: "planner",
      commandRunner: runner,
    });

    await expect(provider.complete("planner prompt")).resolves.toContain(
      '"objective":"secure_economy"',
    );
  });

  it("can use a researcher output schema for post-match analysis", async () => {
    const runner: CodexCliCommandRunner = async (input) => {
      expect(input.stdin).toContain("post-match researcher JSON object");
      expect(input.stdin).toContain("Do not choose actions");
      const schemaPath = input.args[input.args.indexOf("--output-schema") + 1];
      const outputPath =
        input.args[input.args.indexOf("--output-last-message") + 1];
      const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
      expect(schema).toMatchObject({
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
          evidence: {
            items: {
              required: [
                "artifact",
                "run",
                "turn",
                "selectedActionId",
                "metric",
                "claim",
              ],
            },
          },
          plannerControls: {
            required: [
              "objective",
              "preferredActionKinds",
              "enabledModules",
              "tacticalSettingsChange",
            ],
          },
          proposal: {
            required: [
              "title",
              "change",
              "allowedFiles",
              "expectedMetricMovement",
              "rejectCriteria",
            ],
          },
          abBenchmark: {
            required: ["baselineCommand", "candidateCommand", "metrics"],
          },
          canonicalCompliance: {
            required: [
              "usesExistingLegalActionIds",
              "rawIntentPathRequired",
              "newRunnerRequired",
              "newActionSchemaRequired",
              "newValidatorRequired",
              "newObjectiveKindRequired",
              "coreChangesRequired",
            ],
          },
        },
      });
      await fs.writeFile(
        outputPath,
        JSON.stringify({
          summary: "The agent stalls after gaining an advantage.",
          failurePattern: "It holds while a wounded rival is still finishable.",
          evidence: [
            {
              artifact: "learning-report.md",
              run: "run-1",
              turn: 1200,
              selectedActionId: "hold",
              metric: "tile share",
              claim: "Hold was selected during a finish-pressure window.",
            },
          ],
          hypothesis:
            "Finish pressure should dominate neutral economy once safe.",
          plannerControls: {
            objective: "pressure_rival",
            preferredActionKinds: ["attack", "hold"],
            enabledModules: ["combat", "defense"],
            tacticalSettingsChange:
              "Prefer finish pressure only when reserve remains safe.",
          },
          proposal: {
            title: "Prioritize finish pressure windows",
            change:
              "Raise frontier finish pressure when a weaker bordered rival can be eliminated without dropping reserve discipline.",
            allowedFiles: ["src/server/agents/AgentPlannerExecutor.ts"],
            expectedMetricMovement: "Higher conversion rate and fewer stalls.",
            rejectCriteria: ["Win rate drops", "Average tile share drops"],
          },
          abBenchmark: {
            baselineCommand: "npm run agent:benchmark:hard-nations",
            candidateCommand: "npm run agent:benchmark:hard-nations",
            metrics: ["wins", "average tile share"],
          },
          canonicalCompliance: {
            usesExistingLegalActionIds: true,
            rawIntentPathRequired: false,
            newRunnerRequired: false,
            newActionSchemaRequired: false,
            newValidatorRequired: false,
            newObjectiveKindRequired: false,
            coreChangesRequired: false,
          },
          missingObservationFields: [],
          riskNotes: [],
        }),
      );
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    };
    const provider = new CodexCliLlmProvider({
      command: "codex-test",
      cwd: "/tmp/project",
      timeoutMs: 2_000,
      outputSchema: "researcher",
      commandRunner: runner,
    });

    await expect(provider.complete("research prompt")).resolves.toContain(
      '"failurePattern":"It holds while a wounded rival is still finishable."',
    );
  });

  it("reports login/auth failures clearly", async () => {
    const runner: CodexCliCommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "not logged in",
      timedOut: false,
    });
    const provider = new CodexCliLlmProvider({
      command: "codex",
      cwd: "/tmp/project",
      timeoutMs: 2_000,
      commandRunner: runner,
    });

    await expect(provider.complete("prompt")).rejects.toThrow(/codex login/);
  });

  it("reports timeout clearly", async () => {
    const runner: CodexCliCommandRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const provider = new CodexCliLlmProvider({
      command: "codex",
      cwd: "/tmp/project",
      timeoutMs: 10,
      commandRunner: runner,
    });

    await expect(provider.complete("prompt")).rejects.toThrow(
      /timed out after 10ms/,
    );
  });
});
