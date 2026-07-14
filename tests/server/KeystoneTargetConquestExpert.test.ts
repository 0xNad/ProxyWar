import { describe, expect, it } from "vitest";

import {
  proposeKeystoneConquest,
  proposeKeystoneConquestForTarget,
  type KeystoneActionFacts,
  type KeystoneOwnFacts,
  type KeystonePlayerFacts,
  type KeystoneWorldModel,
} from "../../coworld-adapter/src/keystone-experts";

function action(
  id: string,
  targetPlayerID: string | null,
  overrides: Partial<KeystoneActionFacts> = {},
): KeystoneActionFacts {
  return Object.freeze({
    id,
    kind: "attack",
    targetPlayerID,
    isSpawn: false,
    isHold: false,
    isNeutralExpansion: false,
    isHostileTargetAction: targetPlayerID !== null,
    targetsSelf: false,
    targetsFriendlyOrTeam: false,
    safetyBlocked: false,
    forbidden: false,
    planAligned: false,
    actionRiskBP: 1_000,
    troopCommitmentBP: 3_500,
    actionOwner: "conquest",
    ...overrides,
  });
}

function player(
  playerID: string,
  overrides: Partial<KeystonePlayerFacts> = {},
): KeystonePlayerFacts {
  return Object.freeze({
    playerID,
    isAlive: true,
    isAllied: false,
    isFriendly: false,
    isTeammate: false,
    sameTeam: false,
    friendlyOrTeam: false,
    sharesBorder: true,
    incomingAttack: false,
    troops: 40_000,
    troopRatioBP: 5_000,
    tileShareBP: 1_000,
    relativeTroopRatioBP: 14_000,
    ...overrides,
  });
}

const readyOwn: KeystoneOwnFacts = Object.freeze({
  playerID: "ME",
  team: null,
  troops: 75_000,
  maxTroops: 100_000,
  troopRatioBP: 7_500,
  tileShareBP: 3_000,
  tilesOwned: 80,
});

function world(args: {
  actions: readonly KeystoneActionFacts[];
  players?: readonly KeystonePlayerFacts[];
  own?: KeystoneOwnFacts | null;
  incomingAggressorIDs?: readonly string[];
  ambiguousOfferedActionIDs?: readonly string[];
  phase?: KeystoneWorldModel["phase"];
}): KeystoneWorldModel {
  return Object.freeze({
    gameID: "TARGET-CONQUEST-EXPERT",
    phase: args.phase ?? "active",
    turnNumber: 1_500,
    commander: Object.freeze({ planID: "target-test", binding: null }),
    own: args.own === undefined ? readyOwn : args.own,
    players: Object.freeze([...(args.players ?? [])]),
    incomingAggressorIDs: Object.freeze([...(args.incomingAggressorIDs ?? [])]),
    canExpandIntoNeutral: false,
    recommendedBackstabTargetID: null,
    actions: Object.freeze([...args.actions]),
    ambiguousOfferedActionIDs: Object.freeze([
      ...(args.ambiguousOfferedActionIDs ?? []),
    ]),
  });
}

