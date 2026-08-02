/**
 * Bankroll rules and stake validation for the LMSR market. Ported from the
 * prior engine's `rules.ts` — pure helpers, no state of their own.
 */
import type { ReplayPremiereMarketOrderRejectReason } from "./ReplayPremiereWageringTypes";

/** Credits granted the first time a participant trades. */
export const STARTING_BANKROLL = 1_000;
export const MIN_STAKE = 10;

/** Maximum credits allowed on a single buy: 50% of current bankroll. */
export function maxStake(bankroll: number): number {
  return Math.floor(bankroll / 2);
}

export interface ReplayPremiereStakeValidation {
  readonly ok: boolean;
  readonly reason?: ReplayPremiereMarketOrderRejectReason;
}

/**
 * Validates a buy stake (credits) against the bankroll rules. Sells are not
 * stake-limited — they return money and only require holding the shares,
 * checked separately by the caller against actual holdings.
 */
export function validateBuyStake(
  stake: number,
  bankroll: number,
): ReplayPremiereStakeValidation {
  if (!Number.isSafeInteger(stake) || stake <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (stake < MIN_STAKE) {
    return { ok: false, reason: "below_min_stake" };
  }
  if (stake > bankroll) {
    return { ok: false, reason: "insufficient_funds" };
  }
  if (stake > maxStake(bankroll)) {
    return { ok: false, reason: "above_max_stake" };
  }
  return { ok: true };
}
