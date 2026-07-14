import { computeKeystoneBidBP } from "./bid";
import type {
  KeystoneActionFacts,
  KeystoneActionSelection,
  KeystoneArbitrationResult,
  KeystoneArbitrationTier,
  KeystoneAuctionContext,
  KeystoneAuctionTrace,
  KeystoneCouncilTiers,
  KeystoneExpertDomain,
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
  rawBidBP: number;
  planBonusBP: number;
  auctionScoreBP: number;
}

interface TierSpec {
  tier: ProposalTier;
  source: KeystoneProposalSource;
  proposals: readonly CouncilProposal[];
}

export const DEFAULT_KEYSTONE_PLAN_ALIGNMENT_BONUS_BP = 500;
export const DEFAULT_KEYSTONE_SWITCH_MARGIN_BP = 500;

const DEFAULT_AUCTION_CONTEXT: KeystoneAuctionContext = Object.freeze({
  incumbent: null,
  planAlignmentBonusBP: DEFAULT_KEYSTONE_PLAN_ALIGNMENT_BONUS_BP,
  switchMarginBP: DEFAULT_KEYSTONE_SWITCH_MARGIN_BP,
});

export function arbitrateKeystoneAction(
  world: KeystoneWorldModel,
  tiers: KeystoneCouncilTiers,
  auctionContext: KeystoneAuctionContext = DEFAULT_AUCTION_CONTEXT,
): KeystoneArbitrationResult {
  assertBasisPoints(
    "planAlignmentBonusBP",
    auctionContext.planAlignmentBonusBP,
  );
  assertBasisPoints("switchMarginBP", auctionContext.switchMarginBP);
  const rejections: KeystoneProposalRejection[] = [];
  let auction: KeystoneAuctionTrace | null = null;
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
      auctionContext.planAlignmentBonusBP,
    );
    const unique = deduplicateActions(scored, spec.tier, rejections);
    const ranked = unique.sort(compareScoredProposals);
    const ordered =
      spec.tier === "expert_auction"
        ? rankExpertAuction(ranked, auctionContext)
        : { ranked, trace: null };
    if (spec.tier === "expert_auction") {
      auction = ordered.trace;
    }
    const selected = ordered.ranked[0];
    if (selected !== undefined) {
      const runnerUp = ordered.ranked[1];
      return freezeResult({
        disposition: "proposal",
        selection: selectionFor(spec.tier, selected),
        runnerUp:
          runnerUp === undefined ? null : selectionFor(spec.tier, runnerUp),
        bidMarginBP:
          runnerUp === undefined ? null : selected.rawBidBP - runnerUp.rawBidBP,
        auction,
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
      auction,
      rejections,
    });
  }

  return freezeResult({
    disposition: "abstain",
    selection: null,
    runnerUp: null,
    bidMarginBP: null,
    auction,
    rejections,
  });
}

function scoreTier(
  spec: TierSpec,
  actionByID: ReadonlyMap<string, KeystoneActionFacts>,
  ambiguousOfferedActionIDs: ReadonlySet<string>,
  rejections: KeystoneProposalRejection[],
  planAlignmentBonusBP: number,
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
    let rawBidBP: number;
    try {
      rawBidBP = computeKeystoneBidBP(proposal, action.actionRiskBP);
      validateProposalText(proposal);
    } catch {
      rejections.push(rejectionFor(spec.tier, proposal, "invalid_proposal"));
      continue;
    }
    if (spec.tier === "expert_auction" && rawBidBP <= 0) {
      rejections.push(rejectionFor(spec.tier, proposal, "non_positive_bid"));
      continue;
    }
    const planBonusBP =
      spec.tier === "expert_auction" && action.planAligned
        ? planAlignmentBonusBP
        : 0;
    scored.push({
      proposal,
      action,
      rawBidBP,
      planBonusBP,
      auctionScoreBP: rawBidBP + planBonusBP,
    });
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
    b.auctionScoreBP - a.auctionScoreBP ||
    b.rawBidBP - a.rawBidBP ||
    compareText(a.action.id, b.action.id) ||
    compareSameActionProposals(a, b)
  );
}

