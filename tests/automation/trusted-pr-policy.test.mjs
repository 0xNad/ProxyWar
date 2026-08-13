import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseRecordSafe,
  canRefreshTrustedBranch,
  changedPathsFromPullFiles,
  evaluatePullRequest,
  isTrustBoundaryPath,
  isTrustedAuthor,
  normalizeLogin,
  policy,
} from "../../.github/scripts/trusted-pr-policy.mjs";

const SHA = "a".repeat(40);

function passingInput(overrides = {}) {
  return {
    authorLogin: "johomax",
    baseBranch: "main",
    draft: false,
    state: "OPEN",
    headSha: SHA,
    expectedHeadSha: SHA,
    mergeable: "MERGEABLE",
    behindBy: 0,
    unresolvedReviewThreads: 0,
    reviewDecision: "APPROVED",
    labels: [],
    files: ["src/client/Main.ts"],
    checkRuns: policy.requiredChecks.map((name, index) => ({
      name,
      status: "completed",
      conclusion: "success",
      app: { id: 15368, slug: "github-actions" },
      completed_at: `2026-08-11T22:${String(index).padStart(2, "0")}:00Z`,
    })),
    ...overrides,
  };
}

test("allowlist contains exactly the two normalized trusted contributors", () => {
  assert.deepEqual(policy.trustedAuthors, ["johomax", "relh"]);
  assert.equal(isTrustedAuthor("johomax"), true);
  assert.equal(isTrustedAuthor("JOHOMAX"), true);
  assert.equal(isTrustedAuthor("RelH"), true);
});

test("lookalikes and whitespace tricks are rejected", () => {
  for (const login of [
    "johomax-",
    "joh0max",
    "softmaxwell",
    "relh-",
    " relh",
    "relh ",
    "rel h",
    "",
  ])
    assert.equal(isTrustedAuthor(login), false, login);
  assert.equal(normalizeLogin(" RELH "), null);
});

test("a normal trusted PR with an exact tested head is eligible", () => {
  assert.deepEqual(evaluatePullRequest(passingInput()).reasons, []);
});

test("drafts, wrong bases, stale heads, conflicts, unresolved threads, requested changes, and holds are rejected", () => {
  const cases = [
    [{ draft: true }, "draft"],
    [{ baseBranch: "develop" }, "wrong-base-branch"],
    [{ expectedHeadSha: "b".repeat(40) }, "stale-head-sha"],
    [{ mergeable: "CONFLICTING" }, "merge-conflict"],
    [{ behindBy: 1 }, "branch-not-current"],
    [{ unresolvedReviewThreads: 1 }, "unresolved-review-conversations"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes-requested"],
    [{ labels: ["DO-NOT-MERGE"] }, "blocking-label"],
    [{ labels: ["security-hold"] }, "blocking-label"],
  ];
  for (const [override, reason] of cases)
    assert.ok(
      evaluatePullRequest(passingInput(override)).reasons.includes(reason),
      reason,
    );
});

test("only a stale otherwise-safe trusted branch may be refreshed before new CI", () => {
  const stale = evaluatePullRequest(
    passingInput({ behindBy: 2, checkRuns: [] }),
  );
  assert.equal(canRefreshTrustedBranch(stale), true);

  for (const override of [
    { authorLogin: "attacker" },
    { baseBranch: "develop" },
    { draft: true },
    { expectedHeadSha: "b".repeat(40) },
    { mergeable: "CONFLICTING" },
    { unresolvedReviewThreads: 1 },
    { reviewDecision: "CHANGES_REQUESTED" },
    { labels: ["security-hold"] },
    { files: [".github/workflows/ci.yml"] },
  ]) {
    const result = evaluatePullRequest(
      passingInput({ behindBy: 1, checkRuns: [], ...override }),
    );
    assert.equal(
      canRefreshTrustedBranch(result),
      false,
      result.reasons.join(","),
    );
  }

  assert.equal(
    canRefreshTrustedBranch(evaluatePullRequest(passingInput())),
    false,
  );
  assert.equal(
    canRefreshTrustedBranch(
      evaluatePullRequest(passingInput({ checkRuns: [] })),
    ),
    false,
  );
});

test("manually applying the audit label never bypasses author verification", () => {
  const result = evaluatePullRequest(
    passingInput({ authorLogin: "attacker", labels: [policy.auditLabel] }),
  );
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("untrusted-author"));
});

