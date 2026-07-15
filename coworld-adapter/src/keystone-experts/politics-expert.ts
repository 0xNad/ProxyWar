import type {
  KeystoneActionFacts,
  KeystoneBidComponents,
  KeystoneExpertProposal,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "./types";

type PoliticsReaction =
  | "balance_alliance_accept"
  | "embargo_repair"
  | "hostile_request_rejection"
  | "break_to_bound_conquest"
  | "alliance_extension";

export type KeystonePoliticsProposal = KeystoneExpertProposal & {
  readonly source: "politics";
};

interface PoliticsCandidate {
  readonly action: KeystoneActionFacts;
  readonly target: KeystonePlayerFacts;
  readonly reaction: PoliticsReaction;
  readonly priority: number;
}

const MIN_BREAK_CONQUEST_RELATIVE_TROOPS_BP = 11_500;
const MIN_BREAK_CONQUEST_OWN_READINESS_BP = 5_000;

const reactionScores: Readonly<
  Record<PoliticsReaction, Omit<KeystoneBidComponents, "riskBP">>
> = Object.freeze({
  balance_alliance_accept: Object.freeze({
    expectedValueBP: 8_200,
    urgencyBP: 9_000,
    confidenceBP: 9_500,
    opportunityCostBP: 500,
  }),
  embargo_repair: Object.freeze({
    expectedValueBP: 8_500,
    urgencyBP: 9_500,
    confidenceBP: 9_700,
    opportunityCostBP: 300,
  }),
  hostile_request_rejection: Object.freeze({
    expectedValueBP: 6_000,
    urgencyBP: 8_500,
    confidenceBP: 9_300,
    opportunityCostBP: 1_000,
  }),
  break_to_bound_conquest: Object.freeze({
    expectedValueBP: 9_000,
    urgencyBP: 8_500,
    confidenceBP: 9_500,
    opportunityCostBP: 800,
  }),
  alliance_extension: Object.freeze({
    expectedValueBP: 6_500,
    urgencyBP: 6_000,
    confidenceBP: 9_000,
    opportunityCostBP: 1_500,
  }),
});

/**
 * Proposes at most one evidence-gated diplomatic reaction. The initial
 * Politics expert intentionally has no free-standing proactive policy: it may
 * repair an embargo against a friendly player, reject an alliance request
 * from a player actively attacking us, preserve an observable alliance that
 * is already in its extension window, or execute the political half of an
 * exact Commander-bound break -> conquest macro. Every other political action
 * is an abstention. A break may also be admitted by the existing reviewed
 * backstab affordance after neutral expansion is exhausted; both paths bind
 * the same target for the transaction layer to verify on acceptance.
 */
export function proposeKeystonePolitics(
  world: KeystoneWorldModel,
): KeystonePoliticsProposal | null {
  if (world.phase !== "active" || world.own === null) {
    return null;
  }

  const ambiguousActionIDs = new Set(world.ambiguousOfferedActionIDs);
  const actionIDCounts = countActionIDs(world.actions);
  const { playerByID, ambiguousPlayerIDs } = indexUniquePlayers(world.players);
  const incomingAggressorIDs = new Set(world.incomingAggressorIDs);
  const candidates: PoliticsCandidate[] = [];

  for (const action of world.actions) {
    if (
      !isCommonlyEligible(action) ||
      actionIDCounts.get(action.id) !== 1 ||
      ambiguousActionIDs.has(action.id) ||
      action.targetPlayerID === null ||
      ambiguousPlayerIDs.has(action.targetPlayerID)
    ) {
      continue;
    }
    const target = playerByID.get(action.targetPlayerID);
    if (target === undefined || target.isAlive !== true) {
      continue;
    }
    const candidate = reactionFor(world, action, target, incomingAggressorIDs);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }

  candidates.sort(comparePoliticsCandidates);
  const selected = candidates[0];
  if (selected === undefined) {
    return null;
  }
  const scores = reactionScores[selected.reaction];
  return Object.freeze({
    proposalID: `politics:${selected.reaction}:${selected.action.id}`,
    actionID: selected.action.id,
    source: "politics",
    rationale: rationaleFor(selected.reaction, selected.target.playerID),
    expectedValueBP: scores.expectedValueBP,
    urgencyBP: scores.urgencyBP,
    confidenceBP: scores.confidenceBP,
    riskBP: selected.action.actionRiskBP,
    opportunityCostBP: scores.opportunityCostBP,
  });
}

function reactionFor(
  world: KeystoneWorldModel,
  action: KeystoneActionFacts,
  target: KeystonePlayerFacts,
  incomingAggressorIDs: ReadonlySet<string>,
): PoliticsCandidate | null {
  const balanceLeaderID = world.balanceOfPower?.leaderPlayerID ?? null;
  const isBalanceLeader = target.playerID === balanceLeaderID;
  if (
    balanceLeaderID !== null &&
    action.kind === "alliance_request" &&
    !isBalanceLeader &&
    action.targetsFriendlyOrTeam === false &&
    target.friendlyOrTeam === false &&
    target.hasIncomingAllianceRequest === true &&
    target.incomingAttack === false &&
    !incomingAggressorIDs.has(target.playerID)
  ) {
    return Object.freeze({
      action,
      target,
      reaction: "balance_alliance_accept",
      priority: 0,
    });
  }

  if (
    action.kind === "embargo_stop" &&
    !isBalanceLeader &&
    action.targetsFriendlyOrTeam === true &&
    target.friendlyOrTeam === true &&
    target.hasEmbargoAgainst === true
  ) {
    return Object.freeze({
      action,
      target,
      reaction: "embargo_repair",
      priority: 0,
    });
  }

  if (
    action.kind === "break_alliance" &&
    (balanceLeaderID === null || isBalanceLeader) &&
    action.targetsFriendlyOrTeam === true &&
    target.isAllied === true &&
    target.isTeammate === false &&
    target.sameTeam === false &&
    target.sharesBorder === true &&
    target.incomingAttack === false &&
    world.incomingAggressorIDs.length === 0 &&
    target.relativeTroopRatioBP !== null &&
    target.relativeTroopRatioBP >= MIN_BREAK_CONQUEST_RELATIVE_TROOPS_BP &&
    world.own !== null &&
    world.own.troopRatioBP !== null &&
    world.own.troopRatioBP >= MIN_BREAK_CONQUEST_OWN_READINESS_BP &&
    (commanderBindsConquest(world, target.playerID) ||
      recommendedBackstabBindsConquest(world, target.playerID))
  ) {
    return Object.freeze({
      action,
      target,
      reaction: "break_to_bound_conquest",
      priority: 2,
    });
  }

  if (
    action.kind === "alliance_reject" &&
    action.targetsFriendlyOrTeam === false &&
    target.friendlyOrTeam === false &&
    target.hasIncomingAllianceRequest === true &&
    (target.incomingAttack === true ||
      incomingAggressorIDs.has(target.playerID))
  ) {
    return Object.freeze({
      action,
      target,
      reaction: "hostile_request_rejection",
      priority: 1,
    });
  }

  if (
    action.kind === "alliance_extend" &&
    !isBalanceLeader &&
    action.targetsFriendlyOrTeam === true &&
    target.isAllied === true &&
    target.friendlyOrTeam === true &&
    target.canExtendAlliance === true &&
    target.allianceInExtensionWindow === true &&
    target.incomingAttack === false &&
    !incomingAggressorIDs.has(target.playerID)
  ) {
    return Object.freeze({
      action,
      target,
      reaction: "alliance_extension",
      priority: 3,
    });
  }

  return null;
}

function commanderBindsConquest(
  world: KeystoneWorldModel,
  targetPlayerID: string,
): boolean {
  return (
    world.commander.binding?.kind === "attack_target" &&
    world.commander.binding.targetPlayerID === targetPlayerID
  );
}

function recommendedBackstabBindsConquest(
  world: KeystoneWorldModel,
  targetPlayerID: string,
): boolean {
  return (
    world.recommendedBackstabTargetID === targetPlayerID &&
    world.canExpandIntoNeutral === false &&
    world.incomingAggressorIDs.length === 0
  );
}

function isCommonlyEligible(action: KeystoneActionFacts): boolean {
  return (
    action.id.trim().length > 0 &&
    action.actionOwner === "politics" &&
    action.forbidden === false &&
    action.safetyBlocked === false &&
    action.targetsSelf === false &&
    action.isHostileTargetAction === false &&
    action.isSpawn === false &&
    action.isHold === false &&
    Number.isInteger(action.actionRiskBP) &&
    action.actionRiskBP >= 0 &&
    action.actionRiskBP <= 10_000
  );
}

function countActionIDs(
  actions: readonly KeystoneActionFacts[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.id, (counts.get(action.id) ?? 0) + 1);
  }
  return counts;
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

function comparePoliticsCandidates(
  a: PoliticsCandidate,
  b: PoliticsCandidate,
): number {
  return (
    a.priority - b.priority ||
    a.action.actionRiskBP - b.action.actionRiskBP ||
    compareText(a.action.id, b.action.id)
  );
}

function rationaleFor(
  reaction: PoliticsReaction,
  targetPlayerID: string,
): string {
  switch (reaction) {
    case "balance_alliance_accept":
      return `accept observed alliance request from nonleader ${targetPlayerID} during runaway-leader pressure`;
    case "embargo_repair":
      return `repair embargo against observed friendly target ${targetPlayerID}`;
    case "hostile_request_rejection":
      return `reject incoming alliance request from active aggressor ${targetPlayerID}`;
    case "break_to_bound_conquest":
      return `break alliance only to unlock evidence-bound conquest of ${targetPlayerID}`;
    case "alliance_extension":
      return `extend existing alliance in observed extension window with ${targetPlayerID}`;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
