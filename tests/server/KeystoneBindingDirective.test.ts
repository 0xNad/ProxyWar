import { describe, expect, it } from "vitest";

import {
  arbitrateKeystoneAction,
  buildKeystoneWorldModel,
  KeystoneOperationalCommitmentLedger,
  normalizeKeystoneCommanderContext,
  resolveKeystoneBindingDirective,
  type KeystoneAuctionContext,
  type KeystoneCommanderBinding,
  type KeystoneCouncilTiers,
  type KeystoneExpertProposal,
} from "../../coworld-adapter/src/keystone-experts";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type { StrategicPlan } from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrainInput,
  AgentGamePhase,
  AgentVisiblePlayer,
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

const defaultBid = Object.freeze({
  expectedValueBP: 8_000,
  urgencyBP: 6_000,
  confidenceBP: 8_000,
  riskBP: 1_000,
  opportunityCostBP: 1_000,
});

const basePlan: StrategicPlan = {
  planID: "binding-plan",
  objective: "expand_territory",
  targetPlayerId: null,
  rationale: "focused binding test",
  startedAtTick: 0,
  maxDecisionCycles: 3,
  successCriteria: [],
  failureCriteria: [],
  preferredActionKinds: ["attack", "build"],
  forbiddenActionKinds: [],
  plannerSource: "rule",
};

function plan(overrides: Partial<StrategicPlan>): StrategicPlan {
  return { ...basePlan, ...overrides };
}

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

function input(
  actions: readonly LegalAction[],
  players: readonly AgentVisiblePlayer[] = [],
  options: {
    phase?: AgentGamePhase;
    incomingAttackPlayerIDs?: readonly string[];
  } = {},
): AgentBrainInput {
  const observation = new AgentObservationBuilder().build({
    agentID: "keystone",
    clientID: null,
    username: "Keystone",
    profile: "aggressive",
    gameID: "BINDING-DIRECTIVE",
    turnNumber: 2_000,
    phaseOverride: options.phase ?? "active",
  });
  return {
    observation: {
      ...observation,
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
        incomingAttacks: options.incomingAttackPlayerIDs?.length ?? 0,
        outgoingAllianceRequests: 0,
        incomingAllianceRequests: 0,
        team: null,
      },
      visiblePlayers: [...players],
      combat: {
        ...observation.combat,
        ownTroops: 75_000,
        maxTroops: 100_000,
        troopRatio: 0.75,
        borderedPlayerIDs: players
          .filter((candidate) => candidate.sharesBorder)
          .map((candidate) => candidate.playerID),
        attackablePlayerIDs: players
          .filter((candidate) => candidate.canAttack)
          .map((candidate) => candidate.playerID),
        incomingAttackPlayerIDs: [...(options.incomingAttackPlayerIDs ?? [])],
        canExpandIntoNeutral: actions.some(
          (candidate) => candidate.metadata?.expansion === true,
        ),
      },
    },
    legalActions: [...actions],
  };
}

function world(
  binding: KeystoneCommanderBinding | null,
  actions: readonly LegalAction[],
  players: readonly AgentVisiblePlayer[] = [],
  options: {
    forbiddenActionKinds?: readonly LegalActionKind[];
    phase?: AgentGamePhase;
    incomingAttackPlayerIDs?: readonly string[];
  } = {},
) {
  return buildKeystoneWorldModel(
    input(actions, players, {
      phase: options.phase,
      incomingAttackPlayerIDs: options.incomingAttackPlayerIDs,
    }),
    {
      commander: Object.freeze({ planID: "binding-plan", binding }),
      forbiddenActionKinds: options.forbiddenActionKinds,
    },
  );
}

function expert(
  source: KeystoneExpertProposal["source"],
  actionID: string,
  overrides: Partial<KeystoneExpertProposal> = {},
): KeystoneExpertProposal {
  return {
    proposalID: `${source}:${actionID}`,
    actionID,
    source,
    rationale: "focused operational proposal",
    ...defaultBid,
    ...overrides,
  };
}

