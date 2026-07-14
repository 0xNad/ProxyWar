import { describe, expect, it, vi } from "vitest";

import {
  KeystoneSingleActionExecutor,
  type KeystoneActionRanker,
} from "../../coworld-adapter/src/keystone-single-action-executor";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type {
  AgentSettings,
  RankedActionForPrompt,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import { actionFollowsCanonicalPlan } from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

const settings: Partial<AgentSettings> = {
  territoryFirstNeutralLandEnabled: true,
  maxActionsPerDecision: 5,
  siloTileShareRatio: 0.14,
  samTileShareRatio: 0.14,
};

function plan(overrides: Partial<StrategicPlan> = {}): StrategicPlan {
  return {
    planID: "plan-1",
    objective: "pressure_rival",
    targetPlayerId: null,
    rationale: "convert a reachable rival",
    startedAtTick: 0,
    maxDecisionCycles: 3,
    successCriteria: [],
    failureCriteria: [],
    preferredActionKinds: ["attack", "boat", "build", "hold"],
    forbiddenActionKinds: [],
    plannerSource: "real-llm",
    ...overrides,
  };
}

function rival(
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
    troops: 50_000,
    maxTroops: 100_000,
    troopRatio: 0.5,
    gold: "100000",
    tilesOwned: 50,
    tileShare: 0.15,
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
    relativeTroopRatio: 1,
    ...overrides,
  };
}

function input(args: {
  turn: number;
  actions: LegalAction[];
  rivals?: AgentVisiblePlayer[];
  neutral?: boolean;
  troopRatio?: number;
  incoming?: string[];
  gameID?: string;
  tileShare?: number;
  ownStateNull?: boolean;
}): AgentBrainInput {
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: args.gameID ?? "SINGLE-ACTION",
    turnNumber: args.turn,
    phaseOverride: "active",
  });
  const rivals = args.rivals ?? [];
  const ownTroops = 90_000;
  const troopRatio = args.troopRatio ?? 0.6;
  const observation: AgentObservation = {
    ...base,
    alivePlayerCount: 1 + rivals.filter((player) => player.isAlive).length,
    ownState: args.ownStateNull
      ? null
      : {
          playerID: "ME",
          clientID: null,
          smallID: 1,
          name: "Keystone",
          type: PlayerType.Nation,
          isAlive: true,
          isDisconnected: false,
          isTraitor: false,
          hasSpawned: true,
          troops: ownTroops,
          maxTroops: 100_000,
          troopRatio,
          gold: "250000",
          tilesOwned: 30,
          tileShare: args.tileShare ?? 0.1,
          borderTiles: 8,
          outgoingAttacks: 0,
          incomingAttacks: args.incoming?.length ?? 0,
          outgoingAllianceRequests: 0,
          incomingAllianceRequests: 0,
        },
    visiblePlayers: rivals,
    combat: {
      ...base.combat,
      ownTroops,
      maxTroops: 100_000,
      troopRatio,
      borderedPlayerIDs: rivals
        .filter((player) => player.sharesBorder)
        .map((player) => player.playerID),
      attackablePlayerIDs: rivals
        .filter((player) => player.canAttack)
        .map((player) => player.playerID),
      canExpandIntoNeutral: args.neutral ?? false,
      neutralExpansionLegalReason:
        args.neutral === true ? "neutral frontier is reachable" : null,
      incomingAttackPlayerIDs: args.incoming ?? [],
      weakestAttackableTargetID:
        rivals.find((player) => player.canAttack && !player.isAllied)
          ?.playerID ?? null,
    },
  };
  return { observation, legalActions: args.actions };
}

function action(
  id: string,
  kind: LegalActionKind,
  metadata: LegalAction["metadata"] = {},
  risk: LegalAction["risk"] = { level: "low", score: 0.1 },
): LegalAction {
  return { id, kind, label: id, intent: null, risk, metadata };
}

function attack(
  targetID: string,
  ratio = 1,
  targetTileShare = 0.2,
  id = `attack:${targetID}:35`,
): LegalAction {
  return action(id, "attack", {
    targetID,
    relativeTroopRatio: ratio,
    targetTileShare,
    troopPercent: 35,
  });
}

