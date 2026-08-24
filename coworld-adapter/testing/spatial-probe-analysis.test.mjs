import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpatialProbeEvents } from "./analyze-spatial-probes.mjs";

function probe({ arm, index, requirement, correct = true }) {
  return {
    schemaVersion: 1,
    event: "probe",
    evidenceFile: `${arm}.log`,
    arm,
    gameID: "PWSAAAAA",
    turnNumber: index * 25,
    activeIndex: index,
    model: "us.anthropic.claude-sonnet-4-6",
    responseModel: "claude-sonnet-4-6",
    providerOK: true,
    parseOK: true,
    carrierActionID: "hold",
    carrierActionOffered: true,
    offeredMenuSHA256: `menu-${index}`,
    inputTokens: 100,
    outputTokens: 10,
    latencyMs: 1000,
    gate1: {
      scenarioID: `scenario-${index}`,
      visibilityRequirement: requirement,
      correct,
    },
    gate2: null,
  };
}

test("Gate 1 analyzer enforces the exact 160/40 cardinality", () => {
  const events = [];
  for (const arm of ["off", "structured", "full"]) {
    for (let index = 0; index < 200; index += 1) {
      events.push(
        probe({
          arm,
          index,
          requirement: index < 160 ? "structured" : "minimap",
        }),
      );
    }
  }
  const report = analyzeSpatialProbeEvents(events);
  assert.equal(report.gate1.cardinalityPass, true);
  assert.equal(report.gate1.reliabilityPass, true);
  assert.equal(report.gate1.structuredPass, true);
  assert.equal(report.gate1.minimapPass, true);
  assert.equal(report.gate1.arms.full.inputTokens, 20_000);
});

test("Gate 1 analyzer does not promote a partial fixture", () => {
  const events = [
    probe({ arm: "off", index: 0, requirement: "structured" }),
    probe({ arm: "structured", index: 0, requirement: "structured" }),
    probe({ arm: "full", index: 0, requirement: "structured" }),
  ];
  const report = analyzeSpatialProbeEvents(events);
  assert.equal(report.gate1.cardinalityPass, false);
  assert.equal(report.gate1.structuredPass, false);
  assert.equal(report.gate1.minimapPass, false);
});

test("Gate 2 analyzer scores each arm against the enabled-arm hidden truth", () => {
  const events = [];
  for (let index = 0; index < 40; index += 1) {
    const truth = `attack:R${index}:20`;
    for (const arm of ["off", "structured", "full"]) {
      events.push({
        ...probe({ arm, index, requirement: "structured" }),
        gate1: null,
        gate2: {
          taskClass: "structured_target",
          metric: "largest_border",
          candidateActionIDs: [truth, `attack:X${index}:20`],
          candidatesOffered: true,
          expected: arm === "off" ? "unknown" : truth,
          answer: arm === "off" ? "unknown" : truth,
        },
      });
    }
  }
  const report = analyzeSpatialProbeEvents(events);
  assert.equal(report.gate2.structuredTasks, 40);
  assert.equal(report.gate2.structuredAccuracy.off, 0);
  assert.equal(report.gate2.structuredAccuracy.structured, 1);
  assert.equal(report.gate2.structuredAccuracy.full, 1);
  assert.equal(report.gate2.structuredPass, true);
});