describe("target-constrained Keystone Conquest expert", () => {
  it("returns the best exact offered conventional action only for the bound target", () => {
    const model = world({
      actions: [
        action("attack:other:exact", "OTHER", { troopCommitmentBP: 3_500 }),
        action("boat:target:exact", "TARGET", {
          kind: "boat",
          troopCommitmentBP: 3_500,
        }),
        action("attack:target:25/%", "TARGET", {
          troopCommitmentBP: 2_500,
        }),
        action("attack:target:35/%", "TARGET", {
          troopCommitmentBP: 3_500,
        }),
      ],
      players: [
        player("OTHER", { relativeTroopRatioBP: 30_000 }),
        player("TARGET"),
      ],
    });

    expect(proposeKeystoneConquest(model)?.actionID).toBe("attack:other:exact");
    expect(proposeKeystoneConquestForTarget(model, "TARGET")).toMatchObject({
      actionID: "attack:target:35/%",
      source: "conquest",
      commitmentKey: "conquest:target:TARGET",
    });
  });

  it("can select a player-targeted boat but never broadens to another target or weapon kind", () => {
    const model = world({
      actions: [
        action("attack:other", "OTHER"),
        action("boat:target:exact", "TARGET", { kind: "boat" }),
        action("nuke:target", "TARGET", { kind: "nuke" }),
        action("warship:target", "TARGET", { kind: "warship" }),
        action("move-warship:target", "TARGET", { kind: "move_warship" }),
        action("neutral:targetless", null, {
          isHostileTargetAction: false,
          isNeutralExpansion: true,
          actionOwner: "expansion",
        }),
        action("hold:targetless", null, {
          kind: "hold",
          isHold: true,
          isHostileTargetAction: false,
          actionOwner: null,
        }),
      ],
      players: [player("TARGET"), player("OTHER")],
    });

    expect(proposeKeystoneConquestForTarget(model, "TARGET")?.actionID).toBe(
      "boat:target:exact",
    );
  });

  it("abstains for empty, missing, ambiguous, friendly, team, unsafe, and unready targets", () => {
    const safe = action("attack:target", "TARGET");
    const target = player("TARGET");

    expect(
      proposeKeystoneConquestForTarget(
        world({ actions: [safe], players: [target] }),
        "",
      ),
    ).toBeNull();
    expect(
      proposeKeystoneConquestForTarget(
        world({ actions: [safe], players: [target] }),
        "MISSING",
      ),
    ).toBeNull();
    expect(
      proposeKeystoneConquestForTarget(
        world({ actions: [safe], players: [target, player("TARGET")] }),
        "TARGET",
      ),
    ).toBeNull();

    for (const unsafeTarget of [
      player("TARGET", { isFriendly: true, friendlyOrTeam: true }),
      player("TARGET", {
        isTeammate: true,
        sameTeam: true,
        friendlyOrTeam: true,
      }),
      player("TARGET", { incomingAttack: true }),
    ]) {
      expect(
        proposeKeystoneConquestForTarget(
          world({ actions: [safe], players: [unsafeTarget] }),
          "TARGET",
        ),
      ).toBeNull();
    }

    for (const unsafeAction of [
      action("attack:forbidden", "TARGET", { forbidden: true }),
      action("attack:blocked", "TARGET", { safetyBlocked: true }),
      action("attack:friendly", "TARGET", {
        targetsFriendlyOrTeam: true,
      }),
    ]) {
      expect(
        proposeKeystoneConquestForTarget(
          world({ actions: [unsafeAction], players: [target] }),
          "TARGET",
        ),
      ).toBeNull();
    }

    expect(
      proposeKeystoneConquestForTarget(
        world({
          actions: [safe],
          players: [target],
          ambiguousOfferedActionIDs: [safe.id],
        }),
        "TARGET",
      ),
    ).toBeNull();
    expect(
      proposeKeystoneConquestForTarget(
        world({
          actions: [safe],
          players: [target],
          incomingAggressorIDs: ["TARGET"],
        }),
        "TARGET",
      ),
    ).toBeNull();
    expect(
      proposeKeystoneConquestForTarget(
        world({
          actions: [safe],
          players: [target],
          own: Object.freeze({ ...readyOwn, troopRatioBP: 3_499 }),
        }),
        "TARGET",
      ),
    ).toBeNull();
  });

  it("requires the same bounded conquest evidence as the ordinary expert", () => {
    const model = world({
      actions: [action("attack:unsupported", "TARGET")],
      players: [
        player("TARGET", {
          relativeTroopRatioBP: 10_000,
          tileShareBP: 1_000,
        }),
      ],
    });

    expect(proposeKeystoneConquest(model)).toBeNull();
    expect(proposeKeystoneConquestForTarget(model, "TARGET")).toBeNull();
  });
});
