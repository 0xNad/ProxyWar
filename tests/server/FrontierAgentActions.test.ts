import { describe, expect, it } from "vitest";
import { ClientIntentMessageSchema } from "../../src/core/Schemas";
import { PlayerType, Relation, UnitType } from "../../src/core/game/Game";
import {
  validateAgentDecision,
  validateAgentDecisionBatch,
} from "../../src/server/agents/AgentDecisionValidator";
import {
  AgentObservationBuilder,
  emojiReactionForPlayer,
  quickChatForPlayer,
} from "../../src/server/agents/AgentObservationBuilder";
import {
  FrontierPolicyExecutor,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import {
  AgentObservation,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
  legalActionKinds,
} from "../../src/server/agents/AgentTypes";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { LlmPromptBuilder } from "../../src/server/agents/LlmPromptBuilder";

const autonomousGameplayKinds = legalActionKinds.filter(
  (kind) => kind !== "hold",
);

describe("FrontierAgent expanded legal action surface", () => {
  it("discovers every autonomous gameplay action kind and emits schema-valid intents", () => {
    const activeActions = new LegalActionBuilder().build({
      observation: expandedObservation(),
      maxPostSpawnActions: 120,
    });
    const spawnActions = new LegalActionBuilder().build({
      observation: {
        ...expandedObservation(),
        phase: "spawn",
      },
      spawnCandidates: [
        {
          tile: 10,
          x: 5,
          y: 5,
          pressureScore: 0.2,
          safetyScore: 0.9,
          diplomacyScore: 0.7,
          opportunityScore: 0.8,
        },
      ],
    });
    const actions = [...activeActions, ...spawnActions];
    const kinds = new Set(actions.map((action) => action.kind));

    for (const kind of autonomousGameplayKinds) {
      expect(kinds.has(kind), `${kind} should be offered`).toBe(true);
    }

    for (const action of actions) {
      if (action.intent !== null) {
        expect(() =>
          ClientIntentMessageSchema.parse({
            type: "intent",
            intent: action.intent,
          }),
        ).not.toThrow();
      }
    }
  });

  it("keeps map-wide spawn scouts in the legal action list", () => {
    const clusteredCandidates = Array.from({ length: 24 }, (_, index) => ({
      tile: 1_000 + index,
      x: 100 + (index % 4),
      y: 100 + Math.floor(index / 4),
      pressureScore: 0.64,
      safetyScore: 0.34,
      diplomacyScore: 0.82,
      opportunityScore: 0.92 - index * 0.002,
      localLandScore: 0.99,
    }));
    const distantScout = {
      tile: 9_001,
      x: 15,
      y: 270,
      pressureScore: 0.56,
      safetyScore: 0.38,
      diplomacyScore: 0.74,
      opportunityScore: 0.84,
      localLandScore: 0.97,
    };

    const actions = new LegalActionBuilder().build({
      observation: {
        ...expandedObservation(),
        phase: "spawn",
      },
      spawnCandidates: [...clusteredCandidates, distantScout],
      maxSpawnActions: 8,
    });

    expect(actions.map((action) => action.id)).toContain("spawn:9001");
  });

  it("offers only hold after an agent has been eliminated", () => {
    const observation = expandedObservation();
    observation.ownState = {
      ...observation.ownState!,
      isAlive: false,
      tilesOwned: 0,
    };

    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 120,
    });

    expect(actions.map((action) => action.kind)).toEqual(["hold"]);
  });

  it("submits land structure builds at the proven build tile", () => {
    const observation = expandedObservation();
    observation.nonCombat.buildOptions = [
      {
        unit: UnitType.DefensePost,
        role: "defensive",
        targetTile: 200,
        buildTile: 205,
        cost: "50000",
        legalReason: "core canBuild(Defense Post) returned build tile 205",
        isBorderBuild: true,
        hostileBorderDistance: 1,
        frontierValue: 1,
        defensiveValue: 0.9,
      },
    ];
    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 20,
    });

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "build:Defense Post:205",
          intent: {
            type: "build_unit",
            unit: UnitType.DefensePost,
            tile: 205,
          },
          metadata: expect.objectContaining({
            targetTile: 200,
            buildTile: 205,
          }),
        }),
      ]),
    );
  });

  it("offers decisive player transports when naval conversion is needed", () => {
    const observation = expandedObservation();
    observation.ownState = {
      ...observation.ownState!,
      troops: 1_000_000,
      tileShare: 0.64,
    };
    observation.combat = {
      ...observation.combat,
      attackablePlayerIDs: [],
      borderedPlayerIDs: [],
      canExpandIntoNeutral: false,
    };
    observation.nonCombat.boatOptions = [
      {
        targetTile: 444,
        sourceTile: 111,
        targetID: "RIVAL001",
        targetName: "Rival",
        troops: 80_000,
        legalReason: "test player transport",
      },
    ];

    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 40,
    });

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "boat:444:8",
          intent: expect.objectContaining({ troops: 80_000 }),
        }),
        expect.objectContaining({
          id: "boat:444:16",
          intent: expect.objectContaining({ troops: 160_000 }),
        }),
        expect.objectContaining({
          id: "boat:444:25",
          intent: expect.objectContaining({ troops: 250_000 }),
        }),
      ]),
    );
  });

  it("offers committed neutral island transports when troops are healthy", () => {
    const observation = expandedObservation();
    observation.ownState = {
      ...observation.ownState!,
      troops: 200_000,
      maxTroops: 320_000,
      troopRatio: 0.63,
    };
    observation.combat = {
      ...observation.combat,
      ownTroops: 200_000,
      maxTroops: 320_000,
      troopRatio: 0.63,
      canExpandIntoNeutral: false,
      neutralExpansionLegalReason: null,
      borderedPlayerIDs: [],
      attackablePlayerIDs: [],
    };
    observation.nonCombat.boatOptions = [
      {
        targetTile: 444,
        sourceTile: 111,
        targetID: null,
        targetName: "Terra Nullius",
        troops: 16_000,
        legalReason: "test neutral island transport",
      },
    ];

    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 40,
    });

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "boat:444:8",
          metadata: expect.objectContaining({ targetID: null }),
        }),
        expect.objectContaining({
          id: "boat:444:16",
          metadata: expect.objectContaining({ targetID: null }),
        }),
        expect.objectContaining({
          id: "boat:444:25",
          metadata: expect.objectContaining({ targetID: null }),
        }),
      ]),
    );
  });

  it("does not offer build or upgrade actions that cannot be afforded", () => {
    const observation = expandedObservation();
    observation.ownState = {
      ...observation.ownState!,
      gold: "4999",
    };
    observation.nonCombat.buildOptions = [
      {
        unit: UnitType.DefensePost,
        role: "defensive",
        targetTile: 200,
        buildTile: 205,
        cost: "5000",
        legalReason: "spatially buildable but unaffordable",
      },
    ];
    observation.nonCombat.upgradeOptions = [
      {
        unitID: 3,
        unit: UnitType.City,
        tile: 20,
        level: 1,
        cost: "5000",
        legalReason: "upgrade exists but unaffordable",
      },
    ];

    const actions = new LegalActionBuilder().build({
      observation,
      maxPostSpawnActions: 20,
    });

    expect(actions.map((action) => action.id)).not.toContain(
      "build:Defense Post:205",
    );
    expect(actions.map((action) => action.id)).not.toContain("upgrade:City:3");
  });

  it("uses validation fallback when a brain invents an action id", () => {
    const hold = holdAction();
    const validation = validateAgentDecision(
      {
        actionID: "invented:admin:kick",
        reason: "bad planner output",
      },
      [hold],
    );

    expect(validation).toMatchObject({
      ok: false,
      fallback: hold,
    });
  });

  it("validates ordered action batches and drops invented ids", () => {
    const expand = actionForKind("attack");
    const build = actionForKind("build");
    const hold = holdAction();
    const validation = validateAgentDecisionBatch(
      {
        actionID: expand.id,
        actionIDs: [expand.id, "invented:admin:kick", build.id, build.id],
        reason: "module batch",
      },
      [expand, build, hold],
    );

    expect(validation.ok).toBe(false);
    expect(validation.actions.map((action) => action.id)).toEqual([
      expand.id,
      build.id,
    ]);
    expect(validation.rejectedActionIDs).toEqual(["invented:admin:kick"]);
  });

  it.each(autonomousGameplayKinds)(
    "FrontierPolicyExecutor can select %s when it is the strategic legal option",
    (kind) => {
      const action = actionForKind(kind);
      const observation = observationForKind(kind);
      const plan: StrategicPlan = {
        planID: `test:${kind}`,
        objective: objectiveForKind(kind),
        targetPlayerId: targetForKind(kind),
        rationale: `prefer ${kind}`,
        startedAtTick: observation.tick,
        maxDecisionCycles: 1,
        successCriteria: [`select ${kind}`],
        failureCriteria: ["hold selected instead"],
        preferredActionKinds: [kind],
        forbiddenActionKinds: [],
        plannerSource: "mock-llm",
      };

      const decision = new FrontierPolicyExecutor("opportunistic", {
        settings: { openingExpansionTempoEnabled: false },
      }).decide(
        {
          observation,
          legalActions: [action, holdAction()],
        },
        plan,
      );
      expect(decision.actionID).toBe(action.id);
      expect(decision.planFollowed).toBe(true);
    },
  );

  it("loads FrontierAgent skill text into LLM prompts", () => {
    const prompt = new LlmPromptBuilder().build({
      observation: expandedObservation(),
      legalActions: [holdAction()],
    });

    expect(prompt).toContain("FRONTIER_AGENT_SKILL");
    expect(prompt).toContain("Decision Contract");
    expect(prompt).toContain("LegalAction.id");
  });

  it("maps social context to expressive emoji and public chat choices", () => {
    const betrayer = visiblePlayer("ALLY0001", {
      name: "False Ally",
      isAllied: true,
      canBreakAlliance: true,
    });
    const clownTarget = visiblePlayer("WEAK0001", {
      name: "Overextended Rival",
      canAttack: true,
      relativeTroopRatio: 1.7,
    });
    const pressureTarget = visiblePlayer("RIVAL001", {
      name: "Border Rival",
      canAttack: true,
      relativeTroopRatio: 1.05,
    });
    const friend = visiblePlayer("FRND0001", {
      name: "Useful Buffer",
      canRequestAlliance: true,
    });

    expect(emojiReactionForPlayer(betrayer)).toMatchObject({
      emoji: 10,
      context: "betrayal_signal",
    });
    expect(emojiReactionForPlayer(clownTarget)).toMatchObject({
      emoji: 11,
      context: "mock_overextended_target",
    });
    expect(quickChatForPlayer(clownTarget)).toMatchObject({
      key: "attack.finish",
      message:
        "The table is open. Carve up Overextended Rival before they recover.",
    });
    expect(emojiReactionForPlayer(pressureTarget)).toMatchObject({
      emoji: 41,
      context: "pressure_target",
    });
    expect(quickChatForPlayer(pressureTarget)).toMatchObject({
      key: "attack.focus",
      message:
        "Pressure Border Rival; whoever joins gets my quiet border.",
    });
    expect(emojiReactionForPlayer(friend)).toMatchObject({
      emoji: 25,
      context: "alliance_signal",
    });
    expect(quickChatForPlayer(friend)).toMatchObject({
      key: "misc.team_up",
      message:
        "Useful Buffer, sign early and I remember. Delay and I shop elsewhere.",
    });
    expect(quickChatForPlayer(betrayer)).toMatchObject({
      key: "misc.team_up",
      message:
        "False Ally, I can keep this pact or open your border. Convince me.",
    });
  });
});

