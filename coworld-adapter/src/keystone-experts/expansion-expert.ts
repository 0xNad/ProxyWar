import type {
  KeystoneActionFacts,
  KeystoneExpertProposal,
  KeystoneWorldModel,
} from "./types";

const OPENING_END_TURN = 1_400;

type ExpansionOpportunity = "opening" | "frontier" | "contact";
type ExpansionMode = "land" | "boat";

export type KeystoneExpansionProposal = KeystoneExpertProposal & {
  readonly source: "expansion";
};

interface ExpansionScorecard {
  readonly expectedValueBP: number;
  readonly urgencyBP: number;
  readonly confidenceBP: number;
  readonly opportunityCostBP: number;
}

const opportunityScores: Readonly<
  Record<ExpansionOpportunity, ExpansionScorecard>
> = Object.freeze({
  opening: Object.freeze({
    expectedValueBP: 9_200,
    urgencyBP: 9_400,
    confidenceBP: 9_600,
    opportunityCostBP: 500,
  }),
  frontier: Object.freeze({
    expectedValueBP: 8_500,
    urgencyBP: 8_000,
    confidenceBP: 9_200,
    opportunityCostBP: 1_500,
  }),
  contact: Object.freeze({
    expectedValueBP: 7_200,
    urgencyBP: 5_600,
    confidenceBP: 8_800,
    opportunityCostBP: 3_200,
  }),
});

/**
 * Proposes one safe neutral-expansion action from the shared council model.
 * Land always outranks boats; boats are a deterministic frontier fallback once
 * the offered action set contains no neutral land expansion.
 */
export function proposeKeystoneExpansion(
  world: KeystoneWorldModel,
): KeystoneExpansionProposal | null {
  if (world.phase !== "active" || world.own === null) {
    return null;
  }

  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  const neutralLandOffered = world.actions.some(
    (action) =>
      action.kind === "attack" &&
      action.isNeutralExpansion &&
      !action.isHostileTargetAction &&
      action.targetPlayerID === null,
  );
  const eligible = world.actions.filter(
    (action) =>
      action.actionOwner === "expansion" &&
      action.isNeutralExpansion &&
      !action.isHostileTargetAction &&
      !action.isSpawn &&
      !action.isHold &&
      !action.forbidden &&
      !action.safetyBlocked &&
      action.targetPlayerID === null &&
      !ambiguousIDs.has(action.id) &&
      (action.kind === "attack" || action.kind === "boat"),
  );
  const land = chooseDeterministically(
    eligible.filter((action) => action.kind === "attack"),
  );
  const selected = neutralLandOffered
    ? land
    : chooseDeterministically(
        eligible.filter((action) => action.kind === "boat"),
      );
  if (selected === null) {
    return null;
  }

  const mode: ExpansionMode = selected.kind === "attack" ? "land" : "boat";
  const opportunity = expansionOpportunity(world);
  const score = scoreExpansion(opportunity, mode);

  return Object.freeze({
    proposalID: `expansion:${opportunity}:${mode}:${selected.id}`,
    actionID: selected.id,
    source: "expansion",
    rationale:
      mode === "land"
        ? `${opportunity} neutral land expansion; land frontier preferred`
        : `${opportunity} neutral boat expansion; land frontier exhausted`,
    expectedValueBP: score.expectedValueBP,
    urgencyBP: score.urgencyBP,
    confidenceBP: score.confidenceBP,
    riskBP: basisPoints(selected.actionRiskBP),
    opportunityCostBP: score.opportunityCostBP,
    commitmentKey: `expansion:neutral-${mode}`,
    horizonDecisions: mode === "land" ? 2 : 1,
  });
}

function chooseDeterministically(
  actions: readonly KeystoneActionFacts[],
): KeystoneActionFacts | null {
  let selected: KeystoneActionFacts | null = null;
  for (const action of actions) {
    if (selected === null || compareExpansionActions(action, selected) < 0) {
      selected = action;
    }
  }
  return selected;
}

function compareExpansionActions(
  a: KeystoneActionFacts,
  b: KeystoneActionFacts,
): number {
  return (
    basisPoints(a.actionRiskBP) - basisPoints(b.actionRiskBP) ||
    compareText(a.id, b.id)
  );
}

function expansionOpportunity(world: KeystoneWorldModel): ExpansionOpportunity {
  const hostileContact =
    world.incomingAggressorIDs.length > 0 ||
    world.players.some(
      (player) =>
        player.isAlive && player.sharesBorder && !player.friendlyOrTeam,
    );
  if (hostileContact) {
    return "contact";
  }
  return world.turnNumber < OPENING_END_TURN ? "opening" : "frontier";
}

function scoreExpansion(
  opportunity: ExpansionOpportunity,
  mode: ExpansionMode,
): ExpansionScorecard {
  const base = opportunityScores[opportunity];
  if (mode === "land") {
    return base;
  }
  return Object.freeze({
    expectedValueBP: basisPoints(base.expectedValueBP - 1_200),
    urgencyBP: basisPoints(base.urgencyBP - 1_000),
    confidenceBP: basisPoints(base.confidenceBP - 800),
    opportunityCostBP: basisPoints(base.opportunityCostBP + 1_200),
  });
}

function basisPoints(value: number): number {
  if (!Number.isFinite(value)) {
    return 10_000;
  }
  return Math.round(Math.min(10_000, Math.max(0, value)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
