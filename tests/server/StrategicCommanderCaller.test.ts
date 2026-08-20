import type { ActiveCommanderPlan } from "../../src/server/agents/CommanderPlanLifecycle";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import {
  executableExposedStrategicOptions,
  resolveStrategicOptionBinding,
  StrategicCommanderCaller,
  type StrategicCommanderCycleInput,
  type StrategicCommanderCycleOutcome,
} from "../../src/server/agents/StrategicCommanderCaller";
import type {
  BuiltStrategicOptions,
  StrategicOptionId,
} from "../../src/server/agents/StrategicCommanderTypes";
import { buildStrategicOptions } from "../../src/server/agents/StrategicOptionBuilder";
import {
  makeCommanderStage2Fixture,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  RAW_EXPANSION_ACTION_ID,
  type CommanderStage2Fixture,
} from "./StrategicCommanderStage2TestHarness";

const BASE_DECISION = 7;

/** The exact ids Stage 1 exposes for the shared fixture, in exposed order. */
const EXPOSED_IDS: StrategicOptionId[] = [
  "expand",
  "develop_economy",
  "pressure_rival:P7",
  "survive",
  "pressure_rival:P8",
];

/** Lexicographically first exposed id, which is what the fallback must pick. */
const FALLBACK_ID: StrategicOptionId = "develop_economy";

class ScriptedProvider implements LlmProvider {
  readonly prompts: string[] = [];
  constructor(private readonly script: (prompt: string) => string) {}

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.script(prompt);
  }
}

class ThrowingProvider implements LlmProvider {
  calls = 0;
  constructor(private readonly message: string) {}

  async complete(): Promise<string> {
    this.calls += 1;
    throw new Error(this.message);
  }
}

function commanderResponse(
  selectedStrategicOptionId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    selectedStrategicOptionId,
    horizonDecisions: 4,
    intent: "press the weakest border while the economy compounds",
    replanTriggers: [],
    ...overrides,
  });
}

function cycleInput(
  fixture: CommanderStage2Fixture,
  overrides: Partial<StrategicCommanderCycleInput> = {},
): StrategicCommanderCycleInput {
  return {
    observation: fixture.observation,
    options: fixture.strategicOptions,
    decisionSequence: BASE_DECISION,
    activePlan: null,
    ...overrides,
  };
}

async function runCycle(
  provider: LlmProvider,
  overrides: Partial<StrategicCommanderCycleInput> = {},
  fixture: CommanderStage2Fixture = makeCommanderStage2Fixture(),
): Promise<StrategicCommanderCycleOutcome> {
  return new StrategicCommanderCaller(provider).runCycle(
    cycleInput(fixture, overrides),
  );
}

/** Installs a real Commander-authored plan through a full caller cycle. */
async function installedPlan(
  selectedStrategicOptionId: string,
): Promise<ActiveCommanderPlan> {
  const provider = new ScriptedProvider(() =>
    commanderResponse(selectedStrategicOptionId),
  );
  const outcome = await runCycle(provider);
  expect(outcome.cycle.selector).toBe("commander");
  if (outcome.cycle.plan === null) {
    throw new Error("expected an installed plan");
  }
  return outcome.cycle.plan;
}