function expandedObservation(): AgentObservation {
  const base = new AgentObservationBuilder().build({
    agentID: "frontier-agent",
    clientID: null,
    username: "Frontier Agent",
    profile: "opportunistic",
    gameID: "TEST0001",
    turnNumber: 20,
    phaseOverride: "active",
  });
  const rival = visiblePlayer("RIVAL001", {
    name: "Rival",
    sharesBorder: true,
    canAttack: true,
    canEmbargo: true,
    canTarget: true,
    relativeTroopRatio: 1.6,
    troops: 4_000,
    tileShare: 0.18,
  });
  const ally = visiblePlayer("ALLY0001", {
    name: "Ally",
    isAllied: true,
    isFriendly: true,
    canDonateGold: true,
    canDonateTroops: true,
    canExtendAlliance: true,
    relation: Relation.Friendly,
  });
  const requester = visiblePlayer("REQ00001", {
    name: "Requester",
    canRejectAlliance: true,
    hasIncomingAllianceRequest: true,
  });
  const friend = visiblePlayer("FRND0001", {
    name: "Friend",
    canRequestAlliance: true,
  });

  return {
    ...base,
    ownState: {
      playerID: "AGENT001",
      clientID: "CLIENT01",
      smallID: 1,
      name: "Frontier",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 12_000,
      maxTroops: 20_000,
      troopRatio: 0.6,
      gold: "250000",
      tilesOwned: 300,
      tileShare: 0.25,
      borderTiles: 80,
      outgoingAttacks: 1,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
      spawnTile: 12,
    },
    visiblePlayers: [rival, ally, requester, friend],
    combat: {
      ownTroops: 12_000,
      maxTroops: 20_000,
      troopRatio: 0.6,
      borderedPlayerIDs: ["RIVAL001"],
      attackablePlayerIDs: ["RIVAL001"],
      canExpandIntoNeutral: true,
      neutralExpansionLegalReason: "test neutral expansion",
      incomingAttackPlayerIDs: [],
      outgoingAttackPlayerIDs: ["RIVAL001"],
      outgoingAttacks: [
        {
          attackID: "attack-1",
          targetID: "RIVAL001",
          targetName: "Rival",
          troops: 2_000,
          retreating: false,
          sourceTile: 22,
          borderSize: 4,
        },
      ],
      incomingAttacks: [],
      weakestAttackableTargetID: "RIVAL001",
      strongestAttackableTargetID: "RIVAL001",
      blockerNotes: [],
    },
    nonCombat: {
      buildOptions: [
        {
          unit: UnitType.City,
          role: "economic",
          targetTile: 20,
          buildTile: 20,
          cost: "1000",
          legalReason: "test",
        },
        {
          unit: UnitType.Warship,
          role: "defensive",
          targetTile: 300,
          buildTile: 300,
          cost: "5000",
          legalReason: "test",
        },
        {
          unit: UnitType.MIRV,
          role: "infrastructure",
          targetTile: 77,
          buildTile: 77,
          cost: "100000",
          legalReason: "test",
        },
      ],
      upgradeOptions: [
        {
          unitID: 3,
          unit: UnitType.City,
          tile: 20,
          level: 1,
          cost: "2000",
          legalReason: "test",
        },
      ],
      deleteUnitOptions: [
        {
          unitID: 9,
          unit: UnitType.DefensePost,
          tile: 88,
          level: 1,
          legalReason: "test",
        },
      ],
      boatOptions: [
        {
          targetTile: 444,
          sourceTile: 111,
          targetID: null,
          targetName: "Terra Nullius",
          troops: 900,
          legalReason: "test",
        },
      ],
      boatRetreatOptions: [
        {
          unitID: 7,
          tile: 30,
          targetTile: 444,
          troops: 700,
          legalReason: "test",
        },
      ],
      warshipMoveOptions: [
        {
          unitIDs: [5],
          targetTile: 700,
          legalReason: "test",
        },
      ],
      allianceOptions: [
        {
          playerID: "REQ00001",
          playerName: "Requester",
          action: "reject",
          legalReason: "test",
        },
        {
          playerID: "ALLY0001",
          playerName: "Ally",
          action: "extend",
          legalReason: "test",
        },
        {
          playerID: "RIVAL001",
          playerName: "Rival",
          action: "break",
          legalReason: "test",
        },
      ],
      targetOptions: [
        {
          targetID: "RIVAL001",
          targetName: "Rival",
          legalReason: "test",
        },
      ],
      emojiOptions: [
        {
          recipientID: "ALLY0001",
          recipientName: "Ally",
          emoji: 0,
          legalReason: "test",
        },
      ],
      quickChatOptions: [
        {
          recipientID: "ALLY0001",
          recipientName: "Ally",
          quickChatKey: "help.troops",
          legalReason: "test",
        },
      ],
      supportOptions: [
        {
          recipientID: "ALLY0001",
          recipientName: "Ally",
          canDonateGold: true,
          canDonateTroops: true,
          suggestedGold: 1_000,
          suggestedTroops: 500,
          legalReasons: ["test"],
        },
      ],
      embargoOptions: [
        {
          targetID: "RIVAL001",
          targetName: "Rival",
          action: "start",
          legalReason: "test",
        },
        {
          targetID: "REQ00001",
          targetName: "Requester",
          action: "stop",
          legalReason: "test",
        },
      ],
      canEmbargoAll: true,
      blockerNotes: [],
    },
    endgame: {
      winner: null,
      leaderID: "RIVAL001",
      leaderName: "Rival",
      leaderTileShare: 0.28,
      ownTileShare: 0.25,
      turnsToTimer: 5_000,
    },
  };
}

