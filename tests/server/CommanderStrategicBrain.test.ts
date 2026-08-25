import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import { StrategicCommanderBrain } from "../../src/server/agents/StrategicCommanderBrain";
import { StrategicCommanderCaller } from "../../src/server/agents/StrategicCommanderCaller";
import type { CommanderState } from "../../src/server/agents/StrategicCommanderTypes";
import {
  makeCommanderStage2Fixture,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  type CommanderStage2Fixture,
} from "./StrategicCommanderStage2TestHarness";

const RENAMED_ATTACK_ACTION_ID = "raw-attack-P7-41-percent";

class QueueProvider implements LlmProvider {
  readonly prompts: string[] = [];
  constructor(private readonly responses: Array<string | Error>) {}

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const value =
      this.responses[
        Math.min(this.prompts.length - 1, this.responses.length - 1)
      ];
    if (value === undefined) throw new Error("unscripted provider call");
    if (value instanceof Error) throw value;
    return value;
  }
}

class TacticalProbe implements AgentBrain {
  readonly brainType = "rule";
  readonly inputs: AgentBrainInput[] = [];
  constructor(private readonly decision: AgentDecision) {}
  decide(input: AgentBrainInput): AgentDecision {
    this.inputs.push(input);
    return this.decision;
  }
}

function response(
  selectedStrategicOptionId: string,
  horizonDecisions = 4,
  replanTriggers: string[] = [],
): string {
  return JSON.stringify({
    selectedStrategicOptionId,
    horizonDecisions,
    intent: "execute the selected strategic option",
    replanTriggers,
  });
}

function makeBrain(provider: LlmProvider, tactical: AgentBrain) {
  return new StrategicCommanderBrain(
    new StrategicCommanderCaller(provider),
    tactical,
  );
}

function brainInput(
  fixture: CommanderStage2Fixture,
  legalActions: LegalAction[] = fixture.legalActions,
): AgentBrainInput {
  return { observation: fixture.observation, legalActions };
}

function holdOnlyMenu(): LegalAction[] {
  return [
    {
      id: "hold",
      kind: "hold",
      label: "hold",
      intent: null,
      risk: { level: "none", score: 0 },
    },
    {
      id: "emoji-wave",
      kind: "emoji",
      label: "wave",
      intent: null,
      risk: { level: "none", score: 0 },
    },
  ];
}

function commanderStateFromPrompt(prompt: string): CommanderState {
  const start = "COMMANDER_STATE_JSON:\n";
  const end = "\nEND_COMMANDER_STATE_JSON";
  const startIndex = prompt.indexOf(start);
  const endIndex = prompt.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Commander prompt is missing its state envelope");
  }
  return JSON.parse(
    prompt.slice(startIndex + start.length, endIndex),
  ) as CommanderState;
}

