import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  navalWarCandidate,
  promoteArgmaxPrimary,
  FrontierPolicyExecutor,
  RuleAgentPlanner,
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
  "PROXYWAR_TUNE_NAVAL_WAR",
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

  const openingObservation = (): AgentObservation => {
    const base = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Keystone",
      profile: "aggressive",
      gameID: "COMMIT",
      turnNumber: 900,
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
        troopRatio: 0.67,
        gold: "50000",
        tilesOwned: 4_000,
        tileShare: 0.05,
        borderTiles: 60,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: { ...base.combat, troopRatio: 0.67, ownTroops: 600_000 },
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
