import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpatialProbeEvents } from "./analyze-spatial-probes.mjs";

function probe({
  arm,
  index,
  requirement,
  correct = true,
  questionClass = requirement,
}) {
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
      questionClass,
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
  assert.deepEqual(report.gate1.arms.full.accuracyByQuestionClass, {
    minimap: { cases: 40, correct: 40, accuracy: 1 },
    structured: { cases: 160, correct: 160, accuracy: 1 },
  });
});

test("Gate 1 analyzer exposes post-hoc accuracy by question class", () => {
  const events = [
    probe({
      arm: "full",
      index: 0,
      requirement: "minimap",
      questionClass: "minimap_terrain_cell",
    }),
    probe({
      arm: "full",
      index: 1,
      requirement: "minimap",
      questionClass: "minimap_terrain_cell",
      correct: false,
    }),
    probe({
      arm: "full",
      index: 2,
      requirement: "minimap",
      questionClass: "minimap_owner_cell",
    }),
  ];
  const report = analyzeSpatialProbeEvents(events);
  assert.deepEqual(report.gate1.arms.full.accuracyByQuestionClass, {
    minimap_owner_cell: { cases: 1, correct: 1, accuracy: 1 },
    minimap_terrain_cell: { cases: 2, correct: 1, accuracy: 0.5 },
  });
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
