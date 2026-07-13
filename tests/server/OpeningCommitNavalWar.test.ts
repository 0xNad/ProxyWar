import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  navalWarCandidate,
  openingCommitDevelopmentCandidate,
  promoteArgmaxPrimary,
  FrontierPolicyExecutor,
  RuleAgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

/**
 * Keystone v13 (qd1n forensics 2026-07-13): opening-commitment floor (idle
 * troops buy land — the 5:1 land-race loss), naval war (the 15,600-turn
 * freeze: no land border treated as no war possible), base-floor invasion
 * carve-out (must-follow expansion mandated during the fatal invasion).
 */

type Ranked = Parameters<typeof promoteArgmaxPrimary>[0][number];

const FLAGS = [
  "PROXYWAR_TUNE_OPENING_COMMIT",
  "PROXYWAR_TUNE_OPENING_PHASE_LOCK",
  "PROXYWAR_TUNE_NAVAL_WAR",
  "PROXYWAR_TUNE_THIN_EXECUTOR",
  "PROXYWAR_TUNE_DIRECTIVE_COMMITMENT",
] as const;

function ranked(
  id: string,
  kind: LegalAction["kind"],
  totalScore: number,
  over: Partial<LegalAction> = {},
): Ranked {
  return {
    action: {
      id,
      kind,
      label: id,
      intent: null,
      risk: { level: "low", score: 0.2 },
      ...over,
    },
    totalScore,
    policy: { totalScore, contributions: [], penalties: [] },
    skill: undefined,
    primaryModule: "expansion",
    schedulerSlot: "neutral_expansion",
  } as unknown as Ranked;
}

function farRival(over: Partial<AgentVisiblePlayer> = {}): AgentVisiblePlayer {
  return {
    playerID: "FAR",
    clientID: "FAR",
    smallID: 9,
    name: "Far",
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 900_000,
    maxTroops: 2_000_000,
    troopRatio: 0.45,
    gold: "1000",
    tilesOwned: 200_000,
    tileShare: 0.6,
    sharesBorder: false,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: false,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.1,
    ...over,
  };
}

function frozenObservation(tilesFlat: boolean): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "FREEZE",
    turnNumber: 8000,
    phaseOverride: "active",
  });
  const tiles = tilesFlat ? [81_164, 81_164, 81_164, 81_164, 81_164] : [70_000, 74_000, 78_000, 80_000, 81_164];
  return {
    ...base,
    ownState: {
      playerID: "agent-1",
      clientID: null,
      smallID: 1,
      name: "Keystone",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 10_000_000,
      maxTroops: 10_300_000,
      troopRatio: 0.97,
      gold: "67000000",
      tilesOwned: 81_164,
      tileShare: 0.15,
      borderTiles: 400,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    visiblePlayers: [farRival()],
    combat: { ...base.combat, troopRatio: 0.97, ownTroops: 10_000_000 },
    memory: {
      ...base.memory,
      recentActions: tiles.map((ownTiles, i) => ({
        sequence: i,
        actionID: "expand:terra-nullius:10",
        actionKind: "attack" as const,
        reason: "expand",
        accepted: true,
        ownTiles,
        expansion: true,
      })),
    },
  };
}

