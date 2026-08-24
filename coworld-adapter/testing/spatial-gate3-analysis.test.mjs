import assert from "node:assert/strict";
import test from "node:test";

import { pairedSummary } from "./analyze-spatial-gate3.mjs";

test("pairedSummary retains signs and computes a bounded interval", () => {
  const report = pairedSummary([1, 0.5, 0, -0.25]);
  assert.equal(report.count, 4);
  assert.equal(report.meanDifference, 0.3125);
  assert.deepEqual(
    { positive: report.positive, tied: report.tied, negative: report.negative },
    { positive: 2, tied: 1, negative: 1 },
  );
  assert.equal(report.confidenceInterval95.length, 2);
  assert.ok(report.confidenceInterval95[0] < report.meanDifference);
  assert.ok(report.confidenceInterval95[1] > report.meanDifference);
});

test("pairedSummary returns null mean and interval for no observations", () => {
  assert.deepEqual(pairedSummary([]), {
    count: 0,
    meanDifference: null,
    confidenceInterval95: null,
    positive: 0,
    tied: 0,
    negative: 0,
  });
});
