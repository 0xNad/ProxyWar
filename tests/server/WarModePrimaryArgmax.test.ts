import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  FrontierPolicyExecutor,
  promoteArgmaxPrimary,
  RuleAgentPlanner,
  warModeCounterstrikeCandidate,
  warModeInvaderIDs,
} from "../../src/server/agents/AgentPlannerExecutor";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

/**
 * Keystone v7 levers (4-game hosted forensics, 2026-07-12):
 * - PROXYWAR_TUNE_PRIMARY_ARGMAX: on single-action wires only the batch primary
 *   executes; module-order primaries shipped score-9-16 actions while score-100
 *   actions rode the batch and were dropped (28/40 decisions in one hosted game).
 * - PROXYWAR_TUNE_WAR_MODE: invaded-at-parity and endgame-duel regimes where every
 *   attack gate demanded a troop edge a defender-advantage endgame never shows.
 * - PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES: the armed bootstrap built the first
 *   City at t400 with 52 tiles, donating the opening land grab.
 */

type Ranked = Parameters<typeof promoteArgmaxPrimary>[0][number];

function ranked(
  id: string,
  kind: LegalAction["kind"],
  totalScore: number,
  over: Partial<LegalAction> = {},
  penalties: string[] = [],
): Ranked {
  return {
    action: {
      id,
      kind,
      label: id,
      intent: null,
      risk: { level: "medium", score: 0.3 },
      ...over,
    },
    totalScore,
    policy: { totalScore, contributions: [], penalties },
    skill: undefined,
    primaryModule: "expansion",
    schedulerSlot: "neutral_expansion",
  } as unknown as Ranked;
}

const FLAGS = [
  "PROXYWAR_TUNE_WAR_MODE",
  "PROXYWAR_TUNE_ECONOMY_BOOTSTRAP",
  "PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES",
] as const;

describe("promoteArgmaxPrimary (PROXYWAR_TUNE_PRIMARY_ARGMAX semantics)", () => {
  it("promotes a higher-scored build over a low-scored neutral-expand primary", () => {
    const expand = ranked("expand:terra-nullius:10", "attack", 12, {
      metadata: { expansion: true },
    });
    const build = ranked("build:Defense Post:200", "build", 100);
    const result = promoteArgmaxPrimary([expand, build]);
    expect(result[0]!.action.id).toBe("build:Defense Post:200");
    expect(result.map((c) => c.action.id)).toHaveLength(2);
  });

  it("promotes a higher-scored mainland expand over a boat primary (the opening stall)", () => {
    const boat = ranked("boat:294181:16", "boat", 33, {
      metadata: { targetID: null },
    });
    const expand = ranked("expand:terra-nullius:35", "attack", 100, {
      metadata: { expansion: true },
    });
    const result = promoteArgmaxPrimary([boat, expand]);
    expect(result[0]!.action.id).toBe("expand:terra-nullius:35");
  });

  it("never displaces a deliberate combat primary with a different combat action", () => {
    const chosen = ranked("attack:TARGET1:25", "attack", 88, {
      metadata: { targetID: "TARGET1" },
    });
    const other = ranked("attack:TARGET2:25", "attack", 95, {
      metadata: { targetID: "TARGET2" },
    });
    const result = promoteArgmaxPrimary([chosen, other]);
    expect(result[0]!.action.id).toBe("attack:TARGET1:25");
  });

  it("never promotes diplomacy or social riders (uncalibrated cross-module scores)", () => {
    const expand = ranked("expand:terra-nullius:10", "attack", 40, {
      metadata: { expansion: true },
    });
    const ally = ranked("alliance:RIV", "alliance_request", 100);
    const chat = ranked("quick_chat:hello", "quick_chat", 90);
    const result = promoteArgmaxPrimary([expand, ally, chat]);
    expect(result[0]!.action.id).toBe("expand:terra-nullius:10");
  });

  it("requires a strictly higher score and keeps ties on the primary", () => {
    const expand = ranked("expand:terra-nullius:10", "attack", 50, {
      metadata: { expansion: true },
    });
    const build = ranked("build:City:100", "build", 50);
    expect(promoteArgmaxPrimary([expand, build])[0]!.action.id).toBe(
      "expand:terra-nullius:10",
    );
  });
});

function visibleRival(over: Partial<AgentVisiblePlayer>): AgentVisiblePlayer {
  return {
    playerID: "ENEMY",
    clientID: "ENEMY",
    smallID: 9,
    name: "Enemy",
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 550_000,
    maxTroops: 900_000,
    troopRatio: 0.6,
    gold: "1000",
    tilesOwned: 5_000,
    tileShare: 0.5,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Hostile,
    canAttack: true,
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: true,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 0.9,
    ...over,
  };
}

function invasionObservation(
  over: Partial<AgentObservation> = {},
): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "WAR",
    turnNumber: 4800,
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
      troops: 500_000,
      maxTroops: 800_000,
      troopRatio: 0.6,
      gold: "1000",
      tilesOwned: 90_000,
      tileShare: 0.42,
      borderTiles: 300,
      outgoingAttacks: 0,
      incomingAttacks: 1,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    visiblePlayers: [visibleRival({})],
    combat: {
      ...base.combat,
      incomingAttackPlayerIDs: ["ENEMY"],
      borderedPlayerIDs: ["ENEMY"],
      attackablePlayerIDs: ["ENEMY"],
      ownTroops: 500_000,
    },
    memory: {
      ...base.memory,
      recentActions: [
        {
          sequence: 1,
          actionID: "hold",
          actionKind: "hold",
          reason: "hold",
          accepted: true,
          ownTiles: 100_000, // current 90,000 => 10% recent loss
        },
      ],
    },
    ...over,
  };
}

