import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import { StrategicCommanderBrain } from "../../src/server/agents/StrategicCommanderBrain";
import { StrategicCommanderCaller } from "../../src/server/agents/StrategicCommanderCaller";
import {
  makeCommanderStage2Fixture,
  RAW_ATTACK_ACTION_ID,
  RAW_BUILD_ACTION_ID,
  RAW_EXPANSION_ACTION_ID,
  type CommanderStage2Fixture,
} from "./StrategicCommanderStage2TestHarness";

/** Current P7 pressure binding after this test renames the offered attack. */
const RENAMED_ATTACK_ACTION_ID = "raw-attack-P7-41-percent";

class QueueProvider implements LlmProvider {
  readonly prompts: string[] = [];
  private readonly responses: string[];

  constructor(...responses: string[]) {
    this.responses = responses;
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const next =
      this.responses[
        Math.min(this.prompts.length - 1, this.responses.length - 1)
      ];
    if (next === undefined) {
      throw new Error("the provider was consulted without a scripted response");
    }
    return next;
  }
}

class ScriptedTacticalBrain implements AgentBrain {
  readonly brainType = "rule";
  readonly menus: LegalAction[][] = [];
  readonly decisions: AgentDecision[] = [];

  constructor(
    private readonly script: (input: AgentBrainInput) => AgentDecision,
  ) {}