function observationForKind(kind: LegalActionKind): AgentObservation {
  const observation = expandedObservation();
  if (
    kind === "alliance_reject" ||
    kind === "target_player" ||
    kind === "embargo" ||
    kind === "embargo_all"
  ) {
    const relevantPlayerID =
      kind === "alliance_reject" ? "REQ00001" : "RIVAL001";
    return {
      ...observation,
      ownState:
        observation.ownState === null
          ? null
          : {
              ...observation.ownState,
              outgoingAttacks: 0,
            },
      visiblePlayers: observation.visiblePlayers.filter(
        (player) => player.playerID === relevantPlayerID,
      ),
      combat: {
        ...observation.combat,
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        outgoingAttackPlayerIDs: [],
        outgoingAttacks: [],
      },
      endgame: {
        ...observation.endgame!,
        leaderID: relevantPlayerID,
        leaderName: relevantPlayerID === "REQ00001" ? "Requester" : "Rival",
        leaderTileShare: 0.18,
        ownTileShare: 0.25,
      },
    };
  }
  if (kind === "break_alliance") {
    return {
      ...observation,
      visiblePlayers: observation.visiblePlayers.filter(
        (player) => player.playerID === "RIVAL001",
      ),
      combat: {
        ...observation.combat,
        borderedPlayerIDs: ["RIVAL001"],
        attackablePlayerIDs: ["RIVAL001"],
        weakestAttackableTargetID: "RIVAL001",
        strongestAttackableTargetID: "RIVAL001",
      },
      endgame: {
        ...observation.endgame!,
        leaderID: "RIVAL001",
        leaderName: "Rival",
        leaderTileShare: 0.18,
        ownTileShare: 0.25,
      },
    };
  }
  if (kind !== "retreat" && kind !== "boat_retreat") {
    return observation;
  }
  return {
    ...observation,
    combat: {
      ...observation.combat,
      incomingAttackPlayerIDs: ["RIVAL001"],
      incomingAttacks: [
        {
          attackID: "incoming-1",
          targetID: "RIVAL001",
          targetName: "Rival",
          troops: 2_500,
          retreating: false,
          sourceTile: 33,
          borderSize: 5,
        },
      ],
    },
  };
}

