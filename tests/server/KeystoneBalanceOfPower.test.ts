import { describe, expect, it, vi } from "vitest";

import {
  KEYSTONE_BALANCE_OF_POWER_MARKER,
  KeystoneBalanceOfPowerExecutor,
} from "../../coworld-adapter/src/keystone-balance-of-power";
import {
  buildKeystoneWorldModel,
  proposeKeystoneConquest,
  proposeKeystonePolitics,
  resolveKeystoneBindingDirective,
} from "../../coworld-adapter/src/keystone-experts";
import { decisionToResponse } from "../../coworld-adapter/src/keystone-player";
import {
  KEYSTONE_SURVIVAL_SHIELD_MARKER,
  KeystoneSurvivalShieldExecutor,
} from "../../coworld-adapter/src/keystone-survival-shield";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentExecutionDecision,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

const plan: StrategicPlan = {
  planID: "balance-plan",
  objective: "pressure_rival",
  targetPlayerId: null,
  rationale: "focused balance-of-power fixture",
  startedAtTick: 0,
  maxDecisionCycles: 6,
  successCriteria: [],
  failureCriteria: [],
  preferredActionKinds: ["attack", "hold"],
  forbiddenActionKinds: [],
  plannerSource: "rule",
};

function action(
  id: string,
  kind: LegalActionKind,
  metadata: LegalAction["metadata"] = {},
  riskScore = 0.1,
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: riskScore === 0 ? "none" : "low", score: riskScore },
    metadata,
  };
}

function attack(
  targetPlayerID: string,
  troopPercent = 35,
  id = `attack:${targetPlayerID}:${troopPercent}`,
): LegalAction {
  return action(id, "attack", { targetID: targetPlayerID, troopPercent });
}

function hold(): LegalAction {
  return action("hold:wait", "hold", {}, 0);
}

function power(
  playerID: string,
  tileShare: number,
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
    troops: 50_000,
    maxTroops: 100_000,
    troopRatio: 0.5,
    gold: "100000",
    tilesOwned: Math.round(tileShare * 10_000),
    tileShare,
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
    relativeTroopRatio: 1.2,
    team: null,
    ...overrides,
  };
}

function defaultPowers(): AgentVisiblePlayer[] {
  return [power("LEADER", 0.34), power("BUFFER", 0.25), power("MINOR", 0.21)];
}

function input(args: {
  actions: LegalAction[];
  turn?: number;
  tick?: number | null;
  gameID?: string;
  gameMode?: "FFA" | "Team";
  ownShare?: number;
  ownTeam?: string | null;
  players?: AgentVisiblePlayer[];
  threatRatio?: number;
  reportedLeaderID?: string | null;
}): AgentBrainInput {
  const turn = args.turn ?? 2_000;
  const players = args.players ?? defaultPowers();
  const ownShare = args.ownShare ?? 0.2;
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: args.gameID ?? "BALANCE-GAME",
    turnNumber: turn,
    phaseOverride: "active",
  });
  const aggressor = players.find((candidate) => candidate.incomingAttack);
  return {
    observation: {
      ...base,
      gameMode: args.gameMode ?? "FFA",
      turnNumber: turn,
      tick: args.tick === undefined ? turn : args.tick,
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
        tilesOwned: Math.round(ownShare * 10_000),
        tileShare: ownShare,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: aggressor === undefined ? 0 : 1,
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
        incomingAttackPlayerIDs:
          aggressor === undefined ? [] : [aggressor.playerID],
        incomingAttacks:
          aggressor === undefined || args.threatRatio === undefined
            ? []
            : [
                {
                  attackID: "incoming:1",
                  targetID: aggressor.playerID,
                  targetName: aggressor.name,
                  troops: Math.round(75_000 * args.threatRatio),
                  retreating: false,
                  sourceTile: null,
                  borderSize: 10,
                },
              ],
        canExpandIntoNeutral: args.actions.some(
          (candidate) => candidate.metadata?.expansion === true,
        ),
      },
      endgame: {
        ...base.endgame!,
        leaderID:
          args.reportedLeaderID === undefined
            ? (base.endgame?.leaderID ?? null)
            : args.reportedLeaderID,
      },
    },
    legalActions: args.actions,
  };
}

function world(
  current: AgentBrainInput,
  overrides: Parameters<typeof buildKeystoneWorldModel>[1] = {},
) {
  return buildKeystoneWorldModel(current, {
    balanceOfPowerEnabled: true,
    ...overrides,
  });
}

function decision(actionID: string): AgentExecutionDecision {
  return Object.freeze({
    actionID,
    actionIDs: [actionID],
    reason: `v40 selected ${actionID}`,
    planFollowed: false,
    executorSource: "frontier-policy-executor",
    actionSelectionSource: "local-policy-executor",
  });
}

