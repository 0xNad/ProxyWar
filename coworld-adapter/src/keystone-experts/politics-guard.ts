import { arbitrateKeystoneAction } from "./arbiter";
import type {
  KeystoneActionSelection,
  KeystoneArbitrationResult,
  KeystoneAuctionContext,
  KeystoneDirectiveProposal,
  KeystoneExpertProposal,
  KeystoneWorldModel,
} from "./types";

export type KeystonePoliticsGuardReplacementSource =
  | "survival"
  | "expansion"
  | "economy"
  | "conquest";

export type KeystonePoliticsGuardSelection = KeystoneActionSelection &
  Readonly<{
    readonly tier: "survival" | "expert_auction";
    readonly source: KeystonePoliticsGuardReplacementSource;
  }>;

/**
 * Pure treatment seam over the reviewed Council: it keeps the complete original
 * world/offers, but limits proposals eligible to replace proactive politics.
 * Politics and Commander binding proposals are deliberately absent; survival
 * retains hard precedence over the three productive expert domains. The guard
 * is a one-shot treatment, so shadow-only ledger choices cannot bias it.
 */
export function arbitrateKeystonePoliticsGuard(
  world: KeystoneWorldModel,
  args: {
    readonly survivalProposal: KeystoneDirectiveProposal<"survival"> | null;
    /** Proposals already attributed to expansion/economy/conquest slots. */
    readonly eligibleExpertProposals: readonly KeystoneExpertProposal[];
    readonly auctionContext: KeystoneAuctionContext;
  },
): KeystoneArbitrationResult {
  return arbitrateKeystoneAction(
    world,
    {
      spawn: [],
      survival: args.survivalProposal === null ? [] : [args.survivalProposal],
      bindingDirective: [],
      expertAuction: args.eligibleExpertProposals.filter(
        (proposal) => proposal.source !== "politics",
      ),
    },
    Object.freeze({ ...args.auctionContext, incumbent: null }),
  );
}

export function keystonePoliticsGuardSelection(
  result: KeystoneArbitrationResult | null,
): KeystonePoliticsGuardSelection | null {
  const selection = result?.selection;
  if (selection === undefined || selection === null) {
    return null;
  }
  if (selection.tier === "survival" && selection.source === "survival") {
    return selection as KeystonePoliticsGuardSelection;
  }
  if (
    selection.tier === "expert_auction" &&
    (selection.source === "expansion" ||
      selection.source === "economy" ||
      selection.source === "conquest")
  ) {
    return selection as KeystonePoliticsGuardSelection;
  }
  return null;
}
