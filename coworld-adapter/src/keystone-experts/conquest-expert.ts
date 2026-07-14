import { computeKeystoneBidBP } from "./bid";
import type {
  KeystoneActionFacts,
  KeystoneBidComponents,
  KeystoneExpertProposal,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "./types";

type ConquestActionKind =
  | "attack"
  | "boat"
  | "nuke"
  | "warship"
  | "move_warship";

export type KeystoneConquestProposal = KeystoneExpertProposal & {
  readonly source: "conquest";
};

interface ScoredConquestAction {
  readonly action: KeystoneActionFacts & {
    readonly kind: ConquestActionKind;
  };
  readonly proposal: KeystoneConquestProposal;
  readonly bidBP: number;
  readonly targetPlayerID: string | null;
}

const kindPreference: Readonly<Record<ConquestActionKind, number>> =
  Object.freeze({
    attack: 0,
    boat: 1,
    warship: 2,
    move_warship: 3,
    nuke: 4,
  });

/**
 * Proposes one risk-adjusted conquest action from the shared council model.
 * The proposer only sees centrally classified facts and can never manufacture
 * an intent or an action id that was not offered by the canonical action path.
 */
export function proposeKeystoneConquest(
  world: KeystoneWorldModel,
): KeystoneConquestProposal | null {
  if (world.phase !== "active" || world.own === null) {
    return null;
  }

  const playerByID = new Map(
    world.players.map((player) => [player.playerID, player]),
  );
  const incomingAggressorIDs = new Set(world.incomingAggressorIDs);
  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  const scored: ScoredConquestAction[] = [];

  for (const action of world.actions) {
    if (
      !isConquestAction(action) ||
      action.actionOwner !== "conquest" ||
      action.forbidden ||
      action.safetyBlocked ||
      action.targetsSelf ||
      action.targetsFriendlyOrTeam ||
      action.isNeutralExpansion ||
      action.isSpawn ||
      action.isHold ||
      ambiguousIDs.has(action.id)
    ) {
      continue;
    }

    const candidate = scoreAction(
      world,
      action,
      playerByID,
      incomingAggressorIDs,
    );
    if (candidate !== null) {
      scored.push(candidate);
    }
  }

  scored.sort(compareScoredConquestActions);
  return scored[0]?.proposal ?? null;
}

function scoreAction(
  world: KeystoneWorldModel,
  action: KeystoneActionFacts & { readonly kind: ConquestActionKind },
  playerByID: ReadonlyMap<string, KeystonePlayerFacts>,
  incomingAggressorIDs: ReadonlySet<string>,
): ScoredConquestAction | null {
  let target: KeystonePlayerFacts | null = null;
  if (isTargetedConquestKind(action.kind)) {
    if (action.targetPlayerID === null) {
      return null;
    }
    target = playerByID.get(action.targetPlayerID) ?? null;
    if (
      target === null ||
      !target.isAlive ||
      target.friendlyOrTeam ||
      target.incomingAttack ||
      incomingAggressorIDs.has(target.playerID)
    ) {
      return null;
    }
  } else if (action.targetPlayerID !== null) {
    return null;
  }

  const timing = conquestTiming(world);
  const relativeTroopRatioBP =
    target === null ? null : targetRelativeTroopRatioBP(world, target);
  const targetTileShareBP =
    target === null ? null : clampBP(target.tileShareBP ?? 0);
  const baseComponents =
    target === null && isNavalConquestKind(action.kind)
      ? scoreNavalAction(world, action.kind, timing)
      : target !== null && isTargetedConquestKind(action.kind)
        ? scoreTargetedAction(
            world,
            action.kind,
            target,
            relativeTroopRatioBP!,
            targetTileShareBP!,
            timing,
          )
        : null;
  if (baseComponents === null) {
    return null;
  }
  const components = freezeComponents({
    ...baseComponents,
    riskBP: action.actionRiskBP,
  });
  const proposal = proposalFor(
    action,
    target,
    relativeTroopRatioBP,
    targetTileShareBP,
    timing,
    components,
  );
  const bidBP = computeKeystoneBidBP(proposal, action.actionRiskBP);
  if (bidBP <= 0) {
    return null;
  }
  return Object.freeze({
    action,
    proposal,
    bidBP,
    targetPlayerID: target?.playerID ?? null,
  });
}

interface ConquestTiming {
  readonly hostileContact: boolean;
  readonly turnWindowBP: number;
}

function conquestTiming(world: KeystoneWorldModel): ConquestTiming {
  const hostileContact =
    world.incomingAggressorIDs.length > 0 ||
    world.players.some(
      (player) =>
        player.isAlive && player.sharesBorder && !player.friendlyOrTeam,
    );
  return Object.freeze({
    hostileContact,
    turnWindowBP: clampBP((world.turnNumber - 800) * 2),
  });
}

function scoreTargetedAction(
  world: KeystoneWorldModel,
  kind: "attack" | "boat" | "nuke",
  target: KeystonePlayerFacts,
  relativeTroopRatioBP: number,
  targetTileShareBP: number,
  timing: ConquestTiming,
): KeystoneBidComponents {
  const advantageBP = clampBP(
    Math.trunc(((relativeTroopRatioBP - 7_500) * 2) / 5),
  );
  const disadvantageBP = clampRange(
    Math.trunc((10_000 - relativeTroopRatioBP) / 2),
    0,
    2_500,
  );
  const tilePayoffBP = clampRange(
    Math.trunc((targetTileShareBP * 3) / 4),
    0,
    2_000,
  );
  const borderBP = target.sharesBorder ? 1_400 : 0;
  const contactUrgencyBP = timing.hostileContact ? 600 : 0;
  const neutralOpportunityCostBP = world.canExpandIntoNeutral ? 1_200 : 0;

  switch (kind) {
    case "attack":
      return freezeComponents({
        expectedValueBP: clampBP(3_200 + advantageBP + tilePayoffBP + borderBP),
        urgencyBP: clampBP(
          2_000 +
            timing.turnWindowBP +
            (target.sharesBorder ? 2_400 : 0) +
            contactUrgencyBP,
        ),
        confidenceBP: clampBP(
          4_200 +
            Math.trunc((advantageBP * 3) / 4) +
            (target.sharesBorder ? 1_800 : 0) -
            disadvantageBP,
        ),
        riskBP: 0,
        opportunityCostBP: clampBP(
          1_800 + disadvantageBP + neutralOpportunityCostBP,
        ),
      });
    case "boat":
      return freezeComponents({
        expectedValueBP: clampBP(
          2_600 +
            advantageBP +
            tilePayoffBP +
            (target.sharesBorder ? 200 : 700),
        ),
        urgencyBP: clampBP(1_600 + timing.turnWindowBP + contactUrgencyBP),
        confidenceBP: clampBP(
          3_600 +
            Math.trunc((advantageBP * 2) / 3) +
            (target.sharesBorder ? 0 : 1_000) -
            disadvantageBP,
        ),
        riskBP: 0,
        opportunityCostBP: clampBP(
          2_800 + disadvantageBP + neutralOpportunityCostBP,
        ),
      });
    case "nuke":
      return freezeComponents({
        expectedValueBP: clampBP(
          1_200 +
            tilePayoffBP +
            timing.turnWindowBP +
            Math.trunc(advantageBP / 2),
        ),
        urgencyBP: clampBP(
          1_000 +
            timing.turnWindowBP +
            (target.sharesBorder ? 800 : 0) +
            contactUrgencyBP,
        ),
        confidenceBP: clampBP(
          2_800 +
            Math.trunc(advantageBP / 2) +
            (target.sharesBorder ? 500 : 0) -
            disadvantageBP,
        ),
        riskBP: 0,
        opportunityCostBP: clampBP(
          4_800 + disadvantageBP + neutralOpportunityCostBP,
        ),
      });
  }
}

function scoreNavalAction(
  world: KeystoneWorldModel,
  kind: "warship" | "move_warship",
  timing: ConquestTiming,
): KeystoneBidComponents {
  const contactValueBP = timing.hostileContact ? 1_500 : 0;
  const neutralOpportunityCostBP = world.canExpandIntoNeutral ? 1_000 : 0;
  if (kind === "warship") {
    return freezeComponents({
      expectedValueBP: clampBP(2_400 + timing.turnWindowBP + contactValueBP),
      urgencyBP: clampBP(
        1_000 +
          Math.trunc(timing.turnWindowBP / 2) +
          (timing.hostileContact ? 1_800 : 0),
      ),
      confidenceBP: timing.hostileContact ? 5_800 : 4_500,
      riskBP: 0,
      opportunityCostBP: clampBP(4_500 + neutralOpportunityCostBP),
    });
  }
  return freezeComponents({
    expectedValueBP: clampBP(1_800 + timing.turnWindowBP + contactValueBP),
    urgencyBP: clampBP(
      1_800 +
        Math.trunc(timing.turnWindowBP / 2) +
        (timing.hostileContact ? 1_500 : 0),
    ),
    confidenceBP: timing.hostileContact ? 5_500 : 4_200,
    riskBP: 0,
    opportunityCostBP: clampBP(3_000 + neutralOpportunityCostBP),
  });
}

function proposalFor(
  action: KeystoneActionFacts & { readonly kind: ConquestActionKind },
  target: KeystonePlayerFacts | null,
  relativeTroopRatioBP: number | null,
  targetTileShareBP: number | null,
  timing: ConquestTiming,
  components: KeystoneBidComponents,
): KeystoneConquestProposal {
  const mode = action.kind === "move_warship" ? "move-warship" : action.kind;
  const targetRationale =
    target === null
      ? `contact=${timing.hostileContact ? 1 : 0} turnWindowBP=${timing.turnWindowBP}`
      : `target=${target.playerID} border=${target.sharesBorder ? 1 : 0} relativeBP=${relativeTroopRatioBP} shareBP=${targetTileShareBP}`;
  return Object.freeze({
    proposalID: `conquest:${mode}:${action.id}`,
    actionID: action.id,
    source: "conquest",
    rationale: `conquest ${mode}; ${targetRationale} riskBP=${components.riskBP}`,
    ...components,
    commitmentKey:
      target === null
        ? "conquest:naval-control"
        : `conquest:target:${target.playerID}`,
    horizonDecisions:
      action.kind === "attack"
        ? 3
        : action.kind === "boat" || action.kind === "warship"
          ? 2
          : 1,
  });
}

function targetRelativeTroopRatioBP(
  world: KeystoneWorldModel,
  target: KeystonePlayerFacts,
): number {
  if (target.relativeTroopRatioBP !== null) {
    return clampRange(target.relativeTroopRatioBP, 0, 30_000);
  }
  if (target.troops > 0 && world.own !== null) {
    return clampRange(
      Math.trunc((world.own.troops * 10_000) / target.troops),
      0,
      30_000,
    );
  }
  return 10_000;
}

function compareScoredConquestActions(
  a: ScoredConquestAction,
  b: ScoredConquestAction,
): number {
  return (
    b.bidBP - a.bidBP ||
    kindPreference[a.action.kind] - kindPreference[b.action.kind] ||
    compareText(a.targetPlayerID ?? "", b.targetPlayerID ?? "") ||
    compareText(a.action.id, b.action.id)
  );
}

function isConquestActionKind(
  kind: KeystoneActionFacts["kind"],
): kind is ConquestActionKind {
  return (
    kind === "attack" ||
    kind === "boat" ||
    kind === "nuke" ||
    kind === "warship" ||
    kind === "move_warship"
  );
}

function isConquestAction(
  action: KeystoneActionFacts,
): action is KeystoneActionFacts & { readonly kind: ConquestActionKind } {
  return isConquestActionKind(action.kind);
}

function isTargetedConquestKind(
  kind: ConquestActionKind,
): kind is "attack" | "boat" | "nuke" {
  return kind === "attack" || kind === "boat" || kind === "nuke";
}

function isNavalConquestKind(
  kind: ConquestActionKind,
): kind is "warship" | "move_warship" {
  return kind === "warship" || kind === "move_warship";
}

function freezeComponents(
  components: KeystoneBidComponents,
): KeystoneBidComponents {
  return Object.freeze({
    expectedValueBP: clampBP(components.expectedValueBP),
    urgencyBP: clampBP(components.urgencyBP),
    confidenceBP: clampBP(components.confidenceBP),
    riskBP: clampBP(components.riskBP),
    opportunityCostBP: clampBP(components.opportunityCostBP),
  });
}

function clampBP(value: number): number {
  return clampRange(value, 0, 10_000);
}

function clampRange(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return maximum;
  }
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