function boat(targetID: string): LegalAction {
  return action(`boat:${targetID}:25`, "boat", {
    targetID,
    relativeTroopRatio: 1,
    navalInvasion: true,
    troopPercent: 25,
  });
}

function neutral(percent: number): LegalAction {
  return action(`expand:terra-nullius:${percent}`, "attack", {
    targetID: null,
    expansion: true,
    troopPercent: percent,
    troopPercentage: percent / 100,
  });
}

const city = action("build:City:10", "build", {
  unit: "City",
  role: "economic",
});
const upgrade = action("upgrade:City:1", "upgrade_structure", {
  unit: "City",
});
const alliance = action("alliance:A", "alliance_request", {
  recipientID: "A",
});
const hold = action("hold", "hold");

function ranked(actions: readonly LegalAction[]): RankedActionForPrompt[] {
  return actions.map((candidate, index) => ({
    id: candidate.id,
    kind: candidate.kind,
    totalScore: 100 - index,
    policyScore: 90 - index,
    skillScore: 50,
    module: "combat",
    schedulerSlot: "combat_attack",
    penalties: [],
    topSkill: "test",
  }));
}

const orderedRanker: KeystoneActionRanker = ({ input: current }) =>
  ranked(current.legalActions);

function executor(rankActions: KeystoneActionRanker = orderedRanker) {
  return new KeystoneSingleActionExecutor({
    profile: "aggressive",
    settings,
    rankActions,
    actionFollowsCanonicalPlan,
  });
}

