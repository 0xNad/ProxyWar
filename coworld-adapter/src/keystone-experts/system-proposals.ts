import { hasCanonicalDefensivePlacementEvidence } from "./action-facts";
import { computeKeystoneBidBP } from "./bid";
import type {
  KeystoneActionFacts,
  KeystoneDirectiveProposal,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "./types";

export type KeystoneSpawnProposal = KeystoneDirectiveProposal<"spawn">;
export type KeystoneSurvivalProposal = KeystoneDirectiveProposal<"survival">;

interface SurvivalCandidate {
  readonly action: KeystoneActionFacts;
  readonly proposal: KeystoneSurvivalProposal;
  readonly categoryPriority: number;
}

const MIN_COUNTER_READINESS_BP = 3_500;
const MIN_COUNTER_RATIO_BP = 8_000;
const STRONG_COUNTER_READINESS_BP = 6_500;
const STRONG_COUNTER_RATIO_BP = 12_000;
const canonicalCounterCommitments = new Set([
  1_000, 2_000, 2_500, 3_500, 4_000,
]);

/** Chooses one exact offered spawn id. Spawn risk already represents 1 - safety. */
export function proposeKeystoneSpawn(
  world: KeystoneWorldModel,
): KeystoneSpawnProposal | null {
  if (world.phase !== "spawn") {
    return null;
  }

  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  const actions = world.actions.filter(
    (action) =>
      action.actionOwner === "arbiter" &&
      action.kind === "spawn" &&
      action.isSpawn &&
      !action.isHold &&
      action.targetPlayerID === null &&
      !action.forbidden &&
      !action.safetyBlocked &&
      !ambiguousIDs.has(action.id) &&
      isBasisPoints(action.actionRiskBP),
  );
  actions.sort(compareSafeActions);
  const selected = actions[0];
  if (selected === undefined) {
    return null;
  }

  return Object.freeze({
    proposalID: `spawn:safest:${selected.id}`,
    actionID: selected.id,
    source: "spawn",
    rationale: "safest canonical offered spawn candidate",
    expectedValueBP: 10_000 - selected.actionRiskBP,
    urgencyBP: 10_000,
    confidenceBP: 9_500,
    riskBP: selected.actionRiskBP,
    opportunityCostBP: 0,
  });
}

/**
 * Produces at most one recovery action under observed incoming pressure.
 * Retreats, defensive structures, and bounded counters remain mutually
 * exclusive proposals; all offensive counters require a unique live,
 * non-friendly aggressor and canonical commitment metadata.
 */
export function proposeKeystoneSurvival(
  world: KeystoneWorldModel,
): KeystoneSurvivalProposal | null {
  if (
    world.phase !== "active" ||
    world.own === null ||
    world.incomingAggressorIDs.length === 0
  ) {
    return null;
  }

  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  const { playerByID, ambiguousPlayerIDs } = indexUniquePlayers(world.players);
  const incomingAggressorIDs = new Set(world.incomingAggressorIDs);
  const candidates: SurvivalCandidate[] = [];

  for (const action of world.actions) {
    if (
      action.actionOwner !== "survival" ||
      action.forbidden ||
      action.safetyBlocked ||
      ambiguousIDs.has(action.id) ||
      !isBasisPoints(action.actionRiskBP)
    ) {
      continue;
    }

    const retreat = retreatCandidate(action);
    if (retreat !== null) {
      candidates.push(retreat);
      continue;
    }

    const defensiveBuild = defensiveBuildCandidate(action);
    if (defensiveBuild !== null) {
      candidates.push(defensiveBuild);
      continue;
    }

    const counter = counterCandidate({
      action,
      ownReadinessBP: world.own.troopRatioBP,
      playerByID,
      ambiguousPlayerIDs,
      incomingAggressorIDs,
    });
    if (counter !== null) {
      candidates.push(counter);
    }
  }

  candidates.sort(compareSurvivalCandidates);
  return candidates[0]?.proposal ?? null;
}

function retreatCandidate(
  action: KeystoneActionFacts,
): SurvivalCandidate | null {
  if (action.kind !== "retreat" && action.kind !== "boat_retreat") {
    return null;
  }
  const boat = action.kind === "boat_retreat";
  return freezeSurvivalCandidate({
    action,
    categoryPriority: boat ? 1 : 0,
    proposal: {
      proposalID: `survival:${action.kind}:${action.id}`,
      actionID: action.id,
      source: "survival",
      rationale: boat
        ? "recover committed transport troops under verified incoming pressure"
        : "recover committed land troops under verified incoming pressure",
      expectedValueBP: boat ? 7_800 : 8_500,
      urgencyBP: boat ? 9_200 : 10_000,
      confidenceBP: boat ? 8_500 : 9_000,
      riskBP: action.actionRiskBP,
      opportunityCostBP: boat ? 1_500 : 1_000,
    },
  });
}

function defensiveBuildCandidate(
  action: KeystoneActionFacts,
): SurvivalCandidate | null {
  if (
    action.kind !== "build" ||
    action.buildRole !== "defensive" ||
    (action.unitType !== "defense_post" &&
      action.unitType !== "sam_launcher") ||
    action.targetPlayerID !== null ||
    !hasCanonicalDefensivePlacementEvidence(action)
  ) {
    return null;
  }
  const defensePost = action.unitType === "defense_post";
  return freezeSurvivalCandidate({
    action,
    categoryPriority: defensePost ? 2 : 3,
    proposal: {
      proposalID: `survival:defensive-build:${action.unitType}:${action.id}`,
      actionID: action.id,
      source: "survival",
      rationale: `build offered ${action.unitType.replaceAll("_", " ")} under verified incoming pressure`,
      expectedValueBP: defensePost ? 8_200 : 7_000,
      urgencyBP: defensePost ? 9_000 : 7_500,
      confidenceBP: defensePost ? 9_000 : 8_000,
      riskBP: action.actionRiskBP,
      opportunityCostBP: defensePost ? 1_800 : 2_500,
    },
  });
}

function counterCandidate(input: {
  action: KeystoneActionFacts;
  ownReadinessBP: number | null;
  playerByID: ReadonlyMap<string, KeystonePlayerFacts>;
  ambiguousPlayerIDs: ReadonlySet<string>;
  incomingAggressorIDs: ReadonlySet<string>;
}): SurvivalCandidate | null {
  const { action } = input;
  if (
    (action.kind !== "attack" && action.kind !== "boat") ||
    action.targetPlayerID === null ||
    action.targetsFriendlyOrTeam ||
    input.ambiguousPlayerIDs.has(action.targetPlayerID) ||
    !input.incomingAggressorIDs.has(action.targetPlayerID) ||
    input.ownReadinessBP === null ||
    input.ownReadinessBP < MIN_COUNTER_READINESS_BP ||
    action.troopCommitmentBP === null ||
    action.troopCommitmentBP === undefined ||
    !canonicalCounterCommitments.has(action.troopCommitmentBP)
  ) {
    return null;
  }
  const target = input.playerByID.get(action.targetPlayerID);
  if (
    target === undefined ||
    !target.isAlive ||
    target.friendlyOrTeam ||
    (!target.incomingAttack &&
      !input.incomingAggressorIDs.has(target.playerID)) ||
    (target.troops > 0 &&
      (target.relativeTroopRatioBP === null ||
        target.relativeTroopRatioBP < MIN_COUNTER_RATIO_BP))
  ) {
    return null;
  }

  const desiredCommitmentBP =
    target.troops === 0
      ? 1_000
      : input.ownReadinessBP >= STRONG_COUNTER_READINESS_BP &&
          target.relativeTroopRatioBP! >= STRONG_COUNTER_RATIO_BP
        ? 4_000
        : 2_500;
  const distanceBP = Math.abs(action.troopCommitmentBP - desiredCommitmentBP);
  const strengthBP = Math.min(
    2_000,
    Math.max(0, (target.relativeTroopRatioBP ?? 10_000) - 10_000),
  );
  const finish = target.troops === 0;

  return freezeSurvivalCandidate({
    action,
    categoryPriority: 4,
    proposal: {
      proposalID: `survival:counter:${action.kind}:${action.id}`,
      actionID: action.id,
      source: "survival",
      rationale: `bounded ${action.kind} counter against verified incoming aggressor ${target.playerID} at ${Math.trunc(action.troopCommitmentBP / 100)}% canonical commitment`,
      expectedValueBP: clampBP(
        (finish ? 8_000 : 6_800) + strengthBP - Math.trunc(distanceBP / 2),
      ),
      urgencyBP: 9_000,
      confidenceBP: clampBP(
        (finish ? 9_000 : 7_000) + Math.trunc(strengthBP / 2) - distanceBP,
      ),
      riskBP: action.actionRiskBP,
      opportunityCostBP: clampBP(
        2_500 + Math.trunc(action.troopCommitmentBP / 2),
      ),
    },
  });
}

function compareSafeActions(
  a: KeystoneActionFacts,
  b: KeystoneActionFacts,
): number {
  return a.actionRiskBP - b.actionRiskBP || compareText(a.id, b.id);
}

function compareSurvivalCandidates(
  a: SurvivalCandidate,
  b: SurvivalCandidate,
): number {
  return (
    computeKeystoneBidBP(b.proposal, b.action.actionRiskBP) -
      computeKeystoneBidBP(a.proposal, a.action.actionRiskBP) ||
    a.categoryPriority - b.categoryPriority ||
    compareText(a.action.id, b.action.id) ||
    compareText(a.proposal.proposalID, b.proposal.proposalID)
  );
}

function freezeSurvivalCandidate(
  candidate: SurvivalCandidate,
): SurvivalCandidate {
  return Object.freeze({
    action: candidate.action,
    categoryPriority: candidate.categoryPriority,
    proposal: Object.freeze(candidate.proposal),
  });
}

function indexUniquePlayers(players: readonly KeystonePlayerFacts[]): {
  readonly playerByID: ReadonlyMap<string, KeystonePlayerFacts>;
  readonly ambiguousPlayerIDs: ReadonlySet<string>;
} {
  const playerByID = new Map<string, KeystonePlayerFacts>();
  const ambiguousPlayerIDs = new Set<string>();
  for (const player of players) {
    if (
      player.playerID.trim().length === 0 ||
      playerByID.has(player.playerID)
    ) {
      ambiguousPlayerIDs.add(player.playerID);
      playerByID.delete(player.playerID);
      continue;
    }
    if (!ambiguousPlayerIDs.has(player.playerID)) {
      playerByID.set(player.playerID, player);
    }
  }
  return { playerByID, ambiguousPlayerIDs };
}

function isBasisPoints(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function clampBP(value: number): number {
  return Math.round(Math.min(10_000, Math.max(0, value)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
