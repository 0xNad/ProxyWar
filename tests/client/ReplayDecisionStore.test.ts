import { describe, expect, it } from "vitest";

import { publicStatedReasonText } from "../../src/client/ReplayDecisionStore";

describe("publicStatedReasonText", () => {
  it.each([
    "dgd:err:atk",
    "rul:atk",
    "e1:hold",
    "heuristic-expand",
    "heuristic expand",
    "fallback:hold",
    "autopilot_expand",
  ])("suppresses policy/debug token %s", (reason) => {
    expect(publicStatedReasonText(reason)).toBeNull();
  });

  it("preserves actual agent-authored prose", () => {
    expect(
      publicStatedReasonText(
        "I will fortify the north before committing to this alliance.",
      ),
    ).toBe("I will fortify the north before committing to this alliance.");
  });
});
