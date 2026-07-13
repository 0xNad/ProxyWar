import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  promoteArgmaxPrimary,
  StrategicPlan,
  thinPlanExecutionCandidate,
} from "../../src/server/agents/AgentPlannerExecutor";
import {
  AgentObservation,
  LegalAction,
} from "../../src/server/agents/AgentTypes";

/**
 * Thin executor (PROXYWAR_TUNE_THIN_EXECUTOR, keystone v11): the Commander's
 * named intent executes with minimal reinterpretation. Five A/B cycles showed
 * mechanical parity with the league leader while the thick heuristic cascade
 * still lost every mid-game; his architecture executes the plan's named
 * action+target directly.
 */

type Ranked = Parameters<typeof promoteArgmaxPrimary>[0][number];

const FLAGS = [
  "PROXYWAR_TUNE_THIN_EXECUTOR",
  "PROXYWAR_TUNE_ATTACK_LADDER",
] as const;

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

function observation(): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "THIN",
    turnNumber: 3500,
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
      tilesOwned: 60_000,
      tileShare: 0.3,
      borderTiles: 200,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    },
    combat: { ...base.combat, ownTroops: 500_000, incomingAttackPlayerIDs: [] },
  };
}

function plan(
  turnIntent: StrategicPlan["turnIntent"],
  targetPlayerId: string | null,
): StrategicPlan {
  return {
    planID: "thin-test",
    objective: turnIntent === "pressure" ? "pressure_rival" : "expand_territory",
    turnIntent,
    targetPlayerId,
    rationale: "test",
    startedAtTick: 0,
    maxDecisionCycles: 3,
    successCriteria: [],
    failureCriteria: [],
    preferredActionKinds: ["attack", "hold"],
    forbiddenActionKinds: [],
    enabledModules: ["combat", "expansion", "defense"],
    plannerSource: "rule",
  } as unknown as StrategicPlan;
}

const strike = (pc: number, penalties: string[] = []): Ranked =>
  ranked(`attack:TARGET:${pc}`, "attack", 50, {
    risk: { level: "high", score: 0.7 },
    metadata: { targetID: "TARGET", relativeTroopRatio: 0.9, troopPercent: pc },
  }, penalties);

describe("thin executor (PROXYWAR_TUNE_THIN_EXECUTOR)", () => {
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

  it("flag OFF (default): always undefined", () => {
    delete process.env.PROXYWAR_TUNE_THIN_EXECUTOR;
    expect(
      thinPlanExecutionCandidate(
        { observation: observation(), legalActions: [] },
        plan("pressure", "TARGET"),
        [strike(40)],
      ),
    ).toBeUndefined();
  });

  it("pressure + target: executes the best qualifying attack on THAT target, ignoring higher-scored detours", () => {
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    const picked = thinPlanExecutionCandidate(
      { observation: observation(), legalActions: [] },
      plan("pressure", "TARGET"),
      [
        ranked("expand:terra-nullius:35", "attack", 100, {
          metadata: { expansion: true },
        }),
        ranked("attack:OTHER:40", "attack", 95, {
          metadata: { targetID: "OTHER", relativeTroopRatio: 2, troopPercent: 40 },
        }),
        strike(25),
        strike(40),
      ],
    );
    expect(picked?.action.id).toBe("attack:TARGET:40");
  });

  it("pressure guards hold: ratio floor and reserve-suicide penalty still refuse", () => {
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    expect(
      thinPlanExecutionCandidate(
        { observation: observation(), legalActions: [] },
        plan("pressure", "TARGET"),
        [
          ranked("attack:TARGET:40", "attack", 50, {
            metadata: { targetID: "TARGET", relativeTroopRatio: 0.5, troopPercent: 40 },
          }),
        ],
      ),
    ).toBeUndefined();
    expect(
      thinPlanExecutionCandidate(
        { observation: observation(), legalActions: [] },
        plan("pressure", "TARGET"),
        [strike(40, ["attack would deplete the reserve below competitive defense"])],
      ),
    ).toBeUndefined();
  });

  it("growth: executes the best mainland expand; no expand offered falls through", () => {
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    const picked = thinPlanExecutionCandidate(
      { observation: observation(), legalActions: [] },
      plan("growth", null),
      [
        ranked("boat:99:16", "boat", 90),
        ranked("expand:terra-nullius:20", "attack", 40, {
          metadata: { expansion: true },
        }),
      ],
    );
    expect(picked?.action.id).toBe("expand:terra-nullius:20");
    expect(
      thinPlanExecutionCandidate(
        { observation: observation(), legalActions: [] },
        plan("growth", null),
        [ranked("boat:99:16", "boat", 90)],
      ),
    ).toBeUndefined();
  });

  it("stands down during an active invasion (war-mode defense stays reachable)", () => {
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    process.env.PROXYWAR_TUNE_WAR_MODE = "1";
    const base = observation();
    const invaded: AgentObservation = {
      ...base,
      ownState: { ...base.ownState!, tilesOwned: 90_000 },
      combat: { ...base.combat, incomingAttackPlayerIDs: ["RAIDER"] },
      memory: {
        ...base.memory,
        recentActions: [
          {
            sequence: 1,
            actionID: "hold",
            actionKind: "hold",
            reason: "hold",
            accepted: true,
            ownTiles: 100_000, // 10% recent loss => invasion regime live
          },
        ],
      },
    };
    expect(
      thinPlanExecutionCandidate(
        { observation: invaded, legalActions: [] },
        plan("growth", null),
        [
          ranked("expand:terra-nullius:20", "attack", 40, {
            metadata: { expansion: true },
          }),
        ],
      ),
    ).toBeUndefined();
    delete process.env.PROXYWAR_TUNE_WAR_MODE;
  });

  it("other intents fall through (build/diplomacy stay with the directives)", () => {
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    expect(
      thinPlanExecutionCandidate(
        { observation: observation(), legalActions: [] },
        plan("build", null),
        [ranked("build:City:100", "build", 100)],
      ),
    ).toBeUndefined();
  });

  it("ladder sizing applies to non-invader pressure targets when armed", () => {
    process.env.PROXYWAR_TUNE_THIN_EXECUTOR = "1";
    process.env.PROXYWAR_TUNE_ATTACK_LADDER = "1";
    const picked = thinPlanExecutionCandidate(
      { observation: observation(), legalActions: [] },
      plan("pressure", "TARGET"),
      [strike(10), strike(25), strike(40)],
    );
    // No recent attacks on TARGET -> 10% probe first.
    expect(picked?.action.id).toBe("attack:TARGET:10");
  });
});