describe("StrategicCommanderCaller Stage 4 — provider-call boundary", () => {
  it("calls the provider once at the initial no-plan boundary and installs its choice", async () => {
    const provider = new ScriptedProvider(() =>
      commanderResponse("pressure_rival:P7"),
    );
    const outcome = await runCycle(provider);

    expect(outcome.providerCalled).toBe(true);
    expect(outcome.providerFailure).toBeNull();
    expect(provider.prompts).toHaveLength(1);
    expect(outcome.cycle.evaluation).toMatchObject({
      disposition: "replan",
      reason: "no_active_plan",
    });
    expect(outcome.cycle.responseDisposition).toBe("applied");
    expect(outcome.cycle.selector).toBe("commander");
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe(
      "pressure_rival:P7",
    );
    expect(outcome.cycle.plan?.origin.exposedOptionIDs).toEqual(EXPOSED_IDS);
  });

  it("continues a valid installed plan without calling the provider", async () => {
    const plan = await installedPlan("pressure_rival:P7");
    const provider = new ScriptedProvider(() => {
      throw new Error("the provider must not be consulted while continuing");
    });
    const outcome = await runCycle(provider, {
      decisionSequence: BASE_DECISION + 1,
      activePlan: plan,
    });

    expect(provider.prompts).toHaveLength(0);
    expect(outcome.providerCalled).toBe(false);
    expect(outcome.providerFailure).toBeNull();
    expect(outcome.cycle.evaluation).toMatchObject({
      disposition: "continue",
      reason: "within_horizon",
    });
    expect(outcome.cycle.planPreserved).toBe(true);
    expect(outcome.cycle.plan).toBe(plan);
    expect(outcome.resolution).toMatchObject({
      status: "executable",
      selectedStrategicOptionId: "pressure_rival:P7",
      alignedPrimaryActionIDs: [RAW_ATTACK_ACTION_ID],
    });
  });

  it("calls the provider again at horizon expiry and shows the expiring plan", async () => {
    const plan = await installedPlan("pressure_rival:P7");
    const provider = new ScriptedProvider(() =>
      commanderResponse("develop_economy"),
    );
    const outcome = await runCycle(provider, {
      decisionSequence: BASE_DECISION + plan.horizonDecisions,
      activePlan: plan,
    });

    expect(outcome.providerCalled).toBe(true);
    expect(provider.prompts).toHaveLength(1);
    expect(outcome.cycle.evaluation).toMatchObject({
      disposition: "replan",
      reason: "horizon_expiry",
    });
    expect(provider.prompts[0]).toContain(
      '"selectedStrategicOptionId":"pressure_rival:P7"',
    );
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe(
      "develop_economy",
    );
  });

  it("never calls the provider when no strategic options are exposed", async () => {
    const fixture = makeCommanderStage2Fixture();
    const provider = new ScriptedProvider(() => {
      throw new Error("the provider must not be consulted without options");
    });
    const outcome = await runCycle(
      provider,
      {
        options: buildStrategicOptions({
          observation: fixture.observation,
          legalActions: [],
        }),
      },
      fixture,
    );

    expect(provider.prompts).toHaveLength(0);
    expect(outcome.providerCalled).toBe(false);
    expect(outcome.cycle.evaluation.reason).toBe("no_exposed_options");
    expect(outcome.cycle.plan).toBeNull();
    expect(outcome.resolution).toEqual({ status: "no_plan" });
  });

  it("keeps LegalAction ids and bindings out of the Commander prompt", async () => {
    const provider = new ScriptedProvider(() => commanderResponse("expand"));
    await runCycle(provider);

    const prompt = provider.prompts[0]!;
    expect(prompt).not.toContain(RAW_ATTACK_ACTION_ID);
    expect(prompt).not.toContain(RAW_BUILD_ACTION_ID);
    expect(prompt).not.toContain(RAW_EXPANSION_ACTION_ID);
    expect(prompt).not.toContain("alignedPrimaryActionIDs");
    expect(prompt).not.toContain("alignedSupportActionIDs");
  });
});

