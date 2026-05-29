import { describe, expect, it } from "vitest";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import type {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LlmAgentBrain } from "../../src/server/agents/LlmAgentBrain";
import { LlmDecisionParser } from "../../src/server/agents/LlmDecisionParser";
import { LlmPromptBuilder } from "../../src/server/agents/LlmPromptBuilder";
import { LlmProvider } from "../../src/server/agents/LlmProvider";
import { MockLlmProvider } from "../../src/server/agents/MockLlmProvider";

const observation: AgentObservation = {
  agentID: "agent-1",
  clientID: "CLNT0001",
  username: "Agent One",
  profile: "diplomatic",
  gameID: "AGENTLLM",
  phase: "active",
  turnNumber: 12,
  tick: 320,
  ownState: {
    playerID: "PLAYER01",
    clientID: "CLNT0001",
    smallID: 1,
    name: "Agent One",
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    isTraitor: false,
    hasSpawned: true,
    troops: 100,
    gold: "50",
    tilesOwned: 20,
    borderTiles: 4,
    outgoingAttacks: 0,
    incomingAttacks: 0,
    outgoingAllianceRequests: 0,
    incomingAllianceRequests: 0,
  },
  visiblePlayers: [],
  combat: {
    ownTroops: 100,
    borderedPlayerIDs: [],
    attackablePlayerIDs: [],
    canExpandIntoNeutral: false,
    neutralExpansionLegalReason: null,
    incomingAttackPlayerIDs: [],
    outgoingAttackPlayerIDs: [],
    weakestAttackableTargetID: null,
    strongestAttackableTargetID: null,
    blockerNotes: ["no visible hostile borders in current snapshot"],
  },
  nonCombat: {
    buildOptions: [],
    supportOptions: [],
    embargoOptions: [],
    blockerNotes: ["no non-combat options in static test observation"],
  },
  strategic: {
    priority: "ally",
    urgency: "low",
    summary:
      "priority=ally, urgency=low, expand=0, economy=0, offense=0, defense=0, threat=0",
    scores: {
      expansion: 0,
      economy: 0,
      defense: 0,
      offense: 0,
      diplomacy: 0.7,
      threat: 0,
      idleTroops: 0,
    },
    recommendedActionKinds: ["alliance_request", "build", "hold"],
    targetPlayerIDs: ["PLAYER02"],
    notes: ["static test observation"],
  },
  memory: {
    recentActions: [],
    recentActionCountsByKind: {},
    recentNonHoldCount: 0,
    recentExpansionCount: 0,
    recentBuildCount: 0,
    repeatedActionKind: null,
    repeatedActionCount: 0,
    avoidActionIDs: [],
    summary: "no recent agent decisions",
    notes: [],
  },
  objective: null,
  recentDecisions: [],
  notes: [],
};

const objectiveObservation: AgentObservation = {
  ...observation,
  objective: {
    objectiveID: "agent-1:build_alliance",
    kind: "build_alliance",
    label: "Build alliance network",
    status: "active",
    createdTurn: 12,
    updatedTurn: 12,
    preferredActionKinds: [
      "alliance_request",
      "donate_troops",
      "donate_gold",
      "build",
      "hold",
    ],
    targetPlayerID: "PLAYER02",
    targetPlayerName: "Player Two",
    progress: {
      recentDecisionCount: 0,
      alignedRecentDecisionCount: 0,
      consecutiveAlignedDecisionCount: 0,
    },
    summary:
      "Build alliance network (active); recentAligned=0/0; consecutive=0; legalAligned=1; target=Player Two",
    notes: ["static test objective"],
  },
};

const legalActions: LegalAction[] = [
  {
    id: "alliance:PLAYER02",
    kind: "alliance_request",
    label: "Request alliance with Player Two",
    intent: { type: "allianceRequest", recipient: "PLAYER02" },
    risk: { level: "low", score: 0.2 },
    metadata: { recipientID: "PLAYER02" },
  },
  {
    id: "hold",
    kind: "hold",
    label: "Hold this turn",
    intent: null,
    risk: { level: "none", score: 0 },
  },
];

