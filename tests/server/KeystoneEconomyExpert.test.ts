import { describe, expect, it } from "vitest";

import {
  classifyKeystoneActions,
  proposeKeystoneEconomy,
  type KeystoneActionFacts,
  type KeystoneEconomyProposal,
  type KeystonePlayerFacts,
  type KeystoneStructureUnitType,
  type KeystoneWorldModel,
} from "../../coworld-adapter/src/keystone-experts";
import type {
  LegalAction,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

type EconomicUnit = Extract<
  KeystoneStructureUnitType,
  "city" | "port" | "factory"
>;

function economyAction(
  id: string,
  kind: "build" | "upgrade_structure" = "build",
  unitType: EconomicUnit = "city",
  overrides: Partial<KeystoneActionFacts> = {},
): KeystoneActionFacts {
  return {
    id,
    kind,
    unitType,
    buildRole: kind === "build" ? "economic" : null,
    targetPlayerID: null,
    isSpawn: false,
    isHold: false,
    isNeutralExpansion: false,
    isHostileTargetAction: false,
    targetsSelf: false,
    targetsFriendlyOrTeam: false,
    safetyBlocked: false,
    forbidden: false,
    planAligned: false,
    actionRiskBP: kind === "build" ? 3_500 : 2_000,
    actionOwner: "economy",
    ...overrides,
  };
}

function otherAction(
  id: string,
  kind: LegalActionKind,
  overrides: Partial<KeystoneActionFacts> = {},
): KeystoneActionFacts {
  return {
    id,
    kind,
    unitType: null,
    buildRole: null,
    targetPlayerID: null,
    isSpawn: kind === "spawn",
    isHold: kind === "hold",
    isNeutralExpansion: false,
    isHostileTargetAction: kind === "attack" || kind === "boat",
    targetsSelf: false,
    targetsFriendlyOrTeam: false,
    safetyBlocked: false,
    forbidden: false,
    planAligned: false,
    actionRiskBP: 1_000,
    actionOwner: null,
    ...overrides,
  };
}

function neutralAction(id = "neutral:available"): KeystoneActionFacts {
  return otherAction(id, "attack", {
    isNeutralExpansion: true,
    isHostileTargetAction: false,
    actionOwner: "expansion",
  });
}

function incomingPlayer(playerID = "AGGRESSOR"): KeystonePlayerFacts {
  return {
    playerID,
    isAlive: true,
    isAllied: false,
    isFriendly: false,
    isTeammate: false,
    sameTeam: false,
    friendlyOrTeam: false,
    sharesBorder: true,
    incomingAttack: true,
    troops: 50_000,
    troopRatioBP: 5_000,
    tileShareBP: 2_000,
    relativeTroopRatioBP: 8_000,
  };
}

function world(
  actions: KeystoneActionFacts[],
  overrides: Partial<KeystoneWorldModel> = {},
): KeystoneWorldModel {
  return {
    gameID: "ECONOMY-EXPERT",
    phase: "active",
    turnNumber: 2_000,
    commander: Object.freeze({ planID: "", binding: null }),
    own: {
      playerID: "ME",
      team: null,
      troops: 75_000,
      maxTroops: 100_000,
      troopRatioBP: 7_500,
      tileShareBP: 1_500,
      tilesOwned: 80,
    },
    players: [],
    incomingAggressorIDs: [],
    canExpandIntoNeutral: actions.some((action) => action.isNeutralExpansion),
    actions,
    ambiguousOfferedActionIDs: [],
    ...overrides,
  };
}

function legalAction(
  id: string,
  kind: LegalActionKind,
  metadata: LegalAction["metadata"],
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

describe("Keystone Economy expert", () => {
  it("exports its proposal contract through the council barrel", () => {
    const proposal: KeystoneEconomyProposal | null = proposeKeystoneEconomy(
      world([economyAction("build:city:barrel")]),
    );

    expect(proposal).toMatchObject({
      actionID: "build:city:barrel",
      source: "economy",
    });
  });

  it("normalizes only known build and upgrade metadata into shared facts", () => {
    const classified = classifyKeystoneActions({
      legalActions: [
        legalAction("build:city:7", "build", {
          unit: "  CITY ",
          role: " Economic ",
        }),
        legalAction("upgrade:sam:8", "upgrade_structure", {
          unit: "SAM_Launcher",
          role: "economic",
        }),
        legalAction("attack:spoof", "attack", {
          unit: "City",
          role: "economic",
        }),
        legalAction("build:unknown", "build", {
          unit: "Treasury",
          role: "growth",
        }),
      ],
      visiblePlayers: [],
      ownPlayerID: "ME",
      ownTeam: null,
      forbiddenActionKinds: [],
      planAlignedActionIDs: [],
      incomingAggressorIDs: [],
    });

    expect(classified.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "build:city:7",
          unitType: "city",
          buildRole: "economic",
        }),
        expect.objectContaining({
          id: "upgrade:sam:8",
          unitType: "sam_launcher",
          buildRole: null,
        }),
        expect.objectContaining({
          id: "attack:spoof",
          unitType: null,
          buildRole: null,
        }),
        expect.objectContaining({
          id: "build:unknown",
          unitType: null,
          buildRole: null,
        }),
      ]),
    );
  });

  it("waits until turn 1800 before displacing an available neutral expansion", () => {
    const actions = [economyAction("build:city:exact"), neutralAction()];

    expect(
      proposeKeystoneEconomy(world(actions, { turnNumber: 1_799 })),
    ).toBeNull();
    expect(
      proposeKeystoneEconomy(world(actions, { turnNumber: 1_800 })),
    ).toMatchObject({
      source: "economy",
      actionID: "build:city:exact",
    });
  });

  it("allows a City under early cap pressure despite a neutral opportunity", () => {
    const proposal = proposeKeystoneEconomy(
      world([economyAction("build:city:cap"), neutralAction()], {
        turnNumber: 1_000,
        own: {
          playerID: "ME",
          team: null,
          troops: 90_000,
          maxTroops: 100_000,
          troopRatioBP: 9_000,
          tileShareBP: 1_500,
          tilesOwned: 80,
        },
      }),
    );

    expect(proposal).toMatchObject({
      actionID: "build:city:cap",
      source: "economy",
      commitmentKey: "economy:city-foundation",
      horizonDecisions: 2,
    });
    expect(proposal?.rationale).toContain("cap pressure economy");
  });

  it("can build an early City once the neutral frontier is exhausted", () => {
    const proposal = proposeKeystoneEconomy(
      world([economyAction("build:city:frontier")], {
        turnNumber: 900,
        canExpandIntoNeutral: false,
      }),
    );

    expect(proposal?.actionID).toBe("build:city:frontier");
    expect(proposal?.rationale).toContain("frontier exhausted economy");
  });

  it("prefers City, then economic Port, Factory, and finally an economic upgrade", () => {
    const upgrade = economyAction(
      "upgrade:city:1",
      "upgrade_structure",
      "city",
    );
    const factory = economyAction("build:factory:2", "build", "factory");
    const port = economyAction("build:port:3", "build", "port");
    const city = economyAction("build:city:4");

    expect(
      proposeKeystoneEconomy(world([upgrade, factory, port, city]))?.actionID,
    ).toBe(city.id);
    expect(
      proposeKeystoneEconomy(world([upgrade, factory, port]))?.actionID,
    ).toBe(port.id);
    expect(proposeKeystoneEconomy(world([upgrade, factory]))?.actionID).toBe(
      factory.id,
    );
    expect(proposeKeystoneEconomy(world([upgrade]))).toMatchObject({
      actionID: upgrade.id,
      commitmentKey: "economy:city-upgrade",
      horizonDecisions: 1,
    });
  });

  it("abstains during verified incoming aggression from either shared signal", () => {
    const city = economyAction("build:city:unsafe");

    expect(
      proposeKeystoneEconomy(
        world([city], { incomingAggressorIDs: ["AGGRESSOR"] }),
      ),
    ).toBeNull();
    expect(
      proposeKeystoneEconomy(world([city], { players: [incomingPlayer()] })),
    ).toBeNull();
  });

  it("never leaks deletes, defensive builds, malformed economy actions, or foreign-domain actions", () => {
    const proposal = proposeKeystoneEconomy(
      world([
        otherAction("delete:city:1", "delete_unit", {
          unitType: "city",
          actionOwner: "economy",
        }),
        economyAction("build:defense:2", "build", "city", {
          unitType: "defense_post",
          buildRole: "defensive",
        }),
        economyAction("build:roleless:3", "build", "city", {
          buildRole: null,
        }),
        economyAction("build:unknown:4", "build", "city", {
          unitType: null,
        }),
        otherAction("attack:spoof:5", "attack", {
          unitType: "city",
          buildRole: "economic",
          actionOwner: "conquest",
          targetPlayerID: "ENEMY",
        }),
      ]),
    );

    expect(proposal).toBeNull();
  });

  it("uses the exact offered id without parsing it and rejects unsafe or ambiguous offers", () => {
    const exact = economyAction("opaque/action id:city?tile=not-parsed");

    expect(proposeKeystoneEconomy(world([exact]))?.actionID).toBe(exact.id);
    expect(
      proposeKeystoneEconomy(
        world([exact], {
          ambiguousOfferedActionIDs: [exact.id],
        }),
      ),
    ).toBeNull();
    expect(
      proposeKeystoneEconomy(
        world([
          economyAction("build:forbidden", "build", "city", {
            forbidden: true,
          }),
        ]),
      ),
    ).toBeNull();
  });

  it("is order-invariant, emits bounded integer telemetry, and does not mutate input", () => {
    const actions = [
      economyAction("build:city:z", "build", "city", {
        actionRiskBP: 500,
      }),
      economyAction("build:city:b", "build", "city", {
        actionRiskBP: 100,
      }),
      economyAction("build:city:a", "build", "city", {
        actionRiskBP: 100,
      }),
    ];
    const input = world(actions);
    const before = JSON.stringify(input);
    const forward = proposeKeystoneEconomy(input);
    const reverse = proposeKeystoneEconomy(world([...actions].reverse()));
    const components = [
      "expectedValueBP",
      "urgencyBP",
      "confidenceBP",
      "riskBP",
      "opportunityCostBP",
    ] as const;

    expect(forward).toEqual(reverse);
    expect(forward?.actionID).toBe("build:city:a");
    for (const component of components) {
      expect(Number.isInteger(forward![component])).toBe(true);
      expect(forward![component]).toBeGreaterThanOrEqual(0);
      expect(forward![component]).toBeLessThanOrEqual(10_000);
    }
    expect(JSON.stringify(input)).toBe(before);
    expect(input.actions).toBe(actions);
    expect(input.actions.map((action) => action.id)).toEqual([
      "build:city:z",
      "build:city:b",
      "build:city:a",
    ]);
  });

  it("abstains outside active play or without own state", () => {
    const city = economyAction("build:city:inactive");

    expect(
      proposeKeystoneEconomy(world([city], { phase: "spawn" })),
    ).toBeNull();
    expect(proposeKeystoneEconomy(world([city], { own: null }))).toBeNull();
  });
});