function tiers(
  expertAuction: readonly KeystoneExpertProposal[] = [],
  bindingDirective: KeystoneCouncilTiers["bindingDirective"] = [],
  survival: KeystoneCouncilTiers["survival"] = [],
): KeystoneCouncilTiers {
  return {
    spawn: [],
    survival,
    bindingDirective,
    expertAuction,
  };
}

describe("Keystone Commander context", () => {
  it("normalizes one frozen attack binding with defensive precedence", () => {
    const context = normalizeKeystoneCommanderContext(
      plan({
        commitment: { targetPlayerId: "RIVAL", minAttackRatio: 0.255 },
        allianceDirective: {
          stance: "seek_alliance",
          targetPlayerId: "ALLY",
        },
        buildDirective: { unit: "City" },
      }),
    );

    expect(context).toEqual({
      planID: "binding-plan",
      binding: {
        kind: "attack_target",
        domain: "conquest",
        targetPlayerID: "RIVAL",
        minCommitmentBP: 2_550,
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.binding)).toBe(true);
  });

  it("fails a malformed higher-priority directive closed instead of falling through", () => {
    const context = normalizeKeystoneCommanderContext(
      plan({
        commitment: { targetPlayerId: " ", minAttackRatio: 0.25 },
        allianceDirective: {
          stance: "seek_alliance",
          targetPlayerId: "ALLY",
        },
        buildDirective: { unit: "City" },
      }),
    );
    expect(context.binding).toBeNull();
  });

  it("normalizes targeted and open alliance bindings", () => {
    expect(
      normalizeKeystoneCommanderContext(
        plan({
          allianceDirective: {
            stance: "hold_alliance",
            targetPlayerId: " ALLY ",
          },
        }),
      ).binding,
    ).toEqual({
      kind: "alliance",
      domain: "politics",
      stance: "hold_alliance",
      targetPlayerID: "ALLY",
    });
    expect(
      normalizeKeystoneCommanderContext(
        plan({ allianceDirective: { stance: "seek_alliance" } }),
      ).binding,
    ).toMatchObject({ targetPlayerID: null });
  });

  it.each([
    ["City", "city"],
    ["Factory", "factory"],
    ["Port", "port"],
    ["MissileSilo", "missile_silo"],
    ["SAMLauncher", "sam_launcher"],
    ["any", "any"],
  ] as const)("normalizes the %s build unit", (unit, normalized) => {
    expect(
      normalizeKeystoneCommanderContext(plan({ buildDirective: { unit } }))
        .binding,
    ).toEqual({ kind: "build", domain: "economy", unit: normalized });
  });

  it("attaches the immutable context itself to the shared world", () => {
    const commander = normalizeKeystoneCommanderContext(
      plan({ buildDirective: { unit: "City" } }),
    );
    const shared = buildKeystoneWorldModel(input([]), { commander });
    expect(shared.commander).toBe(commander);
    expect(Object.isFrozen(shared.commander)).toBe(true);
  });
});

describe("Keystone exact offered-action binding", () => {
  it("chooses the smallest offered land commitment meeting the attack floor", () => {
    const binding = Object.freeze({
      kind: "attack_target" as const,
      domain: "conquest" as const,
      targetPlayerID: "RIVAL",
      minCommitmentBP: 2_500,
    });
    const current = world(
      binding,
      [
        action("attack:rival:10", "attack", {
          targetID: "RIVAL",
          troopPercent: 10,
        }),
        action(
          "attack:rival:25",
          "attack",
          { targetID: "RIVAL", troopPercent: 25 },
          0.4,
        ),
        action("attack:rival:35", "attack", {
          targetID: "RIVAL",
          troopPercent: 35,
        }),
      ],
      [player("RIVAL")],
    );

    const resolution = resolveKeystoneBindingDirective(current);
    expect(resolution).toMatchObject({
      status: "proposed",
      kind: "attack_target",
      proposal: {
        actionID: "attack:rival:25",
        source: "binding_directive",
      },
    });
    expect(
      current.actions.some(
        (candidate) => candidate.id === resolution.proposal?.actionID,
      ),
    ).toBe(true);
  });

  it("uses only an exact offered boat fallback when no land offer meets the floor", () => {
    const resolution = resolveKeystoneBindingDirective(
      world(
        {
          kind: "attack_target",
          domain: "conquest",
          targetPlayerID: "RIVAL",
          minCommitmentBP: 6_000,
        },
        [
          action("attack:rival:35", "attack", {
            targetID: "RIVAL",
            troopPercent: 35,
          }),
          action("boat:z", "boat", { targetID: "RIVAL" }, 0.2),
          action("boat:a", "boat", { targetID: "RIVAL" }, 0.1),
        ],
        [player("RIVAL")],
      ),
    );
    expect(resolution.proposal?.actionID).toBe("boat:a");
  });

  it("fails attack binding closed for absent, unsafe, dead, ambiguous, forbidden, or malformed offers", () => {
    const binding: KeystoneCommanderBinding = {
      kind: "attack_target",
      domain: "conquest",
      targetPlayerID: "RIVAL",
      minCommitmentBP: 2_500,
    };
    const offered = action("attack:rival", "attack", {
      targetID: "RIVAL",
      troopPercent: 30,
    });
    const unavailableWorlds = [
      world(binding, [], [player("RIVAL")]),
      world(binding, [offered], [player("RIVAL", { isAlive: false })]),
      world(
        binding,
        [offered],
        [
          player("RIVAL", {
            isAllied: true,
            isFriendly: true,
            relation: Relation.Friendly,
          }),
        ],
      ),
      world(binding, [offered], [player("RIVAL"), player("RIVAL")]),
      world(binding, [offered, { ...offered }], [player("RIVAL")]),
      world(binding, [offered], [player("RIVAL")], {
        forbiddenActionKinds: ["attack"],
      }),
      world(
        binding,
        [
          action("attack:unknown", "attack", {
            targetID: "RIVAL",
            troopPercent: "30" as unknown as number,
          }),
        ],
        [player("RIVAL")],
      ),
    ];

    for (const current of unavailableWorlds) {
      expect(resolveKeystoneBindingDirective(current)).toEqual({
        status: "unavailable",
        kind: "attack_target",
        proposal: null,
      });
    }
  });

  it("honors alliance target and stance using only live offered actions", () => {
    const actions = [
      action("request:ally", "alliance_request", { targetID: "ALLY" }, 0.4),
      action("extend:ally", "alliance_extend", { targetID: "ALLY" }, 0.2),
      action("request:other", "alliance_request", { targetID: "OTHER" }, 0.1),
      action("request:self", "alliance_request", { targetID: "ME" }, 0),
    ];
    const players = [player("ALLY"), player("OTHER")];

    expect(
      resolveKeystoneBindingDirective(
        world(
          {
            kind: "alliance",
            domain: "politics",
            stance: "seek_alliance",
            targetPlayerID: "ALLY",
          },
          actions,
          players,
        ),
      ).proposal?.actionID,
    ).toBe("request:ally");
    expect(
      resolveKeystoneBindingDirective(
        world(
          {
            kind: "alliance",
            domain: "politics",
            stance: "hold_alliance",
            targetPlayerID: "ALLY",
          },
          actions,
          players,
        ),
      ).proposal?.actionID,
    ).toBe("extend:ally");
    expect(
      resolveKeystoneBindingDirective(
        world(
          {
            kind: "alliance",
            domain: "politics",
            stance: "seek_alliance",
            targetPlayerID: null,
          },
          actions,
          players,
        ),
      ).proposal?.actionID,
    ).toBe("request:other");
  });

  it("does not synthesize a missing alliance action id", () => {
    const resolution = resolveKeystoneBindingDirective(
      world(
        {
          kind: "alliance",
          domain: "politics",
          stance: "seek_alliance",
          targetPlayerID: "ALLY",
        },
        [action("request:other", "alliance_request", { targetID: "OTHER" })],
        [player("ALLY"), player("OTHER")],
      ),
    );
    expect(resolution).toEqual({
      status: "unavailable",
      kind: "alliance",
      proposal: null,
    });
  });

  it("matches economic builds and keeps deterrent units exact", () => {
    const actions = [
      action("city:economic", "build", { unit: "City", role: "economic" }, 0.3),
      action("city:defensive", "build", { unit: "City", role: "defensive" }, 0),
      action(
        "factory:economic",
        "build",
        { unit: "Factory", role: "economic" },
        0.1,
      ),
      action(
        "silo",
        "build",
        { unit: "Missile Silo", role: "infrastructure" },
        0.2,
      ),
      action("sam", "build", { unit: "SAM Launcher", role: "defensive" }, 0.1),
    ];
    const resolution = (
      unit: Extract<KeystoneCommanderBinding, { kind: "build" }>["unit"],
    ) =>
      resolveKeystoneBindingDirective(
        world({ kind: "build", domain: "economy", unit }, actions),
      );

    expect(resolution("city").proposal?.actionID).toBe("city:economic");
    expect(resolution("any").proposal?.actionID).toBe("factory:economic");
    expect(resolution("missile_silo").proposal?.actionID).toBe("silo");
    expect(resolution("sam_launcher").proposal?.actionID).toBe("sam");
  });

  it("marks a missing exact build unavailable and lets the expert auction continue", () => {
    const current = world({ kind: "build", domain: "economy", unit: "city" }, [
      action("expand:neutral", "attack", {
        targetID: null,
        expansion: true,
        troopPercent: 35,
      }),
    ]);
    const resolution = resolveKeystoneBindingDirective(current);
    const result = arbitrateKeystoneAction(
      current,
      tiers([expert("expansion", "expand:neutral")]),
    );
    expect(resolution.status).toBe("unavailable");
    expect(result.selection).toMatchObject({
      actionID: "expand:neutral",
      tier: "expert_auction",
    });
  });

  it("preserves survival over a binding and a binding over conflicting experts", () => {
    const current = world(
      {
        kind: "attack_target",
        domain: "conquest",
        targetPlayerID: "RIVAL",
        minCommitmentBP: 2_500,
      },
      [
        action("retreat", "retreat"),
        action("attack:rival", "attack", {
          targetID: "RIVAL",
          troopPercent: 30,
        }),
        action("build:city", "build", { unit: "City", role: "economic" }),
      ],
      [player("RIVAL"), player("AGGRESSOR", { incomingAttack: true })],
      { incomingAttackPlayerIDs: ["AGGRESSOR"] },
    );
    const binding = resolveKeystoneBindingDirective(current).proposal!;
    const survival = {
      proposalID: "survival:retreat",
      actionID: "retreat",
      source: "survival" as const,
      rationale: "survive first",
      ...defaultBid,
    };
    const conflict = expert("economy", "build:city", {
      expectedValueBP: 10_000,
    });

    expect(
      arbitrateKeystoneAction(current, tiers([conflict], [binding], [survival]))
        .selection,
    ).toMatchObject({ actionID: "retreat", tier: "survival" });
    expect(
      arbitrateKeystoneAction(current, tiers([conflict], [binding])).selection,
    ).toMatchObject({
      actionID: "attack:rival",
      tier: "binding_directive",
    });
  });
});

describe("Keystone bounded operational hysteresis", () => {
  const actions = [
    action("expand:neutral", "attack", {
      targetID: null,
      expansion: true,
      troopPercent: 35,
    }),
    action("build:city", "build", { unit: "City", role: "economic" }),
  ];

  function operationalWorld(
    options: {
      binding?: KeystoneCommanderBinding | null;
      phase?: AgentGamePhase;
      pressure?: boolean;
    } = {},
  ) {
    const aggressor = player("AGGRESSOR", {
      incomingAttack: options.pressure === true,
    });
    return world(
      options.binding ?? null,
      actions,
      options.pressure === true ? [aggressor] : [],
      {
        phase: options.phase,
        incomingAttackPlayerIDs: options.pressure === true ? ["AGGRESSOR"] : [],
      },
    );
  }

  const expansion = expert("expansion", "expand:neutral", {
    commitmentKey: "expansion:neutral-land",
    horizonDecisions: 2,
  });

  function armLedger() {
    const ledger = new KeystoneOperationalCommitmentLedger();
    const current = operationalWorld();
    const preparation = ledger.prepare({
      world: current,
      ordinal: 1,
      reset: true,
      proposals: [expansion],
      planAlignmentBonusBP: 0,
      switchMarginBP: 500,
    });
    const result = arbitrateKeystoneAction(
      current,
      tiers([expansion]),
      preparation.auctionContext,
    );
    const record = ledger.record({
      world: current,
      ordinal: 1,
      result,
      proposals: [expansion],
    });
    expect(record).toMatchObject({
      reason: "armed",
      after: {
        commitment: {
          key: "expansion:neutral-land",
          source: "expansion",
          startedOrdinal: 1,
          expiresAfterOrdinal: 2,
        },
        remainingDecisions: 2,
      },
    });
    return ledger;
  }

  it("retains below the exact switch margin, does not extend TTL, then expires", () => {
    const ledger = armLedger();
    const current = operationalWorld();
    const challenger = expert("economy", "build:city", {
      expectedValueBP: 8_998,
      commitmentKey: "economy:city-foundation",
      horizonDecisions: 2,
    });
    const preparation = ledger.prepare({
      world: current,
      ordinal: 2,
      reset: false,
      proposals: [expansion, challenger],
      planAlignmentBonusBP: 0,
      switchMarginBP: 500,
    });
    const result = arbitrateKeystoneAction(
      current,
      tiers([expansion, challenger]),
      preparation.auctionContext,
    );
    expect(result.selection?.actionID).toBe("expand:neutral");
    expect(result.bidMarginBP).toBe(-499);
    expect(result.auction).toMatchObject({
      status: "retained",
      challengerAdvantageBP: 499,
      selectedRawBidBP: 7_125,
      selectedPlanBonusBP: 0,
    });
    expect(
      ledger.record({
        world: current,
        ordinal: 2,
        result,
        proposals: [expansion, challenger],
      }),
    ).toMatchObject({
      reason: "retained",
      after: {
        commitment: { expiresAfterOrdinal: 2 },
        remainingDecisions: 1,
      },
    });
    expect(
      ledger.prepare({
        world: current,
        ordinal: 3,
        reset: false,
        proposals: [expansion, challenger],
        planAlignmentBonusBP: 0,
        switchMarginBP: 500,
      }),
    ).toMatchObject({
      auctionContext: { incumbent: null },
      transition: { reason: "expired" },
    });
  });

  it("switches at the exact margin and arms the challenger objective", () => {
    const ledger = armLedger();
    const current = operationalWorld();
    const challenger = expert("economy", "build:city", {
      expectedValueBP: 9_000,
      commitmentKey: "economy:city-foundation",
      horizonDecisions: 2,
    });
    const preparation = ledger.prepare({
      world: current,
      ordinal: 2,
      reset: false,
      proposals: [expansion, challenger],
      planAlignmentBonusBP: 0,
      switchMarginBP: 500,
    });
    const result = arbitrateKeystoneAction(
      current,
      tiers([expansion, challenger]),
      preparation.auctionContext,
    );
    expect(result.selection?.actionID).toBe("build:city");
    expect(result.auction).toMatchObject({
      status: "switched",
      challengerAdvantageBP: 500,
    });
    expect(
      ledger.record({
        world: current,
        ordinal: 2,
        result,
        proposals: [expansion, challenger],
      }),
    ).toMatchObject({
      reason: "armed",
      after: {
        commitment: {
          key: "economy:city-foundation",
          source: "economy",
          startedOrdinal: 2,
          expiresAfterOrdinal: 3,
        },
      },
    });
  });

  it.each([
    ["game reset", "reset"],
    ["inactive phase", "inactive_phase"],
    ["Commander binding", "commander_binding"],
    ["incoming pressure", "incoming_pressure"],
    ["missing incumbent proposal", "incumbent_unavailable"],
  ] as const)("clears on %s", (_name, expectedReason) => {
    const ledger = armLedger();
    const current =
      expectedReason === "inactive_phase"
        ? operationalWorld({ phase: "finished" })
        : expectedReason === "commander_binding"
          ? operationalWorld({
              binding: { kind: "build", domain: "economy", unit: "city" },
            })
          : expectedReason === "incoming_pressure"
            ? operationalWorld({ pressure: true })
            : operationalWorld();
    const prepared = ledger.prepare({
      world: current,
      ordinal: 2,
      reset: expectedReason === "reset",
      proposals: expectedReason === "incumbent_unavailable" ? [] : [expansion],
      planAlignmentBonusBP: 0,
      switchMarginBP: 500,
    });
    expect(prepared).toMatchObject({
      auctionContext: { incumbent: null },
      transition: {
        reason: expectedReason,
        before: { commitment: { key: "expansion:neutral-land" } },
        after: { commitment: null, remainingDecisions: 0 },
      },
    });
  });

  it("does not arm malformed or overlong operational metadata", () => {
    const current = operationalWorld();
    for (const proposal of [
      expert("expansion", "expand:neutral", {
        commitmentKey: "conquest:wrong-owner",
        horizonDecisions: 2,
      }),
      expert("expansion", "expand:neutral", {
        commitmentKey: `expansion:${"x".repeat(100)}`,
        horizonDecisions: 2,
      }),
      expert("expansion", "expand:neutral", {
        commitmentKey: "expansion:neutral-land",
        horizonDecisions: 4,
      }),
    ]) {
      const ledger = new KeystoneOperationalCommitmentLedger();
      const prepared = ledger.prepare({
        world: current,
        ordinal: 1,
        reset: true,
        proposals: [proposal],
        planAlignmentBonusBP: 0,
        switchMarginBP: 500,
      });
      const result = arbitrateKeystoneAction(
        current,
        tiers([proposal]),
        prepared.auctionContext,
      );
      expect(result.selection?.actionID).toBe("expand:neutral");
      expect(
        ledger.record({
          world: current,
          ordinal: 1,
          result,
          proposals: [proposal],
        }),
      ).toMatchObject({
        reason: "selected_without_commitment",
        after: { commitment: null },
      });
    }
  });

  it("validates auction bounds and remains order invariant under hysteresis", () => {
    const current = operationalWorld();
    const challenger = expert("economy", "build:city", {
      expectedValueBP: 8_998,
      commitmentKey: "economy:city-foundation",
      horizonDecisions: 2,
    });
    const context: KeystoneAuctionContext = {
      incumbent: {
        key: "expansion:neutral-land",
        source: "expansion",
        startedOrdinal: 1,
        expiresAfterOrdinal: 2,
      },
      planAlignmentBonusBP: 0,
      switchMarginBP: 500,
    };
    const forward = arbitrateKeystoneAction(
      current,
      tiers([expansion, challenger]),
      context,
    );
    const reverse = arbitrateKeystoneAction(
      current,
      tiers([challenger, expansion]),
      context,
    );
    expect(forward).toEqual(reverse);
    expect(forward.selection?.actionID).toBe("expand:neutral");
    expect(() =>
      arbitrateKeystoneAction(current, tiers([expansion]), {
        ...context,
        switchMarginBP: 10_001,
      }),
    ).toThrow(/switchMarginBP/);
  });
});