describe("naval war (PROXYWAR_TUNE_NAVAL_WAR)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const flag of FLAGS) saved[flag] = process.env[flag];
  });
  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag]!;
    }
  });

  it("flag OFF (default): undefined even in the freeze regime", () => {
    delete process.env.PROXYWAR_TUNE_NAVAL_WAR;
    expect(
      navalWarCandidate({ observation: frozenObservation(true), legalActions: [] }, [
        ranked("boat:FAR:16", "boat", 30, { metadata: { targetID: "FAR" } }),
      ]),
    ).toBeUndefined();
  });

  it("no land border + alive rival + capped troops: forces the player-targeting boat", () => {
    process.env.PROXYWAR_TUNE_NAVAL_WAR = "1";
    const picked = navalWarCandidate(
      { observation: frozenObservation(false), legalActions: [] },
      [
        ranked("expand:terra-nullius:10", "attack", 100, {
          metadata: { expansion: true },
        }),
        ranked("boat:neutral:8", "boat", 60, { metadata: {} }),
        ranked("boat:FAR:16", "boat", 30, { metadata: { targetID: "FAR" } }),
      ],
    );
    expect(picked?.action.id).toBe("boat:FAR:16");
  });

  it("no invasion boat offered + tiles flat: best development action replaces the no-op expand", () => {
    process.env.PROXYWAR_TUNE_NAVAL_WAR = "1";
    const picked = navalWarCandidate(
      { observation: frozenObservation(true), legalActions: [] },
      [
        ranked("expand:terra-nullius:10", "attack", 100, {
          metadata: { expansion: true },
        }),
        ranked("build:Port:9", "build", 55, { metadata: { unit: "Port" } }),
      ],
    );
    expect(picked?.action.id).toBe("build:Port:9");
    // Tiles still moving -> no suppression, leaf stands down.
    expect(
      navalWarCandidate({ observation: frozenObservation(false), legalActions: [] }, [
        ranked("expand:terra-nullius:10", "attack", 100, {
          metadata: { expansion: true },
        }),
        ranked("build:Port:9", "build", 55, { metadata: { unit: "Port" } }),
      ]),
    ).toBeUndefined();
  });

  it("hostile attacks with flat tiles are not misclassified as failed expansion", () => {
    process.env.PROXYWAR_TUNE_NAVAL_WAR = "1";
    const base = frozenObservation(true);
    const observation: AgentObservation = {
      ...base,
      memory: {
        ...base.memory,
        recentActions: base.memory.recentActions.map((decision) => ({
          ...decision,
          actionID: "attack:FAR:25",
          targetID: "FAR",
          expansion: false,
        })),
      },
    };
    expect(
      navalWarCandidate({ observation, legalActions: [] }, [
        ranked("expand:terra-nullius:10", "attack", 100, {
          metadata: { expansion: true },
        }),
        ranked("build:Port:9", "build", 55, {
          metadata: { unit: "Port" },
        }),
      ]),
    ).toBeUndefined();
  });

  it("a bordered rival closes the regime (land war owns it)", () => {
    process.env.PROXYWAR_TUNE_NAVAL_WAR = "1";
    const observation = {
      ...frozenObservation(true),
      visiblePlayers: [farRival({ sharesBorder: true, canAttack: true })],
    };
    expect(
      navalWarCandidate({ observation, legalActions: [] }, [
        ranked("boat:FAR:16", "boat", 30, { metadata: { targetID: "FAR" } }),
      ]),
    ).toBeUndefined();
  });
});