describe("LLM agent decision contract", () => {
  it("builds a prompt with observation data and legal action ids", () => {
    const prompt = new LlmPromptBuilder().build({
      observation: objectiveObservation,
      legalActions,
      personality: "careful diplomat",
    });

    expect(prompt).toContain("JSON only");
    expect(prompt).toContain("Agent One");
    expect(prompt).toContain("LEGAL_ACTIONS_JSON");
    expect(prompt).toContain("alliance:PLAYER02");
    expect(prompt).toContain("hold");
    expect(prompt).toContain("must not invent actions");
    expect(prompt).toContain("Do not write code");
    expect(prompt).toContain("OPENFRONT_PLAYBOOK");
    expect(prompt).toContain("expand territory");
    expect(prompt).toContain("priority=ally");
    expect(prompt).toContain("no recent agent decisions");
    expect(prompt).toContain("build_alliance");
    expect(prompt).toContain("Build alliance network");
    expect(prompt).toContain("STRATEGIC_SKILL_SCORES_JSON");
    expect(prompt).toContain("diplomacy");
  });

  it("accepts valid JSON and clamps numeric confidence", () => {
    const result = new LlmDecisionParser().parse(
      JSON.stringify({
        selectedLegalActionId: "alliance:PLAYER02",
        reason: "This creates an early safety buffer.",
        confidence: 1.4,
      }),
      legalActions,
    );

    expect(result).toMatchObject({
      ok: true,
      selectedLegalActionId: "alliance:PLAYER02",
      confidence: 1,
    });
  });

  it("accepts a single fenced JSON object", () => {
    const result = new LlmDecisionParser().parse(
      '```json\n{"selectedLegalActionId":"hold","reason":"No safe action is available.","confidence":0.5}\n```',
      legalActions,
    );

    expect(result).toMatchObject({
      ok: true,
      selectedLegalActionId: "hold",
    });
  });

  it("rejects malformed JSON", () => {
    const result = new LlmDecisionParser().parse("{bad json", legalActions);

    expect(result).toMatchObject({
      ok: false,
    });
    expect(result.reason).toContain("malformed JSON");
  });

  it("rejects code-like model output instead of treating it as gameplay", () => {
    const result = new LlmDecisionParser().parse(
      'const action = legalActions[0]; return { selectedLegalActionId: action.id, reason: "scripted" };',
      legalActions,
    );

    expect(result).toMatchObject({
      ok: false,
    });
    expect(result.reason).toContain("malformed JSON");
  });

  it("rejects an unknown legal action id", () => {
    const result = new LlmDecisionParser().parse(
      JSON.stringify({
        selectedLegalActionId: "attack:missing",
        reason: "Trying something else.",
      }),
      legalActions,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "unknown selectedLegalActionId: attack:missing",
    });
  });

  it("rejects a missing selectedLegalActionId", () => {
    const result = new LlmDecisionParser().parse(
      JSON.stringify({ reason: "No id." }),
      legalActions,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "selectedLegalActionId must be a string",
    });
  });

  it("rejects invalid confidence values", () => {
    const result = new LlmDecisionParser().parse(
      JSON.stringify({
        selectedLegalActionId: "hold",
        reason: "Hold safely.",
        confidence: "certain",
      }),
      legalActions,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "confidence must be a finite number",
    });
  });

  it.each([
    [
      "empty output",
      "",
      "empty LLM response",
    ],
    [
      "extra field",
      JSON.stringify({
        selectedLegalActionId: "hold",
        reason: "Hold.",
        intent: { type: "spawn", tile: 1 },
      }),
      "unknown JSON field: intent",
    ],
    [
      "raw intent JSON",
      JSON.stringify({ type: "spawn", tile: 1 }),
      "unknown JSON field: type",
    ],
    [
      "actionId alias",
      JSON.stringify({
        actionId: "hold",
        reason: "Hold.",
      }),
      "unknown JSON field: actionId. Use selectedLegalActionId instead.",
    ],
    [
      "empty reason",
      JSON.stringify({
        selectedLegalActionId: "hold",
        reason: "  ",
      }),
      "reason cannot be empty",
    ],
    [
      "array response",
      JSON.stringify([{ selectedLegalActionId: "hold", reason: "Hold." }]),
      "LLM response must be a JSON object",
    ],
    [
      "primitive response",
      JSON.stringify("hold"),
      "LLM response must be a JSON object",
    ],
  ])("rejects %s", (_label, raw, reason) => {
    const result = new LlmDecisionParser().parse(raw, legalActions);

    expect(result).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("rejects overlong reasons", () => {
    const result = new LlmDecisionParser({ maxReasonLength: 10 }).parse(
      JSON.stringify({
        selectedLegalActionId: "hold",
        reason: "This reason is too long.",
      }),
      legalActions,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "reason exceeds 10 characters",
    });
  });

  it("falls back safely when mock LLM output is invalid", async () => {
    const brain = new LlmAgentBrain({
      provider: new MockLlmProvider({ mode: "unknown" }),
      profile: "opportunistic",
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("hold");
    expect(decision.metadata).toMatchObject({
      brain: "llm",
      llmParseOk: false,
      fallbackUsed: true,
      fallbackActionID: "hold",
    });
  });

  it("falls back when a provider throws", async () => {
    const provider: LlmProvider = {
      providerType: "custom",
      complete: async () => {
        throw new Error("provider unavailable");
      },
    };
    const brain = new LlmAgentBrain({ provider, profile: "diplomatic" });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("alliance:PLAYER02");
    expect(decision.metadata).toMatchObject({
      brain: "llm",
      brainType: "real-llm",
      runtimeMode: "llm-action-selector",
      externalPlannerCall: false,
      externalActionCall: true,
      rawProviderOutputPresent: false,
      llmParseOk: false,
      fallbackUsed: true,
      fallbackActionID: "alliance:PLAYER02",
    });
    expect(decision.metadata?.llmParseFailureReason).toContain(
      "provider unavailable",
    );
  });

  it("falls back when a provider exceeds the brain timeout", async () => {
    const provider: LlmProvider = {
      providerType: "custom",
      complete: async () => new Promise<string>(() => {}),
    };
    const brain = new LlmAgentBrain({
      provider,
      profile: "diplomatic",
      providerTimeoutMs: 1,
    });

    const decision = await brain.decide({ observation, legalActions });

    expect(decision.actionID).toBe("alliance:PLAYER02");
    expect(decision.metadata).toMatchObject({
      brain: "llm",
      brainType: "real-llm",
      llmParseOk: false,
      fallbackUsed: true,
      fallbackActionID: "alliance:PLAYER02",
    });
    expect(decision.metadata?.llmParseFailureReason).toContain("timed out");
  });

  it("selects a valid legal action by id with the mock LLM provider", async () => {
    const provider = new MockLlmProvider({
      mode: "valid",
      preferKind: "alliance_request",
    });
    const brain = new LlmAgentBrain({ provider, profile: "diplomatic" });

    const decision = await brain.decide({ observation, legalActions });

    expect(provider.prompts[0]).toContain("LEGAL_ACTIONS_JSON");
    expect(decision).toMatchObject({
      actionID: "alliance:PLAYER02",
      metadata: {
        brain: "llm",
        runtimeMode: "llm-action-selector",
        plannerSource: "none",
        executorSource: "llm-action-selector",
        actionSelectionSource: "llm-action-selector",
        externalPlannerCall: false,
        externalActionCall: false,
        rawProviderOutputPresent: false,
        llmParseOk: true,
        fallbackUsed: false,
      },
    });
  });

  it("mock LLM uses skill scores to diversify repeated expansion", async () => {
    const provider = new MockLlmProvider({ mode: "valid" });
    const brain = new LlmAgentBrain({ provider, profile: "opportunistic" });
    const repeatedExpansionObservation: AgentObservation = {
      ...observation,
      profile: "opportunistic",
      strategic: {
        ...observation.strategic,
        priority: "expand",
        recommendedActionKinds: ["attack", "build", "hold"],
      },
      memory: {
        recentActions: [],
        recentActionCountsByKind: { attack: 2 },
        recentNonHoldCount: 2,
        recentExpansionCount: 2,
        recentBuildCount: 0,
        repeatedActionKind: "attack",
        repeatedActionCount: 2,
        avoidActionIDs: ["expand:terra-nullius:10"],
        summary: "recent=attack,attack; expansions=2; builds=0; repeat=attackx2",
        notes: ["recent expansion streak"],
      },
      objective: {
        objectiveID: "agent-1:expand_territory",
        kind: "expand_territory",
        label: "Expand territory",
        status: "active",
        createdTurn: 12,
        updatedTurn: 12,
        preferredActionKinds: ["attack", "build", "hold"],
        progress: {
          recentDecisionCount: 2,
          alignedRecentDecisionCount: 2,
          consecutiveAlignedDecisionCount: 2,
        },
        summary: "expand_territory active",
        notes: [],
      },
    };
    const actionSet: LegalAction[] = [
      {
        id: "expand:terra-nullius:20",
        kind: "attack",
        label: "Expand into neutral land",
        intent: { type: "attack", targetID: null, troops: 20 },
        risk: { level: "low", score: 0.1 },
        metadata: { expansion: true, troopPercent: 20 },
      },
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "medium", score: 0.3 },
        metadata: { role: "economic", unit: "City" },
      },
      {
        id: "hold",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "none", score: 0 },
      },
    ];

    const decision = await brain.decide({
      observation: repeatedExpansionObservation,
      legalActions: actionSet,
    });

    expect(decision).toMatchObject({
      actionID: "build:City:100",
      metadata: {
        brain: "llm",
        llmParseOk: true,
        fallbackUsed: false,
      },
    });
  });

  it("can prefer the first offered attack action in attack mode", async () => {
    const provider = new MockLlmProvider({ mode: "attack" });
    const brain = new LlmAgentBrain({ provider, profile: "aggressive" });
    const attackActions: LegalAction[] = [
      {
        id: "hold",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "none", score: 0 },
      },
      {
        id: "attack:PLAYER02:25",
        kind: "attack",
        label: "Attack Player Two with 25% troops",
        intent: { type: "attack", targetID: "PLAYER02", troops: 25 },
        risk: { level: "low", score: 0.1 },
      },
    ];

    const decision = await brain.decide({
      observation,
      legalActions: attackActions,
    });

    expect(decision).toMatchObject({
      actionID: "attack:PLAYER02:25",
      metadata: {
        brain: "llm",
        llmParseOk: true,
        fallbackUsed: false,
      },
    });
  });

  it("can prefer build, support, and non-hold mock scenarios", async () => {
    const actionSet: LegalAction[] = [
      {
        id: "hold",
        kind: "hold",
        label: "Hold",
        intent: null,
        risk: { level: "none", score: 0 },
      },
      {
        id: "build:Defense Post:10",
        kind: "build",
        label: "Build Defense Post",
        intent: {
          type: "build_unit",
          unit: UnitType.DefensePost,
          tile: 10,
        },
        risk: { level: "low", score: 0.1 },
      },
      {
        id: "donate_troops:PLAYER02",
        kind: "donate_troops",
        label: "Donate troops",
        intent: {
          type: "donate_troops",
          recipient: "PLAYER02",
          troops: 10,
        },
        risk: { level: "medium", score: 0.4 },
      },
    ];

    await expect(
      new LlmAgentBrain({
        provider: new MockLlmProvider({ mode: "build" }),
        profile: "defensive",
      }).decide({ observation, legalActions: actionSet }),
    ).resolves.toMatchObject({ actionID: "build:Defense Post:10" });

    await expect(
      new LlmAgentBrain({
        provider: new MockLlmProvider({ mode: "support" }),
        profile: "diplomatic",
      }).decide({ observation, legalActions: actionSet }),
    ).resolves.toMatchObject({ actionID: "donate_troops:PLAYER02" });

    await expect(
      new LlmAgentBrain({
        provider: new MockLlmProvider({ mode: "non_hold" }),
        profile: "opportunistic",
      }).decide({ observation, legalActions: actionSet }),
    ).resolves.toMatchObject({ actionID: "build:Defense Post:10" });
  });
});
