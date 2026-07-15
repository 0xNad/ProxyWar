import { describe, expect, it } from "vitest";

import {
  KEYSTONE_DEFENSE_AUTHORITY_MARKER,
  KEYSTONE_SURVIVAL_SHIELD_MARKER,
  KeystoneSurvivalShieldExecutor,
} from "../../coworld-adapter/src/keystone-survival-shield";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentExecutionDecision,
  AgentExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
  RecentAgentDecision,
} from "../../src/server/agents/AgentTypes";

function action(
  id: string,
  kind: LegalActionKind,
  metadata: LegalAction["metadata"] = {},
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: "low", score: 0.2 },
    metadata,
  };
}

function aggressor(
  playerID = "ENEMY",
  overrides: Partial<AgentVisiblePlayer> = {},
): AgentVisiblePlayer {
  return {
    playerID,
    clientID: null,
    smallID: 2,
    name: playerID,
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 60_000,
    maxTroops: 100_000,
    troopRatio: 0.6,
    gold: "100000",
    tilesOwned: 60,
    tileShare: 0.25,
    sharesBorder: true,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Hostile,
    canAttack: true,
    canRequestAlliance: true,
    canDonateGold: true,
    canDonateTroops: true,
    canEmbargo: true,
    hasEmbargoAgainst: false,
    outgoingAttack: true,
    incomingAttack: true,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.25,
    ...overrides,
  };
}

function input(args: {
  actions: LegalAction[];
  players?: AgentVisiblePlayer[];
  turn?: number;
  defensePriority?: boolean;
  threatRatio?: number;
  recentDecisions?: RecentAgentDecision[];
  conversionReady?: boolean;
  finishRecommended?: boolean;
  finishTargetID?: string;
  finishActionID?: string;
}): AgentBrainInput {
  const players = args.players ?? [];
  const turn = args.turn ?? 2_000;
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "SURVIVAL-SHIELD-GAME",
    turnNumber: turn,
    phaseOverride: "active",
  });
  return {
    observation: {
      ...base,
      ownState: {
        playerID: "ME",
        clientID: null,
        smallID: 1,
        name: "Keystone",
        type: PlayerType.Nation,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        gold: "250000",
        tilesOwned: 8_000,
        tileShare: 0.08,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: players.filter((candidate) => candidate.incomingAttack)
          .length,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        team: null,
      },
      visiblePlayers: players,
      strategic: {
        ...base.strategic,
        ...(args.defensePriority === true
          ? { priority: "build_defense" as const, urgency: "high" as const }
          : {}),
      },
      combat: {
        ...base.combat,
        canExpandIntoNeutral: true,
        incomingAttackPlayerIDs: players
          .filter((candidate) => candidate.incomingAttack)
          .map((candidate) => candidate.playerID),
        incomingAttacks:
          args.threatRatio === undefined || players[0] === undefined
            ? []
            : [
                {
                  attackID: "incoming:1",
                  targetID: players[0].playerID,
                  targetName: players[0].name,
                  troops: Math.round(75_000 * args.threatRatio),
                  retreating: false,
                  sourceTile: null,
                  borderSize: 10,
                },
              ],
      },
      tacticalAffordances: {
        ...base.tacticalAffordances!,
        frontierConversionTiming: {
          ...base.tacticalAffordances!.frontierConversionTiming!,
          incomingThreatRatio: args.threatRatio ?? 0,
          ...(args.conversionReady === undefined
            ? {}
            : { executorReady: args.conversionReady }),
        },
        frontierFinishPressure: {
          ...base.tacticalAffordances!.frontierFinishPressure!,
          ...(args.finishRecommended === undefined
            ? {}
            : { recommended: args.finishRecommended }),
          ...(args.finishTargetID === undefined
            ? {}
            : { bestTargetID: args.finishTargetID }),
          ...(args.finishActionID === undefined
            ? {}
            : { bestAttackID: args.finishActionID }),
        },
      },
      recentDecisions: args.recentDecisions ?? [],
    },
    legalActions: args.actions,
  };
}

