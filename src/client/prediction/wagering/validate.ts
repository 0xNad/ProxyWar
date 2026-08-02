/**
 * Client-side trade-draft validation. Mirrors the checks the server repeats
 * authoritatively — this pass exists for fast feedback only and is never
 * trusted on its own.
 */
import { MIN_STAKE, maxStake, type Credits } from "src/prediction/types";
import { maxSharesForBudget } from "./marketMath";
import type { MarketState, TradeRejectReason } from "./types";

export type TradeDraftValidation =
  | { readonly ok: true; readonly message?: undefined }
  | { readonly ok: false; readonly reason: TradeRejectReason; readonly message: string };

const REJECT_MESSAGE: Record<TradeRejectReason, string> = {
  "market-closed": "Trading is closed for this checkpoint.",
  "no-seat-selected": "Choose a seat.",
  "invalid-amount": "Enter a valid whole-chip amount.",
  "below-min-stake": `Minimum stake is ${MIN_STAKE} cr.`,
  "above-max-stake": "Maximum stake is 50% of your bankroll.",
  "insufficient-funds": "You don't have enough chips.",
  "no-shares-to-sell": "You hold no shares to sell.",
  "zero-shares": "That amount doesn't buy a whole share at this price.",
};

function rejected(reason: TradeRejectReason): TradeDraftValidation {
  return { ok: false, reason, message: REJECT_MESSAGE[reason] };
}

export interface BuyDraftInput {
  readonly seatId: string | null;
  readonly budgetText: string;
  readonly bankroll: Credits;
  readonly windowOpen: boolean;
  readonly market: MarketState | null;
}

/** Validates a draft BUY before submit. Never trusted on its own. */
export function validateBuyDraft(input: BuyDraftInput): TradeDraftValidation {
  if (!input.windowOpen) return rejected("market-closed");
  if (input.seatId === null || input.seatId === "") {
    return rejected("no-seat-selected");
  }
  const trimmed = input.budgetText.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return rejected("invalid-amount");
  }
  const budget = Number(trimmed);
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    return rejected("invalid-amount");
  }
  if (budget < MIN_STAKE) return rejected("below-min-stake");
  const cap = maxStake(input.bankroll);
  if (budget > cap) return rejected("above-max-stake");
  if (budget > input.bankroll) return rejected("insufficient-funds");
  if (
    input.market !== null &&
    maxSharesForBudget(input.market, input.seatId, budget) < 1
  ) {
    return rejected("zero-shares");
  }
  return { ok: true };
}

export interface SellDraftInput {
  readonly seatId: string | null;
  readonly sharesText: string;
  readonly heldShares: number;
  readonly windowOpen: boolean;
}

/** Validates a draft SELL before submit. Never trusted on its own. */
export function validateSellDraft(input: SellDraftInput): TradeDraftValidation {
  if (!input.windowOpen) return rejected("market-closed");
  if (input.seatId === null || input.seatId === "") return rejected("no-seat-selected");
  if (input.heldShares <= 0) return rejected("no-shares-to-sell");
  const trimmed = input.sharesText.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return rejected("invalid-amount");
  }
  const shares = Number(trimmed);
  if (!Number.isSafeInteger(shares) || shares <= 0) {
    return rejected("invalid-amount");
  }
  if (shares > input.heldShares) return rejected("above-max-stake");
  return { ok: true };
}
