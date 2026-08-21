import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COMMANDER_PROMPT_VERSION,
  LlmOptionSelector,
} from "../../src/server/agents/LlmOptionSelector";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import { makeCommanderStage2Fixture } from "./StrategicCommanderStage2TestHarness";

class CapturingProvider implements LlmProvider {
  readonly providerType = "custom" as const;
  readonly model = "test-model";
  readonly prompts: string[] = [];

  constructor(private readonly reply: string) {}

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.reply;
  }
}

describe("LlmOptionSelector Stage 5 authority and telemetry", () => {
  it("uses only the Stage 2 prompt, never Arm B's answer key", async () => {
    const fixture = makeCommanderStage2Fixture();
    const provider = new CapturingProvider(
      JSON.stringify({
        selectedStrategicOptionId: "pressure_rival:P8",
        horizonDecisions: 4,
        intent: "test an alternative pressure target",
        replanTriggers: [],
      }),
    );
    const selector = new LlmOptionSelector({
      provider,
    });

    const attempt = await selector.select(
      fixture.builtState.state,
      fixture.builtState.state.options,
    );

    expect(attempt).toMatchObject({
      ok: true,
      selection: { selectedStrategicOptionId: "pressure_rival:P8" },
      telemetry: {
        providerCalled: true,
        parseOk: true,
        failureKind: null,
        provider: "custom",
        model: "test-model",
        promptVersion: COMMANDER_PROMPT_VERSION,
      },
    });
    expect(attempt.telemetry.promptCharacters).toBe(
      provider.prompts[0]!.length,
    );
    expect(provider.prompts[0]).not.toContain(
      "deterministic control selected pressure_rival",
    );
    expect(provider.prompts[0]).not.toContain(
      "commanderDeterministicPreferredOptionId",
    );
    expect(provider.prompts[0]).not.toContain("raw-attack-P7");
  });

  it("classifies an off-set choice without retaining raw provider output", async () => {
    const fixture = makeCommanderStage2Fixture();
    const raw = JSON.stringify({
      selectedStrategicOptionId: "pressure_rival:P404",
      horizonDecisions: 3,
      intent: "off set",
      replanTriggers: [],
    });
    const attempt = await new LlmOptionSelector({
      provider: new CapturingProvider(raw),
    }).select(fixture.builtState.state, fixture.builtState.state.options);

    expect(attempt).toMatchObject({
      ok: false,
      selection: null,
      telemetry: {
        rawOutputPresent: true,
        parseOk: false,
        failureKind: "invalid-option",
        failureDetail:
          "Commander selector selected an option outside the locked set",
      },
    });
    expect(JSON.stringify(attempt)).not.toContain("pressure_rival:P404");
    expect(JSON.stringify(attempt)).not.toContain(raw);
  });

  it("fails if the options are not the exact locked state surface", async () => {
    const fixture = makeCommanderStage2Fixture();
    await expect(
      new LlmOptionSelector({
        provider: new CapturingProvider("{}"),
      }).select(fixture.builtState.state, [
        ...fixture.builtState.state.options,
      ]),
    ).rejects.toThrow(/exact locked state option surface/);
  });

  it("has no deterministic selector implementation dependency", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/server/agents/LlmOptionSelector.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /DeterministicOptionSelector|selectDeterministicStrategicOption/,
    );
    expect(source).not.toContain("AgentBrainInput");
    expect(source).not.toContain("LegalAction");
  });
});