const plan: StrategicPlan = {
  planID: "survival-plan",
  objective: "expand_territory",
  targetPlayerId: null,
  rationale: "fixture",
  startedAtTick: 1_500,
  maxDecisionCycles: 3,
  successCriteria: [],
  failureCriteria: [],
  preferredActionKinds: ["attack", "build"],
  forbiddenActionKinds: [],
  plannerSource: "real-llm",
};

function decision(actionID: string): AgentExecutionDecision {
  return Object.freeze({
    actionID,
    actionIDs: [actionID],
    reason: `delegate selected ${actionID}`,
    planFollowed: true,
    executorSource: "frontier-policy-executor",
    actionSelectionSource: "local-policy-executor",
  });
}

function shield(
  selectedActionID: string,
  defenseAuthorityEnabled = false,
): KeystoneSurvivalShieldExecutor {
  const delegate: AgentExecutor = {
    decide() {
      return decision(selectedActionID);
    },
  };
  return new KeystoneSurvivalShieldExecutor({
    delegate,
    actionFollowsCanonicalPlan: () => false,
    defenseAuthorityEnabled,
  });
}

describe("Keystone survival shield", () => {
  it("preserves a no-edge campaign outside verified cross-target collapse", () => {
    const attack = action("attack:RIVAL:25", "attack", {
      targetID: "RIVAL",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(attack.id, true).decide(
      input({
        actions: [attack, hold],
        players: [
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 1.1,
          }),
        ],
        defensePriority: true,
        conversionReady: false,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected).toEqual(decision(attack.id));
  });

  it("preserves counters against the current aggressor", () => {
    const counter = action("attack:ENEMY:25", "attack", {
      targetID: "ENEMY",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(counter.id, true).decide(
      input({
        actions: [counter, hold],
        players: [aggressor("ENEMY", { relativeTroopRatio: 1.1 })],
        defensePriority: true,
        conversionReady: false,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected).toEqual(decision(counter.id));
  });

  it("preserves a current-aggressor counter across the collapse boundaries", () => {
    const counter = action("attack:ENEMY:25", "attack", {
      targetID: "ENEMY",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(counter.id, true).decide(
      input({
        actions: [counter, hold],
        players: [aggressor("ENEMY", { relativeTroopRatio: 1.1 })],
        defensePriority: true,
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before counter boundary fixture",
            accepted: true,
            ownTiles: 9_000,
          },
        ],
        conversionReady: false,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected).toEqual(decision(counter.id));
  });

  it.each([
    ["conversion-ready", true, false, 1.1],
    ["finish-ready", false, true, 1.1],
    ["strength-edge", false, false, 1.25],
  ])(
    "preserves a hostile campaign with a %s edge",
    (_label, conversionReady, finishRecommended, relativeTroopRatio) => {
      const attack = action("attack:RIVAL:25", "attack", {
        targetID: "RIVAL",
        troopPercent: 25,
      });
      const hold = action("hold:wait", "hold");
      const selected = shield(attack.id, true).decide(
        input({
          actions: [attack, hold],
          players: [
            aggressor("RIVAL", {
              incomingAttack: false,
              outgoingAttack: false,
              relativeTroopRatio,
            }),
          ],
          defensePriority: true,
          conversionReady,
          finishRecommended,
        }),
        plan,
      );

      expect(selected).toEqual(decision(attack.id));
    },
  );

  it("preempts a different conquest during verified cross-target collapse", () => {
    const attack = action("attack:RIVAL:25", "attack", {
      targetID: "RIVAL",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(attack.id, true).decide(
      input({
        actions: [attack, hold],
        players: [
          aggressor("INVADER", { relativeTroopRatio: 1.4 }),
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 2.1,
          }),
        ],
        defensePriority: true,
        threatRatio: 0.1,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before cross-target collapse",
            accepted: true,
            ownTiles: 8_700,
          },
        ],
        conversionReady: true,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected).toMatchObject({
      actionID: hold.id,
      actionIDs: [hold.id],
      actionSelectionSource: "keystone-defense-authority:reserve",
    });
    expect(selected.reason).toContain(KEYSTONE_DEFENSE_AUTHORITY_MARKER);
    expect(selected.reason).toContain("cross_target_collapse_preempted");
    expect(selected.reason).toContain(`preempted=${attack.id}`);
  });

  it("preempts a forbidden side attack selected during cross-target collapse", () => {
    const attack = action("attack:RIVAL:10", "attack", {
      targetID: "RIVAL",
      troopPercent: 10,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(attack.id, true).decide(
      input({
        actions: [attack, hold],
        players: [
          aggressor("INVADER"),
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 1.2,
          }),
        ],
        defensePriority: true,
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before forbidden side attack",
            accepted: true,
            ownTiles: 9_000,
          },
        ],
        conversionReady: false,
        finishRecommended: false,
      }),
      { ...plan, forbiddenActionKinds: ["attack"] },
    );

    expect(selected.actionID).toBe(hold.id);
    expect(selected.actionIDs).toEqual([hold.id]);
    expect(selected.reason).toContain(KEYSTONE_DEFENSE_AUTHORITY_MARKER);
    expect(selected.reason).toContain("cross_target_collapse_preempted");
    expect(selected.reason).toContain(`preempted=${attack.id}`);
  });

  it("retreats only the preempted campaign when several retreats are offered", () => {
    const attack = action("attack:RIVAL:25", "attack", {
      targetID: "RIVAL",
      troopPercent: 25,
    });
    const rivalRetreat = action("retreat:rival-campaign", "retreat", {
      targetID: "RIVAL",
    });
    const otherRetreat = action("retreat:other-campaign", "retreat", {
      targetID: "OTHER",
    });
    const invaderCounter = action("attack:INVADER:25", "attack", {
      targetID: "INVADER",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(attack.id, true).decide(
      input({
        actions: [attack, rivalRetreat, otherRetreat, invaderCounter, hold],
        players: [
          aggressor("INVADER", { relativeTroopRatio: 1.4 }),
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 2.1,
          }),
          aggressor("OTHER", {
            incomingAttack: false,
            outgoingAttack: false,
          }),
        ],
        defensePriority: true,
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before multi-retreat fixture",
            accepted: true,
            ownTiles: 9_000,
          },
        ],
        conversionReady: true,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected.actionID).toBe(rivalRetreat.id);
    expect(selected.actionIDs).toEqual([rivalRetreat.id]);
    expect(selected.reason).toContain("cross_target_collapse_preempted");
  });

  it("holds reserves when the preempted campaign has ambiguous retreats", () => {
    const attack = action("attack:RIVAL:25", "attack", {
      targetID: "RIVAL",
      troopPercent: 25,
    });
    const rivalRetreatA = action("retreat:rival-campaign-a", "retreat", {
      targetID: "RIVAL",
    });
    const rivalRetreatB = action("retreat:rival-campaign-b", "retreat", {
      targetID: "RIVAL",
    });
    const invaderCounter = action("attack:INVADER:25", "attack", {
      targetID: "INVADER",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const selected = shield(attack.id, true).decide(
      input({
        actions: [attack, rivalRetreatA, rivalRetreatB, invaderCounter, hold],
        players: [
          aggressor("INVADER", { relativeTroopRatio: 1.4 }),
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 2.1,
          }),
        ],
        defensePriority: true,
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before ambiguous retreat fixture",
            accepted: true,
            ownTiles: 9_000,
          },
        ],
        conversionReady: true,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected.actionID).toBe(hold.id);
    expect(selected.actionIDs).toEqual([hold.id]);
    expect(selected.reason).toContain("cross_target_collapse_preempted");
  });

  it.each([
    ["incoming pressure is below 10%", 0.099, 8_700, true],
    ["accepted tile loss is below 8%", 0.1, 8_695, true],
    ["the high-water decision was rejected", 0.1, 9_000, false],
  ])(
    "preserves a strong side campaign when %s",
    (_label, threatRatio, priorTiles, accepted) => {
      const attack = action("attack:RIVAL:25", "attack", {
        targetID: "RIVAL",
        troopPercent: 25,
      });
      const hold = action("hold:wait", "hold");
      const selected = shield(attack.id, true).decide(
        input({
          actions: [attack, hold],
          players: [
            aggressor("INVADER"),
            aggressor("RIVAL", {
              incomingAttack: false,
              outgoingAttack: false,
              relativeTroopRatio: 2.1,
            }),
          ],
          defensePriority: true,
          threatRatio,
          recentDecisions: [
            {
              sequence: 1,
              actionID: "build:Factory:1",
              actionKind: "build",
              reason: "cross-target boundary fixture",
              accepted,
              ownTiles: priorTiles,
            },
          ],
          conversionReady: true,
          finishRecommended: false,
        }),
        plan,
      );

      expect(selected).toEqual(decision(attack.id));
    },
  );

  it("preserves only the exact canonical finish during cross-target collapse", () => {
    const attack = action("attack:RIVAL:25", "attack", {
      targetID: "RIVAL",
      troopPercent: 25,
    });
    const hold = action("hold:wait", "hold");
    const collapseInput = (finishActionID: string) =>
      input({
        actions: [attack, hold],
        players: [
          aggressor("INVADER"),
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 2.1,
          }),
        ],
        defensePriority: true,
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before exact finish",
            accepted: true,
            ownTiles: 9_000,
          },
        ],
        conversionReady: true,
        finishRecommended: true,
        finishTargetID: "RIVAL",
        finishActionID,
      });

    expect(
      shield(attack.id, true).decide(collapseInput(attack.id), plan),
    ).toEqual(decision(attack.id));
    const unrelatedFinish = shield(attack.id, true).decide(
      collapseInput("attack:RIVAL:40"),
      plan,
    );
    expect(unrelatedFinish.actionID).toBe(hold.id);
    expect(unrelatedFinish.reason).toContain("cross_target_collapse_preempted");
  });

  it("does not revive the moderate Defense Post treatment", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const selected = shield(factory.id, true).decide(
      input({
        actions: [factory, defense],
        players: [aggressor()],
        defensePriority: true,
        threatRatio: 0.269,
        conversionReady: false,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected).toEqual(decision(factory.id));
  });

  it("fails closed and exposes a defense-authority infrastructure error", () => {
    const attack = action("attack:RIVAL:25", "attack", {
      targetID: "RIVAL",
      troopPercent: 25,
    });
    const selected = shield(attack.id, true).decide(
      input({
        actions: [attack],
        players: [
          aggressor("INVADER"),
          aggressor("RIVAL", {
            incomingAttack: false,
            outgoingAttack: false,
            relativeTroopRatio: 2.1,
          }),
        ],
        defensePriority: true,
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "build:Factory:1",
            actionKind: "build",
            reason: "accepted before fail-closed fixture",
            accepted: true,
            ownTiles: 9_000,
          },
        ],
        conversionReady: true,
        finishRecommended: false,
      }),
      plan,
    );

    expect(selected.actionID).toBe(attack.id);
    expect(selected.reason).toContain(KEYSTONE_DEFENSE_AUTHORITY_MARKER);
    expect(selected.reason).toContain("infrastructure_error");
  });

  it("leaves calm v16 decisions exactly unchanged", () => {
    const expand = action("expand:neutral:35", "attack", {
      expansion: true,
      targetID: null,
      troopPercent: 35,
    });
    const executor = shield(expand.id);

    expect(executor.decide(input({ actions: [expand] }), plan)).toEqual(
      decision(expand.id),
    );
  });

  it("preempts stale expansion with an exact offered retreat under pressure", () => {
    const expand = action("expand:neutral:35", "attack", {
      expansion: true,
      targetID: null,
      troopPercent: 35,
    });
    const retreat = action("retreat:land", "retreat", {
      targetID: "ENEMY",
    });
    const selected = shield(expand.id).decide(
      input({
        actions: [expand, retreat],
        players: [aggressor()],
        threatRatio: 0.5,
      }),
      plan,
    );

    expect(selected).toMatchObject({
      actionID: retreat.id,
      actionIDs: [retreat.id],
      executorSource: "keystone-survival-shield",
      actionSelectionSource: "keystone-survival-shield:survival",
    });
    expect(selected.reason).toContain(KEYSTONE_SURVIVAL_SHIELD_MARKER);
    expect(selected.reason).toContain("survival_preempted");
  });

  it("delegates the failed 26.9% moderate Defense Post treatment", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
      defensiveValue: 0.9,
      hostileBorderDistance: 4,
    });
    const selected = shield(factory.id).decide(
      input({
        actions: [factory, defense],
        players: [aggressor()],
        defensePriority: true,
        threatRatio: 0.269,
      }),
      plan,
    );

    expect(selected).toEqual(decision(factory.id));
  });

  it("delegates two low-volume attackers until pressure becomes severe", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const current = input({
      actions: [factory, defense],
      players: [aggressor(), aggressor("OTHER")],
      threatRatio: 0.04,
    });
    current.observation.combat.incomingAttacks!.push({
      attackID: "incoming:2",
      targetID: "OTHER",
      targetName: "OTHER",
      troops: 3_000,
      retreating: false,
      sourceTile: null,
      borderSize: 10,
    });

    expect(shield(factory.id).decide(current, plan)).toEqual(
      decision(factory.id),
    );
  });

  it("uses only a bounded canonical counter against the observed aggressor", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const counter = action("attack:ENEMY:40", "attack", {
      targetID: "ENEMY",
      troopPercent: 40,
    });
    const other = action("attack:OTHER:40", "attack", {
      targetID: "OTHER",
      troopPercent: 40,
    });
    const selected = shield(factory.id).decide(
      input({
        actions: [factory, counter, other],
        players: [aggressor(), aggressor("OTHER", { incomingAttack: false })],
        threatRatio: 0.5,
      }),
      plan,
    );

    expect(selected.actionID).toBe(counter.id);
    expect(selected.actionIDs).toEqual([counter.id]);
  });

  it("uses accepted recent territory loss to rescue a moderate-pressure collapse", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const counter = action("attack:ENEMY:25", "attack", {
      targetID: "ENEMY",
      troopPercent: 25,
    });
    const selected = shield(factory.id).decide(
      input({
        actions: [factory, counter],
        players: [aggressor()],
        threatRatio: 0.199,
        recentDecisions: [
          {
            sequence: 1,
            actionID: "expand:neutral:35",
            actionKind: "attack",
            reason: "accepted before collapse",
            accepted: true,
            ownTiles: 57_000,
            expansion: true,
          },
        ],
      }),
      plan,
    );

    expect(selected).toMatchObject({
      actionID: counter.id,
      actionIDs: [counter.id],
      actionSelectionSource: "keystone-survival-shield:survival",
    });
  });

  it("marks exposure when v16 already chose the survival action", () => {
    const retreat = action("retreat:land", "retreat", {
      targetID: "ENEMY",
    });
    const selected = shield(retreat.id).decide(
      input({
        actions: [retreat],
        players: [aggressor()],
        threatRatio: 0.5,
      }),
      plan,
    );

    expect(selected.actionID).toBe(retreat.id);
    expect(selected.reason).toContain("survival_confirmed");
    expect(selected.actionSelectionSource).toBe(
      "keystone-survival-shield:survival_confirmed",
    );
  });

  it("does not abandon an unrelated campaign for a tiny un-escalated probe", () => {
    const attack = action("attack:OTHER:40", "attack", {
      targetID: "OTHER",
      troopPercent: 40,
    });
    const retreat = action("retreat:OTHER", "retreat", {
      targetID: "OTHER",
    });
    const selected = shield(attack.id).decide(
      input({
        actions: [attack, retreat],
        players: [aggressor(), aggressor("OTHER", { incomingAttack: false })],
        threatRatio: 0.01,
      }),
      plan,
    );

    expect(selected).toEqual(decision(attack.id));
  });

  it("rate-limits defensive builds and rotates into a bounded counter", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const counter = action("attack:ENEMY:25", "attack", {
      targetID: "ENEMY",
      troopPercent: 25,
    });
    const selected = shield(factory.id).decide(
      input({
        actions: [factory, defense, counter],
        players: [aggressor()],
        defensePriority: true,
        threatRatio: 0.5,
        recentDecisions: [
          {
            sequence: 1,
            actionID: defense.id,
            actionKind: "build",
            reason: "prior shield build",
            accepted: true,
            unit: "Defense Post",
          },
        ],
      }),
      plan,
    );

    expect(selected.actionID).toBe(counter.id);
  });

  it("delegates moderate pressure during the defensive-build cooldown", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const counter = action("attack:ENEMY:25", "attack", {
      targetID: "ENEMY",
      troopPercent: 25,
    });
    const selected = shield(factory.id).decide(
      input({
        actions: [factory, defense, counter],
        players: [aggressor()],
        threatRatio: 0.2,
        recentDecisions: [
          {
            sequence: 1,
            actionID: defense.id,
            actionKind: "build",
            reason: "prior shield build",
            accepted: true,
            unit: "Defense Post",
          },
        ],
      }),
      plan,
    );

    expect(selected).toEqual(decision(factory.id));
  });

  it("ignores retreating-only pressure", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const current = input({
      actions: [factory, defense],
      players: [aggressor()],
      threatRatio: 0.5,
    });
    current.observation.combat.incomingAttacks![0]!.retreating = true;

    expect(shield(factory.id).decide(current, plan)).toEqual(
      decision(factory.id),
    );
  });

  it("preserves an authoritative hostile attack even under severe pressure", () => {
    const attack = action("attack:OTHER:40", "attack", {
      targetID: "OTHER",
      troopPercent: 40,
    });
    const defense = action("build:Defense Post:11", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const selected = shield(attack.id).decide(
      input({
        actions: [attack, defense],
        players: [aggressor(), aggressor("OTHER", { incomingAttack: false })],
        threatRatio: 0.5,
      }),
      plan,
    );

    expect(selected).toEqual(decision(attack.id));
  });

  it("rejects SAM and generic border-only placements for land-pressure preemption", () => {
    const factory = action("build:Factory:10", "build", {
      unit: "Factory",
      role: "economic",
    });
    const sam = action("build:SAM Launcher:11", "build", {
      unit: "SAM Launcher",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const borderOnly = action("build:Defense Post:12", "build", {
      unit: "Defense Post",
      role: "defensive",
      defensiveValue: 0.9,
      hostileBorderDistance: 2,
    });
    const selected = shield(factory.id).decide(
      input({
        actions: [factory, sam, borderOnly],
        players: [aggressor()],
        threatRatio: 0.2,
      }),
      plan,
    );

    expect(selected).toEqual(decision(factory.id));
  });

  it("fails closed to v16 and makes malformed treatment state visible", () => {
    const malformed = action("", "hold");
    const selected = shield(malformed.id).decide(
      input({ actions: [malformed], players: [aggressor()] }),
      plan,
    );

    expect(selected.actionID).toBe("");
    expect(selected.reason).toContain("infrastructure_error");
    expect(selected.reason).toContain(KEYSTONE_SURVIVAL_SHIELD_MARKER);
  });
});
