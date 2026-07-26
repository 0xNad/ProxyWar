import { describe, expect, it } from "vitest";
import { SessionBankroll } from "../../../../src/client/prediction/wagering/sessionBankroll";
import { STARTING_BANKROLL } from "src/prediction/types";

describe("SessionBankroll", () => {
  it("starts at STARTING_BANKROLL by default", () => {
    expect(new SessionBankroll().balance).toBe(STARTING_BANKROLL);
  });

  it("debits a confirmed buy's chip cost", () => {
    const ledger = new SessionBankroll(1000);
    expect(ledger.applyTrade(-50)).toBe(950);
    expect(ledger.balance).toBe(950);
  });

  it("credits a confirmed sell's chip proceeds", () => {
    const ledger = new SessionBankroll(1000);
    ledger.applyTrade(-50);
    expect(ledger.applyTrade(30)).toBe(980);
    expect(ledger.balance).toBe(980);
  });

  it("credits a checkpoint settlement payout", () => {
    const ledger = new SessionBankroll(1000);
    ledger.applyTrade(-50);
    ledger.creditSettlementOnce("cp_1", 133);
    expect(ledger.balance).toBe(1083);
    expect(ledger.hasSettled("cp_1")).toBe(true);
  });

  it("never double-credits the same checkpoint's settlement", () => {
    const ledger = new SessionBankroll(1000);
    ledger.applyTrade(-50);
    ledger.creditSettlementOnce("cp_1", 133);
    ledger.creditSettlementOnce("cp_1", 133);
    ledger.creditSettlementOnce("cp_1", 133);
    // Balancing: 1000 - 50 + 133 exactly once == 1083, not 1000 - 50 + 399.
    expect(ledger.balance).toBe(1083);
  });

  it("credits independently settled checkpoints separately", () => {
    const ledger = new SessionBankroll(1000);
    ledger.applyTrade(-50);
    ledger.applyTrade(-30);
    ledger.creditSettlementOnce("cp_1", 0); // lost
    ledger.creditSettlementOnce("cp_2", 30); // void, refunded
    expect(ledger.balance).toBe(1000 - 50 - 30 + 0 + 30);
  });
});