describe("StrategicCommanderBrain — active authority", () => {
  it("executes a Commander plan without consulting the tactical brain", async () => {
    const provider = new QueueProvider([response("pressure_rival:P7")]);
    const tactical = new TacticalProbe({ actionID: "hold", reason: "escape" });
    const brain = makeBrain(provider, tactical);
    const decision = await brain.decide(
      brainInput(makeCommanderStage2Fixture()),
    );

    expect(brain.brainType).toBe("strategic-commander");
    expect(tactical.inputs).toHaveLength(0);
    expect(provider.prompts).toHaveLength(1);
    expect(decision.actionID).toBe(RAW_ATTACK_ACTION_ID);
    expect(decision.metadata).toMatchObject({
      runtimeMode: "commander-v0-selector",
      commanderSelectedStrategicOptionId: "pressure_rival:P7",
      commanderFidelity: "aligned_primary",
      commanderSelectorSource: "llm",
      commanderPlanAgeDecisions: 0,
      commanderImmediateReplan: false,
      planFollowed: true,
      plannerFallbackUsed: false,
      externalPlannerCall: true,
      providerEvidenceSource: "trusted-in-process",
      providerCallKind: "planner",
    });
    expect(decision.metadata?.planID).toEqual(expect.any(String));
  });

  it("emits a classified same-target support batch only on the first plan decision", async () => {
    const fixture = makeCommanderStage2Fixture();
    const support: LegalAction = {
      id: "embargo-p7-start",
      kind: "embargo",
      label: "embargo P7",
      intent: { type: "embargo", targetID: "P7", action: "start" },
      risk: { level: "none", score: 0 },
      metadata: { action: "start", targetID: "P7" },
    };
    fixture.legalActions.push(support);
    const provider = new QueueProvider([response("pressure_rival:P7")]);
    const tactical = new TacticalProbe({ actionID: "hold", reason: null });
    const brain = makeBrain(provider, tactical);

    const first = await brain.decide(brainInput(fixture));
    const second = await brain.decide(brainInput(fixture));

    expect(first.actionIDs).toEqual([RAW_ATTACK_ACTION_ID, support.id]);
    expect(
      JSON.parse(String(first.metadata?.commanderBatchFidelities)),
    ).toEqual({
      [RAW_ATTACK_ACTION_ID]: "aligned_primary",
      [support.id]: "aligned_support",
    });
    expect(second.actionIDs).toBeUndefined();
    expect(provider.prompts).toHaveLength(1);
    expect(tactical.inputs).toHaveLength(0);
  });

  it("continues a durable plan and records age without another provider call", async () => {
    const provider = new QueueProvider([response("pressure_rival:P7")]);
    const tactical = new TacticalProbe({ actionID: "hold", reason: null });
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();

    const first = await brain.decide(brainInput(fixture));
    const second = await brain.decide(brainInput(fixture));

    expect(provider.prompts).toHaveLength(1);
    expect(second.actionID).toBe(RAW_ATTACK_ACTION_ID);
    expect(second.metadata?.planID).toBe(first.metadata?.planID);
    expect(second.metadata?.commanderPlanAgeDecisions).toBe(1);
    expect(tactical.inputs).toHaveLength(0);
  });

  it("keeps an executable pressure plan through two-target exposure-cap churn", async () => {
    const provider = new QueueProvider([response("pressure_rival:P9")]);
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();
    const initialMenu = fixture.legalActions.filter(
      (action) => action.metadata?.targetID !== "P8",
    );

    const first = await brain.decide(brainInput(fixture, initialMenu));
    const second = await brain.decide(brainInput(fixture));

    expect(first.actionID).toBe("raw-attack-P9-11-percent");
    expect(second.actionID).toBe("raw-attack-P9-11-percent");
    expect(second.metadata).toMatchObject({
      planID: first.metadata?.planID,
      commanderReplanReason: "within_horizon",
      commanderEligibleOptionIds: expect.stringContaining("pressure_rival:P9"),
    });
    expect(String(second.metadata?.commanderExposedOptionIds)).not.toContain(
      "pressure_rival:P9",
    );
    expect(provider.prompts).toHaveLength(1);
  });

  it("retains truthful plan age when an outer failure interrupts a later replan", async () => {
    let providerCalls = 0;
    let resolveReplan: (value: string) => void = () => undefined;
    const pendingReplan = new Promise<string>((resolve) => {
      resolveReplan = resolve;
    });
    const provider: LlmProvider = {
      complete: () => {
        providerCalls += 1;
        return providerCalls === 1
          ? Promise.resolve(response("pressure_rival:P7", 2))
          : pendingReplan;
      },
    };
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();
    const first = await brain.decide(brainInput(fixture));
    await brain.decide(brainInput(fixture));
    const interruptedCycle = brain.decide(brainInput(fixture));
    await vi.waitFor(() => expect(providerCalls).toBe(2));

    const failed = brain.failClosed({
      ...brainInput(fixture),
      cause: "brain-timeout",
      detail: "outer decision timeout",
    });
    expect(failed.metadata).toMatchObject({
      planID: first.metadata?.planID,
      commanderPlanAgeDecisions: 2,
      commanderFidelity: "hold_plan_blocked",
      commanderImmediateReplan: true,
    });
    expect(failed.metadata).not.toHaveProperty("externalPlannerCall");
    expect(failed.metadata).not.toHaveProperty("plannerRan");
    expect(failed.metadata).not.toHaveProperty("plannerLatencyMs");
    expect(failed.metadata).not.toHaveProperty("plannerParseOk");
    expect(failed.metadata).not.toHaveProperty("plannerParseFailureReason");

    resolveReplan(response("develop_economy", 2));
    const invalidated = await interruptedCycle;
    expect(invalidated.metadata).toMatchObject({
      planID: first.metadata?.planID,
      commanderPlanAgeDecisions: 2,
      commanderFidelity: "hold_plan_blocked",
    });
  });

  it("replans after canonical execution rejects the issued primary", async () => {
    const provider = new QueueProvider([
      response("pressure_rival:P7"),
      response("develop_economy"),
    ]);
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();
    const first = await brain.decide(brainInput(fixture));

    brain.onActionResult({
      decision: first,
      requestedActionID: first.actionID,
      result: {
        accepted: false,
        reason: "core rejected the offered primary",
        submittedIntent: null,
      },
    });
    const second = await brain.decide(brainInput(fixture));

    expect(provider.prompts).toHaveLength(2);
    expect(second.actionID).toBe(RAW_BUILD_ACTION_ID);
    expect(second.metadata).toMatchObject({
      commanderReplanReason: "option_not_executable",
      commanderPreviousPlanID: first.metadata?.planID,
      commanderSelectedStrategicOptionId: "develop_economy",
    });
  });

  it("replans without attacking when the selected rival disconnects", async () => {
    const provider = new QueueProvider([
      response("pressure_rival:P7"),
      response("develop_economy"),
    ]);
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();
    const first = await brain.decide(brainInput(fixture));
    fixture.observation.visiblePlayers.find(
      (player) => player.playerID === "P7",
    )!.isDisconnected = true;

    const second = await brain.decide(brainInput(fixture));

    expect(provider.prompts).toHaveLength(2);
    expect(second.actionID).toBe(RAW_BUILD_ACTION_ID);
    expect(second.actionID).not.toBe(RAW_ATTACK_ACTION_ID);
    expect(second.metadata).toMatchObject({
      commanderReplanReason: "option_not_executable",
      commanderPreviousPlanID: first.metadata?.planID,
    });
  });

  it("attributes an opted-in disconnected target as target_dead", async () => {
    const provider = new QueueProvider([
      response("pressure_rival:P7", 4, ["target_dead"]),
      response("develop_economy"),
    ]);
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();
    const first = await brain.decide(brainInput(fixture));
    fixture.observation.visiblePlayers.find(
      (player) => player.playerID === "P7",
    )!.isDisconnected = true;

    const second = await brain.decide(brainInput(fixture));

    expect(second.metadata).toMatchObject({
      commanderReplanReason: "target_dead",
      commanderPreviousPlanID: first.metadata?.planID,
      commanderSelectedStrategicOptionId: "develop_economy",
    });
  });

  it("derives bounded factual events across real Commander decisions", async () => {
    const provider = new QueueProvider([
      response("expand", 2),
      response("develop_economy", 2),
    ]);
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();
    await brain.decide(brainInput(fixture));

    fixture.observation.ownState!.tilesOwned = 290;
    fixture.observation.ownState!.troops = 19_000;
    fixture.observation.ownState!.incomingAttacks = 3;
    fixture.observation.combat.incomingAttackPlayerIDs.push("P4", "P_UNSEEN");
    fixture.observation.visiblePlayers.find(
      (player) => player.playerID === "P9",
    )!.isAlive = false;
    await brain.decide(brainInput(fixture));

    fixture.observation.ownState!.tilesOwned = 280;
    fixture.observation.ownState!.troops = 18_000;
    await brain.decide(brainInput(fixture));

    expect(provider.prompts).toHaveLength(2);
    expect(commanderStateFromPrompt(provider.prompts[1]!).recentEvents).toEqual(
      [
        "tiles 300→280 since plan start",
        "troops 20000→18000 since plan start",
        "tiles 300→290 since previous decision",
        "P4 began attacking you",
        "P9 was eliminated",
        "tiles 290→280 since previous decision",
      ],
    );
    expect(provider.prompts[1]).not.toContain("P_UNSEEN");
    expect(provider.prompts[1]).not.toContain(
      "UNBOUNDED_RECENT_DECISION_CANARY",
    );
  });

  it("replans at horizon expiry and records the replaced plan", async () => {
    const provider = new QueueProvider([
      response("pressure_rival:P7", 2),
      response("develop_economy", 2),
    ]);
    const brain = makeBrain(
      provider,
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();

    const first = await brain.decide(brainInput(fixture));
    await brain.decide(brainInput(fixture));
    const third = await brain.decide(brainInput(fixture));

    expect(provider.prompts).toHaveLength(2);
    expect(third.actionID).toBe(RAW_BUILD_ACTION_ID);
    expect(third.metadata).toMatchObject({
      commanderSelectedStrategicOptionId: "develop_economy",
      commanderReplanReason: "horizon_expiry",
      commanderPreviousPlanID: first.metadata?.planID,
    });
  });

  it("uses only the current decision's rotated action IDs", async () => {
    const provider = new QueueProvider([response("pressure_rival:P7")]);
    const tactical = new TacticalProbe({
      actionID: RAW_ATTACK_ACTION_ID,
      reason: "stale tactical output",
    });
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();
    await brain.decide(brainInput(fixture));

    const rotated = fixture.legalActions.map((action) =>
      action.id === RAW_ATTACK_ACTION_ID
        ? { ...action, id: RENAMED_ATTACK_ACTION_ID }
        : action,
    );
    const second = await brain.decide(brainInput(fixture, rotated));

    expect(second.actionID).toBe(RENAMED_ATTACK_ACTION_ID);
    expect(provider.prompts).toHaveLength(1);
    expect(tactical.inputs).toHaveLength(0);
  });

  it("keeps active hold-only play Commander-owned rather than escaping tactically", async () => {
    const provider = new QueueProvider([response("expand")]);
    const tactical = new TacticalProbe({
      actionID: "emoji-wave",
      reason: "off-plan escape",
    });
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();

    const blocked = await brain.decide(brainInput(fixture, holdOnlyMenu()));

    expect(provider.prompts).toHaveLength(1);
    expect(tactical.inputs).toHaveLength(0);
    expect(blocked).toMatchObject({
      actionID: "hold",
      metadata: {
        commanderFidelity: "aligned_primary",
        commanderImmediateReplan: false,
        commanderBlockedReason: null,
        planFollowed: true,
        commanderSelectorSource: "fallback-deterministic",
      },
    });
  });

  it("marks provider failure as a fallback-authored plan without tactical escape", async () => {
    const provider = new QueueProvider([new Error("provider unavailable")]);
    const tactical = new TacticalProbe({
      actionID: RAW_ATTACK_ACTION_ID,
      reason: "should not run",
    });
    const brain = makeBrain(provider, tactical);
    const decision = await brain.decide(
      brainInput(makeCommanderStage2Fixture()),
    );

    expect(tactical.inputs).toHaveLength(0);
    expect(decision.metadata).toMatchObject({
      commanderSelectorSource: "fallback-deterministic",
      plannerFallbackUsed: true,
      llmPlannerDegraded: true,
      degradedCause: "policy-error",
      plannerParseFailureReason: "Commander selector transport failed",
    });
    expect(
      decision.metadata?.commanderSelectedStrategicOptionId,
    ).toBeUndefined();
    expect(
      decision.metadata?.commanderFallbackSelectedStrategicOptionId,
    ).toEqual(expect.any(String));
  });

  it("retains a timeout-authored plan's degradation origin while it continues", async () => {
    const never = new Promise<string>(() => undefined);
    const provider: LlmProvider = { complete: () => never };
    const brain = new StrategicCommanderBrain(
      new StrategicCommanderCaller(provider, 2),
      new TacticalProbe({ actionID: "hold", reason: null }),
    );
    const fixture = makeCommanderStage2Fixture();

    const first = await brain.decide(brainInput(fixture));
    const second = await brain.decide(brainInput(fixture));

    expect(first.metadata).toMatchObject({
      degradedCause: "plan-timeout",
      plannerFallbackUsed: true,
    });
    expect(second.metadata).toMatchObject({
      planID: first.metadata?.planID,
      degradedCause: "plan-timeout",
      plannerFallbackUsed: true,
    });
  });
});

describe("StrategicCommanderBrain — phase and identity boundaries", () => {
  it("delegates spawn unchanged and consumes no Commander sequence", async () => {
    const provider = new QueueProvider([response("expand")]);
    const spawnDecision: AgentDecision = {
      actionID: "spawn-7",
      spawnPreferenceActionIDs: ["spawn-7"],
      reason: "spawn",
    };
    const tactical = new TacticalProbe(spawnDecision);
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();
    fixture.observation.phase = "spawn";

    expect(await brain.decide(brainInput(fixture))).toBe(spawnDecision);
    fixture.observation.phase = "active";
    const active = await brain.decide(brainInput(fixture));
    expect(active.metadata?.planID).toMatch(/^commander:0:/);
    expect(provider.prompts[0]).not.toContain('"decisionSequence"');
  });

  it("delegates dead play unchanged", async () => {
    const provider = new QueueProvider([response("expand")]);
    const deadDecision: AgentDecision = { actionID: "hold", reason: "dead" };
    const tactical = new TacticalProbe(deadDecision);
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();
    fixture.observation.ownState!.isAlive = false;

    expect(await brain.decide(brainInput(fixture))).toBe(deadDecision);
    expect(provider.prompts).toHaveLength(0);
  });

  it.each(["gameID", "agentID"] as const)(
    "resets the plan and sequence when %s changes",
    async (field) => {
      const provider = new QueueProvider([response("expand")]);
      const brain = makeBrain(
        provider,
        new TacticalProbe({ actionID: "hold", reason: null }),
      );
      const first = makeCommanderStage2Fixture();
      await brain.decide(brainInput(first));
      const second = makeCommanderStage2Fixture();
      second.observation[field] = `OTHER_${field}`;
      const reset = await brain.decide(brainInput(second));

      expect(provider.prompts).toHaveLength(2);
      expect(reset.metadata?.planID).toMatch(/^commander:0:/);
      expect(provider.prompts[1]).not.toContain('"decisionSequence"');
    },
  );
});