describe("StrategicCommanderCaller Stage 4 — exact binding resolution", () => {
  it("resolves the installed plan to verbatim copies of the current binding", async () => {
    const fixture = makeCommanderStage2Fixture();
    const provider = new ScriptedProvider(() =>
      commanderResponse("pressure_rival:P7"),
    );
    const outcome = await runCycle(provider, {}, fixture);

    const candidate = fixture.strategicOptions.candidates.find(
      (entry) => entry.id === "pressure_rival:P7",
    )!;
    expect(outcome.resolution).toEqual({
      status: "executable",
      selectedStrategicOptionId: "pressure_rival:P7",
      alignedPrimaryActionIDs: candidate.binding.alignedPrimaryActionIDs,
      alignedSupportActionIDs: candidate.binding.alignedSupportActionIDs,
    });
    if (outcome.resolution.status !== "executable") {
      throw new Error("expected an executable resolution");
    }
    expect(outcome.resolution.alignedPrimaryActionIDs).not.toBe(
      candidate.binding.alignedPrimaryActionIDs,
    );
    expect(outcome.resolution.alignedSupportActionIDs).not.toBe(
      candidate.binding.alignedSupportActionIDs,
    );
  });

  it("resolves only against current candidates and never invents action ids", () => {
    const options = makeCommanderStage2Fixture().strategicOptions;

    expect(
      resolveStrategicOptionBinding("pressure_rival:P404", options.candidates),
    ).toBeNull();
    expect(resolveStrategicOptionBinding("expand", options.candidates)).toEqual(
      {
        alignedPrimaryActionIDs: [RAW_EXPANSION_ACTION_ID],
        alignedSupportActionIDs: [],
      },
    );

    const crippled = structuredClone(options);
    crippled.candidates.find(
      (entry) => entry.id === "expand",
    )!.binding.alignedPrimaryActionIDs = [];
    expect(
      resolveStrategicOptionBinding("expand", crippled.candidates),
    ).toBeNull();
  });
});

describe("StrategicCommanderCaller Stage 4 — option_not_executable handling", () => {
  function optionsWithoutExecutableExpand(): BuiltStrategicOptions {
    const options = structuredClone(
      makeCommanderStage2Fixture().strategicOptions,
    );
    options.candidates.find(
      (entry) => entry.id === "expand",
    )!.binding.alignedPrimaryActionIDs = [];
    return options;
  }

  it("does not expose an option whose binding cannot execute", () => {
    const options = optionsWithoutExecutableExpand();
    expect(
      executableExposedStrategicOptions(options).map((option) => option.id),
    ).toEqual(EXPOSED_IDS.filter((id) => id !== "expand"));
  });

  it("replans through the existing lifecycle path when the plan's option is no longer executable", async () => {
    const plan = await installedPlan("expand");
    const provider = new ScriptedProvider(() => commanderResponse("survive"));
    const outcome = await runCycle(provider, {
      decisionSequence: BASE_DECISION + 1,
      activePlan: plan,
      options: optionsWithoutExecutableExpand(),
    });

    expect(outcome.cycle.evaluation).toMatchObject({
      disposition: "terminate",
      reason: "option_no_longer_offered",
    });
    expect(outcome.providerCalled).toBe(true);
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe("survive");
    expect(JSON.stringify(outcome.resolution)).not.toContain(
      RAW_EXPANSION_ACTION_ID,
    );
  });

  it("replans through the existing lifecycle path when the plan's option is missing entirely", async () => {
    const plan = await installedPlan("pressure_rival:P7");
    const fixture = makeCommanderStage2Fixture();
    const provider = new ScriptedProvider(() => commanderResponse("expand"));
    const outcome = await runCycle(
      provider,
      {
        decisionSequence: BASE_DECISION + 1,
        activePlan: plan,
        options: buildStrategicOptions({
          observation: fixture.observation,
          legalActions: fixture.legalActions.filter(
            (action) => action.id !== RAW_ATTACK_ACTION_ID,
          ),
        }),
      },
      fixture,
    );

    expect(outcome.cycle.evaluation).toMatchObject({
      disposition: "terminate",
      reason: "option_no_longer_offered",
    });
    expect(outcome.providerCalled).toBe(true);
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe("expand");
    expect(outcome.resolution).toMatchObject({
      status: "executable",
      alignedPrimaryActionIDs: [RAW_EXPANSION_ACTION_ID],
    });
    expect(JSON.stringify(outcome.resolution)).not.toContain(
      RAW_ATTACK_ACTION_ID,
    );
  });

  it("falls back when the Commander selects a non-executable option", async () => {
    const provider = new ScriptedProvider(() => commanderResponse("expand"));
    const outcome = await runCycle(provider, {
      options: optionsWithoutExecutableExpand(),
    });

    expect(outcome.cycle.plan?.origin.exposedOptionIDs).not.toContain("expand");
    expect(outcome.cycle.responseDisposition).toBe("rejected");
    expect(outcome.cycle.rejection?.code).toBe("response_invalid");
    expect(outcome.cycle.selector).toBe("fallback");
    expect(outcome.cycle.fallbackReason).toBe("commander_response_invalid");
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
    expect(outcome.resolution).toMatchObject({
      status: "executable",
      selectedStrategicOptionId: FALLBACK_ID,
      alignedPrimaryActionIDs: [RAW_BUILD_ACTION_ID],
    });
    expect(JSON.stringify(outcome.resolution)).not.toContain(
      RAW_EXPANSION_ACTION_ID,
    );
  });
});

