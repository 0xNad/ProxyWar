import { describe, expect, it } from "vitest";

import {
  AGENT_DEGRADATION_CAUSES,
  asAgentDegradationCause,
  asPlayerReportedDegradationCause,
  isSelfReportedDegradationCause,
  type AgentDegradationCause,
} from "../../src/server/agents/AgentWireProtocol";

/**
 * The cause vocabulary is an EVIDENCE field: it exists so the league's largest
 * live number — about a third of all decisions degraded — can be attributed at
 * all. Two properties matter more than the parsing itself:
 *
 *  1. It must reject anything it does not recognize, because a policy sending an
 *     almost-right value has told us nothing, and a catch-all bucket would put
 *     invented data in the one field whose purpose is attribution.
 *  2. A PLAYER must not be able to claim a SERVER observation. `brain-timeout`
 *     means "we never heard from this seat"; a seat that answered fine and
 *     stamped itself `brain-timeout` would forge provenance.
 */
describe("agent degradation cause vocabulary", () => {
  it("accepts every member of its own vocabulary, and nothing else", () => {
    for (const cause of AGENT_DEGRADATION_CAUSES) {
      expect(asAgentDegradationCause(cause)).toBe(cause);
    }
    expect(AGENT_DEGRADATION_CAUSES.length).toBeGreaterThan(0);
  });

  it("is a strict equality parse — no trimming, casing or prefix leniency", () => {
    const nearMisses = [
      " plan-warmup",
      "plan-warmup ",
      "PLAN-WARMUP",
      "Plan-Warmup",
      "plan_warmup",
      "plan-warmup\n",
      "plan-warmup\u0000",
      "plan-warmupX",
      "plan-",
      "plan",
      "warmup",
      "",
    ];
    for (const value of nearMisses) {
      expect(
        asAgentDegradationCause(value),
        `near miss ${JSON.stringify(value)} must not parse`,
      ).toBeUndefined();
    }
  });

  it("rejects non-strings and hostile payloads rather than coercing them", () => {
    for (const value of [
      undefined,
      null,
      42,
      true,
      {},
      [],
      ["plan-warmup"],
      { cause: "plan-warmup" },
      () => "plan-warmup",
      "x".repeat(5_000),
      '{"$ne": null}',
      "plan-warmup'; DROP TABLE decisions;--",
    ]) {
      expect(asAgentDegradationCause(value)).toBeUndefined();
    }
  });

  it("keeps the self-reported and server-observed families disjoint and total", () => {
    const selfReported = AGENT_DEGRADATION_CAUSES.filter((cause) =>
      isSelfReportedDegradationCause(cause),
    );
    const serverObserved = AGENT_DEGRADATION_CAUSES.filter(
      (cause) => !isSelfReportedDegradationCause(cause),
    );
    // Every cause belongs to exactly one family — a cause in neither would have
    // no defined trust rule, which is how a forgery slips through.
    expect(selfReported.length + serverObserved.length).toBe(
      AGENT_DEGRADATION_CAUSES.length,
    );
    expect(selfReported.length).toBeGreaterThan(0);
    expect(serverObserved).toEqual(["brain-timeout", "brain-error"]);
  });

  it("refuses a player-sent SERVER observation while accepting its own report", () => {
    // The forgery guard. `brain-*` says the server failed to hear from the seat;
    // only the server may say that.
    for (const forged of ["brain-timeout", "brain-error"] as const) {
      expect(asAgentDegradationCause(forged)).toBe(forged);
      expect(
        asPlayerReportedDegradationCause(forged),
        `${forged} must never be accepted from a player frame`,
      ).toBeUndefined();
    }
    for (const own of AGENT_DEGRADATION_CAUSES.filter((cause) =>
      isSelfReportedDegradationCause(cause),
    )) {
      expect(asPlayerReportedDegradationCause(own)).toBe(own);
    }
  });

  it("classifies by explicit membership, not by how a cause is spelled", () => {
    // A prefix rule would call any future non-`plan` self-report a server
    // observation. `policy-error` is exactly that case, and it must be trusted as
    // self-reported.
    const policyError: AgentDegradationCause = "policy-error";
    expect(policyError.startsWith("plan-")).toBe(false);
    expect(isSelfReportedDegradationCause(policyError)).toBe(true);
    expect(asPlayerReportedDegradationCause(policyError)).toBe(policyError);
  });
});
