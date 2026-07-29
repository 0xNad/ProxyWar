import {
  PlatformHandoffStore,
  type PlatformHandoffIssueInput,
} from "../../../src/server/platform/PlatformHandoffStore";

function baseIssueInput(): PlatformHandoffIssueInput {
  return {
    state: "state-nonce-1234567890",
    returnOrigin: "https://bet.proxywar.xyz",
    audience: "betting",
    childSessionId: `guest_${"a".repeat(32)}`,
    accountId: `acct_${"b".repeat(32)}`,
    displayName: "Daveey",
    claim: { lineageSlug: "daveey-proxywar", label: "daveey-proxywar:v24" },
  };
}

function redeemRequestFor(input: PlatformHandoffIssueInput, code: string) {
  return {
    code,
    state: input.state,
    returnOrigin: input.returnOrigin,
    audience: input.audience,
    childSessionId: input.childSessionId,
  };
}

describe("PlatformHandoffStore", () => {
  test("redeems exactly once: correct code/state/origin/audience/session succeeds, returns the bound account", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    const result = store.redeemCode(redeemRequestFor(input, code));
    expect(result).toEqual({
      ok: true,
      accountId: input.accountId,
      displayName: input.displayName,
      claim: input.claim,
    });
  });

  test("is genuinely single-use under a concurrent race: exactly one of many simultaneous redeems succeeds", async () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    const attempts = 25;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        Promise.resolve(store.redeemCode(redeemRequestFor(input, code))),
      ),
    );
    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(attempts - 1);
    for (const failure of failures) {
      if (!failure.ok) expect(failure.reason).toBe("invalid_code");
    }
  });

  test("a second redemption of an already-consumed code is rejected as invalid, never re-succeeds", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    expect(store.redeemCode(redeemRequestFor(input, code)).ok).toBe(true);
    const second = store.redeemCode(redeemRequestFor(input, code));
    expect(second).toEqual({ ok: false, reason: "invalid_code" });
  });

  test("a code bound to origin A cannot be redeemed with a different returnOrigin", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    const result = store.redeemCode({
      ...redeemRequestFor(input, code),
      returnOrigin: "https://evil.example.com",
    });
    expect(result).toEqual({ ok: false, reason: "origin_mismatch" });
    // The mismatch must NOT have consumed the code — the legitimate
    // caller, presenting the correct origin, can still redeem it.
    expect(store.redeemCode(redeemRequestFor(input, code)).ok).toBe(true);
  });

  test("a code cannot be redeemed with a mismatched state", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    const result = store.redeemCode({
      ...redeemRequestFor(input, code),
      state: "a-different-state-value",
    });
    expect(result).toEqual({ ok: false, reason: "state_mismatch" });
  });

  test("a code cannot be redeemed under a different audience", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    const result = store.redeemCode({
      ...redeemRequestFor(input, code),
      audience: "league",
    });
    expect(result).toEqual({ ok: false, reason: "audience_mismatch" });
  });

  test("a code cannot be redeemed under a different child session id", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const { code } = store.issueCode(input);
    const result = store.redeemCode({
      ...redeemRequestFor(input, code),
      childSessionId: `guest_${"f".repeat(32)}`,
    });
    expect(result).toEqual({ ok: false, reason: "session_mismatch" });
  });

  test("a code cannot be redeemed after expiry, and expiry consumes it (no lingering redeemable record)", () => {
    let nowMs = 1_000_000;
    const store = new PlatformHandoffStore(() => nowMs, 2 * 60 * 1_000);
    const input = baseIssueInput();
    const { code, expiresAt } = store.issueCode(input);
    expect(Date.parse(expiresAt)).toBe(nowMs + 2 * 60 * 1_000);
    nowMs += 2 * 60 * 1_000 + 1;
    const result = store.redeemCode(redeemRequestFor(input, code));
    expect(result).toEqual({ ok: false, reason: "expired" });
    // Retrying afterward must not somehow succeed — the first lookup's
    // expiry check deleted the record, so the retry sees a plain
    // unknown code, not a lingering "expired" record to keep rejecting.
    expect(store.redeemCode(redeemRequestFor(input, code))).toEqual({
      ok: false,
      reason: "invalid_code",
    });
  });

  test("redeeming with a well-formed but never-issued code is rejected, never throws", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const result = store.redeemCode(redeemRequestFor(input, "a".repeat(64)));
    expect(result).toEqual({ ok: false, reason: "invalid_code" });
  });

  test("two independently issued codes for the same account are both independently redeemable", () => {
    const store = new PlatformHandoffStore();
    const input = baseIssueInput();
    const first = store.issueCode(input);
    const second = store.issueCode({ ...input, state: "another-state-value-2" });
    expect(first.code).not.toBe(second.code);
    expect(store.redeemCode(redeemRequestFor(input, first.code)).ok).toBe(true);
    expect(
      store.redeemCode({
        ...redeemRequestFor(input, second.code),
        state: "another-state-value-2",
      }).ok,
    ).toBe(true);
  });

  test("an account with no claim redeems with claim: null, never a coincidental default", () => {
    const store = new PlatformHandoffStore();
    const input = { ...baseIssueInput(), claim: null };
    const { code } = store.issueCode(input);
    const result = store.redeemCode(redeemRequestFor(input, code));
    expect(result).toEqual({
      ok: true,
      accountId: input.accountId,
      displayName: input.displayName,
      claim: null,
    });
  });
});
