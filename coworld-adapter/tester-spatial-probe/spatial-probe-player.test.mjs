import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE1_CASE_COUNT,
  GATE1_MINIMAP_CASE_COUNT,
  GATE1_STRUCTURED_CASE_COUNT,
  armFromObservation,
  buildGate1Cases,
  buildGate2Task,
  expectedGate2Action,
  gate1PromptCase,
  startSpatialProbe,
} from "./spatial-probe-player.mjs";

function schema1Observation({ minimap = false } = {}) {
  return {
    ownState: { playerID: "SELF" },
    visiblePlayers: [
      {
        playerID: "R_A",
        bearing: "east",
        distanceClass: "adjacent",
        borderWithYou: {
          tiles: 80,
          shareOfYourBorder: 60,
          terrain: "land",
          defensePostsCovering: 1,
          underAttackHere: false,
        },
      },
      {
        playerID: "R_B",
        bearing: "west",
        distanceClass: "far",
        borderWithYou: {
          tiles: 20,
          shareOfYourBorder: 20,
          terrain: "coastal",
          defensePostsCovering: 0,
          underAttackHere: false,
        },
      },
    ],
    spatial: {
      schemaVersion: 1,
      visibilityModel: "global-lockstep-public-map-v1",
      ownShape: {
        quadrant: "center",
        compactness: "compact",
        regionCount: 1,
        largestRegionShare: 100,
        regionAnalysis: "complete",
        centroidBasis: "largest_region_border",
        coastShare: 10,
        centroid: { xPct: 50, yPct: 50 },
      },
      ...(minimap
        ? {
            minimap: {
              schemaVersion: 1,
              width: 24,
              height: 12,
              rows: Array.from({ length: 12 }, () => "A".repeat(24)),
              legend: [
                { glyph: "A", playerID: "SELF", name: "Self", isYou: true },
              ],
            },
          }
        : {}),
    },
  };
}

test("Gate 1 fixture has exact preregistered cardinality and stable IDs", () => {
  const cases = buildGate1Cases();
  assert.equal(cases.length, GATE1_CASE_COUNT);
  assert.equal(
    cases.filter((entry) => entry.visibilityRequirement === "structured")
      .length,
    GATE1_STRUCTURED_CASE_COUNT,
  );
  assert.equal(
    cases.filter((entry) => entry.visibilityRequirement === "minimap").length,
    GATE1_MINIMAP_CASE_COUNT,
  );
  assert.equal(
    new Set(cases.map((entry) => entry.scenarioID)).size,
    cases.length,
  );
  assert.deepEqual(
    buildGate1Cases().map((entry) => entry.scenarioID),
    cases.map((entry) => entry.scenarioID),
  );
});

test("Gate 1 arm projection exposes only the preregistered layer", () => {
  const cases = buildGate1Cases();
  const structuredCase = cases.find(
    (entry) => entry.visibilityRequirement === "structured",
  );
  const minimapCase = cases.find(
    (entry) => entry.visibilityRequirement === "minimap",
  );
  assert.equal(gate1PromptCase(structuredCase, "off").expected, "unknown");
  assert.equal(
    gate1PromptCase(structuredCase, "structured").expected,
    structuredCase.truth,
  );
  assert.equal(gate1PromptCase(minimapCase, "structured").expected, "unknown");
  assert.equal(
    gate1PromptCase(minimapCase, "full").expected,
    minimapCase.truth,
  );
  assert.equal(
    "minimap" in
      gate1PromptCase(structuredCase, "structured").spatialContext.spatial,
    false,
  );
  assert.equal(
    gate1PromptCase(minimapCase, "full").spatialContext.spatial.minimap
      .schemaVersion,
    2,
  );
});

test("arm detection fails closed and distinguishes minimap", () => {
  assert.equal(armFromObservation({ visiblePlayers: [] }), "off");
  assert.equal(armFromObservation(schema1Observation()), "structured");
  assert.equal(
    armFromObservation(schema1Observation({ minimap: true })),
    "full",
  );
});

test("Gate 2 uses exact offered same-shape target IDs and a hidden answer key", () => {
  const actions = [
    {
      id: "attack:R_A:20",
      kind: "attack",
      metadata: { targetID: "R_A", targetName: "A", troopPercent: 20 },
    },
    {
      id: "attack:R_B:20",
      kind: "attack",
      metadata: { targetID: "R_B", targetName: "B", troopPercent: 20 },
    },
    { id: "hold", kind: "hold", metadata: {} },
  ];
  const task = buildGate2Task(actions, 0);
  assert.equal(task.taskClass, "structured_target");
  assert.deepEqual(
    task.candidates.map((candidate) => candidate.id),
    ["attack:R_A:20", "attack:R_B:20"],
  );
  assert.equal(task.expected, undefined);
  assert.equal(
    expectedGate2Action(task, schema1Observation()),
    "attack:R_A:20",
  );
  assert.equal(expectedGate2Action(task, { visiblePlayers: [] }), null);
});

test("Gate 2 builds minimap-positioned tasks only from offered tile actions", () => {
  const actions = [
    {
      id: "build:City:10",
      kind: "build",
      metadata: { unit: "City", role: "economic", targetTile: 10 },
    },
    {
      id: "build:City:20",
      kind: "build",
      metadata: { unit: "City", role: "economic", targetTile: 20 },
    },
    { id: "hold", kind: "hold", metadata: {} },
  ];
  const task = buildGate2Task(actions, 1);
  assert.equal(task.taskClass, "minimap_tile");
  assert.deepEqual(
    task.candidates.map((candidate) => candidate.id),
    ["build:City:10", "build:City:20"],
  );
  assert.equal(expectedGate2Action(task, schema1Observation()), null);
});

test("hosted probe answer is evidence-only and the offered carrier is executed", async () => {
  class FakeSocket {
    static latest;

    constructor() {
      this.handlers = new Map();
      this.sent = [];
      FakeSocket.latest = this;
    }

    on(name, handler) {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {}

    emit(name, value) {
      for (const handler of this.handlers.get(name) ?? []) handler(value);
    }
  }

  let calls = 0;
  const bedrock = {
    messages: {
      create: async () => {
        calls += 1;
        return {
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ text: '{"gate1":"unknown","gate2":null}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      },
    },
  };
  const previousURL = process.env.COWORLD_PLAYER_WS_URL;
  const previousLog = console.log;
  process.env.COWORLD_PLAYER_WS_URL = "ws://probe.invalid";
  console.log = () => {};
  try {
    startSpatialProbe({
      argv: ["--mode=gate1", "--offset=0"],
      BedrockClient: () => bedrock,
      WebSocketCtor: FakeSocket,
    });
    FakeSocket.latest.emit(
      "message",
      JSON.stringify({
        type: "decision_request",
        requestID: "REQ_1",
        request: {
          observation: {
            gameID: "PWSAAAAA",
            turnNumber: 25,
            ownState: { playerID: "SELF" },
            visiblePlayers: [],
          },
          legalActions: [{ id: "hold", kind: "hold", metadata: {} }],
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    assert.equal(FakeSocket.latest.sent.length, 1);
    assert.equal(FakeSocket.latest.sent[0].selectedLegalActionId, "hold");
    assert.equal(FakeSocket.latest.sent[0].fallbackUsed, false);
    assert.equal(FakeSocket.latest.sent[0].llmPlannerDegraded, false);
  } finally {
    console.log = previousLog;
    if (previousURL === undefined) delete process.env.COWORLD_PLAYER_WS_URL;
    else process.env.COWORLD_PLAYER_WS_URL = previousURL;
  }
});
