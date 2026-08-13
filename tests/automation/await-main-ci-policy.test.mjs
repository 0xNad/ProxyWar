import assert from "node:assert/strict";
import test from "node:test";

import {
  requiredCiRunAction,
  selectExactSourceRun,
} from "../../.github/scripts/await-main-ci-policy.mjs";

const SHA = "a".repeat(40);

function run(overrides = {}) {
  return {
    id: 123,
    event: "workflow_dispatch",
    display_title: `CI ${SHA}`,
    head_sha: "b".repeat(40),
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    created_at: "2026-08-12T20:00:00Z",
    ...overrides,
  };
}

test("selects only the newest exact-source push or explicit fallback run", () => {
  const oldFallback = run();
  const newPush = run({
    id: 456,
    event: "push",
    head_sha: SHA,
    display_title: "ordinary title",
    created_at: "2026-08-12T21:00:00Z",
  });
  const unrelated = run({ id: 789, display_title: `CI ${"c".repeat(40)}` });
  assert.equal(
    selectExactSourceRun([unrelated, oldFallback, newPush], SHA)?.id,
    456,
  );
});

test("retries failed jobs twice, then fails closed", () => {
  assert.equal(requiredCiRunAction(null), "missing");
  assert.equal(requiredCiRunAction(run({ status: "in_progress" })), "wait");
  assert.equal(requiredCiRunAction(run()), "pass");
  assert.equal(
    requiredCiRunAction(run({ conclusion: "failure", run_attempt: 1 })),
    "rerun-failed",
  );
  assert.equal(
    requiredCiRunAction(run({ conclusion: "failure", run_attempt: 2 })),
    "rerun-failed",
  );
  assert.equal(
    requiredCiRunAction(run({ conclusion: "failure", run_attempt: 3 })),
    "fail",
  );
});
