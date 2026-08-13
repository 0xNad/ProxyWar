import assert from "node:assert/strict";
import test from "node:test";

import { runWithRetry } from "../../.github/scripts/npm-ci-with-retry.mjs";

test("returns immediately when npm ci succeeds", async () => {
  const attempts = [];
  const exitCode = await runWithRetry({
    runAttempt: async (attempt) => {
      attempts.push(attempt);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(attempts, [1]);
});

test("retries transient install failures with bounded exponential delays", async () => {
  const attempts = [];
  const delays = [];
  const warnings = [];
  const exitCode = await runWithRetry({
    attempts: 3,
    delayMs: 5_000,
    runAttempt: async (attempt) => {
      attempts.push(attempt);
      return attempt === 3 ? 0 : 1;
    },
    sleep: async (delay) => delays.push(delay),
    warn: (warning) => warnings.push(warning),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [5_000, 10_000]);
  assert.equal(warnings.length, 2);
});

test("fails with the final exit code after the bounded retry budget", async () => {
  const exitCode = await runWithRetry({
    attempts: 2,
    delayMs: 0,
    runAttempt: async (attempt) => (attempt === 1 ? 17 : 23),
    sleep: async () => {},
    warn: () => {},
  });
  assert.equal(exitCode, 23);
});
