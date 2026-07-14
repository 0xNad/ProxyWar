import type {
  KeystoneArbitrationResult,
  KeystoneAuctionContext,
  KeystoneExpertProposal,
  KeystoneOperationalCommitment,
  KeystoneWorldModel,
} from "./types";

const MAX_HORIZON_DECISIONS = 3;
const MAX_COMMITMENT_KEY_LENGTH = 96;
const SAFE_COMMITMENT_KEY = /^[A-Za-z0-9_.:/-]+$/;

export type KeystoneOperationalLedgerReason =
  | "none"
  | "reset"
  | "inactive_phase"
  | "commander_binding"
  | "incoming_pressure"
  | "expired"
  | "incumbent_unavailable"
  | "armed"
  | "retained"
  | "selected_without_commitment"
  | "higher_tier_selected"
  | "hold_or_abstain";

export interface KeystoneOperationalLedgerSnapshot {
  readonly commitment: KeystoneOperationalCommitment | null;
  readonly remainingDecisions: number;
}

export interface KeystoneOperationalLedgerTransition {
  readonly reason: KeystoneOperationalLedgerReason;
  readonly before: KeystoneOperationalLedgerSnapshot;
  readonly after: KeystoneOperationalLedgerSnapshot;
}

export interface KeystoneOperationalLedgerPreparation {
  readonly auctionContext: KeystoneAuctionContext;
  readonly transition: KeystoneOperationalLedgerTransition;
}

/**
 * The sole Council cross-decision state owner. It persists an objective key for
 * at most three decisions and never stores a LegalAction.id.
 */
export class KeystoneOperationalCommitmentLedger {
  private commitment: KeystoneOperationalCommitment | null = null;

  prepare(args: {
    world: KeystoneWorldModel;
    ordinal: number;
    reset: boolean;
    proposals: readonly KeystoneExpertProposal[];
    planAlignmentBonusBP: number;
    switchMarginBP: number;
  }): KeystoneOperationalLedgerPreparation {
    const before = this.snapshot(args.ordinal);
    const clearReason = this.clearReason(args);
    if (clearReason !== null) {
      this.commitment = null;
    }
    const after = this.snapshot(args.ordinal);
    return Object.freeze({
      auctionContext: Object.freeze({
        incumbent: this.commitment,
        planAlignmentBonusBP: args.planAlignmentBonusBP,
        switchMarginBP: args.switchMarginBP,
      }),
      transition: freezeTransition(clearReason ?? "none", before, after),
    });
  }

  record(args: {
    world: KeystoneWorldModel;
    ordinal: number;
    result: KeystoneArbitrationResult;
    proposals: readonly KeystoneExpertProposal[];
  }): KeystoneOperationalLedgerTransition {
    const before = this.snapshot(args.ordinal);
    const selection = args.result.selection;
    let reason: KeystoneOperationalLedgerReason;

    if (selection === null) {
      this.commitment = null;
      reason = "hold_or_abstain";
    } else if (selection.tier !== "expert_auction") {
      this.commitment = null;
      reason =
        selection.tier === "hold" ? "hold_or_abstain" : "higher_tier_selected";
    } else if (args.world.commander.binding !== null) {
      this.commitment = null;
      reason = "commander_binding";
    } else if (args.world.incomingAggressorIDs.length > 0) {
      this.commitment = null;
      reason = "incoming_pressure";
    } else if (args.world.phase !== "active" || args.world.own === null) {
      this.commitment = null;
      reason = "inactive_phase";
    } else {
      const selectedProposal = uniqueSelectedProposal(
        args.proposals,
        selection,
      );
      const descriptor =
        selectedProposal === null
          ? null
          : operationalDescriptor(selectedProposal);
      if (descriptor === null) {
        this.commitment = null;
        reason = "selected_without_commitment";
      } else if (
        this.commitment !== null &&
        this.commitment.key === descriptor.key &&
        this.commitment.source === descriptor.source &&
        args.ordinal <= this.commitment.expiresAfterOrdinal
      ) {
        // A same-key selection confirms current evidence but cannot extend TTL.
        reason = "retained";
      } else {
        this.commitment = Object.freeze({
          key: descriptor.key,
          source: descriptor.source,
          startedOrdinal: args.ordinal,
          expiresAfterOrdinal: args.ordinal + descriptor.horizonDecisions - 1,
        });
        reason = "armed";
      }
    }

    return freezeTransition(reason, before, this.snapshot(args.ordinal));
  }

  snapshot(ordinal: number): KeystoneOperationalLedgerSnapshot {
    return Object.freeze({
      commitment: this.commitment,
      remainingDecisions:
        this.commitment === null
          ? 0
          : Math.min(
              MAX_HORIZON_DECISIONS,
              Math.max(0, this.commitment.expiresAfterOrdinal - ordinal + 1),
            ),
    });
  }

  private clearReason(args: {
    world: KeystoneWorldModel;
    ordinal: number;
    reset: boolean;
    proposals: readonly KeystoneExpertProposal[];
  }): Exclude<KeystoneOperationalLedgerReason, "none"> | null {
    if (args.reset) {
      return "reset";
    }
    if (args.world.phase !== "active" || args.world.own === null) {
      return "inactive_phase";
    }
    if (args.world.commander.binding !== null) {
      return "commander_binding";
    }
    if (args.world.incomingAggressorIDs.length > 0) {
      return "incoming_pressure";
    }
    if (
      this.commitment !== null &&
      args.ordinal > this.commitment.expiresAfterOrdinal
    ) {
      return "expired";
    }
    if (this.commitment !== null) {
      const incumbent = this.commitment;
      if (
        !args.proposals.some(
          (proposal) =>
            proposal.source === incumbent.source &&
            proposal.commitmentKey === incumbent.key,
        )
      ) {
        return "incumbent_unavailable";
      }
    }
    return null;
  }
}

function operationalDescriptor(proposal: KeystoneExpertProposal): {
  readonly key: string;
  readonly source: KeystoneExpertProposal["source"];
  readonly horizonDecisions: number;
} | null {
  const key = proposal.commitmentKey;
  const horizon = proposal.horizonDecisions;
  if (
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > MAX_COMMITMENT_KEY_LENGTH ||
    !SAFE_COMMITMENT_KEY.test(key) ||
    !key.startsWith(`${proposal.source}:`) ||
    typeof horizon !== "number" ||
    !Number.isInteger(horizon) ||
    horizon < 1 ||
    horizon > MAX_HORIZON_DECISIONS
  ) {
    return null;
  }
  return Object.freeze({
    key,
    source: proposal.source,
    horizonDecisions: horizon,
  });
}

function uniqueSelectedProposal(
  proposals: readonly KeystoneExpertProposal[],
  selection: NonNullable<KeystoneArbitrationResult["selection"]>,
): KeystoneExpertProposal | null {
  const matches = proposals.filter(
    (proposal) =>
      proposal.proposalID === selection.proposalID &&
      proposal.actionID === selection.actionID &&
      proposal.source === selection.source,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function freezeTransition(
  reason: KeystoneOperationalLedgerReason,
  before: KeystoneOperationalLedgerSnapshot,
  after: KeystoneOperationalLedgerSnapshot,
): KeystoneOperationalLedgerTransition {
  return Object.freeze({ reason, before, after });
}
