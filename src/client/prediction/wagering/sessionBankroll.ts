/**
 * Client-local session bankroll.
 *
 * The premiere market slice has no server wallet (confirmed with the server
 * owner) — trades and payouts are per-checkpoint integer chip amounts only,
 * no persistent account. This ledger reuses `STARTING_BANKROLL` from the
 * substrate-agnostic `src/prediction/types` so the starting number matches
 * the rest of the product's play-money convention. It lives for one
 * premiere viewing session: starts at `STARTING_BANKROLL`, applies each
 * CONFIRMED trade's chip delta (a buy debits its cost, a sell credits its
 * proceeds — both come straight off the server's trade response, never a
 * client estimate), and credits a checkpoint's settlement payout exactly
 * once when that checkpoint's settlement is first observed (a checkpoint's
 * settlement arrives repeatedly on every subsequent heartbeat/poll —
 * crediting it more than once would silently mint money). It is
 * informational and drives client-side `maxStake()` validation only; it is
 * never sent to the server and never overrides a server rejection.
 */
import { STARTING_BANKROLL, type Credits } from "src/prediction/types";

export class SessionBankroll {
  private balanceValue: Credits;
  private readonly settledCheckpointIds = new Set<string>();

  constructor(startingBalance: Credits = STARTING_BANKROLL) {
    this.balanceValue = startingBalance;
  }

  get balance(): Credits {
    return this.balanceValue;
  }

  /**
   * Apply a confirmed trade's chip delta — negative for a buy's cost,
   * positive for a sell's proceeds. Call only with the server's own
   * `chips` figure from the trade response, never a client preview.
   */
  applyTrade(chipsDelta: Credits): Credits {
    this.balanceValue += chipsDelta;
    return this.balanceValue;
  }

  /**
   * Credit a checkpoint's settlement payout, exactly once per checkpoint —
   * repeat calls for a checkpoint already settled are a no-op, since the
   * same settlement is pushed on every subsequent hydrate.
   */
  creditSettlementOnce(checkpointId: string, payout: Credits): Credits {
    if (this.settledCheckpointIds.has(checkpointId)) {
      return this.balanceValue;
    }
    this.settledCheckpointIds.add(checkpointId);
    this.balanceValue += payout;
    return this.balanceValue;
  }

  hasSettled(checkpointId: string): boolean {
    return this.settledCheckpointIds.has(checkpointId);
  }
}