  decide(input: AgentBrainInput): AgentDecision {
    this.menus.push(input.legalActions);
    const decision = this.script(input);
    this.decisions.push(decision);
    return decision;
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

function firstOfferedTactical(): ScriptedTacticalBrain {
  return new ScriptedTacticalBrain((input) => ({
    actionID: input.legalActions[0]!.id,
    reason: "tactical pick",
  }));
}

function makeBrain(
  provider: LlmProvider,
  tactical: AgentBrain,
): StrategicCommanderBrain {
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

function nonStrategicMenu(): LegalAction[] {
  return [
    {
      id: "raw-emoji-wave",
      kind: "emoji",
      label: "emoji: wave",
      intent: null,
      risk: { level: "none", score: 0 },
    },
  ];
}

describe("StrategicCommanderBrain Stage 5 — plan installation and reuse", () => {
  it("installs the initial plan and executes only the current aligned primary binding", async () => {
    const provider = new QueueProvider(commanderResponse("pressure_rival:P7"));
    const tactical = firstOfferedTactical();
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();

    const decision = await brain.decide(brainInput(fixture));

    expect(brain.brainType).toBe("rule");
    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]).toContain('"decisionSequence":0');
    expect(tactical.menus).toHaveLength(1);
    expect(tactical.menus[0]!.map((action) => action.id)).toEqual([
      RAW_ATTACK_ACTION_ID,
    ]);
    expect(decision).toEqual({
      actionID: RAW_ATTACK_ACTION_ID,
      reason: "tactical pick",
      metadata: {
        commanderSelectedStrategicOptionId: "pressure_rival:P7",
        commanderExecutionFallback: false,
      },
    });
  });

  it("returns a single primary action id and drops batch, deal, and message channels", async () => {
    const provider = new QueueProvider(commanderResponse("pressure_rival:P7"));
    const tactical = new ScriptedTacticalBrain(() => ({
      actionID: RAW_ATTACK_ACTION_ID,
      actionIDs: [RAW_ATTACK_ACTION_ID, RAW_BUILD_ACTION_ID],
      dealActionID: "raw-deal-propose-P7",
      messageActionID: "raw-message-P7",
      messageText: "smuggled negotiation",
      reason: "tactical pick with extra channels",
    }));
    const brain = makeBrain(provider, tactical);

    const decision = await brain.decide(
      brainInput(makeCommanderStage2Fixture()),
    );

    expect(decision.actionID).toBe(RAW_ATTACK_ACTION_ID);
    expect(decision.actionIDs).toBeUndefined();
    expect(decision.spawnPreferenceActionIDs).toBeUndefined();
    expect(decision.dealActionID).toBeUndefined();
    expect(decision.messageActionID).toBeUndefined();
    expect(decision.messageText).toBeUndefined();
  });

  it("continues the installed plan without another provider call", async () => {
    const provider = new QueueProvider(commanderResponse("pressure_rival:P7"));
    const tactical = firstOfferedTactical();
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();

    const first = await brain.decide(brainInput(fixture));
    const second = await brain.decide(brainInput(fixture));

    expect(provider.prompts).toHaveLength(1);
    expect(first.actionID).toBe(RAW_ATTACK_ACTION_ID);
    expect(second.actionID).toBe(RAW_ATTACK_ACTION_ID);
    expect(tactical.menus).toHaveLength(2);
    expect(tactical.menus[1]!.map((action) => action.id)).toEqual([
      RAW_ATTACK_ACTION_ID,
    ]);
  });

  it("consults the provider again at a real replan boundary and shows the expiring plan", async () => {
    const provider = new QueueProvider(
      commanderResponse("pressure_rival:P7"),
      commanderResponse("develop_economy"),
    );
    const tactical = firstOfferedTactical();
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();

    const decisions: AgentDecision[] = [];
    for (let call = 0; call < 5; call++) {
      decisions.push(await brain.decide(brainInput(fixture)));
    }

    // horizonDecisions is 4: sequences 1-3 continue, sequence 4 expires.
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain('"decisionSequence":4');
    expect(provider.prompts[1]).toContain(
      '"selectedStrategicOptionId":"pressure_rival:P7"',
    );
    expect(decisions.slice(0, 4).map((decision) => decision.actionID)).toEqual(
      Array.from({ length: 4 }, () => RAW_ATTACK_ACTION_ID),
    );
    expect(decisions[4]!.actionID).toBe(RAW_BUILD_ACTION_ID);
    expect(decisions[4]!.metadata).toMatchObject({
      commanderSelectedStrategicOptionId: "develop_economy",
      commanderExecutionFallback: false,
    });
  });
});

describe("StrategicCommanderBrain Stage 5 — identity reset", () => {
  it.each([["gameID"], ["agentID"]] as const)(
    "resets the plan and decision sequence when the %s changes",
    async (field) => {
      const provider = new QueueProvider(
        commanderResponse("pressure_rival:P7"),
      );
      const brain = makeBrain(provider, firstOfferedTactical());

      await brain.decide(brainInput(makeCommanderStage2Fixture()));
      expect(provider.prompts).toHaveLength(1);

      const other = makeCommanderStage2Fixture();
      other.observation[field] = `COMMANDER_STAGE_5_OTHER_${field}`;
      await brain.decide(brainInput(other));

      // A fresh identity starts a fresh cycle: the sequence restarts at 0 and
      // there is no continuing plan, so the provider is consulted again.
      expect(provider.prompts).toHaveLength(2);
      expect(provider.prompts[1]).toContain('"decisionSequence":0');

      // The plan installed under the new identity then continues normally.
      await brain.decide(brainInput(other));
      expect(provider.prompts).toHaveLength(2);
    },
  );
});

describe("StrategicCommanderBrain Stage 5 — tactical delegation boundaries", () => {
  it("delegates unchanged outside the active phase without consulting the Commander", async () => {
    const provider = new QueueProvider();
    const tacticalDecision: AgentDecision = {
      actionID: "raw-spawn-tile-7",
      spawnPreferenceActionIDs: ["raw-spawn-tile-7"],
      reason: "spawn pick",
    };
    const tactical = new ScriptedTacticalBrain(() => tacticalDecision);
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();
    fixture.observation.phase = "spawn";
    const input = brainInput(fixture);

    const decision = await brain.decide(input);

    expect(provider.prompts).toHaveLength(0);
    expect(tactical.menus[0]).toBe(input.legalActions);
    expect(decision).toBe(tacticalDecision);
  });

  it("delegates unchanged while dead and consumes no decision sequence", async () => {
    const provider = new QueueProvider(commanderResponse("pressure_rival:P7"));
    const tactical = firstOfferedTactical();
    const brain = makeBrain(provider, tactical);

    const dead = makeCommanderStage2Fixture();
    dead.observation.ownState!.isAlive = false;
    const deadInput = brainInput(dead);
    const bypassed = await brain.decide(deadInput);

    expect(provider.prompts).toHaveLength(0);
    expect(tactical.menus[0]).toBe(deadInput.legalActions);
    expect(bypassed).toBe(tactical.decisions[0]);

    // The bypass never advanced the Commander: the first real cycle is 0.
    await brain.decide(brainInput(makeCommanderStage2Fixture()));
    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]).toContain('"decisionSequence":0');
  });