test("trust-boundary changes require explicit owner approval", () => {
  for (const path of [
    ".github/automation/trusted-release-policy.json",
    ".github/workflows/coworld-production.yml",
    ".github/workflows/ci.yml",
    ".github/scripts/trusted-pr-admission.mjs",
    ".github/scripts/await-main-ci.mjs",
    "scripts/coworld-production-release.mjs",
    "tests/automation/trusted-pr-policy.test.mjs",
  ]) {
    assert.equal(isTrustBoundaryPath(path), true, path);
    assert.ok(
      evaluatePullRequest(passingInput({ files: [path] })).reasons.includes(
        "trust-boundary-change-needs-owner-approval",
      ),
      path,
    );
  }
  assert.equal(
    isTrustBoundaryPath(
      "coworld-adapter/coworld/coworld_manifest_template.json",
    ),
    false,
  );
  assert.equal(isTrustBoundaryPath("src/client/replay/Replay.ts"), false);
});

test("renaming a protected path cannot evade the trust-boundary gate", () => {
  const paths = changedPathsFromPullFiles([
    {
      filename: "docs/renamed-workflow.yml",
      previous_filename: ".github/workflows/coworld-production.yml",
      status: "renamed",
    },
  ]);
  assert.deepEqual(paths, [
    "docs/renamed-workflow.yml",
    ".github/workflows/coworld-production.yml",
  ]);
  assert.ok(
    evaluatePullRequest(passingInput({ files: paths })).reasons.includes(
      "trust-boundary-change-needs-owner-approval",
    ),
  );
});

test("an explicit 0xNad approval is the only trust-boundary exception", () => {
  const path = ".github/workflows/coworld-production.yml";
  assert.equal(
    evaluatePullRequest(
      passingInput({ files: [path], ownerApprovedTrustBoundary: true }),
    ).eligible,
    true,
  );
});

test("fork metadata is safe because policy needs only immutable API fields", () => {
  const result = evaluatePullRequest(
    passingInput({ isFork: true, headRepository: "johomax/ProxyWar" }),
  );
  assert.equal(result.eligible, true);
});

test("missing and unsuccessful checks fail closed", () => {
  const missing = evaluatePullRequest(passingInput({ checkRuns: [] }));
  assert.ok(missing.reasons.includes("required-check-missing"));
  const failedRuns = passingInput().checkRuns.map((check) => ({ ...check }));
  failedRuns[0].conclusion = "failure";
  const failed = evaluatePullRequest(passingInput({ checkRuns: failedRuns }));
  assert.ok(failed.reasons.includes("required-check-not-successful"));
  const spoofedRuns = passingInput().checkRuns.map((check) => ({ ...check }));
  spoofedRuns[0].app = { id: 999, slug: "lookalike-check-app" };
  const spoofed = evaluatePullRequest(passingInput({ checkRuns: spoofedRuns }));
  assert.ok(spoofed.reasons.includes("required-check-not-successful"));
});

test("only the inherited upstream-only Prettier check may be skipped", () => {
  const skippedPrettier = passingInput().checkRuns.map((check) =>
    check.name === "🎨 Prettier" ? { ...check, conclusion: "skipped" } : check,
  );
  assert.equal(
    evaluatePullRequest(passingInput({ checkRuns: skippedPrettier })).eligible,
    true,
  );
  const skippedBuild = passingInput().checkRuns.map((check) =>
    check.name === "🏗️ Build" ? { ...check, conclusion: "skipped" } : check,
  );
  assert.ok(
    evaluatePullRequest(
      passingInput({ checkRuns: skippedBuild }),
    ).reasons.includes("required-check-not-successful"),
  );
});

test("latest duplicate check run wins", () => {
  const oldFailure = {
    ...passingInput().checkRuns[0],
    conclusion: "failure",
    completed_at: "2026-08-11T20:00:00Z",
  };
  const result = evaluatePullRequest(
    passingInput({ checkRuns: [oldFailure, ...passingInput().checkRuns] }),
  );
  assert.equal(result.eligible, true);
});

test("post-merge recovery relaxes only obsolete merge state and still fails closed", () => {
  const merged = passingInput({
    state: "CLOSED",
    mergeable: "UNKNOWN",
    behindBy: 2,
  });
  assert.equal(
    evaluatePullRequest(merged, { mergedRecovery: true }).eligible,
    true,
  );
  assert.ok(
    evaluatePullRequest(
      { ...merged, authorLogin: "attacker" },
      { mergedRecovery: true },
    ).reasons.includes("untrusted-author"),
  );
  assert.ok(
    evaluatePullRequest(
      { ...merged, checkRuns: [] },
      { mergedRecovery: true },
    ).reasons.includes("required-check-missing"),
  );
});

test("release summaries fail closed on secret-shaped fields", () => {
  assert.doesNotThrow(() =>
    assertReleaseRecordSafe({ sourceSha: SHA, coworldId: "cow_example" }),
  );
  assert.throws(() =>
    assertReleaseRecordSafe({ api_token: "not-a-real-token" }),
  );
  assert.throws(() => assertReleaseRecordSafe({ note: "Bearer abc.def" }));
});