describe("opening-commitment floor (PROXYWAR_TUNE_OPENING_COMMIT)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const flag of FLAGS) saved[flag] = process.env[flag];
  });
  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag]!;
    }
  });

  const openingObservation = (
    turnNumber = 900,
    troopRatio = 0.67,
  ): AgentObservation => {
    const base = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Keystone",
      profile: "aggressive",
      gameID: "COMMIT",
      turnNumber,
      phaseOverride: "active",
    });
    return {
      ...base,
      ownState: {
        playerID: "agent-1",
        clientID: null,
        smallID: 1,
        name: "Keystone",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 600_000,
        maxTroops: 900_000,
        troopRatio,
        gold: "50000",
        tilesOwned: 4_000,
        tileShare: 0.05,
        borderTiles: 60,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: { ...base.combat, troopRatio, ownTroops: 600_000 },
      memory: {
        ...base.memory,
        // Heavy recent expansion — the shipped path would de-escalate to 15%.
        recentExpansionCount: 6,
      },
    };
  };

  const expansionActions = (): LegalAction[] =>
    [10, 20, 35].map((pc) => ({
      id: `expand:terra-nullius:${pc}`,
      kind: "attack" as const,
      label: `Expand into neutral land with ${pc}% troops`,
      intent: { type: "attack", targetID: null, troops: 1000 * pc },
      risk: { level: "low" as const, score: 0.1 },
      metadata: { expansion: true, troopPercent: pc },
    }));

  const hostileOpeningObservation = (incoming: boolean): AgentObservation => {
    const base = openingObservation();
    return {
      ...base,
      ownState:
        base.ownState === null
          ? null
          : {
              ...base.ownState,
              tilesOwned: 1_500,
              tileShare: 0.02,
            },
      visiblePlayers: [
        farRival({
          playerID: "RIVAL",
          clientID: "RIVAL",
          name: "Parity Rival",
          troops: 570_000,
          tileShare: 0.06,
          sharesBorder: true,
          canAttack: true,
          relativeTroopRatio: 1.05,
          outgoingAttack: incoming,
        }),
      ],
      combat: {
        ...base.combat,
        attackablePlayerIDs: ["RIVAL"],
        borderedPlayerIDs: ["RIVAL"],
        weakestAttackableTargetID: "RIVAL",
        strongestAttackableTargetID: "RIVAL",
        incomingAttackPlayerIDs: incoming ? ["RIVAL"] : [],
      },
    };
  };

  const hostileOpeningActions = (incoming: boolean): LegalAction[] => [
    {
      id: "attack:RIVAL:40",
      kind: "attack",
      label: "Attack parity rival with 40%",
      intent: { type: "attack", targetID: "RIVAL", troops: 240_000 },
      risk: { level: "medium", score: 0.35 },
      metadata: {
        expansion: false,
        targetID: "RIVAL",
        targetName: "Parity Rival",
        targetTileShare: 0.06,
        relativeTroopRatio: 1.05,
        sharesBorder: true,
        incomingAttack: incoming,
        troopPercent: 40,
        troopPercentage: 0.4,
      },
    },
    ...expansionActions(),
  ];

  const pressurePlan = (observation: AgentObservation): StrategicPlan => ({
    planID: "agent-1:opening-pressure",
    objective: "pressure_rival",
    turnIntent: "pressure",
    targetPlayerId: "RIVAL",
    rationale: "pressure the bordered rival",
    startedAtTick: observation.tick,
    maxDecisionCycles: 2,
    successCriteria: ["gain rival territory"],
    failureCriteria: ["fall behind opening expansion tempo"],
    preferredActionKinds: ["attack", "hold"],
    forbiddenActionKinds: [],
    enabledModules: ["combat", "expansion", "defense"],
    plannerSource: "mock-llm",
  });

  // Mirror the keystone seat's executor settings — the territory-first path is
  // what consumes the commitment functions (KEYSTONE_EXECUTOR_SETTINGS in
  // coworld-adapter/src/keystone-player.ts).
  const keystoneExecutor = () =>
    new FrontierPolicyExecutor("aggressive", {
      settings: {
        territoryFirstNeutralLandEnabled: true,
        maxActionsPerDecision: 5,
      },
    });

  it("flag ON with idle troops: the selected expansion commits at the floor (35%), not the de-escalated 10-15%", async () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation: openingObservation(), legalActions: expansionActions() },
      null,
    );
    const decision = keystoneExecutor().decide(
      { observation: openingObservation(), legalActions: expansionActions() },
      planned.plan,
    );
    expect(decision.actionID).toBe("expand:terra-nullius:35");
    expect(decision.reason).toContain("openingCommit=escalated");
    const actionIDs = decision.actionIDs ?? [decision.actionID];
    expect(actionIDs.filter((id) => id.startsWith("expand:"))).toEqual([
      "expand:terra-nullius:35",
    ]);
    expect(actionIDs.length).toBeLessThanOrEqual(5);
  });

  it("v16: opening commitment ignores the troop floor, but post-opening still obeys it", async () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    const belowFloorOpening = openingObservation(900, 0.2);
    const openingPlan = await new RuleAgentPlanner("aggressive").plan(
      { observation: belowFloorOpening, legalActions: expansionActions() },
      null,
    );
    const openingDecision = keystoneExecutor().decide(
      { observation: belowFloorOpening, legalActions: expansionActions() },
      openingPlan.plan,
    );
    expect(openingDecision.actionID).toBe("expand:terra-nullius:35");
    expect(openingDecision.reason).toContain("openingCommit=escalated");

    const belowFloorPostOpening = openingObservation(3_100, 0.2);
    const postOpeningPlan = await new RuleAgentPlanner("aggressive").plan(
      { observation: belowFloorPostOpening, legalActions: expansionActions() },
      null,
    );
    const postOpeningDecision = keystoneExecutor().decide(
      {
        observation: belowFloorPostOpening,
        legalActions: expansionActions(),
      },
      postOpeningPlan.plan,
    );
    expect(postOpeningDecision.actionID).not.toBe("expand:terra-nullius:35");
    expect(postOpeningDecision.reason).not.toContain(
      "openingCommit=escalated",
    );
  });

  it("v17: phase-locks neutral expansion when healthy hostile pressure would leak while behind opening tempo", () => {
    const observation = hostileOpeningObservation(false);
    const legalActions = hostileOpeningActions(false);
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    delete process.env.PROXYWAR_TUNE_OPENING_PHASE_LOCK;
    const baseline = keystoneExecutor().decide(
      { observation, legalActions },
      pressurePlan(observation),
    );
    expect(baseline.actionID).toBe("attack:RIVAL:40");

    process.env.PROXYWAR_TUNE_OPENING_PHASE_LOCK = "1";
    const decision = keystoneExecutor().decide(
      { observation, legalActions },
      pressurePlan(observation),
    );
    expect(decision.actionID).toBe("expand:terra-nullius:35");
    expect(decision.reason).toContain(
      "openingCommit=phaseLocked(expand:terra-nullius:35 over attack:RIVAL:40)",
    );
  });

  it("v17: incoming pressure preserves the hostile counterattack", () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    process.env.PROXYWAR_TUNE_OPENING_PHASE_LOCK = "1";
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    const observation = hostileOpeningObservation(true);
    const legalActions = hostileOpeningActions(true);
    const decision = keystoneExecutor().decide(
      { observation, legalActions },
      pressurePlan(observation),
    );
    expect(decision.actionID).toBe("attack:RIVAL:40");
    expect(decision.reason).not.toContain("openingCommit=phaseLocked");
  });

  it("v17: a binding commitment remains primary", () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    process.env.PROXYWAR_TUNE_OPENING_PHASE_LOCK = "1";
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    process.env.PROXYWAR_TUNE_DIRECTIVE_COMMITMENT = "1";
    const observation = hostileOpeningObservation(false);
    const legalActions = hostileOpeningActions(false);
    const plan: StrategicPlan = {
      ...pressurePlan(observation),
      commitment: { targetPlayerId: "RIVAL", minAttackRatio: 0.25 },
    };
    const decision = keystoneExecutor().decide(
      { observation, legalActions },
      plan,
    );
    expect(decision.actionID).toBe("attack:RIVAL:40");
    expect(decision.reason).not.toContain("openingCommit=phaseLocked");
  });

  it("v14: a neutral banking-boat primary is escalated to the land expand while frontier remains", async () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    const actionsWithBoat: LegalAction[] = [
      {
        id: "boat:1234:16",
        kind: "boat",
        label: "Send 16% transport to Terra Nullius",
        intent: { type: "boat", troops: 96_000, dst: 1234 },
        risk: { level: "low", score: 0.2 },
        metadata: {},
      },
      ...expansionActions(),
    ];
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation: openingObservation(), legalActions: actionsWithBoat },
      null,
    );
    const decision = keystoneExecutor().decide(
      { observation: openingObservation(), legalActions: actionsWithBoat },
      planned.plan,
    );
    // Regardless of which primary the cascade chose, the wire carries a
    // committed land expand, never a banking boat, while frontier remains.
    expect(decision.actionID).toBe("expand:terra-nullius:35");
  });

  it("v14: no-op suppression — expansion primary with tiles flat swaps to the best development action", async () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    const base = openingObservation();
    const observation: AgentObservation = {
      ...base,
      memory: {
        ...base.memory,
        recentActions: [12_000, 12_000, 12_000, 12_000, 12_000].map(
          (ownTiles, i) => ({
            sequence: i,
            actionID: "expand:terra-nullius:10",
            actionKind: "attack" as const,
            reason: "expand",
            accepted: true,
            ownTiles,
            expansion: true,
          }),
        ),
      },
    };
    const actions: LegalAction[] = [
      ...expansionActions(),
      {
        id: "build:City:100",
        kind: "build",
        label: "Build City",
        intent: { type: "build_unit", unit: UnitType.City, tile: 100 },
        risk: { level: "medium", score: 0.3 },
        metadata: { role: "economic", unit: "City" },
      },
    ];
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions: actions },
      null,
    );
    const decision = keystoneExecutor().decide(
      { observation, legalActions: actions },
      planned.plan,
    );
    expect(decision.actionID).toBe("build:City:100");
    expect(decision.reason).toContain("openingCommit=noopSuppressed");
    const actionIDs = decision.actionIDs ?? [decision.actionID];
    expect(actionIDs.some((id) => id.startsWith("expand:"))).toBe(false);
    expect(actionIDs.length).toBeLessThanOrEqual(5);
  });

  it("hostile attacks with flat tiles do not suppress valid neutral expansion", async () => {
    process.env.PROXYWAR_TUNE_OPENING_COMMIT = "1";
    const base = openingObservation();
    const observation: AgentObservation = {
      ...base,
      memory: {
        ...base.memory,
        recentActions: [12_000, 12_000, 12_000, 12_000].map(
          (ownTiles, i) => ({
            sequence: i,
            actionID: "attack:RIVAL:25",
            actionKind: "attack" as const,
            reason: "hostile pressure",
            accepted: true,
            ownTiles,
            targetID: "RIVAL",
            expansion: false,
          }),
        ),
      },
    };
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions: expansionActions() },
      null,
    );
    const decision = keystoneExecutor().decide(
      { observation, legalActions: expansionActions() },
      planned.plan,
    );
    expect(decision.actionID).toBe("expand:terra-nullius:35");
    expect(decision.reason).not.toContain("openingCommit=noopSuppressed");
  });

  it("rejects a higher-scored unsafe hostile fallback in favor of a safe build", () => {
    const unsafeAttack = ranked("attack:RIVAL:40", "attack", 100, {
      risk: { level: "high", score: 0.9 },
      metadata: { expansion: false, targetID: "RIVAL" },
    });
    unsafeAttack.policy.penalties.push(
      "attack would deplete the reserve below competitive defense",
    );
    const safeBuild = ranked("build:City:100", "build", 25, {
      metadata: { unit: "City" },
    });
    expect(
      openingCommitDevelopmentCandidate([unsafeAttack, safeBuild])?.action.id,
    ).toBe("build:City:100");

    const unsafeBoat = ranked("boat:RIVAL:40", "boat", 110, {
      risk: { level: "high", score: 0.95 },
      metadata: { targetID: "RIVAL" },
    });
    unsafeBoat.policy.penalties.push(
      "attack would deplete the reserve below competitive defense",
    );
    expect(
      openingCommitDevelopmentCandidate([unsafeBoat, safeBuild])?.action.id,
    ).toBe("build:City:100");
  });

  it("flag OFF: shipped de-escalation picks the low-commitment expand", async () => {
    delete process.env.PROXYWAR_TUNE_OPENING_COMMIT;
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation: openingObservation(), legalActions: expansionActions() },
      null,
    );
    const decision = keystoneExecutor().decide(
      { observation: openingObservation(), legalActions: expansionActions() },
      planned.plan,
    );
    expect(decision.actionID).not.toBe("expand:terra-nullius:35");
  });
});
