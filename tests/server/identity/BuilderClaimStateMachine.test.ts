import { describe, expect, it } from "vitest";
import {
  applyClaimTransition,
  buildAuditEntry,
  InvalidClaimTransitionError,
  isClaimTerminal,
  isClaimTransitionAllowed,
} from "../../../src/server/identity/BuilderClaimStateMachine";

describe("BuilderClaimStateMachine", () => {
  it("walks the operator-mediated happy path: draft -> proof_pending -> verified", () => {
    expect(applyClaimTransition("draft", "mark_proof_pending")).toBe("proof_pending");
    expect(applyClaimTransition("proof_pending", "approve")).toBe("verified");
  });

  it("walks the scaffolded nonce path: draft -> challenge_issued -> proof_pending -> verified", () => {
    expect(applyClaimTransition("draft", "issue_challenge")).toBe("challenge_issued");
    expect(applyClaimTransition("challenge_issued", "mark_proof_pending")).toBe(
      "proof_pending",
    );
    expect(applyClaimTransition("proof_pending", "auto_verify_from_observation")).toBe(
      "verified",
    );
  });

  it("allows reject/withdraw from every non-terminal state", () => {
    for (const state of ["draft", "challenge_issued", "proof_pending"] as const) {
      expect(applyClaimTransition(state, "reject")).toBe("rejected");
      expect(applyClaimTransition(state, "withdraw")).toBe("rejected");
    }
  });

  it("allows revoke only from verified", () => {
    expect(applyClaimTransition("verified", "revoke")).toBe("revoked");
  });

  it("rejects an illegal transition instead of silently no-op'ing", () => {
    expect(() => applyClaimTransition("draft", "approve")).toThrow(
      InvalidClaimTransitionError,
    );
    expect(() => applyClaimTransition("verified", "approve")).toThrow(
      InvalidClaimTransitionError,
    );
  });

  it("never allows a transition out of a terminal state", () => {
    for (const action of [
      "issue_challenge",
      "mark_proof_pending",
      "approve",
      "reject",
      "revoke",
      "withdraw",
      "auto_verify_from_observation",
    ] as const) {
      expect(isClaimTransitionAllowed("rejected", action)).toBe(false);
      expect(isClaimTransitionAllowed("revoked", action)).toBe(false);
    }
  });

  it("isClaimTerminal matches exactly {rejected, revoked}", () => {
    expect(isClaimTerminal("draft")).toBe(false);
    expect(isClaimTerminal("challenge_issued")).toBe(false);
    expect(isClaimTerminal("proof_pending")).toBe(false);
    expect(isClaimTerminal("verified")).toBe(false);
    expect(isClaimTerminal("rejected")).toBe(true);
    expect(isClaimTerminal("revoked")).toBe(true);
  });

  it("buildAuditEntry stamps a deterministic ISO timestamp and preserves actor/note", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const entry = buildAuditEntry(
      "draft",
      "proof_pending",
      "mark_proof_pending",
      { kind: "claimant", id: "acct_deadbeef" },
      "submitted evidence",
      now,
    );
    expect(entry).toEqual({
      at: "2026-08-01T00:00:00.000Z",
      actor: { kind: "claimant", id: "acct_deadbeef" },
      action: "mark_proof_pending",
      fromState: "draft",
      toState: "proof_pending",
      note: "submitted evidence",
    });
  });
});
