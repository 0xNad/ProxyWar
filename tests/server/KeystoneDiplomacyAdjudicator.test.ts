import { describe, expect, it } from "vitest";

import {
  KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER,
  KeystoneDiplomacyAdjudicatorExecutor,
} from "../../coworld-adapter/src/keystone-diplomacy-adjudicator";
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

function player(
  playerID: string,
  overrides: Partial<AgentVisiblePlayer> = {},
): AgentVisiblePlayer {
  return {
    playerID,
    clientID: null,
    smallID: playerID.charCodeAt(0),
    name: playerID,
    type: PlayerType.Human,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 40_000,
    maxTroops: 80_000,
    troopRatio: 0.5,
    gold: "100000",
    tilesOwned: 50,
    tileShare: 0.2,
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
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    relativeTroopRatio: 1.25,
    ...overrides,
  };
}

function input(args: {
  turn: number;
  actions: LegalAction[];
  players?: AgentVisiblePlayer[];
  recentDecisions?: RecentAgentDecision[];
  gameID?: string;
  backstabTargetID?: string;
  canExpandIntoNeutral?: boolean;
}): AgentBrainInput {
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: args.gameID ?? "DTA-GAME",
    turnNumber: args.turn,
    phaseOverride: "active",
  });
  const players = args.players ?? [];
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
        tilesOwned: 80,
        tileShare: 0.3,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: players.filter((candidate) => candidate.incomingAttack)
          .length,
        outgoingAllianceRequests: players.filter(
          (candidate) => candidate.hasOutgoingAllianceRequest,
        ).length,
        incomingAllianceRequests: players.filter(
          (candidate) => candidate.hasIncomingAllianceRequest,
        ).length,
        team: null,
      },
      visiblePlayers: players,
      combat: {
        ...base.combat,
        canExpandIntoNeutral: args.canExpandIntoNeutral ?? false,
        incomingAttackPlayerIDs: players
          .filter((candidate) => candidate.incomingAttack)
          .map((candidate) => candidate.playerID),
      },
      recentDecisions: args.recentDecisions ?? [],
      ...(args.backstabTargetID === undefined
        ? {}
        : {
            tacticalAffordances: {
              ...base.tacticalAffordances!,
              backstabAlly: {
                tacticID: "backstab_ally" as const,
                recommended: true,
                turnNumber: args.turn,
                backstabTargetID: args.backstabTargetID,
                backstabTargetName: args.backstabTargetID,
                ownTileShare: 0.3,
                reason: "fixture",
              },
            },
          }),
    },
    legalActions: args.actions,
  };
}

const plan: StrategicPlan = {
  planID: "dta-plan",
  objective: "expand_territory",
  targetPlayerId: null,
  rationale: "fixture",
  startedAtTick: 0,
  maxDecisionCycles: 3,
  successCriteria: [],
  failureCriteria: [],
  preferredActionKinds: ["attack", "boat", "build"],
  forbiddenActionKinds: [],
  plannerSource: "real-llm",
};

function authoritative(actionID: string): AgentExecutionDecision {
  return Object.freeze({
    actionID,
    actionIDs: [actionID],
    reason: `delegate selected ${actionID}`,
    planFollowed: false,
    executorSource: "frontier-policy-executor",
    actionSelectionSource: "local-policy-executor",
  });
}

function adjudicator(
  select: (input: AgentBrainInput) => string,
): KeystoneDiplomacyAdjudicatorExecutor {
  const delegate: AgentExecutor = {
    decide(current) {
      return authoritative(select(current));
    },
  };
  return new KeystoneDiplomacyAdjudicatorExecutor({
    delegate,
    actionFollowsCanonicalPlan: () => false,
  });
}

function recentBreak(
  accepted: boolean,
  actionID = "break:ALLY",
): RecentAgentDecision {
  return {
    sequence: 1,
    actionID,
    actionKind: "break_alliance",
    reason: "fixture",
    accepted,
    targetID: "ALLY",
  };
}