function strike(
  id: string,
  targetID: string,
  relativeTroopRatio: number,
  troopPercent: number,
  penalties: string[] = [],
): Ranked {
  return ranked(
    id,
    "attack",
    60,
    {
      risk: { level: "high", score: 0.7 },
      metadata: { targetID, relativeTroopRatio, troopPercent },
    },
    penalties,
  );
}

describe("war mode (PROXYWAR_TUNE_WAR_MODE)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
    }
  });
  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) {
        delete process.env[flag];
      } else {
        process.env[flag] = saved[flag]!;
      }
    }
  });

  it("flag OFF (default): no targets, no counterstrike", () => {
    delete process.env.PROXYWAR_TUNE_WAR_MODE;
    const observation = invasionObservation();
    expect(warModeInvaderIDs(observation).size).toBe(0);
    expect(
      warModeCounterstrikeCandidate(
        { observation, legalActions: [] },
        [strike("attack:ENEMY:25", "ENEMY", 0.9, 25)],
      ),
    ).toBeUndefined();
  });

  it("invasion regime: authorizes a 0.9-ratio high-risk strike on the invader", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    const observation = invasionObservation();
    expect([...warModeInvaderIDs(observation)]).toEqual(["ENEMY"]);
    const picked = warModeCounterstrikeCandidate(
      { observation, legalActions: [] },
      [
        strike("attack:ENEMY:10", "ENEMY", 0.9, 10),
        strike("attack:ENEMY:40", "ENEMY", 0.9, 40),
        strike("attack:OTHER:40", "OTHER", 2.0, 40),
      ],
    );
    // Highest troop commitment on the INVADER — never the juicier bystander.
    expect(picked?.action.id).toBe("attack:ENEMY:40");
  });

  it("invasion regime: still refuses below the ratio floor and on reserve-suicide", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    const observation = invasionObservation();
    expect(
      warModeCounterstrikeCandidate({ observation, legalActions: [] }, [
        strike("attack:ENEMY:40", "ENEMY", 0.7, 40),
      ]),
    ).toBeUndefined();
    expect(
      warModeCounterstrikeCandidate({ observation, legalActions: [] }, [
        strike("attack:ENEMY:40", "ENEMY", 0.9, 40, [
          "attack would deplete the reserve below competitive defense",
        ]),
      ]),
    ).toBeUndefined();
  });

  it("no tile loss => invasion regime stays closed (incoming alone is not war)", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    const observation = invasionObservation({
      // Two bordered rivals so the duel regime cannot open either; shares small.
      visiblePlayers: [
        visibleRival({ tileShare: 0.1 }),
        visibleRival({ playerID: "OTHER", clientID: "OTHER", name: "Other", tileShare: 0.1 }),
      ],
    });
    observation.memory.recentActions = [
      {
        sequence: 1,
        actionID: "hold",
        actionKind: "hold",
        reason: "hold",
        accepted: true,
        ownTiles: 90_000, // no loss vs current 90,000
      },
    ];
    expect(warModeInvaderIDs(observation).size).toBe(0);
  });

  it("duel regime: one bordered rival at >= our share and dominant combined share is a target without any incoming attack", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    const observation = invasionObservation({
      combat: {
        ...invasionObservation().combat,
        incomingAttackPlayerIDs: [],
      },
    });
    // own 0.42 + rival 0.5 = 0.92 combined, rival leads.
    expect([...warModeInvaderIDs(observation)]).toEqual(["ENEMY"]);
  });

  it("duel regime closed with two bordered rivals", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    const observation = invasionObservation({
      combat: {
        ...invasionObservation().combat,
        incomingAttackPlayerIDs: [],
      },
      visiblePlayers: [
        visibleRival({}),
        visibleRival({ playerID: "OTHER", clientID: "OTHER", name: "Other" }),
      ],
    });
    expect(warModeInvaderIDs(observation).size).toBe(0);
  });
});

describe("economy bootstrap min-tiles (PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
    }
  });
  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) {
        delete process.env[flag];
      } else {
        process.env[flag] = saved[flag]!;
      }
    }
  });

  const noCityObservation = (): AgentObservation => {
    const base = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Keystone",
      profile: "aggressive",
      gameID: "BOOT",
      turnNumber: 400,
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
        troops: 500_000,
        maxTroops: 800_000,
        troopRatio: 0.6,
        gold: "200000",
        tilesOwned: 12_000,
        tileShare: 0.3,
        borderTiles: 100,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
    };
  };

  const actions = (): LegalAction[] => [
    {
      id: "expand:terra-nullius:10",
      kind: "attack",
      label: "Expand",
      intent: { type: "attack", targetID: null, troops: 100 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true },
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

  const decide = async (observation: AgentObservation) => {
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation, legalActions: actions() },
      null,
    );
    return new FrontierPolicyExecutor("aggressive").decide(
      { observation, legalActions: actions() },
      planned.plan,
    );
  };

  it("bootstrap sleeps below the tile threshold (land grab keeps the decision)", async () => {
    process.env.PROXYWAR_TUNE_ECONOMY_BOOTSTRAP = "1";
    process.env.PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES = "15000";
    const decision = await decide(noCityObservation()); // 12,000 tiles < 15,000
    expect(decision.actionID).not.toBe("build:City:100");
  });

  it("bootstrap resumes past the threshold (default 0 preserves shipped behavior)", async () => {
    process.env.PROXYWAR_TUNE_ECONOMY_BOOTSTRAP = "1";
    process.env.PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES = "10000";
    const above = await decide(noCityObservation()); // 12,000 >= 10,000
    expect(above.actionID).toBe("build:City:100");
    delete process.env.PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES;
    const defaulted = await decide(noCityObservation());
    expect(defaulted.actionID).toBe("build:City:100");
  });
});
