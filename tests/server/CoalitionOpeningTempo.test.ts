import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  coalitionAllianceAcceptCandidate,
  coalitionRunawayLeader,
  FrontierPolicyExecutor,
  LlmAgentPlanner,
  PlannerExecutorAgentBrain,
  promoteArgmaxPrimary,
  RuleAgentPlanner,
  warModeCounterstrikeCandidate,
} from "../../src/server/agents/AgentPlannerExecutor";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { LlmProvider } from "../../src/server/agents/LlmProvider";

/**
 * Keystone v8 (operator directive 2026-07-12: coalition/"gang up on the leader",
 * opening tempo, attack ladder). Core discovery pinned here: alliances form on
 * MUTUAL request — sending alliance_request to a player with a pending incoming
 * request IS the acceptance (PlayerImpl.canSendAllianceRequest returns true for
 * exactly this case) — and no league policy prioritized the counter-request, so
 * agent-agent alliances never formed.
 */

type Ranked = Parameters<typeof promoteArgmaxPrimary>[0][number];

const FLAGS = [
  "PROXYWAR_TUNE_COALITION",
  "PROXYWAR_TUNE_OPENING_TEMPO",
  "PROXYWAR_TUNE_ATTACK_LADDER",
  "PROXYWAR_TUNE_WAR_MODE",
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
      risk: { level: "medium", score: 0.3 },
      ...over,
    },
    totalScore,
    policy: { totalScore, contributions: [], penalties: [] },
    skill: undefined,
    primaryModule: "expansion",
    schedulerSlot: "neutral_expansion",
  } as unknown as Ranked;
}

function rival(over: Partial<AgentVisiblePlayer>): AgentVisiblePlayer {
  return {
    playerID: "RIV",
    clientID: "RIV",
    smallID: 9,
    name: "Rival",
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 300_000,
    maxTroops: 900_000,
    troopRatio: 0.4,
    gold: "1000",
    tilesOwned: 3_000,
    tileShare: 0.1,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: true,
    canRequestAlliance: true,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.5,
    ...over,
  };
}

function coalitionObservation(
  visiblePlayers: AgentVisiblePlayer[],
  over: Partial<AgentObservation> = {},
  turnNumber = 2500,
): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "COAL",
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
      troopRatio: 0.65,
      gold: "1000",
      tilesOwned: 50_000,
      tileShare: 0.25,
      borderTiles: 200,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    visiblePlayers,
    ...over,
  };
}

const leader = () =>
  rival({
    playerID: "LEADER",
    clientID: "LEADER",
    name: "Odin",
    tileShare: 0.4,
    troops: 900_000,
  });
const minor = (over: Partial<AgentVisiblePlayer> = {}) =>
  rival({
    playerID: "MINOR",
    clientID: "MINOR",
    name: "James",
    tileShare: 0.08,
    ...over,
  });

