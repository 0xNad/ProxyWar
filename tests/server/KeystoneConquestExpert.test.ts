import { describe, expect, it } from "vitest";

import {
  buildKeystoneWorldModel,
  computeKeystoneBidBP,
  proposeKeystoneConquest,
} from "../../coworld-adapter/src/keystone-experts";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentBrainInput,
  AgentGamePhase,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

function action(
  id: string,
  kind: LegalActionKind,
  targetPlayerID: string | null = null,
  riskScore = 0.1,
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: {
      level:
        riskScore === 0
          ? "none"
          : riskScore >= 0.75
            ? "high"
            : riskScore >= 0.5
              ? "medium"
              : "low",
      score: riskScore,
    },
    metadata: targetPlayerID === null ? {} : { targetID: targetPlayerID },
  };
}

function neutral(id = "expand:neutral:35"): LegalAction {
  return {
    ...action(id, "attack"),
    metadata: {
      targetID: null,
      targetType: "neutral",
      expansion: true,
      troopPercent: 35,
    },
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

function brainInput(args: {
  actions: LegalAction[];
  players?: AgentVisiblePlayer[];
  ownTeam?: string | null;
  phase?: AgentGamePhase;
  turnNumber?: number;
}): AgentBrainInput {
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "CONQUEST-EXPERT",
    turnNumber: args.turnNumber ?? 1_500,
    phaseOverride: args.phase ?? "active",
  });
  const players = args.players ?? [];
  return {
    observation: {
      ...base,
      gameMode: (args.ownTeam ?? null) === null ? "FFA" : "Team",
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
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        team: args.ownTeam ?? null,
      },
      visiblePlayers: players,
      combat: {
        ...base.combat,
        ownTroops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        borderedPlayerIDs: players
          .filter((candidate) => candidate.sharesBorder)
          .map((candidate) => candidate.playerID),
        attackablePlayerIDs: players
          .filter((candidate) => candidate.canAttack)
          .map((candidate) => candidate.playerID),
        incomingAttackPlayerIDs: players
          .filter((candidate) => candidate.incomingAttack)
          .map((candidate) => candidate.playerID),
        canExpandIntoNeutral: args.actions.some(
          (candidate) => candidate.metadata?.expansion === true,
        ),
      },
    },
    legalActions: args.actions,
  };
}

function world(args: Parameters<typeof brainInput>[0]) {
  return buildKeystoneWorldModel(brainInput(args));
}