  it("delegates on the original menu when the Commander has no executable resolution", async () => {
    const provider = new QueueProvider();
    const tactical = firstOfferedTactical();
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();
    const input = brainInput(fixture, nonStrategicMenu());

    const decision = await brain.decide(input);

    expect(provider.prompts).toHaveLength(0);
    expect(tactical.menus[0]).toBe(input.legalActions);
    expect(decision).toBe(tactical.decisions[0]);
    expect(decision.actionID).toBe("raw-emoji-wave");
  });
});

describe("StrategicCommanderBrain Stage 5 — stale and off-binding tactical ids", () => {
  it("replaces an off-binding tactical id with the lexicographically first aligned id", async () => {
    const provider = new QueueProvider(commanderResponse("expand"));
    const tactical = new ScriptedTacticalBrain(() => ({
      actionID: "hold",
      reason: "off-binding tactical pick",
    }));
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();
    const secondExpansion: LegalAction = {
      ...fixture.legalActions.find(
        (action) => action.id === RAW_EXPANSION_ACTION_ID,
      )!,
      id: "raw-expand-tile-100",
    };

    const decision = await brain.decide(
      brainInput(fixture, [...fixture.legalActions, secondExpansion]),
    );

    expect(tactical.menus[0]!.map((action) => action.id)).toEqual([
      RAW_EXPANSION_ACTION_ID,
      "raw-expand-tile-100",
    ]);
    expect(decision).toEqual({
      actionID: "raw-expand-tile-100",
      reason: null,
      metadata: {
        commanderSelectedStrategicOptionId: "expand",
        commanderExecutionFallback: true,
        commanderRejectedTacticalActionID: "hold",
      },
    });
  });

  it("rejects a stale tactical id from a previous decision's menu", async () => {
    const provider = new QueueProvider(commanderResponse("pressure_rival:P7"));
    const tactical = new ScriptedTacticalBrain(() => ({
      actionID: RAW_ATTACK_ACTION_ID,
      reason: "tactical pick",
    }));
    const brain = makeBrain(provider, tactical);
    const fixture = makeCommanderStage2Fixture();

    const first = await brain.decide(brainInput(fixture));
    expect(first.actionID).toBe(RAW_ATTACK_ACTION_ID);

    // Decision-scoped ids rotate: the same P7 pressure option now binds a
    // differently named attack, and the plan continues without a provider call.
    const renamedMenu = fixture.legalActions.map((action) =>
      action.id === RAW_ATTACK_ACTION_ID
        ? { ...action, id: RENAMED_ATTACK_ACTION_ID }
        : action,
    );
    const second = await brain.decide(brainInput(fixture, renamedMenu));

    expect(provider.prompts).toHaveLength(1);
    expect(tactical.menus[1]!.map((action) => action.id)).toEqual([
      RENAMED_ATTACK_ACTION_ID,
    ]);
    expect(second).toEqual({
      actionID: RENAMED_ATTACK_ACTION_ID,
      reason: null,
      metadata: {
        commanderSelectedStrategicOptionId: "pressure_rival:P7",
        commanderExecutionFallback: true,
        commanderRejectedTacticalActionID: RAW_ATTACK_ACTION_ID,
      },
    });
  });
});