describe("coalition (PROXYWAR_TUNE_COALITION)", () => {
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

  it("flag OFF (default): no leader detected", () => {
    delete process.env.PROXYWAR_TUNE_COALITION;
    expect(
      coalitionRunawayLeader(coalitionObservation([leader(), minor()])),
    ).toBeNull();
  });

  it("detects the runaway leader; never when we lead; never an ally", () => {
    process.env.PROXYWAR_TUNE_COALITION = "1";
    const detected = coalitionRunawayLeader(
      coalitionObservation([leader(), minor()]),
    );
    expect(detected).toMatchObject({ playerID: "LEADER", tileShare: 0.4 });
    // We lead (own 0.25 vs rival 0.26 < 1.15x) -> no coalition regime.
    expect(
      coalitionRunawayLeader(
        coalitionObservation([rival({ playerID: "R2", tileShare: 0.26 })]),
      ),
    ).toBeNull();
    // The big player is our ALLY -> betray-late owns that, not the coalition.
    expect(
      coalitionRunawayLeader(
        coalitionObservation([
          rival({
            playerID: "ALLY",
            tileShare: 0.4,
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
          }),
          minor(),
        ]),
      ),
    ).toBeNull();
  });

  it("accepts a pending alliance request from a non-leader (counter-request = accept)", () => {
    process.env.PROXYWAR_TUNE_COALITION = "1";
    const observation = coalitionObservation([
      leader(),
      minor({ hasIncomingAllianceRequest: true }),
    ]);
    const picked = coalitionAllianceAcceptCandidate(
      { observation, legalActions: [] },
      [
        // Real LegalActionBuilder alliance_request shape: metadata.recipientID.
        ranked("alliance:MINOR", "alliance_request", 40, {
          metadata: { recipientID: "MINOR", recipientName: "James" },
        }),
        ranked("alliance:LEADER", "alliance_request", 90, {
          metadata: { recipientID: "LEADER", recipientName: "Odin" },
        }),
        ranked("expand:terra-nullius:10", "attack", 100, {
          metadata: { expansion: true },
        }),
      ],
    );
    // The MINOR's request is accepted; the LEADER is never courted.
    expect(picked?.action.id).toBe("alliance:MINOR");
  });

  it("no pending request, or requestor is the leader: no forced accept", () => {
    process.env.PROXYWAR_TUNE_COALITION = "1";
    expect(
      coalitionAllianceAcceptCandidate(
        { observation: coalitionObservation([leader(), minor()]), legalActions: [] },
        [ranked("alliance:MINOR", "alliance_request", 40, { metadata: { targetID: "MINOR" } })],
      ),
    ).toBeUndefined();
  });

  it("Commander prompt gains the COALITION MODE block exactly when the regime holds", async () => {
    process.env.PROXYWAR_TUNE_COALITION = "1";
    // t2500 with a neutral expand offered = land grab live -> the block must
    // forbid starting ANY war (leader included) and must never court the leader.
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "build_alliance",
          turnIntent: "diplomacy",
          rationale: "coalition",
          maxDecisionCycles: 2,
          preferredActionKinds: ["alliance_request", "hold"],
          enabledModules: ["diplomacy", "defense", "economy"],
          targetPlayerId: null,
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.15,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 4,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
      planEveryDecisionSteps: 3,
    });
    await brain.decide({
      observation: coalitionObservation([leader(), minor()]),
      legalActions: [
        {
          id: "expand:terra-nullius:10",
          kind: "attack",
          label: "Expand",
          intent: { type: "attack", targetID: null, troops: 100 },
          risk: { level: "low", score: 0.1 },
          metadata: { expansion: true },
        },
        {
          id: "hold",
          kind: "hold",
          label: "Hold",
          intent: null,
          risk: { level: "none", score: 0 },
        },
      ],
    });
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0]).toContain("COALITION MODE — RUNAWAY LEADER: Odin");
    expect(prompts[0]).toContain("IS the acceptance");
    expect(prompts[0]).toContain("NEVER request an alliance with the leader");
    // Land grab live (t2500 + neutral offered): war on ANYONE is forbidden.
    expect(prompts[0]).toContain("do NOT start a war now");
    expect(prompts[0]).not.toContain("at the leader (LEADER) only");
    // Coalition suppresses the dominance window outright.
    expect(prompts[0]).not.toContain("DOMINANCE WINDOW");
  });

  it("after the land grab, the block aims all pressure at the leader", async () => {
    process.env.PROXYWAR_TUNE_COALITION = "1";
    const prompts: string[] = [];
    const provider: LlmProvider = {
      providerType: "codex-cli",
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return JSON.stringify({
          objective: "pressure_rival",
          turnIntent: "pressure",
          rationale: "contain the leader",
          maxDecisionCycles: 1,
          preferredActionKinds: ["attack", "hold"],
          enabledModules: ["combat", "defense", "economy"],
          targetPlayerId: "LEADER",
          tacticalSettings: {
            reserveRatio: 0.35,
            triggerRatio: 0.55,
            expansionRatio: 0.15,
            maxConcurrentWars: 1,
            retreatThreshold: 0.35,
            maxActionsPerDecision: 4,
          },
        });
      },
    };
    const brain = new PlannerExecutorAgentBrain({
      profile: "aggressive",
      planner: new LlmAgentPlanner({
        provider,
        profile: "aggressive",
        plannerType: "codex-cli",
      }),
      executor: new FrontierPolicyExecutor("aggressive"),
      planEveryDecisionSteps: 3,
    });
    // t4000, no neutral growth offered: the pressure directive applies.
    await brain.decide({
      observation: coalitionObservation([leader(), minor()], {}, 4000),
      legalActions: [
        {
          id: "attack:LEADER:25",
          kind: "attack",
          label: "Attack Odin with 25%",
          intent: { type: "attack", targetID: "LEADER", troops: 100_000 },
          risk: { level: "medium", score: 0.3 },
          metadata: { targetID: "LEADER", sharesBorder: true },
        },
        {
          id: "hold",
          kind: "hold",
          label: "Hold",
          intent: null,
          risk: { level: "none", score: 0 },
        },
      ],
    });
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0]).toContain("at the leader (LEADER) only");
    expect(prompts[0]).not.toContain("do NOT start a war now");
  });
});