describe("Keystone Conquest expert", () => {
  it("proposes only a centrally owned hostile conquest action", () => {
    const model = world({
      actions: [
        action("build:city", "build"),
        action("alliance:enemy", "alliance_request", "ENEMY"),
        action("hostile:land:exact", "attack", "ENEMY"),
        action("hold", "hold", null, 0),
      ],
      players: [player("ENEMY")],
    });

    expect(proposeKeystoneConquest(model)).toMatchObject({
      source: "conquest",
      actionID: "hostile:land:exact",
      commitmentKey: "conquest:target:ENEMY",
      horizonDecisions: 3,
    });
  });

  it("excludes allied, friendly, teammate, same-team, and self targets", () => {
    const model = world({
      actions: [
        action("attack:ally", "attack", "ALLY"),
        action("attack:friendly", "attack", "FRIEND"),
        action("attack:teammate", "attack", "TEAMMATE"),
        action("attack:same-team", "attack", "SAME_TEAM"),
        action("attack:self", "attack", "ME"),
      ],
      players: [
        player("ALLY", { isAllied: true }),
        player("FRIEND", { isFriendly: true }),
        player("TEAMMATE", { isTeammate: true }),
        player("SAME_TEAM", { team: "blue" }),
      ],
      ownTeam: "blue",
    });

    expect(proposeKeystoneConquest(model)).toBeNull();
  });

  it("leaves an observed-aggressor counter to the survival tier", () => {
    const model = world({
      actions: [action("counter:aggressor", "attack", "AGGRESSOR")],
      players: [player("AGGRESSOR", { incomingAttack: true })],
    });

    expect(model.actions[0]?.actionOwner).toBe("survival");
    expect(proposeKeystoneConquest(model)).toBeNull();
  });

  it("excludes neutral expansion and targetless malformed hostile actions", () => {
    const model = world({
      actions: [
        neutral(),
        action("malformed:attack", "attack"),
        action("malformed:boat", "boat"),
        action("malformed:nuke", "nuke"),
      ],
    });

    expect(proposeKeystoneConquest(model)).toBeNull();
  });

  it("excludes forbidden conquest actions and dead targets", () => {
    const forbidden = buildKeystoneWorldModel(
      brainInput({
        actions: [action("attack:forbidden", "attack", "ENEMY")],
        players: [player("ENEMY")],
      }),
      { forbiddenActionKinds: ["attack"] },
    );
    const dead = world({
      actions: [action("attack:dead", "attack", "DEAD")],
      players: [player("DEAD", { isAlive: false })],
    });

    expect(proposeKeystoneConquest(forbidden)).toBeNull();
    expect(proposeKeystoneConquest(dead)).toBeNull();
  });

  it("prefers a weak bordered target over stronger or remote targets", () => {
    const model = world({
      actions: [
        action("attack:strong-border", "attack", "STRONG_BORDER"),
        action("attack:weak-remote", "attack", "WEAK_REMOTE"),
        action("attack:weak-border", "attack", "WEAK_BORDER"),
      ],
      players: [
        player("STRONG_BORDER", {
          relativeTroopRatio: 0.9,
          tileShare: 0.3,
        }),
        player("WEAK_REMOTE", {
          relativeTroopRatio: 2,
          tileShare: 0.2,
          sharesBorder: false,
        }),
        player("WEAK_BORDER", {
          relativeTroopRatio: 1.8,
          tileShare: 0.1,
        }),
      ],
    });

    expect(proposeKeystoneConquest(model)?.actionID).toBe("attack:weak-border");
  });

  it("prefers hostile land over a comparable hostile boat", () => {
    const model = world({
      actions: [
        action("boat:enemy", "boat", "ENEMY", 0.1),
        action("attack:enemy", "attack", "ENEMY", 0.1),
      ],
      players: [player("ENEMY")],
    });

    expect(proposeKeystoneConquest(model)?.actionID).toBe("attack:enemy");
  });

  it("uses the risk-adjusted common bid for naval and nuclear options", () => {
    const justified = world({
      actions: [
        action("warship:port:7", "warship", null, 0.1),
        action("move-warship:9", "move_warship", null, 0.1),
        action("nuke:enemy", "nuke", "ENEMY", 0.1),
      ],
      players: [player("ENEMY")],
      turnNumber: 2_400,
    });
    const proposal = proposeKeystoneConquest(justified);

    expect(proposal).not.toBeNull();
    expect(computeKeystoneBidBP(proposal!, proposal!.riskBP)).toBeGreaterThan(
      0,
    );

    const unjustified = world({
      actions: [action("warship:unsafe", "warship", null, 1)],
      turnNumber: 100,
    });
    expect(proposeKeystoneConquest(unjustified)).toBeNull();
  });

  it("is order invariant with deterministic telemetry and tie-breaking", () => {
    const actions = [
      action("attack:z", "attack", "ZED"),
      action("attack:alpha", "attack", "ALPHA"),
      action("boat:alpha", "boat", "ALPHA"),
    ];
    const players = [
      player("ZED", { relativeTroopRatio: 1.4, tileShare: 0.15 }),
      player("ALPHA", { relativeTroopRatio: 1.4, tileShare: 0.15 }),
    ];

    const forward = proposeKeystoneConquest(world({ actions, players }));
    const reversed = proposeKeystoneConquest(
      world({
        actions: [...actions].reverse(),
        players: [...players].reverse(),
      }),
    );

    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({
      actionID: "attack:alpha",
      proposalID: "conquest:attack:attack:alpha",
      rationale:
        "conquest attack; target=ALPHA border=1 relativeBP=14000 shareBP=1500 riskBP=1000",
      commitmentKey: "conquest:target:ALPHA",
    });
  });

  it("emits bounded integer basis-point components and the exact offered id", () => {
    const exactID = "attack:offered/%:17";
    const proposal = proposeKeystoneConquest(
      world({
        actions: [action(exactID, "attack", "ENEMY", 0.3333)],
        players: [
          player("ENEMY", {
            relativeTroopRatio: 99,
            tileShare: 4,
          }),
        ],
        turnNumber: 99_999,
      }),
    );

    expect(proposal?.actionID).toBe(exactID);
    for (const value of [
      proposal?.expectedValueBP,
      proposal?.urgencyBP,
      proposal?.confidenceBP,
      proposal?.riskBP,
      proposal?.opportunityCostBP,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10_000);
    }
  });

  it("does not mutate the shared world model or its action and player arrays", () => {
    const model = world({
      actions: [
        action("attack:b", "attack", "B"),
        action("attack:a", "attack", "A"),
      ],
      players: [player("B"), player("A")],
    });
    const before = JSON.stringify(model);

    proposeKeystoneConquest(model);

    expect(JSON.stringify(model)).toBe(before);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.actions)).toBe(true);
    expect(Object.isFrozen(model.players)).toBe(true);
  });

  it("abstains outside active play and without an own-state anchor", () => {
    expect(
      proposeKeystoneConquest(
        world({
          actions: [action("attack:enemy", "attack", "ENEMY")],
          players: [player("ENEMY")],
          phase: "spawn",
        }),
      ),
    ).toBeNull();

    const model = world({
      actions: [action("attack:enemy", "attack", "ENEMY")],
      players: [player("ENEMY")],
    });
    expect(
      proposeKeystoneConquest(Object.freeze({ ...model, own: null })),
    ).toBeNull();
  });
});
