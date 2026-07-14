import { describe, expect, it } from "vitest";

import {
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  computeKeystoneBidBP,
  type KeystoneCouncilTiers,
  type KeystoneDirectiveProposal,
  type KeystoneExpertProposal,
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
    risk: { level: riskScore === 0 ? "none" : "low", score: riskScore },
    metadata:
      targetPlayerID === null
        ? {}
        : {
            targetID: targetPlayerID,
          },
  };
}

function neutral(id = "expand:neutral:35"): LegalAction {
  return {
    ...action(id, "attack", null),
    metadata: { targetID: null, expansion: true, troopPercent: 35 },
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
  phase?: AgentGamePhase;
  players?: AgentVisiblePlayer[];
  ownTeam?: string | null;
}): AgentBrainInput {
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "EXPERT-COUNCIL",
    turnNumber: 1_500,
    phaseOverride: args.phase ?? "active",
  });
  const players = args.players ?? [];
  return {
    observation: {
      ...base,
      gameMode: args.ownTeam === null ? "FFA" : "Team",
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

const defaultBid = {
  expectedValueBP: 8_000,
  urgencyBP: 6_000,
  confidenceBP: 8_000,
  riskBP: 1_000,
  opportunityCostBP: 1_000,
};

function expert(
  proposalID: string,
  actionID: string,
  overrides: Partial<KeystoneExpertProposal> = {},
): KeystoneExpertProposal {
  return {
    proposalID,
    actionID,
    source: "conquest",
    rationale: "focused test proposal",
    ...defaultBid,
    ...overrides,
  };
}

function directive<Source extends "spawn" | "survival" | "binding_directive">(
  source: Source,
  proposalID: string,
  actionID: string,
  overrides: Partial<KeystoneDirectiveProposal<Source>> = {},
): KeystoneDirectiveProposal<Source> {
  return {
    proposalID,
    actionID,
    source,
    rationale: "focused test directive",
    ...defaultBid,
    ...overrides,
  };
}

function tiers(
  overrides: Partial<KeystoneCouncilTiers> = {},
): KeystoneCouncilTiers {
  return {
    spawn: [],
    survival: [],
    bindingDirective: [],
    expertAuction: [],
    ...overrides,
  };
}

describe("Keystone expert council infrastructure", () => {
  it("builds a deterministic immutable world model and centralized action facts", () => {
    const teammate = player("TEAM", { team: "blue" });
    const enemy = player("ENEMY", { incomingAttack: true, team: "red" });
    const world = buildKeystoneWorldModel(
      brainInput({
        actions: [
          action("z-enemy", "attack", "ENEMY"),
          neutral(),
          action("a-team", "attack", "TEAM"),
        ],
        players: [enemy, teammate],
        ownTeam: "blue",
      }),
      {
        forbiddenActionKinds: ["nuke"],
        planAlignedActionIDs: ["z-enemy"],
      },
    );

    expect(Object.isFrozen(world)).toBe(true);
    expect(Object.isFrozen(world.actions)).toBe(true);
    expect(Object.isFrozen(world.actions[0])).toBe(true);
    expect(world.actions.map((candidate) => candidate.id)).toEqual([
      "a-team",
      "expand:neutral:35",
      "z-enemy",
    ]);
    expect(
      world.actions.find((candidate) => candidate.id === "a-team"),
    ).toMatchObject({
      targetsFriendlyOrTeam: true,
      safetyBlocked: true,
    });
    expect(
      world.actions.find((candidate) => candidate.id === "expand:neutral:35"),
    ).toMatchObject({
      isNeutralExpansion: true,
      isHostileTargetAction: false,
      safetyBlocked: false,
    });
    expect(world.incomingAggressorIDs).toEqual(["ENEMY"]);
  });

  it("rejects empty and duplicate ids in the offered LegalAction set", () => {
    expect(() =>
      buildKeystoneWorldModel(
        brainInput({ actions: [action("", "hold", null, 0)] }),
      ),
    ).toThrow(/empty offered action id/);
    expect(() =>
      buildKeystoneWorldModel(
        brainInput({
          actions: [action("same", "hold"), action("same", "attack", "A")],
        }),
      ),
    ).toThrow(/duplicate offered action id: same/);
  });

  it("uses an integer common bid formula with the action risk as a floor", () => {
    expect(
      computeKeystoneBidBP(
        {
          expectedValueBP: 8_000,
          urgencyBP: 6_000,
          confidenceBP: 7_000,
          riskBP: 1_000,
          opportunityCostBP: 2_000,
        },
        4_000,
      ),
    ).toBe(6_000);
    expect(() =>
      computeKeystoneBidBP({ ...defaultBid, confidenceBP: 0.5 }),
    ).toThrow(/integer from 0 to 10000/);
  });

  it("filters non-offered proposals and falls through to a valid lower tier", () => {
    const world = buildKeystoneWorldModel(
      brainInput({
        actions: [action("build:city", "build"), action("hold", "hold")],
      }),
    );
    const result = arbitrateKeystoneAction(
      world,
      tiers({
        survival: [directive("survival", "missing", "not-offered")],
        bindingDirective: [
          directive("binding_directive", "city", "build:city"),
        ],
      }),
    );

    expect(result.selection?.actionID).toBe("build:city");
    expect(result.selection?.tier).toBe("binding_directive");
    expect(result.rejections).toContainEqual(
      expect.objectContaining({
        proposalID: "missing",
        reason: "non_offered_action",
      }),
    );
  });

  it("deduplicates proposals for one action without double counting", () => {
    const world = buildKeystoneWorldModel(
      brainInput({ actions: [action("attack:A", "attack", "A")] }),
    );
    const result = arbitrateKeystoneAction(
      world,
      tiers({
        expertAuction: [
          expert("weak", "attack:A", {
            source: "politics",
            expectedValueBP: 3_000,
          }),
          expert("strong", "attack:A", {
            source: "conquest",
            expectedValueBP: 9_000,
          }),
        ],
      }),
    );

    expect(result.selection).toMatchObject({
      actionID: "attack:A",
      proposalID: "strong",
      source: "conquest",
    });
    expect(result.rejections).toContainEqual(
      expect.objectContaining({
        proposalID: "weak",
        reason: "duplicate_action_proposal",
      }),
    );
  });

  it("filters forbidden and friendly-or-team hostile actions before auction", () => {
    const friend = player("FRIEND", { isFriendly: true });
    const teammate = player("TEAM", { team: "blue" });
    const enemy = player("ENEMY", { team: "red" });
    const world = buildKeystoneWorldModel(
      brainInput({
        actions: [
          action("attack:friend", "attack", "FRIEND"),
          action("attack:team", "attack", "TEAM"),
          action("build:city", "build"),
          action("attack:enemy", "attack", "ENEMY"),
        ],
        players: [friend, teammate, enemy],
        ownTeam: "blue",
      }),
      { forbiddenActionKinds: ["build"] },
    );
    const result = arbitrateKeystoneAction(
      world,
      tiers({
        expertAuction: [
          expert("friend", "attack:friend", { expectedValueBP: 10_000 }),
          expert("team", "attack:team", { expectedValueBP: 10_000 }),
          expert("forbidden", "build:city", { expectedValueBP: 10_000 }),
          expert("enemy", "attack:enemy", { expectedValueBP: 4_000 }),
        ],
      }),
    );

    expect(result.selection?.actionID).toBe("attack:enemy");
    expect(result.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposalID: "friend",
          reason: "friendly_or_team_target",
        }),
        expect.objectContaining({
          proposalID: "team",
          reason: "friendly_or_team_target",
        }),
        expect.objectContaining({
          proposalID: "forbidden",
          reason: "forbidden_action",
        }),
      ]),
    );
  });

  it("enforces spawn, survival, binding, then expert precedence", () => {
    const spawnWorld = buildKeystoneWorldModel(
      brainInput({
        phase: "spawn",
        actions: [
          action("spawn:10", "spawn"),
          action("attack:A", "attack", "A"),
        ],
      }),
    );
    const spawnResult = arbitrateKeystoneAction(
      spawnWorld,
      tiers({
        spawn: [directive("spawn", "spawn", "spawn:10")],
        survival: [directive("survival", "survive", "attack:A")],
        expertAuction: [expert("expert", "attack:A")],
      }),
    );
    expect(spawnResult.selection).toMatchObject({
      actionID: "spawn:10",
      tier: "spawn",
    });

    const activeWorld = buildKeystoneWorldModel(
      brainInput({
        actions: [
          action("retreat:1", "retreat"),
          action("build:city", "build"),
          action("attack:A", "attack", "A"),
        ],
      }),
    );
    const survivalResult = arbitrateKeystoneAction(
      activeWorld,
      tiers({
        survival: [directive("survival", "retreat", "retreat:1")],
        bindingDirective: [
          directive("binding_directive", "directive", "build:city"),
        ],
        expertAuction: [expert("expert", "attack:A")],
      }),
    );
    expect(survivalResult.selection).toMatchObject({
      actionID: "retreat:1",
      tier: "survival",
    });

    const bindingResult = arbitrateKeystoneAction(
      activeWorld,
      tiers({
        bindingDirective: [
          directive("binding_directive", "directive", "build:city"),
        ],
        expertAuction: [expert("expert", "attack:A")],
      }),
    );
    expect(bindingResult.selection).toMatchObject({
      actionID: "build:city",
      tier: "binding_directive",
    });
  });

  it("prefers the plan-aligned expert pool before comparing bids", () => {
    const world = buildKeystoneWorldModel(
      brainInput({
        actions: [
          action("attack:A", "attack", "A"),
          action("build:city", "build"),
        ],
      }),
      { planAlignedActionIDs: ["build:city"] },
    );
    const result = arbitrateKeystoneAction(
      world,
      tiers({
        expertAuction: [
          expert("attack", "attack:A", { expectedValueBP: 10_000 }),
          expert("city", "build:city", {
            source: "economy",
            expectedValueBP: 2_000,
          }),
        ],
      }),
    );

    expect(result.selection).toMatchObject({
      actionID: "build:city",
      planAligned: true,
    });
  });

  it("is order invariant and uses action id as the fixed cross-action tie break", () => {
    const a = action("a-action", "build");
    const b = action("b-action", "build");
    const proposals = [expert("b", b.id), expert("a", a.id)];
    const forward = arbitrateKeystoneAction(
      buildKeystoneWorldModel(brainInput({ actions: [b, a] })),
      tiers({ expertAuction: proposals }),
    );
    const reverse = arbitrateKeystoneAction(
      buildKeystoneWorldModel(brainInput({ actions: [a, b] })),
      tiers({ expertAuction: [...proposals].reverse() }),
    );

    expect(forward.selection).toEqual(reverse.selection);
    expect(forward.selection?.actionID).toBe("a-action");
  });

  it("returns exactly one offered id, otherwise holds or explicitly abstains", () => {
    const selected = arbitrateKeystoneAction(
      buildKeystoneWorldModel(
        brainInput({
          actions: [
            action("attack:A", "attack", "A"),
            action("hold", "hold", null, 0),
          ],
        }),
      ),
      tiers({ expertAuction: [expert("attack", "attack:A")] }),
    );
    expect(selected.disposition).toBe("proposal");
    expect(selected.selection?.actionID).toBe("attack:A");
    expect(
      Object.keys(selected.selection ?? {}).filter((key) => key === "actionID"),
    ).toHaveLength(1);
    expect("actionIDs" in (selected.selection ?? {})).toBe(false);

    const losingBid = expert("bad", "attack:A", {
      expectedValueBP: 0,
      urgencyBP: 0,
      confidenceBP: 0,
      riskBP: 10_000,
      opportunityCostBP: 10_000,
    });
    const held = arbitrateKeystoneAction(
      buildKeystoneWorldModel(
        brainInput({
          actions: [
            action("attack:A", "attack", "A"),
            action("hold", "hold", null, 0),
          ],
        }),
      ),
      tiers({ expertAuction: [losingBid] }),
    );
    expect(held).toMatchObject({
      disposition: "hold",
      selection: { actionID: "hold", tier: "hold" },
    });

    const abstained = arbitrateKeystoneAction(
      buildKeystoneWorldModel(
        brainInput({ actions: [action("attack:A", "attack", "A")] }),
      ),
      tiers({ expertAuction: [losingBid] }),
    );
    expect(abstained).toMatchObject({
      disposition: "abstain",
      selection: null,
    });
  });
});
