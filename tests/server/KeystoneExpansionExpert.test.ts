import { describe, expect, it } from "vitest";

import type {
  KeystoneActionFacts,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "../../coworld-adapter/src/keystone-experts";
import { proposeKeystoneExpansion } from "../../coworld-adapter/src/keystone-experts";
import type { LegalActionKind } from "../../src/server/agents/AgentTypes";

function expansionAction(
  id: string,
  kind: "attack" | "boat" = "attack",
  overrides: Partial<KeystoneActionFacts> = {},
): KeystoneActionFacts {
  return {
    id,
    kind,
    targetPlayerID: null,
    isSpawn: false,
    isHold: false,
    isNeutralExpansion: true,
    isHostileTargetAction: false,
    targetsSelf: false,
    targetsFriendlyOrTeam: false,
    safetyBlocked: false,
    forbidden: false,
    planAligned: false,
    actionRiskBP: 1_000,
    actionOwner: "expansion",
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

function hostilePlayer(playerID = "ENEMY"): KeystonePlayerFacts {
  return {
    playerID,
    isAlive: true,
    isAllied: false,
    isFriendly: false,
    isTeammate: false,
    sameTeam: false,
    friendlyOrTeam: false,
    sharesBorder: true,
    incomingAttack: false,
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
    gameID: "EXPANSION-EXPERT",
    phase: "active",
    turnNumber: 800,
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
    canExpandIntoNeutral: actions.some(
      (action) => action.kind === "attack" && action.isNeutralExpansion,
    ),
    actions,
    ambiguousOfferedActionIDs: [],
    ...overrides,
  };
}

describe("Keystone Expansion expert", () => {
  it("always prefers safe neutral land expansion over an offered neutral boat", () => {
    const proposal = proposeKeystoneExpansion(
      world([
        expansionAction("neutral:boat", "boat", { actionRiskBP: 0 }),
        expansionAction("neutral:land", "attack", { actionRiskBP: 2_500 }),
      ]),
    );

    expect(proposal).toMatchObject({
      source: "expansion",
      actionID: "neutral:land",
      commitmentKey: "expansion:neutral-land",
      horizonDecisions: 2,
    });
  });

  it("falls back to a neutral boat only after neutral land is exhausted", () => {
    const proposal = proposeKeystoneExpansion(
      world([
        otherAction("hostile:land", "attack", {
          targetPlayerID: "ENEMY",
          actionOwner: "conquest",
        }),
        expansionAction("neutral:boat", "boat"),
      ]),
    );

    expect(proposal).toMatchObject({
      actionID: "neutral:boat",
      source: "expansion",
      commitmentKey: "expansion:neutral-boat",
      horizonDecisions: 1,
    });
    expect(proposal?.rationale).toContain("land frontier exhausted");
  });

  it("chooses independently of offered-action order", () => {
    const actions = [
      expansionAction("neutral:z", "attack", { actionRiskBP: 500 }),
      expansionAction("neutral:b", "attack", { actionRiskBP: 100 }),
      expansionAction("neutral:a", "attack", { actionRiskBP: 100 }),
    ];
    const forward = proposeKeystoneExpansion(world(actions));
    const reverse = proposeKeystoneExpansion(world([...actions].reverse()));

    expect(forward).toEqual(reverse);
    expect(forward?.actionID).toBe("neutral:a");
  });

  it("never leaks hostile, social, build, survival, spawn, or hold actions", () => {
    const proposal = proposeKeystoneExpansion(
      world([
        otherAction("hostile:attack", "attack", {
          targetPlayerID: "ENEMY",
          actionOwner: "conquest",
        }),
        otherAction("politics:alliance", "alliance_request", {
          targetPlayerID: "ENEMY",
          actionOwner: "politics",
        }),
        otherAction("economy:city", "build", { actionOwner: "economy" }),
        otherAction("survival:retreat", "retreat", {
          actionOwner: "survival",
        }),
        otherAction("system:spawn", "spawn", { actionOwner: "arbiter" }),
        otherAction("system:hold", "hold", { actionOwner: "arbiter" }),
      ]),
    );

    expect(proposal).toBeNull();
  });

  it("abstains from forbidden, safety-blocked, ambiguous, and unowned neutral-shaped actions", () => {
    const proposal = proposeKeystoneExpansion(
      world(
        [
          expansionAction("neutral:forbidden", "attack", {
            forbidden: true,
          }),
          expansionAction("neutral:blocked", "attack", {
            safetyBlocked: true,
          }),
          expansionAction("neutral:ambiguous", "attack"),
          expansionAction("neutral:unowned", "attack", {
            actionOwner: null,
          }),
          expansionAction("neutral:safe-boat", "boat"),
        ],
        { ambiguousOfferedActionIDs: ["neutral:ambiguous"] },
      ),
    );

    expect(proposal).toBeNull();
  });

  it("emits bounded integer telemetry and lowers expansion urgency after contact", () => {
    const action = expansionAction("neutral:exact-offered-id", "attack", {
      actionRiskBP: 1_234,
    });
    const opening = proposeKeystoneExpansion(world([action]));
    const contact = proposeKeystoneExpansion(
      world([action], {
        players: [hostilePlayer()],
        turnNumber: 2_000,
      }),
    );
    const componentNames = [
      "expectedValueBP",
      "urgencyBP",
      "confidenceBP",
      "riskBP",
      "opportunityCostBP",
    ] as const;

    expect(opening?.actionID).toBe("neutral:exact-offered-id");
    expect(opening?.rationale).toBe(
      "opening neutral land expansion; land frontier preferred",
    );
    expect(contact?.rationale).toBe(
      "contact neutral land expansion; land frontier preferred",
    );
    expect(opening!.urgencyBP).toBeGreaterThan(contact!.urgencyBP);
    expect(opening!.expectedValueBP).toBeGreaterThan(contact!.expectedValueBP);
    for (const proposal of [opening!, contact!]) {
      for (const name of componentNames) {
        expect(Number.isInteger(proposal[name])).toBe(true);
        expect(proposal[name]).toBeGreaterThanOrEqual(0);
        expect(proposal[name]).toBeLessThanOrEqual(10_000);
      }
    }
  });

  it("does not mutate the world model or its offered action order", () => {
    const actions = [
      expansionAction("neutral:b", "attack", { actionRiskBP: 200 }),
      expansionAction("neutral:a", "attack", { actionRiskBP: 100 }),
    ];
    const input = world(actions);
    const before = JSON.stringify(input);

    proposeKeystoneExpansion(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(input.actions).toBe(actions);
    expect(input.actions.map((action) => action.id)).toEqual([
      "neutral:b",
      "neutral:a",
    ]);
  });
});
