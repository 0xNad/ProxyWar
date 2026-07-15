import type {
  AgentGamePhase,
  LegalActionKind,
} from "../../../src/server/agents/AgentTypes";

export const keystoneExpertDomains = [
  "expansion",
  "economy",
  "conquest",
  "politics",
] as const;

export type KeystoneExpertDomain = (typeof keystoneExpertDomains)[number];

export type KeystoneActionOwner =
  | KeystoneExpertDomain
  | "survival"
  | "arbiter"
  | null;

export const keystoneStructureUnitTypes = [
  "city",
  "port",
  "factory",
  "defense_post",
  "sam_launcher",
  "missile_silo",
] as const;

export type KeystoneStructureUnitType =
  (typeof keystoneStructureUnitTypes)[number];

export const keystoneBuildRoles = [
  "economic",
  "defensive",
  "infrastructure",
] as const;

export type KeystoneBuildRole = (typeof keystoneBuildRoles)[number];

/** All proposal scoring inputs are integer basis points in [0, 10_000]. */
export interface KeystoneBidComponents {
  readonly expectedValueBP: number;
  readonly urgencyBP: number;
  readonly confidenceBP: number;
  readonly riskBP: number;
  readonly opportunityCostBP: number;
}

export interface KeystoneProposalBase extends KeystoneBidComponents {
  readonly proposalID: string;
  readonly actionID: string;
  readonly rationale: string;
}

export interface KeystoneExpertProposal extends KeystoneProposalBase {
  readonly source: KeystoneExpertDomain;
  /** Lets a future executor persist a coherent objective without persisting an action id. */
  readonly commitmentKey?: string;
  /** Proposals cannot create unbounded commitments. */
  readonly horizonDecisions?: number;
}

export type KeystoneCommanderBinding =
  | Readonly<{
      readonly kind: "attack_target";
      readonly domain: "conquest";
      readonly targetPlayerID: string;
      readonly minCommitmentBP: number;
    }>
  | Readonly<{
      readonly kind: "alliance";
      readonly domain: "politics";
      readonly stance: "seek_alliance" | "hold_alliance";
      readonly targetPlayerID: string | null;
    }>
  | Readonly<{
      readonly kind: "build";
      readonly domain: "economy";
      readonly unit: KeystoneStructureUnitType | "any";
    }>;

/** Immutable strategic context shared by every deterministic expert. */
export interface KeystoneCommanderContext {
  readonly planID: string;
  readonly binding: KeystoneCommanderBinding | null;
}

export interface KeystoneOperationalCommitment {
  /** Stable objective identity. Never a LegalAction.id. */
  readonly key: string;
  readonly source: KeystoneExpertDomain;
  readonly startedOrdinal: number;
  /** Inclusive: the horizon includes the decision that established the objective. */
  readonly expiresAfterOrdinal: number;
}

export interface KeystoneAuctionContext {
  readonly incumbent: KeystoneOperationalCommitment | null;
  readonly planAlignmentBonusBP: number;
  readonly switchMarginBP: number;
}

export type KeystoneHysteresisStatus =
  | "inactive"
  | "incumbent_unavailable"
  | "incumbent_leading"
  | "retained"
  | "switched";

/** Honest auction trace: raw utility, plan bonus, and persistence stay separate. */
export interface KeystoneAuctionTrace {
  readonly status: KeystoneHysteresisStatus;
  readonly incumbentKey: string | null;
  readonly incumbentSource: KeystoneExpertDomain | null;
  readonly baselineWinnerProposalID: string | null;
  readonly selectedProposalID: string | null;
  readonly challengerProposalID: string | null;
  readonly challengerAdvantageBP: number | null;
  readonly switchMarginBP: number;
  readonly planAlignmentBonusBP: number;
  readonly selectedRawBidBP: number | null;
  readonly selectedPlanBonusBP: number | null;
  readonly selectedAuctionScoreBP: number | null;
}

export type KeystoneDirectiveSource =
  | "spawn"
  | "survival"
  | "binding_directive";

export interface KeystoneDirectiveProposal<
  Source extends KeystoneDirectiveSource = KeystoneDirectiveSource,
> extends KeystoneProposalBase {
  readonly source: Source;
}

export interface KeystoneCouncilTiers {
  readonly spawn: readonly KeystoneDirectiveProposal<"spawn">[];
  readonly survival: readonly KeystoneDirectiveProposal<"survival">[];
  readonly bindingDirective: readonly KeystoneDirectiveProposal<"binding_directive">[];
  readonly expertAuction: readonly KeystoneExpertProposal[];
}

export interface KeystonePlayerFacts {
  readonly playerID: string;
  readonly isAlive: boolean;
  readonly isAllied: boolean;
  readonly isFriendly: boolean;
  readonly isTeammate: boolean;
  readonly sameTeam: boolean;
  readonly friendlyOrTeam: boolean;
  readonly sharesBorder: boolean;
  readonly incomingAttack: boolean;
  readonly hasOutgoingAllianceRequest?: boolean;
  readonly hasIncomingAllianceRequest?: boolean;
  readonly hasEmbargoAgainst?: boolean;
  readonly canExtendAlliance?: boolean;
  readonly allianceInExtensionWindow?: boolean;
  readonly troops: number;
  readonly troopRatioBP: number | null;
  readonly tileShareBP: number | null;
  readonly relativeTroopRatioBP: number | null;
}