function visiblePlayer(
  playerID: string,
  overrides: Partial<AgentVisiblePlayer>,
): AgentVisiblePlayer {
  return {
    playerID,
    clientID: `${playerID}C`.slice(0, 8),
    smallID: 2,
    name: playerID,
    type: PlayerType.Nation,
    isAlive: true,
    isDisconnected: false,
    hasSpawned: true,
    troops: 3_000,
    maxTroops: 8_000,
    troopRatio: 0.38,
    gold: "10000",
    tilesOwned: 80,
    tileShare: 0.08,
    sharesBorder: false,
    isAllied: false,
    isFriendly: false,
    relation: Relation.Neutral,
    canAttack: false,
    canRequestAlliance: false,
    canDonateGold: false,
    canDonateTroops: false,
    canEmbargo: false,
    canStopEmbargo: false,
    canTarget: false,
    canBreakAlliance: false,
    canExtendAlliance: false,
    canRejectAlliance: false,
    hasEmbargoAgainst: false,
    outgoingAttack: false,
    incomingAttack: false,
    hasOutgoingAllianceRequest: false,
    hasIncomingAllianceRequest: false,
    ...overrides,
  };
}

function actionForKind(kind: LegalActionKind): LegalAction {
  const actions = new LegalActionBuilder().build({
    observation:
      kind === "spawn"
        ? { ...expandedObservation(), phase: "spawn" }
        : expandedObservation(),
    spawnCandidates: [
      {
        tile: 10,
        x: 5,
        y: 5,
        pressureScore: 0.2,
        safetyScore: 0.9,
        diplomacyScore: 0.7,
        opportunityScore: 0.8,
      },
    ],
    maxPostSpawnActions: 120,
  });
  const action = actions.find((candidate) => candidate.kind === kind);
  if (action === undefined) {
    throw new Error(`missing action for kind ${kind}`);
  }
  return action;
}

function objectiveForKind(kind: LegalActionKind): StrategicPlan["objective"] {
  switch (kind) {
    case "spawn":
      return "choose_spawn";
    case "attack":
      return "pressure_rival";
    case "boat":
      return "expand_territory";
    case "build":
    case "upgrade_structure":
      return "secure_economy";
    case "retreat":
    case "boat_retreat":
    case "warship":
    case "move_warship":
      return "fortify_border";
    case "alliance_request":
    case "alliance_extend":
    case "donate_gold":
    case "donate_troops":
    case "embargo_stop":
    case "quick_chat":
    case "emoji":
      return "build_alliance";
    case "alliance_reject":
    case "break_alliance":
    case "target_player":
    case "nuke":
    case "embargo":
    case "embargo_all":
      return "pressure_rival";
    case "delete_unit":
    case "hold":
      return "survive";
  }
}

function targetForKind(kind: LegalActionKind): string | null {
  return ["attack", "break_alliance", "nuke"].includes(kind)
    ? "RIVAL001"
    : null;
}

function holdAction(): LegalAction {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold",
    intent: null,
    risk: { level: "none", score: 0 },
  };
}