describe("opening tempo (PROXYWAR_TUNE_OPENING_TEMPO)", () => {
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
      gameID: "TEMPO",
      turnNumber: 1000,
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
        troops: 400_000,
        maxTroops: 800_000,
        troopRatio: 0.5,
        gold: "50000",
        tilesOwned: 8_000,
        tileShare: 0.2,
        borderTiles: 90,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
    };
  };

  const openingActions = (): LegalAction[] => [
    {
      id: "expand:terra-nullius:20",
      kind: "attack",
      label: "Expand into neutral land",
      intent: { type: "attack", targetID: null, troops: 80_000 },
      risk: { level: "low", score: 0.1 },
      metadata: { expansion: true },
    },
    {
      id: "boat:1234:16",
      kind: "boat",
      label: "Send 16% transport to Terra Nullius",
      intent: { type: "boat", troops: 64_000, dst: 1234 },
      risk: { level: "low", score: 0.2 },
      metadata: {},
    },
    {
      id: "hold",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "none", score: 0 },
    },
  ];

  it("flag ON: mainland expand is the wire primary in the opening (boat demoted)", async () => {
    process.env.PROXYWAR_TUNE_OPENING_TEMPO = "1";
    const planned = await new RuleAgentPlanner("aggressive").plan(
      { observation: openingObservation(), legalActions: openingActions() },
      null,
    );
    const decision = new FrontierPolicyExecutor("aggressive").decide(
      { observation: openingObservation(), legalActions: openingActions() },
      planned.plan,
    );
    expect(decision.actionID).toBe("expand:terra-nullius:20");
  });
});

describe("attack ladder (PROXYWAR_TUNE_ATTACK_LADDER, via war-mode strikes)", () => {
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

  const invasion = (recentAttacksOnEnemy: number): AgentObservation => {
    const base = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Keystone",
      profile: "aggressive",
      gameID: "LADDER",
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
      visiblePlayers: [
        rival({
          playerID: "ENEMY",
          clientID: "ENEMY",
          name: "Enemy",
          tileShare: 0.5,
          troops: 550_000,
          relativeTroopRatio: 0.9,
          outgoingAttack: true,
        }),
      ],
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
            sequence: 0,
            actionID: "hold",
            actionKind: "hold",
            reason: "hold",
            accepted: true,
            ownTiles: 100_000,
          },
          ...Array.from({ length: recentAttacksOnEnemy }, (_, i) => ({
            sequence: i + 1,
            actionID: `attack:ENEMY:25`,
            actionKind: "attack" as const,
            reason: "strike",
            accepted: true,
            ownTiles: 95_000,
            targetID: "ENEMY",
          })),
        ],
      },
    };
  };

  const strikes = (): Ranked[] =>
    [10, 25, 40].map((pc) =>
      ranked(`attack:ENEMY:${pc}`, "attack", 60, {
        risk: { level: "high", score: 0.7 },
        metadata: { targetID: "ENEMY", relativeTroopRatio: 0.9, troopPercent: pc },
      }),
    );

  it("ladder never applies to an ACTIVE INVADER: max-commit defense regardless of flag", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    process.env.PROXYWAR_TUNE_ATTACK_LADDER = "1";
    // ENEMY is in incomingAttackPlayerIDs — answering a 40% invasion with a
    // 10% probe is under-defense (v8 A/B games 1-2 fast collapses).
    expect(
      warModeCounterstrikeCandidate(
        { observation: invasion(0), legalActions: [] },
        strikes(),
      )?.action.id,
    ).toBe("attack:ENEMY:40");
  });

  const duel = (recentAttacksOnEnemy: number): AgentObservation => {
    const base = invasion(recentAttacksOnEnemy);
    return {
      ...base,
      combat: { ...base.combat, incomingAttackPlayerIDs: [] },
    };
  };

  it("ladder ON (duel regime, no incoming): 10% probe first, 25% second, 40% after", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    process.env.PROXYWAR_TUNE_ATTACK_LADDER = "1";
    expect(
      warModeCounterstrikeCandidate(
        { observation: duel(0), legalActions: [] },
        strikes(),
      )?.action.id,
    ).toBe("attack:ENEMY:10");
    expect(
      warModeCounterstrikeCandidate(
        { observation: duel(1), legalActions: [] },
        strikes(),
      )?.action.id,
    ).toBe("attack:ENEMY:25");
    expect(
      warModeCounterstrikeCandidate(
        { observation: duel(3), legalActions: [] },
        strikes(),
      )?.action.id,
    ).toBe("attack:ENEMY:40");
  });

  it("ladder OFF: war mode keeps its max-commitment preference", () => {
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    delete process.env.PROXYWAR_TUNE_ATTACK_LADDER;
    expect(
      warModeCounterstrikeCandidate(
        { observation: duel(0), legalActions: [] },
        strikes(),
      )?.action.id,
    ).toBe("attack:ENEMY:40");
  });
});