function compareSameActionProposals(
  a: ScoredProposal,
  b: ScoredProposal,
): number {
  return (
    b.auctionScoreBP - a.auctionScoreBP ||
    b.rawBidBP - a.rawBidBP ||
    compareText(a.proposal.source, b.proposal.source) ||
    compareText(a.proposal.proposalID, b.proposal.proposalID)
  );
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
    bidBP: candidate.rawBidBP,
    planAligned: candidate.action.planAligned,
  });
}

function rankExpertAuction(
  ranked: readonly ScoredProposal[],
  context: KeystoneAuctionContext,
): {
  readonly ranked: readonly ScoredProposal[];
  readonly trace: KeystoneAuctionTrace;
} {
  const baselineWinner = ranked[0] ?? null;
  const incumbent =
    context.incumbent === null
      ? null
      : (ranked.find((candidate) =>
          matchesIncumbent(candidate, context.incumbent!),
        ) ?? null);
  let selected = baselineWinner;
  let challenger: ScoredProposal | null = null;
  let challengerAdvantageBP: number | null = null;
  let status: KeystoneAuctionTrace["status"];

  if (context.incumbent === null) {
    status = "inactive";
  } else if (incumbent === null) {
    status = "incumbent_unavailable";
  } else if (baselineWinner === incumbent) {
    challenger =
      ranked.find((candidate) => !sameCommitment(candidate, incumbent)) ?? null;
    challengerAdvantageBP =
      challenger === null
        ? null
        : challenger.auctionScoreBP - incumbent.auctionScoreBP;
    status = "incumbent_leading";
  } else {
    challenger = baselineWinner;
    challengerAdvantageBP =
      challenger === null
        ? null
        : challenger.auctionScoreBP - incumbent.auctionScoreBP;
    if (
      challengerAdvantageBP !== null &&
      challengerAdvantageBP >= context.switchMarginBP
    ) {
      status = "switched";
    } else {
      selected = incumbent;
      status = "retained";
    }
  }

  const ordered =
    selected === null
      ? []
      : [selected, ...ranked.filter((candidate) => candidate !== selected)];
  return Object.freeze({
    ranked: ordered,
    trace: Object.freeze({
      status,
      incumbentKey: context.incumbent?.key ?? null,
      incumbentSource: context.incumbent?.source ?? null,
      baselineWinnerProposalID: baselineWinner?.proposal.proposalID ?? null,
      selectedProposalID: selected?.proposal.proposalID ?? null,
      challengerProposalID: challenger?.proposal.proposalID ?? null,
      challengerAdvantageBP,
      switchMarginBP: context.switchMarginBP,
      planAlignmentBonusBP: context.planAlignmentBonusBP,
      selectedRawBidBP: selected?.rawBidBP ?? null,
      selectedPlanBonusBP: selected?.planBonusBP ?? null,
      selectedAuctionScoreBP: selected?.auctionScoreBP ?? null,
    }),
  });
}

function matchesIncumbent(
  candidate: ScoredProposal,
  incumbent: NonNullable<KeystoneAuctionContext["incumbent"]>,
): boolean {
  return (
    isExpertSource(candidate.proposal.source) &&
    "commitmentKey" in candidate.proposal &&
    candidate.proposal.source === incumbent.source &&
    candidate.proposal.commitmentKey === incumbent.key
  );
}

function sameCommitment(a: ScoredProposal, b: ScoredProposal): boolean {
  return (
    isExpertSource(a.proposal.source) &&
    isExpertSource(b.proposal.source) &&
    "commitmentKey" in a.proposal &&
    "commitmentKey" in b.proposal &&
    a.proposal.source === b.proposal.source &&
    a.proposal.commitmentKey !== undefined &&
    a.proposal.commitmentKey === b.proposal.commitmentKey
  );
}

function isExpertSource(
  source: KeystoneProposalSource,
): source is KeystoneExpertDomain {
  return (
    source === "expansion" ||
    source === "economy" ||
    source === "conquest" ||
    source === "politics"
  );
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
  auction: KeystoneAuctionTrace | null;
  rejections: KeystoneProposalRejection[];
}): KeystoneArbitrationResult {
  return Object.freeze({
    disposition: result.disposition,
    selection: result.selection,
    runnerUp: result.runnerUp,
    bidMarginBP: result.bidMarginBP,
    auction: result.auction,
    rejections: Object.freeze([...result.rejections]),
  });
}

function assertBasisPoints(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${label} must be an integer from 0 to 10000`);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
