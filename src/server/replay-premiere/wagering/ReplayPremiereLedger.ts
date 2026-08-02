/**
 * Double-entry, integer-credit ledger. Ported from the prior single-player
 * engine's `ledger.ts` — the money-invariant logic was already correct and
 * substrate-agnostic, so it is kept essentially verbatim.
 *
 * Every transaction is a set of postings whose deltas sum to exactly zero,
 * so the sum of every account balance is an invariant: always 0. Accounts:
 * BANK (issuer of grants, goes negative), AMM (the LMSR market maker, may
 * carry the market's bounded worst-case subsidy), and one per participant
 * (real guest_* or synthetic sim_*). This is the single source of truth for
 * money in the market; nothing else mutates balances.
 *
 * Server-authoritative note: this class is constructed fresh from durable
 * snapshot state at the start of every mutation and serialized back out at
 * the end — it is never held across mutations, so it carries no concurrency
 * concerns of its own. Serialization/atomicity come from the caller
 * (`ReplayPremiereInteractions.mutate()`), not from this module.
 */

export const REPLAY_PREMIERE_MARKET_BANK_ACCOUNT = "BANK";
export const REPLAY_PREMIERE_MARKET_AMM_ACCOUNT = "AMM";

export interface ReplayPremiereLedgerPosting {
  readonly account: string;
  /** Integer credit delta (may be negative). */
  readonly delta: number;
}

export interface ReplayPremiereLedgerSnapshot {
  readonly balances: Readonly<Record<string, number>>;
  /** Total credits granted to each account from BANK (skill-vs-grant accounting). */
  readonly granted: Readonly<Record<string, number>>;
}

export class ReplayPremiereLedger {
  private balances = new Map<string, number>();
  private granted = new Map<string, number>();

  balanceOf(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  grantedTo(account: string): number {
    return this.granted.get(account) ?? 0;
  }

  /** Sum of every account balance. MUST always be 0. */
  total(): number {
    let total = 0;
    for (const value of this.balances.values()) total += value;
    return total;
  }

  /**
   * Apply a balanced set of postings atomically. Throws if the deltas don't
   * sum to zero or any delta is not a safe integer — these would corrupt
   * the money invariant and indicate a bug, never a user error.
   */
  post(postings: readonly ReplayPremiereLedgerPosting[]): void {
    let sum = 0;
    for (const posting of postings) {
      if (!Number.isSafeInteger(posting.delta)) {
        throw new Error(
          `ReplayPremiereLedger: non-integer delta ${posting.delta} for ${posting.account}`,
        );
      }
      sum += posting.delta;
    }
    if (sum !== 0) {
      throw new Error(`ReplayPremiereLedger: postings do not balance (sum=${sum})`);
    }
    for (const posting of postings) {
      this.balances.set(posting.account, this.balanceOf(posting.account) + posting.delta);
    }
  }

  /** Grant credits from BANK to an account (the initial bankroll grant). */
  grant(account: string, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`ReplayPremiereLedger: invalid grant ${amount}`);
    }
    this.post([
      { account: REPLAY_PREMIERE_MARKET_BANK_ACCOUNT, delta: -amount },
      { account, delta: amount },
    ]);
    this.granted.set(account, this.grantedTo(account) + amount);
  }

  snapshot(): ReplayPremiereLedgerSnapshot {
    return {
      balances: Object.fromEntries(this.balances),
      granted: Object.fromEntries(this.granted),
    };
  }

  static restore(snapshot: ReplayPremiereLedgerSnapshot): ReplayPremiereLedger {
    const ledger = new ReplayPremiereLedger();
    for (const [account, value] of Object.entries(snapshot.balances)) {
      ledger.balances.set(account, value);
    }
    for (const [account, value] of Object.entries(snapshot.granted)) {
      ledger.granted.set(account, value);
    }
    return ledger;
  }
}