describe("StrategicCommanderCaller Stage 4 — provider and response safety", () => {
  it("installs the fallback plan when the provider throws and never propagates", async () => {
    const provider = new ThrowingProvider("provider  down\n now");
    const outcome = await runCycle(provider);

    expect(provider.calls).toBe(1);
    expect(outcome.providerCalled).toBe(true);
    expect(outcome.providerFailure).toBe("provider down now");
    expect(outcome.cycle.responseDisposition).toBe("absent");
    expect(outcome.cycle.selector).toBe("fallback");
    expect(outcome.cycle.fallbackReason).toBe("commander_result_absent");
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
    expect(outcome.resolution).toMatchObject({
      status: "executable",
      selectedStrategicOptionId: FALLBACK_ID,
    });
  });

  it("rejects malformed provider output and installs the fallback plan", async () => {
    const provider = new ScriptedProvider(
      () => "strategy: attack everyone at once!!",
    );
    const outcome = await runCycle(provider);

    expect(outcome.providerCalled).toBe(true);
    expect(outcome.providerFailure).toBeNull();
    expect(outcome.cycle.responseDisposition).toBe("rejected");
    expect(outcome.cycle.rejection?.code).toBe("response_invalid");
    expect(outcome.cycle.selector).toBe("fallback");
    expect(outcome.cycle.fallbackReason).toBe("commander_response_invalid");
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe(FALLBACK_ID);
  });

  it("keeps a continuing plan when late provider output would be rejected", async () => {
    const plan = await installedPlan("pressure_rival:P7");
    const provider = new ScriptedProvider(() => commanderResponse("expand"));
    const outcome = await runCycle(provider, {
      decisionSequence: BASE_DECISION + 2,
      activePlan: plan,
    });

    expect(outcome.providerCalled).toBe(false);
    expect(outcome.cycle.planPreserved).toBe(true);
    expect(outcome.cycle.plan?.selectedStrategicOptionId).toBe(
      "pressure_rival:P7",
    );
  });
});

describe("StrategicCommanderCaller Stage 4 — determinism", () => {
  it("produces identical outcomes and prompts for identical inputs", async () => {
    const run = async () => {
      const provider = new ScriptedProvider(() =>
        commanderResponse("pressure_rival:P7"),
      );
      const outcome = await runCycle(provider);
      return { outcome, prompts: provider.prompts };
    };

    const first = await run();
    const second = await run();
    expect(second.outcome).toEqual(first.outcome);
    expect(second.prompts).toEqual(first.prompts);
  });

  it("is insensitive to source ordering of rivals and legal actions", async () => {
    const run = async (reverseSources: boolean) => {
      const provider = new ScriptedProvider(() =>
        commanderResponse("pressure_rival:P7"),
      );
      const outcome = await runCycle(
        provider,
        {},
        makeCommanderStage2Fixture({ reverseSources }),
      );
      return { outcome, prompts: provider.prompts };
    };

    const forward = await run(false);
    const reversed = await run(true);
    expect(reversed.outcome).toEqual(forward.outcome);
    expect(reversed.prompts).toEqual(forward.prompts);
  });
});
