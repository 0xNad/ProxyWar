import assert from "node:assert/strict";
import test from "node:test";

import {
  pairedSummary,
  selectedActionUtilization,
} from "./analyze-spatial-gate3.mjs";

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

test("selectedActionUtilization deduplicates side-slot evidence by request", () => {
  assert.deepEqual(
    selectedActionUtilization([
      { requestID: "req_1", selectedLegalActionID: "hold" },
      { requestID: "req_1", selectedLegalActionID: "hold" },
      { requestID: "req_2", selectedLegalActionID: "attack:rival:4" },
      { requestID: "req_3", selectedLegalActionID: "build:City:8" },
      { requestID: "req_4", selectedLegalActionID: "upgrade:Factory:7" },
      { requestID: "req_5", selectedLegalActionID: "boat:Warship:12" },
      { requestID: "req_6", selectedLegalActionID: "expand:terra-nullius:9" },
      { requestID: "req_missing" },
    ]),
    {
      decisions: 6,
      actionKindCounts: {
        attack: 1,
        boat: 1,
        build: 1,
        expand: 1,
        hold: 1,
        upgrade: 1,
      },
      nonHoldRate: 5 / 6,
      expandRate: 1 / 6,
      attackRate: 1 / 6,
      economyBuildRate: 2 / 6,
      boatRate: 1 / 6,
    },
  );
});

test("selectedActionUtilization rejects conflicting duplicated evidence", () => {
  assert.throws(
    () =>
      selectedActionUtilization([
        { requestID: "req_1", selectedLegalActionID: "hold" },
        { requestID: "req_1", selectedLegalActionID: "attack:rival:4" },
      ]),
    /conflicting selected legal-action evidence/u,
  );
});