describe("Keystone diplomacy adjudicator", () => {
  it("leaves ordinary v16 decisions exactly unchanged", () => {
    const executor = adjudicator(() => "expand:neutral");
    const current = input({
      turn: 500,
      actions: [
        action("expand:neutral", "attack", {
          targetID: null,
          expansion: true,
          troopPercent: 35,
        }),
      ],
      canExpandIntoNeutral: true,
    });
    const expected = authoritative("expand:neutral");

    expect(executor.decide(current, plan)).toEqual(expected);
  });

  it("allows a genuine first or reactive request but marks treatment exposure", () => {
    const request = action("request:RIVAL", "alliance_request", {
      recipientID: "RIVAL",
    });
    const executor = adjudicator(() => request.id);
    const first = executor.decide(
      input({ turn: 500, actions: [request], players: [player("RIVAL")] }),
      plan,
    );
    const reactiveExecutor = adjudicator(() => request.id);
    const reactive = reactiveExecutor.decide(
      input({
        turn: 500,
        actions: [request],
        players: [player("RIVAL", { hasIncomingAllianceRequest: true })],
      }),
      plan,
    );

    expect(first.actionID).toBe(request.id);
    expect(first.reason).toContain(
      `[${KEYSTONE_DIPLOMACY_ADJUDICATOR_MARKER} request_first_allowed]`,
    );
    expect(reactive.reason).toContain("request_reactive_allowed");
  });

  it("replaces an accepted-repeat or currently-pending request with productive expansion", () => {
    const request = action("request:RIVAL", "alliance_request", {
      recipientID: "RIVAL",
    });
    const expand = action("expand:neutral", "attack", {
      targetID: null,
      expansion: true,
      troopPercent: 35,
    });
    const acceptedRequest: RecentAgentDecision = {
      sequence: 1,
      actionID: request.id,
      actionKind: "alliance_request",
      reason: "fixture",
      accepted: true,
      targetID: "RIVAL",
    };
    const repeatExecutor = adjudicator(() => request.id);
    const repeat = repeatExecutor.decide(
      input({
        turn: 700,
        actions: [request, expand],
        players: [player("RIVAL")],
        recentDecisions: [acceptedRequest],
        canExpandIntoNeutral: true,
      }),
      plan,
    );
    const pendingExecutor = adjudicator(() => request.id);
    const pending = pendingExecutor.decide(
      input({
        turn: 700,
        actions: [request, expand],
        players: [player("RIVAL", { hasOutgoingAllianceRequest: true })],
        canExpandIntoNeutral: true,
      }),
      plan,
    );

    expect(repeat).toMatchObject({
      actionID: expand.id,
      actionIDs: [expand.id],
      executorSource: "keystone-diplomacy-adjudicator",
    });
    expect(repeat.reason).toContain("request_repeat_suppressed");
    expect(pending.actionID).toBe(expand.id);
    expect(pending.reason).toContain("request_pending_suppressed");
  });

  it("suppresses an unbacked break instead of consuming a productive turn", () => {
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canAttack: false,
    });
    const breakAction = action("break:ALLY", "break_alliance", {
      targetID: "ALLY",
    });
    const expand = action("expand:neutral", "attack", {
      targetID: null,
      expansion: true,
      troopPercent: 35,
    });
    const executor = adjudicator(() => breakAction.id);
    const selected = executor.decide(
      input({
        turn: 8_000,
        actions: [breakAction, expand],
        players: [ally],
        canExpandIntoNeutral: true,
      }),
      plan,
    );

    expect(selected.actionID).toBe(expand.id);
    expect(selected.reason).toContain("break_unbound_suppressed");
    expect(executor.ledgerSnapshot().macro.state).toBe("idle");
  });

  it("arms only an accepted backed break, then forces safe conquest of the same target", () => {
    const breakAction = action("break:ALLY", "break_alliance", {
      targetID: "ALLY",
    });
    const request = action("request:OTHER", "alliance_request", {
      recipientID: "OTHER",
    });
    const attack = action("attack:ALLY:35", "attack", {
      targetID: "ALLY",
      troopPercent: 35,
    });
    const executor = adjudicator((current) =>
      current.observation.turnNumber === 8_000 ? breakAction.id : request.id,
    );
    const selectedBreak = executor.decide(
      input({
        turn: 8_000,
        actions: [breakAction],
        players: [
          player("ALLY", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
            canAttack: false,
          }),
        ],
        backstabTargetID: "ALLY",
      }),
      plan,
    );
    const selectedAttack = executor.decide(
      input({
        turn: 8_010,
        actions: [request, attack],
        players: [player("ALLY"), player("OTHER")],
        recentDecisions: [recentBreak(true)],
      }),
      plan,
    );

    expect(selectedBreak.actionID).toBe(breakAction.id);
    expect(selectedBreak.reason).toContain("break_bound_pending");
    expect(selectedAttack.actionID).toBe(attack.id);
    expect(selectedAttack.reason).toContain("macro_target_conquest");
    expect(executor.ledgerSnapshot().macro).toMatchObject({
      state: "armed",
      targetPlayerID: "ALLY",
    });
  });

  it("does not create a conquest commitment from a rejected break", () => {
    const breakAction = action("break:ALLY", "break_alliance", {
      targetID: "ALLY",
    });
    const hold = action("hold:wait", "hold");
    const executor = adjudicator((current) =>
      current.observation.turnNumber === 8_000 ? breakAction.id : hold.id,
    );
    executor.decide(
      input({
        turn: 8_000,
        actions: [breakAction],
        players: [
          player("ALLY", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
            canAttack: false,
          }),
        ],
        backstabTargetID: "ALLY",
      }),
      plan,
    );
    const next = executor.decide(
      input({
        turn: 8_010,
        actions: [hold],
        players: [player("ALLY")],
        recentDecisions: [recentBreak(false)],
      }),
      plan,
    );

    expect(next.actionID).toBe(hold.id);
    expect(next.reason).not.toContain("macro_target_conquest");
    expect(executor.ledgerSnapshot().macro.state).toBe("pending");
  });

  it("keeps survival above an armed target-conquest macro", () => {
    const breakAction = action("break:ALLY", "break_alliance", {
      targetID: "ALLY",
    });
    const attack = action("attack:ALLY:35", "attack", {
      targetID: "ALLY",
      troopPercent: 35,
    });
    const retreat = action("retreat:pressure", "retreat", {
      targetID: "ALLY",
    });
    const executor = adjudicator((current) =>
      current.observation.turnNumber === 8_000 ? breakAction.id : attack.id,
    );
    executor.decide(
      input({
        turn: 8_000,
        actions: [breakAction],
        players: [
          player("ALLY", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
            canAttack: false,
          }),
        ],
        backstabTargetID: "ALLY",
      }),
      plan,
    );
    const survival = executor.decide(
      input({
        turn: 8_010,
        actions: [attack, retreat],
        players: [player("ALLY", { incomingAttack: true })],
        recentDecisions: [recentBreak(true)],
      }),
      plan,
    );

    expect(survival.actionID).toBe(retreat.id);
    expect(survival.reason).toContain("macro_survival");
  });

  it("resets a pending transaction on a new game", () => {
    const breakAction = action("break:ALLY", "break_alliance", {
      targetID: "ALLY",
    });
    const hold = action("hold:wait", "hold");
    const executor = adjudicator((current) =>
      current.observation.gameID === "DTA-GAME" ? breakAction.id : hold.id,
    );
    executor.decide(
      input({
        turn: 8_000,
        actions: [breakAction],
        players: [
          player("ALLY", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
            canAttack: false,
          }),
        ],
        backstabTargetID: "ALLY",
      }),
      plan,
    );
    const resetDecision = executor.decide(
      input({
        gameID: "DTA-GAME-B",
        turn: 100,
        actions: [hold],
      }),
      plan,
    );

    expect(resetDecision.actionID).toBe(hold.id);
    expect(executor.ledgerSnapshot()).toMatchObject({
      gameID: "DTA-GAME-B",
      macro: { state: "idle" },
    });
  });

  it("suppresses a second backed break while the first macro is cooling down", () => {
    const breakAlly = action("break:ALLY", "break_alliance", {
      targetID: "ALLY",
    });
    const breakSecond = action("break:SECOND", "break_alliance", {
      targetID: "SECOND",
    });
    const hold = action("hold:wait", "hold");
    const city = action("build:city", "build", {
      unit: "City",
      role: "economic",
    });
    const executor = adjudicator((current) => {
      if (current.observation.turnNumber === 8_000) return breakAlly.id;
      if (current.observation.turnNumber === 8_010) return hold.id;
      return breakSecond.id;
    });
    executor.decide(
      input({
        turn: 8_000,
        actions: [breakAlly],
        players: [
          player("ALLY", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
            canAttack: false,
          }),
        ],
        backstabTargetID: "ALLY",
      }),
      plan,
    );
    const completed = executor.decide(
      input({
        turn: 8_010,
        actions: [hold],
        players: [],
        recentDecisions: [recentBreak(true)],
      }),
      plan,
    );
    const blocked = executor.decide(
      input({
        turn: 8_020,
        actions: [breakSecond, city],
        players: [
          player("SECOND", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
            canAttack: false,
          }),
        ],
        backstabTargetID: "SECOND",
      }),
      plan,
    );

    expect(completed.reason).toContain("macro_target_completed");
    expect(executor.ledgerSnapshot().macro.state).toBe("cooldown");
    expect(blocked.actionID).toBe(city.id);
    expect(blocked.reason).toContain("break_unbound_suppressed");
  });

  it("marks an internal adjudicator failure while preserving the v16 action", () => {
    const expand = action("expand:neutral", "attack", {
      targetID: null,
      expansion: true,
      troopPercent: 35,
    });
    const delegate: AgentExecutor = {
      decide: () => authoritative(expand.id),
    };
    const executor = new KeystoneDiplomacyAdjudicatorExecutor({
      delegate,
      actionFollowsCanonicalPlan: () => {
        throw new Error("injected alignment failure");
      },
    });
    const selected = executor.decide(
      input({
        turn: 500,
        actions: [expand],
        canExpandIntoNeutral: true,
      }),
      plan,
    );

    expect(selected.actionID).toBe(expand.id);
    expect(selected.reason).toContain("infrastructure_error");
    expect(selected.executorSource).toBe("keystone-diplomacy-adjudicator");
  });
});
