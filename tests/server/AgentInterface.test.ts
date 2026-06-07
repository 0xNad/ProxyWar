import { describe, expect, it } from "vitest";
import {
  PlayerInfo,
  PlayerType,
  Relation,
  UnitType,
} from "../../src/core/game/Game";
import { validateAgentDecision } from "../../src/server/agents/AgentDecisionValidator";
import { AgentMemoryBuilder } from "../../src/server/agents/AgentMemoryBuilder";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import {
  actionAlignsWithObjective,
  AgentObjectiveManager,
} from "../../src/server/agents/AgentObjectiveManager";
import { AgentStrategicStateBuilder } from "../../src/server/agents/AgentStrategicStateBuilder";
import type {
  AgentObservation,
  AgentOwnState,
  AgentVisiblePlayer,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import {
  buildSpawnCandidates,
  LegalActionBuilder,
} from "../../src/server/agents/LegalActionBuilder";
import { RuleAgentBrain } from "../../src/server/agents/RuleAgentBrain";
import { setup } from "../util/Setup";

describe("AI Nations League agent interface", () => {
  it("builds a stable observation object from a core game snapshot", async () => {
    const player = new PlayerInfo(
      "Agent One",
      PlayerType.Human,
      "CLNT0001",
      "PLAYER01",
    );
    const game = await setup("half_land_half_ocean", { nations: "disabled" }, [
      player,
    ]);

    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: "CLNT0001",
      username: "Agent One",
      profile: "aggressive",
      gameID: "AGENTOBS",
      turnNumber: 7,
      gameState: game,
    });

    expect(observation).toMatchObject({
      agentID: "agent-1",
      clientID: "CLNT0001",
      username: "Agent One",
      profile: "aggressive",
      gameID: "AGENTOBS",
      phase: "spawn",
      turnNumber: 7,
      ownState: {
        playerID: "PLAYER01",
        clientID: "CLNT0001",
        name: "Agent One",
        type: PlayerType.Human,
        isAlive: false,
        hasSpawned: false,
        troops: expect.any(Number),
        tilesOwned: 0,
      },
      visiblePlayers: [],
      nonCombat: {
        buildOptions: [],
        supportOptions: [],
        embargoOptions: [],
        blockerNotes: expect.any(Array),
      },
      strategic: {
        priority: "spawn",
        urgency: "high",
        recommendedActionKinds: ["spawn", "hold"],
      },
      memory: {
        recentActions: [],
        recentNonHoldCount: 0,
        summary: "no recent agent decisions",
      },
      recentDecisions: [],
      notes: [],
    });
  });

  it("offers proven build, support, and embargo candidates from observation", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "defensive",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "active",
    });
    const legalActions = new LegalActionBuilder().build({
      observation: {
        ...observation,
        nonCombat: {
          buildOptions: [
            {
              unit: UnitType.DefensePost,
              role: "defensive",
              targetTile: 101,
              buildTile: 101,
              cost: "50000",
              legalReason:
                "core canBuild(Defense Post) returned build tile 101",
            },
          ],
          supportOptions: [
            {
              recipientID: "ALLY0001",
              recipientName: "Ally One",
              canDonateGold: true,
              canDonateTroops: true,
              suggestedGold: 1000,
              suggestedTroops: 50,
              legalReasons: [
                "core canDonateGold returned true",
                "core canDonateTroops returned true",
              ],
            },
          ],
          embargoOptions: [
            {
              targetID: "RIVAL001",
              targetName: "Rival One",
              action: "start",
              legalReason:
                "target is alive, not friendly, and no existing embargo is active",
            },
          ],
          blockerNotes: [],
        },
      },
    });

    expect(legalActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "build:Defense Post:101",
          kind: "build",
          intent: {
            type: "build_unit",
            unit: UnitType.DefensePost,
            tile: 101,
          },
        }),
        expect.objectContaining({
          id: "donate_troops:ALLY0001",
          kind: "donate_troops",
          intent: {
            type: "donate_troops",
            recipient: "ALLY0001",
            troops: 50,
          },
        }),
        expect.objectContaining({
          id: "donate_gold:ALLY0001",
          kind: "donate_gold",
          intent: {
            type: "donate_gold",
            recipient: "ALLY0001",
            gold: 1000,
          },
        }),
        expect.objectContaining({
          id: "embargo:RIVAL001:start",
          kind: "embargo",
          intent: {
            type: "embargo",
            targetID: "RIVAL001",
            action: "start",
          },
        }),
      ]),
    );
  });

  it("prioritizes defensive builds for defensive agents on hostile borders", () => {
    const ownState: AgentOwnState = {
      playerID: "PLAYER01",
      clientID: "CLNT0001",
      smallID: 1,
      name: "Defensive Agent",
      type: PlayerType.Human,
      isAlive: true,
      isDisconnected: false,
      isTraitor: false,
      hasSpawned: true,
      troops: 100_000,
      gold: "200000",
      tilesOwned: 300,
      borderTiles: 20,
      outgoingAttacks: 0,
      incomingAttacks: 0,
      outgoingAllianceRequests: 0,
      incomingAllianceRequests: 0,
    };
    const visiblePlayers: AgentVisiblePlayer[] = [
      {
        playerID: "TARGET01",
        clientID: "CLNT0002",
        smallID: 2,
        name: "Border Rival",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        hasSpawned: true,
        troops: 90_000,
        gold: "100000",
        tilesOwned: 250,
        sharesBorder: true,
        isAllied: false,
        isFriendly: false,
        relation: Relation.Neutral,
        canAttack: true,
        attackLegalReason: "shares border and core canAttackPlayer is true",
        canRequestAlliance: false,
        canDonateGold: false,
        canDonateTroops: false,
        canEmbargo: true,
        hasEmbargoAgainst: false,
        outgoingAttack: false,
        incomingAttack: false,
        hasOutgoingAllianceRequest: false,
        hasIncomingAllianceRequest: false,
        relativeTroopRatio: 1.11,
      },
    ];

    const strategic = new AgentStrategicStateBuilder().build({
      profile: "defensive",
      phase: "active",
      ownState,
      visiblePlayers,
      combat: {
        ownTroops: ownState.troops,
        borderedPlayerIDs: ["TARGET01"],
        attackablePlayerIDs: ["TARGET01"],
        canExpandIntoNeutral: true,
        neutralExpansionLegalReason:
          "player is alive, spawned, and core nearby() includes Terra Nullius",
        incomingAttackPlayerIDs: [],
        outgoingAttackPlayerIDs: [],
        weakestAttackableTargetID: "TARGET01",
        strongestAttackableTargetID: "TARGET01",
        blockerNotes: [],
      },
      nonCombat: {
        buildOptions: [
          {
            unit: UnitType.DefensePost,
            role: "defensive",
            targetTile: 101,
            buildTile: 101,
            cost: "50000",
            legalReason:
              "core canBuild(Defense Post) returned build tile 101",
          },
        ],
        supportOptions: [],
        embargoOptions: [],
        blockerNotes: [],
      },
    });

    expect(strategic).toMatchObject({
      priority: "build_defense",
      urgency: "medium",
      recommendedActionKinds: ["build", "alliance_request", "attack", "hold"],
    });
  });

  it("restrains expansion and flips to defense when over-extended against strong borders", () => {
    const buildStrategic = (ownTroops: number) =>
      new AgentStrategicStateBuilder().build({
        profile: "aggressive",
        phase: "active",
        ownState: {
          playerID: "PLAYER01",
          clientID: "CLNT0001",
          smallID: 1,
          name: "Over-extended Agent",
          type: PlayerType.Human,
          isAlive: true,
          isDisconnected: false,
          isTraitor: false,
          hasSpawned: true,
          troops: ownTroops,
          gold: "200000",
          tilesOwned: 2000,
          borderTiles: 400,
          outgoingAttacks: 0,
          incomingAttacks: 0,
          outgoingAllianceRequests: 0,
          incomingAllianceRequests: 0,
        },
        visiblePlayers: [1, 2].map((n) => ({
          playerID: `RIVAL0${n}`,
          clientID: `CLNT000${n}`,
          smallID: n + 1,
          name: `Strong Rival ${n}`,
          type: PlayerType.Human,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 400_000,
          gold: "100000",
          tilesOwned: 2500,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Hostile,
          canAttack: true,
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: ownTroops / 400_000,
        })),
        combat: {
          ownTroops,
          borderedPlayerIDs: ["RIVAL01", "RIVAL02"],
          attackablePlayerIDs: ["RIVAL01", "RIVAL02"],
          canExpandIntoNeutral: true,
          neutralExpansionLegalReason: "neutral land nearby",
          incomingAttackPlayerIDs: [],
          outgoingAttackPlayerIDs: [],
          weakestAttackableTargetID: "RIVAL01",
          strongestAttackableTargetID: "RIVAL01",
          blockerNotes: [],
        },
        nonCombat: {
          buildOptions: [],
          supportOptions: [],
          embargoOptions: [],
          blockerNotes: [],
        },
      });

    // Over-extended: 2000 tiles, thin reserves (idleTroops ~0.2), 2 stronger borders.
    const overExtended = buildStrategic(100_000);
    expect(overExtended.scores.expansion).toBe(0.15);
    expect(overExtended.scores.defense).toBeGreaterThanOrEqual(0.9);
    expect(overExtended.priority).toBe("build_defense");

    // Same perimeter but thick reserves (and no stronger borders) -> NOT over-extended,
    // so the opening/healthy land-grab drive is preserved.
    const healthy = buildStrategic(600_000);
    expect(healthy.scores.expansion).toBe(0.9);
  });

  it("offers legal spawn candidates before an agent has spawned", async () => {
    const game = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(game.map(), {
      maxCandidates: 4,
    });
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "defensive",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "spawn",
    });

    const legalActions = new LegalActionBuilder().build({
      observation,
      spawnCandidates,
      maxSpawnActions: 3,
    });

    expect(
      legalActions.filter((action) => action.kind === "spawn"),
    ).toHaveLength(3);
    expect(legalActions.some((action) => action.id === "hold")).toBe(true);
    expect(legalActions[0]).toMatchObject({
      kind: "spawn",
      intent: { type: "spawn" },
    });
  });

  it("has a rule brain choose one of the offered legal actions", async () => {
    const game = await setup("big_plains", { nations: "disabled" });
    const spawnCandidates = buildSpawnCandidates(game.map(), {
      maxCandidates: 8,
    });
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "opportunistic",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "spawn",
    });
    const legalActions = new LegalActionBuilder().build({
      observation,
      spawnCandidates,
    });

    const decision = new RuleAgentBrain("opportunistic").decide({
      observation,
      legalActions,
    });

    expect(legalActions.map((action) => action.id)).toContain(
      decision.actionID,
    );
    expect(validateAgentDecision(decision, legalActions).ok).toBe(true);
  });

  it("offers post-spawn attack candidates when observation marks them valid", () => {
    const observation: AgentObservation = {
      agentID: "agent-1",
      clientID: "CLNT0001",
      username: "Agent One",
      profile: "aggressive",
      gameID: "AGENTOBS",
      phase: "active",
      turnNumber: 3,
      tick: 120,
      ownState: {
        playerID: "PLAYER01",
        clientID: "CLNT0001",
        smallID: 1,
        name: "Agent One",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 100,
        gold: "50",
        tilesOwned: 20,
        borderTiles: 6,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      visiblePlayers: [
        {
          playerID: "TARGET01",
          clientID: "CLNT0002",
          smallID: 2,
          name: "Target Two",
          type: PlayerType.Human,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 20,
          gold: "10",
          tilesOwned: 8,
          sharesBorder: true,
          isAllied: false,
          isFriendly: false,
          relation: Relation.Neutral,
          canAttack: true,
          attackLegalReason: "shares border and core canAttackPlayer is true",
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: true,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 5,
        },
      ],
      combat: {
        ownTroops: 100,
        borderedPlayerIDs: ["TARGET01"],
        attackablePlayerIDs: ["TARGET01"],
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        incomingAttackPlayerIDs: [],
        outgoingAttackPlayerIDs: [],
        weakestAttackableTargetID: "TARGET01",
        strongestAttackableTargetID: "TARGET01",
        blockerNotes: [],
      },
      nonCombat: {
        buildOptions: [],
        supportOptions: [],
        embargoOptions: [
          {
            targetID: "TARGET01",
            targetName: "Target Two",
            action: "start",
            legalReason:
              "target is alive, not friendly, and no existing embargo is active",
          },
        ],
        blockerNotes: [],
      },
      strategic: {
        priority: "attack",
        urgency: "medium",
        summary:
          "priority=attack, urgency=medium, expand=0, economy=0, offense=1, defense=0, threat=0.45",
        scores: {
          expansion: 0,
          economy: 0,
          defense: 0,
          offense: 1,
          diplomacy: 0,
          threat: 0.45,
          idleTroops: 0,
        },
        recommendedActionKinds: ["attack", "build", "embargo", "hold"],
        targetPlayerIDs: ["TARGET01"],
        notes: [],
      },
      memory: new AgentMemoryBuilder().build(),
      objective: null,
      recentDecisions: [],
      notes: [],
    };

    const legalActions = new LegalActionBuilder().build({ observation });
    const decision = new RuleAgentBrain("aggressive").decide({
      observation,
      legalActions,
    });
    const validation = validateAgentDecision(decision, legalActions);

    expect(legalActions).toContainEqual(
      expect.objectContaining({
        id: "attack:TARGET01:25",
        kind: "attack",
        intent: {
          type: "attack",
          targetID: "TARGET01",
          troops: 25,
        },
        metadata: expect.objectContaining({
          targetID: "TARGET01",
          troopPercent: 25,
          legalReason: "shares border and core canAttackPlayer is true",
        }),
      }),
    );
    expect(validation).toMatchObject({
      ok: true,
      action: { kind: "attack" },
    });
  });

  it("does not offer attacks against friendly players even if a snapshot says canAttack", () => {
    const base = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: "CLNT0001",
      username: "Agent One",
      profile: "aggressive",
      gameID: "AGENTOBS",
      turnNumber: 3,
      phaseOverride: "active",
    });
    const observation: AgentObservation = {
      ...base,
      ownState: {
        playerID: "PLAYER01",
        clientID: "CLNT0001",
        smallID: 1,
        name: "Agent One",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 100,
        gold: "50",
        tilesOwned: 20,
        borderTiles: 6,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      visiblePlayers: [
        {
          playerID: "FRIEND01",
          clientID: "CLNT0002",
          smallID: 2,
          name: "Friendly Neighbor",
          type: PlayerType.Human,
          isAlive: true,
          isDisconnected: false,
          hasSpawned: true,
          troops: 20,
          gold: "10",
          tilesOwned: 8,
          sharesBorder: true,
          isAllied: false,
          isFriendly: true,
          relation: Relation.Friendly,
          canAttack: true,
          attackLegalReason: "stale snapshot said canAttack=true",
          canRequestAlliance: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: false,
          hasEmbargoAgainst: false,
          outgoingAttack: false,
          incomingAttack: false,
          hasOutgoingAllianceRequest: false,
          hasIncomingAllianceRequest: false,
          relativeTroopRatio: 5,
        },
      ],
      combat: {
        ...base.combat,
        ownTroops: 100,
        borderedPlayerIDs: ["FRIEND01"],
        attackablePlayerIDs: [],
        canExpandIntoNeutral: false,
        neutralExpansionLegalReason: null,
        weakestAttackableTargetID: null,
        strongestAttackableTargetID: null,
      },
      strategic: {
        ...base.strategic,
        priority: "attack",
        urgency: "medium",
        recommendedActionKinds: ["attack", "hold"],
        targetPlayerIDs: [],
      },
    };

    const legalActions = new LegalActionBuilder().build({ observation });

    expect(legalActions.map((action) => action.id)).not.toContain(
      "attack:FRIEND01:10",
    );
    expect(
      legalActions.some((action) => action.id.startsWith("attack:FRIEND01:")),
    ).toBe(false);
  });

  it("offers neutral expansion attacks when observation proves adjacent unowned land", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "aggressive",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "active",
    });
    const expansionObservation: AgentObservation = {
      ...observation,
      ownState: {
        playerID: "PLAYER01",
        clientID: "CLNT0001",
        smallID: 1,
        name: "Agent One",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 1_000,
        gold: "50000",
        tilesOwned: 50,
        borderTiles: 12,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...observation.combat,
        ownTroops: 1_000,
        canExpandIntoNeutral: true,
        neutralExpansionLegalReason:
          "player is alive, spawned, and core nearby() includes Terra Nullius",
      },
      strategic: {
        ...observation.strategic,
        priority: "expand",
        urgency: "medium",
        recommendedActionKinds: ["attack", "build", "embargo", "hold"],
      },
    };
    const legalActions = new LegalActionBuilder().build({
      observation: expansionObservation,
    });

    const expansion = legalActions.find((action) =>
      action.id.startsWith("expand:terra-nullius:"),
    );
    const decision = new RuleAgentBrain("aggressive").decide({
      observation: expansionObservation,
      legalActions,
    });

    expect(expansion).toMatchObject({
      kind: "attack",
      intent: {
        type: "attack",
        targetID: null,
        troops: 100,
      },
      metadata: expect.objectContaining({
        expansion: true,
        targetName: "Terra Nullius",
      }),
    });
    expect(decision.actionID).toBe(expansion?.id);
  });

  it("uses short-term memory to diversify repeated expansion when a build exists", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "aggressive",
      gameID: "AGENTOBS",
      turnNumber: 5,
      phaseOverride: "active",
      recentDecisions: [
        {
          sequence: 1,
          actionID: "expand:terra-nullius:20",
          actionKind: "attack",
          accepted: true,
          reason: "expanded",
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
        },
        {
          sequence: 2,
          actionID: "expand:terra-nullius:20",
          actionKind: "attack",
          accepted: true,
          reason: "expanded again",
          targetID: null,
          targetName: "Terra Nullius",
          expansion: true,
        },
      ],
    });
    const memoryObservation: AgentObservation = {
      ...observation,
      ownState: {
        playerID: "PLAYER01",
        clientID: "CLNT0001",
        smallID: 1,
        name: "Agent One",
        type: PlayerType.Human,
        isAlive: true,
        isDisconnected: false,
        isTraitor: false,
        hasSpawned: true,
        troops: 10_000,
        gold: "200000",
        tilesOwned: 200,
        borderTiles: 20,
        outgoingAttacks: 0,
        incomingAttacks: 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
      },
      combat: {
        ...observation.combat,
        ownTroops: 10_000,
        canExpandIntoNeutral: true,
        neutralExpansionLegalReason:
          "player is alive, spawned, and core nearby() includes Terra Nullius",
      },
      nonCombat: {
        ...observation.nonCombat,
        buildOptions: [
          {
            unit: UnitType.City,
            role: "economic",
            targetTile: 101,
            buildTile: 101,
            cost: "125000",
            legalReason: "core canBuild(City) returned build tile 101",
          },
        ],
      },
      strategic: {
        ...observation.strategic,
        priority: "expand",
        urgency: "medium",
      },
    };
    const legalActions = new LegalActionBuilder().build({
      observation: memoryObservation,
    });
    const objective = new AgentObjectiveManager().objectiveFor({
      agentID: memoryObservation.agentID,
      profile: memoryObservation.profile,
      observation: memoryObservation,
      legalActions,
      turnNumber: memoryObservation.turnNumber,
    });
    const objectiveObservation = {
      ...memoryObservation,
      objective,
    };

    const decision = new RuleAgentBrain("aggressive").decide({
      observation: objectiveObservation,
      legalActions,
    });

    expect(memoryObservation.memory).toMatchObject({
      recentExpansionCount: 2,
      repeatedActionKind: "attack",
      repeatedActionCount: 2,
    });
    expect(objective).toMatchObject({
      kind: "secure_economy",
      status: "active",
    });
    expect(decision.actionID).toBe("build:City:101");
    const buildAction = legalActions.find(
      (action) => action.id === "build:City:101",
    );
    expect(
      actionAlignsWithObjective(objectiveObservation.objective, buildAction),
    ).toBe(true);
  });

  it("has rule brains prefer post-spawn actions only when their profile wants them", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "opportunistic",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "active",
    });
    const legalActions: LegalAction[] = [
      {
        id: "attack:TARGET01",
        kind: "attack" as const,
        label: "Attack Target",
        intent: { type: "attack" as const, targetID: "TARGET01", troops: 10 },
        risk: { level: "high" as const, score: 0.9 },
      },
      {
        id: "alliance:TARGET01",
        kind: "alliance_request" as const,
        label: "Request alliance",
        intent: { type: "allianceRequest" as const, recipient: "TARGET01" },
        risk: { level: "low" as const, score: 0.2 },
      },
      {
        id: "build:Defense Post:101",
        kind: "build" as const,
        label: "Build Defense Post",
        intent: {
          type: "build_unit" as const,
          unit: UnitType.DefensePost,
          tile: 101,
        },
        risk: { level: "low" as const, score: 0.1 },
        metadata: { role: "defensive" },
      },
      {
        id: "donate_troops:TARGET01",
        kind: "donate_troops" as const,
        label: "Donate troops",
        intent: {
          type: "donate_troops" as const,
          recipient: "TARGET01",
          troops: 25,
        },
        risk: { level: "medium" as const, score: 0.4 },
      },
      {
        id: "hold",
        kind: "hold" as const,
        label: "Hold",
        intent: null,
        risk: { level: "none" as const, score: 0 },
      },
    ];

    expect(
      new RuleAgentBrain("diplomatic").decide({ observation, legalActions })
        .actionID,
    ).toBe("alliance:TARGET01");
    expect(
      new RuleAgentBrain("aggressive").decide({ observation, legalActions })
        .actionID,
    ).toBe("attack:TARGET01");
    expect(
      new RuleAgentBrain("opportunistic").decide({ observation, legalActions })
        .actionID,
    ).toBe("build:Defense Post:101");
    expect(
      new RuleAgentBrain("defensive").decide({ observation, legalActions })
        .actionID,
    ).toBe("build:Defense Post:101");

    const supportOnly = legalActions.filter(
      (action) => action.kind !== "alliance_request",
    );
    expect(
      new RuleAgentBrain("diplomatic").decide({
        observation,
        legalActions: supportOnly,
      }).actionID,
    ).toBe("donate_troops:TARGET01");
  });

  it("has rule brains avoid pointless interior Defense Posts when economy builds are legal", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "defensive",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "active",
    });
    const legalActions: LegalAction[] = [
      {
        id: "build:Defense Post:101",
        kind: "build" as const,
        label: "Build Defense Post",
        intent: {
          type: "build_unit" as const,
          unit: UnitType.DefensePost,
          tile: 101,
        },
        risk: { level: "low" as const, score: 0.1 },
        metadata: {
          role: "defensive",
          unit: UnitType.DefensePost,
          defensiveValue: 0.01,
          frontierValue: 0,
          hostileBorderDistance: null,
          nearbyEnemyCount: 0,
          nearbyIncomingAttack: false,
          buildPlacementReason:
            "Defense Post has no proven hostile frontier coverage.",
        },
      },
      {
        id: "build:City:120",
        kind: "build" as const,
        label: "Build City",
        intent: {
          type: "build_unit" as const,
          unit: UnitType.City,
          tile: 120,
        },
        risk: { level: "medium" as const, score: 0.3 },
        metadata: {
          role: "economic",
          unit: UnitType.City,
          economicValue: 0.8,
          buildPlacementReason: "City favors safe economic placement.",
        },
      },
      {
        id: "hold",
        kind: "hold" as const,
        label: "Hold",
        intent: null,
        risk: { level: "none" as const, score: 0 },
      },
    ];

    expect(
      new RuleAgentBrain("defensive").decide({ observation, legalActions })
        .actionID,
    ).toBe("build:City:120");
  });

  it("falls back to hold when a decision chooses an unknown action", () => {
    const observation = new AgentObservationBuilder().build({
      agentID: "agent-1",
      clientID: null,
      username: "Agent One",
      profile: "diplomatic",
      gameID: "AGENTOBS",
      turnNumber: 0,
      phaseOverride: "active",
    });
    const legalActions = new LegalActionBuilder().build({ observation });

    const validation = validateAgentDecision(
      { actionID: "missing-action", reason: "test invalid decision" },
      legalActions,
    );

    expect(validation).toMatchObject({
      ok: false,
      fallback: { id: "hold" },
    });
  });
});
