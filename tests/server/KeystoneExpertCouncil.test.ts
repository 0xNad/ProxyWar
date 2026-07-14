import { describe, expect, it } from "vitest";

import {
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  computeKeystoneBidBP,
  proposeKeystoneConquest,
  proposeKeystoneEconomy,
  proposeKeystoneExpansion,
  proposeKeystonePolitics,
  proposeKeystoneSpawn,
  proposeKeystoneSurvival,
  type KeystoneActionOwner,
  type KeystoneCouncilTiers,
  type KeystoneDirectiveProposal,
  type KeystoneExpertDomain,
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

function metadataAction(
  id: string,
  kind: LegalActionKind,
  metadata: NonNullable<LegalAction["metadata"]>,
): LegalAction {
  return { ...action(id, kind), metadata };
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
  turnNumber?: number;
}): AgentBrainInput {
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "EXPERT-COUNCIL",
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

function tiersFromRealProposers(
  world: ReturnType<typeof buildKeystoneWorldModel>,
): KeystoneCouncilTiers {
  const spawn = proposeKeystoneSpawn(world);
  const survival = proposeKeystoneSurvival(world);
  return {
    spawn: spawn === null ? [] : [spawn],
    survival: survival === null ? [] : [survival],
    bindingDirective: [],
    expertAuction: [
      proposeKeystoneExpansion(world),
      proposeKeystoneEconomy(world),
      proposeKeystoneConquest(world),
      proposeKeystonePolitics(world),
    ].flatMap((proposal) => (proposal === null ? [] : [proposal])),
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
      actionOwner: "expansion",
    });
    expect(world.incomingAggressorIDs).toEqual(["ENEMY"]);
  });

  it("rejects an empty id in the offered LegalAction set", () => {
    expect(() =>
      buildKeystoneWorldModel(
        brainInput({ actions: [action("", "hold", null, 0)] }),
      ),
    ).toThrow(/empty offered action id/);
  });

  it("quarantines colliding Coworld quick-chat ids and keeps unrelated actions selectable", () => {
    const collidingID = "quick_chat:ALLY:attack.focus";
    const chats = [
      metadataAction(collidingID, "quick_chat", {
        recipientID: "ALLY",
        targetID: "A",
        quickChatKey: "attack.focus",
      }),
      metadataAction(collidingID, "quick_chat", {
        recipientID: "ALLY",
        targetID: "B",
        quickChatKey: "attack.focus",
      }),
    ];
    const world = buildKeystoneWorldModel(
      brainInput({
        actions: [...chats, action("build:city", "build")],
      }),
    );

    expect(world.ambiguousOfferedActionIDs).toEqual([collidingID]);
    expect(world.actions.map((candidate) => candidate.id)).toEqual([
      "build:city",
    ]);

    const result = arbitrateKeystoneAction(
      world,
      tiers({
        expertAuction: [
          expert("ambiguous-chat", collidingID, { source: "politics" }),
          expert("unique-city", "build:city", { source: "economy" }),
        ],
      }),
    );
    expect(result.selection?.actionID).toBe("build:city");
    expect(result.rejections).toContainEqual(
      expect.objectContaining({
        proposalID: "ambiguous-chat",
        reason: "ambiguous_offered_action",
      }),
    );

    const held = arbitrateKeystoneAction(
      buildKeystoneWorldModel(
        brainInput({
          actions: [...chats, action("hold", "hold", null, 0)],
        }),
      ),
      tiers(),
    );
    expect(held).toMatchObject({
      disposition: "hold",
      selection: { actionID: "hold", tier: "hold" },
    });

    const nothingUnique = buildKeystoneWorldModel(
      brainInput({ actions: [...chats].reverse() }),
    );
    const abstained = arbitrateKeystoneAction(
      nothingUnique,
      tiers({
        expertAuction: [
          expert("ambiguous-only", collidingID, { source: "politics" }),
        ],
      }),
    );
    expect(nothingUnique.ambiguousOfferedActionIDs).toEqual([collidingID]);
    expect(nothingUnique.actions).toEqual([]);
    expect(abstained).toMatchObject({
      disposition: "abstain",
      selection: null,
    });
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

  it("normalizes canonical troop commitments and fails closed on malformed or conflicting metadata", () => {
    const actions = [
      metadataAction("commit:10", "attack", {
        targetID: "ENEMY",
        troopPercent: 10,
      }),
      metadataAction("commit:25", "attack", {
        targetID: "ENEMY",
        troopPercentage: 0.25,
      }),
      metadataAction("commit:40", "attack", {
        targetID: "ENEMY",
        troopPercent: 40,
        troopPercentage: 0.4,
      }),
      metadataAction("commit:conflict", "attack", {
        targetID: "ENEMY",
        troopPercent: 25,
        troopPercentage: 0.4,
      }),
      metadataAction("commit:string", "attack", {
        targetID: "ENEMY",
        troopPercent: "35",
      }),
      metadataAction("commit:range", "attack", {
        targetID: "ENEMY",
        troopPercentage: 1.01,
      }),
      action("attack:ENEMY:40", "attack", "ENEMY"),
    ];
    const model = buildKeystoneWorldModel(
      brainInput({ actions, players: [player("ENEMY")] }),
    );
    const commitmentByID = Object.fromEntries(
      model.actions.map((candidate) => [
        candidate.id,
        candidate.troopCommitmentBP,
      ]),
    );

    expect(commitmentByID).toEqual({
      "commit:10": 1_000,
      "commit:25": 2_500,
      "commit:40": 4_000,
      "attack:ENEMY:40": null,
      "commit:conflict": null,
      "commit:range": null,
      "commit:string": null,
    });
  });

  it("assigns every action family to one expert or protected system owner", () => {
    const owned: Array<{ action: LegalAction; owner: KeystoneActionOwner }> = [
      { action: action("spawn", "spawn"), owner: "arbiter" },
      { action: action("hold", "hold", null, 0), owner: "arbiter" },
      { action: neutral("neutral:attack"), owner: "expansion" },
      {
        action: metadataAction("neutral:boat", "boat", {
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
        }),
        owner: "expansion",
      },
      {
        action: metadataAction("hostile:spoofed-neutral", "attack", {
          targetID: "ENEMY",
          expansion: true,
        }),
        owner: "conquest",
      },
      {
        action: action("hostile:attack", "attack", "ENEMY"),
        owner: "conquest",
      },
      { action: action("hostile:boat", "boat", "ENEMY"), owner: "conquest" },
      { action: action("hostile:nuke", "nuke", "ENEMY"), owner: "conquest" },
      { action: action("warship", "warship"), owner: "conquest" },
      { action: action("move:warship", "move_warship"), owner: "conquest" },
      { action: action("build", "build"), owner: "economy" },
      { action: action("upgrade", "upgrade_structure"), owner: "economy" },
      { action: action("delete", "delete_unit"), owner: "economy" },
      {
        action: action("alliance:request", "alliance_request", "ENEMY"),
        owner: "politics",
      },
      {
        action: action("alliance:reject", "alliance_reject", "ENEMY"),
        owner: "politics",
      },
      {
        action: action("alliance:extend", "alliance_extend", "ENEMY"),
        owner: "politics",
      },
      {
        action: action("alliance:break", "break_alliance", "ENEMY"),
        owner: "politics",
      },
      { action: action("target", "target_player", "ENEMY"), owner: "politics" },
      { action: action("embargo", "embargo", "ENEMY"), owner: "politics" },
      {
        action: action("embargo:stop", "embargo_stop", "ENEMY"),
        owner: "politics",
      },
      { action: action("embargo:all", "embargo_all"), owner: "politics" },
      {
        action: action("donate:gold", "donate_gold", "ENEMY"),
        owner: "politics",
      },
      {
        action: action("donate:troops", "donate_troops", "ENEMY"),
        owner: "politics",
      },
      { action: action("chat", "quick_chat", "ENEMY"), owner: "politics" },
      { action: action("emoji", "emoji", "ENEMY"), owner: "politics" },
      { action: action("retreat", "retreat"), owner: "survival" },
      { action: action("boat:retreat", "boat_retreat"), owner: "survival" },
      {
        action: action("counter:attack", "attack", "AGGRESSOR"),
        owner: "survival",
      },
      {
        action: action("counter:boat", "boat", "AGGRESSOR"),
        owner: "survival",
      },
      {
        action: action("counter:nuke", "nuke", "AGGRESSOR"),
        owner: "survival",
      },
      { action: action("unowned:attack", "attack"), owner: null },
      { action: action("unowned:boat", "boat"), owner: null },
      { action: action("unowned:nuke", "nuke"), owner: null },
    ];
    const world = buildKeystoneWorldModel(
      brainInput({
        actions: owned.map((entry) => entry.action),
        players: [
          player("ENEMY"),
          player("AGGRESSOR", { incomingAttack: true }),
        ],
      }),
    );

    expect(world.actions).toHaveLength(owned.length);
    for (const expected of owned) {
      expect(
        world.actions.find((candidate) => candidate.id === expected.action.id),
        expected.action.id,
      ).toMatchObject({ actionOwner: expected.owner });
    }
  });

  it("enforces a complete non-overlapping expert ownership matrix", () => {
    const sources: KeystoneExpertDomain[] = [
      "expansion",
      "economy",
      "conquest",
      "politics",
    ];
    const cases: Array<{
      owner: KeystoneExpertDomain;
      candidate: LegalAction;
    }> = [
      { owner: "expansion", candidate: neutral("owned:expansion") },
      { owner: "economy", candidate: action("owned:economy", "build") },
      {
        owner: "conquest",
        candidate: action("owned:conquest", "attack", "ENEMY"),
      },
      {
        owner: "politics",
        candidate: metadataAction("owned:politics", "quick_chat", {
          recipientID: "ENEMY",
          quickChatKey: "attack.focus",
        }),
      },
    ];

    for (const ownershipCase of cases) {
      const world = buildKeystoneWorldModel(
        brainInput({ actions: [ownershipCase.candidate] }),
      );
      for (const source of sources) {
        const result = arbitrateKeystoneAction(
          world,
          tiers({
            expertAuction: [
              expert(
                `${ownershipCase.owner}-from-${source}`,
                ownershipCase.candidate.id,
                { source },
              ),
            ],
          }),
        );
        if (source === ownershipCase.owner) {
          expect(result.selection?.actionID).toBe(ownershipCase.candidate.id);
        } else {
          expect(result).toMatchObject({
            disposition: "abstain",
            selection: null,
          });
          expect(result.rejections).toContainEqual(
            expect.objectContaining({
              reason: "action_ownership_mismatch",
            }),
          );
        }
      }
    }
  });

  it("moves only recognized defensive builds into survival ownership during verified pressure", () => {
    const defensive = metadataAction("build:defense", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const sam = metadataAction("build:sam", "build", {
      unit: "SAM Launcher",
      role: "defensive",
      defensiveValue: 0.4,
    });
    const economic = metadataAction("build:city", "build", {
      unit: "City",
      role: "economic",
    });
    const malformed = metadataAction("build:unknown", "build", {
      unit: "Treasury",
      role: "defensive",
      nearbyIncomingAttack: true,
    });
    const unsupported = metadataAction("build:unsupported", "build", {
      unit: "Defense Post",
      role: "defensive",
    });
    const malformedPlacement = metadataAction(
      "build:malformed-placement",
      "build",
      {
        unit: "Defense Post",
        role: "defensive",
        nearbyIncomingAttack: "true",
        defensiveValue: 2,
        hostileBorderDistance: 1.5,
      },
    );
    const nearBorder = metadataAction("build:near-border", "build", {
      unit: "Defense Post",
      role: "defensive",
      hostileBorderDistance: 60,
    });

    const calm = buildKeystoneWorldModel(
      brainInput({
        actions: [
          defensive,
          sam,
          economic,
          malformed,
          unsupported,
          malformedPlacement,
          nearBorder,
        ],
      }),
    );
    expect(
      Object.fromEntries(
        calm.actions.map((candidate) => [candidate.id, candidate.actionOwner]),
      ),
    ).toEqual({
      "build:city": "economy",
      "build:defense": "economy",
      "build:malformed-placement": "economy",
      "build:near-border": "economy",
      "build:sam": "economy",
      "build:unsupported": "economy",
      "build:unknown": "economy",
    });

    const pressured = buildKeystoneWorldModel(
      brainInput({
        actions: [
          defensive,
          sam,
          economic,
          malformed,
          unsupported,
          malformedPlacement,
          nearBorder,
        ],
        players: [player("AGGRESSOR", { incomingAttack: true })],
      }),
    );
    expect(
      Object.fromEntries(
        pressured.actions.map((candidate) => [
          candidate.id,
          candidate.actionOwner,
        ]),
      ),
    ).toEqual({
      "build:city": "economy",
      "build:defense": "survival",
      "build:malformed-placement": "economy",
      "build:near-border": "survival",
      "build:sam": "survival",
      "build:unsupported": "economy",
      "build:unknown": "economy",
    });
    expect(
      pressured.actions.find((candidate) => candidate.id === "build:defense"),
    ).toMatchObject({
      nearbyIncomingAttack: true,
      defensiveValueBP: null,
      hostileBorderDistance: null,
    });
    expect(
      pressured.actions.find((candidate) => candidate.id === "build:sam"),
    ).toMatchObject({
      nearbyIncomingAttack: null,
      defensiveValueBP: 4_000,
      hostileBorderDistance: null,
    });
    expect(
      pressured.actions.find(
        (candidate) => candidate.id === "build:malformed-placement",
      ),
    ).toMatchObject({
      nearbyIncomingAttack: null,
      defensiveValueBP: null,
      hostileBorderDistance: null,
    });

    const ownershipResult = arbitrateKeystoneAction(
      pressured,
      tiers({
        expertAuction: [
          expert("economy-cannot-bypass-survival", "build:defense", {
            source: "economy",
          }),
        ],
      }),
    );
    expect(ownershipResult.selection).toBeNull();
    expect(ownershipResult.rejections).toContainEqual(
      expect.objectContaining({
        proposalID: "economy-cannot-bypass-survival",
        reason: "action_ownership_mismatch",
      }),
    );
  });

  it("keeps arbiter, survival, and unowned actions outside every expert domain", () => {
    const actions = [
      action("spawn", "spawn"),
      action("hold", "hold", null, 0),
      action("retreat", "retreat"),
      action("counter", "attack", "AGGRESSOR"),
      action("ordinary-attack", "attack", "ENEMY"),
      action("unowned", "attack"),
      action("build", "build"),
    ];
    const world = buildKeystoneWorldModel(
      brainInput({
        actions,
        players: [
          player("AGGRESSOR", { incomingAttack: true }),
          player("ENEMY"),
        ],
      }),
    );

    for (const actionID of ["spawn", "hold", "retreat", "counter", "unowned"]) {
      const result = arbitrateKeystoneAction(
        world,
        tiers({ expertAuction: [expert(`expert-${actionID}`, actionID)] }),
      );
      expect(result.rejections).toContainEqual(
        expect.objectContaining({
          proposalID: `expert-${actionID}`,
          reason: "action_ownership_mismatch",
        }),
      );
    }

    const survival = arbitrateKeystoneAction(
      world,
      tiers({
        survival: [
          directive("survival", "not-survival", "ordinary-attack"),
          directive("survival", "verified-counter", "counter"),
        ],
      }),
    );
    expect(survival.selection).toMatchObject({
      actionID: "counter",
      tier: "survival",
    });
    expect(survival.rejections).toContainEqual(
      expect.objectContaining({
        proposalID: "not-survival",
        reason: "action_ownership_mismatch",
      }),
    );

    const binding = arbitrateKeystoneAction(
      world,
      tiers({
        bindingDirective: [
          directive("binding_directive", "binding-hold", "hold"),
          directive("binding_directive", "binding-counter", "counter"),
          directive("binding_directive", "binding-unowned", "unowned"),
          directive("binding_directive", "binding-build", "build"),
        ],
      }),
    );
    expect(binding.selection?.actionID).toBe("build");
    expect(
      binding.rejections.filter(
        (rejection) => rejection.reason === "action_ownership_mismatch",
      ),
    ).toHaveLength(3);
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
            source: "conquest",
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

  it("fills the spawn tier with the safest exact offered non-ambiguous id", () => {
    const spawnWorld = buildKeystoneWorldModel(
      brainInput({
        phase: "spawn",
        actions: [
          action("spawn:risky", "spawn", null, 0.8),
          action("spawn:safe", "spawn", null, 0.2),
          action("hold", "hold", null, 0),
        ],
      }),
    );
    const proposal = proposeKeystoneSpawn(spawnWorld);
    expect(proposal).toMatchObject({
      source: "spawn",
      actionID: "spawn:safe",
    });
    expect(
      arbitrateKeystoneAction(
        spawnWorld,
        tiers({ spawn: proposal === null ? [] : [proposal] }),
      ).selection,
    ).toMatchObject({ actionID: "spawn:safe", tier: "spawn" });

    const duplicateWorld = buildKeystoneWorldModel(
      brainInput({
        phase: "spawn",
        actions: [
          action("spawn:collision", "spawn", null, 0.1),
          action("spawn:collision", "spawn", null, 0.2),
        ],
      }),
    );
    expect(proposeKeystoneSpawn(duplicateWorld)).toBeNull();

    const forbiddenWorld = buildKeystoneWorldModel(
      brainInput({
        phase: "spawn",
        actions: [action("spawn:forbidden", "spawn", null, 0.1)],
      }),
      { forbiddenActionKinds: ["spawn"] },
    );
    expect(proposeKeystoneSpawn(forbiddenWorld)).toBeNull();
  });

  it("produces bounded survival recovery, defensive-build, and counter proposals only under verified pressure", () => {
    const aggressor = player("AGGRESSOR", {
      incomingAttack: true,
      relativeTroopRatio: 1,
    });
    const counterActions = [10, 25, 40].map((percent) =>
      metadataAction(`opaque-counter-${percent}`, "attack", {
        targetID: "AGGRESSOR",
        troopPercent: percent,
      }),
    );
    const defense = metadataAction("opaque-defense", "build", {
      unit: "Defense Post",
      role: "defensive",
      nearbyIncomingAttack: true,
    });

    const calm = buildKeystoneWorldModel(
      brainInput({
        actions: [...counterActions, defense],
        players: [
          player("AGGRESSOR", {
            incomingAttack: false,
            relativeTroopRatio: 1,
          }),
        ],
      }),
    );
    expect(proposeKeystoneSurvival(calm)).toBeNull();

    const counterWorld = buildKeystoneWorldModel(
      brainInput({ actions: counterActions, players: [aggressor] }),
    );
    expect(proposeKeystoneSurvival(counterWorld)).toMatchObject({
      source: "survival",
      actionID: "opaque-counter-25",
    });

    const defenseWorld = buildKeystoneWorldModel(
      brainInput({
        actions: [...counterActions, defense],
        players: [aggressor],
      }),
    );
    expect(proposeKeystoneSurvival(defenseWorld)).toMatchObject({
      source: "survival",
      actionID: "opaque-defense",
    });

    const boatRetreatWorld = buildKeystoneWorldModel(
      brainInput({
        actions: [action("opaque-boat-retreat", "boat_retreat")],
        players: [aggressor],
      }),
    );
    expect(proposeKeystoneSurvival(boatRetreatWorld)).toMatchObject({
      actionID: "opaque-boat-retreat",
    });

    const landRetreatWorld = buildKeystoneWorldModel(
      brainInput({
        actions: [
          action("opaque-boat-retreat", "boat_retreat"),
          action("opaque-land-retreat", "retreat"),
        ],
        players: [aggressor],
      }),
    );
    expect(proposeKeystoneSurvival(landRetreatWorld)).toMatchObject({
      actionID: "opaque-land-retreat",
    });
  });

  it("keeps survival counters friendly-safe and fails closed on unknown commitment metadata", () => {
    const friendlyAggressor = player("FRIEND", {
      incomingAttack: true,
      isFriendly: true,
      relation: Relation.Friendly,
    });
    const friendlyWorld = buildKeystoneWorldModel(
      brainInput({
        actions: [
          metadataAction("counter-friendly", "attack", {
            targetID: "FRIEND",
            troopPercent: 25,
          }),
        ],
        players: [friendlyAggressor],
      }),
    );
    expect(proposeKeystoneSurvival(friendlyWorld)).toBeNull();

    const aggressor = player("AGGRESSOR", { incomingAttack: true });
    const unknownWorld = buildKeystoneWorldModel(
      brainInput({
        actions: [action("looks-like-counter-40", "attack", "AGGRESSOR")],
        players: [aggressor],
      }),
    );
    expect(proposeKeystoneSurvival(unknownWorld)).toBeNull();
  });

  it("arbitrates all four expert domains and protected system tiers through one ownership boundary", () => {
    const rival = player("RIVAL", {
      relativeTroopRatio: 1.5,
      tileShare: 0.25,
    });
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canExtendAlliance: true,
      allianceInExtensionWindow: true,
    });
    const expertActions = [
      neutral("opaque-neutral-35"),
      metadataAction("opaque-city", "build", {
        unit: "City",
        role: "economic",
      }),
      metadataAction("opaque-conquest", "attack", {
        targetID: "RIVAL",
        troopPercent: 25,
      }),
      metadataAction("opaque-politics", "alliance_extend", {
        targetID: "ALLY",
      }),
    ];
    const expertWorld = buildKeystoneWorldModel(
      brainInput({
        turnNumber: 2_000,
        actions: expertActions,
        players: [rival, ally],
      }),
      { planAlignedActionIDs: ["opaque-politics"] },
    );
    const expertProposals = [
      proposeKeystoneExpansion(expertWorld),
      proposeKeystoneEconomy(expertWorld),
      proposeKeystoneConquest(expertWorld),
      proposeKeystonePolitics(expertWorld),
    ].flatMap((proposal) => (proposal === null ? [] : [proposal]));
    expect(expertProposals.map((proposal) => proposal.source).sort()).toEqual([
      "conquest",
      "economy",
      "expansion",
      "politics",
    ]);
    expect(
      arbitrateKeystoneAction(expertWorld, tiersFromRealProposers(expertWorld))
        .selection,
    ).toMatchObject({
      actionID: "opaque-politics",
      tier: "expert_auction",
      planAligned: true,
    });

    const pressuredWorld = buildKeystoneWorldModel(
      brainInput({
        turnNumber: 2_000,
        actions: [...expertActions, action("opaque-retreat", "retreat")],
        players: [rival, ally, player("AGGRESSOR", { incomingAttack: true })],
      }),
    );
    const survival = proposeKeystoneSurvival(pressuredWorld);
    expect(survival).not.toBeNull();
    expect(
      arbitrateKeystoneAction(
        pressuredWorld,
        tiersFromRealProposers(pressuredWorld),
      ).selection,
    ).toMatchObject({ actionID: "opaque-retreat", tier: "survival" });

    const spawnWorld = buildKeystoneWorldModel(
      brainInput({
        phase: "spawn",
        actions: [action("opaque-spawn", "spawn", null, 0.2)],
      }),
    );
    expect(
      arbitrateKeystoneAction(spawnWorld, tiersFromRealProposers(spawnWorld))
        .selection,
    ).toMatchObject({ actionID: "opaque-spawn", tier: "spawn" });
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
    const proposals = [
      expert("b", b.id, { source: "economy" }),
      expert("a", a.id, { source: "economy" }),
    ];
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
