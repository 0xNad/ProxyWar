import { computeKeystoneBidBP } from "./bid";
import type {
  KeystoneActionFacts,
  KeystoneActionSelection,
  KeystoneArbitrationResult,
  KeystoneArbitrationTier,
  KeystoneCouncilTiers,
  KeystoneExpertProposal,
  KeystoneProposalRejection,
  KeystoneProposalSource,
  KeystoneWorldModel,
} from "./types";

type CouncilProposal =
  | KeystoneCouncilTiers["spawn"][number]
  | KeystoneCouncilTiers["survival"][number]
  | KeystoneCouncilTiers["bindingDirective"][number]
  | KeystoneExpertProposal;

type ProposalTier = Exclude<KeystoneArbitrationTier, "hold">;

interface ScoredProposal {
  proposal: CouncilProposal;
  action: KeystoneActionFacts;
  bidBP: number;
}

interface TierSpec {
  tier: ProposalTier;
  source: KeystoneProposalSource;
  proposals: readonly CouncilProposal[];
}

export function arbitrateKeystoneAction(
  world: KeystoneWorldModel,
  tiers: KeystoneCouncilTiers,
): KeystoneArbitrationResult {
  const rejections: KeystoneProposalRejection[] = [];
  const actionByID = new Map(
    world.actions.map((action) => [action.id, action]),
  );
  const ambiguousOfferedActionIDs = new Set(world.ambiguousOfferedActionIDs);
  const tierSpecs: readonly TierSpec[] = [
    { tier: "spawn", source: "spawn", proposals: tiers.spawn },
    { tier: "survival", source: "survival", proposals: tiers.survival },
    {
      tier: "binding_directive",
      source: "binding_directive",
      proposals: tiers.bindingDirective,
    },
    {
      tier: "expert_auction",
      source: "fallback",
      proposals: tiers.expertAuction,
    },
  ];

  for (const spec of tierSpecs) {
    if (spec.tier === "spawn" && world.phase !== "spawn") {
      rejectAll(rejections, spec, "spawn_phase_mismatch");
      continue;
    }
    if (spec.tier !== "spawn" && world.phase === "spawn") {
      continue;
    }

    const scored = scoreTier(
      spec,
      actionByID,
      ambiguousOfferedActionIDs,
      rejections,
    );
    // Spawn/survival/binding inputs already encode hard policy. Plan alignment
    // is therefore a pool preference only for the discretionary expert auction.
    const eligible =
      spec.tier === "expert_auction" && scored.some(planAligned)
        ? scored.filter(planAligned)
        : scored;
    const unique = deduplicateActions(eligible, spec.tier, rejections);
    const ranked = unique.sort(compareScoredProposals);
    const selected = ranked[0];
    if (selected !== undefined) {
      const runnerUp = ranked[1];
      return freezeResult({
        disposition: "proposal",
        selection: selectionFor(spec.tier, selected),
        runnerUp:
          runnerUp === undefined ? null : selectionFor(spec.tier, runnerUp),
        bidMarginBP:
          runnerUp === undefined ? null : selected.bidBP - runnerUp.bidBP,
        rejections,
      });
    }
  }

  const hold = world.actions.find(
    (action) => action.isHold && !action.forbidden && !action.safetyBlocked,
  );
  if (hold !== undefined) {
    return freezeResult({
      disposition: "hold",
      selection: Object.freeze({
        actionID: hold.id,
        actionKind: hold.kind,
        tier: "hold",
        source: "fallback",
        proposalID: null,
        bidBP: null,
        planAligned: hold.planAligned,
      }),
      runnerUp: null,
      bidMarginBP: null,
      rejections,
    });
  }

  return freezeResult({
    disposition: "abstain",
    selection: null,
    runnerUp: null,
    bidMarginBP: null,
    rejections,
  });
}

function scoreTier(
  spec: TierSpec,
  actionByID: ReadonlyMap<string, KeystoneActionFacts>,
  ambiguousOfferedActionIDs: ReadonlySet<string>,
  rejections: KeystoneProposalRejection[],
): ScoredProposal[] {
  const scored: ScoredProposal[] = [];
  for (const proposal of spec.proposals) {
    const rejection = baseRejection(
      spec,
      proposal,
      actionByID,
      ambiguousOfferedActionIDs,
    );
    if (rejection !== null) {
      rejections.push(rejection);
      continue;
    }
    const action = actionByID.get(proposal.actionID)!;
    let bidBP: number;
    try {
      bidBP = computeKeystoneBidBP(proposal, action.actionRiskBP);
      validateProposalText(proposal);
    } catch {
      rejections.push(rejectionFor(spec.tier, proposal, "invalid_proposal"));
      continue;
    }
    if (spec.tier === "expert_auction" && bidBP <= 0) {
      rejections.push(rejectionFor(spec.tier, proposal, "non_positive_bid"));
      continue;
    }
    scored.push({ proposal, action, bidBP });
  }
  return scored;
}