describe("Keystone Coworld single-action conversion executor", () => {
  it("uses 35% neutral expansion in OPENING and returns exactly one offered id", () => {
    const current = input({
      turn: 400,
      actions: [neutral(10), alliance, neutral(35), hold],
      neutral: true,
    });
    const decision = executor().decide(current, plan());

    expect(decision.actionID).toBe("expand:terra-nullius:35");
    expect(current.legalActions.map((candidate) => candidate.id)).toContain(
      decision.actionID,
    );
    expect(decision.actionIDs).toBeUndefined();
    expect(decision.planFollowed).toBe(false);
    expect(decision.reason).toContain("state=OPENING");
    expect(decision.reason).toContain("marker=opening_expand_35");
  });

  it("walks OPENING -> CONTACT -> TARGET_LOCK -> FINISH and persists the lock", () => {
    const machine = executor();
    const a = rival("A", { relativeTroopRatio: 1, tileShare: 0.2 });
    const b = rival("B", { relativeTroopRatio: 1.2, tileShare: 0.18 });

    const contact = machine.decide(
      input({
        turn: 1_500,
        actions: [attack("A"), attack("B"), neutral(35), hold],
        rivals: [a, b],
        neutral: true,
      }),
      plan({ targetPlayerId: "A" }),
    );
    expect(contact.actionID).toBe("attack:A:35");
    expect(contact.reason).toContain("transition=OPENING>CONTACT");
    expect(machine.snapshot()).toMatchObject({
      state: "CONTACT",
      targetPlayerID: null,
    });

    const locked = machine.decide(
      input({
        turn: 1_600,
        actions: [attack("A"), attack("B"), city, hold],
        rivals: [a, b],
      }),
      plan({ targetPlayerId: "A" }),
    );
    expect(locked.actionID).toBe("attack:A:35");
    expect(locked.reason).toContain("transition=CONTACT>TARGET_LOCK");

    const finishingA = attack("A", 1.6, 0.1);
    const finish = machine.decide(
      input({
        turn: 1_700,
        actions: [attack("B", 2), finishingA, city, hold],
        rivals: [{ ...a, relativeTroopRatio: 1.6, tileShare: 0.1 }, b],
      }),
      plan({ targetPlayerId: "B" }),
    );
    expect(finish.actionID).toBe(finishingA.id);
    expect(finish.reason).toContain("transition=TARGET_LOCK>FINISH");

    const repeated = machine.decide(
      input({
        turn: 1_800,
        actions: [attack("B", 2), finishingA, upgrade, hold],
        rivals: [{ ...a, relativeTroopRatio: 1.6, tileShare: 0.1 }, b],
      }),
      plan({ targetPlayerId: "B" }),
    );
    expect(repeated.actionID).toBe(finishingA.id);
    expect(repeated.reason).toContain("marker=target_lock_persistence");
    expect(machine.snapshot()).toMatchObject({
      state: "FINISH",
      targetPlayerID: "A",
    });
  });

  it("allows one early City when the frontier stalls, then restores economy eligibility", () => {
    const machine = executor();
    const stalled = input({
      turn: 800,
      actions: [city, upgrade, hold],
      neutral: false,
      tileShare: 0.08,
    });

    const first = machine.decide(stalled, plan());
    const second = machine.decide(
      { ...stalled, observation: { ...stalled.observation, turnNumber: 900 } },
      plan(),
    );

    expect(first.actionID).toBe(city.id);
    expect(first.reason).toContain("marker=city_milestone");
    expect(second.actionID).toBe(upgrade.id);
    expect(machine.snapshot().cityMilestoneUsed).toBe(true);
  });

  it("does not build a City under attack and suppresses blind early diplomacy", () => {
    const underAttack = executor().decide(
      input({
        turn: 900,
        actions: [city, upgrade, alliance, hold],
        incoming: ["A"],
        tileShare: 0.08,
      }),
      plan(),
    );
    expect(underAttack.actionID).toBe(upgrade.id);

    const visibleOnlyAttack = executor().decide(
      input({
        turn: 900,
        actions: [city, upgrade, hold],
        rivals: [rival("A", { incomingAttack: true })],
        tileShare: 0.08,
      }),
      plan(),
    );
    expect(visibleOnlyAttack.actionID).toBe(upgrade.id);

    const social = executor().decide(
      input({ turn: 500, actions: [alliance, hold] }),
      plan({
        objective: "build_alliance",
        preferredActionKinds: ["alliance_request", "hold"],
      }),
    );
    expect(social.actionID).toBe(hold.id);
    expect(social.reason).toContain("marker=early_social_suppression");
  });

  it("does not mistake an ambiguous null-id rival for neutral frontier", () => {
    const ambiguous = action("attack:unknown:35", "attack", {
      targetID: null,
      targetName: "Named Rival",
      troopPercent: 35,
    });
    const decision = executor().decide(
      input({ turn: 400, actions: [ambiguous, hold], neutral: false }),
      plan(),
    );

    expect(decision.actionID).toBe(hold.id);
    expect(decision.reason).not.toContain("opening_expand");
  });

  it("interrupts for the actual aggressor without permanently changing its lock", () => {
    const machine = executor();
    const a = rival("A");
    const b = rival("B");
    machine.decide(
      input({ turn: 1_500, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );
    machine.decide(
      input({ turn: 1_600, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );

    const interrupt = machine.decide(
      input({
        turn: 1_700,
        actions: [attack("A"), attack("B"), hold],
        rivals: [a, { ...b, incomingAttack: true }],
        incoming: ["B"],
      }),
      plan({ targetPlayerId: "A", forbiddenActionKinds: ["attack"] }),
    );
    expect(interrupt.actionID).toBe("attack:B:35");
    expect(interrupt.reason).toContain("marker=invasion_interrupt");
    expect(interrupt.planFollowed).toBe(false);
    expect(machine.snapshot().targetPlayerID).toBe("A");

    const resumed = machine.decide(
      input({
        turn: 1_800,
        actions: [attack("B"), attack("A"), hold],
        rivals: [a, b],
      }),
      plan({ targetPlayerId: "B" }),
    );
    expect(resumed.actionID).toBe("attack:A:35");
  });

  it("prefers an aggressor-directed troop spend over a ranked nuke during a capped invasion", () => {
    const nuke = action("nuke:B", "nuke", {
      targetID: "B",
      relativeTroopRatio: 2,
    });
    const attacker = rival("B", {
      incomingAttack: true,
      relativeTroopRatio: 1.2,
    });
    const decision = executor().decide(
      input({
        turn: 1_700,
        actions: [nuke, attack("B", 1.2), hold],
        rivals: [attacker],
        incoming: ["B"],
        troopRatio: 0.95,
      }),
      plan({
        objective: "survive",
        preferredActionKinds: ["hold"],
        forbiddenActionKinds: ["attack", "nuke"],
      }),
    );

    expect(decision.actionID).toBe("attack:B:35");
    expect(decision.reason).toContain("marker=invasion_interrupt");
    expect(decision.planFollowed).toBe(false);
  });

  it("releases an unavailable lock after bounded misses and releases dead targets immediately", () => {
    const machine = executor();
    const a = rival("A");
    const b = rival("B");
    machine.decide(
      input({ turn: 1_500, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );
    machine.decide(
      input({ turn: 1_600, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );

    const miss = machine.decide(
      input({ turn: 1_700, actions: [attack("B"), hold], rivals: [a, b] }),
      plan({ targetPlayerId: "B" }),
    );
    expect(miss.actionID).toBe(hold.id);
    expect(machine.snapshot()).toMatchObject({
      targetPlayerID: "A",
      targetMisses: 1,
    });

    const released = machine.decide(
      input({ turn: 1_800, actions: [attack("B"), hold], rivals: [a, b] }),
      plan({ targetPlayerId: "B" }),
    );
    expect(released.actionID).toBe("attack:B:35");
    expect(machine.snapshot().targetPlayerID).toBe("B");

    const deadMachine = executor();
    deadMachine.decide(
      input({ turn: 1_500, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );
    deadMachine.decide(
      input({ turn: 1_600, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );
    const dead = deadMachine.decide(
      input({
        turn: 1_700,
        actions: [attack("B"), hold],
        rivals: [{ ...a, isAlive: false }, b],
      }),
      plan({ targetPlayerId: "B" }),
    );
    expect(dead.actionID).toBe("attack:B:35");
    expect(deadMachine.snapshot().targetPlayerID).toBe("B");
  });

  it("switches a stale lock immediately when cap pressure exposes only a forbidden credible rival", () => {
    const machine = executor();
    const a = rival("A");
    const b = rival("B", { relativeTroopRatio: 1.4 });
    machine.decide(
      input({ turn: 1_500, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );
    machine.decide(
      input({ turn: 1_600, actions: [attack("A"), hold], rivals: [a] }),
      plan({ targetPlayerId: "A" }),
    );

    const switched = machine.decide(
      input({
        turn: 1_700,
        actions: [attack("B", 1.4)],
        rivals: [a, b],
        troopRatio: 0.95,
      }),
      plan({
        targetPlayerId: "A",
        forbiddenActionKinds: ["attack"],
        preferredActionKinds: ["hold"],
      }),
    );

    expect(switched.actionID).toBe("attack:B:35");
    expect(switched.reason).toContain("marker=cap_conversion_override");
    expect(switched.planFollowed).toBe(false);
    expect(machine.snapshot().targetPlayerID).toBe("B");
  });

  it("ignores allied plan targets and selects a credible non-allied rival", () => {
    const allied = rival("A", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
    });
    const open = rival("B");
    const decision = executor().decide(
      input({
        turn: 1_500,
        actions: [attack("A"), attack("B"), hold],
        rivals: [allied, open],
      }),
      plan({
        targetPlayerId: "A",
        commitment: { targetPlayerId: "A", minAttackRatio: 0.2 },
      }),
    );
    expect(decision.actionID).toBe("attack:B:35");
  });

  it("uses an allowed player boat when the Commander forbids land attacks", () => {
    const target = rival("A");
    const decision = executor().decide(
      input({
        turn: 1_500,
        actions: [attack("A"), boat("A"), city, hold],
        rivals: [target],
      }),
      plan({
        targetPlayerId: "A",
        forbiddenActionKinds: ["attack"],
        preferredActionKinds: ["boat", "build", "hold"],
      }),
    );
    expect(decision.actionID).toBe("boat:A:25");
  });

  it.each([
    {
      label: "near cap",
      troopRatio: 0.95,
      neutral: true,
      marker: "cap_conversion_override",
    },
    {
      label: "at a dead frontier",
      troopRatio: 0.6,
      neutral: false,
      marker: "dead_frontier_conversion_override",
    },
  ])(
    "overrides stale attack+boat prohibitions $label for a credible player conversion",
    ({ troopRatio, neutral: hasNeutral, marker }) => {
      const target = rival("A", { relativeTroopRatio: 1.5 });
      const actions = [
        city,
        attack("A", 1.5),
        boat("A"),
        ...(hasNeutral ? [neutral(35)] : []),
        hold,
      ];
      const decision = executor().decide(
        input({
          turn: 3_000,
          actions,
          rivals: [target],
          neutral: hasNeutral,
          troopRatio,
        }),
        plan({
          targetPlayerId: "A",
          forbiddenActionKinds: ["attack", "boat"],
          preferredActionKinds: ["build", "hold"],
        }),
      );

      expect(decision.actionID).toBe("attack:A:35");
      expect(decision.reason).toContain(`marker=${marker}`);
      expect(decision.planFollowed).toBe(false);
    },
  );

  it("does not use a cap override for a high-risk unfavorable attack", () => {
    const reckless = action(
      "attack:A:75",
      "attack",
      { targetID: "A", relativeTroopRatio: 1, troopPercent: 75 },
      { level: "high", score: 0.9 },
    );
    const decision = executor().decide(
      input({
        turn: 3_000,
        actions: [reckless, city, hold],
        rivals: [rival("A")],
        troopRatio: 0.95,
      }),
      plan({
        targetPlayerId: "A",
        forbiddenActionKinds: ["attack"],
        preferredActionKinds: ["build", "hold"],
      }),
    );

    expect(decision.actionID).toBe(city.id);
    expect(decision.reason).not.toContain("conversion_override");
  });

  it.each([
    { label: "allied", flags: { isAllied: true } },
    { label: "friendly", flags: { isFriendly: true } },
    { label: "teammate", flags: { isTeammate: true } },
  ])("never uses a cap override against an $label player", ({ flags }) => {
    const protectedPlayer = rival("A", flags);
    const decision = executor().decide(
      input({
        turn: 3_000,
        actions: [attack("A", 2), boat("A"), city, hold],
        rivals: [protectedPlayer],
        troopRatio: 0.95,
      }),
      plan({
        targetPlayerId: "A",
        forbiddenActionKinds: ["attack", "boat"],
        preferredActionKinds: ["build", "hold"],
      }),
    );

    expect(decision.actionID).toBe(city.id);
    expect(decision.reason).not.toContain("conversion_override");
  });

  it("protects a named Commander alliance target from ordinary conversion", () => {
    const intendedAlly = rival("A", {
      relation: Relation.Neutral,
      isFriendly: false,
    });
    const decision = executor().decide(
      input({
        turn: 1_500,
        actions: [attack("A"), alliance, hold],
        rivals: [intendedAlly],
      }),
      plan({
        objective: "build_alliance",
        targetPlayerId: "A",
        preferredActionKinds: ["alliance_request", "hold"],
        allianceDirective: { stance: "seek_alliance", targetPlayerId: "A" },
      }),
    );

    expect(decision.actionID).toBe(alliance.id);
    expect(decision.actionID).not.toBe("attack:A:35");
    expect(decision.planFollowed).toBe(true);
  });

  it("marks an unfulfilled named alliance directive as not followed", () => {
    const decision = executor().decide(
      input({ turn: 500, actions: [hold] }),
      plan({
        objective: "build_alliance",
        targetPlayerId: "A",
        preferredActionKinds: ["alliance_request", "hold"],
        allianceDirective: { stance: "seek_alliance", targetPlayerId: "A" },
      }),
    );

    expect(decision.actionID).toBe(hold.id);
    expect(decision.planFollowed).toBe(false);
  });

  it("honors an offered binding City directive ahead of ordinary pressure", () => {
    const decision = executor().decide(
      input({
        turn: 1_000,
        actions: [attack("A"), city, neutral(35), hold],
        rivals: [rival("A")],
        neutral: true,
      }),
      plan({
        objective: "secure_economy",
        preferredActionKinds: ["attack", "build", "hold"],
        buildDirective: { unit: "City" },
      }),
    );

    expect(decision.actionID).toBe(city.id);
    expect(decision.reason).toContain("marker=binding_build_directive");
    expect(decision.planFollowed).toBe(true);
  });

  it("honors an offered binding City directive at the troop cap", () => {
    const decision = executor().decide(
      input({
        turn: 3_000,
        actions: [attack("A"), city, hold],
        rivals: [rival("A")],
        troopRatio: 0.95,
      }),
      plan({
        objective: "secure_economy",
        preferredActionKinds: ["attack", "build", "hold"],
        buildDirective: { unit: "City" },
      }),
    );

    expect(decision.actionID).toBe(city.id);
    expect(decision.reason).toContain("marker=binding_build_directive");
    expect(decision.planFollowed).toBe(true);
  });

  it("honors an offered binding alliance directive at the troop cap", () => {
    const decision = executor().decide(
      input({
        turn: 3_000,
        actions: [attack("B", 1.2), alliance, hold],
        rivals: [rival("A"), rival("B", { relativeTroopRatio: 1.2 })],
        troopRatio: 0.95,
      }),
      plan({
        objective: "build_alliance",
        targetPlayerId: "A",
        preferredActionKinds: ["alliance_request", "attack", "hold"],
        allianceDirective: { stance: "seek_alliance", targetPlayerId: "A" },
      }),
    );

    expect(decision.actionID).toBe(alliance.id);
    expect(decision.reason).toContain("marker=binding_alliance_directive");
    expect(decision.planFollowed).toBe(true);
  });

  it("selects the closest offered land attack above a commitment floor", () => {
    const attack10 = action("attack:A:10", "attack", {
      targetID: "A",
      relativeTroopRatio: 1.4,
      targetTileShare: 0.2,
      troopPercent: 10,
      troopPercentage: 0.1,
    });
    const attack35 = action("attack:A:35", "attack", {
      targetID: "A",
      relativeTroopRatio: 1.4,
      targetTileShare: 0.2,
      troopPercent: 35,
      troopPercentage: 0.35,
    });
    const decision = executor().decide(
      input({
        turn: 1_500,
        actions: [attack10, attack35, hold],
        rivals: [rival("A", { relativeTroopRatio: 1.4 })],
      }),
      plan({
        targetPlayerId: "A",
        commitment: { targetPlayerId: "A", minAttackRatio: 0.25 },
      }),
    );

    expect(decision.actionID).toBe(attack35.id);
    expect(decision.reason).toContain("marker=binding_commitment");
    expect(decision.planFollowed).toBe(true);
  });

  it("spends near the troop cap on conversion instead of build, neutral, or hold", () => {
    const target = rival("A");
    const nuke = action("nuke:A", "nuke", {
      targetID: "A",
      relativeTroopRatio: 2,
    });
    const decision = executor().decide(
      input({
        turn: 800,
        actions: [nuke, city, neutral(35), attack("A"), hold],
        rivals: [target],
        neutral: true,
        troopRatio: 0.92,
      }),
      plan({ targetPlayerId: "A" }),
    );
    expect(decision.actionID).toBe("attack:A:35");
    expect(decision.reason).toContain("marker=cap_spend");
  });

  it("uses a narrow forbidden troop-spend override over a permitted nuke near cap", () => {
    const nukeA = action("nuke:A", "nuke", {
      targetID: "A",
      relativeTroopRatio: 2,
    });
    const decision = executor().decide(
      input({
        turn: 1_500,
        actions: [nukeA, attack("B", 1.2), hold],
        rivals: [rival("A"), rival("B", { relativeTroopRatio: 1.2 })],
        troopRatio: 0.95,
      }),
      plan({
        targetPlayerId: "A",
        preferredActionKinds: ["nuke", "hold"],
        forbiddenActionKinds: ["attack"],
      }),
    );

    expect(decision.actionID).toBe("attack:B:35");
    expect(decision.reason).toContain("marker=cap_conversion_override");
    expect(decision.selectedModules).toContain(
      "marker=cap_conversion_override",
    );
    expect(decision.planFollowed).toBe(false);
  });

  it("permits later ranked economy only when no credible conversion exists", () => {
    const decision = executor().decide(
      input({ turn: 3_000, actions: [upgrade, city, hold] }),
      plan({ objective: "secure_economy" }),
    );
    expect(decision.actionID).toBe(upgrade.id);
    expect(decision.executorSource).toBe("coworld-single-action-v1");
    expect(decision.selectedModules).toContain(
      "treatment=coworld-single-action-v1",
    );
  });

  it("passes the exact Keystone settings to the injected repository ranker", () => {
    const rankActions = vi.fn<KeystoneActionRanker>(({ input: current }) =>
      ranked(current.legalActions),
    );
    executor(rankActions).decide(
      input({ turn: 400, actions: [neutral(35), hold], neutral: true }),
      plan(),
    );

    expect(rankActions).toHaveBeenCalledOnce();
    expect(rankActions.mock.calls[0]![0]).toMatchObject({
      profile: "aggressive",
      settings,
    });
  });

  it("fails closed rather than fabricating an id when no action was offered", () => {
    expect(() =>
      executor().decide(input({ turn: 1, actions: [] }), plan()),
    ).toThrow(/empty offered action set/);
  });

  it("drops ambiguous duplicate ids without suppressing unrelated legal actions", () => {
    const rankActions = vi.fn<KeystoneActionRanker>(({ input: current }) =>
      ranked(current.legalActions),
    );
    const duplicate = neutral(35);

    const decision = executor(rankActions).decide(
      input({
        turn: 400,
        actions: [duplicate, { ...duplicate }, hold],
        neutral: true,
      }),
      plan(),
    );

    expect(decision.actionID).toBe(hold.id);
    expect(rankActions).toHaveBeenCalledOnce();
    expect(rankActions.mock.calls[0]![0].input.legalActions).toEqual([hold]);
  });

  it("keeps expanding when two quick-chat intents collide on one wire id", () => {
    const rankActions = vi.fn<KeystoneActionRanker>(({ input: current }) =>
      ranked(current.legalActions),
    );
    const expansion = neutral(35);
    const chatID = "quick_chat:ALLY:attack.focus";
    const chatOne = action(chatID, "quick_chat", {
      recipientID: "ALLY",
      targetID: "RIVAL-1",
      quickChatKey: "attack.focus",
    });
    const chatTwo = action(chatID, "quick_chat", {
      recipientID: "ALLY",
      targetID: "RIVAL-2",
      quickChatKey: "attack.focus",
    });

    const decision = executor(rankActions).decide(
      input({
        turn: 1_300,
        actions: [expansion, chatOne, chatTwo, hold],
        neutral: true,
      }),
      plan(),
    );

    expect(decision.actionID).toBe(expansion.id);
    expect(rankActions.mock.calls[0]![0].input.legalActions).toEqual([
      expansion,
      hold,
    ]);
  });

  it("fails closed when every offered action id is ambiguous", () => {
    const rankActions = vi.fn<KeystoneActionRanker>(() => []);

    expect(() =>
      executor(rankActions).decide(
        input({ turn: 400, actions: [hold, { ...hold }] }),
        plan(),
      ),
    ).toThrow(/every offered action id is ambiguous/);
    expect(rankActions).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\t\n"])(
    "fails closed on an empty offered id before invoking the ranker",
    (id) => {
      const rankActions = vi.fn<KeystoneActionRanker>(() => []);
      expect(() =>
        executor(rankActions).decide(
          input({ turn: 400, actions: [{ ...hold, id }] }),
          plan(),
        ),
      ).toThrow(/empty offered action id/);
      expect(rankActions).not.toHaveBeenCalled();
    },
  );

  it("ignores unknown and mismatched ranker rows, dedupes rows, and appends partial output", () => {
    const expansion = neutral(35);
    const valid = ranked([expansion])[0]!;
    const rankActions: KeystoneActionRanker = () => [
      { ...valid, id: "ghost:action" },
      valid,
      { ...valid, totalScore: -999 },
      { ...valid, id: hold.id, kind: "attack" },
    ];
    const decision = executor(rankActions).decide(
      input({
        turn: 400,
        actions: [neutral(10), expansion, city, hold],
        neutral: true,
      }),
      plan(),
    );

    expect(decision.actionID).toBe(expansion.id);
    expect(decision.alternativesConsidered).toBe(`${expansion.id}:100`);
    expect(decision.actionIDs).toBeUndefined();
  });

  it("handles a null ownState without inventing cap pressure", () => {
    const decision = executor().decide(
      input({
        turn: 400,
        actions: [city, neutral(35), hold],
        neutral: true,
        ownStateNull: true,
      }),
      plan(),
    );

    expect(decision.actionID).toBe("expand:terra-nullius:35");
    expect(decision.reason).not.toContain("cap_");
  });
});