function router(
  authoritative: AgentExecutionDecision,
  decide = vi.fn(() => authoritative),
): { executor: KeystoneBalanceOfPowerExecutor; decide: typeof decide } {
  return {
    executor: new KeystoneBalanceOfPowerExecutor({
      delegate: { decide },
      actionFollowsCanonicalPlan: () => false,
    }),
    decide,
  };
}

describe("Keystone Council balance of power", () => {
  it("builds an immutable conservative FFA imbalance snapshot only when enabled", () => {
    const current = input({ actions: [hold()] });
    expect(buildKeystoneWorldModel(current).balanceOfPower).toBeUndefined();

    const balance = world(current).balanceOfPower;
    expect(balance).toEqual({
      leaderPlayerID: "LEADER",
      leaderTileShareBP: 3_400,
      runnerUpPlayerID: "BUFFER",
      runnerUpTileShareBP: 2_500,
      strongestOtherNonLeaderPlayerID: "BUFFER",
      strongestOtherNonLeaderTileShareBP: 2_500,
      ownTileShareBP: 2_000,
      leaderOwnGapBP: 1_400,
      leaderFieldGapBP: 900,
      alivePowerCount: 4,
    });
    expect(Object.isFrozen(balance)).toBe(true);
    expect(
      world(
        input({ actions: [hold()], players: [...defaultPowers()].reverse() }),
      ).balanceOfPower,
    ).toEqual(balance);
  });

  it("fails closed below every activation threshold or on contradictory identity", () => {
    const cases = [
      input({
        actions: [hold()],
        players: [
          power("LEADER", 0.31),
          power("BUFFER", 0.25),
          power("MINOR", 0.24),
        ],
      }),
      input({
        actions: [hold()],
        players: [
          power("LEADER", 0.32),
          power("BUFFER", 0.24),
          power("MINOR", 0.24),
        ],
      }),
      input({
        actions: [hold()],
        players: [power("LEADER", 0.34), power("BUFFER", 0.25)],
      }),
      input({ actions: [hold()], ownShare: 0.4 }),
      input({ actions: [hold()], gameMode: "Team", ownTeam: "blue" }),
      input({ actions: [hold()], reportedLeaderID: "BUFFER" }),
      input({
        actions: [hold()],
        players: [
          power("LEADER", 0.34),
          power("BUFFER", Number.NaN),
          power("MINOR", 0.21),
        ],
      }),
    ];
    for (const current of cases) {
      expect(world(current).balanceOfPower).toBeNull();
    }
  });

  it("preserves valid quick-chat recipient/subject metadata while quarantining conflicting attack identity", () => {
    const chat = action("quick_chat:BUFFER:attack.focus", "quick_chat", {
      recipientID: "BUFFER",
      targetID: "LEADER",
      quickChatKey: "attack.focus",
    });
    const conflictingAttack = action("attack:conflicting", "attack", {
      targetID: "BUFFER",
      recipientID: "MINOR",
      expansion: true,
      troopPercent: 35,
    });
    const current = world(
      input({ actions: [chat, conflictingAttack, hold()] }),
    );

    expect(
      current.actions.find((candidate) => candidate.id === chat.id),
    ).toMatchObject({
      targetPlayerID: "LEADER",
      actionOwner: "politics",
    });
    expect(
      current.actions.find(
        (candidate) => candidate.id === conflictingAttack.id,
      ),
    ).toMatchObject({
      targetPlayerID: null,
      isNeutralExpansion: false,
      actionOwner: null,
    });
  });

  it("lets Conquest target only a safely attackable leader and Politics accept only reactive nonleader cooperation", () => {
    const leaderAttack = attack("LEADER");
    const bufferAttack = attack("BUFFER");
    const reactiveBuffer = action(
      "alliance_request:BUFFER",
      "alliance_request",
      { recipientID: "BUFFER" },
    );
    const leaderRequest = action(
      "alliance_request:LEADER",
      "alliance_request",
      { recipientID: "LEADER" },
    );
    const players = defaultPowers().map((candidate) =>
      candidate.playerID === "BUFFER"
        ? { ...candidate, hasIncomingAllianceRequest: true }
        : candidate,
    );
    const current = world(
      input({
        actions: [
          bufferAttack,
          leaderAttack,
          reactiveBuffer,
          leaderRequest,
          hold(),
        ],
        players,
      }),
    );

    expect(proposeKeystoneConquest(current)?.actionID).toBe(leaderAttack.id);
    expect(proposeKeystoneConquest(current)?.rationale).toContain("leader");
    expect(proposeKeystonePolitics(current)?.actionID).toBe(reactiveBuffer.id);

    const proactive = world(
      input({ actions: [reactiveBuffer, leaderRequest, hold()] }),
    );
    expect(proposeKeystonePolitics(proactive)).toBeNull();
  });

  it("suppresses untargeted naval and nuclear military replacements", () => {
    const naval = action("warship:patrol", "warship");
    const moveNaval = action("move_warship:patrol", "move_warship");
    const leaderNuke = action(
      "nuke:LEADER",
      "nuke",
      { targetID: "LEADER" },
      0.1,
    );
    const players = [
      power("LEADER", 0.36),
      power("BUFFER", 0.25),
      power("MINOR", 0.21),
    ];

    expect(
      proposeKeystoneConquest(
        world(
          input({
            actions: [naval, moveNaval, leaderNuke, hold()],
            ownShare: 0.18,
            players,
          }),
        ),
      ),
    ).toBeNull();
  });

  it("carves every attack and proactive-alliance Commander binding out of the active Council", () => {
    const bufferAttack = attack("BUFFER", 35);
    const leaderAttack = attack("LEADER", 35);
    const requestBuffer = action(
      "alliance_request:BUFFER",
      "alliance_request",
      { recipientID: "BUFFER" },
    );
    const players = defaultPowers().map((candidate) =>
      candidate.playerID === "BUFFER"
        ? { ...candidate, hasIncomingAllianceRequest: true }
        : candidate,
    );
    const current = input({
      actions: [bufferAttack, leaderAttack, requestBuffer, hold()],
      players,
    });

    expect(
      resolveKeystoneBindingDirective(
        world(current, {
          commander: {
            planID: "buffer-order",
            binding: {
              kind: "attack_target",
              domain: "conquest",
              targetPlayerID: "BUFFER",
              minCommitmentBP: 3_500,
            },
          },
        }),
      ).status,
    ).toBe("unavailable");
    expect(
      resolveKeystoneBindingDirective(
        world(current, {
          commander: {
            planID: "leader-order",
            binding: {
              kind: "attack_target",
              domain: "conquest",
              targetPlayerID: "LEADER",
              minCommitmentBP: 3_500,
            },
          },
        }),
      ).status,
    ).toBe("unavailable");
    expect(
      resolveKeystoneBindingDirective(
        world(
          input({
            actions: [requestBuffer, hold()],
          }),
          {
            commander: {
              planID: "proactive-request",
              binding: {
                kind: "alliance",
                domain: "politics",
                stance: "seek_alliance",
                targetPlayerID: "BUFFER",
              },
            },
          },
        ),
      ).status,
    ).toBe("unavailable");
  });

  it("requires two distinct stable observations and redirects only v40's exact strongest-other attack", () => {
    const bufferAttack = attack("BUFFER");
    const leaderAttack = attack("LEADER");
    const authoritative = decision(bufferAttack.id);
    const { executor, decide } = router(authoritative);
    const first = input({
      actions: [bufferAttack, leaderAttack, hold()],
      turn: 100,
    });

    expect(executor.decide(first, plan)).toBe(authoritative);
    expect(executor.decide(first, plan)).toBe(authoritative);

    const replaced = executor.decide(
      input({ actions: [bufferAttack, leaderAttack, hold()], turn: 101 }),
      plan,
    );
    expect(replaced).toMatchObject({
      actionID: leaderAttack.id,
      actionIDs: [leaderAttack.id],
      executorSource: "keystone-balance-of-power",
      actionSelectionSource: "keystone-balance-of-power:conquest",
    });
    expect(replaced.reason).toContain(
      `[${KEYSTONE_BALANCE_OF_POWER_MARKER} leader_attack_redirected`,
    );
    expect(replaced.reason).toContain(`original=${bufferAttack.id}`);
    expect(replaced.reason).toContain(`replacement=${leaderAttack.id}`);
    expect(replaced.reason).toContain(
      "offered_original=1 offered_replacement=1",
    );
    expect(replaced.reason.length).toBeLessThan(500);
    const wire = decisionToResponse("req_balance", {
      actionID: replaced.actionID,
      reason: `${replaced.reason} ${"x".repeat(1_000)}`,
    });
    expect(String(wire.reason)).toMatch(
      /^\[keystone-balance-of-power:v1 leader_attack_redirected/,
    );
    expect(String(wire.reason).length).toBeLessThanOrEqual(500);
    expect(decide).toHaveBeenCalledTimes(3);
  });

  it("never protects the strongest other while it is currently attacking us", () => {
    const bufferAttack = attack("BUFFER", 25);
    const authoritative = decision(bufferAttack.id);
    const { executor } = router(authoritative);
    const players = defaultPowers().map((candidate) =>
      candidate.playerID === "BUFFER"
        ? { ...candidate, incomingAttack: true }
        : candidate,
    );
    const actions = [bufferAttack, attack("LEADER"), hold()];

    expect(executor.decide(input({ actions, players, turn: 100 }), plan)).toBe(
      authoritative,
    );
    expect(executor.decide(input({ actions, players, turn: 101 }), plan)).toBe(
      authoritative,
    );
  });

  it("returns exact v40 for stable non-buffer decisions and resets on a leader change", () => {
    const selectedMinor = attack("MINOR");
    const authoritative = decision(selectedMinor.id);
    const { executor } = router(authoritative);
    const actions = [selectedMinor, attack("LEADER"), attack("BUFFER"), hold()];

    expect(executor.decide(input({ actions, turn: 100 }), plan)).toBe(
      authoritative,
    );
    expect(executor.decide(input({ actions, turn: 101 }), plan)).toBe(
      authoritative,
    );

    const changedPowers = [
      power("BUFFER", 0.35),
      power("LEADER", 0.24),
      power("MINOR", 0.21),
    ];
    expect(
      executor.decide(
        input({ actions, turn: 102, players: changedPowers }),
        plan,
      ),
    ).toBe(authoritative);
  });

  it("marks a stable exact buffer trigger when no unique safe replacement exists", () => {
    const bufferAttack = attack("BUFFER");
    const duplicateLeader = attack("LEADER");
    const authoritative = decision(bufferAttack.id);
    const { executor } = router(authoritative);
    const actions = [bufferAttack, duplicateLeader, { ...duplicateLeader }];

    expect(executor.decide(input({ actions, turn: 100 }), plan)).toBe(
      authoritative,
    );
    const unchanged = executor.decide(input({ actions, turn: 101 }), plan);

    expect(unchanged.actionID).toBe(authoritative.actionID);
    expect(unchanged.reason).toContain(
      `[${KEYSTONE_BALANCE_OF_POWER_MARKER} no_safe_replacement`,
    );
    expect(unchanged.reason).toContain(`original=${bufferAttack.id}`);
    expect(unchanged.reason.length).toBeLessThanOrEqual(500);
  });

  it("marks infrastructure failures without changing the v40 action", () => {
    const bufferAttack = attack("BUFFER");
    const authoritative = decision(bufferAttack.id);
    const executor = new KeystoneBalanceOfPowerExecutor({
      delegate: { decide: () => authoritative },
      actionFollowsCanonicalPlan: () => {
        throw new Error("alignment fixture failed");
      },
    });

    const failed = executor.decide(
      input({ actions: [bufferAttack, attack("LEADER"), hold()] }),
      plan,
    );
    expect(failed.actionID).toBe(authoritative.actionID);
    expect(failed.reason).toContain(
      `[${KEYSTONE_BALANCE_OF_POWER_MARKER} infrastructure_error stage=world`,
    );
    expect(failed.actionSelectionSource).toBe(
      "keystone-balance-of-power:infrastructure_error",
    );
    expect(failed.reason.length).toBeLessThanOrEqual(500);
  });

  it("suppresses a nonleader survival counter internally while the outer severe shield still wins", () => {
    const bufferAttack = attack("BUFFER", 25);
    const minorCounter = attack("MINOR", 25);
    const authoritative = decision(bufferAttack.id);
    const { executor: balance } = router(authoritative);
    const shield = new KeystoneSurvivalShieldExecutor({
      delegate: balance,
      actionFollowsCanonicalPlan: () => false,
    });
    const players = defaultPowers().map((candidate) =>
      candidate.playerID === "MINOR"
        ? { ...candidate, incomingAttack: true }
        : candidate,
    );

    const first = input({
      actions: [bufferAttack, minorCounter, hold()],
      turn: 100,
      players,
      threatRatio: 0.5,
    });
    expect(shield.decide(first, plan).actionID).toBe(bufferAttack.id);

    const second = shield.decide(
      input({
        actions: [bufferAttack, minorCounter, hold()],
        turn: 101,
        players,
        threatRatio: 0.5,
      }),
      plan,
    );
    expect(second.actionID).toBe(minorCounter.id);
    expect(second.reason).toContain(KEYSTONE_SURVIVAL_SHIELD_MARKER);
    expect(second.reason).toContain(
      `[${KEYSTONE_BALANCE_OF_POWER_MARKER} buffer_attack_preempted`,
    );
    expect(second.actionSelectionSource).toBe(
      "keystone-survival-shield:survival",
    );
  });
});
