import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ClaudeCliLlmProvider,
  type ClaudeCliCommandRunner,
} from "../../src/server/agents/ClaudeCliLlmProvider";
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

  it("aborts the provider transport when its 12-second-class selector budget expires", async () => {
    const fixture = makeCommanderStage2Fixture();
    let aborted = false;
    const provider: LlmProvider = {
      providerType: "custom",
      model: "slow-test-model",
      complete: (_prompt, options) =>
        new Promise((_resolve, reject) => {
          const fail = () => {
            aborted = true;
            reject(new Error("transport aborted"));
          };
          if (options?.signal?.aborted === true) fail();
          else options?.signal?.addEventListener("abort", fail, { once: true });
        }),
    };
    const selector = new LlmOptionSelector({ provider, timeoutMs: 20 });

    await expect(
      selector.select(
        fixture.builtState.state,
        fixture.builtState.state.options,
      ),
    ).resolves.toMatchObject({
      ok: false,
      telemetry: { failureKind: "timeout", rawOutputPresent: false },
    });
    expect(aborted).toBe(true);
  });

  it("returns at the selector deadline when a custom provider ignores cancellation", async () => {
    const fixture = makeCommanderStage2Fixture();
    const provider: LlmProvider = {
      providerType: "custom",
      model: "non-cooperative-test-model",
      complete: () => new Promise<string>(() => undefined),
    };
    const selector = new LlmOptionSelector({ provider, timeoutMs: 20 });
    const startedAt = Date.now();

    await expect(
      selector.select(
        fixture.builtState.state,
        fixture.builtState.state.options,
      ),
    ).resolves.toMatchObject({
      ok: false,
      telemetry: { failureKind: "timeout" },
    });
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  it("waits for aborted provider cleanup before a following selector uses the global lock", async () => {
    const fixture = makeCommanderStage2Fixture();
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
          stdout: JSON.stringify({
            selectedStrategicOptionId: "pressure_rival:P8",
            horizonDecisions: 4,
            intent: "continue after the prior process is gone",
            replanTriggers: [],
          }),
          stderr: "",
          code: 0,
          timedOut: false,
        });
      }
      return new Promise((resolve) => {
        const finishCleanup = () => {
          setTimeout(() => {
            active -= 1;
            resolve({
              stdout: "",
              stderr: "",
              code: null,
              timedOut: false,
              aborted: true,
            });
          }, 80);
        };
        if (input.signal?.aborted === true) finishCleanup();
        else
          input.signal?.addEventListener("abort", finishCleanup, {
            once: true,
          });
      });
    };
    const selector = new LlmOptionSelector({
      provider: new ClaudeCliLlmProvider({ commandRunner: runner }),
      timeoutMs: 20,
    });

    await expect(
      selector.select(
        fixture.builtState.state,
        fixture.builtState.state.options,
      ),
    ).resolves.toMatchObject({
      ok: false,
      telemetry: { failureKind: "timeout" },
    });
    await expect(
      selector.select(
        fixture.builtState.state,
        fixture.builtState.state.options,
      ),
    ).resolves.toMatchObject({
      ok: true,
      selection: { selectedStrategicOptionId: "pressure_rival:P8" },
    });
    expect(calls).toBe(2);
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
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