function baseRejection(
  spec: TierSpec,
  proposal: CouncilProposal,
  actionByID: ReadonlyMap<string, KeystoneActionFacts>,
  ambiguousOfferedActionIDs: ReadonlySet<string>,
): KeystoneProposalRejection | null {
  if (!sourceMatches(spec, proposal.source)) {
    return rejectionFor(spec.tier, proposal, "source_tier_mismatch");
  }
  if (ambiguousOfferedActionIDs.has(proposal.actionID)) {
    return rejectionFor(spec.tier, proposal, "ambiguous_offered_action");
  }
  const action = actionByID.get(proposal.actionID);
  if (action === undefined) {
    return rejectionFor(spec.tier, proposal, "non_offered_action");
  }
  if (action.forbidden) {
    return rejectionFor(spec.tier, proposal, "forbidden_action");
  }
  if (action.safetyBlocked) {
    return rejectionFor(spec.tier, proposal, "friendly_or_team_target");
  }
  if (spec.tier === "spawn" && !action.isSpawn) {
    return rejectionFor(spec.tier, proposal, "not_spawn_action");
  }
  if (!ownerMatches(spec, proposal, action)) {
    return rejectionFor(spec.tier, proposal, "action_ownership_mismatch");
  }
  return null;
}

function ownerMatches(
  spec: TierSpec,
  proposal: CouncilProposal,
  action: KeystoneActionFacts,
): boolean {
  switch (spec.tier) {
    case "spawn":
      return action.actionOwner === "arbiter" && action.isSpawn;
    case "survival":
      return action.actionOwner === "survival";
    case "binding_directive":
      return (
        action.actionOwner === "expansion" ||
        action.actionOwner === "economy" ||
        action.actionOwner === "conquest" ||
        action.actionOwner === "politics"
      );
    case "expert_auction":
      return action.actionOwner === proposal.source;
  }
}

function sourceMatches(
  spec: TierSpec,
  source: KeystoneProposalSource,
): boolean {
  return spec.tier === "expert_auction"
    ? source === "expansion" ||
        source === "economy" ||
        source === "conquest" ||
        source === "politics"
    : source === spec.source;
}

function validateProposalText(proposal: CouncilProposal): void {
  if (
    proposal.proposalID.trim().length === 0 ||
    proposal.actionID.trim().length === 0 ||
    proposal.rationale.trim().length === 0
  ) {
    throw new Error("proposal fields must be non-empty");
  }
  if (
    "horizonDecisions" in proposal &&
    proposal.horizonDecisions !== undefined &&
    (!Number.isInteger(proposal.horizonDecisions) ||
      proposal.horizonDecisions < 1)
  ) {
    throw new Error("proposal horizon must be a positive integer");
  }
}

function deduplicateActions(
  proposals: readonly ScoredProposal[],
  tier: ProposalTier,
  rejections: KeystoneProposalRejection[],
): ScoredProposal[] {
  const byAction = new Map<string, ScoredProposal[]>();
  for (const proposal of proposals) {
    const sameAction = byAction.get(proposal.action.id) ?? [];
    sameAction.push(proposal);
    byAction.set(proposal.action.id, sameAction);
  }

  const unique: ScoredProposal[] = [];
  for (const sameAction of byAction.values()) {
    sameAction.sort(compareSameActionProposals);
    const winner = sameAction[0]!;
    unique.push(winner);
    for (const duplicate of sameAction.slice(1)) {
      rejections.push(
        rejectionFor(tier, duplicate.proposal, "duplicate_action_proposal"),
      );
    }
  }
  return unique;
}

function compareScoredProposals(a: ScoredProposal, b: ScoredProposal): number {
  return (
    b.bidBP - a.bidBP ||
    compareText(a.action.id, b.action.id) ||
    compareSameActionProposals(a, b)
  );
}

function compareSameActionProposals(
  a: ScoredProposal,
  b: ScoredProposal,
): number {
  return (
    b.bidBP - a.bidBP ||
    compareText(a.proposal.source, b.proposal.source) ||
    compareText(a.proposal.proposalID, b.proposal.proposalID)
  );
}

function planAligned(candidate: ScoredProposal): boolean {
  return candidate.action.planAligned;
}

function selectionFor(
  tier: ProposalTier,
  candidate: ScoredProposal,
): KeystoneActionSelection {
  return Object.freeze({
    actionID: candidate.action.id,
    actionKind: candidate.action.kind,
    tier,
    source: candidate.proposal.source,
    proposalID: candidate.proposal.proposalID,
    bidBP: candidate.bidBP,
    planAligned: candidate.action.planAligned,
  });
}

function rejectAll(
  rejections: KeystoneProposalRejection[],
  spec: TierSpec,
  reason: KeystoneProposalRejection["reason"],
): void {
  for (const proposal of spec.proposals) {
    rejections.push(rejectionFor(spec.tier, proposal, reason));
  }
}

function rejectionFor(
  tier: ProposalTier,
  proposal: CouncilProposal,
  reason: KeystoneProposalRejection["reason"],
): KeystoneProposalRejection {
  return Object.freeze({
    tier,
    proposalID: proposal.proposalID,
    actionID: proposal.actionID,
    reason,
  });
}

function freezeResult(result: {
  disposition: KeystoneArbitrationResult["disposition"];
  selection: KeystoneActionSelection | null;
  runnerUp: KeystoneActionSelection | null;
  bidMarginBP: number | null;
  rejections: KeystoneProposalRejection[];
}): KeystoneArbitrationResult {
  return Object.freeze({
    disposition: result.disposition,
    selection: result.selection,
    runnerUp: result.runnerUp,
    bidMarginBP: result.bidMarginBP,
    rejections: Object.freeze([...result.rejections]),
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
