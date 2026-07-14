import { describe, expect, it } from "vitest";

import {
  buildKeystoneWorldModel,
  proposeKeystonePolitics,
  type KeystoneWorldModel,
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
  riskScore = 0.2,
): LegalAction {
  return {
    id,
    kind,
    label: id,
    intent: null,
    risk: { level: riskScore === 0 ? "none" : "low", score: riskScore },
    metadata: targetPlayerID === null ? {} : { targetID: targetPlayerID },
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
  phase?: AgentGamePhase;
  turnNumber?: number;
}): AgentBrainInput {
  const base = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "POLITICS-EXPERT",
    turnNumber: args.turnNumber ?? 300,
    phaseOverride: args.phase ?? "active",
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
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: players.filter(
          (candidate) => candidate.hasIncomingAllianceRequest,
        ).length,
        team: null,
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
      },
    },
    legalActions: args.actions,
  };
}

function world(args: Parameters<typeof brainInput>[0]): KeystoneWorldModel {
  return buildKeystoneWorldModel(brainInput(args));
}

describe("Keystone Politics expert", () => {
  it("abstains instead of filling early cadence with proactive politics", () => {
    const rival = player("RIVAL");
    const proactiveKinds: readonly LegalActionKind[] = [
      "alliance_request",
      "break_alliance",
      "donate_gold",
      "donate_troops",
      "quick_chat",
      "emoji",
      "embargo",
      "embargo_all",
      "target_player",
    ];
    const actions = proactiveKinds.map((kind) =>
      action(
        `proactive:${kind}`,
        kind,
        kind === "embargo_all" ? null : rival.playerID,
      ),
    );

    expect(
      proposeKeystonePolitics(
        world({ actions, players: [rival], turnNumber: 100 }),
      ),
    ).toBeNull();
  });

  it("rejects only an observed incoming request from an active aggressor", () => {
    const aggressor = player("AGGRESSOR", {
      incomingAttack: true,
      hasIncomingAllianceRequest: true,
    });
    const proposal = proposeKeystonePolitics(
      world({
        actions: [
          action("alliance_reject:AGGRESSOR", "alliance_reject", "AGGRESSOR"),
          action("embargo:AGGRESSOR:start", "embargo", "AGGRESSOR"),
        ],
        players: [aggressor],
      }),
    );

    expect(proposal).toMatchObject({
      actionID: "alliance_reject:AGGRESSOR",
      source: "politics",
      proposalID:
        "politics:hostile_request_rejection:alliance_reject:AGGRESSOR",
      expectedValueBP: 6_000,
      urgencyBP: 8_500,
      confidenceBP: 9_300,
      riskBP: 2_000,
      opportunityCostBP: 1_000,
    });
    expect(Object.isFrozen(proposal)).toBe(true);
  });

  it("does not reject an unsupported or merely neutral incoming offer", () => {
    const requester = player("REQUESTER", {
      hasIncomingAllianceRequest: true,
    });
    expect(
      proposeKeystonePolitics(
        world({
          actions: [
            action("alliance_reject:REQUESTER", "alliance_reject", "REQUESTER"),
          ],
          players: [requester],
        }),
      ),
    ).toBeNull();
  });

  it("repairs an observable embargo against a friendly or allied target", () => {
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      hasEmbargoAgainst: true,
      canStopEmbargo: true,
    });
    const proposal = proposeKeystonePolitics(
      world({
        actions: [action("embargo:ALLY:stop", "embargo_stop", "ALLY", 0.5)],
        players: [ally],
      }),
    );

    expect(proposal).toMatchObject({
      actionID: "embargo:ALLY:stop",
      source: "politics",
      proposalID: "politics:embargo_repair:embargo:ALLY:stop",
      expectedValueBP: 8_500,
      urgencyBP: 9_500,
      confidenceBP: 9_700,
      riskBP: 5_000,
      opportunityCostBP: 300,
    });
  });

  it("extends only an existing safe alliance in its observable extension window", () => {
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      canExtendAlliance: true,
      allianceInExtensionWindow: true,
    });
    expect(
      proposeKeystonePolitics(
        world({
          actions: [action("alliance_extend:ALLY", "alliance_extend", "ALLY")],
          players: [ally],
        }),
      ),
    ).toMatchObject({
      actionID: "alliance_extend:ALLY",
      proposalID: "politics:alliance_extension:alliance_extend:ALLY",
      source: "politics",
    });

    const noWindow = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      canExtendAlliance: true,
    });
    expect(
      proposeKeystonePolitics(
        world({
          actions: [action("alliance_extend:ALLY", "alliance_extend", "ALLY")],
          players: [noWindow],
        }),
      ),
    ).toBeNull();
  });

  it("fails closed when any alliance-extension fact is missing or contradictory", () => {
    const offered = action("alliance_extend:ALLY", "alliance_extend", "ALLY");
    const incompleteAllies: AgentVisiblePlayer[] = [
      player("ALLY", {
        isFriendly: true,
        canExtendAlliance: true,
        allianceInExtensionWindow: true,
      }),
      player("ALLY", {
        isAllied: true,
        isFriendly: true,
        allianceInExtensionWindow: true,
      }),
      player("ALLY", {
        isAllied: true,
        isFriendly: true,
        canExtendAlliance: true,
      }),
      player("ALLY", {
        isAllied: true,
        isFriendly: true,
        canExtendAlliance: true,
        allianceInExtensionWindow: true,
        incomingAttack: true,
      }),
    ];

    for (const incompleteAlly of incompleteAllies) {
      expect(
        proposeKeystonePolitics(
          world({ actions: [offered], players: [incompleteAlly] }),
        ),
      ).toBeNull();
    }
  });

  it("protects allies even when contradictory hostile evidence is present", () => {
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      incomingAttack: true,
      hasIncomingAllianceRequest: true,
    });
    expect(
      proposeKeystonePolitics(
        world({
          actions: [
            action("alliance_reject:ALLY", "alliance_reject", "ALLY"),
            action("break_alliance:ALLY", "break_alliance", "ALLY"),
            action("embargo:ALLY:start", "embargo", "ALLY"),
            action("target_player:ALLY", "target_player", "ALLY"),
          ],
          players: [ally],
        }),
      ),
    ).toBeNull();
  });

  it("chooses exactly one deterministic reaction without ever selecting a hostile action", () => {
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      hasEmbargoAgainst: true,
      canExtendAlliance: true,
      allianceInExtensionWindow: true,
    });
    const aggressor = player("AGGRESSOR", {
      incomingAttack: true,
      hasIncomingAllianceRequest: true,
    });
    const actions = [
      action("target_player:AGGRESSOR", "target_player", "AGGRESSOR"),
      action("alliance_reject:AGGRESSOR", "alliance_reject", "AGGRESSOR"),
      action("alliance_extend:ALLY", "alliance_extend", "ALLY"),
      action("embargo:ALLY:stop", "embargo_stop", "ALLY"),
      action("embargo:AGGRESSOR:start", "embargo", "AGGRESSOR"),
    ];
    const proposal = proposeKeystonePolitics(
      world({ actions, players: [aggressor, ally] }),
    );

    expect(proposal?.actionID).toBe("embargo:ALLY:stop");
    expect(
      actions.find((candidate) => candidate.id === proposal?.actionID)?.kind,
    ).toBe("embargo_stop");
  });

  it("fails closed on forbidden, ambiguous, non-owned, or unsafe actions", () => {
    const aggressor = player("AGGRESSOR", {
      incomingAttack: true,
      hasIncomingAllianceRequest: true,
    });
    const offered = action(
      "alliance_reject:AGGRESSOR",
      "alliance_reject",
      "AGGRESSOR",
    );
    const forbidden = buildKeystoneWorldModel(
      brainInput({ actions: [offered], players: [aggressor] }),
      { forbiddenActionKinds: ["alliance_reject"] },
    );
    expect(proposeKeystonePolitics(forbidden)).toBeNull();

    const ambiguous = world({
      actions: [offered, { ...offered }],
      players: [aggressor],
    });
    expect(ambiguous.ambiguousOfferedActionIDs).toEqual([
      "alliance_reject:AGGRESSOR",
    ]);
    expect(proposeKeystonePolitics(ambiguous)).toBeNull();

    const base = world({ actions: [offered], players: [aggressor] });
    for (const patch of [
      { actionOwner: "conquest" as const },
      { safetyBlocked: true },
      { targetsSelf: true },
      { actionRiskBP: Number.NaN },
    ]) {
      const malformed: KeystoneWorldModel = Object.freeze({
        ...base,
        actions: Object.freeze(
          base.actions.map((candidate) =>
            Object.freeze({ ...candidate, ...patch }),
          ),
        ),
      });
      expect(proposeKeystonePolitics(malformed)).toBeNull();
    }
  });

  it("fails closed on missing or ambiguous target-player evidence", () => {
    const offered = action(
      "alliance_reject:AGGRESSOR",
      "alliance_reject",
      "AGGRESSOR",
    );
    expect(
      proposeKeystonePolitics(world({ actions: [offered], players: [] })),
    ).toBeNull();

    const aggressor = player("AGGRESSOR", {
      incomingAttack: true,
      hasIncomingAllianceRequest: true,
    });
    expect(
      proposeKeystonePolitics(
        world({
          actions: [offered],
          players: [aggressor, { ...aggressor }],
        }),
      ),
    ).toBeNull();
  });

  it("is order-invariant, bounded, immutable, and does not mutate its world", () => {
    const ally = player("ALLY", {
      isAllied: true,
      isFriendly: true,
      relation: Relation.Friendly,
      hasEmbargoAgainst: true,
    });
    const aggressor = player("AGGRESSOR", {
      incomingAttack: true,
      hasIncomingAllianceRequest: true,
    });
    const actions = [
      action("alliance_reject:AGGRESSOR", "alliance_reject", "AGGRESSOR"),
      action("embargo:ALLY:stop", "embargo_stop", "ALLY"),
    ];
    const forward = world({ actions, players: [ally, aggressor] });
    const reverse = world({
      actions: [...actions].reverse(),
      players: [aggressor, ally],
    });
    const before = JSON.stringify(forward);
    const forwardProposal = proposeKeystonePolitics(forward);
    const reverseProposal = proposeKeystonePolitics(reverse);

    expect(reverseProposal).toEqual(forwardProposal);
    expect(JSON.stringify(forward)).toBe(before);
    expect(Object.isFrozen(forwardProposal)).toBe(true);
    for (const value of [
      forwardProposal?.expectedValueBP,
      forwardProposal?.urgencyBP,
      forwardProposal?.confidenceBP,
      forwardProposal?.riskBP,
      forwardProposal?.opportunityCostBP,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10_000);
    }
  });

  it("abstains outside active play or without observable own state", () => {
    expect(
      proposeKeystonePolitics(
        world({ actions: [], players: [], phase: "spawn" }),
      ),
    ).toBeNull();

    const active = world({ actions: [], players: [] });
    expect(
      proposeKeystonePolitics(Object.freeze({ ...active, own: null })),
    ).toBeNull();
  });
});