export interface KeystoneOwnFacts {
  readonly playerID: string;
  readonly team: string | null;
  readonly troops: number;
  readonly maxTroops: number | null;
  readonly troopRatioBP: number | null;
  readonly tileShareBP: number | null;
  readonly tilesOwned: number;
}

/**
 * Conservative, current-snapshot FFA imbalance evidence. `runnerUpPlayerID`
 * may be our own id; `strongestOtherNonLeaderPlayerID` never is. The router
 * owns cross-decision stability, so these facts remain pure observation truth.
 */
export interface KeystoneBalanceOfPowerFacts {
  readonly leaderPlayerID: string;
  readonly leaderTileShareBP: number;
  readonly runnerUpPlayerID: string;
  readonly runnerUpTileShareBP: number;
  readonly strongestOtherNonLeaderPlayerID: string | null;
  readonly strongestOtherNonLeaderTileShareBP: number | null;
  readonly ownTileShareBP: number;
  readonly leaderOwnGapBP: number;
  readonly leaderFieldGapBP: number;
  readonly alivePowerCount: number;
}

export interface KeystoneActionFacts {
  readonly id: string;
  readonly kind: LegalActionKind;
  /** Canonical structure metadata for offered build/upgrade actions only. */
  readonly unitType?: KeystoneStructureUnitType | null;
  /** Canonical role metadata for offered build actions only. */
  readonly buildRole?: KeystoneBuildRole | null;
  /** Canonical defensive-placement metadata for offered build actions only. */
  readonly nearbyIncomingAttack?: boolean | null;
  /** Canonical unit-interval defensiveValue normalized to [0, 10_000]. */
  readonly defensiveValueBP?: number | null;
  /** Canonical non-negative integer distance for offered build actions only. */
  readonly hostileBorderDistance?: number | null;
  readonly targetPlayerID: string | null;
  readonly isSpawn: boolean;
  readonly isHold: boolean;
  readonly isNeutralExpansion: boolean;
  readonly isHostileTargetAction: boolean;
  readonly targetsSelf: boolean;
  readonly targetsFriendlyOrTeam: boolean;
  readonly safetyBlocked: boolean;
  readonly forbidden: boolean;
  readonly planAligned: boolean;
  readonly actionRiskBP: number;
  /** Canonical troopPercent/troopPercentage metadata normalized to [0, 10_000]. */
  readonly troopCommitmentBP?: number | null;
  /** Exactly one expert domain, a protected system tier, or null when unsafe to classify. */
  readonly actionOwner: KeystoneActionOwner;
}

export interface KeystoneActionClassification {
  readonly actions: readonly KeystoneActionFacts[];
  /** Every colliding offered id is dropped; ids are unique and code-point sorted. */
  readonly ambiguousOfferedActionIDs: readonly string[];
}

export interface KeystoneWorldModel {
  readonly gameID: string;
  readonly phase: AgentGamePhase;
  readonly turnNumber: number;
  readonly commander: KeystoneCommanderContext;
  readonly own: KeystoneOwnFacts | null;
  readonly players: readonly KeystonePlayerFacts[];
  readonly incomingAggressorIDs: readonly string[];
  readonly canExpandIntoNeutral: boolean;
  /** Null unless the named default-off treatment has exact current evidence. */
  readonly balanceOfPower?: KeystoneBalanceOfPowerFacts | null;
  /** Existing deterministic backstab affordance, copied without its free text. */
  readonly recommendedBackstabTargetID: string | null;
  readonly actions: readonly KeystoneActionFacts[];
  readonly ambiguousOfferedActionIDs: readonly string[];
}

export type KeystoneArbitrationTier =
  | "spawn"
  | "survival"
  | "binding_directive"
  | "expert_auction"
  | "hold";

export type KeystoneProposalSource =
  | KeystoneExpertDomain
  | KeystoneDirectiveSource
  | "fallback";

export interface KeystoneActionSelection {
  readonly actionID: string;
  readonly actionKind: LegalActionKind;
  readonly tier: KeystoneArbitrationTier;
  readonly source: KeystoneProposalSource;
  readonly proposalID: string | null;
  readonly bidBP: number | null;
  readonly planAligned: boolean;
}

export type KeystoneProposalRejectionReason =
  | "ambiguous_offered_action"
  | "non_offered_action"
  | "forbidden_action"
  | "friendly_or_team_target"
  | "spawn_phase_mismatch"
  | "not_spawn_action"
  | "source_tier_mismatch"
  | "action_ownership_mismatch"
  | "invalid_proposal"
  | "non_positive_bid"
  | "duplicate_action_proposal";

export interface KeystoneProposalRejection {
  readonly tier: Exclude<KeystoneArbitrationTier, "hold">;
  readonly proposalID: string;
  readonly actionID: string;
  readonly reason: KeystoneProposalRejectionReason;
}

export interface KeystoneArbitrationResult {
  readonly disposition: "proposal" | "hold" | "abstain";
  /** Exactly one offered id or null; the council never returns an action batch. */
  readonly selection: KeystoneActionSelection | null;
  /** The next eligible, distinct action in the selected tier, when one exists. */
  readonly runnerUp: KeystoneActionSelection | null;
  /** Selected effective auction score minus runner-up; negative only when hysteresis retains. */
  readonly bidMarginBP: number | null;
  /** Populated only after the discretionary expert auction is evaluated. */
  readonly auction: KeystoneAuctionTrace | null;
  readonly rejections: readonly KeystoneProposalRejection[];
}
